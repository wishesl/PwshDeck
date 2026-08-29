package session

import (
	"context"
	"fmt"
	"log"
	"os"
	"sort"
	"sync"
	"time"

	"github.com/UserExistsError/conpty"
	"github.com/wailsapp/wails/v3/pkg/application"
)

// Event names emitted to the frontend.
const (
	// EventData carries per-session raw ANSI/VT chunks from the ConPTY. The
	// payload is a termEvent; the frontend routes it to the matching xterm.js
	// instance by session id.
	EventData = "term_data"
	// EventStatus reports per-session shell liveness (termEvent payload with
	// Data set to StatusConnected / StatusDisconnected).
	EventStatus = "term_status"
)

// Status values carried in termEvent.Data for EventStatus.
const (
	StatusConnected    = "connected"
	StatusDisconnected = "disconnected"
)

// executeWait bounds the quiet-period polling used by executeCommand.
const (
	executeQuiet     = 700 * time.Millisecond
	executeTick      = 120 * time.Millisecond
	executeDefaultTO = 20 * time.Second
	executeMaxTO     = 120 * time.Second
)

// termEvent is the payload for both terminal events.
type termEvent struct {
	ID   string `json:"id"`
	Data string `json:"data,omitempty"`
}

// SessionManager manages a set of interactive pwsh sessions, each running inside
// its own Windows ConPTY, so shells behave exactly like a real terminal
// (Tab completion, PSReadLine, progress bars, Ctrl+C, ...). Every window owns
// one session, and MCP clients can create and drive additional sessions.
type SessionManager struct {
	app *application.App

	mu       sync.Mutex
	sessions map[string]*TerminalSession
	counter  int
	closed   bool
}

// NewSessionManager constructs a service without an App instance.
// Call Init(app) once the Wails application has been created.
func NewSessionManager() *SessionManager {
	return &SessionManager{sessions: make(map[string]*TerminalSession)}
}

// Init binds the Wails app to the service. Excluded from frontend bindings.
//
//wails:ignore
func (s *SessionManager) Init(app *application.App) {
	s.app = app
}

// StartSession launches a new pwsh inside a ConPTY and registers it.
// windowName associates the session with a GUI window so it can be cleaned up
// when that window closes (may be empty for MCP-only sessions).
func (s *SessionManager) StartSession(windowName string) (*SessionInfo, error) {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return nil, fmt.Errorf("service is shutting down")
	}
	s.counter++
	n := s.counter
	id := newSessionID()
	title := fmt.Sprintf("pwsh #%d", n)

	home, err := os.UserHomeDir()
	if err != nil {
		home = "." // fall back to the current working directory
	}
	cpty, err := conpty.Start(
		`pwsh.exe -NoProfile`,
		conpty.ConPtyDimensions(120, 30),
		conpty.ConPtyWorkDir(home),
	)
	if err != nil {
		s.mu.Unlock()
		return nil, fmt.Errorf("failed to start pwsh in ConPTY: %w", err)
	}

	sess := &TerminalSession{
		ID:        id,
		Title:     title,
		Window:    windowName,
		cpty:      cpty,
		cols:      120,
		rows:      30,
		createdAt: time.Now(),
		running:   true,
	}
	s.sessions[id] = sess
	s.mu.Unlock()

	// Stream raw ConPTY output to the frontend in chunks.
	go s.readLoop(sess)
	// Watch for the shell exiting.
	go s.waitExit(sess)

	s.emitStatus(sess, StatusConnected)
	info := sess.Info()
	log.Printf("session %s started (%s)", id, windowName)
	return &info, nil
}

// WriteInput forwards keystrokes or pasted text to a session's stdin.
// xterm.js delivers data (including escape sequences for arrows etc.) via its
// onData callback, and we pass it through untouched.
func (s *SessionManager) WriteInput(id string, data string) error {
	return s.getSession(id).writeInput(data)
}

// Resize informs the ConPTY of the terminal's new dimensions so pwsh reflows
// its layout. Called by the frontend whenever xterm.js is resized.
func (s *SessionManager) Resize(id string, cols, rows int) error {
	return s.getSession(id).resize(cols, rows)
}

// StopSession terminates a session's ConPTY and shell, then forgets it.
func (s *SessionManager) StopSession(id string) error {
	s.mu.Lock()
	sess, ok := s.sessions[id]
	if ok {
		delete(s.sessions, id)
	}
	s.mu.Unlock()
	if !ok {
		return fmt.Errorf("unknown session %q", id)
	}
	err := sess.close()
	log.Printf("session %s stopped", id)
	return err
}

// ListSessions returns all sessions, oldest first.
func (s *SessionManager) ListSessions() []SessionInfo {
	s.mu.Lock()
	list := make([]*TerminalSession, 0, len(s.sessions))
	for _, sess := range s.sessions {
		list = append(list, sess)
	}
	s.mu.Unlock()

	sort.Slice(list, func(i, j int) bool {
		return list[i].createdAt.Before(list[j].createdAt)
	})
	infos := make([]SessionInfo, 0, len(list))
	for _, sess := range list {
		infos = append(infos, sess.Info())
	}
	return infos
}

