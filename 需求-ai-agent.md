# 需求文档：内置 AI Agent（终端环境排查助手）

> 状态：MVP 设计稿（2026-08）
> 关联：`需求.md`（最初 pwsh 终端）、MCP 远程控制（已完成）

## 1. 是什么 (What)

在 PwshDeck 内内置一个 **AI Agent（聊天面板）**：用户用自然语言描述环境问题
（如"装不上依赖""PATH 不对""端口被占"），Agent 通过**操作真实终端会话**
（读输出、执行命令）自主排查并修复，写操作需用户**逐条审批**。

本质：把已有 MCP 的"远程遥控"升级为"自带副驾"，Agent 是应用内第一个
MCP 客户端，消费同一套会话管理层。

## 2. 为什么 (Why)

- 环境问题（依赖、PATH、端口、SDK 版本）是开发者最高频的排查场景，
  交互式终端里人肉来回敲命令费时；Agent 可直接观察真实 shell 输出。
- 现有 `internal/session` 已抽象好"执行命令等提示符返回"（promptSeq 信号）
  和"增量读输出"（read_output），Agent 复用成本极低，且 MCP 与 Agent
  行为天然一致。
- 用户已确认三项决策（ask_user_question）：
  1. LLM 接入：**OpenAI 兼容协议**（DeepSeek / Ollama / 任意兼容端点）
  2. 安全策略：**只读自动 + 写操作审批**
  3. 实现路径：**Dive**（github.com/deepnoodle-ai/dive v1.26.0，Apache-2.0）

## 3. 怎么做 (How) — 架构

```
┌─ frontend（dockview 新增 "AI 助手" 面板，可拖拽）
│   流式 token / 工具调用卡片 / 审批卡片 / 输入框
│   Events.On('agent_event')  ← Wails 事件
├─ internal/agent（新增，Go 后端，Wails Service）
│   AgentService：SendMessage / Approve / Cancel / 状态
│   ├─ Dive Agent 循环（NewAgent + CreateResponse）
│   ├─ provider 工厂：openaicompletions / ollama（按 config）
│   └─ 工具层：复用 SessionManager（FuncTool 包装）
├─ internal/session（现有，Agent 与 MCP 共用）
└─ config：新增 llm 配置段（provider/endpoint/model/api_key）
```

### 核心实现路径（必须打通的关键链路）

1. **Agent 循环**：`SendMessage(input)` 起 goroutine → `dive.NewAgent` +
   `CreateResponse(ctx, WithInput(input), WithSession(sess), WithEventCallback(cb))`
   → 流式事件经 `app.Event.Emit("agent_event", ...)` 推前端。
2. **工具层**：`dive.FuncTool[T]` 包装 SessionManager：
   `list_sessions` / `create_session` / `execute_command` / `read_output` /
   `send_input` / `stop_session`（对齐 MCP 工具名，Agent 专属描述）。
3. **审批（技术难点，已验证 Dive 原生支持）**：
   - `execute_command` 工具内做**只读/写启发式判定**（命令前缀/关键词）。
   - 只读（`Get-*`、`ls`、`git status`、`go version`…）→ 直接执行，结果回给 LLM。
   - 写（`Remove-*`、`Set-*`、`Install-*`、`> `、`| Out-File`、`npm install`…）
     → 返回 `dive.NewSuspendResultWithReason(prompt, SuspendReasonAuth, metadata)`
     → Agent 挂起 → `Response.Suspension.PendingToolCalls` 带 `toolCallID` →
     Go 侧 emit `pending` 事件 → 前端审批卡片 → 用户允许/拒绝 →
     `Approve()`：执行（或拒绝）后 `CreateResponse(ctx, WithResume(state, results))` 恢复。
4. **会话记忆**：`session.NewMemoryStore()` 挂到 Agent，多轮对话自动保存/加载。

### 技术难点 [难点]（均已验证）

- **[难点] 审批暂停/恢复** ✅ 已验证：`NewSuspendResultWithReason` +
  `SuspendReasonAuth` + `WithResume`（源码确认存在，response.go / tool.go）。
- **[难点] OpenAI 兼容 provider** ✅ 已验证：`openaicompletions.New(WithEndpoint,
  WithAPIKey, WithModel)`，DeepSeek 换 endpoint 即用；Ollama 独立 provider。
- **[难点] 流式事件** ✅ 已验证：`EventCallback(ctx, *ResponseItem)` 带
  `ResponseItemTypeModelEvent`（text delta）/ ToolCall / ToolResult。
- **[难点] Go toolchain** ✅ 本机 go1.26.3 + GOTOOLCHAIN=auto，`go build` 通过
  （Dive 要求 toolchain go1.26.5，会自动下载）。CI 需确认 setup-go 行为。
- **[难点] 只读/写判定启发式**：纯字符串匹配，宁可多审批不可漏（误判只读为
  可执行的代价是破坏性的；误判写为审批只是多一步）。边界文档化。

### 已知边界（延续项目优雅降级哲学）

- Agent 只跑 pwsh（Windows）与 bash（Unix）默认会话；bash 下 MCP 的
  `stripTrailingPrompt` 是 pwsh 专用，Agent 工具输出不做提示符剥离（纯外观）。
- 嵌套 REPL 内 `execute_command` 会等超时（与 MCP 相同行为），Agent 需用
  `send_input`+`read_output` 驱动——写入 Agent 系统提示词。
- HTTP MCP 无鉴权边界不变；Agent 的 LLM API key 存本地 config.json（明文，
  同现有配置风格），不新增凭据存储。
- 多窗口：Agent 是全局单例，`agent_event` 广播到所有窗口，各窗口聊天面板
  显示同一对话（MVP 简化，符合"一个副驾"心智）。

## 4. 验收标准（MVP）

1. 设置面板可配置 LLM（provider/endpoint/model/api_key），保存后生效。
2. 聊天面板发消息 → 流式回复；工具调用以卡片展示（命令、状态、结果）。
3. 只读命令自动执行；写命令弹审批卡片，允许后执行、拒绝后继续。
4. `go vet ./internal/...` / `go test ./internal/...` / `npm run build` /
   `wails3 build` 全绿；本机冒烟无回归（Windows）。
5. 提交信息英文 conventional 风格；分支 `feat/ai-agent`（从 master 开）。
