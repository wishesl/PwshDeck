// Package config persists application settings to the user config directory.
package config

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

// DefaultMCPPort is the TCP port the streamable-HTTP MCP server listens on
// unless configured otherwise.
const DefaultMCPPort = 21724

// Config holds persisted application settings.
type Config struct {
	// MCPEnabled auto-starts the streamable-HTTP MCP server on launch.
	MCPEnabled bool `json:"mcp_enabled"`
	// MCPPort is the TCP port for the HTTP MCP server.
	MCPPort int `json:"mcp_port"`
}

// Load reads config.json from the user config directory, falling back to
// defaults (and persisting them) when the file is missing or unreadable.
func Load() *Config {
	def := &Config{MCPEnabled: false, MCPPort: DefaultMCPPort}

	path, err := configPath()
	if err != nil {
		return def
	}
	data, err := os.ReadFile(path)
	if err != nil {
		_ = def.Save() // first run: persist defaults
		return def
	}
	cfg := &Config{}
	if err := json.Unmarshal(data, cfg); err != nil {
		return def
	}
	if cfg.MCPPort <= 0 || cfg.MCPPort > 65535 {
		cfg.MCPPort = DefaultMCPPort
	}
	return cfg
}

// Save persists the config to disk.
func (c *Config) Save() error {
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

func configPath() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", fmt.Errorf("cannot resolve user config dir: %w", err)
	}
	return filepath.Join(dir, "pwsh-mcp", "config.json"), nil
}
