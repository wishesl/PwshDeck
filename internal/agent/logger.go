package agent

import (
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// The agent writes a timestamped diagnostic log to
// %APPDATA%\PwshDeck\logs\agent.log (or ~/.config/PwshDeck/logs on Linux,
// ~/Library/Application Support/PwshDeck/logs on macOS). Every emitted event
// plus tool activity and lifecycle changes are recorded so a misbehaving tool
// chain can be diagnosed from the log alone.
var (
	logOnce sync.Once
	logMu   sync.Mutex
	logFile *os.File
)

func openAgentLog() {
	path, err := agentLogPath()
	if err != nil {
		return
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	logFile = f
	log.Printf("agent: logging to %s", path)
}

func agentLogPath() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "PwshDeck", "logs", "agent.log"), nil
}

// agentLogf appends a timestamped line to the agent log file and to stderr.
func agentLogf(format string, args ...any) {
	logOnce.Do(openAgentLog)
	logMu.Lock()
	defer logMu.Unlock()
	line := fmt.Sprintf("%s %s\n", time.Now().Format("2006-01-02 15:04:05.000"), fmt.Sprintf(format, args...))
	if logFile != nil {
		_, _ = logFile.WriteString(line)
	}
	log.Print(line)
}
