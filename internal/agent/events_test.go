package agent

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/deepnoodle-ai/dive"
	"github.com/deepnoodle-ai/dive/llm"
	divesess "github.com/deepnoodle-ai/dive/session"

	"pwshdeck/internal/config"
	"pwshdeck/internal/session"
)

// fakeLLM implements llm.LLM (non-streaming) for tests. The first Generate
// returns a tool call to the named tool; every subsequent call returns text.
type fakeLLM struct {
	name     string
	toolName string
	calls    atomic.Int32
}

func (f *fakeLLM) Name() string { return f.name }

func (f *fakeLLM) Generate(ctx context.Context, opts ...llm.Option) (*llm.Response, error) {
	n := f.calls.Add(1)
	if n == 1 {
		return &llm.Response{
			ID:         "resp_1",
			Model:      f.name,
			Role:       llm.Assistant,
			Type:       "message",
			StopReason: "tool_use",
			Content: []llm.Content{
				&llm.ToolUseContent{ID: "tool_1", Name: f.toolName, Input: []byte(`{}`)},
			},
		}, nil
	}
	return &llm.Response{
		ID:         "resp_2",
		Model:      f.name,
		Role:       llm.Assistant,
		Type:       "message",
		StopReason: "stop",
		Content:    []llm.Content{&llm.TextContent{Text: "done"}},
	}, nil
}

// TestToolEventsReachCallback proves the backend chain Dive -> eventCallback
// actually produces tool_call and tool_result events. The real agent + real
// tool set is used; only the LLM is faked.
func TestToolEventsReachCallback(t *testing.T) {
	svc := &AgentService{
		pwsh: session.NewSessionManager(0, 0),
		sess: divesess.New("test-agent"),
	}

	fake := &fakeLLM{name: "test-model", toolName: "list_sessions"}
	agent, err := dive.NewAgent(dive.AgentOptions{
		Name:         "test-agent",
		SystemPrompt: SystemPrompt,
		Model:        fake,
		Tools:        svc.tools(),
	})
	if err != nil {
		t.Fatalf("NewAgent: %v", err)
	}

	var gotToolCall, gotToolResult atomic.Int32
	cb := func(ctx context.Context, item *dive.ResponseItem) error {
		switch item.Type {
		case dive.ResponseItemTypeToolCall:
			gotToolCall.Add(1)
			if item.ToolCall == nil {
				t.Error("tool_call item has nil ToolCall")
			}
		case dive.ResponseItemTypeToolCallResult:
			gotToolResult.Add(1)
			if item.ToolCallResult == nil {
				t.Error("tool_call_result item has nil ToolCallResult")
			}
		}
		return nil
	}

	_, err = agent.CreateResponse(context.Background(),
		dive.WithInput("list sessions please"),
		dive.WithEventCallback(cb),
	)
	if err != nil {
		t.Fatalf("CreateResponse: %v", err)
	}
	if gotToolCall.Load() == 0 {
		t.Fatal("no ResponseItemTypeToolCall reached the callback — backend tool event chain broken")
	}
	if gotToolResult.Load() == 0 {
		t.Fatal("no ResponseItemTypeToolCallResult reached the callback — backend tool result chain broken")
	}
}

