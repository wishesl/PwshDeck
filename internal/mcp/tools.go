package mcp

import (
	"context"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"pwshdeck/internal/session"
	"pwshdeck/internal/window"
)

// mcpMaxToolOutput bounds the output text returned by execute_command /
// read_output, keeping the tail where fresh output lives.
const mcpMaxToolOutput = 96 * 1024

// ansiPattern matches ANSI/VT escape sequences in terminal output: CSI
// (ESC [ ...), OSC (ESC ] ... up to BEL/ST) and single-byte ESC sequences.
var ansiPattern = regexp.MustCompile(`\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-~]`)

// cleanOutput strips ANSI escape sequences and stray control characters from
// terminal output, producing plain text for MCP tool results. The GUI stream
// keeps the raw bytes; only what MCP clients read is cleaned.
func cleanOutput(s string) string {
	s = ansiPattern.ReplaceAllString(s, "")
	return strings.Map(func(r rune) rune {
		switch r {
		case '\t', '\r', '\n':
			return r
		default:
			if r < 0x20 || r == 0x7f {
				return -1 // drop remaining control characters
			}
			return r
		}
	}, s)
}

// decodeInput expands the escape sequences send_input documents (\r, \n, \t,
// \\ and \uXXXX) into their raw byte values, so a client can send Enter ("\r")
// or Ctrl+C ("\u0003") as plain text. Unknown escapes pass through literally.
func decodeInput(s string) string {
	if !strings.ContainsRune(s, '\\') {
		return s
	}
	var b strings.Builder
	b.Grow(len(s))
	for i := 0; i < len(s); {
		if s[i] != '\\' || i+1 >= len(s) {
			b.WriteByte(s[i])
			i++
			continue
		}
		switch s[i+1] {
		case 'r':
			b.WriteByte('\r')
			i += 2
		case 'n':
			b.WriteByte('\n')
			i += 2
		case 't':
			b.WriteByte('\t')
			i += 2
		case '\\':
			b.WriteByte('\\')
			i += 2
		case 'u':
			if i+6 <= len(s) {
				if r, ok := parseUnicodeEscape(s[i+2 : i+6]); ok {
					b.WriteRune(r)
					i += 6
					continue
				}
			}
			b.WriteByte(s[i])
			i++
		default:
			b.WriteByte(s[i])
			i++
		}
	}
	return b.String()
}

// parseUnicodeEscape parses four hex digits into a rune.
func parseUnicodeEscape(hex string) (rune, bool) {
	var v rune
	for _, c := range hex {
		var d rune
		switch {
		case c >= '0' && c <= '9':
			d = c - '0'
		case c >= 'a' && c <= 'f':
			d = c - 'a' + 10
		case c >= 'A' && c <= 'F':
			d = c - 'A' + 10
		default:
			return 0, false
		}
		v = v*16 + d
	}
	return v, true
}

// trailingPromptPattern matches the interactive prompt that ends command
// output — "PS <location>> " possibly nested ("PS C:\dir>> ") — after
// cleanOutput has removed the OSC 9;9 report and any ANSI escapes. The prompt
// is stripped so tool results carry only the command's own output.
var trailingPromptPattern = regexp.MustCompile(`\r?\n?PS [^\r\n]*?>\s*$`)

// stripCommandEcho removes the echoed command line PowerShell renders as the
// command is typed, so output starts at the command's own result. PSReadLine
// echoes a long command in fragmented pieces plus one full redraw; the full
// command string only appears in that final redraw, so find its first
// occurrence and keep everything after it (skipping the trailing whitespace
// PSReadLine adds for the cursor, then the line terminator). Multi-line
// commands are left untouched.
func stripCommandEcho(output, command string) string {
	command = strings.TrimSpace(command)
	if command == "" || strings.ContainsAny(command, "\r\n") {
		return output
	}
	idx := strings.Index(output, command)
	if idx < 0 {
		return output
	}
	rest := output[idx+len(command):]
	rest = strings.TrimLeft(rest, " \t")
	return strings.TrimLeft(rest, "\r\n")
}

