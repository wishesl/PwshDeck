package mcp

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"pwsh-mcp/internal/session"
	"pwsh-mcp/internal/window"
)

// mcpMaxToolOutput bounds the output text returned by execute_command /
// read_output, keeping the tail where fresh output lives.
const mcpMaxToolOutput = 96 * 1024

// pwshToolSet is the single source of truth for exposed tool names and
// descriptions, used both at registration time and by the management UI.
var pwshToolSet = []ToolInfo{
	{Name: "list_sessions", Description: "List all pwsh terminal sessions with id, title, host window, size and running state."},
	{Name: "create_session", Description: "Start a new interactive pwsh session in a ConPTY. Optionally also open a GUI window for it."},
	{Name: "send_input", Description: "Write raw keystrokes to a session's stdin. Use \\r for Enter; supports escape sequences and Ctrl+C (\\u0003). Output is not returned - use read_output."},
	{Name: "execute_command", Description: "Run a PowerShell command in a session (Enter appended automatically) and wait for the output to settle before returning the collected output. The session stays interactive - use read_output with since_offset for anything produced later."},
	{Name: "read_output", Description: "Read output buffered since a byte offset (offset 0 returns recent history). Returns NextOffset to pass back for incremental reads."},
	{Name: "stop_session", Description: "Terminate a pwsh session and its ConPTY, then remove it from the session list."},
	{Name: "resize_session", Description: "Resize a session's pseudo terminal so pwsh reflows its output."},
	{Name: "list_windows", Description: "List the application's terminal windows."},
	{Name: "open_window", Description: "Open a new terminal window, optionally attaching an existing session; a fresh session is started when none is given."},
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
	srv := mcp.NewServer(&mcp.Implementation{Name: "pwsh-mcp", Version: "0.1.0"}, nil)

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
			info, err := pwsh.StartSession("")
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
			if err := pwsh.WriteInput(in.SessionID, in.Input); err != nil {
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
			return nil, executeOut{
				SessionID: in.SessionID,
				Command:   in.Command,
				Output:    tailOutput(output, mcpMaxToolOutput),
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
				Output:     tailOutput(string(data), mcpMaxToolOutput),
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

	// ---- open_window ---------------------------------------------------
	mcp.AddTool(srv,
		&mcp.Tool{
			Name:        "open_window",
			Description: toolDesc("open_window"),
		},
		func(ctx context.Context, req *mcp.CallToolRequest, in openWindowIn) (*mcp.CallToolResult, windowInfoOut, error) {
			if wins == nil {
				return nil, windowInfoOut{}, fmt.Errorf("GUI unavailable (running headless)")
			}
			sid := ""
			if in.SessionID != nil {
				sid = *in.SessionID
			}
			info, err := attachWindow(wins, pwsh, sid)
			if err != nil {
				return nil, windowInfoOut{}, err
			}
			return nil, windowInfoOut{Name: info.Name, Title: info.Title}, nil
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
		if _, err := pwsh.StartSession(info.Name); err != nil {
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

type openWindowIn struct {
	SessionID *string `json:"session_id,omitempty" jsonschema:"Attach this existing session to the new window; omit to start a fresh session in the window."`
}

type windowInfoOut struct {
	Name  string `json:"name"`
	Title string `json:"title"`
}
