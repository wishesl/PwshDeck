// Package session manages interactive pwsh processes running inside Windows
// ConPTYs, so shells behave exactly like a real terminal (Tab completion,
// PSReadLine, progress bars, Ctrl+C, ...).
package session

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"regexp"
	"sync"
	"time"

	"github.com/UserExistsError/conpty"
)

// outputBufLimit caps how many recent ConPTY output bytes are kept in memory
// per session, so MCP clients can read output produced while they were away.
const outputBufLimit = 512 * 1024

// TerminalSession is one pwsh process running inside a Windows ConPTY.
type TerminalSession struct {
	ID     string
	Title  string
	Window string
	// Pwd is the shell's current working directory, tracked from the OSC 9;9
	// cwd reports the prompt hook (see pwshCommandLine in manager.go) emits on
	// every prompt. Tabs persist it so a restored shell boots in the same
	// directory. Guarded by mu.
	Pwd string

	cpty *conpty.ConPty
	cols int
	rows int

	mu         sync.Mutex
	running    bool
	createdAt  time.Time
	lastActive time.Time // last input/output activity, for idle recycling
	oscCarry   []byte    // tail of recent output for split OSC 9;9 reports; readLoop only

	buf outputBuffer
}

// SessionInfo is the wire-safe view of a session, shared by the Wails
// bindings and the MCP tools.
type SessionInfo struct {
	ID        string `json:"id"`
	Title     string `json:"title"`
	Window    string `json:"window"`
	Running   bool   `json:"running"`
	CreatedAt string `json:"created_at"`
	Cols      int    `json:"cols"`
	Rows      int    `json:"rows"`
	Pwd       string `json:"pwd"`
}

// Info snapshots the current session state.
func (s *TerminalSession) Info() SessionInfo {
	s.mu.Lock()
	defer s.mu.Unlock()
	return SessionInfo{
		ID:        s.ID,
		Title:     s.Title,
		Window:    s.Window,
		Running:   s.running,
		CreatedAt: s.createdAt.Format(time.RFC3339),
		Cols:      s.cols,
		Rows:      s.rows,
		Pwd:       s.Pwd,
	}
}

// isRunning reports whether the shell is still alive.
func (s *TerminalSession) isRunning() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.running
}

// touch records activity so the idle janitor can tell live sessions apart
// from abandoned ones.
func (s *TerminalSession) touch() {
	s.mu.Lock()
	s.lastActive = time.Now()
	s.mu.Unlock()
}

// idleFor reports how long the session has been silent (input or output).
func (s *TerminalSession) idleFor() time.Duration {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.lastActive.IsZero() {
		return time.Since(s.createdAt)
	}
	return time.Since(s.lastActive)
}

// setPwd records the shell's current working directory, as reported by the
// prompt hook.
func (s *TerminalSession) setPwd(pwd string) {
	s.mu.Lock()
	s.Pwd = pwd
	s.mu.Unlock()
}

// oscCwdPattern matches ConEmu-style OSC 9;9 working-directory reports
// (`ESC ] 9 ; 9 ; "path" ESC \`), which the prompt hook emits on every prompt.
var oscCwdPattern = regexp.MustCompile(`\x1b\]9;9;"([^"]*)"(?:\x07|\x1b\\)`)

// oscCarryBytes caps how much recent output is remembered across read chunks.
const oscCarryBytes = 1024

// consumeCwdReport scans a chunk of ConPTY output for OSC 9;9 cwd reports and
// returns the newest path found (empty when the chunk carries none). A report
// split across two reads is still recognized by keeping the tail of previous
// output in oscCarry. Called from readLoop only, so oscCarry needs no locking.
func (s *TerminalSession) consumeCwdReport(chunk []byte) string {
	combined := append(append([]byte{}, s.oscCarry...), chunk...)
	var pwd string
	for _, m := range oscCwdPattern.FindAllSubmatch(combined, -1) {
		pwd = string(m[1])
	}
	if bytes.Contains(combined, []byte("\x1b]")) {
		if len(combined) > oscCarryBytes {
			combined = combined[len(combined)-oscCarryBytes:]
		}
		s.oscCarry = append(s.oscCarry[:0], combined...)
	} else {
		s.oscCarry = nil
	}
	return pwd
}

func (s *TerminalSession) writeInput(data string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.running {
		return fmt.Errorf("session %s is not running", s.ID)
	}
	s.lastActive = time.Now()
	_, err := s.cpty.Write([]byte(data))
	return err
}

func (s *TerminalSession) resize(cols, rows int) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.running {
		return fmt.Errorf("session %s is not running", s.ID)
	}
	if cols <= 0 || rows <= 0 {
		return fmt.Errorf("invalid terminal size %dx%d", cols, rows)
	}
	s.cols, s.rows = cols, rows
	return s.cpty.Resize(cols, rows)
}

// close shuts the ConPTY (and its shell) down. Safe to call multiple times.
func (s *TerminalSession) close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.running {
		return nil
	}
	s.running = false
	return s.cpty.Close()
}

// outputBuffer keeps the most recent output bytes tagged with stable sequence
// offsets, so readers can resume from where they stopped even after the
// buffer has been trimmed from the front.
type outputBuffer struct {
	mu        sync.Mutex
	buf       []byte
	startSeq  int64     // sequence offset of buf[0]
	lastWrite time.Time // time of the most recent write
}

func (o *outputBuffer) write(p []byte) {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.buf = append(o.buf, p...)
	if len(o.buf) > outputBufLimit {
		drop := len(o.buf) - outputBufLimit
		o.buf = o.buf[drop:]
		o.startSeq += int64(drop)
	}
	o.lastWrite = time.Now()
}

// since returns output bytes from the given sequence offset onwards, plus the
// offset a reader should use next time. dropped is true when older bytes have
// been trimmed and the caller's offset could not be honored.
func (o *outputBuffer) since(offset int64) (data []byte, next int64, dropped bool) {
	o.mu.Lock()
	defer o.mu.Unlock()
	end := o.startSeq + int64(len(o.buf))
	if offset < o.startSeq {
		offset = o.startSeq
		dropped = o.startSeq > 0
	}
	if offset > end {
		offset = end
	}
	return o.buf[offset-o.startSeq:], end, dropped
}

// lastSeq returns the offset a fresh reader should start from to only see
// future output.
func (o *outputBuffer) lastSeq() int64 {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.startSeq + int64(len(o.buf))
}

func (o *outputBuffer) lastActivity() time.Time {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.lastWrite
}

// newSessionID returns a short random identifier usable as an MCP argument.
func newSessionID() string {
	b := make([]byte, 4)
	if _, err := rand.Read(b); err != nil {
		return fmt.Sprintf("t%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(b)
}
