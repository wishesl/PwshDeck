package session

import (
	"context"
	"encoding/base64"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"
	"unicode/utf16"

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
	// EventPwd reports per-session working-directory changes (termEvent
	// payload with Data set to the current path), so the UI can persist each
	// tab's pwd without polling.
	EventPwd = "term_pwd"
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

	maxSessions int           // 0 = unlimited
	idleTimeout time.Duration // 0 = disabled; only window-less sessions recycle

	mu       sync.Mutex
	sessions map[string]*TerminalSession
	counter  int
	closed   bool
}

// NewSessionManager constructs a service without an App instance.
// maxSessions caps concurrently running shells (0 = unlimited) and
// idleTimeout auto-recycles window-less sessions that stay silent that long
// (0 = disabled). Call Init(app) once the Wails application has been created.
func NewSessionManager(maxSessions int, idleTimeout time.Duration) *SessionManager {
	s := &SessionManager{
		sessions:    make(map[string]*TerminalSession),
		maxSessions: maxSessions,
		idleTimeout: idleTimeout,
	}
	if idleTimeout > 0 {
		go s.idleJanitor()
	}
	return s
}

// Init binds the Wails app to the service. Excluded from frontend bindings.
//
//wails:ignore
func (s *SessionManager) Init(app *application.App) {
	s.app = app
}

// idleJanitor periodically closes window-less sessions that exceeded the idle
// timeout, preventing MCP clients from leaking shells.
func (s *SessionManager) idleJanitor() {
	tick := s.idleTimeout / 4
	if tick < time.Second {
		tick = time.Second
	}
	t := time.NewTicker(tick)
	defer t.Stop()
	for range t.C {
		if s.closed {
			return
		}
		var victims []*TerminalSession
		s.mu.Lock()
		for id, sess := range s.sessions {
			sess.mu.Lock()
			windowless := sess.Window == ""
			running := sess.running
			sess.mu.Unlock()
			if windowless && running && sess.idleFor() >= s.idleTimeout {
				victims = append(victims, sess)
				delete(s.sessions, id)
			}
		}
		s.mu.Unlock()
		for _, sess := range victims {
			_ = sess.close()
			s.emitStatus(sess, StatusDisconnected)
			log.Printf("session %s recycled: idle for %v", sess.ID, s.idleTimeout)
		}
	}
}

