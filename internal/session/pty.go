package session

import (
	"context"
	"io"
)

// pty abstracts one pseudo-terminal pair so the session logic stays platform
// agnostic: Windows runs shells inside a ConPTY, Linux/macOS inside a POSIX
// pty. The interface mirrors exactly what the session loop needs — read raw
// output, write input, resize, close, and wait for the shell to exit.
type pty interface {
	io.ReadWriteCloser
	Resize(cols, rows int) error
	Wait(ctx context.Context) (int, error)
}

// startedPTY is the result of launching a shell inside a fresh pty: the pty
// itself plus the shell's display name (e.g. "pwsh" on Windows, "bash" on
// Unix), used for session titles.
type startedPTY struct {
	p    pty
	name string
}

// startShellPTY launches an interactive shell inside a fresh pseudo-terminal
// in the given working directory, sized cols x rows. Implemented per platform
// (pty_windows.go / pty_unix.go) because the shell, its startup flags and the
// pty mechanism all differ.
