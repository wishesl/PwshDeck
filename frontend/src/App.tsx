import { useEffect, useRef, useState } from 'react';
import { Events, Window } from '@wailsio/runtime';
import { WindowManager } from '../bindings/pwshdeck/internal/window';
import McpPanel from './components/McpPanel';
import Workbench from './components/Workbench/Workbench';
import { DEFAULT_ACCENT } from './components/Terminal';
import {
  buildColumn,
  countLeaves,
  flattenLeaves,
  makeSplit,
  moveLeaf,
  newLeaf,
  removeLeaf,
  updateLeaf,
  updateSplit,
  type Direction,
  type PaneNode,
  type Placement,
} from './components/Workbench/types';
import './App.css';

export default function App() {
  const [root, setRoot] = useState<PaneNode>(() => newLeaf({ title: '终端1' }));
  const [loaded, setLoaded] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [mcpOpen, setMcpOpen] = useState(false);

  // Latest tree for deferred handlers (debounced pwd persist, unload).
  const rootRef = useRef(root);
  const pwdTimerRef = useRef<number | null>(null);
  useEffect(() => {
    rootRef.current = root;
  }, [root]);

  // ---- Close-to-tray vs exit prompt -------------------------------------
  const [closePromptOpen, setClosePromptOpen] = useState(false);
  const [dontAskAgain, setDontAskAgain] = useState(false);
  // In-memory only: remembering a choice lasts for this launch (the webview
  // lives as long as the app) and the prompt returns on the next launch.
  const rememberedCloseAction = useRef<'tray' | 'exit' | null>(null);
  const windowNameRef = useRef('');
  const closeActionRef = useRef<() => void>(() => {});

  const hideToTray = () => {
    setClosePromptOpen(false);
    WindowManager.HideToTray().catch(() => {});
  };

  const quitApp = () => {
    setClosePromptOpen(false);
    WindowManager.QuitApp().catch(() => {});
  };

  const applyCloseAction = () => {
    const remembered = rememberedCloseAction.current;
    if (remembered === 'tray') hideToTray();
    else if (remembered === 'exit') quitApp();
    else {
      setDontAskAgain(false);
      setClosePromptOpen(true);
    }
  };
  closeActionRef.current = applyCloseAction;

  // Native closes (Alt+F4, taskbar "Close window") arrive as a window-scoped
  // event; the frameless close button calls applyCloseAction directly.
  useEffect(() => {
    (async () => {
      try {
        windowNameRef.current = await Window.Name();
      } catch {
        /* browser dev: no window identity */
      }
    })();
    const off = Events.On('window-close-requested', (event: any) => {
      const sender = event?.sender;
      if (windowNameRef.current && sender && sender !== windowNameRef.current) return;
      closeActionRef.current();
    });
    return off;
  }, []);

  // Persist the pane prefs (titles + accents + last working directory). The
  // split layout itself is not persisted yet.
  const persistRoot = (r: PaneNode) => {
    WindowManager.SetTabPrefs(
      flattenLeaves(r).map((l) => ({ title: l.title, accent: l.accent, pwd: l.pwd })),
    ).catch(() => {});
  };

  // Track each session's working directory (term_pwd events) and persist it,
  // debounced so prompt re-renders do not spam config IO.
  useEffect(() => {
    const off = Events.On('term_pwd', (event: any) => {
      const payload = event?.data;
      if (!payload || typeof payload.id !== 'string' || typeof payload.data !== 'string') return;
      const leaf = flattenLeaves(rootRef.current).find((l) => l.sessionId === payload.id);
      if (!leaf || leaf.pwd === payload.data) return;
      setRoot((prev) => updateLeaf(prev, leaf.id, (l) => ({ ...l, pwd: payload.data })));
      if (pwdTimerRef.current) window.clearTimeout(pwdTimerRef.current);
      pwdTimerRef.current = window.setTimeout(() => {
        persistRoot(rootRef.current);
      }, 1500);
    });
    const onUnload = () => persistRoot(rootRef.current);
    window.addEventListener('beforeunload', onUnload);
    return () => {
      off();
      window.removeEventListener('beforeunload', onUnload);
      if (pwdTimerRef.current) window.clearTimeout(pwdTimerRef.current);
    };
  }, []);

  // Restore persisted pane prefs on startup (as a stacked column split).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let prefs: { title: string; accent: string; pwd: string }[] = [];
      try {
        prefs = (await WindowManager.GetTabPrefs()) ?? [];
      } catch {
        /* browser dev or first run */
      }
      if (cancelled) return;
      let next: PaneNode;
      if (prefs.length === 0) {
        next = newLeaf({ title: '终端1' });
      } else {
        const leaves = prefs.map((p, i) =>
          newLeaf({
            title: p.title || `终端${i + 1}`,
            accent: p.accent || DEFAULT_ACCENT,
            pwd: p.pwd || '',
          }),
        );
        next = buildColumn(leaves);
      }
      setRoot(next);
      setActiveId(flattenLeaves(next)[0].id);
      setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSplit = (leafId: string, direction: Direction) => {
    const nextLeaf = newLeaf({ title: `终端${countLeaves(root) + 1}` });
    const next = updateLeaf(root, leafId, (leaf) => makeSplit(direction, leaf, nextLeaf));
    setRoot(next);
    setActiveId(nextLeaf.id);
    persistRoot(next);
  };

  const handleClose = (leafId: string) => {
    if (countLeaves(root) <= 1) return; // keep at least one pane
    const [next] = removeLeaf(root, leafId);
    setRoot(next);
    persistRoot(next);
    if (activeId === leafId) {
      setActiveId(flattenLeaves(next)[0].id);
    }
  };

  const handleReady = (leafId: string, sessionId: string) => {
    setRoot((prev) => updateLeaf(prev, leafId, (l) => ({ ...l, sessionId })));
  };

  const handleRatio = (splitId: string, ratio: number) => {
    setRoot((prev) => updateSplit(prev, splitId, ratio));
  };

  const handleMove = (sourceId: string, targetId: string, placement: Placement) => {
    const next = moveLeaf(root, sourceId, targetId, placement);
    if (next === root) return;
    setRoot(next);
    persistRoot(next);
    setActiveId(sourceId);
  };

  // Esc closes whichever overlay is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMcpOpen(false);
        setClosePromptOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Do not mount terminals until the persisted prefs are known, so no shell is
  // started and immediately torn down during restoration.
  if (!loaded) {
    return <div className="app" />;
  }

  return (
    <div className="app">
      <div className="topbar">
        <div className="brand">
          Pwsh<span className="brand-accent">Deck</span>
        </div>
        <div style={{ flex: 1 }} />
        <button type="button" className="mcp-btn" onClick={() => setMcpOpen(true)}>
          MCP 管理
        </button>
        <div className="window-controls">
          <button
            type="button"
            className="win-btn"
            title="最小化"
            onClick={() => Window.Minimise().catch(() => {})}
          >
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <rect x="0.5" y="4.5" width="9" height="1" fill="currentColor" />
            </svg>
          </button>
          <button
            type="button"
            className="win-btn"
            title="最大化 / 还原"
            onClick={() => Window.ToggleMaximise().catch(() => {})}
          >
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="1" />
            </svg>
          </button>
          <button
            type="button"
            className="win-btn win-btn-close"
            title="关闭"
            onClick={() => closeActionRef.current()}
          >
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <path d="M1 1 L9 9 M9 1 L1 9" stroke="currentColor" strokeWidth="1" />
            </svg>
          </button>
        </div>
      </div>

      <main className="content">
        <Workbench
          node={root}
          activeId={activeId}
          onActivate={setActiveId}
          onSplit={handleSplit}
          onClose={handleClose}
          onReady={handleReady}
          onRatio={handleRatio}
          onMove={handleMove}
        />
      </main>

      {closePromptOpen && (
        <div className="modal-overlay" onClick={() => setClosePromptOpen(false)}>
          <div className="modal close-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h2>关闭窗口</h2>
            </div>
            <div className="close-dialog-body">
              <p className="close-dialog-text">要最小化到系统托盘，还是直接退出？</p>
              <div className="close-dialog-actions">
                <button
                  type="button"
                  className="btn-primary"
                  onClick={() => {
                    if (dontAskAgain) rememberedCloseAction.current = 'tray';
                    hideToTray();
                  }}
                >
                  最小化到系统托盘
                </button>
                <button
                  type="button"
                  className="btn-danger"
                  onClick={() => {
                    if (dontAskAgain) rememberedCloseAction.current = 'exit';
                    quitApp();
                  }}
                >
                  直接退出
                </button>
              </div>
              <label className="close-dialog-remember">
                <input
                  type="checkbox"
                  checked={dontAskAgain}
                  onChange={(e) => setDontAskAgain(e.target.checked)}
                />
                本次启动不再提示
              </label>
            </div>
          </div>
        </div>
      )}

      {mcpOpen && (
        <div className="modal-overlay" onClick={() => setMcpOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h2>MCP 管理</h2>
              <button type="button" className="modal-close" title="关闭" onClick={() => setMcpOpen(false)}>
                ×
              </button>
            </div>
            <div className="modal-body">
              <McpPanel />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
