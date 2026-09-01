package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"sync"

	"github.com/deepnoodle-ai/dive"
	"github.com/deepnoodle-ai/dive/llm"
	divesess "github.com/deepnoodle-ai/dive/session"
	"github.com/wailsapp/wails/v3/pkg/application"

	"pwshdeck/internal/config"
	"pwshdeck/internal/session"
)

// AgentService runs the built-in AI assistant. It owns one Dive agent bound
// to the SessionManager (so the agent's tools operate real terminal sessions)
// and streams progress to every window through the agent_event Wails event.
// Only one turn runs at a time; write commands pause for user approval.
type AgentService struct {
	app  *application.App
	pwsh *session.SessionManager
	cfg  config.LLMConfig

	mu       sync.Mutex
	agent    *dive.Agent           // nil until configured
	sess     *divesess.Session     // conversation memory
	busy     bool                  // a turn is in flight
	pending  *dive.SuspensionState // awaiting approval
	sysShown bool                  // system prompt already streamed for this agent
	cancel   context.CancelFunc
}

// NewAgentService constructs the service. Configure with SetLLMConfig before
// sending messages; Init wires the Wails app and session manager.
func NewAgentService(cfg config.LLMConfig) *AgentService {
	return &AgentService{
		cfg:  cfg,
		sess: divesess.New("pwshdeck-agent"),
	}
}

// Init binds the Wails app and session manager. Excluded from bindings.
//
//wails:ignore
func (a *AgentService) Init(app *application.App, pwsh *session.SessionManager) {
	a.app = app
	a.pwsh = pwsh
	if a.cfg.Model != "" {
		a.rebuildLocked()
	}
}

// SetLLMConfig reconfigures the model provider and rebuilds the agent, then
// persists the settings. Changing the model keeps the conversation memory.
func (a *AgentService) SetLLMConfig(cfg config.LLMConfig) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.busy {
		return fmt.Errorf("agent is busy; wait for it to finish or cancel first")
	}
	if cfg.Model == "" {
		return fmt.Errorf("model name is required")
	}
	a.cfg = cfg
	if err := a.rebuildLocked(); err != nil {
		return err
	}
	c := config.Load()
	c.LLM = cfg
	if err := c.Save(); err != nil {
		log.Printf("agent: failed to persist LLM config: %v", err)
	}
	agentLogf("SetLLMConfig: provider=%s model=%s endpoint=%q api_key_set=%v tools=6", cfg.Provider, cfg.Model, cfg.Endpoint, cfg.APIKey != "")
	a.emit(AgentEvent{Type: EventConfig})
	return nil
}

// rebuildLocked constructs the Dive provider and agent. Callers hold a.mu.
func (a *AgentService) rebuildLocked() error {
	model, err := buildLLM(a.cfg)
	if err != nil {
		agentLogf("rebuild failed: %v", err)
		return err
	}
	ag, err := dive.NewAgent(dive.AgentOptions{
		Name:               "PwshDeck Agent",
		Description:        "Terminal environment troubleshooting assistant",
		SystemPrompt:       SystemPrompt,
		Model:              model,
		Tools:              a.tools(),
		Session:            a.sess,
		ToolIterationLimit: 25,
	})
	if err != nil {
		agentLogf("NewAgent failed: %v", err)
		return err
	}
	a.agent = ag
	a.sysShown = false
	agentLogf("agent rebuilt: provider=%s model=%s endpoint=%q", a.cfg.Provider, a.cfg.Model, a.cfg.Endpoint)
	return nil
}

// GetLLMConfig returns the current model configuration.
func (a *AgentService) GetLLMConfig() config.LLMConfig {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.cfg
}

// IsConfigured reports whether a model has been configured, plus a human
// explanation of the state.
func (a *AgentService) IsConfigured() (bool, string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.agent == nil {
		return false, "未配置模型 — 请在设置中填写 LLM 配置"
	}
	return true, fmt.Sprintf("%s (%s)", a.cfg.Model, a.cfg.Provider)
}

