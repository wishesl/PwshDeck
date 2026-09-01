import { useEffect, useRef, useState } from 'react';
import { Events } from '@wailsio/runtime';
import { AgentService } from '../../../bindings/pwshdeck/internal/agent';
import './AgentPanel.css';

// Wire payload of the agent_event Wails event (mirrors internal/agent.AgentEvent).
type AgentEventPayload = {
  type: string;
  state?: string;
  text?: string;
  call_id?: string;
  tool?: string;
  input?: string;
  output?: string;
  prompt?: string;
  command?: string;
  session_id?: string;
};

type ToolCall = {
  id: string;
  name: string;
  input: string;
  output: string;
  state: 'running' | 'done' | 'error';
};

type PendingApproval = {
  callId: string;
  tool: string;
  input: string;
  command: string;
  sessionId: string;
  prompt: string;
};

type Entry =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string; streaming: boolean; toolCalls: ToolCall[] }
  | { kind: 'system'; text: string }
  | { kind: 'error'; text: string };

type Props = {
  onOpenSettings: () => void;
};

const prettyJson = (raw: string): string => {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
};

export default function AgentPanel({ onOpenSettings }: Props) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [status, setStatus] = useState<'idle' | 'running' | 'pending'>('idle');
  const [pending, setPending] = useState<PendingApproval | null>(null);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [input, setInput] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const pendingRef = useRef(pending);
  pendingRef.current = pending;

  // Update the last assistant entry (creating one on demand), then run a
  // callback so event handlers can append deltas / tool activity to it.
  const patchLastAssistant = (
    fn: (e: Extract<Entry, { kind: 'assistant' }>) => Extract<Entry, { kind: 'assistant' }>,
  ) => {
    setEntries((prev) => {
      const next = [...prev];
      let i = next.length - 1;
      while (i >= 0 && next[i].kind !== 'assistant') i -= 1;
      if (i < 0) {
        next.push(fn({ kind: 'assistant', text: '', streaming: true, toolCalls: [] }));
      } else {
        next[i] = fn(next[i] as Extract<Entry, { kind: 'assistant' }>);
      }
      return next;
    });
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [ok] = await AgentService.IsConfigured();
        if (!cancelled) setConfigured(ok);
      } catch {
        if (!cancelled) setConfigured(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const off = Events.On('agent_event', (event: any) => {
      const ev = (event?.data ?? event) as AgentEventPayload;
      if (!ev || typeof ev.type !== 'string') return;
      switch (ev.type) {
        case 'status':
          setStatus((ev.state === 'running' || ev.state === 'pending' ? ev.state : 'idle') as 'idle' | 'running' | 'pending');
          if (ev.state === 'running' && pendingRef.current) setPending(null);
          break;
        case 'delta':
          if (!ev.text) break;
          patchLastAssistant((e) => ({ ...e, text: e.text + ev.text! }));
          break;
        case 'tool_call': {
          const call: ToolCall = {
            id: ev.call_id || '',
            name: ev.tool || '',
            input: ev.input || '',
            output: '',
            state: 'running',
          };
          patchLastAssistant((e) => ({ ...e, toolCalls: [...e.toolCalls, call] }));
          break;
        }
        case 'tool_result':
          patchLastAssistant((e) => ({
            ...e,
            toolCalls: e.toolCalls.map((c) =>
              c.id === ev.call_id ? { ...c, output: ev.output ?? '', state: 'done' } : c,
            ),
          }));
          break;
        case 'pending':
          setPending({
            callId: ev.call_id || '',
            tool: ev.tool || '',
            input: ev.input || '',
            command: ev.command || '',
            sessionId: ev.session_id || '',
            prompt: ev.prompt || '',
          });
          setStatus('pending');
          break;
        case 'done':
          patchLastAssistant((e) => ({ ...e, text: ev.text ?? e.text, streaming: false }));
          break;
        case 'error':
          setEntries((prev) => [...prev, { kind: 'error', text: ev.text || '未知错误' }]);
          setStatus('idle');
          break;
        default:
          break;
      }
    });
    return off;
  }, []);

  // Auto-scroll to the bottom unless the user has scrolled up.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [entries, status, pending]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  const send = async () => {
    const text = input.trim();
    if (!text || status !== 'idle' || configured === false) return;
    setEntries((prev) => [...prev, { kind: 'user', text }]);
    setInput('');
    try {
      await AgentService.SendMessage(text);
    } catch (e) {
      setEntries((prev) => [...prev, { kind: 'error', text: String(e) }]);
      setStatus('idle');
    }
  };

  const approve = async (approved: boolean) => {
    if (!pending) return;
    const p = pending;
    setPending(null);
    setEntries((prev) => [
      ...prev,
      { kind: 'system', text: approved ? `已批准执行：${p.command}` : `已拒绝：${p.command}` },
    ]);
    try {
      await AgentService.Approve(p.callId, approved);
    } catch (e) {
      setEntries((prev) => [...prev, { kind: 'error', text: String(e) }]);
      setStatus('idle');
    }
  };

  const cancel = async () => {
    try {
      await AgentService.Cancel();
    } catch {
      /* ignore */
    }
  };

  if (configured === false) {
    return (
      <div className="agent-panel agent-empty">
        <div className="agent-empty-icon">🤖</div>
        <h3>AI 助手尚未配置</h3>
        <p>请在设置中填写模型服务信息（支持 OpenAI 兼容接口，如 DeepSeek / Ollama）。</p>
        <button type="button" className="agent-primary" onClick={onOpenSettings}>
          打开设置
        </button>
      </div>
    );
  }

  const statusLabel =
    status === 'running' ? '思考中…' : status === 'pending' ? '等待审批' : '空闲';

  return (
    <div className="agent-panel">
      <div className="agent-head">
        <div className="agent-head-title">
          <span className="agent-logo">🤖</span>
          <span>AI 助手</span>
          <span className={`agent-status ${status}`}>
            <span className="agent-status-dot" />
            {statusLabel}
          </span>
        </div>
        {status === 'running' && (
          <button type="button" className="agent-ghost" onClick={cancel}>
            停止
          </button>
        )}
      </div>

      <div className="agent-scroll" ref={scrollRef} onScroll={onScroll}>
        {entries.length === 0 && (
          <div className="agent-welcome">
            <p>我是 PwshDeck 内置的 AI 助手，可以直接操作你的终端会话。</p>
            <p>例如：<em>“帮我看看为什么 node 命令找不到”</em>、<em>“检查 8080 端口被谁占用”</em>、<em>“装一下 Python 依赖”</em>。</p>
            <p>只读命令会自动执行；修改系统的命令会先征求你的批准。</p>
          </div>
        )}
        {entries.map((entry, idx) => {
          if (entry.kind === 'user') {
            return (
              <div key={idx} className="agent-msg agent-user">
                <div className="agent-bubble">{entry.text}</div>
              </div>
            );
          }
          if (entry.kind === 'system') {
            return (
              <div key={idx} className="agent-msg agent-system">
                {entry.text}
              </div>
            );
          }
          if (entry.kind === 'error') {
            return (
              <div key={idx} className="agent-msg agent-error">
                ⚠ {entry.text}
              </div>
            );
          }
          return (
            <div key={idx} className="agent-msg agent-assistant">
              <div className={`agent-bubble ${entry.streaming ? 'streaming' : ''}`}>
                {entry.text || (entry.streaming ? '' : '…')}
              </div>
              {entry.toolCalls.length > 0 && (
                <div className="agent-tools">
                  {entry.toolCalls.map((call) => (
                    <div key={call.id} className="agent-tool">
                      <div className="agent-tool-head">
                        <span className={`agent-tool-state ${call.state}`}>
                          {call.state === 'running' ? '●' : '✓'}
                        </span>
                        <code>{call.name}</code>
                      </div>
                      {call.input && <pre className="agent-tool-io">{prettyJson(call.input)}</pre>}
                      {call.output && <pre className="agent-tool-io agent-tool-out">{call.output}</pre>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
        {pending && (
          <div className="agent-pending">
            <div className="agent-pending-head">
              <span className="agent-pending-icon">🔒</span>
              <span>需要你的批准</span>
            </div>
            <div className="agent-pending-command">
              <code>{pending.command || pending.tool}</code>
            </div>
            {pending.input && <pre className="agent-tool-io">{prettyJson(pending.input)}</pre>}
            {pending.sessionId && <div className="agent-pending-session">会话 {pending.sessionId}</div>}
            <div className="agent-pending-actions">
              <button type="button" className="agent-approve" onClick={() => approve(true)}>
                批准
              </button>
              <button type="button" className="agent-reject" onClick={() => approve(false)}>
                拒绝
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="agent-input-row">
        <textarea
          className="agent-input"
          value={input}
          placeholder={status === 'pending' ? '先处理待审批的操作…' : '描述你的环境问题，回车发送（Shift+Enter 换行）'}
          disabled={status === 'running' || status === 'pending'}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <button
          type="button"
          className="agent-primary"
          disabled={!input.trim() || status !== 'idle'}
          onClick={send}
        >
          发送
        </button>
      </div>
    </div>
  );
}
