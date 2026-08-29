// Package window creates and tracks the application's terminal windows.
package window

import (
	"fmt"
	"log"
	"sort"
	"sync"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"

	"pwsh-mcp/internal/config"
	"pwsh-mcp/internal/session"
)

// WindowInfo is the wire-safe view of an application window.
type WindowInfo struct {
	Name  string `json:"name"`
	Title string `json:"title"`
}

// WindowManager creates and tracks terminal windows. Every window loads the
// same frontend, which then starts (or attaches) a pwsh session bound to the
// window name.
//
//go:generate wails3 generate bindings
type WindowManager struct {
	app  *application.App
	pwsh *session.SessionManager

	mu      sync.Mutex
	counter int
	titles  map[string]string // window name -> title, for windows we created
}

// NewWindowManager constructs a service without an App instance.
// Call Init(app, pwsh) once the Wails application has been created.
func NewWindowManager() *WindowManager {
	return &WindowManager{titles: make(map[string]string)}
}

// Init binds the Wails app and the session manager to the service.
// Excluded from frontend bindings.
//
//wails:ignore
func (w *WindowManager) Init(app *application.App, pwsh *session.SessionManager) {
	w.app = app
	w.pwsh = pwsh
}

// NewWindow opens a new terminal window and returns its identity. When the
// window closes, sessions bound to it are stopped automatically.
func (w *WindowManager) NewWindow() (*WindowInfo, error) {
	if w.app == nil {
		return nil, fmt.Errorf("service not initialized: app is nil")
	}
	w.mu.Lock()
	w.counter++
	n := w.counter
	w.mu.Unlock()

	name := fmt.Sprintf("terminal-%d", n)
	title := fmt.Sprintf("pwsh Terminal #%d", n)
	w.mu.Lock()
	w.titles[name] = title
	w.mu.Unlock()

	win := w.app.Window.NewWithOptions(application.WebviewWindowOptions{
		Name:             name,
		Title:            title,
		Width:            1000,
		Height:           618,
		MinWidth:         500,
		MinHeight:        300,
		Frameless:        true, // custom transparent title bar (webview topbar)
		BackgroundType:   application.BackgroundTypeTransparent,
		BackgroundColour: application.RGBA{Red: 8, Green: 10, Blue: 16, Alpha: 140},
		URL:              "/",
	})
	if win == nil {
		return nil, fmt.Errorf("failed to create window %q", name)
	}

	// Clean up bound sessions when the window goes away. WM_CLOSE emits the
	// platform event; Close() emits the common one — cover both.
	cleanup := func(*application.WindowEvent) {
		w.pwsh.StopSessionsForWindow(name)
	}
	win.OnWindowEvent(events.Windows.WindowClosing, cleanup)
	win.OnWindowEvent(events.Common.WindowClosing, cleanup)

	log.Printf("window %s created", name)
	return &WindowInfo{Name: name, Title: title}, nil
}

// CloseWindow closes the window with the given name (session cleanup runs via
// the WindowClosing hooks).
func (w *WindowManager) CloseWindow(name string) error {
	if w.app == nil {
		return fmt.Errorf("service not initialized: app is nil")
	}
	win, ok := w.app.Window.GetByName(name)
	if !ok {
		return fmt.Errorf("unknown window %q", name)
	}
	win.Close()
	return nil
}

// ListWindows returns the application windows created by this service that
// are still alive, ordered by name.
func (w *WindowManager) ListWindows() []WindowInfo {
	if w.app == nil {
		return nil
	}
	alive := make(map[string]bool)
	for _, win := range w.app.Window.GetAll() {
		alive[win.Name()] = true
	}

	w.mu.Lock()
	defer w.mu.Unlock()
	list := make([]WindowInfo, 0, len(w.titles))
	for name, title := range w.titles {
		if alive[name] {
			list = append(list, WindowInfo{Name: name, Title: title})
		}
	}
	sort.Slice(list, func(i, j int) bool { return list[i].Name < list[j].Name })
	return list
}

// GetTabPrefs returns the persisted terminal tab layout (title + accent per
// tab). Sessions themselves are not persisted — each tab boots a fresh shell.
func (w *WindowManager) GetTabPrefs() []config.TabPref {
	return config.Load().Tabs
}

// SetTabPrefs persists the terminal tab layout so it is restored on the next
// launch.
func (w *WindowManager) SetTabPrefs(prefs []config.TabPref) error {
	if prefs == nil {
		prefs = []config.TabPref{}
	}
	cfg := config.Load()
	cfg.Tabs = prefs
	return cfg.Save()
}
