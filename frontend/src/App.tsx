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
import AgentPanel from './components/AgentPanel';
import AgentSettings from './components/AgentSettings/AgentSettings';
import McpPanel from './components/McpPanel';
import SettingsPanel from './components/SettingsPanel/SettingsPanel';
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

const DOCKVIEW_THEME = {
  name: 'PwshDeck',
  className: 'dockview-theme-abyss',
  colorScheme: 'dark',
  tabAnimation: 'default',
  dndTabIndicator: 'line',
} as const;

export default function App() {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [dockReady, setDockReady] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [alwaysOnTop, setAlwaysOnTop] = useState(false);
  const [pinBusy, setPinBusy] = useState(false);
  const [layoutDraggable, setLayoutDraggable] = useState(true);
  const [layoutBusy, setLayoutBusy] = useState(false);
  const [layoutError, setLayoutError] = useState('');
  const [activeTabId, setActiveTabId] = useState('');
  const [dragTabId, setDragTabId] = useState<string | null>(null);
  const [dropTabId, setDropTabId] = useState<string | null>(null);
  const [dropSide, setDropSide] = useState<'before' | 'after' | null>(null);
  const [tabMenu, setTabMenu] = useState<{ tabId: string; x: number; y: number } | null>(null);
  const [closeConfirm, setCloseConfirm] = useState<{ tabId: string } | null>(null);

  const apiRef = useRef<DockviewApi | null>(null);
  const overflowMenuRef = useRef<HTMLDivElement>(null);
  const tabsRef = useRef<Tab[]>(tabs);
  const tabSeqRef = useRef(1);
  const pwdTimerRef = useRef<number | null>(null);
  const layoutRef = useRef<string>('');
  const layoutAppliedRef = useRef(false);
  const restoringRef = useRef(false);
  const layoutTimerRef = useRef<number | null>(null);
  const layoutDraggableRef = useRef(true);
  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);
  useEffect(() => {
    layoutDraggableRef.current = layoutDraggable;
  }, [layoutDraggable]);
  useEffect(() => {
    // Always-on-top is intentionally session-only and starts disabled for each window.
    Window.SetAlwaysOnTop(false).catch(() => {});
  }, []);

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
      list.map((t) => ({ id: t.id, title: t.title, accent: t.accent, pwd: t.pwd })),
    ).catch(() => {});
  };

  // Persist the dockview split layout (arrangement). Serialized on a debounce
  // after any structural change, plus immediately on unload.
  const persistLayoutRef = useRef<() => void>(() => {});
  persistLayoutRef.current = () => {
    const api = apiRef.current;
    if (!api) return;
    WindowManager.SetLayout(layoutDraggableRef.current ? JSON.stringify(api.toJSON()) : '').catch(() => {});
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

  const syncFixedTabOrder = () => {
    if (layoutDraggableRef.current) return;
    const api = apiRef.current;
    if (!api) return;
    const byId = new Map(tabsRef.current.map((tab) => [tab.id, tab]));
    const ordered = api.panels.map((panel) => byId.get(panel.id)).filter((tab): tab is Tab => !!tab);
    if (ordered.length !== tabsRef.current.length || ordered.some((tab, index) => tab.id !== tabsRef.current[index]?.id)) {
      tabsRef.current = ordered;
      setTabs(ordered);
      persistTabsRef.current(ordered);
    }
  };

  const moveFixedTab = (sourceId: string, targetId: string, side: 'before' | 'after') => {
    if (layoutDraggableRef.current || sourceId === targetId) return;
    const api = apiRef.current;
    const source = api?.getPanel(sourceId);
    const target = api?.getPanel(targetId);
    if (!api || !source || !target) return;
    const remaining = api.panels.filter((panel) => panel.id !== sourceId);
    const targetIndex = remaining.findIndex((panel) => panel.id === targetId);
    if (targetIndex < 0) return;
    source.api.moveTo({
      group: target.api.group,
      index: targetIndex + (side === 'after' ? 1 : 0),
    });
    window.setTimeout(syncFixedTabOrder, 0);
  };

  const changeLayoutDraggable = async (draggable: boolean) => {
    setLayoutBusy(true);
    setLayoutError('');
    try {
      let currentWindow = windowNameRef.current;
      if (!currentWindow) {
        try {
          currentWindow = await Window.Name();
        } catch {
          /* browser dev */
        }
      }
      await WindowManager.SetLayoutDraggable(draggable, currentWindow);
      layoutDraggableRef.current = draggable;
      setLayoutDraggable(draggable);
      if (!draggable) {
        const api = apiRef.current;
        const panels = api?.panels ?? [];
        const first = panels[0];
        if (first && api) {
          for (let i = 1; i < panels.length; i += 1) {
            panels[i].api.moveTo({ group: first.api.group, index: i });
          }
        }
        await WindowManager.SetLayout('');
        window.setTimeout(syncFixedTabOrder, 0);
      } else {
        persistLayoutRef.current();
      }
    } catch (err) {
      setLayoutError(String(err));
    } finally {
      setLayoutBusy(false);
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
    const onUnload = () => {
      persistTabsRef.current(tabsRef.current);
      persistLayoutRef.current();
    };
    window.addEventListener('beforeunload', onUnload);
    return () => {
      off();
      window.removeEventListener('beforeunload', onUnload);
      if (pwdTimerRef.current) window.clearTimeout(pwdTimerRef.current);
    };
  }, []);

  // ---- Restore persisted tabs + split layout ----------------------------
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let prefs: { id: string; title: string; accent: string; pwd: string }[] = [];
      let draggable = true;
      try {
        prefs = (await WindowManager.GetTabPrefs()) ?? [];
      } catch {
        /* browser dev or first run */
      }
      try {
        draggable = await WindowManager.GetLayoutDraggable();
      } catch {
        /* browser dev or older backend */
      }
      layoutDraggableRef.current = draggable;
      setLayoutDraggable(draggable);
      let layoutJSON = '';
      try {
        layoutJSON = await WindowManager.GetLayout();
      } catch {
        /* browser dev or first run */
      }
      if (cancelled) return;
      const restored: Tab[] =
        prefs.length > 0
          ? prefs.map((p, i) => ({
              id: p.id || nextTabId(),
              title: p.title || `终端${i + 1}`,
              accent: p.accent || DEFAULT_ACCENT,
              pwd: p.pwd || '',
              sessionId: null,
            }))
          : [{ id: nextTabId(), title: '终端1', accent: DEFAULT_ACCENT, pwd: '', sessionId: null }];
      // Seed the id counter so future tabs never collide with restored ids.
      let maxN = 0;
      for (const t of restored) {
        const m = /^tab-(\d+)$/.exec(t.id);
        if (m) maxN = Math.max(maxN, parseInt(m[1], 10));
      }
      uid = maxN;
      tabSeqRef.current = restored.length;
      layoutRef.current = draggable ? layoutJSON || '' : '';
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
    const addPanel = (tab: Tab, index?: number) => {
      const options = {
        id: tab.id,
        component: 'terminal' as const,
        title: tab.title,
        params: { tabId: tab.id, accent: tab.accent, pwd: tab.pwd } satisfies TerminalParams,
        renderer: 'always' as const,
      };
      if (index !== undefined && api.groups[0]) {
        api.addPanel({ ...options, position: { referenceGroup: api.groups[0], index } });
      } else {
        api.addPanel(options);
      }
    };

    if (!layoutAppliedRef.current) {
      layoutAppliedRef.current = true;
      restoringRef.current = true;
      try {
        // Fixed layout mode deliberately ignores a previous split arrangement;
        // adding panels below keeps every tab in one group.
        if (layoutDraggableRef.current && layoutRef.current) {
          try {
            api.fromJSON(JSON.parse(layoutRef.current));
          } catch {
            /* corrupt layout: fall through to a flat single pane */
          }
        }
        const tabIds = new Set(tabs.map((t) => t.id));
        for (const panel of [...api.panels]) {
          if (!tabIds.has(panel.id)) panel.api.close();
        }
        for (const tab of tabs) {
          const panel = api.getPanel(tab.id);
          if (!panel) {
            addPanel(tab);
          } else {
            if (panel.api.title !== tab.title) panel.api.setTitle(tab.title);
            const p = (panel.params ?? {}) as TerminalParams;
            if (p.accent !== tab.accent || p.pwd !== tab.pwd) {
              panel.api.updateParameters({ tabId: tab.id, accent: tab.accent, pwd: tab.pwd });
            }
          }
        }
      } finally {
        restoringRef.current = false;
        persistLayoutRef.current();
      }
    } else {
      // Later roster changes: just ensure each tab has a panel (e.g. new tab).
      for (const tab of tabs) {
        if (!api.getPanel(tab.id)) addPanel(tab, layoutDraggableRef.current ? undefined : 0);
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
            initialDir={p.pwd || ''}
            onReady={(sessionId) => readyRef.current(p.tabId, sessionId)}
          />
        );
      },
      agent: () => <AgentPanel onOpenSettings={() => setSettingsOpen(true)} />,
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
    // Persist the split arrangement (debounced) after any structural change.
    event.api.onDidLayoutChange(() => {
      if (restoringRef.current) return;
      if (layoutTimerRef.current) window.clearTimeout(layoutTimerRef.current);
      layoutTimerRef.current = window.setTimeout(() => persistLayoutRef.current(), 400);
    });
    event.api.onDidActivePanelChange((event) => {
      setActiveTabId(event.panel?.id ?? '');
    });
    event.api.onDidMovePanel(() => {
      window.setTimeout(syncFixedTabOrder, 0);
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
    const next = layoutDraggableRef.current ? [...tabsRef.current, tab] : [tab, ...tabsRef.current];
    tabsRef.current = next;
    setTabs(next);
    persistTabsRef.current(next);
  };

  const openAgentPanel = () => {
    const api = apiRef.current;
    if (!api) return;
    const existing = api.getPanel('agent');
    if (existing) {
      existing.api.group.model.openPanel(existing);
    } else {
      api.addPanel({ id: 'agent', component: 'agent', title: 'AI 助手', renderer: 'always' });
    }
  };

  useEffect(() => {
    if (!overflowOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && !overflowMenuRef.current?.contains(target)) setOverflowOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [overflowOpen]);

  // Esc closes whichever overlay is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setSettingsOpen(false);
        setOverflowOpen(false);
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
  const selectedTabId = activeTabId || apiRef.current?.activePanel?.id || tabs[0]?.id;

  return (
    <div className="app">
      <div className="topbar">
        <div className="brand">
          Pwsh<span className="brand-accent">Deck</span>
        </div>
        {!layoutDraggable && (
          <div className="topbar-tabs" role="tablist" aria-label="终端标签">
            {tabs.slice(0, 4).map((tab) => (
              <div
                key={tab.id}
                className={`topbar-tab ${tab.id === selectedTabId ? 'active' : ''} ${
                  tab.id === dropTabId && dropSide === 'before' ? 'drop-before' : ''
                } ${tab.id === dropTabId && dropSide === 'after' ? 'drop-after' : ''}`}
                role="tab"
                aria-selected={tab.id === selectedTabId}
                draggable
                onClick={() => {
                  const panel = apiRef.current?.getPanel(tab.id);
                  if (panel) panel.api.group.model.openPanel(panel);
                }}
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = 'move';
                  e.dataTransfer.setData('text/plain', tab.id);
                  setDragTabId(tab.id);
                }}
                onDragOver={(e) => {
                  if (!dragTabId || dragTabId === tab.id) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'move';
                  const rect = e.currentTarget.getBoundingClientRect();
                  const side = e.clientX < rect.left + rect.width / 2 ? 'before' : 'after';
                  setDropTabId(tab.id);
                  setDropSide(side);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  if (dragTabId && dropSide) moveFixedTab(dragTabId, tab.id, dropSide);
                  setDragTabId(null);
                  setDropTabId(null);
                  setDropSide(null);
                }}
                onDragEnd={() => {
                  setDragTabId(null);
                  setDropTabId(null);
                  setDropSide(null);
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setTabMenu({ tabId: tab.id, x: e.clientX, y: e.clientY });
                }}
              >
                <span className="topbar-tab-dot" style={{ background: tab.accent }} />
                <span className="topbar-tab-title">{tab.title}</span>
                <button
                  type="button"
                  className="topbar-tab-close"
                  title="关闭"
                  onClick={(e) => {
                    e.stopPropagation();
                    requestCloseTabRef.current(tab.id);
                  }}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        {!layoutDraggable && tabs.length > 4 && (
          <div className="topbar-menu-wrap" ref={overflowMenuRef}>
            <button
              type="button"
              className={`topbar-more-btn ${overflowOpen ? 'open' : ''}`}
              title="更多终端"
              onClick={() => setOverflowOpen((open) => !open)}
            >
              更多 <span>{tabs.length - 4}</span>
            </button>
            {overflowOpen && (
              <div className="topbar-dropdown topbar-overflow-menu">
                {tabs.slice(4).map((tab) => (
                  <div
                    key={tab.id}
                    className={`topbar-dropdown-item ${tab.id === selectedTabId ? 'active' : ''}`}
                    role="button"
                    tabIndex={0}
                    onClick={() => {
                      const firstId = tabs[0]?.id;
                      if (firstId && firstId !== tab.id) moveFixedTab(tab.id, firstId, 'before');
                      const panel = apiRef.current?.getPanel(tab.id);
                      if (panel) panel.api.group.model.openPanel(panel);
                      setOverflowOpen(false);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        e.currentTarget.click();
                      }
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setTabMenu({ tabId: tab.id, x: e.clientX, y: e.clientY });
                      setOverflowOpen(false);
                    }}
                  >
                    <span className="topbar-tab-dot" style={{ background: tab.accent }} />
                    <span className="topbar-dropdown-title">{tab.title}</span>
                    <button
                      type="button"
                      className="topbar-dropdown-close"
                      title="关闭"
                      aria-label={`关闭 ${tab.title}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        requestCloseTabRef.current(tab.id);
                        setOverflowOpen(false);
                      }}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        <div style={{ flex: 1 }} />
        <button type="button" className="new-session-btn" title="新建会话" onClick={addTab}>
          ＋ 新建会话
        </button>
        <button type="button" className="agent-btn" title="AI 助手" onClick={openAgentPanel}>
          <span className="agent-btn-logo">🤖</span>
          AI 助手
        </button>
        <button type="button" className="settings-btn" title="设置" onClick={() => setSettingsOpen(true)}>
          <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
            <path
              d="M6.9 1.2h2.2l.4 1.5c.4.1.8.3 1.2.5l1.4-.7 1.6 1.6-.7 1.4c.2.4.4.8.5 1.2l1.5.4v2.2l-1.5.4c-.1.4-.3.8-.5 1.2l.7 1.4-1.6 1.6-1.4-.7c-.4.2-.8.4-1.2.5l-.4 1.5H6.9l-.4-1.5c-.4-.1-.8-.3-1.2-.5l-1.4.7-1.6-1.6.7-1.4c-.2-.4-.4-.8-.5-1.2L1 9.3V7.1l1.5-.4c.1-.4.3-.8.5-1.2l-.7-1.4 1.6-1.6 1.4.7c.4-.2.8-.4 1.2-.5l.4-1.5ZM8 6a2.2 2.2 0 1 0 0 4.4A2.2 2.2 0 0 0 8 6Z"
              fill="currentColor"
            />
          </svg>
          <span>设置</span>
        </button>
        <div className="window-controls">
          <button
            type="button"
            className={`win-btn pin-btn ${alwaysOnTop ? 'active' : ''}`}
            title={alwaysOnTop ? '取消钉住' : '钉住'}
            aria-label={alwaysOnTop ? '取消钉住' : '钉住'}
            aria-pressed={alwaysOnTop}
            disabled={pinBusy}
            onClick={async () => {
              const next = !alwaysOnTop;
              setPinBusy(true);
              try {
                await Window.SetAlwaysOnTop(next);
                setAlwaysOnTop(next);
              } catch {
                // Keep the indicator unchanged when the native call fails.
              } finally {
                setPinBusy(false);
              }
            }}
          >
            {alwaysOnTop ? (
              <span className="pin-status-dot visible" />
            ) : (
              <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
                <path
                  d="m10.9 1.8 3.3 3.3-1.2 1.2-1-.3-2.2 2.2 1.1 1.1-.9.9-2.6-1.2-3.1 3.1.8.8-.8.8-1.8-1.8.8-.8.8.8 3.1-3.1-1.2-2.6.9-.9 1.1 1.1 2.2-2.2-.3-1 1.2-1.2Z"
                  fill="currentColor"
                />
                <path d="m8.1 9.7-4.4 4.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
              </svg>
            )}
            <span>{alwaysOnTop ? '已钉住' : '钉住'}</span>
          </button>
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
            className={`dockview-theme-abyss ${!layoutDraggable ? 'dockview-fixed-layout' : ''}`}
            theme={DOCKVIEW_THEME}
            disableDnd={!layoutDraggable}
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

      {settingsOpen && (
        <div className="modal-overlay" onClick={() => setSettingsOpen(false)}>
          <div className="modal settings-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h2>设置</h2>
              <button type="button" className="modal-close" title="关闭" onClick={() => setSettingsOpen(false)}>
                ×
              </button>
            </div>
            <div className="settings-modal-body">
              <SettingsPanel
                draggable={layoutDraggable}
                busy={layoutBusy}
                error={layoutError}
                onChange={changeLayoutDraggable}
              />
              <section className="settings-mcp-section">
                <div className="settings-subhead">
                  <h2>MCP 管理</h2>
                </div>
                <McpPanel />
              </section>
              <section className="settings-mcp-section">
                <div className="settings-subhead">
                  <h2>AI 助手</h2>
                </div>
                <AgentSettings />
              </section>
            </div>
          </div>
        </div>
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

    </div>
  );
}
