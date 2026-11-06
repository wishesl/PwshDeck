package session

import (
	"bytes"
	"encoding/base64"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"
	"unicode/utf16"

	"github.com/UserExistsError/conpty"
)

func TestConsumeCwdReport(t *testing.T) {
	tests := []struct {
		name  string
		chunk []byte
		want  string
	}{
		{
			name:  "single report",
			chunk: []byte("\x1b]9;9;\"C:\\Users\\Tony\\work\"\x1b\\PS C:\\Users\\Tony\\work> "),
			want:  "C:\\Users\\Tony\\work",
		},
		{
			name:  "BEL terminated report",
			chunk: []byte("prompt \x1b]9;9;\"D:\\dev\\app\"\x07PS D:\\dev\\app> "),
			want:  "D:\\dev\\app",
		},
		{
			name:  "newest of several reports wins",
			chunk: []byte("\x1b]9;9;\"C:\\a\"\x1b\\\x1b]9;9;\"C:\\b\"\x1b\\"),
			want:  "C:\\b",
		},
		{
			name:  "no report",
			chunk: []byte("PS C:\\Users\\Tony> "),
			want:  "",
		},
		{
			name:  "other OSC sequences ignored",
			chunk: []byte("\x1b]0;pwsh\x07\x1b]9;4;3;0\x07PS C:\\> "),
			want:  "",
		},
		{
			name:  "report split across chunks",
			chunk: []byte("text \x1b]9;9;\"C:\\split"),
			want:  "",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			sess := &TerminalSession{}
			if got := sess.consumeCwdReport(tt.chunk); got != tt.want {
				t.Errorf("consumeCwdReport(%q) = %q, want %q", tt.chunk, got, tt.want)
			}
		})
	}

	t.Run("report completed by the next chunk", func(t *testing.T) {
		sess := &TerminalSession{}
		if got := sess.consumeCwdReport([]byte("prefix \x1b]9;9;\"C:\\split")); got != "" {
			t.Fatalf("first half unexpectedly completed: %q", got)
		}
		if got := sess.consumeCwdReport([]byte("ted\\dir\"\x1b\\PS> ")); got != "C:\\splitted\\dir" {
			t.Fatalf("second half = %q, want %q", got, "C:\\splitted\\dir")
		}
	})
}

func TestOutputTail(t *testing.T) {
	tests := []struct {
		name string
		out  string
		want string
	}{
		{name: "empty output", out: "", want: ""},
		{name: "keeps the last ten characters", out: "0123456789abcdef", want: "6789abcdef"},
		{name: "ANSI stripped", out: "\x1b[31mhello world\x1b[0m\r\nPS C:\\dir> ", want: "PS C:\\dir>"},
		{name: "whitespace collapsed onto one line", out: "a\r\nb\tc   ", want: "a b c"},
		{name: "multibyte runes counted, not bytes", out: "一二三四五六七八九十十一", want: "三四五六七八九十十一"},
		{name: "ANSI-only output is empty", out: "\x1b[2J\x1b[H", want: ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			sess := &TerminalSession{}
			sess.buf.write([]byte(tt.out))
			if got := sess.Info().OutputTail; got != tt.want {
				t.Errorf("OutputTail for %q = %q, want %q", tt.out, got, tt.want)
			}
		})
	}
}

func TestRenameSession(t *testing.T) {
	mgr := NewSessionManager(0, 0)
	sess := &TerminalSession{ID: "abcd", Title: "pwsh #1"}
	mgr.sessions["abcd"] = sess

	if err := mgr.RenameSession("abcd", "  后端  "); err != nil {
		t.Fatalf("rename: %v", err)
	}
	if got := sess.Info().Title; got != "后端" {
		t.Errorf("title after rename = %q, want %q", got, "后端")
	}

	// An empty title is a no-op rather than an error: the UI never commits one.
	if err := mgr.RenameSession("abcd", "   "); err != nil {
		t.Fatalf("rename to blank: %v", err)
	}
	if got := sess.Info().Title; got != "后端" {
		t.Errorf("title after blank rename = %q, want %q", got, "后端")
	}

	if err := mgr.RenameSession("missing", "x"); err == nil {
		t.Error("renaming an unknown session should fail")
	}
}

func TestListSessionsReportsLiveTitleAndTail(t *testing.T) {
	mgr := NewSessionManager(0, 0)
	sess := &TerminalSession{ID: "abcd", Title: "pwsh #1", running: true}
	sess.buf.write([]byte("\x1b[32mbuild ok\x1b[0m\r\nPS C:\\work> "))
	mgr.sessions["abcd"] = sess

	if err := mgr.RenameSession("abcd", "后端"); err != nil {
		t.Fatalf("rename: %v", err)
	}
	infos := mgr.ListSessions()
	if len(infos) != 1 {
		t.Fatalf("ListSessions returned %d sessions, want 1", len(infos))
	}
	if infos[0].Title != "后端" {
		t.Errorf("title = %q, want %q", infos[0].Title, "后端")
	}
	if want := "S C:\\work>"; infos[0].OutputTail != want {
		t.Errorf("output_tail = %q, want %q", infos[0].OutputTail, want)
	}
}

