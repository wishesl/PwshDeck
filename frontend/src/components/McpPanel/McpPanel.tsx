import { useEffect, useState } from 'react';
import { MCPService } from '../../../bindings/changeme';
import type { MCPStatus } from '../../../bindings/changeme';
import './McpPanel.css';

export default function McpPanel() {
  const [status, setStatus] = useState<MCPStatus | null>(null);
  const [port, setPort] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const st = (await MCPService.GetStatus()) as unknown as MCPStatus;
        setStatus(st);
        setPort(String(st.port || 21724));
      } catch (e) {
        setError(String(e));
      }
    })();
  }, []);

  const toggle = async () => {
    if (!status) return;
    setBusy(true);
    setError('');
    try {
      if (status.running) {
        await MCPService.Disable();
      } else {
        await MCPService.Enable(parseInt(port, 10) || 21724);
      }
      const st = (await MCPService.GetStatus()) as unknown as MCPStatus;
      setStatus(st);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      /* clipboard unavailable */
    }
  };

  const url = status?.url || `http://127.0.0.1:${port || 21724}/mcp`;
  const exePath = (status?.stdio_cmd || '')
    .replace(/ --mcp$/, '')
    .replace(/^"|"$/g, '');

  const httpConfig = JSON.stringify(
    { mcpServers: { 'pwsh-mcp': { type: 'http', url } } },
    null,
    2,
  );
  const stdioConfig = JSON.stringify(
    {
      mcpServers: {
        'pwsh-mcp': {
          command: exePath || 'pwsh-mcp.exe',
          args: ['--mcp'],
        },
      },
    },
    null,
    2,
  );

  return (
    <div className="mcp-panel">
      <section className="card">
        <div className="card-head">
          <h2>MCP 服务</h2>
          <span className={`pill ${status?.running ? 'on' : 'off'}`}>
            {status?.running ? '● 运行中' : '○ 已停止'}
          </span>
        </div>
        <p className="hint">
          AI 客户端（ZCode、Claude 等）通过 MCP 协议连接本应用，即可创建/操控 pwsh
          终端会话、执行命令并读取输出。服务仅监听 127.0.0.1，不对局域网开放。
        </p>
        {error && <p className="error-msg">⚠ {error}</p>}
        <div className="controls">
          <label htmlFor="mcp-port">端口</label>
          <input
            id="mcp-port"
            value={port}
            onChange={(e) => setPort(e.target.value.replace(/\D/g, ''))}
            disabled={busy || !!status?.running}
            inputMode="numeric"
            placeholder="21724"
          />
          <button className="primary" onClick={toggle} disabled={busy || !status}>
            {busy ? '处理中…' : status?.running ? '停止服务' : '启动服务'}
          </button>
        </div>
        {status?.running && (
          <div className="endpoint">
            端点：<code>{status.url}</code>
          </div>
        )}
      </section>

      <section className="card">
        <div className="card-head">
          <h2>客户端配置</h2>
          <span className="pill">{status?.running ? 'HTTP 可用' : '启动服务后可用'}</span>
        </div>
        <h3>HTTP 模式（推荐，随 GUI 运行）</h3>
        <pre>
          {httpConfig}
          <button className="copy" onClick={() => copy(httpConfig)}>
            复制
          </button>
        </pre>
        <h3>stdio 模式（无头，无需 GUI）</h3>
        <pre>
          {stdioConfig}
          <button className="copy" onClick={() => copy(stdioConfig)}>
            复制
          </button>
        </pre>
        <p className="hint">
          stdio 模式直接运行 <code>{exePath || 'pwsh-mcp.exe'} --mcp</code>
          ，以命令形式注册到任意 MCP 客户端。
        </p>
      </section>

      <section className="card">
        <div className="card-head">
          <h2>暴露的工具（{status?.tool_count ?? 0}）</h2>
        </div>
        <ul className="tools">
          {(status?.tools ?? []).map((t) => (
            <li key={t.name}>
              <code className="tool-name">{t.name}</code>
              <span className="tool-desc">{t.description}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