// mockDeepSeek simulates an OpenAI-compatible chat completions endpoint. The
// first request streams a tool call to list_sessions; the second streams a
// plain text answer. It also records the request bodies so the test can assert
// tools were actually sent to the model.
func mockDeepSeek(t *testing.T) (*httptest.Server, *[]string) {
	t.Helper()
	var bodies []string
	var n atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		bodies = append(bodies, string(b))
		count := n.Add(1)
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Connection", "keep-alive")
		if count == 1 {
			// Stream: assistant preamble -> tool call -> finish_reason tool_calls -> [DONE]
			fmt.Fprint(w, `data: {"id":"1","object":"chat.completion.chunk","model":"deepseek-chat","choices":[{"index":0,"delta":{"role":"assistant","content":""}}]}`+"\n\n")
			fmt.Fprint(w, `data: {"id":"1","object":"chat.completion.chunk","model":"deepseek-chat","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_abc","type":"function","function":{"name":"list_sessions","arguments":""}}]}}]}`+"\n\n")
			fmt.Fprint(w, `data: {"id":"1","object":"chat.completion.chunk","model":"deepseek-chat","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{}"}}]}}]}`+"\n\n")
			fmt.Fprint(w, `data: {"id":"1","object":"chat.completion.chunk","model":"deepseek-chat","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}`+"\n\n")
			fmt.Fprint(w, `data: {"id":"1","object":"chat.completion.chunk","model":"deepseek-chat","choices":[],"usage":{"prompt_tokens":20,"completion_tokens":5,"total_tokens":25}}`+"\n\n")
			fmt.Fprint(w, "data: [DONE]\n\n")
			return
		}
		// Second request: plain text answer.
		fmt.Fprint(w, `data: {"id":"2","object":"chat.completion.chunk","model":"deepseek-chat","choices":[{"index":0,"delta":{"role":"assistant","content":"There are no sessions."}}]}`+"\n\n")
		fmt.Fprint(w, `data: {"id":"2","object":"chat.completion.chunk","model":"deepseek-chat","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}`+"\n\n")
		fmt.Fprint(w, `data: {"id":"2","object":"chat.completion.chunk","model":"deepseek-chat","choices":[],"usage":{"prompt_tokens":30,"completion_tokens":6,"total_tokens":36}}`+"\n\n")
		fmt.Fprint(w, "data: [DONE]\n\n")
	}))
	return srv, &bodies
}

// TestRealProviderStreamsToolCall runs the full production path: the real
// openaicompletions provider (pointed at a mock server) + real agent + real
// tools. It proves that a streaming tool_call from the wire is parsed, emitted
// as a tool_call event, executed, and reported as a tool_result event.
func TestRealProviderStreamsToolCall(t *testing.T) {
	srv, bodies := mockDeepSeek(t)
	defer srv.Close()

	model, err := buildLLM(config.LLMConfig{
		Provider: "openaicompletions",
		Endpoint: srv.URL,
		Model:    "deepseek-chat",
	})
	if err != nil {
		t.Fatalf("buildLLM: %v", err)
	}

	svc := &AgentService{
		pwsh: session.NewSessionManager(0, 0),
		sess: divesess.New("test-agent"),
	}
	agent, err := dive.NewAgent(dive.AgentOptions{
		Name:         "test-agent",
		SystemPrompt: SystemPrompt,
		Model:        model,
		Tools:        svc.tools(),
	})
	if err != nil {
		t.Fatalf("NewAgent: %v", err)
	}

	var gotToolCall, gotToolResult atomic.Int32
	var seenToolName atomic.Value
	cb := func(ctx context.Context, item *dive.ResponseItem) error {
		switch item.Type {
		case dive.ResponseItemTypeToolCall:
			gotToolCall.Add(1)
			seenToolName.Store(item.ToolCall.Name)
		case dive.ResponseItemTypeToolCallResult:
			gotToolResult.Add(1)
		}
		return nil
	}

	resp, err := agent.CreateResponse(context.Background(),
		dive.WithInput("list the sessions"),
		dive.WithEventCallback(cb),
	)
	if err != nil {
		t.Fatalf("CreateResponse: %v", err)
	}
	if gotToolCall.Load() == 0 {
		t.Fatal("no tool_call event from real streaming provider")
	}
	if name, _ := seenToolName.Load().(string); name != "list_sessions" {
		t.Fatalf("tool name = %q, want list_sessions", name)
	}
	if gotToolResult.Load() == 0 {
		t.Fatal("no tool_result event from real streaming provider")
	}
	if resp == nil || !strings.Contains(resp.OutputText(), "no sessions") {
		t.Fatalf("final output missing tool result context: %+v", resp)
	}
	// Assert the model request actually carried the tools array.
	sent := false
	for _, b := range *bodies {
		if strings.Contains(b, `"tools"`) && strings.Contains(b, `list_sessions`) {
			sent = true
			break
		}
	}
	if !sent {
		t.Fatalf("request bodies did not include tools with list_sessions:\n%v", *bodies)
	}
}
