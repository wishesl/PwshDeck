import { useEffect, useRef } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { Events } from '@wailsio/runtime';
import { PwshService } from '../../../bindings/changeme';
import './Terminal.css';

export default function Terminal() {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new XTerm({
      allowTransparency: true,
      cursorBlink: true,
      fontSize: 14,
      fontFamily: "'Cascadia Code', 'Consolas', 'Courier New', monospace",
      theme: {
        background: 'rgba(8, 10, 16, 0.66)',
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
        if (dims) {
          PwshService.Resize(dims.cols, dims.rows).catch(() => {});
        }
      } catch {
        /* terminal not ready yet */
      }
    };
    syncSize();
    window.addEventListener('resize', syncSize);

    // Keystrokes -> shell stdin.
    const dataDisposable = term.onData((data) => {
      PwshService.WriteInput(data).catch(() => {});
    });

    // ConPTY output -> terminal.
    const offData = Events.On('term_data', (event: any) => {
      term.write(event.data);
    });
    const offStatus = Events.On('term_status', (event: any) => {
      if (event.data === 'disconnected') {
        term.write('\r\n\x1b[90m[pwsh session ended]\x1b[0m\r\n');
      }
    });

    // Boot the shell.
    PwshService.StartPwsh()
      .then(syncSize)
      .catch((err: any) => {
        term.write(`\r\n\x1b[31mFailed to start pwsh: ${err}\x1b[0m\r\n`);
      });

    return () => {
      dataDisposable.dispose();
      offData();
      offStatus();
      window.removeEventListener('resize', syncSize);
      PwshService.StopPwsh().catch(() => {});
      term.dispose();
    };
  }, []);

  return (
    <div className="terminal">
      <div ref={containerRef} className="terminal-xterm" />
    </div>
  );
}
