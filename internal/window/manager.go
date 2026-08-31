// Package window creates and tracks the application's terminal windows.
package window

import (
	"fmt"
	"log"
	"sort"
	"sync"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"

	"pwshdeck/internal/config"
	"pwshdeck/internal/session"
)

// WindowInfo is the wire-safe view of an application window.
type WindowInfo struct {
	Name  string `json:"name"`
	Title string `json:"title"`
}

// EventCloseRequested is emitted to a window when the OS asks it to close
// (Alt+F4, taskbar "Close window"), so the frontend can ask the user whether
// to hide the app to the system tray or quit. The custom close button in the
// top bar shows the same dialog directly.
const EventCloseRequested = "window-close-requested"

// WindowManager creates and tracks terminal windows. Every window loads the
// same frontend, which then starts (or attaches) a pwsh session bound to the
// window name.
//
//go:generate wails3 generate bindings
type WindowManager struct {
	app  *application.App
	pwsh *session.SessionManager

	tray    *application.SystemTray // created lazily with the first window
	icon    []byte                  // tray icon bytes (PNG), set from main
	primary string                  // window name attached to the tray

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

// SetTrayIcon stores the PNG bytes used for the system tray icon. Call it once
// before the first window is created. Excluded from frontend bindings.
//
//wails:ignore
func (w *WindowManager) SetTrayIcon(icon []byte) {
	w.icon = icon
}

// NewWindow opens a new terminal window and returns its identity. When the
// window closes, sessions bound to it are stopped automatically.
func (w *WindowManager) NewWindow() (*WindowInfo, error) {
	if w.app == nil {
		return nil, fmt.Errorf("service not initialized: app is nil")
	}
	if !config.Load().LayoutDraggable && len(w.app.Window.GetAll()) > 0 {
		return nil, fmt.Errorf("additional windows are disabled by the current layout setting")
	}
	w.mu.Lock()
	w.counter++
	n := w.counter
	w.mu.Unlock()

	name := fmt.Sprintf("terminal-%d", n)
	title := fmt.Sprintf("PwshDeck #%d", n)
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

	// Stop sessions bound to this window only when it truly closes. A native
	// close request (WM_CLOSE → events.Windows.WindowClosing) is intercepted
	// and turned into a "hide to tray vs quit" prompt instead, so it must NOT
	// tear down sessions here — that happens on the real close
	// (events.Common.WindowClosing) below.
	win.OnWindowEvent(events.Windows.WindowClosing, func(*application.WindowEvent) {
		win.EmitEvent(EventCloseRequested)
	})
	win.OnWindowEvent(events.Common.WindowClosing, func(*application.WindowEvent) {
		w.pwsh.StopSessionsForWindow(name)
	})

	// First window carries the system tray; subsequent windows just reuse it.
	w.ensureTray(win)

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

// GetLayout returns the persisted dockview split layout (JSON). An empty
// string means no layout was saved yet and the default single pane is used.
func (w *WindowManager) GetLayout() string {
	return config.Load().Layout
}

// SetLayout persists the dockview split layout (JSON from the frontend's
// api.toJSON()) so panes are restored on the next launch.
func (w *WindowManager) SetLayout(json string) error {
	cfg := config.Load()
	cfg.Layout = json
	return cfg.Save()
}

// GetLayoutDraggable returns whether the current layout allows tabs to leave
// their window or create split panes.
func (w *WindowManager) GetLayoutDraggable() bool {
	return config.Load().LayoutDraggable
}

// SetLayoutDraggable persists the layout mode. Switching to a fixed layout also
// closes any other GUI windows so only the caller's window remains.
func (w *WindowManager) SetLayoutDraggable(draggable bool, currentWindow string) error {
	cfg := config.Load()
	cfg.LayoutDraggable = draggable
	if err := cfg.Save(); err != nil {
		return err
	}
	if draggable || w.app == nil {
		return nil
	}
	if currentWindow == "" {
		currentWindow = w.primary
	}
	for _, win := range w.app.Window.GetAll() {
		if win.Name() != currentWindow {
			win.Close()
		}
	}
	return nil
}

// HideToTray hides every window but keeps the app (sessions + MCP server)
// running in the background. The user restores it from the system tray icon.
func (w *WindowManager) HideToTray() error {
	if w.app == nil {
		return fmt.Errorf("service not initialized: app is nil")
	}
	for _, win := range w.app.Window.GetAll() {
		win.Hide()
	}
	return nil
}

// ShowFromTray restores all windows and brings the primary one to the front.
// Handles both tray-hidden windows (hidden via Hide() → need Show() to restore
// the WebView2 surface) and taskbar-minimised windows (need UnMinimise()).
func (w *WindowManager) ShowFromTray() {
	if w.app == nil {
		return
	}
	for _, win := range w.app.Window.GetAll() {
		if win.IsMinimised() {
			win.UnMinimise()
		} else {
			win.Show()
		}
	}
	if w.primary != "" {
		if win, ok := w.app.Window.GetByName(w.primary); ok {
			win.Focus()
		}
	}
}

// QuitApp exits the whole application (all windows, sessions and the MCP
// server). Used by the close dialog and the tray menu.
func (w *WindowManager) QuitApp() {
	if w.app != nil {
		w.app.Quit()
	}
}

// ensureTray creates the system tray icon on the first window. It is called
// before app.Run(), so New() defers the actual Run() until startup; the icon,
// tooltip, menu and click handler are stored on the tray and picked up then.
func (w *WindowManager) ensureTray(win *application.WebviewWindow) {
	if w.app == nil || w.tray != nil {
		return
	}
	w.primary = win.Name()

	tray := w.app.SystemTray.New()
	tray.SetTooltip("PwshDeck")
	if w.icon != nil {
		tray.SetIcon(w.icon)
	}
	tray.SetMenu(w.trayMenu())
	// Left-click restores the window(s); right-click opens the menu.
	tray.OnClick(func() { w.ShowFromTray() })
	tray.AttachWindow(win)
	w.tray = tray

	log.Printf("system tray created")
}

// trayMenu builds the right-click menu for the tray icon.
func (w *WindowManager) trayMenu() *application.Menu {
	m := application.NewMenu()
	m.Add("显示 PwshDeck").OnClick(func(*application.Context) {
		w.ShowFromTray()
	})
	m.AddSeparator()
	m.Add("退出").OnClick(func(*application.Context) {
		w.QuitApp()
	})
	return m
}
