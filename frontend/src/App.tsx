import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Window } from '@wailsio/runtime';
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

let uid = 0;
const nextTabId = () => `tab-${++uid}`;

const initialTab: Tab = {
  id: nextTabId(),
  title: '终端1',
  accent: DEFAULT_ACCENT,
  sessionId: null,
};

export default function App() {
  const [tabs, setTabs] = useState<Tab[]>([initialTab]);
  const [activeId, setActiveId] = useState(initialTab.id);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [mcpOpen, setMcpOpen] = useState(false);
  const tabSeqRef = useRef(1);

  const addTab = () => {
    tabSeqRef.current += 1;
    const tab: Tab = {
      id: nextTabId(),
      title: `终端${tabSeqRef.current}`,
      accent: DEFAULT_ACCENT,
      sessionId: null,
    };
    setTabs((prev) => [...prev, tab]);
    setActiveId(tab.id);
  };

  const closeTab = (id: string) => {
    const idx = tabs.findIndex((t) => t.id === id);
    if (idx < 0 || tabs.length <= 1) return; // keep at least one tab
    const next = tabs.filter((t) => t.id !== id);
    setTabs(next);
    if (activeId === id) {
      setActiveId(next[Math.min(idx, next.length - 1)].id);
    }
  };

  const renameTab = (id: string, title: string) => {
    setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, title } : t)));
  };

  const setTabAccent = (id: string, accent: string) => {
    setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, accent } : t)));
  };

  const handleReady = (tabId: string, sessionId: string) => {
    setTabs((prev) => prev.map((t) => (t.id === tabId ? { ...t, sessionId } : t)));
  };

  // Esc closes whichever overlay is open (tab menu or MCP modal).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMenu(null);
        setMcpOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const menuTab = menu ? tabs.find((t) => t.id === menu.tabId) : null;

  return (
    <div className="app">
      <div className="topbar">
        <div className="brand">
          pwsh<span className="brand-accent">-mcp</span>
        </div>
        <div className="tab-bar">
          {tabs.map((tab) => {
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
          <button type="button" className="tab-add" title="新建终端" onClick={addTab}>
            ＋
          </button>
        </div>
        <div className="topbar-spacer" />
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
