# AGENTS.md

本文件为 AI 编码代理（及协作者）提供本项目的工作约定、关键机制与已知坑。开始改动前请先读完「关键技术机制」和「坑」两节——里面有多处是踩过坑才总结出来的非显然结论。

## 项目概览

**PwshDeck** 是一个 Wails v3 桌面应用：Go 后端 + React/TypeScript 前端（xterm.js），底层用 Windows ConPTY 跑真正的交互式 `pwsh`，并内置 MCP 服务让 AI 客户端远程创建/操控 pwsh 会话。

两种运行模式（`main.go`）：

- **GUI 模式**：单实例、多标签、多窗口，可选随 GUI 启动 streamable-HTTP MCP。
- **stdio 模式**：`PwshDeck.exe --mcp`，无头，供经典 `command` 型 MCP 客户端配置。

## 目录结构与职责

```
main.go                    # 入口：GUI / --mcp stdio 两种模式
internal/
  config/                  # config.json 加载与持久化（%APPDATA%\PwshDeck\config.json）
  session/                 # TerminalSession（ConPTY）+ SessionManager（会话管理/命令执行）
  mcp/                     # MCPService（HTTP 生命周期）+ BuildServer（工具注册）+ 输出清理
  window/                  # WindowManager（多窗口、标签布局持久化）
frontend/
  src/                     # React + TS + xterm.js
  bindings/                # wails3 自动生成，勿手改
build/                     # Wails3 各平台 Taskfile 脚手架（含 ios/android，见「坑」）
```

关键依赖：`github.com/UserExistsError/conpty v0.1.4`、`github.com/modelcontextprotocol/go-sdk v1.6.1`、`wails v3.0.0-beta.15`。

## 常用命令

```bash
# 完整生产构建（前端 + Go + 打包，输出 bin/PwshDeck.exe）
wails3 build

# 只编译 Go 后端（等价于 wails3 build 里的 native 步骤）
go build -tags production -trimpath -buildvcs=false -ldflags="-w -s -H windowsgui" -o bin\PwshDeck.exe .

# 前端构建（改 frontend/src 后必须重新跑，产物会被 go:embed 打进二进制）
cd frontend && npm run build

# 重新生成 Wails 绑定（改了 Service 的方法/模型后跑）
wails3 generate bindings -clean=true -ts -i

# 测试 / 静态检查（只针对 internal，见「坑」）
go test ./internal/...
go vet ./internal/...

# 开发模式（前端热重载）
wails3 dev

# 无头 stdio MCP
bin\PwshDeck.exe --mcp
```

冒烟脚本在 `.task/`（已 gitignore）：`smoke-sync.ps1`（同步读取，可用）、`smoke-test.ps1`（异步事件读取，某些环境读不到输出，弃用）。

## 关键技术机制

### 1. pwd 追踪（OSC 9;9 提示符钩子）

