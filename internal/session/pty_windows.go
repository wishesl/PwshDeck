//go:build windows

package session

import (
	"context"
	"encoding/base64"
	"fmt"
	"unicode/utf16"

	"github.com/UserExistsError/conpty"
)

// conptyPTY adapts *conpty.ConPty to the common pty interface.
type conptyPTY struct {
	c *conpty.ConPty
}

func (p *conptyPTY) Read(b []byte) (int, error)  { return p.c.Read(b) }
func (p *conptyPTY) Write(b []byte) (int, error) { return p.c.Write(b) }
func (p *conptyPTY) Close() error                { return p.c.Close() }
func (p *conptyPTY) Resize(cols, rows int) error { return p.c.Resize(cols, rows) }
func (p *conptyPTY) Wait(ctx context.Context) (int, error) {
	code, err := p.c.Wait(ctx)
	return int(code), err
}

// startShellPTY launches pwsh inside a Windows ConPTY.
func startShellPTY(workDir string, cols, rows int) (*startedPTY, error) {
	cpty, err := conpty.Start(
		pwshCommandLine(),
		conpty.ConPtyDimensions(cols, rows),
		conpty.ConPtyWorkDir(workDir),
	)
	if err != nil {
		return nil, fmt.Errorf("failed to start pwsh in ConPTY: %w", err)
	}
	return &startedPTY{p: &conptyPTY{c: cpty}, name: "pwsh"}, nil
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
