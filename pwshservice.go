package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"sync"

	"github.com/UserExistsError/conpty"
	"github.com/wailsapp/wails/v3/pkg/application"
)

// Event names emitted to the frontend.
const (
	// EventData carries raw ANSI/VT byte chunks from the ConPTY. The frontend
	// feeds these straight into xterm.js, which renders them natively.
	EventData = "term_data"
	// EventStatus reports whether the pwsh process is alive.
	EventStatus = "term_status"
)

// Status values for EventStatus.
const (
	StatusConnected    = "connected"
	StatusDisconnected = "disconnected"
)

// PwshService hosts an interactive pwsh session inside a Windows ConPTY, so the
// shell behaves exactly like a real terminal (Tab completion, multi-line input,
// progress bars, Ctrl+C, PSReadLine, ...).
type PwshService struct {
	app     *application.App
	cpty    *conpty.ConPty
	running bool
	mu      sync.Mutex
}

// NewPwshService constructs a service without an App instance.
// Call Init(app) once the Wails application has been created.
func NewPwshService() *PwshService {
	return &PwshService{}
}

// Init binds the Wails app to the service.
func (s *PwshService) Init(app *application.App) {
	s.app = app
}

// StartPwsh launches pwsh inside a ConPTY pseudo terminal.
func (s *PwshService) StartPwsh() error {
	if s.app == nil {
		return fmt.Errorf("service not initialized: app is nil")
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.running {
		return fmt.Errorf("pwsh is already running")
	}

	home, err := os.UserHomeDir()
	if err != nil {
		home = "." // fall back to the current working directory
	}

	cpty, err := conpty.Start(
		`pwsh.exe -NoProfile`,
		conpty.ConPtyDimensions(80, 24),
		conpty.ConPtyWorkDir(home),
	)
	if err != nil {
		return fmt.Errorf("failed to start pwsh in ConPTY: %w", err)
	}

	s.cpty = cpty
	s.running = true

	// Stream raw ConPTY output to the frontend in chunks.
	go s.readLoop(cpty)

	// Watch for the shell exiting.
	go func() {
		exitCode, waitErr := cpty.Wait(context.Background())
		log.Printf("pwsh exited: code=%v err=%v", exitCode, waitErr)
		s.mu.Lock()
		s.running = false
		s.mu.Unlock()
		if s.app != nil {
			s.app.Event.Emit(EventStatus, StatusDisconnected)
		}
	}()

	if s.app != nil {
		s.app.Event.Emit(EventStatus, StatusConnected)
	}
	return nil
}

// readLoop forwards ConPTY output to the frontend as raw byte chunks.
func (s *PwshService) readLoop(cpty *conpty.ConPty) {
	buf := make([]byte, 4096)
	for {
		n, err := cpty.Read(buf)
		if n > 0 {
			if s.app != nil {
				s.app.Event.Emit(EventData, string(buf[:n]))
			}
		}
		if err != nil {
			log.Printf("conpty read ended: %v", err)
			return
		}
	}
}

// WriteInput forwards keystrokes or pasted text to the shell's stdin.
// xterm.js delivers data (including escape sequences for arrows etc.) via its
// onData callback, and we pass it through untouched.
func (s *PwshService) WriteInput(data string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if !s.running {
		return fmt.Errorf("pwsh is not running")
	}
	_, err := s.cpty.Write([]byte(data))
	if err != nil {
		return fmt.Errorf("failed to write to pwsh: %w", err)
	}
	return nil
}

// Resize informs the ConPTY of the terminal's new dimensions so pwsh reflows
// its layout. Called by the frontend whenever xterm.js is resized.
func (s *PwshService) Resize(cols, rows int) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if !s.running {
		return fmt.Errorf("pwsh is not running")
	}
	return s.cpty.Resize(cols, rows)
}

// StopPwsh terminates the ConPTY and the shell inside it.
func (s *PwshService) StopPwsh() error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.running {
		err := s.cpty.Close()
		s.running = false
		return err
	}
	return nil
}
