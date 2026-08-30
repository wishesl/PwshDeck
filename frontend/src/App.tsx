import { useEffect, useRef, useState } from 'react';
import { Events, Window } from '@wailsio/runtime';
import { WindowManager } from '../bindings/pwshdeck/internal/window';
import McpPanel from './components/McpPanel';
import TabMenu from './components/TabMenu';
import { DEFAULT_ACCENT } from './components/Terminal';
import Workbench, { type PaneState, type TabView } from './components/Workbench/Workbench';
import { insertPane, leaf, removeLeaf, updateSplit, type LayoutNode, type Placement } from './components/Workbench/types';
import './App.css';

type Tab = {
  id: string;
  title: string;
  accent: string;
  pwd: string;
  sessionId: string | null;
};

type MenuState = { tabId: string; x: number; y: number };

let uid = 0;
const nextTabId = () => `tab-${++uid}`;
let paneSeq = 0;
const nextPaneId = () => `pane-${++paneSeq}`;

export default function App() {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [panes, setPanes] = useState<PaneState[]>([]);
  const [layout, setLayout] = useState<LayoutNode>(leaf(''));
  const [activePaneId, setActivePaneId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [mcpOpen, setMcpOpen] = useState(false);

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

  // Restore persisted tabs into a single pane.
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
      const pane: PaneState = {
        id: nextPaneId(),
        tabIds: restored.map((t) => t.id),
        activeTabId: restored[0].id,
      };
      setTabs(restored);
      setPanes([pane]);
      setLayout(leaf(pane.id));
      setActivePaneId(pane.id);
      setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ---- Tab / pane operations --------------------------------------------
  const findPane = (tabId: string) => panes.find((p) => p.tabIds.includes(tabId));

  const addTab = (paneId: string) => {
    tabSeqRef.current += 1;
    const tab: Tab = {
      id: nextTabId(),
      title: `终端${tabSeqRef.current}`,
      accent: DEFAULT_ACCENT,
      pwd: '',
      sessionId: null,
    };
    const nextTabs = [...tabs, tab];
    setTabs(nextTabs);
    setPanes((prev) =>
      prev.map((p) => (p.id === paneId ? { ...p, tabIds: [...p.tabIds, tab.id], activeTabId: tab.id } : p)),
    );
    setActivePaneId(paneId);
    persistTabs(nextTabs);
  };

  const closeTab = (tabId: string) => {
    if (tabs.length <= 1) return;
    const pane = findPane(tabId);
    if (!pane) return;
    const nextTabs = tabs.filter((t) => t.id !== tabId);
    setTabs(nextTabs);
    persistTabs(nextTabs);

    const remaining = pane.tabIds.filter((id) => id !== tabId);
    if (remaining.length === 0) {
      setPanes((prev) => prev.filter((p) => p.id !== pane.id));
      setLayout((prev) => removeLeaf(prev, pane.id));
      if (activePaneId === pane.id) {
        const other = panes.find((p) => p.id !== pane.id);
        if (other) setActivePaneId(other.id);
      }
    } else {
      setPanes((prev) =>
        prev.map((p) =>
          p.id === pane.id
            ? { ...p, tabIds: remaining, activeTabId: p.activeTabId === tabId ? remaining[0] : p.activeTabId }
            : p,
        ),
      );
    }
  };

  const selectTab = (paneId: string, tabId: string) => {
    setActivePaneId(paneId);
    setPanes((prev) => prev.map((p) => (p.id === paneId ? { ...p, activeTabId: tabId } : p)));
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

  const handleReady = (tabId: string, sessionId: string) => {
    setTabs((prev) => prev.map((t) => (t.id === tabId ? { ...t, sessionId } : t)));
  };

  const handleRatio = (splitId: string, ratio: number) => {
    setLayout((prev) => updateSplit(prev, splitId, ratio));
  };

  const handleSplitTab = (sourceTabId: string, targetPaneId: string, placement: Placement) => {
    const sourcePane = findPane(sourceTabId);
    if (!sourcePane) return;
    if (sourcePane.id === targetPaneId && sourcePane.tabIds.length === 1) return;
    const newPaneId = nextPaneId();
    const newPane: PaneState = { id: newPaneId, tabIds: [sourceTabId], activeTabId: sourceTabId };
    const remaining = sourcePane.tabIds.filter((id) => id !== sourceTabId);

    let nextPanes = panes.map((p) => (p.id === sourcePane.id ? { ...p, tabIds: remaining } : p));
    let nextLayout = insertPane(layout, targetPaneId, newPaneId, placement);
    if (remaining.length === 0) {
      nextPanes = nextPanes.filter((p) => p.id !== sourcePane.id);
      nextLayout = removeLeaf(nextLayout, sourcePane.id);
    }
    nextPanes = [...nextPanes, newPane];
    setPanes(nextPanes);
    setLayout(nextLayout);
    setActivePaneId(newPaneId);
  };

  const handleMoveTab = (sourceTabId: string, targetPaneId: string) => {
    const sourcePane = findPane(sourceTabId);
    if (!sourcePane || sourcePane.id === targetPaneId) return;
    const remaining = sourcePane.tabIds.filter((id) => id !== sourceTabId);
    let nextPanes = panes.map((p) => {
      if (p.id === sourcePane.id) return { ...p, tabIds: remaining };
      if (p.id === targetPaneId) return { ...p, tabIds: [...p.tabIds, sourceTabId], activeTabId: sourceTabId };
      return p;
    });
    let nextLayout = layout;
    if (remaining.length === 0) {
      nextPanes = nextPanes.filter((p) => p.id !== sourcePane.id);
      nextLayout = removeLeaf(layout, sourcePane.id);
    }
    setPanes(nextPanes);
    setLayout(nextLayout);
    setActivePaneId(targetPaneId);
  };

  // Esc closes whichever overlay is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMenu(null);
        setMcpOpen(false);
        setClosePromptOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!loaded) {
    return <div className="app" />;
  }

  const menuTab = menu ? tabs.find((t) => t.id === menu.tabId) : null;
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
          layout={layout}
          panes={panes}
          tabs={tabViews}
          activePaneId={activePaneId}
          onSelectTab={selectTab}
          onAddTab={addTab}
          onCloseTab={closeTab}
          onReady={handleReady}
          onRatio={handleRatio}
          onSplitTab={handleSplitTab}
          onMoveTab={handleMoveTab}
          onTabContextMenu={(tabId, x, y) => setMenu({ tabId, x, y })}
        />
      </main>

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
