import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Events, Window } from '@wailsio/runtime';
import {
  DockviewReact,
  type DockviewApi,
  type DockviewReadyEvent,
  type IDockviewDefaultTabProps,
  type IDockviewPanelProps,
} from 'dockview-react';
import 'dockview-react/dist/styles/dockview.css';
import { WindowManager } from '../bindings/pwshdeck/internal/window';
import McpPanel from './components/McpPanel';
import TabMenu from './components/TabMenu';
import Terminal, { DEFAULT_ACCENT } from './components/Terminal';
import './App.css';

type Tab = {
  id: string;
  title: string;
  accent: string;
  pwd: string;
  sessionId: string | null;
};

type TerminalParams = { tabId: string; accent: string; pwd: string };

let uid = 0;
const nextTabId = () => `tab-${++uid}`;

export default function App() {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [dockReady, setDockReady] = useState(false);
  const [mcpOpen, setMcpOpen] = useState(false);
  const [tabMenu, setTabMenu] = useState<{ tabId: string; x: number; y: number } | null>(null);
  const [closeConfirm, setCloseConfirm] = useState<{ tabId: string } | null>(null);

  const apiRef = useRef<DockviewApi | null>(null);
  const tabsRef = useRef<Tab[]>(tabs);
  const tabSeqRef = useRef(1);
  const pwdTimerRef = useRef<number | null>(null);
  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);

  // Latest-value refs so the (once-invoked) dockview callbacks never go stale.
  const readyRef = useRef<(tabId: string, sessionId: string) => void>(() => {});
  readyRef.current = (tabId, sessionId) => {
    setTabs((prev) => prev.map((t) => (t.id === tabId ? { ...t, sessionId } : t)));
  };
  const closeTabRef = useRef<(tabId: string) => void>(() => {});
  closeTabRef.current = (tabId) => {
    const next = tabsRef.current.filter((t) => t.id !== tabId);
    if (next.length === tabsRef.current.length) return;
    tabsRef.current = next;
    setTabs(next);
    persistTabsRef.current(next);
  };
  const requestCloseTabRef = useRef<(tabId: string) => void>(() => {});
  requestCloseTabRef.current = (tabId) => setCloseConfirm({ tabId });
  const persistTabsRef = useRef<(list: Tab[]) => void>(() => {});
  persistTabsRef.current = (list) => {
    WindowManager.SetTabPrefs(
      list.map((t) => ({ title: t.title, accent: t.accent, pwd: t.pwd })),
    ).catch(() => {});
  };

  const renameTabRef = useRef<(tabId: string, title: string) => void>(() => {});
  renameTabRef.current = (tabId, title) => {
    const next = tabsRef.current.map((t) => (t.id === tabId ? { ...t, title } : t));
    tabsRef.current = next;
    setTabs(next);
    persistTabsRef.current(next);
    apiRef.current?.getPanel(tabId)?.api.setTitle(title);
  };

  const accentTabRef = useRef<(tabId: string, accent: string) => void>(() => {});
  accentTabRef.current = (tabId, accent) => {
    const next = tabsRef.current.map((t) => (t.id === tabId ? { ...t, accent } : t));
    tabsRef.current = next;
    setTabs(next);
    persistTabsRef.current(next);
    const panel = apiRef.current?.getPanel(tabId);
    if (panel) {
      const p = (panel.params ?? {}) as TerminalParams;
      panel.api.updateParameters({ tabId, accent, pwd: p.pwd });
    }
  };

  // ---- Close-to-tray vs exit prompt -------------------------------------
  const [closePromptOpen, setClosePromptOpen] = useState(false);
  const [dontAskAgain, setDontAskAgain] = useState(false);
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

  useEffect(() => {
    (async () => {
      try {
        windowNameRef.current = await Window.Name();
      } catch {
        /* browser dev */
      }
    })();
    const off = Events.On('window-close-requested', (event: any) => {
      const sender = event?.sender;
      if (windowNameRef.current && sender && sender !== windowNameRef.current) return;
      closeActionRef.current();
    });
    return off;
  }, []);

  // ---- pwd tracking -----------------------------------------------------
  useEffect(() => {
    const off = Events.On('term_pwd', (event: any) => {
      const payload = event?.data;
      if (!payload || typeof payload.id !== 'string' || typeof payload.data !== 'string') return;
      const current = tabsRef.current.find((t) => t.sessionId === payload.id);
      if (!current || current.pwd === payload.data) return;
      setTabs((prev) =>
        prev.map((t) => (t.sessionId === payload.id && t.pwd !== payload.data ? { ...t, pwd: payload.data } : t)),
      );
      if (pwdTimerRef.current) window.clearTimeout(pwdTimerRef.current);
      pwdTimerRef.current = window.setTimeout(() => persistTabsRef.current(tabsRef.current), 1500);
    });
    const onUnload = () => persistTabsRef.current(tabsRef.current);
    window.addEventListener('beforeunload', onUnload);
    return () => {
      off();
      window.removeEventListener('beforeunload', onUnload);
      if (pwdTimerRef.current) window.clearTimeout(pwdTimerRef.current);
    };
  }, []);

  // ---- Restore persisted tabs ------------------------------------------
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
      const restored: Tab[] =
        prefs.length > 0
          ? prefs.map((p, i) => ({
              id: nextTabId(),
              title: p.title || `终端${i + 1}`,
              accent: p.accent || DEFAULT_ACCENT,
              pwd: p.pwd || '',
              sessionId: null,
            }))
          : [{ id: nextTabId(), title: '终端1', accent: DEFAULT_ACCENT, pwd: '', sessionId: null }];
      tabSeqRef.current = restored.length;
      setTabs(restored);
      setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ---- Add dockview panels for tabs ------------------------------------
  useEffect(() => {
    if (!loaded || !dockReady || !apiRef.current) return;
    const api = apiRef.current;
    for (const tab of tabs) {
      if (!api.getPanel(tab.id)) {
        api.addPanel({
          id: tab.id,
          component: 'terminal',
          title: tab.title,
          params: { tabId: tab.id, accent: tab.accent, pwd: tab.pwd } satisfies TerminalParams,
          renderer: 'always',
        });
      }
    }
  }, [loaded, dockReady, tabs]);

  const components = useMemo(
    () => ({
      terminal: (props: IDockviewPanelProps) => {
        const p = (props.params ?? {}) as TerminalParams;
        return (
          <Terminal
            accent={p.accent || DEFAULT_ACCENT}
            active
            initialDir={p.pwd || ''}
            onReady={(sessionId) => readyRef.current(p.tabId, sessionId)}
          />
        );
      },
    }),
    [],
  );

  const defaultTabComponent = useMemo(
    () => (props: IDockviewDefaultTabProps) => {
      const accent = (props.params as { accent?: string } | undefined)?.accent ?? DEFAULT_ACCENT;
      // dockview only re-renders the React tab on `params` changes; a title
      // change fires `onDidTitleChange` instead, so subscribe to keep the label
      // in sync after a rename.
      const [title, setTitle] = useState(props.api.title ?? '');
      useEffect(() => {
        setTitle(props.api.title ?? '');
        const disposable = props.api.onDidTitleChange((event) => setTitle(event.title));
        return () => disposable.dispose();
      }, [props.api]);
      return (
        <div
          className="pd-tab"
          style={{ '--tab-accent': accent } as CSSProperties}
          title={title}
          onContextMenu={(e) => {
            e.preventDefault();
            setTabMenu({ tabId: props.api.id, x: e.clientX, y: e.clientY });
          }}
        >
          <span className="pd-tab-dot" />
          <span className="pd-tab-title">{title}</span>
          <button
            type="button"
            className="pd-tab-close"
            title="关闭"
            onClick={(e) => {
              e.stopPropagation();
              requestCloseTabRef.current(props.api.id);
            }}
          >
            ×
          </button>
        </div>
      );
    },
    [],
  );

  const onReady = (event: DockviewReadyEvent) => {
    apiRef.current = event.api;
    setDockReady(true);
    // A panel "remove" also fires during a move (remove then re-add), so defer
    // and check whether the panel really is gone before treating it as closed.
    event.api.onDidRemovePanel((panel) => {
      window.setTimeout(() => {
        const api = apiRef.current;
        if (api && !api.getPanel(panel.id)) {
          closeTabRef.current(panel.id);
        }
      }, 0);
    });
  };

  const addTab = () => {
    tabSeqRef.current += 1;
    const tab: Tab = {
      id: nextTabId(),
      title: `终端${tabSeqRef.current}`,
      accent: DEFAULT_ACCENT,
      pwd: '',
      sessionId: null,
    };
    const next = [...tabsRef.current, tab];
    tabsRef.current = next;
    setTabs(next);
    persistTabsRef.current(next);
  };

  // Esc closes whichever overlay is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMcpOpen(false);
        setClosePromptOpen(false);
        setTabMenu(null);
        setCloseConfirm(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const menuTab = tabMenu ? tabs.find((t) => t.id === tabMenu.tabId) : null;
  const confirmTab = closeConfirm ? tabs.find((t) => t.id === closeConfirm.tabId) : null;

  return (
    <div className="app">
      <div className="topbar">
        <div className="brand">
          Pwsh<span className="brand-accent">Deck</span>
        </div>
        <div style={{ flex: 1 }} />
        <button type="button" className="new-session-btn" title="新建会话" onClick={addTab}>
          ＋ 新建会话
        </button>
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
        <div style={{ width: '100%', height: '100%' }}>
          <DockviewReact
            className="dockview-theme-abyss"
            onReady={onReady}
            components={components}
            defaultTabComponent={defaultTabComponent}
          />
        </div>
      </main>

      {tabMenu && menuTab && (
        <TabMenu
          x={tabMenu.x}
          y={tabMenu.y}
          title={menuTab.title}
          accent={menuTab.accent}
          onRename={(name) => {
            renameTabRef.current(tabMenu.tabId, name);
            setTabMenu(null);
          }}
          onAccent={(color) => {
            accentTabRef.current(tabMenu.tabId, color);
            setTabMenu(null);
          }}
          onClose={() => setTabMenu(null)}
        />
      )}

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

      {closeConfirm && confirmTab && (
        <div className="modal-overlay" onClick={() => setCloseConfirm(null)}>
          <div className="modal close-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h2>关闭会话</h2>
            </div>
            <div className="close-dialog-body">
              <p className="close-dialog-text">
                确定关闭会话「<strong className="close-dialog-name">{confirmTab.title}</strong>」吗？
                该会话正在运行的进程将被终止。
              </p>
              <div className="close-dialog-actions">
                <button type="button" onClick={() => setCloseConfirm(null)}>
                  取消
                </button>
                <button
                  type="button"
                  className="btn-danger"
                  onClick={() => {
                    apiRef.current?.getPanel(closeConfirm.tabId)?.api.close();
                    setCloseConfirm(null);
                  }}
                >
                  关闭会话
                </button>
              </div>
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
