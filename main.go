package main

import (
	"context"
	"embed"
	"flag"
	"log"
	"time"

	mcpapi "github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/wailsapp/wails/v3/pkg/application"

	"pwshdeck/internal/config"
	"pwshdeck/internal/mcp"
	"pwshdeck/internal/session"
	"pwshdeck/internal/window"
)

// Wails uses Go's `embed` package to embed the frontend files into the binary.
// Any files in the frontend/dist folder will be embedded into the binary and
// made available to the frontend.
// See https://pkg.go.dev/embed for more information.

//go:embed all:frontend/dist
var assets embed.FS

//go:embed build/appicon.png
var appIcon []byte

// applicationName is kept as a build-time variable so temporary test builds
// can use a distinct Wails/WebView identity without changing the normal build.
var applicationName = "PwshDeck"

// main supports two modes:
//   - default: the GUI terminal app; optionally serves MCP over HTTP on
//     127.0.0.1 so local AI clients can manage pwsh sessions.
//   - --mcp:   a headless stdio MCP server speaking JSON-RPC on stdin/stdout,
//     for classic "command" style MCP client configs.
func main() {
	mcpStdio := flag.Bool("mcp", false, "run as a headless stdio MCP server for AI clients")
	flag.Parse()

	if *mcpStdio {
		runStdioMCPServer()
		return
	}
	runGUI()
}

// runStdioMCPServer serves the pwsh-management tools over stdin/stdout without
// any GUI. Sessions created here are window-less invisible shells; no session
// cap or idle recycling applies (the client owns the process lifecycle).
func runStdioMCPServer() {
	pwsh := session.NewSessionManager(0, 0)
	defer pwsh.ShutdownAll() // graceful client disconnect still cleans up shells
	srv, _ := mcp.BuildServer(pwsh, nil)
	if err := srv.Run(context.Background(), &mcpapi.StdioTransport{}); err != nil {
		log.Fatal(err)
	}
}

// runGUI boots the desktop application.
func runGUI() {
	// Only one GUI instance may run; focus the existing window otherwise.
	if !acquireSingleInstance() {
		return
	}

	cfg := config.Load()
	pwshSvc := session.NewSessionManager(
		cfg.MaxSessions,
		time.Duration(cfg.IdleTimeoutMinutes)*time.Minute,
	)
	winSvc := window.NewWindowManager()
	mcpSvc := mcp.NewMCPService(cfg)

	// Create a new Wails application by providing the necessary options.
	// 'Assets' configures the asset server with the 'FS' variable pointing to
	// the frontend files. 'Services' are exposed to the frontend bindings.
	app := application.New(application.Options{
		Name:        applicationName,
		Description: "Interactive shell terminal (pwsh on Windows, bash on macOS/Linux) with MCP remote control",
		Services: []application.Service{
			application.NewService(pwshSvc),
			application.NewService(winSvc),
			application.NewService(mcpSvc),
		},
		Assets: application.AssetOptions{
			Handler: application.AssetFileServerFS(assets),
		},
		Mac: application.MacOptions{
			ApplicationShouldTerminateAfterLastWindowClosed: true,
		},
	})

	pwshSvc.Init(app)
	winSvc.Init(app, pwshSvc)
	mcpSvc.Init(app, pwshSvc, winSvc)

	// The system tray icon is created together with the first window.
	winSvc.SetTrayIcon(appIcon)

	// Close every shell when the application exits.
	app.OnShutdown(func() {
		mcpSvc.Shutdown()
		pwshSvc.ShutdownAll()
	})

	// Restore the persisted MCP server choice.
	if cfg.MCPEnabled {
		if err := mcpSvc.Enable(cfg.MCPPort); err != nil {
			log.Printf("failed to auto-start MCP server on port %d: %v", cfg.MCPPort, err)
		}
	}

	// First terminal window; more can be opened from the UI or via MCP.
	if _, err := winSvc.NewWindow(); err != nil {
		log.Fatal(err)
	}

	// When a second instance launches (single-instance mutex), it signals the
	// show event; reveal the windows through Wails' Show() so the WebView2
	// content is restored too (not just the native window frame).
	go watchShowRequest(winSvc.ShowFromTray)

	// Run the application. This blocks until the application has been exited.
	if err := app.Run(); err != nil {
		log.Fatal(err)
	}
}
