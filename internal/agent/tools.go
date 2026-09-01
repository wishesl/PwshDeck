package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/deepnoodle-ai/dive"

	"pwshdeck/internal/session"
)

// maxToolOutput bounds the output returned to the model, mirroring the MCP
// tools' limit (the tail holds the fresh output).
const maxToolOutput = 96 * 1024

// toolResultText renders a ToolResult as plain text for the event stream.
func toolResultText(r *dive.ToolResult) string {
	if r == nil {
		return ""
	}
	if r.Display != "" {
		return r.Display
	}
	var b strings.Builder
	for _, c := range r.Content {
		if c != nil && c.Text != "" {
			b.WriteString(c.Text)
		}
	}
	return b.String()
}

// tools returns the agent's tool set. Tools mirror the MCP tool names so the
// assistant and external clients behave identically; descriptions are tuned
// for the agent's own model.
func (a *AgentService) tools() []dive.Tool {
	return []dive.Tool{
		a.toolListSessions(),
		a.toolCreateSession(),
		a.toolExecuteCommand(),
		a.toolReadOutput(),
		a.toolSendInput(),
		a.toolStopSession(),
	}
}

// autoApproved reports whether full-permission mode is on (write operations
// run without waiting for user approval). Safe to call from tool handlers.
func (a *AgentService) autoApproved() bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.autoApprove
}

// pickSession resolves a session id, preferring the explicit one; an empty id
// picks the first running session so the agent does not need to know ids when
// a shell already exists.
func (a *AgentService) pickSession(id string) (*session.SessionInfo, error) {
	if id != "" {
		for _, s := range a.pwsh.ListSessions() {
			if s.ID == id {
				return &s, nil
			}
		}
		return nil, fmt.Errorf("session %q not found", id)
	}
	for _, s := range a.pwsh.ListSessions() {
		if s.Running {
			return &s, nil
		}
	}
	return nil, fmt.Errorf("no running session — call create_session first")
}

// ---- list_sessions ------------------------------------------------------

type listSessionsIn struct{}

func (a *AgentService) toolListSessions() dive.Tool {
	return dive.FuncTool[listSessionsIn](
		"list_sessions",
		"List all terminal sessions with id, title, running state and working directory.",
		func(ctx context.Context, in listSessionsIn) (*dive.ToolResult, error) {
			list := a.pwsh.ListSessions()
			if list == nil {
				list = []session.SessionInfo{}
			}
			b, err := json.MarshalIndent(list, "", "  ")
			if err != nil {
				return dive.NewToolResultError(err.Error()), nil
			}
			return dive.NewToolResultText(string(b)), nil
		})
}

// ---- create_session -----------------------------------------------------

type createSessionIn struct {
	WorkDir string `json:"work_dir,omitempty" description:"Initial working directory; empty = user home."`
}

func (a *AgentService) toolCreateSession() dive.Tool {
	return dive.FuncTool[createSessionIn](
		"create_session",
		"Start a new interactive shell session (pwsh on Windows, bash on macOS/Linux).",
		func(ctx context.Context, in createSessionIn) (*dive.ToolResult, error) {
			info, err := a.pwsh.StartSession("", in.WorkDir)
			if err != nil {
				return dive.NewToolResultError(err.Error()), nil
			}
			return dive.NewToolResultText(fmt.Sprintf("created session %s (%s)", info.ID, info.Title)), nil
		})
}

// ---- execute_command ----------------------------------------------------

type executeIn struct {
	SessionID string `json:"session_id,omitempty" description:"Session id from list_sessions; empty = first running session."`
	Command   string `json:"command" description:"The shell command to run. Read-only commands run automatically; modifying commands require your approval."`
}

func (a *AgentService) toolExecuteCommand() dive.Tool {
	return dive.FuncTool[executeIn](
		"execute_command",
		"Run a command in an interactive terminal session and wait for the shell to return to its prompt. Read-only commands (Get-*, ls, git status, version checks, ...) run automatically; commands that modify the system (install, remove, write files, kill processes, ...) pause for user approval unless the user enabled full-permission mode. Returns the cleaned output.",
		func(ctx context.Context, in executeIn) (*dive.ToolResult, error) {
			sess, err := a.pickSession(in.SessionID)
			if err != nil {
				return dive.NewToolResultError(err.Error()), nil
			}
			if !isReadOnlyCommand(in.Command) && !a.autoApproved() {
				return dive.NewSuspendResultWithReason(
					fmt.Sprintf("需要审批：执行命令 %q", in.Command),
					dive.SuspendReasonAuth,
					map[string]any{"command": in.Command, "session_id": sess.ID},
				), nil
			}
			return a.runCommand(sess.ID, in.Command), nil
		})
}

// ---- read_output --------------------------------------------------------

type readOutputIn struct {
	SessionID   string `json:"session_id,omitempty" description:"Session id; empty = first running session."`
	SinceOffset int64  `json:"since_offset,omitempty" description:"Byte offset returned by a previous read_output (0 = recent history)."`
}

