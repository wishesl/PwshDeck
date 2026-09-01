package agent

import (
	"fmt"

	"github.com/deepnoodle-ai/dive/llm"
	"github.com/deepnoodle-ai/dive/providers/openaicompletions"
	"github.com/deepnoodle-ai/dive/providers/ollama"

	"pwshdeck/internal/config"
)

// buildLLM constructs a Dive LLM provider from the persisted settings.
// "openaicompletions" (the default) targets any OpenAI-compatible endpoint
// (OpenAI, DeepSeek, ...); "ollama" targets a local Ollama server. Both
// support tool calling, which the agent loop depends on.
func buildLLM(cfg config.LLMConfig) (llm.LLM, error) {
	switch cfg.Provider {
	case "ollama":
		var opts []ollama.Option
		if cfg.Endpoint != "" {
			opts = append(opts, ollama.WithEndpoint(cfg.Endpoint))
		}
		if cfg.Model != "" {
			opts = append(opts, ollama.WithModel(cfg.Model))
		}
		if cfg.APIKey != "" {
			opts = append(opts, ollama.WithAPIKey(cfg.APIKey))
		}
		return ollama.New(opts...), nil
	case "", "openaicompletions":
		var opts []openaicompletions.Option
		if cfg.Endpoint != "" {
			opts = append(opts, openaicompletions.WithEndpoint(cfg.Endpoint))
		}
		if cfg.Model != "" {
			opts = append(opts, openaicompletions.WithModel(cfg.Model))
		}
		if cfg.APIKey != "" {
			opts = append(opts, openaicompletions.WithAPIKey(cfg.APIKey))
		}
		return openaicompletions.New(opts...), nil
	default:
		return nil, fmt.Errorf("unknown LLM provider %q", cfg.Provider)
	}
}
