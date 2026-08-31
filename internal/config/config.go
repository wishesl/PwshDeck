// Package config persists application settings to the user config directory.
package config

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sync"
)

// DefaultMCPPort is the TCP port the streamable-HTTP MCP server listens on
// unless configured otherwise.
const DefaultMCPPort = 21724

// Defaults for resource-management settings when not present in the config.
const (
	// DefaultMCPSessionTimeoutMinutes expires idle MCP client sessions after
	// one hour, so stale sessions do not pile up after client restarts.
	DefaultMCPSessionTimeoutMinutes = 60
	// DefaultMaxSessions caps concurrently running shells.
	DefaultMaxSessions = 10
	// DefaultIdleTimeoutMinutes auto-recycles window-less (MCP-created)
	// sessions that produced no activity for half an hour.
	DefaultIdleTimeoutMinutes = 30
)

// fileMu serializes config file IO so concurrent Load/Save calls (e.g. MCP
// toggle + tab persistence) cannot corrupt the file.
var fileMu sync.Mutex

// These are variables so disposable test builds can override both paths with
// -ldflags -X and avoid sharing settings with the normal application.
var configDirName = "PwshDeck"
var legacyConfigDirName = "pwsh-mcp"

// TabPref is the persisted UI state of one terminal tab (sessions themselves
// are not restored — each tab boots a fresh shell on startup).
type TabPref struct {
	// ID is the stable dockview panel id, so the persisted split layout can be
	// matched back to the right tab on restore. Empty for legacy entries.
	ID     string `json:"id"`
	Title  string `json:"title"`
	Accent string `json:"accent"`
	// Pwd is the tab's last-known working directory; the restored shell boots
	// here instead of the user's home directory. Empty means home.
	Pwd string `json:"pwd"`
}

// Config holds persisted application settings.
type Config struct {
	// MCPEnabled auto-starts the streamable-HTTP MCP server on launch.
	MCPEnabled bool `json:"mcp_enabled"`
	// MCPPort is the TCP port for the HTTP MCP server.
	MCPPort int `json:"mcp_port"`
	// MCPSessionTimeoutMinutes expires idle MCP client sessions.
	MCPSessionTimeoutMinutes int `json:"mcp_session_timeout_minutes"`
	// MaxSessions caps the number of concurrently running shells (0 = no cap).
	MaxSessions int `json:"max_sessions"`
	// IdleTimeoutMinutes auto-recycles window-less sessions idle this long
	// (0 = disabled).
	IdleTimeoutMinutes int `json:"idle_timeout_minutes"`
	// Tabs holds the terminal tab layout (title + accent color per tab).
	Tabs []TabPref `json:"tabs"`
	// Layout is the serialized dockview split layout (JSON from api.toJSON()).
	// It restores how tabs are arranged into panes on launch. Empty = default
	// single pane.
	Layout string `json:"layout"`
	// LayoutDraggable controls whether tabs can be dragged between windows or
	// split into additional panes. The default keeps the existing behavior.
	LayoutDraggable bool `json:"layout_draggable"`
}

// Load reads config.json from the user config directory, falling back to
// defaults (and persisting them) when the file is missing or unreadable.
func Load() *Config {
	def := Defaults()

	fileMu.Lock()
	defer fileMu.Unlock()

	migrateLocked()

	path, err := configPath()
	if err != nil {
		return def
	}
	data, err := os.ReadFile(path)
	if err != nil {
		_ = def.saveLocked() // first run: persist defaults
		return def
	}
	cfg := &Config{}
	if err := json.Unmarshal(data, cfg); err != nil {
		return def
	}
	// Keep existing installations in the original draggable mode when the
	// newly introduced field is absent. An explicit false must remain false.
	var layoutMode struct {
		LayoutDraggable *bool `json:"layout_draggable"`
	}
	if err := json.Unmarshal(data, &layoutMode); err == nil && layoutMode.LayoutDraggable == nil {
		cfg.LayoutDraggable = def.LayoutDraggable
	}
	cfg.sanitize()
	return cfg
}

// Defaults returns a Config populated with default values.
func Defaults() *Config {
	return &Config{
		MCPEnabled:               false,
		MCPPort:                  DefaultMCPPort,
		MCPSessionTimeoutMinutes: DefaultMCPSessionTimeoutMinutes,
		MaxSessions:              DefaultMaxSessions,
		IdleTimeoutMinutes:       DefaultIdleTimeoutMinutes,
		LayoutDraggable:          true,
	}
}

// sanitize repairs out-of-range values with their defaults.
func (c *Config) sanitize() {
	if c.MCPPort <= 0 || c.MCPPort > 65535 {
		c.MCPPort = DefaultMCPPort
	}
	if c.MCPSessionTimeoutMinutes < 0 {
		c.MCPSessionTimeoutMinutes = DefaultMCPSessionTimeoutMinutes
	}
	if c.MaxSessions < 0 {
		c.MaxSessions = DefaultMaxSessions
	}
	if c.IdleTimeoutMinutes < 0 {
		c.IdleTimeoutMinutes = DefaultIdleTimeoutMinutes
	}
	if c.Tabs == nil {
		c.Tabs = []TabPref{}
	}
}

// Save persists the config to disk.
func (c *Config) Save() error {
	fileMu.Lock()
	defer fileMu.Unlock()
	return c.saveLocked()
}

func (c *Config) saveLocked() error {
	path, err := configPath()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o644)
}

// migrateLocked moves the legacy (pre-rename) config directory to the new
// location when the new one does not exist yet, so existing settings survive
// the rename. Callers must hold fileMu.
func migrateLocked() {
	dir, err := os.UserConfigDir()
	if err != nil {
		return
	}
	oldDir := filepath.Join(dir, legacyConfigDirName)
	newDir := filepath.Join(dir, configDirName)
	if _, err := os.Stat(newDir); err == nil {
		return // already migrated or created fresh
	}
	if _, err := os.Stat(oldDir); err != nil {
		return // nothing to migrate
	}
	if err := os.Rename(oldDir, newDir); err != nil {
		log.Printf("config: migrate %s -> %s failed: %v", oldDir, newDir, err)
	}
}

func configPath() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", fmt.Errorf("cannot resolve user config dir: %w", err)
	}
	return filepath.Join(dir, configDirName, "config.json"), nil
}
