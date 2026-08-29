package main

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"sync"
	"time"

	"github.com/UserExistsError/conpty"
)

// outputBufLimit caps how many recent ConPTY output bytes are kept in memory
// per session, so MCP clients can read output produced while they were away.
const outputBufLimit = 512 * 1024

// TerminalSession is one pwsh process running inside a Windows ConPTY.
type TerminalSession struct {
	ID     string
	Title  string
	Window string

	cpty *conpty.ConPty
	cols int
	rows int

	mu        sync.Mutex
	running   bool
	createdAt time.Time

	buf outputBuffer
}

// SessionInfo is the wire-safe view of a session, shared by the Wails
// bindings and the MCP tools.
type SessionInfo struct {
	ID        string `json:"id"`
	Title     string `json:"title"`
	Window    string `json:"window"`
	Running   bool   `json:"running"`
	CreatedAt string `json:"created_at"`
	Cols      int    `json:"cols"`
	Rows      int    `json:"rows"`
}

// Info snapshots the current session state.
func (s *TerminalSession) Info() SessionInfo {
	s.mu.Lock()
	defer s.mu.Unlock()
	return SessionInfo{
		ID:        s.ID,
		Title:     s.Title,
		Window:    s.Window,
		Running:   s.running,
		CreatedAt: s.createdAt.Format(time.RFC3339),
		Cols:      s.cols,
		Rows:      s.rows,
	}
}

// isRunning reports whether the shell is still alive.
func (s *TerminalSession) isRunning() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.running
}

func (s *TerminalSession) writeInput(data string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.running {
		return fmt.Errorf("session %s is not running", s.ID)
	}
	_, err := s.cpty.Write([]byte(data))
	return err
}

func (s *TerminalSession) resize(cols, rows int) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.running {
		return fmt.Errorf("session %s is not running", s.ID)
	}
	if cols <= 0 || rows <= 0 {
		return fmt.Errorf("invalid terminal size %dx%d", cols, rows)
	}
	s.cols, s.rows = cols, rows
	return s.cpty.Resize(cols, rows)
}

// close shuts the ConPTY (and its shell) down. Safe to call multiple times.
func (s *TerminalSession) close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.running {
		return nil
	}
	s.running = false
	return s.cpty.Close()
}

// outputBuffer keeps the most recent output bytes tagged with stable sequence
// offsets, so readers can resume from where they stopped even after the
// buffer has been trimmed from the front.
type outputBuffer struct {
	mu        sync.Mutex
	buf       []byte
	startSeq  int64     // sequence offset of buf[0]
	lastWrite time.Time // time of the most recent write
}

func (o *outputBuffer) write(p []byte) {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.buf = append(o.buf, p...)
	if len(o.buf) > outputBufLimit {
		drop := len(o.buf) - outputBufLimit
		o.buf = o.buf[drop:]
		o.startSeq += int64(drop)
	}
	o.lastWrite = time.Now()
}

// since returns output bytes from the given sequence offset onwards, plus the
// offset a reader should use next time. dropped is true when older bytes have
// been trimmed and the caller's offset could not be honored.
func (o *outputBuffer) since(offset int64) (data []byte, next int64, dropped bool) {
	o.mu.Lock()
	defer o.mu.Unlock()
	end := o.startSeq + int64(len(o.buf))
	if offset < o.startSeq {
		offset = o.startSeq
		dropped = o.startSeq > 0
	}
	if offset > end {
		offset = end
	}
	return o.buf[offset-o.startSeq:], end, dropped
}

// lastSeq returns the offset a fresh reader should start from to only see
// future output.
func (o *outputBuffer) lastSeq() int64 {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.startSeq + int64(len(o.buf))
}

func (o *outputBuffer) lastActivity() time.Time {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.lastWrite
}

// newSessionID returns a short random identifier usable as an MCP argument.
func newSessionID() string {
	b := make([]byte, 4)
	if _, err := rand.Read(b); err != nil {
		return fmt.Sprintf("t%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(b)
}
