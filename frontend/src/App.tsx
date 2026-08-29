import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Window } from '@wailsio/runtime';
import { WindowManager } from '../bindings/pwsh-mcp/internal/window';
import Terminal, { DEFAULT_ACCENT } from './components/Terminal';
import McpPanel from './components/McpPanel';
import TabMenu from './components/TabMenu';
import './App.css';

type Tab = {
  id: string;
  title: string;
  accent: string;
  sessionId: string | null;
};

type MenuState = {
  tabId: string;
  x: number;
  y: number;
};

/** How many tabs stay visible in the tab strip; the rest live in the ⋯ menu. */
const MAX_VISIBLE_TABS = 5;

let uid = 0;
const nextTabId = () => `tab-${++uid}`;

const initialTab: Tab = {
  id: nextTabId(),
  title: '终端1',
  accent: DEFAULT_ACCENT,
  sessionId: null,
};

export default function App() {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [tabsLoaded, setTabsLoaded] = useState(false);
  const [activeId, setActiveId] = useState('');
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [mcpOpen, setMcpOpen] = useState(false);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [overflowPos, setOverflowPos] = useState<{ x: number; y: number } | null>(null);
  const moreBtnRef = useRef<HTMLButtonElement | null>(null);
  const tabSeqRef = useRef(1);

  // Persist the tab layout (titles + accent colors; sessions are not restored).
  const persistTabs = (list: Tab[]) => {
    WindowManager.SetTabPrefs(
      list.map((t) => ({ title: t.title, accent: t.accent })),
    ).catch(() => {});
  };

  // Restore the persisted tab layout on startup.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let prefs: { title: string; accent: string }[] = [];
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
              sessionId: null,
            }))
          : [initialTab];
      tabSeqRef.current = restored.length;
      setTabs(restored);
      setActiveId(restored[0].id);
      setTabsLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const addTab = () => {
    tabSeqRef.current += 1;
    const tab: Tab = {
      id: nextTabId(),
      title: `终端${tabSeqRef.current}`,
      accent: DEFAULT_ACCENT,
      sessionId: null,
    };
    const next = [...tabs, tab];
    setTabs(next);
    setActiveId(tab.id);
    persistTabs(next);
  };

  const closeTab = (id: string) => {
    const idx = tabs.findIndex((t) => t.id === id);
    if (idx < 0 || tabs.length <= 1) return; // keep at least one tab
    const next = tabs.filter((t) => t.id !== id);
    setTabs(next);
    persistTabs(next);
    if (activeId === id) {
      setActiveId(next[Math.min(idx, next.length - 1)].id);
    }
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

  // First MAX_VISIBLE_TABS tabs are shown in the strip; the rest are reachable
  // through the ⋯ dropdown.
  const visibleTabs = tabs.slice(0, MAX_VISIBLE_TABS);
  const overflowTabs = tabs.slice(MAX_VISIBLE_TABS);

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

  // Selecting an overflow tab moves it to the first position and activates it.
  const selectOverflowTab = (id: string) => {
    const tab = tabs.find((t) => t.id === id);
    if (!tab) return;
    const next = [tab, ...tabs.filter((t) => t.id !== id)];
    setTabs(next);
    setActiveId(id);
    persistTabs(next);
    setOverflowOpen(false);
  };

  const handleReady = (tabId: string, sessionId: string) => {
    setTabs((prev) => prev.map((t) => (t.id === tabId ? { ...t, sessionId } : t)));
  };

  // Esc closes whichever overlay is open (tab menu, overflow menu or MCP modal).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMenu(null);
        setOverflowOpen(false);
        setMcpOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const menuTab = menu ? tabs.find((t) => t.id === menu.tabId) : null;

  // Do not mount terminals until the persisted tab layout is known, so no
  // shell is started and immediately torn down during restoration.
  if (!tabsLoaded) {
    return <div className="app" />;
  }

  return (
    <div className="app">
      <div className="topbar">
        <div className="brand">
          pwsh<span className="brand-accent">-mcp</span>
        </div>
        <div className="tab-bar">
          {visibleTabs.map((tab) => {
            const active = tab.id === activeId;
            return (
              <div
                key={tab.id}
                className={`tab ${active ? 'active' : ''}`}
                style={{ '--tab-accent': tab.accent } as CSSProperties}
                onClick={() => setActiveId(tab.id)}
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
            onClick={() => Window.Close().catch(() => {})}
          >
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <path d="M1 1 L9 9 M9 1 L1 9" stroke="currentColor" strokeWidth="1" />
            </svg>
          </button>
        </div>
      </div>

      <main className="content">
        {tabs.map((tab) => (
          <div key={tab.id} className={`terminal-page ${tab.id === activeId ? 'active' : ''}`}>
            <Terminal
              accent={tab.accent}
              active={tab.id === activeId}
              onReady={(sid) => handleReady(tab.id, sid)}
            />
          </div>
        ))}
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