func (a *AgentService) toolReadOutput() dive.Tool {
	return dive.FuncTool[readOutputIn](
		"read_output",
		"Read output a session produced since a byte offset (0 = recent history). Use for incremental reads after starting long-running processes or driving nested REPLs.",
		func(ctx context.Context, in readOutputIn) (*dive.ToolResult, error) {
			sess, err := a.pickSession(in.SessionID)
			if err != nil {
				return dive.NewToolResultError(err.Error()), nil
			}
			data, next, dropped, err := a.pwsh.ReadOutput(sess.ID, in.SinceOffset)
			if err != nil {
				return dive.NewToolResultError(err.Error()), nil
			}
			text := cleanOutput(string(data))
			if dropped {
				text = "[buffer overflow: some output was dropped]\n" + text
			}
			return dive.NewToolResultText(
				fmt.Sprintf("%s\n[next_offset: %d]", tailOutput(text, maxToolOutput), next)), nil
		})
}

// ---- send_input ---------------------------------------------------------

type sendInputIn struct {
	SessionID string `json:"session_id,omitempty" description:"Session id; empty = first running session."`
	Input     string `json:"input" description:"Raw keystrokes to send. Use \\r for Enter, \\u0003 for Ctrl+C. Output is not returned — use read_output."`
}

func (a *AgentService) toolSendInput() dive.Tool {
	return dive.FuncTool[sendInputIn](
		"send_input",
		"Write raw keystrokes to a session's stdin (for nested REPLs like python/node/erl where execute_command would time out). Pauses for user approval unless the user enabled full-permission mode.",
		func(ctx context.Context, in sendInputIn) (*dive.ToolResult, error) {
			sess, err := a.pickSession(in.SessionID)
			if err != nil {
				return dive.NewToolResultError(err.Error()), nil
			}
			if !a.autoApproved() {
				return dive.NewSuspendResultWithReason(
					fmt.Sprintf("需要审批：向会话 %s 发送输入 %q", sess.ID, in.Input),
					dive.SuspendReasonAuth,
					map[string]any{"session_id": sess.ID},
				), nil
			}
			return a.runSendInput(sess.ID, in.Input), nil
		})
}

// ---- stop_session -------------------------------------------------------

type stopSessionIn struct {
	SessionID string `json:"session_id" description:"Session id from list_sessions."`
}

func (a *AgentService) toolStopSession() dive.Tool {
	return dive.FuncTool[stopSessionIn](
		"stop_session",
		"Terminate a terminal session and its shell. Pauses for user approval unless the user enabled full-permission mode.",
		func(ctx context.Context, in stopSessionIn) (*dive.ToolResult, error) {
			if _, err := a.pickSession(in.SessionID); err != nil {
				return dive.NewToolResultError(err.Error()), nil
			}
			if !a.autoApproved() {
				return dive.NewSuspendResultWithReason(
					fmt.Sprintf("需要审批：终止会话 %s", in.SessionID),
					dive.SuspendReasonAuth,
					map[string]any{"session_id": in.SessionID},
				), nil
			}
			return a.runStopSession(in.SessionID), nil
		})
}

// ---- write-action execution ---------------------------------------------

// runCommand executes a shell command in a session and returns the cleaned
// output as a tool result. Shared by the direct path (read-only command or
// full-permission mode) and the approval-resume path.
func (a *AgentService) runCommand(sessionID, command string) *dive.ToolResult {
	output, timedOut, err := a.pwsh.ExecuteCommand(sessionID, command, 0)
	if err != nil {
		return dive.NewToolResultError(err.Error())
	}
	cleaned := cleanOutput(output)
	cleaned = stripCommandEcho(cleaned, command)
	if timedOut {
		cleaned += "\n[command timed out]"
	}
	return dive.NewToolResultText(tailOutput(cleaned, maxToolOutput))
}

// runSendInput writes raw keystrokes to a session's stdin. Shared by the
// direct path (full-permission mode) and the approval-resume path.
func (a *AgentService) runSendInput(sessionID, rawInput string) *dive.ToolResult {
	if err := a.pwsh.WriteInput(sessionID, decodeInput(rawInput)); err != nil {
		return dive.NewToolResultError(err.Error())
	}
	return dive.NewToolResultText("input sent — use read_output to see the result")
}

// runStopSession terminates a session and its shell. Shared by the direct
// path (full-permission mode) and the approval-resume path.
func (a *AgentService) runStopSession(sessionID string) *dive.ToolResult {
	if err := a.pwsh.StopSession(sessionID); err != nil {
		return dive.NewToolResultError(err.Error())
	}
	return dive.NewToolResultText(fmt.Sprintf("session %s stopped", sessionID))
}

// ---- approval resolution ------------------------------------------------