// stripTrailingPrompt removes the interactive prompt that ends command output.
func stripTrailingPrompt(output string) string {
	return trailingPromptPattern.ReplaceAllString(output, "")
}

// pwshToolSet is the single source of truth for exposed tool names and
// descriptions, used both at registration time and by the management UI.
var pwshToolSet = []ToolInfo{
	{Name: "list_sessions", Description: "List all pwsh terminal sessions with id, title, host window, size and running state."},
	{Name: "create_session", Description: "Start a new interactive pwsh session in a ConPTY. Optionally also open a GUI window for it."},
	{Name: "send_input", Description: "Write raw keystrokes to a session's stdin. Use \\r for Enter; supports escape sequences and Ctrl+C (\\u0003). Output is not returned - use read_output."},
	{Name: "execute_command", Description: "Run a PowerShell command in a session (Enter appended automatically) and wait for it to finish (the prompt returns) before returning the collected output (plain text, ANSI stripped; command echo and trailing prompt removed). The session stays interactive - use read_output with since_offset for anything produced later."},
	{Name: "read_output", Description: "Read output buffered since a byte offset (offset 0 returns recent history) as plain text (ANSI stripped). Returns NextOffset to pass back for incremental reads."},
	{Name: "stop_session", Description: "Terminate a pwsh session and its ConPTY, then remove it from the session list."},
	{Name: "resize_session", Description: "Resize a session's pseudo terminal so pwsh reflows its output."},
	{Name: "list_windows", Description: "List the application's terminal windows."},
}

// toolDesc looks up a tool description by name.
func toolDesc(name string) string {
	for _, t := range pwshToolSet {
		if t.Name == name {
			return t.Description
		}
	}
	return ""
}

