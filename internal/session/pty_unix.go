//go:build !windows

package session

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"

	pt "github.com/creack/pty"
)

// unixPTY is a POSIX pty pair: reads/writes go through the master side, the
// shell is a child process attached to the slave side.
type unixPTY struct {
	master *os.File
	cmd    *exec.Cmd
}

func (p *unixPTY) Read(b []byte) (int, error)  { return p.master.Read(b) }
func (p *unixPTY) Write(b []byte) (int, error) { return p.master.Write(b) }
func (p *unixPTY) Resize(cols, rows int) error {
	return pt.Setsize(p.master, &pt.Winsize{Cols: uint16(cols), Rows: uint16(rows)})
}

func (p *unixPTY) Close() error {
	// Closing the master makes the shell see EOF on its controlling tty;
	// killing the process guarantees cleanup even when the shell ignores it.
	if p.cmd != nil && p.cmd.Process != nil {
		_ = p.cmd.Process.Kill()
	}
	return p.master.Close()
}

func (p *unixPTY) Wait(ctx context.Context) (int, error) {
	err := p.cmd.Wait()
	if err == nil {
		return 0, nil
	}
	if ee, ok := err.(*exec.ExitError); ok {
		return ee.ExitCode(), err
	}
	return -1, err
}

// osc99BashPromptCommand makes every bash prompt emit the same ConEmu-style
// OSC 9;9 cwd report the pwsh hook produces, so consumeCwdReport and the
// prompt-based command-completion signal work unchanged. The `%s` only appears
// in printf's format string; `$PWD` is passed as an argument, so a literal `%`
// inside a directory name is not interpreted as a format directive.
const osc99BashPromptCommand = `printf '\033]9;9;"%s"\007' "$PWD"`

// startShellPTY launches an interactive bash login shell inside a POSIX pty.
// $SHELL is honored when it is bash (possibly at a non-standard path, e.g.
// Homebrew's /opt/homebrew/bin/bash); otherwise /bin/bash is used, since the
// prompt hook above is bash-specific — zsh/fish would need their own hooks.
// A login shell is used so the user's profile PATH (Homebrew, Nix, ...) is
// available inside the terminal.
func startShellPTY(workDir string, cols, rows int) (*startedPTY, error) {
	shell := defaultShell()
	cmd := exec.Command(shell, "-l")
	cmd.Dir = workDir
	cmd.Env = append(os.Environ(),
		"PROMPT_COMMAND="+osc99BashPromptCommand,
		"TERM=xterm-256color",
	)
	master, err := pt.StartWithSize(cmd, &pt.Winsize{Cols: uint16(cols), Rows: uint16(rows)})
	if err != nil {
		return nil, fmt.Errorf("failed to start %s in pty: %w", shell, err)
	}
	return &startedPTY{p: &unixPTY{master: master, cmd: cmd}, name: filepath.Base(shell)}, nil
}

// defaultShell picks the bash to run: the user's $SHELL when it is bash,
// otherwise the standard /bin/bash.
func defaultShell() string {
	if s := os.Getenv("SHELL"); s != "" && filepath.Base(s) == "bash" {
		return s
	}
	return "/bin/bash"
}