// resolveApproval builds the tool result for a resumed approval: for
// execute_command the pending command actually runs now (approved) or is
// reported as rejected; other tools complete their action or report the
// rejection.
func (a *AgentService) resolveApproval(ctx context.Context, state *dive.SuspensionState, approved bool) *dive.ToolResult {
	call := state.PendingToolCalls[0]

	switch call.Name {
	case "execute_command":
		var in executeIn
		if err := json.Unmarshal(call.Input, &in); err != nil {
			return dive.NewToolResultError("cannot decode pending command: " + err.Error())
		}
		if !approved {
			return dive.NewToolResultText(fmt.Sprintf("用户拒绝了执行命令：%q", in.Command))
		}
		return a.runCommand(in.SessionID, in.Command)

	case "send_input":
		var in sendInputIn
		if err := json.Unmarshal(call.Input, &in); err != nil {
			return dive.NewToolResultError("cannot decode pending input: " + err.Error())
		}
		if !approved {
			return dive.NewToolResultText("用户拒绝了发送输入")
		}
		return a.runSendInput(in.SessionID, in.Input)

	case "stop_session":
		var in stopSessionIn
		if err := json.Unmarshal(call.Input, &in); err != nil {
			return dive.NewToolResultError("cannot decode pending stop: " + err.Error())
		}
		if !approved {
			return dive.NewToolResultText(fmt.Sprintf("用户拒绝了终止会话 %s", in.SessionID))
		}
		return a.runStopSession(in.SessionID)
	}
	return dive.NewToolResultText(fmt.Sprintf("unknown tool %q — operation cancelled", call.Name))
}

// ---- read-only / write classification -----------------------------------

// readOnlyPrefixes are command prefixes that only inspect state. This is a
// heuristic: unknown commands default to requiring approval (a false "read"
// is destructive, a false "write" is merely one extra click).
var readOnlyPrefixes = []string{
	"Get-", "Show-", "Measure-", "Test-", "Select-", "Compare-",
	"ls", "dir", "cat", "type", "echo", "pwd", "whoami", "hostname",
	"git status", "git log", "git diff", "git branch", "git remote",
	"go version", "go env", "go list", "node --version", "npm --version",
	"where ", "which ", "findstr", "Get-Content", "Get-ChildItem",
	"Get-Command", "Get-Process", "Get-Service", "Get-Item", "Get-Location",
	"Get-Date", "Get-Help", "netstat", "ipconfig", "systeminfo", "tasklist",
	"Get-CimInstance", "Get-WmiObject", "Get-NetTCPConnection", "Get-NetUDPEndpoint",
	"Get-ComputerInfo", "Get-ComputerRestorePoint", "Get-Volume", "Get-PSDrive",
	"Get-ItemProperty", "Get-ItemPropertyValue", "Get-ExecutionPolicy",
	"curl ", "wget ",
}

// writeMarkers force approval when present anywhere in the command.
var writeMarkers = []string{
	"Remove-", "Set-", "New-", "Add-", "Clear-", "Move-", "Copy-", "Rename-",
	"Install-", "Update-", "Uninstall-", "Restart-", "Stop-", "Start-",
	"Set-Content", "Add-Content", "Out-File", "Set-Location", "Push-Location",
	"Remove-Item", "Remove-ChildItem", "Remove-ItemProperty", "Remove-PSDrive",
	"Set-ItemProperty", "Set-ExecutionPolicy", "Enable-", "Disable-",
	"| Out-File", "> ", ">> ", "2> ", "2>> ", "&> ",
	"install", "uninstall", "update", "upgrade", "remove", "delete",
	"rm ", "rm -", "del ", "rd ", "mkdir", "md ", "move", "copy",
	"npm install", "npm uninstall", "pnpm install", "yarn add", "yarn remove",
	"pip install", "pip uninstall", "pip3 install", "go install", "go mod", "go get",
	"cargo install", "brew install", "apt install", "apt-get install", "apt remove",
	"choco install", "winget install", "scoop install",
	"git add", "git commit", "git push", "git pull", "git merge", "git rebase",
	"git reset", "git checkout", "git clean", "git rm", "git stash", "git tag",
	"kill", "taskkill", "Stop-Process", "Stop-Service", "Start-Service",
	"Restart-Service", "sudo", "chmod", "chown",
}

// isReadOnlyCommand classifies a shell command as read-only (auto-run) or
// modifying (requires approval). Matching is case-insensitive and prefix- or
// marker-based; unknown commands are treated as modifying.
func isReadOnlyCommand(cmd string) bool {
	c := strings.ToLower(strings.TrimSpace(cmd))
	if c == "" {
		return false
	}
	for _, m := range writeMarkers {
		if strings.Contains(c, strings.ToLower(m)) {
			return false
		}
	}
	for _, p := range readOnlyPrefixes {
		if strings.HasPrefix(c, strings.ToLower(p)) {
			return true
		}
	}
	return false // unknown → conservative: ask the user
}
