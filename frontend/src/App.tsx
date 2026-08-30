import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Events, Window } from '@wailsio/runtime';
import { WindowManager } from '../bindings/pwshdeck/internal/window';
import McpPanel from './components/McpPanel';
import TabMenu from './components/TabMenu';
import { DEFAULT_ACCENT } from './components/Terminal';
import Workbench, { type TabView } from './components/Workbench/Workbench';
import {
  addAtEdge,
  leaf,
  moveLeaf,
  removeLeaf,
  updateSplit,
  type LayoutNode,
  type Placement,
} from './components/Workbench/types';
import './App.css';

type Tab = {
  id: string;
  title: string;
  accent: string;
  pwd: string;
  sessionId: string | null;
};

type MenuState = { tabId: string; x: number; y: number };

const MAX_VISIBLE_TABS = 5;

let uid = 0;
const nextTabId = () => `tab-${++uid}`;

export default function App() {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [tabsLoaded, setTabsLoaded] = useState(false);
  const [activeId, setActiveId] = useState('');
  const [layout, setLayout] = useState<LayoutNode>(leaf(''));
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [mcpOpen, setMcpOpen] = useState(false);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [overflowPos, setOverflowPos] = useState<{ x: number; y: number } | null>(null);
  const moreBtnRef = useRef<HTMLButtonElement | null>(null);
  const tabSeqRef = useRef(1);
  const tabsRef = useRef<Tab[]>(tabs);
  const pwdTimerRef = useRef<number | null>(null);
  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);

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

  // ---- Persistence ------------------------------------------------------
  const persistTabs = (list: Tab[]) => {
    WindowManager.SetTabPrefs(
      list.map((t) => ({ title: t.title, accent: t.accent, pwd: t.pwd })),
    ).catch(() => {});
  };

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
      pwdTimerRef.current = window.setTimeout(() => persistTabs(tabsRef.current), 1500);
    });
    const onUnload = () => persistTabs(tabsRef.current);
    window.addEventListener('beforeunload', onUnload);
    return () => {
      off();
      window.removeEventListener('beforeunload', onUnload);
      if (pwdTimerRef.current) window.clearTimeout(pwdTimerRef.current);
    };
  }, []);

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
      setActiveId(restored[0].id);
      setLayout(leaf(restored[0].id));
      setTabsLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ---- Tab operations ---------------------------------------------------
  const addTab = () => {
    tabSeqRef.current += 1;
    const tab: Tab = {
      id: nextTabId(),
      title: `终端${tabSeqRef.current}`,
      accent: DEFAULT_ACCENT,
      pwd: '',
      sessionId: null,
    };
    const next = [...tabs, tab];
    setTabs(next);
    setActiveId(tab.id);
    setLayout(leaf(tab.id));
    persistTabs(next);
  };

  const closeTab = (id: string) => {
    if (tabs.length <= 1) return;
    const idx = tabs.findIndex((t) => t.id === id);
    if (idx < 0) return;
    const next = tabs.filter((t) => t.id !== id);
    setTabs(next);
    persistTabs(next);

    const visibleIds = layoutLeafIds(layout);
    if (visibleIds.includes(id)) {
      if (visibleIds.length === 1) {
        // It was the only visible tab: switch to the fallback single view.
        setLayout(leaf(next[Math.min(idx, next.length - 1)].id));
      } else {
        setLayout(removeLeaf(layout, id)[0]);
      }
    }
    if (activeId === id) {
      setActiveId(next[Math.min(idx, next.length - 1)].id);
    }
  };

  const selectTab = (id: string) => {
    setActiveId(id);
    setLayout(leaf(id));
  };

  const renameTab = (id: string, title: string) => {
    const next = tabs.map((t) => (t.id === id ? { ...t, title } : t));
    setTabs(next);
    persistTabs(next);
  };

  const setTabAccent = (id: string, accent: string) => {
    const next = tabs.map((t) => (t.id === id ? { ...t, accent } : t));
    setTabs(next);
    persistTabs(next);
  };

  // ---- Layout operations ------------------------------------------------
  const handleReady = (tabId: string, sessionId: string) => {
    setTabs((prev) => prev.map((t) => (t.id === tabId ? { ...t, sessionId } : t)));
  };

  const handleRatio = (splitId: string, ratio: number) => {
    setLayout((prev) => updateSplit(prev, splitId, ratio));
  };

  const handleSplitAtEdge = (tabId: string, placement: Placement) => {
    setLayout((prev) => addAtEdge(prev, tabId, placement));
    setActiveId(tabId);
  };

  const handleClosePane = (tabId: string) => {
    setLayout((prev) => {
      const next = removeLeaf(prev, tabId)[0];
      return next === prev ? prev : next;
    });
  };

  const handleMovePane = (sourceId: string, targetId: string, placement: Placement) => {
    setLayout((prev) => moveLeaf(prev, sourceId, targetId, placement));
  };

  const handleMergePane = (sourceId: string) => {
    setLayout((prev) => {
      const next = removeLeaf(prev, sourceId)[0];
      return next === prev ? prev : next;
    });
  };

  // Esc closes whichever overlay is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMenu(null);
        setOverflowOpen(false);
        setMcpOpen(false);
        setClosePromptOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // ---- Derived ----------------------------------------------------------
  const visibleTabs = tabs.slice(0, MAX_VISIBLE_TABS);
  const overflowTabs = tabs.slice(MAX_VISIBLE_TABS);
  const menuTab = menu ? tabs.find((t) => t.id === menu.tabId) : null;

  const toggleMore = () => {
    if (!overflowOpen && moreBtnRef.current) {
      const r = moreBtnRef.current.getBoundingClientRect();
      setOverflowPos({
        x: Math.max(4, Math.min(r.left, window.innerWidth - 220)),
        y: Math.max(4, Math.min(r.bottom + 6, window.innerHeight - 240)),
      });
    }
    setOverflowOpen((o) => !o);
  };

  const selectOverflowTab = (id: string) => {
    const tab = tabs.find((t) => t.id === id);
    if (!tab) return;
    setTabs([tab, ...tabs.filter((t) => t.id !== id)]);
    selectTab(id);
    setOverflowOpen(false);
  };

  if (!tabsLoaded) {
    return <div className="app" />;
  }

  const tabViews: TabView[] = tabs.map((t) => ({
    id: t.id,
    title: t.title,
    accent: t.accent,
    pwd: t.pwd,
    sessionId: t.sessionId,
  }));

  return (
    <div className="app">
      <div className="topbar">
        <div className="brand">
          Pwsh<span className="brand-accent">Deck</span>
        </div>
        <div className="tab-bar">
          {visibleTabs.map((tab) => {
            const active = tab.id === activeId;
            return (
              <div
                key={tab.id}
                className={`tab ${active ? 'active' : ''}`}
                style={{ '--tab-accent': tab.accent } as CSSProperties}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData('text/plain', JSON.stringify({ type: 'tab', tabId: tab.id }));
                  e.dataTransfer.effectAllowed = 'move';
                }}
                onClick={() => selectTab(tab.id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenu({ tabId: tab.id, x: e.clientX, y: e.clientY });
                }}
                title={tab.title}
              >
                <span className="tab-dot" />
                <span className="tab-title">{tab.title}</span>
                {tabs.length > 1 && (
                  <button
                    type="button"
                    className="tab-close"
                    title="关闭终端"
                    onClick={(e) => {
                      e.stopPropagation();
                      closeTab(tab.id);
                    }}
                  >
                    ×
                  </button>
                )}
              </div>
            );
          })}
          {overflowTabs.length > 0 && (
            <button
              ref={moreBtnRef}
              type="button"
              className={`tab-more ${overflowOpen ? 'active' : ''}`}
              title={`更多标签（${overflowTabs.length}）`}
              onClick={toggleMore}
            >
              ⋯
            </button>
          )}
          <button type="button" className="tab-add" title="新建终端" onClick={addTab}>
            ＋
          </button>
        </div>
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
          layout={layout}
          tabs={tabViews}
          activeId={activeId}
          onActivate={setActiveId}
          onClosePane={handleClosePane}
          onReady={handleReady}
          onRatio={handleRatio}
          onSplitAtEdge={handleSplitAtEdge}
          onMovePane={handleMovePane}
          onMergePane={handleMergePane}
        />
      </main>

      {overflowOpen && overflowPos && (
        <>
          <div className="tab-more-overlay" onClick={() => setOverflowOpen(false)} />
          <div className="tab-more-menu" style={{ left: overflowPos.x, top: overflowPos.y }}>
            {overflowTabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                className={`tab-more-item ${tab.id === activeId ? 'active' : ''}`}
                style={{ '--tab-accent': tab.accent } as CSSProperties}
                onClick={() => selectOverflowTab(tab.id)}
              >
                <span className="tab-dot" />
                <span className="tab-more-title">{tab.title}</span>
              </button>
            ))}
          </div>
        </>
      )}

      {menu && menuTab && (
        <TabMenu
          x={menu.x}
          y={menu.y}
          title={menuTab.title}
          accent={menuTab.accent}
          onRename={(name) => {
            renameTab(menu.tabId, name);
            setMenu(null);
          }}
          onAccent={(color) => {
            setTabAccent(menu.tabId, color);
            setMenu(null);
          }}
          onClose={() => setMenu(null)}
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

// layoutLeafIds lists the tab ids currently visible in the layout.
function layoutLeafIds(node: LayoutNode): string[] {
  if (node.kind === 'leaf') return [node.tabId];
  return [...layoutLeafIds(node.a), ...layoutLeafIds(node.b)];
}
