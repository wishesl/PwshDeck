import { useEffect, useRef, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { Events, Window } from '@wailsio/runtime';
import { SessionManager } from '../../../bindings/pwsh-mcp/internal/session';
import './Terminal.css';

type Phase = 'starting' | 'connected' | 'ended' | 'error';

export default function Terminal() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const [phase, setPhase] = useState<Phase>('starting');

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new XTerm({
      allowTransparency: true,
      cursorBlink: true,
      fontSize: 14,
      fontFamily: "'Cascadia Code', 'Consolas', 'Courier New', monospace",
      theme: {
        background: 'rgba(8, 10, 16, 0.0)',
        foreground: '#d4d4d4',
        cursor: '#d4d4d4',
        selectionBackground: 'rgba(122, 162, 247, 0.35)',
      },
      scrollback: 10000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    fit.fit();

    // Keep the ConPTY size in sync with the rendered terminal.
    const syncSize = () => {
      try {
        fit.fit();
        const dims = fit.proposeDimensions();
        const id = sessionIdRef.current;
        if (dims && id) {
          SessionManager.Resize(id, dims.cols, dims.rows).catch(() => {});
        }
      } catch {
        /* terminal not ready yet */
      }
    };
    syncSize();
    window.addEventListener('resize', syncSize);

    // Boot the shell bound to this window so closing the window stops it.
    (async () => {
      let winName = '';
      try {
        winName = await Window.Name();
      } catch {
        /* browser dev: no window identity */
      }
      const info = await SessionManager.StartSession(winName);
      if (!info) {
        throw new Error('启动会话失败：服务返回空结果');
      }
      sessionIdRef.current = info.id;
      setPhase('connected');
      syncSize();
    })().catch((err) => {
      setPhase('error');
      term.write(`\r\n\x1b[31m启动 pwsh 失败: ${err}\x1b[0m\r\n`);
    });

    // Keystrokes -> shell stdin.
    const dataDisposable = term.onData((data) => {
      const id = sessionIdRef.current;
      if (id) {
        SessionManager.WriteInput(id, data).catch(() => {});
      }
    });

    // ConPTY output -> terminal, routed to this window's session only.
    const offData = Events.On('term_data', (event: any) => {
      const payload = event?.data;
      if (payload && sessionIdRef.current && payload.id === sessionIdRef.current) {
        term.write(payload.data);
      }
    });
    const offStatus = Events.On('term_status', (event: any) => {
      const payload = event?.data;
      if (payload && sessionIdRef.current && payload.id === sessionIdRef.current) {
        if (payload.status === 'disconnected') {
          term.write('\r\n\x1b[90m[pwsh 会话已结束]\x1b[0m\r\n');
          setPhase('ended');
        }
      }
    });

    return () => {
      dataDisposable.dispose();
      offData();
      offStatus();
      window.removeEventListener('resize', syncSize);
      const id = sessionIdRef.current;
      if (id) {
        SessionManager.StopSession(id).catch(() => {});
      }
      term.dispose();
    };
  }, []);

  return (
    <div className="terminal">
      {phase !== 'connected' && (
        <div className={`terminal-badge terminal-badge-${phase}`}>
          {phase === 'starting' && '正在启动 pwsh…'}
          {phase === 'ended' && '会话已结束 — 关闭窗口或新建会话'}
          {phase === 'error' && '启动失败'}
        </div>
      )}
      <div ref={containerRef} className="terminal-xterm" />
    </div>
  );
}
