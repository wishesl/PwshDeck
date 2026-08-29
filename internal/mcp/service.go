// Package mcp exposes an MCP (Model Context Protocol) server that lets AI
// clients manage pwsh sessions: create terminals, run commands, read output,
// resize or stop sessions, and open terminal windows.
package mcp

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/wailsapp/wails/v3/pkg/application"

	"pwshdeck/internal/config"
	"pwshdeck/internal/session"
	"pwshdeck/internal/window"
)

// ToolInfo describes an exposed MCP tool for the management UI.
type ToolInfo struct {
	Name        string `json:"name"`
	Description string `json:"description"`
}

// MCPStatus is the state reported to the management UI.
type MCPStatus struct {
	Running   bool       `json:"running"`
	URL       string     `json:"url"`
	Port      int        `json:"port"`
	ToolCount int        `json:"tool_count"`
	Tools     []ToolInfo `json:"tools"`
	StdioCmd  string     `json:"stdio_cmd"`
}

// MCPService runs the MCP server that lets AI clients drive pwsh sessions.
//
// Two transports are supported:
//   - streamable-HTTP on 127.0.0.1 (GUI mode, toggle from the MCP page)
//   - stdio via `PwshDeck.exe --mcp` (headless, for classic client configs)
type MCPService struct {
	app  *application.App
	pwsh *session.SessionManager
	wins *window.WindowManager
	cfg  *config.Config

	mu      sync.Mutex
	running bool
	port    int
	httpSrv *http.Server
	tools   []ToolInfo
}

// NewMCPService constructs the service with persisted settings.
// Call Init(app, pwsh, wins) once the Wails application has been created.
func NewMCPService(cfg *config.Config) *MCPService {
	_, tools := BuildServer(nil, nil) // registers once to collect the tool list
	return &MCPService{cfg: cfg, tools: tools}
}

// Init binds the Wails app and collaborating services.
// Excluded from frontend bindings.
//
//wails:ignore
func (m *MCPService) Init(app *application.App, pwsh *session.SessionManager, wins *window.WindowManager) {
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

// portProbeMax bounds how far Enable will search upward for a free port when
// the requested one is already taken by another process.
const portProbeMax = 50

// Enable starts the streamable-HTTP MCP server on the given loopback port and
// persists the choice. When the requested port is busy, the next free port up
// to portProbeMax away is used instead, so a conflicting process never blocks
// the server. Restarting on a new port is allowed while running.
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

	srv, _ := BuildServer(m.pwsh, m.wins)
	sessionTimeout := time.Duration(m.cfg.MCPSessionTimeoutMinutes) * time.Minute
	handler := mcp.NewStreamableHTTPHandler(
		func(*http.Request) *mcp.Server { return srv },
		&mcp.StreamableHTTPOptions{SessionTimeout: sessionTimeout},
	)
	mux := http.NewServeMux()
	mux.Handle("/mcp", handler)

	// Probe upward from the requested port until a listener succeeds.
	var ln net.Listener
	boundPort := 0
	for attempt := 0; attempt <= portProbeMax; attempt++ {
		p := port + attempt
		if p > 65535 {
			break
		}
		addr := fmt.Sprintf("127.0.0.1:%d", p)
		l, err := net.Listen("tcp", addr)
		if err == nil {
			ln = l
			boundPort = p
			break
		}
		if !isAddrInUse(err) {
			return fmt.Errorf("cannot listen on %s: %w", addr, err)
		}
		log.Printf("mcp: port %d in use, trying %d", p, p+1)
	}
	if ln == nil {
		return fmt.Errorf("no free port in range %d-%d", port, port+portProbeMax)
	}
	if boundPort != port {
		log.Printf("mcp: requested port %d was busy, bound to %d instead", port, boundPort)
	}

	httpSrv := &http.Server{Handler: mux}
	go func() {
		if err := httpSrv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Printf("mcp http server stopped: %v", err)
		}
	}()

	m.httpSrv = httpSrv
	m.running = true
	m.port = boundPort

	m.cfg.MCPEnabled = true
	m.cfg.MCPPort = boundPort
	if err := m.cfg.Save(); err != nil {
		log.Printf("failed to persist mcp config: %v", err)
	}
	log.Printf("MCP server listening on http://127.0.0.1:%d/mcp", boundPort)
	return nil
}

// isAddrInUse reports whether a listen error is "address already in use".
func isAddrInUse(err error) bool {
	var opErr *net.OpError
	return errors.As(err, &opErr) && opErr.Err != nil &&
		strings.Contains(opErr.Err.Error(), "address already in use")
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