会话启动时用 `pwshCommandLine()`（`-NoLogo -NoProfile -NoExit -EncodedCommand <base64>`）注入一个钩子，重定义 `global:prompt`：每次渲染提示符时，先用 `$host.UI.Write` 输出 ConEmu 风格的 `ESC ] 9 ; 9 ; "path" ESC \`（OSC 9;9 报告），再输出默认的 `PS <path>> ` 提示符。

- `-EncodedCommand` 的参数是 **UTF-16LE 的 base64**（`encodeCommand`），不要改成 UTF-8。
- 保留 `-NoProfile`：用户 profile 不加载，钩子替换的只是默认提示符。
- 报告在 `readLoop` 里由 `consumeCwdReport` 解析（跨 chunk 分片安全，靠 `oscCarry` 记住末尾 1024 字节）。
- 解析到后调用 `notePrompt(pwd)`：更新 `TerminalSession.Pwd` 并让 `promptSeq` 自增。
- 对外暴露：`SessionInfo.pwd`、`term_pwd` 事件（前端据此持久化 `TabPref.pwd`）；恢复时把 pwd 传给 `StartSession(windowName, workDir)`，`resolveWorkDir` 对缺失/相对路径回退到用户主目录。

### 2. 命令完成判定（提示符信号，而非静默期）

`ExecuteCommand` 写命令后，等待 `promptSeq` 前进（= 提示符钩子再次触发 = 命令结束），而不是用「输出静默 700ms」启发式。**只有**当从未观察到过提示符（钩子缺失/被覆盖）时才回退到静默期。

- 这让 `Start-Sleep 60` 这类长命令能正确报 `timed_out`，而不是被静默期误判提前结束。
- `cmdMu` 按会话串行化 `ExecuteCommand`，防止并发调用按键交错/输出串台。

### 3. `consumeCwdReport` 的 carry 只保留「未终止」的报告尾巴

这是最容易踩回的坑：carry **只能**保留从最后一个 `ESC ]` 起、且尚无终止符的尾巴。若保留「完整」的 OSC 报告，下一 chunk 到达时会被**再次匹配**——导致每个提示符被重复计数（`promptSeq` 暴涨）并造成完成判定误触发。不要把它改回老的 `bytes.Contains(combined, "\x1b]")` 全量 carry。

### 4. 输出清理（只作用于 MCP，GUI 保留原始字节）

`internal/mcp/tools.go`：

- `cleanOutput`：剥 ANSI（CSI / OSC / 单字节 ESC）和游离控制字符，保留 `\t\r\n`。
- `stripCommandEcho`：定位**完整命令字符串第一次出现**的位置，取其之后内容（再跳过尾部空格与换行）。原因：PSReadLine 对长命令会「分段回显 + 一次完整重绘」，完整命令只出现在最后一次重绘里；旧「首行匹配」做法剥不干净。
- `stripTrailingPrompt`：正则 `\r?\n?PS [^\r\n]*?>\s*$` 剥掉尾部提示符。
- `decodeInput`：把 `\r`/`\n`/`\t`/`\\`/`\uXXXX` 解码为原始字节，只用在 `send_input` 的 handler 里，**不要**加进 `WriteInput`——GUI 终端的 `onData` 走的是真按键，不需要解码。

### 5. MCP 工具与两种传输

工具：`list_sessions` / `create_session` / `send_input` / `execute_command` / `read_output` / `stop_session` / `resize_session` / `list_windows`（`open_window` 已移除）。

- HTTP：`http://127.0.0.1:<port>/mcp`，随 GUI 启停，端口见 config（默认 21724，被占用时向上探测）。
- stdio：`--mcp`。
- **无鉴权**（有意暂缓）：HTTP 只绑 127.0.0.1，SDK 自带 localhost DNS-rebinding 防护，但任意本机进程仍可执行任意 PowerShell——这是已知风险，不要默认假设安全。

### 6. `execute_command` vs `send_input`+`read_output` 的边界

- `execute_command`：等 pwsh 提示符回来才返回结果，适合**一次性 PowerShell 命令**。
- 进了**嵌套 REPL**（erl/python/node…）后，pwsh 的提示符钩子不再触发，`execute_command` 会一直等到超时（哪怕命令其实执行了）——所以驱动 REPL 要用 `send_input`（发按键即返回）+ `read_output`（带 `since_offset` 增量读）。

## 坑

- **`go build ./...` 会失败**：`build/ios`（及 android）脚手架里 `main` 未定义是既有问题，与业务无关。构建请用 `go build .` 或 `go build ./internal/...`，测试用 `go test ./internal/...`。
- **`frontend/bindings/` 自动生成**：`wails3 generate bindings` 生成，路径与 Go 包结构对应，勿手改。`$Call.ByID(hash)` 的 hash 是「方法身份」的哈希，方法签名变化时 hash 不变，无需手动算。
- **Windows 专属**：ConPTY、`pwsh.exe`（不是 `powershell.exe`）、`-EncodedCommand` 为 UTF-16LE。二进制运行中可被覆盖（已观察），覆盖后需重启进程才加载新代码。
- **`build/appicon.png` 等资源**：属构建资产，一般与业务改动无关，提交时勿夹带无关文件的改动。
- **会话 ID**：4 字节随机，`StartSession` 里做了查重重试。

## 已知边界 / 有意未做

- HTTP MCP 无鉴权（暂缓，原因见上）。
- `execute_command` 提示符返回后没有 settle 延迟：极快的「连续长命令」之间，PSReadLine 的延迟重绘仍可能漏进下一条命令的输出（有意未加，避免每条命令 +200ms）。
- `create_session` 仍保留 `open_window` 参数（GUI 模式默认 true，会弹窗并触发前端按持久化标签再 boot 会话）；只移除了 `open_window` 工具本身。
- pwd 追踪依赖提示符钩子：若用户在会话里自行重定义 `prompt`，pwd 追踪和命令完成信号会静默失效（应用不崩，属优雅降级）。

## 提交约定

- 提交信息用英文、conventional-commit 风格（`feat:` / `fix:` / `refactor:` …）。
- 提交前跑 `go vet ./internal/...` 和 `go test ./internal/...`；改了前端就跑 `npm run build`；改了 Service 接口就跑 `wails3 generate bindings`。
- 不要把 `build/appicon.png` 之类无关的既有改动混进功能提交。
