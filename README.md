# pwsh-mcp

基于 [Wails v3](https://v3.wails.io/) 的 PowerShell (pwsh) 桌面交互式终端，内置 **MCP (Model Context Protocol)** 服务，让 AI 客户端可以直接创建、操控 pwsh 会话并读取输出。

## 功能

- **桌面终端**：xterm.js + Windows ConPTY，pwsh 行为与真实终端完全一致（Tab 补全、PSReadLine、进度条、Ctrl+C…）
- **多窗口**：可打开多个终端窗口，每个窗口绑定独立会话，窗口关闭自动清理会话
- **系统托盘**：点击关闭按钮（或 Alt+F4 / 任务栏「关闭窗口」）会询问「最小化到系统托盘 / 直接退出」；最小化到托盘后会话与 MCP 服务继续在后台运行，可随时从托盘图标唤起
- **MCP 服务**（两种传输方式）：
  - **streamable-HTTP**：`http://127.0.0.1:<port>/mcp`，随 GUI 运行，可在「MCP 管理」页一键启停
  - **stdio**：`pwsh-mcp.exe --mcp`，无头模式，适合经典 `command` 型 MCP 客户端配置
- **暴露的 MCP 工具**：`list_sessions` / `create_session` / `send_input` / `execute_command` / `read_output` / `stop_session` / `resize_session` / `list_windows`
- **配置持久化**：`config.json` 保存 MCP 开关与端口，以及终端标签布局（名称、颜色、**工作目录**，`%APPDATA%\pwsh-mcp\config.json`）；重启后标签恢复，每个标签的 pwsh 会直接启动在上次的工作目录

## 项目结构

```
.
├── main.go                  # 入口：GUI 模式 / --mcp stdio 模式
├── internal/
│   ├── config/              # 应用配置的加载与持久化
│   ├── session/             # ConPTY 会话模型 + SessionManager（终端服务）
│   ├── window/              # WindowManager（多窗口服务）
│   └── mcp/                 # MCPService（HTTP 服务生命周期）+ 工具注册
├── frontend/                # React + TypeScript 前端（xterm.js）
│   ├── src/
│   │   ├── components/Terminal/   # 终端组件
│   │   ├── components/McpPanel/   # MCP 管理面板
│   │   └── utils/ansi.ts          # ANSI 转义序列处理
│   └── bindings/            # Wails3 自动生成的前端绑定（勿手改）
└── build/                   # Wails3 构建资产（各平台 Taskfile）
```

> `frontend/bindings/` 由 `wails3 generate bindings` 自动生成，路径与 Go 包结构对应，请勿手动编辑。

## 开发

前置要求：Go 1.25+、Node.js、[wails3 CLI](https://v3.wails.io/)。

```bash
# 开发模式（前端热重载 + 后端热编译）
wails3 dev

# 或使用 Taskfile
task dev
```

## 构建

```bash
# 生产构建（输出到 bin/）
task build

# 仅编译 Go 后端
go build .
```

## 运行

```bash
# GUI 模式
task run

# 无头 stdio MCP 服务器（供 MCP 客户端直接调用）
pwsh-mcp.exe --mcp
```

## 接入 MCP 客户端

启动 MCP 服务后，在「MCP 管理」页可复制现成的客户端配置：

**HTTP 模式**（推荐，随 GUI 运行）：

```json
{
  "mcpServers": {
    "pwsh-mcp": { "type": "http", "url": "http://127.0.0.1:21724/mcp" }
  }
}
```

**stdio 模式**（无头，无需 GUI）：

```json
{
  "mcpServers": {
    "pwsh-mcp": { "command": "pwsh-mcp.exe", "args": ["--mcp"] }
  }
}
```

MCP 服务只监听 `127.0.0.1`，不对局域网开放。

> **会话过期**：MCP 客户端会话（`Mcp-Session-Id`）空闲超过 `mcp_session_timeout_minutes`（默认 60）会被服务端回收；pwsh-mcp 重启后旧会话也会失效。客户端收到 `404 session not found` 时应按 MCP 规范重新 `initialize`。

## 配置

所有设置持久化在 `%APPDATA%\pwsh-mcp\config.json`（通过 `config.Load()` 读取，首次运行自动创建默认值）：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `mcp_enabled` | `false` | 启动时自动开启 HTTP MCP 服务 |
| `mcp_port` | `21724` | HTTP MCP 端口；被占用时自动向上探测空闲端口 |
| `mcp_session_timeout_minutes` | `60` | 空闲 MCP 客户端会话回收时间（0 = 不回收） |
| `max_sessions` | `10` | 并发会话上限（0 = 不限制），超出时 `create_session` 报错 |
| `idle_timeout_minutes` | `30` | 无窗口（MCP 创建）会话闲置自动回收（0 = 关闭）；GUI 标签页会话不受影响 |
| `tabs` | `[]` | 终端标签布局（名称 + 颜色 + 工作目录），重启后恢复，会话本身不恢复但每个会话以上次所在目录启动 |

## 其他行为

- **单实例**：GUI 模式只允许一个实例；重复启动会聚焦已运行窗口（stdio `--mcp` 模式不受限）。
- **关闭到托盘**：关闭按钮 / Alt+F4 / 任务栏「关闭窗口」会弹出选择框——「最小化到系统托盘」隐藏窗口但保留会话与 MCP 服务，「直接退出」结束整个应用；勾选「本次启动不再提示」后本次运行记住该选择，下次启动恢复询问。托盘图标左键唤起窗口，右键菜单可「显示 pwsh-mcp」或「退出」。
- 关闭最后一个终端标签时不会自动退出应用（至少保留一个标签）。

## 许可

基于 Wails v3 模板项目，遵循相应开源许可。
