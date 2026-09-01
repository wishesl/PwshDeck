import { useEffect, useState } from 'react';
import { AgentService } from '../../../bindings/pwshdeck/internal/agent';
import type { LLMConfig } from '../../../bindings/pwshdeck/internal/config';
import './AgentSettings.css';

const DEFAULT_CFG: LLMConfig = { provider: 'openaicompletions', endpoint: '', model: '', api_key: '' };

const PROVIDERS = [
  { value: 'openaicompletions', label: 'OpenAI 兼容（DeepSeek / OpenAI / 中转站…）' },
  { value: 'ollama', label: 'Ollama（本地）' },
];

export default function AgentSettings() {
  const [cfg, setCfg] = useState<LLMConfig>(DEFAULT_CFG);
  const [loaded, setLoaded] = useState(false);
  const [configured, setConfigured] = useState(false);
  const [statusText, setStatusText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [autoApprove, setAutoApprove] = useState(false);

  const refresh = async () => {
    try {
      const [ok, why] = await AgentService.IsConfigured();
      setConfigured(ok);
      setStatusText(why);
      const c = await AgentService.GetLLMConfig();
      setCfg({
        provider: c.provider || DEFAULT_CFG.provider,
        endpoint: c.endpoint || '',
        model: c.model || '',
        api_key: c.api_key || '',
      });
      setAutoApprove(await AgentService.IsAutoApprove());
    } catch (e) {
      setError(String(e));
    }
  };

  useEffect(() => {
    (async () => {
      await refresh();
      setLoaded(true);
    })();
  }, []);

  const save = async () => {
    if (!cfg.model.trim()) {
      setError('请填写模型名称（model），例如 deepseek-chat。');
      return;
    }
    setBusy(true);
    setError('');
    setSaved(false);
    try {
      await AgentService.SetLLMConfig({ ...cfg, model: cfg.model.trim() });
      await refresh();
      setSaved(true);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const toggleAutoApprove = async () => {
    const next = !autoApprove;
    setAutoApprove(next);
    try {
      await AgentService.SetAutoApprove(next);
    } catch (e) {
      setAutoApprove(!next);
      setError(String(e));
    }
  };

  return (
    <div className="agent-settings">
      <section className="card">
        <div className="card-head">
          <h2>AI 助手模型</h2>
          <span className={`pill ${configured ? 'on' : 'off'}`}>{configured ? '● 已配置' : '○ 未配置'}</span>
        </div>
        <p className="hint">
          内置 AI 助手可直接操控本应用的 pwsh 终端会话，帮助排查环境问题；默认写操作需你逐条审批后才执行。
        </p>
        <label className="agent-settings-perm">
          <input type="checkbox" checked={autoApprove} onChange={toggleAutoApprove} />
          <span>
            <strong>完全权限模式</strong> — 写命令、发送输入、停止会话免审批直接执行
            {autoApprove && <em className="agent-settings-perm-on">（已开启，注意风险）</em>}
          </span>
        </label>
        {statusText && <p className="agent-settings-status">{statusText}</p>}
        {error && <p className="error-msg">⚠ {error}</p>}
        <div className="agent-settings-grid">
          <label>
            <span>Provider</span>
            <select value={cfg.provider} onChange={(e) => setCfg({ ...cfg, provider: e.target.value })} disabled={busy}>
              {PROVIDERS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          <label className="agent-settings-wide">
            <span>接口地址 Endpoint（可选，留空用 Provider 默认）</span>
            <input
              type="text"
              value={cfg.endpoint}
              onChange={(e) => setCfg({ ...cfg, endpoint: e.target.value })}
              disabled={busy}
              placeholder={
                cfg.provider === 'ollama'
                  ? 'http://localhost:11434/v1/messages'
                  : 'https://api.deepseek.com/v1/chat/completions'
              }
            />
          </label>
          <label>
            <span>模型 Model</span>
            <input
              type="text"
              value={cfg.model}
              onChange={(e) => setCfg({ ...cfg, model: e.target.value })}
              disabled={busy}
              placeholder={cfg.provider === 'ollama' ? 'qwen2.5-coder' : 'deepseek-chat'}
            />
          </label>
          <label>
            <span>API Key</span>
            <input
              type="password"
              value={cfg.api_key}
              onChange={(e) => setCfg({ ...cfg, api_key: e.target.value })}
              disabled={busy}
              placeholder="本地 Ollama 可留空"
            />
          </label>
        </div>
        <div className="controls">
          <button className="primary" onClick={save} disabled={busy || !loaded}>
            {busy ? '保存中…' : '保存并应用'}
          </button>
          {saved && <span className="agent-settings-ok">✓ 已保存，AI 助手已就绪</span>}
        </div>
      </section>
    </div>
  );
}
