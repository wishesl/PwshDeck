package main

import (
	"context"
	"embed"
	"flag"
	"log"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/wailsapp/wails/v3/pkg/application"
)

// Wails uses Go's `embed` package to embed the frontend files into the binary.
// Any files in the frontend/dist folder will be embedded into the binary and
// made available to the frontend.
// See https://pkg.go.dev/embed for more information.

//go:embed all:frontend/dist
var assets embed.FS

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
// any GUI. Sessions created here are window-less invisible shells.
func runStdioMCPServer() {
	pwsh := NewSessionManager()
	srv, _ := buildMCPServer(pwsh, nil)
	if err := srv.Run(context.Background(), &mcp.StdioTransport{}); err != nil {
		log.Fatal(err)
	}
}

// runGUI boots the desktop application.
func runGUI() {
	cfg := LoadConfig()
	pwshSvc := NewSessionManager()
	winSvc := NewWindowManager()
	mcpSvc := NewMCPService(cfg)

	// Create a new Wails application by providing the necessary options.
	// 'Assets' configures the asset server with the 'FS' variable pointing to
	// the frontend files. 'Services' are exposed to the frontend bindings.
	app := application.New(application.Options{
		Name:        "pwsh-mcp",
		Description: "Interactive pwsh terminal with MCP remote control",
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

	pwshSvc.init(app)
	winSvc.init(app, pwshSvc)
	mcpSvc.init(app, pwshSvc, winSvc)

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

	// Run the application. This blocks until the application has been exited.
	if err := app.Run(); err != nil {
		log.Fatal(err)
	}
}