func TestEncodeCommand(t *testing.T) {
	enc := encodeCommand("function global:prompt { }\n")
	raw, err := base64.StdEncoding.DecodeString(enc)
	if err != nil {
		t.Fatalf("encoded command is not valid base64: %v", err)
	}
	u := make([]uint16, len(raw)/2)
	for i := range u {
		u[i] = uint16(raw[i*2]) | uint16(raw[i*2+1])<<8
	}
	got := string(utf16.Decode(u))
	if !strings.Contains(got, "global:prompt") {
		t.Errorf("decoded script %q missing prompt hook", got)
	}
}

func TestResolveWorkDir(t *testing.T) {
	home := t.TempDir()
	existing := t.TempDir()
	missing := filepath.Join(t.TempDir(), "nope")
	cwd, err := filepath.Abs(".")
	if err != nil {
		t.Fatalf("resolve cwd: %v", err)
	}

	tests := []struct {
		name string
		in   string
		want string
	}{
		{name: "empty falls back to home", in: "", want: home},
		{name: "existing directory kept", in: existing, want: existing},
		{name: "missing directory falls back to home", in: missing, want: home},
		{name: "relative path resolved to absolute", in: ".", want: cwd},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := resolveWorkDir(tt.in, home); got != tt.want {
				t.Errorf("resolveWorkDir(%q, home) = %q, want %q", tt.in, got, tt.want)
			}
		})
	}
}

// TestPromptHookReportsCwd boots a real pwsh through a ConPTY with the exact
// command line StartSession uses and verifies the prompt hook emits an OSC 9;9
// cwd report carrying the process working directory — the mechanism that lets
// tabs persist their pwd.
func TestPromptHookReportsCwd(t *testing.T) {
	if !conpty.IsConPtyAvailable() {
		t.Skip("ConPTY not available")
	}
	if _, err := exec.LookPath("pwsh.exe"); err != nil {
		t.Skip("pwsh.exe not found on PATH")
	}

	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		dir = t.TempDir()
	}
	cpty, err := conpty.Start(pwshCommandLine(), conpty.ConPtyDimensions(80, 24), conpty.ConPtyWorkDir(dir))
	if err != nil {
		t.Fatalf("start pwsh: %v", err)
	}
	defer cpty.Close()

	pattern := regexp.MustCompile(`\x1b\]9;9;"([^"]*)"(?:\x07|\x1b\\)`)
	deadline := time.Now().Add(20 * time.Second)
	buf := make([]byte, 4096)
	var out bytes.Buffer
	for time.Now().Before(deadline) {
		n, err := cpty.Read(buf)
		if n > 0 {
			out.Write(buf[:n])
			if m := pattern.FindSubmatch(out.Bytes()); m != nil {
				got := string(m[1])
				if !strings.EqualFold(got, dir) {
					t.Fatalf("reported cwd = %q, want %q (output: %q)", got, dir, out.String())
				}
				return
			}
			if out.Len() > 64*1024 {
				out.Reset() // keep the search window bounded
			}
		}
		if err != nil {
			t.Fatalf("conpty read: %v", err)
		}
	}
	t.Fatalf("timed out waiting for OSC 9;9 cwd report; output so far: %q", out.String())
}

// TestExecuteCommandCompletion boots a real pwsh and verifies ExecuteCommand
// uses the prompt hook's OSC 9;9 report to detect completion: a fast command
// returns without timing out, and a long-running command is reported as timed
// out instead of falsely completing during the quiet period.
func TestExecuteCommandCompletion(t *testing.T) {
	if !conpty.IsConPtyAvailable() {
		t.Skip("ConPTY not available")
	}
	if _, err := exec.LookPath("pwsh.exe"); err != nil {
		t.Skip("pwsh.exe not found on PATH")
	}

	mgr := NewSessionManager(0, 0)
	defer mgr.ShutdownAll()
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		dir = t.TempDir()
	}
	info, err := mgr.StartSession("", dir)
	if err != nil {
		t.Fatalf("start session: %v", err)
	}

	out, timedOut, err := mgr.ExecuteCommand(info.ID, "Write-Output 'hello-mcp'", 0)
	if err != nil {
		t.Fatalf("execute fast command: %v", err)
	}
	if timedOut {
		t.Fatalf("fast command reported timed out; output: %q", out)
	}
	if !strings.Contains(out, "hello-mcp") {
		t.Fatalf("fast command output missing result: %q", out)
	}

	out, timedOut, err = mgr.ExecuteCommand(info.ID, "Start-Sleep 5", time.Second)
	if err != nil {
		t.Fatalf("execute long command: %v", err)
	}
	if !timedOut {
		t.Fatalf("long command should have timed out; output: %q", out)
	}
}