// SendMessage feeds a user message to the agent and returns immediately; the
// turn runs in a goroutine and progress streams over agent_event. An error is
// returned only when the message cannot start (busy, awaiting approval, or
// not configured).
func (a *AgentService) SendMessage(input string) error {
	a.mu.Lock()
	if a.agent == nil {
		a.mu.Unlock()
		return fmt.Errorf("AI 助手未配置模型")
	}
	if a.busy {
		a.mu.Unlock()
		return fmt.Errorf("AI 助手正在处理上一条消息，请稍候")
	}
	if a.pending != nil {
		a.mu.Unlock()
		return fmt.Errorf("AI 助手正在等待审批，请先处理待审批的操作")
	}
	a.busy = true
	ctx, cancel := context.WithCancel(context.Background())
	a.cancel = cancel
	agent := a.agent
	a.mu.Unlock()

	a.emit(AgentEvent{Type: EventStatus, State: "running"})
	go func() {
		defer a.finishRun()
		a.emitSystemPromptOnce()
		agentLogf("SendMessage: input=%q", input)
		resp, err := agent.CreateResponse(ctx,
			dive.WithInput(input),
			dive.WithEventCallback(a.eventCallback),
		)
		a.handleResult(resp, err)
	}()
	return nil
}

// emitSystemPromptOnce streams the system prompt as a collapsible block the
// first time a turn runs for the current agent build.
func (a *AgentService) emitSystemPromptOnce() {
	a.mu.Lock()
	if a.sysShown {
		a.mu.Unlock()
		return
	}
	a.sysShown = true
	a.mu.Unlock()
	a.emit(AgentEvent{Type: EventSystem, Text: SystemPrompt})
}

// Approve resolves a pending approval request. approved=true runs the pending
// command (for execute_command) or completes the action; approved=false
// reports the user's rejection back to the agent. The turn resumes in a
// goroutine.
func (a *AgentService) Approve(toolCallID string, approved bool) error {
	a.mu.Lock()
	if a.pending == nil {
		a.mu.Unlock()
		return fmt.Errorf("没有待审批的操作")
	}
	state := a.pending
	if len(state.PendingToolCalls) == 0 || state.PendingToolCalls[0].ID != toolCallID {
		a.mu.Unlock()
		return fmt.Errorf("未知的审批请求 %q", toolCallID)
	}
	if a.agent == nil {
		a.mu.Unlock()
		return fmt.Errorf("AI 助手未配置模型")
	}
	a.pending = nil
	a.busy = true
	ctx, cancel := context.WithCancel(context.Background())
	a.cancel = cancel
	agent := a.agent
	a.mu.Unlock()

	a.emit(AgentEvent{Type: EventStatus, State: "running"})
	go func() {
		defer a.finishRun()
		result := a.resolveApproval(ctx, state, approved)
		resp, err := agent.CreateResponse(ctx,
			dive.WithToolResults(map[string]*dive.ToolResult{toolCallID: result}),
			dive.WithEventCallback(a.eventCallback),
		)
		a.handleResult(resp, err)
	}()
	return nil
}

// Cancel aborts the in-flight turn, if any.
func (a *AgentService) Cancel() error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.cancel != nil {
		a.cancel()
		a.cancel = nil
	}
	return nil
}

// LogFrontend lets the frontend write a diagnostic line into the agent log
// (e.g. component mount/unmount or state transitions) so UI-only bugs can be
// correlated with the backend event stream in a single file.
func (a *AgentService) LogFrontend(msg string) {
	agentLogf("frontend: %s", msg)
}

// finishRun clears the busy flag and reports the idle state. If an approval
// is still pending (the turn ended in a suspension), stay in the "pending"
// state instead of flipping back to idle.
func (a *AgentService) finishRun() {
	a.mu.Lock()
	a.busy = false
	a.cancel = nil
	pending := a.pending != nil
	a.mu.Unlock()
	if pending {
		a.emit(AgentEvent{Type: EventStatus, State: "pending"})
	} else {
		a.emit(AgentEvent{Type: EventStatus, State: "idle"})
	}
}

