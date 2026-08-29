package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"sync"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/wailsapp/wails/v3/pkg/application"
)

// mcpMaxToolOutput bounds the output text returned by execute_command /
// read_output, keeping the tail where fresh output lives.
const mcpMaxToolOutput = 96 * 1024

// ToolInfo describes an exposed MCP tool for the management UI.
type ToolInfo struct {
	Name        string `json:"name"`
	Description string `json:"description"`
}

// MCPStatus is the state reported to the management UI.
type MCPStatus struct {
	Running   bool     `json:"running"`
	URL       string   `json:"url"`
	Port      int      `json:"port"`
	ToolCount int      `json:"tool_count"`
	Tools     []ToolInfo `json:"tools"`
	StdioCmd  string   `json:"stdio_cmd"`
}

// MCPService exposes an MCP (Model Context Protocol) server that lets AI
// clients manage pwsh sessions: create terminals, run commands, read output,
// resize or stop sessions, and open terminal windows.
//
// Two transports are supported:
//   - streamable-HTTP on 127.0.0.1 (GUI mode, toggle from the MCP page)
//   - stdio via `pwsh-mcp.exe --mcp` (headless, for classic client configs)
type MCPService struct {
	app  *application.App
	pwsh *SessionManager
	wins *WindowManager
	cfg  *Config

	mu      sync.Mutex
	running bool
	port    int
	httpSrv *http.Server
	tools   []ToolInfo
}

// NewMCPService constructs the service with persisted settings.
// Call Init(app, pwsh, wins) once the Wails application has been created.
func NewMCPService(cfg *Config) *MCPService {
	_, tools := buildMCPServer(nil, nil) // registers once to collect the tool list
	return &MCPService{cfg: cfg, tools: tools}
}

// init binds the Wails app and collaborating services.
// Unexported so Wails3 does not expose cross-service type references.
func (m *MCPService) init(app *application.App, pwsh *SessionManager, wins *WindowManager) {
	m.app = app
	m.pwsh = pwsh
	m.wins = wins
}

// GetStatus reports the MCP server state for the management UI.
func (m *MCPService) GetStatus() MCPStatus {
	m.mu.Lock()
	defer m.mu.Unlock()
	exe, _ := os.Executable()
	return MCPStatus{
		Running:   m.running,
		URL:       fmt.Sprintf("http://127.0.0.1:%d/mcp", m.port),
		Port:      m.port,
		ToolCount: len(m.tools),
		Tools:     m.tools,
		StdioCmd:  fmt.Sprintf("%q --mcp", exe),
	}
}

// Enable starts the streamable-HTTP MCP server on the given loopback port and
// persists the choice. Restarting on a new port is allowed while running.
func (m *MCPService) Enable(port int) error {
	if m.pwsh == nil {
		return fmt.Errorf("service not initialized")
	}
	if port < 1024 || port > 65535 {
		return fmt.Errorf("port %d out of range (1024-65535)", port)
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	if m.running {
		if m.port == port {
			return nil
		}
		if err := m.stopLocked(); err != nil {
			return err
		}
	}

	srv, _ := buildMCPServer(m.pwsh, m.wins)
	handler := mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return srv }, nil)
	mux := http.NewServeMux()
	mux.Handle("/mcp", handler)

	addr := fmt.Sprintf("127.0.0.1:%d", port)
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return fmt.Errorf("cannot listen on %s: %w", addr, err)
	}
	httpSrv := &http.Server{Handler: mux}
	go func() {
		if err := httpSrv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Printf("mcp http server stopped: %v", err)
		}
	}()

	m.httpSrv = httpSrv
	m.running = true
	m.port = port

	m.cfg.MCPEnabled = true
	m.cfg.MCPPort = port
	if err := m.cfg.Save(); err != nil {
		log.Printf("failed to persist mcp config: %v", err)
	}
	log.Printf("MCP server listening on http://%s/mcp", addr)
	return nil
}

// Disable stops the HTTP MCP server and persists the choice.
func (m *MCPService) Disable() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if !m.running {
		return nil
	}
	if err := m.stopLocked(); err != nil {
		return err
	}
	m.cfg.MCPEnabled = false
	if err := m.cfg.Save(); err != nil {
		log.Printf("failed to persist mcp config: %v", err)
	}
	log.Println("MCP server stopped")
	return nil
}

func (m *MCPService) stopLocked() error {
	if m.httpSrv == nil {
		m.running = false
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	err := m.httpSrv.Shutdown(ctx)
	m.httpSrv = nil
	m.running = false
	return err
}

// Shutdown stops the HTTP server on application exit.
func (m *MCPService) Shutdown() {
	m.mu.Lock()
	defer m.mu.Unlock()
	_ = m.stopLocked()
}

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

// buildMCPServer wires all pwsh-management tools into a new MCP server and
// returns it together with the exposed tool list. When pwsh/wins are nil the
// tools are registered anyway but report "unavailable" at call time (used to
// collect the tool list for the UI).
func buildMCPServer(pwsh *SessionManager, wins *WindowManager) (*mcp.Server, []ToolInfo) {
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
				out.Sessions = []SessionInfo{}
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
			output, timedOut, err := pwsh.executeCommand(in.SessionID, in.Command, timeout)
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
				out.Windows = []WindowInfo{}
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
func attachWindow(wins *WindowManager, pwsh *SessionManager, sessionID string) (*WindowInfo, error) {
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

// ---- MCP tool IO types --------------------------------------------------
// jsonschema struct tags become property descriptions; omitempty keeps
// fields optional.

type listSessionsIn struct{}

type sessionListOut struct {
	Sessions []SessionInfo `json:"sessions"`
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
	Windows []WindowInfo `json:"windows"`
}

type openWindowIn struct {
	SessionID *string `json:"session_id,omitempty" jsonschema:"Attach this existing session to the new window; omit to start a fresh session in the window."`
}

type windowInfoOut struct {
	Name  string `json:"name"`
	Title string `json:"title"`
}