// StartSession launches a new pwsh inside a ConPTY and registers it.
// windowName associates the session with a GUI window so it can be cleaned up
// when that window closes (may be empty for MCP-only sessions). workDir sets
// the shell's initial working directory ("" = the user's home directory; a
// path that no longer exists also falls back to home).
func (s *SessionManager) StartSession(windowName, workDir string) (*SessionInfo, error) {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return nil, fmt.Errorf("service is shutting down")
	}
	if s.maxSessions > 0 && len(s.sessions) >= s.maxSessions {
		s.mu.Unlock()
		return nil, fmt.Errorf("session limit reached (%d); stop an existing session first", s.maxSessions)
	}
	s.counter++
	n := s.counter
	id := newSessionID()
	for {
		if _, exists := s.sessions[id]; !exists {
			break
		}
		id = newSessionID() // collision (astronomically unlikely): retry
	}
	title := fmt.Sprintf("pwsh #%d", n)

	home, err := os.UserHomeDir()
	if err != nil {
		home = "." // fall back to the current working directory
	}
	dir := resolveWorkDir(workDir, home)
	cpty, err := conpty.Start(
		pwshCommandLine(),
		conpty.ConPtyDimensions(120, 30),
		conpty.ConPtyWorkDir(dir),
	)
	if err != nil {
		s.mu.Unlock()
		return nil, fmt.Errorf("failed to start pwsh in ConPTY: %w", err)
	}

	sess := &TerminalSession{
		ID:         id,
		Title:      title,
		Window:     windowName,
		Pwd:        dir,
		cpty:       cpty,
		cols:       120,
		rows:       30,
		createdAt:  time.Now(),
		lastActive: time.Now(),
		running:    true,
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

// promptHookScript redefines the interactive prompt so every prompt emits an
// invisible ConEmu-style OSC 9;9 cwd report (`ESC ] 9 ; 9 ; "path" ESC \`)
// right before the normal prompt text, then renders the default `PS C:\…> `
// prompt unchanged. The manager parses those reports out of the output stream
// to track each session's working directory for tab persistence; xterm.js
// ignores the unknown OSC sequence. The shell runs with -NoProfile, so the
// default prompt is what is being reproduced.
const promptHookScript = `
function global:prompt {
  $h = $host.UI
  $h.Write([char]27 + ']9;9;' + [char]34 + (Get-Location).Path + [char]34 + [char]27 + '\')
  'PS ' + $executionContext.SessionState.Path.CurrentLocation + ('>' * ($nestedPromptLevel + 1)) + ' '
}
`

// pwshCommandLine builds the pwsh invocation used for every session. The
// prompt hook is injected through -EncodedCommand so no quote escaping is
// needed; -NoExit keeps the shell interactive after the hook was installed.
func pwshCommandLine() string {
	return "pwsh.exe -NoLogo -NoProfile -NoExit -EncodedCommand " + encodeCommand(promptHookScript)
}

// encodeCommand base64-encodes a script as UTF-16LE, the format PowerShell's
// -EncodedCommand expects.
func encodeCommand(script string) string {
	u := utf16.Encode([]rune(script))
	b := make([]byte, 0, len(u)*2)
	for _, v := range u {
		b = append(b, byte(v), byte(v>>8))
	}
	return base64.StdEncoding.EncodeToString(b)
}

// resolveWorkDir returns the working directory a new shell should start in:
// the requested one when it resolves to an existing directory, otherwise the
// user's home directory (so a deleted folder never breaks session startup).
func resolveWorkDir(workDir, home string) string {
	if workDir == "" {
		return home
	}
	if abs, err := filepath.Abs(workDir); err == nil {
		workDir = abs
	}
	if fi, err := os.Stat(workDir); err == nil && fi.IsDir() {
		return workDir
	}
	return home
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

// ExecuteCommand writes command followed by Enter, then waits until the shell
// returns to its prompt (the prompt hook's OSC 9;9 report) or the timeout
// expires, and returns the output produced since the command was sent. When no
// prompt has ever been observed (hook missing), it falls back to a short quiet
// period. Excluded from frontend bindings.
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

	// Serialize per session: MCP clients may issue parallel tool calls, and two
	// concurrent commands on one shell would interleave keystrokes and read
	// back overlapping output.
	sess.cmdMu.Lock()
	defer sess.cmdMu.Unlock()
	if !sess.isRunning() {
		return "", false, fmt.Errorf("session %q is not running", id)
	}

	startSeq := sess.buf.lastSeq()
	promptMark := sess.promptMark()
	if err := sess.writeInput(command + "\r"); err != nil {
		return "", false, err
	}

	usePrompt := promptMark > 0
	deadline := time.Now().Add(timeout)
	var act time.Time
	finished := false
	for {
		time.Sleep(executeTick)
		if usePrompt {
			if sess.promptMark() > promptMark {
				finished = true
				break
			}
		} else {
			act = sess.buf.lastActivity()
			if !act.IsZero() && time.Since(act) >= executeQuiet {
				finished = true
				break
			}
		}
		if time.Now().After(deadline) {
			break
		}
	}
	timedOut := !finished
	data, _, _ := sess.buf.since(startSeq)
	return string(data), timedOut, nil
}

// readLoop forwards ConPTY output to the frontend and the session buffer.
func (s *SessionManager) readLoop(sess *TerminalSession) {
	buf := make([]byte, 4096)
	for {
		n, err := sess.cpty.Read(buf)
		if n > 0 {
			chunk := buf[:n]
			sess.buf.write(chunk)
			if pwd := sess.consumeCwdReport(chunk); pwd != "" {
				sess.notePrompt(pwd)
				s.emitPwd(sess, pwd)
			}
			sess.touch() // output counts as activity for idle recycling
			s.emitData(sess, string(chunk))
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

func (s *SessionManager) emitPwd(sess *TerminalSession, pwd string) {
	if s.app != nil {
		s.app.Event.Emit(EventPwd, termEvent{ID: sess.ID, Data: pwd})
	}
}