// BuildServer wires all pwsh-management tools into a new MCP server and
// returns it together with the exposed tool list. When pwsh/wins are nil the
// tools are registered anyway but report "unavailable" at call time (used to
// collect the tool list for the UI).
func BuildServer(pwsh *session.SessionManager, wins *window.WindowManager) (*mcp.Server, []ToolInfo) {
	srv := mcp.NewServer(&mcp.Implementation{Name: "PwshDeck", Version: "0.1.0"}, nil)

	// ---- list_sessions -------------------------------------------------
	mcp.AddTool(srv,
		&mcp.Tool{
			Name:        "list_sessions",
			Description: toolDesc("list_sessions"),
		},
		func(ctx context.Context, req *mcp.CallToolRequest, in listSessionsIn) (*mcp.CallToolResult, sessionListOut, error) {
			var out sessionListOut
			if pwsh != nil {
				out.Sessions = pwsh.ListSessions()
			}
			if out.Sessions == nil {
				out.Sessions = []session.SessionInfo{}
			}
			return nil, out, nil
		})

	// ---- create_session ------------------------------------------------
	mcp.AddTool(srv,
		&mcp.Tool{
			Name:        "create_session",
			Description: toolDesc("create_session"),
		},
		func(ctx context.Context, req *mcp.CallToolRequest, in createSessionIn) (*mcp.CallToolResult, createdSessionOut, error) {
			if pwsh == nil {
				return nil, createdSessionOut{}, fmt.Errorf("pwsh service unavailable")
			}
			info, err := pwsh.StartSession("", "")
			if err != nil {
				return nil, createdSessionOut{}, err
			}
			openWin := wins != nil && (in.OpenWindow == nil || *in.OpenWindow)
			if openWin {
				if _, err := attachWindow(wins, pwsh, info.ID); err != nil {
					return nil, createdSessionOut{ID: info.ID, Title: info.Title},
						fmt.Errorf("session created but window failed: %w", err)
				}
			}
			return nil, createdSessionOut{ID: info.ID, Title: info.Title}, nil
		})

	// ---- send_input ----------------------------------------------------
	mcp.AddTool(srv,
		&mcp.Tool{
			Name:        "send_input",
			Description: "Write raw keystrokes to a session's stdin. Use \\r for Enter; supports escape sequences and Ctrl+C (\\u0003). Output is not returned - use read_output.",
		},
		func(ctx context.Context, req *mcp.CallToolRequest, in sendInputIn) (*mcp.CallToolResult, okOut, error) {
			if pwsh == nil {
				return nil, okOut{}, fmt.Errorf("pwsh service unavailable")
			}
			if err := pwsh.WriteInput(in.SessionID, decodeInput(in.Input)); err != nil {
				return nil, okOut{}, err
			}
			return nil, okOut{OK: true}, nil
		})

	// ---- execute_command -----------------------------------------------
	mcp.AddTool(srv,
		&mcp.Tool{
			Name:        "execute_command",
			Description: toolDesc("execute_command"),
		},
		func(ctx context.Context, req *mcp.CallToolRequest, in executeIn) (*mcp.CallToolResult, executeOut, error) {
			if pwsh == nil {
				return nil, executeOut{}, fmt.Errorf("pwsh service unavailable")
			}
			timeout := time.Duration(0)
			if in.TimeoutSeconds != nil {
				timeout = time.Duration(*in.TimeoutSeconds * float64(time.Second))
			}
			output, timedOut, err := pwsh.ExecuteCommand(in.SessionID, in.Command, timeout)
			if err != nil {
				return nil, executeOut{}, err
			}
			cleaned := cleanOutput(output)
			cleaned = stripCommandEcho(cleaned, in.Command)
			cleaned = stripTrailingPrompt(cleaned)
			return nil, executeOut{
				SessionID: in.SessionID,
				Command:   in.Command,
				Output:    tailOutput(cleaned, mcpMaxToolOutput),
				TimedOut:  timedOut,
			}, nil
		})

	// ---- read_output ---------------------------------------------------
	mcp.AddTool(srv,
		&mcp.Tool{
			Name:        "read_output",
			Description: toolDesc("read_output"),
		},
		func(ctx context.Context, req *mcp.CallToolRequest, in readOutputIn) (*mcp.CallToolResult, readOutputOut, error) {
			if pwsh == nil {
				return nil, readOutputOut{}, fmt.Errorf("pwsh service unavailable")
			}
			var since int64
			if in.SinceOffset != nil {
				since = *in.SinceOffset
			}
			data, next, dropped, err := pwsh.ReadOutput(in.SessionID, since)
			if err != nil {
				return nil, readOutputOut{}, err
			}
			return nil, readOutputOut{
				SessionID:  in.SessionID,
				Output:     tailOutput(cleanOutput(string(data)), mcpMaxToolOutput),
				NextOffset: next,
				Dropped:    dropped,
			}, nil
		})

	// ---- stop_session --------------------------------------------------
	mcp.AddTool(srv,
		&mcp.Tool{
			Name:        "stop_session",
			Description: toolDesc("stop_session"),
		},
		func(ctx context.Context, req *mcp.CallToolRequest, in sessionRefIn) (*mcp.CallToolResult, okOut, error) {
			if pwsh == nil {
				return nil, okOut{}, fmt.Errorf("pwsh service unavailable")
			}
			if err := pwsh.StopSession(in.SessionID); err != nil {
				return nil, okOut{}, err
			}
			return nil, okOut{OK: true}, nil
		})

	// ---- resize_session ------------------------------------------------
	mcp.AddTool(srv,
		&mcp.Tool{
			Name:        "resize_session",
			Description: toolDesc("resize_session"),
		},
		func(ctx context.Context, req *mcp.CallToolRequest, in resizeIn) (*mcp.CallToolResult, okOut, error) {
			if pwsh == nil {
				return nil, okOut{}, fmt.Errorf("pwsh service unavailable")
			}
			if err := pwsh.Resize(in.SessionID, in.Cols, in.Rows); err != nil {
				return nil, okOut{}, err
			}
			return nil, okOut{OK: true}, nil
		})

	// ---- list_windows --------------------------------------------------
	mcp.AddTool(srv,
		&mcp.Tool{
			Name:        "list_windows",
			Description: toolDesc("list_windows"),
		},
		func(ctx context.Context, req *mcp.CallToolRequest, in listWindowsIn) (*mcp.CallToolResult, windowListOut, error) {
			var out windowListOut
			if wins != nil {
				out.Windows = wins.ListWindows()
			}
			if out.Windows == nil {
				out.Windows = []window.WindowInfo{}
			}
			return nil, out, nil
		})

	// The exposed tool list for the management UI.
	return srv, append([]ToolInfo(nil), pwshToolSet...)
}

