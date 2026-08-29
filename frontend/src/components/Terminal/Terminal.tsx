import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Terminal as XTerm, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { Events, Window } from '@wailsio/runtime';
import { SessionManager } from '../../../bindings/pwsh-mcp/internal/session';
import './Terminal.css';

type Phase = 'starting' | 'connected' | 'ended' | 'error';

/** Default tab color used when none is chosen. */
export const DEFAULT_ACCENT = '#4f8cff';

interface TerminalProps {
  /** Tab color: drives the xterm cursor/selection and the container accent. */
  accent?: string;
  /** Whether this tab is visible; triggers a re-fit when it becomes active. */
  active?: boolean;
  /** Fired with the session id once the shell is connected. */
  onReady?: (sessionId: string) => void;
}

function withAlpha(hex: string, alpha: number): string {
  const h = hex.replace('#', '');
  if (h.length !== 6) return `rgba(122, 162, 247, ${alpha})`;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function themeFor(accent: string): ITheme {
  return {
    background: 'rgba(8, 10, 16, 0.0)',
    foreground: '#d4d4d4',
    cursor: accent,
    cursorAccent: '#0a0c14',
    selectionBackground: withAlpha(accent, 0.35),
  };
}

export default function Terminal({ accent = DEFAULT_ACCENT, active = true, onReady }: TerminalProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const [phase, setPhase] = useState<Phase>('starting');

  // Latest props for callbacks without recreating the main effect.
  const accentRef = useRef(accent);
  const onReadyRef = useRef(onReady);
  accentRef.current = accent;
  onReadyRef.current = onReady;

  // Hidden tabs (display:none) report zero size; skip any sizing work then.
  const isVisible = () => {
    const c = containerRef.current;
    return !!c && c.offsetWidth > 0 && c.offsetHeight > 0;
  };

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new XTerm({
      allowTransparency: true,
      cursorBlink: true,
      fontSize: 14,
      fontFamily: "'Cascadia Code', 'Consolas', 'Courier New', monospace",
      theme: themeFor(accentRef.current),
      scrollback: 10000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    fit.fit();

    termRef.current = term;
    fitRef.current = fit;

    // Keep the ConPTY size in sync with the rendered terminal.
    const syncSize = () => {
      if (!isVisible()) return;
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
    let disposed = false;
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
      if (disposed) {
        // Tab closed while the shell was still starting: stop it right away.
        SessionManager.StopSession(info.id).catch(() => {});
        return;
      }
      sessionIdRef.current = info.id;
      onReadyRef.current?.(info.id);
      setPhase('connected');
      syncSize();
    })().catch((err) => {
      if (disposed) return;
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

    // ConPTY output -> terminal, routed to this tab's session only.
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
      disposed = true;
      dataDisposable.dispose();
      offData();
      offStatus();
      window.removeEventListener('resize', syncSize);
      const id = sessionIdRef.current;
      if (id) {
        SessionManager.StopSession(id).catch(() => {});
      }
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, []);

  // Follow accent changes (rename/color picked in the tab menu).
  useEffect(() => {
    accentRef.current = accent;
    const term = termRef.current;
    if (term) {
      term.options.theme = themeFor(accent);
    }
  }, [accent]);

  // Re-fit when this tab becomes visible (hidden tabs have no size).
  useEffect(() => {
    if (!active) return;
    const timer = setTimeout(() => {
      const term = termRef.current;
      const fit = fitRef.current;
      if (!term || !fit) return;
      try {
        fit.fit();
        const dims = fit.proposeDimensions();
        const id = sessionIdRef.current;
        if (dims && id) {
          SessionManager.Resize(id, dims.cols, dims.rows).catch(() => {});
        }
      } catch {
        /* not ready yet */
      }
    }, 40);
    return () => clearTimeout(timer);
  }, [active]);

  return (
    <div className="terminal" style={{ '--tab-accent': accent } as CSSProperties}>
      {phase !== 'connected' && (
        <div className={`terminal-badge terminal-badge-${phase}`}>
          {phase === 'starting' && '正在启动 pwsh…'}
          {phase === 'ended' && '会话已结束 — 关闭标签页或新建终端'}
          {phase === 'error' && '启动失败'}
        </div>
      )}
      <div ref={containerRef} className="terminal-xterm" />
    </div>
  );
}