// handleResult routes a completed turn: a suspension becomes a pending
// approval request; anything else emits the final message or error.
func (a *AgentService) handleResult(resp *dive.Response, err error) {
	if err != nil {
		if a.isCanceled() {
			agentLogf("handleResult: canceled")
			a.emit(AgentEvent{Type: EventDone, Text: "(已取消)"})
		} else {
			agentLogf("handleResult: error: %v", err)
			a.emit(AgentEvent{Type: EventError, Text: err.Error()})
		}
		return
	}
	if resp != nil && resp.Suspension != nil && len(resp.Suspension.PendingToolCalls) > 0 {
		call := resp.Suspension.PendingToolCalls[0]
		a.mu.Lock()
		a.pending = resp.Suspension
		a.mu.Unlock()
		var input string
		if b, e := json.Marshal(call.Input); e == nil {
			input = string(b)
		}
		cmd, _ := call.Metadata["command"].(string)
		sid, _ := call.Metadata["session_id"].(string)
		agentLogf("handleResult: SUSPENDED tool=%s id=%s command=%q session=%s", call.Name, call.ID, cmd, sid)
		a.emit(AgentEvent{
			Type:      EventPending,
			CallID:    call.ID,
			Tool:      call.Name,
			Input:     input,
			Prompt:    call.Prompt,
			Command:   cmd,
			SessionID: sid,
		})
		a.emit(AgentEvent{Type: EventStatus, State: "pending"})
		return
	}
	text := ""
	if resp != nil {
		text = resp.OutputText()
	}
	agentLogf("handleResult: DONE text_len=%d", len(text))
	a.emit(AgentEvent{Type: EventDone, Text: text})
}

func (a *AgentService) isCanceled() bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.cancel != nil
}

// eventCallback streams model deltas and tool activity to the frontend.
func (a *AgentService) eventCallback(ctx context.Context, item *dive.ResponseItem) error {
	if item == nil {
		return nil
	}
	switch item.Type {
	case dive.ResponseItemTypeModelEvent:
		if item.Event == nil || item.Event.Delta == nil {
			return nil
		}
		switch item.Event.Delta.Type {
		case llm.EventDeltaTypeThinking:
			// Reasoning content (e.g. DeepSeek reasoner / thinking models)
			// streams as a separate collapsible "deep thinking" block.
			if item.Event.Delta.Thinking != "" {
				agentLogf("eventCallback: thinking_delta len=%d", len(item.Event.Delta.Thinking))
				a.emit(AgentEvent{Type: EventThinking, Text: item.Event.Delta.Thinking})
			}
		default:
			if item.Event.Delta.Text != "" {
				agentLogf("eventCallback: text_delta len=%d", len(item.Event.Delta.Text))
				a.emit(AgentEvent{Type: EventDelta, Text: item.Event.Delta.Text})
			}
		}
	case dive.ResponseItemTypeToolCall:
		if item.ToolCall != nil {
			var input string
			if b, e := json.Marshal(item.ToolCall.Input); e == nil {
				input = string(b)
			}
			agentLogf("eventCallback: TOOL_CALL id=%s name=%s input=%s", item.ToolCall.ID, item.ToolCall.Name, input)
			a.emit(AgentEvent{Type: EventToolCall, CallID: item.ToolCall.ID, Tool: item.ToolCall.Name, Input: input})
		}
	case dive.ResponseItemTypeToolCallResult:
		if item.ToolCallResult != nil {
			output := ""
			if r := item.ToolCallResult.Result; r != nil {
				output = toolResultText(r)
			}
			agentLogf("eventCallback: TOOL_RESULT id=%s name=%s output_len=%d output_head=%q", item.ToolCallResult.ID, item.ToolCallResult.Name, len(output), truncate(output, 200))
			a.emit(AgentEvent{Type: EventToolResult, CallID: item.ToolCallResult.ID, Tool: item.ToolCallResult.Name, Output: output})
		}
	}
	return nil
}

// truncate shortens a string for log lines, appending "..." when cut.
func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}

func (a *AgentService) emit(ev AgentEvent) {
	agentLogf("EMIT type=%s state=%q text_len=%d call_id=%s tool=%s input_len=%d output_len=%d command=%q session=%s",
		ev.Type, ev.State, len(ev.Text), ev.CallID, ev.Tool, len(ev.Input), len(ev.Output), ev.Command, ev.SessionID)
	if a.app != nil {
		a.app.Event.Emit(EventAgent, ev)
	}
}