// attachWindow opens a window and binds the given session (or a fresh one) to
// it, so the window owns that terminal.
func attachWindow(wins *window.WindowManager, pwsh *session.SessionManager, sessionID string) (*window.WindowInfo, error) {
	info, err := wins.NewWindow()
	if err != nil {
		return nil, err
	}
	if sessionID == "" {
		if _, err := pwsh.StartSession(info.Name, ""); err != nil {
			_ = wins.CloseWindow(info.Name)
			return nil, err
		}
		return info, nil
	}
	// Rebind an existing session to the new window.
	if err := pwsh.BindSessionWindow(sessionID, info.Name); err != nil {
		_ = wins.CloseWindow(info.Name)
		return nil, err
	}
	return info, nil
}

// tailOutput trims a chunk of collected output to a sane length for tool
// results, keeping the tail (fresh output matters more than early noise).
func tailOutput(s string, limit int) string {
	if limit <= 0 || len(s) <= limit {
		return strings.TrimRight(s, "\r\n")
	}
	return strings.TrimRight(s[len(s)-limit:], "\r\n")
}

// ---- MCP tool IO types --------------------------------------------------
// jsonschema struct tags become property descriptions; omitempty keeps
// fields optional.

type listSessionsIn struct{}

type sessionListOut struct {
	Sessions []session.SessionInfo `json:"sessions"`
}

type createSessionIn struct {
	OpenWindow *bool `json:"open_window,omitempty" jsonschema:"Open a GUI window for the new session (default true in GUI mode)."`
}

type createdSessionOut struct {
	ID    string `json:"id"`
	Title string `json:"title"`
}

type sendInputIn struct {
	SessionID string `json:"session_id" jsonschema:"Target session id from list_sessions."`
	Input     string `json:"input" jsonschema:"Raw keystrokes to write to the shell stdin, e.g. 'ls\\r' or Ctrl+C as \\u0003."`
}

type okOut struct {
	OK bool `json:"ok"`
}

type sessionRefIn struct {
	SessionID string `json:"session_id" jsonschema:"Target session id from list_sessions."`
}

type executeIn struct {
	SessionID      string   `json:"session_id" jsonschema:"Target session id from list_sessions."`
	Command        string   `json:"command" jsonschema:"PowerShell command to run; Enter is appended automatically."`
	TimeoutSeconds *float64 `json:"timeout_seconds,omitempty" jsonschema:"Max seconds to wait for output to settle (default 20, max 120)."`
}

type executeOut struct {
	SessionID string `json:"session_id"`
	Command   string `json:"command"`
	Output    string `json:"output"`
	TimedOut  bool   `json:"timed_out"`
}

type readOutputIn struct {
	SessionID   string `json:"session_id" jsonschema:"Target session id from list_sessions."`
	SinceOffset *int64 `json:"since_offset,omitempty" jsonschema:"Byte offset returned by a previous read; omit or 0 for recent history."`
}

type readOutputOut struct {
	SessionID  string `json:"session_id"`
	Output     string `json:"output"`
	NextOffset int64  `json:"next_offset"`
	Dropped    bool   `json:"dropped"`
}

type resizeIn struct {
	SessionID string `json:"session_id" jsonschema:"Target session id from list_sessions."`
	Cols      int    `json:"cols" jsonschema:"Terminal width in columns (>=1)."`
	Rows      int    `json:"rows" jsonschema:"Terminal height in rows (>=1)."`
}

type listWindowsIn struct{}

type windowListOut struct {
	Windows []window.WindowInfo `json:"windows"`
}
