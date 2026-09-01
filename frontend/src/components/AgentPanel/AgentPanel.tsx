import { useEffect, useRef, useState } from 'react';
import { Events } from '@wailsio/runtime';
import { AgentService } from '../../../bindings/pwshdeck/internal/agent';
import AgentIcon from '../AgentIcon';
import {
  useAgentStore,
  updateBlocks,
  setPending as storeSetPending,
  setStatus as storeSetStatus,
  setConfigured as storeSetConfigured,
  getAgentState,
  type Block,
  type ToolCall,
} from './agentStore';
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

// Single-line summary for a collapsed tool card: strip newlines and truncate.
const summarize = (raw: string, max = 120): string => {
  const flat = raw.replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max) + '…' : flat;
};

const blockLabel: Record<'system' | 'thinking' | 'tool', string> = {
  system: '系统提示词注入',
  thinking: '深度思考过程',
  tool: '工具调用',
};

export default function AgentPanel({ onOpenSettings }: Props) {
  const { blocks, pending, status, configured } = useAgentStore();
  const [input, setInput] = useState('');
  // Diagnostic: sequence of event types received during the current run, so a
  // misbehaving tool chain is visible instead of silently showing nothing.
  const [eventTrace, setEventTrace] = useState<string[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);

  const trace = (type: string) => {
    setEventTrace((prev) => (prev.length > 60 ? [...prev.slice(-59), type] : [...prev, type]));
  };

  // Log component lifecycle so a remount (which wipes local state) is visible
  // in the same agent.log as the backend event stream.
  useEffect(() => {
    AgentService.LogFrontend(
      `AgentPanel MOUNT blocks=${getAgentState().blocks.length} status=${getAgentState().status}`,
    ).catch(() => {});
    return () => {
      AgentService.LogFrontend(
        `AgentPanel UNMOUNT blocks=${getAgentState().blocks.length} status=${getAgentState().status}`,
      ).catch(() => {});
    };
  }, []);

  // Append a text delta to the trailing block when it is the same kind,
  // otherwise start a new block. This keeps the conversation in the AI's
  // actual output order (thinking, then text, then tool, then more text...).
  const appendDelta = (kind: 'assistant' | 'thinking', text: string) => {
    updateBlocks((prev) => {
      const next = [...prev];
      const last = next[next.length - 1];
      if (last && last.kind === kind) {
        next[next.length - 1] =
          kind === 'assistant'
            ? { ...(last as Extract<Block, { kind: 'assistant' }>), text: last.text + text }
            : { ...(last as Extract<Block, { kind: 'thinking' }>), text: last.text + text };
      } else {
        next.push(
          kind === 'assistant'
            ? { kind, text, streaming: true }
            : { kind, text, streaming: true, collapsed: true },
        );
      }
      return next;
    });
  };

  const refreshConfig = async () => {
    try {
      const [ok] = await AgentService.IsConfigured();
      storeSetConfigured(ok);
    } catch {
      storeSetConfigured(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [ok] = await AgentService.IsConfigured();
        if (!cancelled) storeSetConfigured(ok);
      } catch {
        if (!cancelled) storeSetConfigured(false);
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
      trace(ev.type);
      switch (ev.type) {
        case 'status':
          storeSetStatus(
            (ev.state === 'running' || ev.state === 'pending' ? ev.state : 'idle') as
              | 'idle'
              | 'running'
              | 'pending',
          );
          if (ev.state === 'running' && getAgentState().pending) storeSetPending(null);
          break;
        case 'delta':
          if (ev.text) appendDelta('assistant', ev.text);
          break;
        case 'thinking':
          if (ev.text) appendDelta('thinking', ev.text);
          break;
        case 'system':
          if (ev.text) {
            updateBlocks((prev) => [...prev, { kind: 'system', text: ev.text!, collapsed: true }]);
          }
          break;
        case 'tool_call': {
          const call: ToolCall = {
            id: ev.call_id || '',
            name: ev.tool || '',
            input: ev.input || '',
            output: '',
            state: 'running',
          };
          updateBlocks((prev) => [...prev, { kind: 'tool', call, collapsed: true }]);
          break;
        }
        case 'tool_result':
          updateBlocks((prev) =>
            prev.map((b) =>
              b.kind === 'tool' && b.call.id === ev.call_id
                ? { ...b, call: { ...b.call, output: ev.output ?? '', state: 'done' } }
                : b,
            ),
          );
          break;
        case 'pending':
          storeSetPending({
            callId: ev.call_id || '',
            tool: ev.tool || '',
            input: ev.input || '',
            command: ev.command || '',
            sessionId: ev.session_id || '',
            prompt: ev.prompt || '',
          });
          storeSetStatus('pending');
          break;
        case 'done':
          updateBlocks((prev) => {
            const next = prev.map((b) =>
              b.kind === 'assistant' || b.kind === 'thinking' ? { ...b, streaming: false } : b,
            );
            // Final text is authoritative: replace the last assistant block's
            // accumulated stream with it (keeps tools/thinking blocks intact).
            if (ev.text) {
              for (let i = next.length - 1; i >= 0; i--) {
                if (next[i].kind === 'assistant') {
                  next[i] = { ...(next[i] as Extract<Block, { kind: 'assistant' }>), text: ev.text! };
                  break;
                }
              }
            }
            return next;
          });
          break;
        case 'error':
          updateBlocks((prev) => [...prev, { kind: 'error', text: ev.text || '未知错误' }]);
          storeSetStatus('idle');
          break;
        case 'config':
          refreshConfig();
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
  }, [blocks, status, pending]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  const toggleBlock = (idx: number) => {
    updateBlocks((prev) =>
      prev.map((b, i) => {
        if (i !== idx || (b.kind !== 'system' && b.kind !== 'thinking' && b.kind !== 'tool')) return b;
        return { ...b, collapsed: !b.collapsed };
      }),
    );
  };

  const send = async () => {
    const text = input.trim();
    if (!text || status !== 'idle' || configured === false) return;
    updateBlocks((prev) => [...prev, { kind: 'user', text }]);
    setInput('');
    try {
      await AgentService.SendMessage(text);
    } catch (e) {
      updateBlocks((prev) => [...prev, { kind: 'error', text: String(e) }]);
      storeSetStatus('idle');
    }
  };

  const approve = async (approved: boolean) => {
    if (!pending) return;
    const p = pending;
    storeSetPending(null);
    updateBlocks((prev) => [
      ...prev,
      { kind: 'user', text: approved ? `（已批准执行：${p.command}）` : `（已拒绝：${p.command}）` },
    ]);
    try {
      await AgentService.Approve(p.callId, approved);
    } catch (e) {
      updateBlocks((prev) => [...prev, { kind: 'error', text: String(e) }]);
      storeSetStatus('idle');
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
        <div className="agent-empty-icon">
          <AgentIcon size={44} />
        </div>
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
          <span className="agent-logo">
            <AgentIcon size={15} />
          </span>
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

      {eventTrace.length > 0 && (
        <div className="agent-trace" title="本次运行收到的事件序列（调试用）">
          {eventTrace.join(' → ')}
        </div>
      )}

      <div className="agent-scroll" ref={scrollRef} onScroll={onScroll}>
        {blocks.length === 0 && (
          <div className="agent-welcome">
            <p>我是 PwshDeck 内置的 AI 助手，可以直接操作你的终端会话。</p>
            <p>
              例如：<em>“帮我看看为什么 node 命令找不到”</em>、
              <em>“检查 8080 端口被谁占用”</em>、<em>“装一下 Python 依赖”</em>。
            </p>
            <p>只读命令会自动执行；修改系统的命令会先征求你的批准。</p>
          </div>
        )}
        {blocks.map((block, idx) => {
          switch (block.kind) {
            case 'user':
              return (
                <div key={idx} className="agent-msg agent-user">
                  <div className="agent-bubble">{block.text}</div>
                </div>
              );
            case 'assistant':
              return (
                <div key={idx} className="agent-msg agent-assistant">
                  <div className={`agent-bubble ${block.streaming ? 'streaming' : ''}`}>
                    {block.text || (block.streaming ? '' : '…')}
                  </div>
                </div>
              );
            case 'system':
            case 'thinking':
              return (
                <div key={idx} className={`agent-block agent-block-${block.kind}`}>
                  <button type="button" className="agent-block-head" onClick={() => toggleBlock(idx)}>
                    <span className={`agent-chevron ${block.collapsed ? '' : 'open'}`}>▸</span>
                    <span className={`agent-block-dot ${'streaming' in block && block.streaming ? 'running' : 'done'}`} />
                    <span className="agent-block-label">{blockLabel[block.kind]}</span>
                    {'streaming' in block && block.streaming && <span className="agent-block-live">进行中</span>}
                  </button>
                  {!block.collapsed && <pre className="agent-block-body">{block.text}</pre>}
                </div>
              );
            case 'tool': {
              const call = block.call;
              const statusText =
                call.state === 'running' ? '进行中' : call.state === 'error' ? '失败' : '完成';
              return (
                <div key={idx} className={`agent-tool-card ${call.state}${block.collapsed ? ' collapsed' : ''}`}>
                  <button type="button" className="agent-tool-card-head" onClick={() => toggleBlock(idx)}>
                    <span className={`agent-chevron ${block.collapsed ? '' : 'open'}`}>▸</span>
                    <span className={`agent-tool-card-state ${call.state}`} />
                    <span className="agent-tool-card-name">{call.name}</span>
                    <span className={`agent-tool-card-status ${call.state}`}>{statusText}</span>
                  </button>
                  <div className="agent-tool-card-body">
                    {call.input && (
                      <div className="agent-tool-card-line">
                        <span className="agent-tool-card-key">输入</span>
                        <span className="agent-tool-card-val">
                          {block.collapsed ? summarize(prettyJson(call.input)) : prettyJson(call.input)}
                        </span>
                      </div>
                    )}
                    {call.output ? (
                      <div className="agent-tool-card-line">
                        <span className="agent-tool-card-key">输出</span>
                        <span className="agent-tool-card-val">
                          {block.collapsed ? summarize(call.output) : call.output}
                        </span>
                      </div>
                    ) : call.state === 'running' ? (
                      <div className="agent-tool-card-line">
                        <span className="agent-tool-card-key">状态</span>
                        <span className="agent-tool-card-val">正在执行…</span>
                      </div>
                    ) : null}
                  </div>
                </div>
              );
            }
            case 'error':
              return (
                <div key={idx} className="agent-msg agent-error">
                  ⚠ {block.text}
                </div>
              );
          }
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