// ReadOutput returns output buffered since the given byte offset. Use the
// returned NextOffset for follow-up calls; offset 0 returns recent history.
func (s *SessionManager) ReadOutput(id string, since int64) ([]byte, int64, bool, error) {
	sess := s.getSession(id)
	data, next, dropped := sess.buf.since(since)
	return data, next, dropped, nil
}

// BindSessionWindow rebinds an existing session to another window, so closing
// that window stops the session.
func (s *SessionManager) BindSessionWindow(id, windowName string) error {
	s.mu.Lock()
	sess, ok := s.sessions[id]
	s.mu.Unlock()
	if !ok {
		return fmt.Errorf("unknown session %q", id)
	}
	sess.mu.Lock()
	sess.Window = windowName
	sess.mu.Unlock()
	return nil
}

// StopSessionsForWindow closes every session bound to the named window.
// Called when a window closes so its shell does not leak.
func (s *SessionManager) StopSessionsForWindow(windowName string) {
	if windowName == "" {
		return
	}
	s.mu.Lock()
	victims := make([]*TerminalSession, 0, 1)
	for id, sess := range s.sessions {
		sess.mu.Lock()
		bound := sess.Window == windowName
		sess.mu.Unlock()
		if bound {
			victims = append(victims, sess)
			delete(s.sessions, id)
		}
	}
	s.mu.Unlock()
	for _, sess := range victims {
		_ = sess.close()
		log.Printf("session %s closed with window %s", sess.ID, windowName)
	}
}

// ShutdownAll closes every session; used on application exit.
func (s *SessionManager) ShutdownAll() {
	s.mu.Lock()
	s.closed = true
	all := make([]*TerminalSession, 0, len(s.sessions))
	for id, sess := range s.sessions {
		all = append(all, sess)
		delete(s.sessions, id)
	}
	s.mu.Unlock()
	for _, sess := range all {
		_ = sess.close()
	}
}

// getSession looks a session up by id.
func (s *SessionManager) getSession(id string) *TerminalSession {
	s.mu.Lock()
	defer s.mu.Unlock()
	sess, ok := s.sessions[id]
	if !ok {
		return &TerminalSession{ID: id} // placeholder; ops will report "not running"
	}
	return sess
}

// ExecuteCommand writes command followed by Enter, then waits for output to
// settle (a short quiet period) or until the timeout expires, and returns the
// output produced since the command was sent. Excluded from frontend bindings.
//
//wails:ignore
func (s *SessionManager) ExecuteCommand(id, command string, timeout time.Duration) (string, bool, error) {
	sess := s.getSession(id)
	if !sess.isRunning() {
		return "", false, fmt.Errorf("session %q is not running", id)
	}
	if timeout <= 0 {
		timeout = executeDefaultTO
	}
	if timeout > executeMaxTO {
		timeout = executeMaxTO
	}

	startSeq := sess.buf.lastSeq()
	if err := sess.writeInput(command + "\r"); err != nil {
		return "", false, err
	}

	deadline := time.Now().Add(timeout)
	var act time.Time
	for {
		time.Sleep(executeTick)
		act = sess.buf.lastActivity()
		if !act.IsZero() && time.Since(act) >= executeQuiet {
			break
		}
		if time.Now().After(deadline) {
			break
		}
	}
	timedOut := act.IsZero() || time.Since(act) < executeQuiet
	data, _, _ := sess.buf.since(startSeq)
	return string(data), timedOut, nil
}

// readLoop forwards ConPTY output to the frontend and the session buffer.
func (s *SessionManager) readLoop(sess *TerminalSession) {
	buf := make([]byte, 4096)
	for {
		n, err := sess.cpty.Read(buf)
		if n > 0 {
			chunk := string(buf[:n])
			sess.buf.write(buf[:n])
			s.emitData(sess, chunk)
		}
		if err != nil {
			log.Printf("conpty read ended for session %s: %v", sess.ID, err)
			return
		}
	}
}

// waitExit marks the session dead once the shell process returns. The entry
// stays registered so its final output remains readable (via read_output /
// the UI buffer) until the window closes or the session is stopped.
func (s *SessionManager) waitExit(sess *TerminalSession) {
	exitCode, waitErr := sess.cpty.Wait(context.Background())
	log.Printf("pwsh session %s exited: code=%v err=%v", sess.ID, exitCode, waitErr)
	sess.mu.Lock()
	sess.running = false
	sess.mu.Unlock()
	s.emitStatus(sess, StatusDisconnected)
}

func (s *SessionManager) emitData(sess *TerminalSession, chunk string) {
	if s.app != nil {
		s.app.Event.Emit(EventData, termEvent{ID: sess.ID, Data: chunk})
	}
}

func (s *SessionManager) emitStatus(sess *TerminalSession, status string) {
	if s.app != nil {
		s.app.Event.Emit(EventStatus, termEvent{ID: sess.ID, Data: status})
	}
}
