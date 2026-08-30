import { useRef, useState, type CSSProperties, type DragEvent, type MouseEvent as ReactMouseEvent } from 'react';
import Terminal from '../Terminal';
import type { Direction, LayoutNode, Placement } from './types';
import './Workbench.css';

export interface TabView {
  id: string;
  title: string;
  accent: string;
  pwd: string;
  sessionId: string | null;
}

export interface PaneState {
  id: string;
  tabIds: string[];
  activeTabId: string;
}

interface WorkbenchProps {
  layout: LayoutNode;
  panes: PaneState[];
  tabs: TabView[];
  activePaneId: string | null;
  onSelectTab: (paneId: string, tabId: string) => void;
  onAddTab: (paneId: string) => void;
  onCloseTab: (tabId: string) => void;
  onReady: (tabId: string, sessionId: string) => void;
  onRatio: (splitId: string, ratio: number) => void;
  onSplitTab: (sourceTabId: string, targetPaneId: string, placement: Placement) => void;
  onMoveTab: (sourceTabId: string, targetPaneId: string) => void;
  onTabContextMenu: (tabId: string, x: number, y: number) => void;
}

// Drop preview: split on a pane edge, or merge into a pane's tab bar.
type DropPreview = { paneId: string; placement: Placement } | { paneId: string; merge: true } | null;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export default function Workbench({
  layout,
  panes,
  tabs,
  activePaneId,
  onSelectTab,
  onAddTab,
  onCloseTab,
  onReady,
  onRatio,
  onSplitTab,
  onMoveTab,
  onTabContextMenu,
}: WorkbenchProps) {
  const [dragTabId, setDragTabId] = useState<string | null>(null);
  const dragRef = useRef<string | null>(null);
  const [dropPreview, setDropPreview] = useState<DropPreview>(null);

  const beginDrag = (tabId: string) => {
    dragRef.current = tabId;
    setDragTabId(tabId);
  };
  const endDrag = () => {
    dragRef.current = null;
    setDragTabId(null);
    setDropPreview(null);
  };

  const render = (n: LayoutNode) => {
    if (n.kind === 'leaf') {
      const pane = panes.find((p) => p.id === n.paneId);
      if (!pane) return null;
      const preview = dropPreview && dropPreview.paneId === pane.id ? dropPreview : null;
      return (
        <PaneView
          pane={pane}
          tabs={tabs}
          active={pane.id === activePaneId}
          draggingTabId={dragTabId}
          edgeDrop={preview && 'placement' in preview ? preview.placement : null}
          mergeDrop={preview ? 'merge' in preview : false}
          onSelectTab={onSelectTab}
          onAddTab={onAddTab}
          onCloseTab={onCloseTab}
          onReady={onReady}
          onTabDragStart={(e, tabId) => {
            e.dataTransfer.setData('text/plain', JSON.stringify({ type: 'tab', tabId }));
            e.dataTransfer.effectAllowed = 'move';
            beginDrag(tabId);
          }}
          onTabDragEnd={endDrag}
          onPaneDragOver={(e) => {
            const src = dragRef.current;
            if (!src) return;
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = 'move';
            setDropPreview({ paneId: pane.id, placement: placementFor(e, e.currentTarget) });
          }}
          onPaneDrop={(e) => {
            e.preventDefault();
            e.stopPropagation();
            const src = readTabId(e);
            endDrag();
            if (!src) return;
            onSplitTab(src, pane.id, placementFor(e, e.currentTarget));
          }}
          onTabBarDragOver={(e) => {
            const src = dragRef.current;
            if (!src) return;
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = 'move';
            setDropPreview({ paneId: pane.id, merge: true });
          }}
          onTabBarDrop={(e) => {
            e.preventDefault();
            e.stopPropagation();
            const src = readTabId(e);
            endDrag();
            if (!src) return;
            onMoveTab(src, pane.id);
          }}
          onTabContextMenu={onTabContextMenu}
        />
      );
    }
    return (
      <div className={`wb-split ${n.direction === 'row' ? 'wb-row' : 'wb-col'}`}>
        <div className="wb-child" style={{ flex: `${n.ratio} 1 0%` }}>
          {render(n.a)}
        </div>
        <Divider direction={n.direction} ratio={n.ratio} onDrag={(r) => onRatio(n.id, r)} />
        <div className="wb-child" style={{ flex: `${1 - n.ratio} 1 0%` }}>
          {render(n.b)}
        </div>
      </div>
    );
  };

  return <div className="wb-root">{render(layout)}</div>;
}

function readTabId(e: DragEvent): string | null {
  try {
    const raw = e.dataTransfer.getData('text/plain');
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (p && p.type === 'tab' && typeof p.tabId === 'string') return p.tabId;
  } catch {
    /* not our drag */
  }
  return null;
}

function placementFor(e: DragEvent, el: HTMLElement): Placement {
  const rect = el.getBoundingClientRect();
  const rx = (e.clientX - rect.left) / rect.width;
  const ry = (e.clientY - rect.top) / rect.height;
  const dLeft = rx;
  const dRight = 1 - rx;
  const dTop = ry;
  const dBottom = 1 - ry;
  const min = Math.min(dLeft, dRight, dTop, dBottom);
  if (min === dLeft) return 'left';
  if (min === dRight) return 'right';
  if (min === dTop) return 'top';
  return 'bottom';
}

interface PaneViewProps {
  pane: PaneState;
  tabs: TabView[];
  active: boolean;
  draggingTabId: string | null;
  edgeDrop: Placement | null;
  mergeDrop: boolean;
  onSelectTab: (paneId: string, tabId: string) => void;
  onAddTab: (paneId: string) => void;
  onCloseTab: (tabId: string) => void;
  onReady: (tabId: string, sessionId: string) => void;
  onTabDragStart: (e: DragEvent<HTMLDivElement>, tabId: string) => void;
  onTabDragEnd: () => void;
  onPaneDragOver: (e: DragEvent<HTMLDivElement>) => void;
  onPaneDrop: (e: DragEvent<HTMLDivElement>) => void;
  onTabBarDragOver: (e: DragEvent<HTMLDivElement>) => void;
  onTabBarDrop: (e: DragEvent<HTMLDivElement>) => void;
  onTabContextMenu: (tabId: string, x: number, y: number) => void;
}

function PaneView({
  pane,
  tabs,
  active,
  draggingTabId,
  edgeDrop,
  mergeDrop,
  onSelectTab,
  onAddTab,
  onCloseTab,
  onReady,
  onTabDragStart,
  onTabDragEnd,
  onPaneDragOver,
  onPaneDrop,
  onTabBarDragOver,
  onTabBarDrop,
  onTabContextMenu,
}: PaneViewProps) {
  const paneTabs = pane.tabIds
    .map((id) => tabs.find((t) => t.id === id))
    .filter((t): t is TabView => !!t);

  return (
    <div
      className={`wb-pane ${active ? 'active' : ''}`}
      onMouseDown={() => onSelectTab(pane.id, pane.activeTabId)}
      onDragOver={onPaneDragOver}
      onDrop={onPaneDrop}
    >
      <div
        className={`wb-pane-tabs ${mergeDrop ? 'wb-tabs-merge' : ''}`}
        onDragOver={onTabBarDragOver}
        onDrop={onTabBarDrop}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {paneTabs.map((tab) => {
          const isActive = tab.id === pane.activeTabId;
          return (
            <div
              key={tab.id}
              className={`wb-tab ${isActive ? 'active' : ''} ${draggingTabId === tab.id ? 'dragging' : ''}`}
              style={{ '--tab-accent': tab.accent } as CSSProperties}
              draggable
              onDragStart={(e) => onTabDragStart(e, tab.id)}
              onDragEnd={onTabDragEnd}
              onClick={(e) => {
                e.stopPropagation();
                onSelectTab(pane.id, tab.id);
              }}
              onMouseDown={(e) => e.stopPropagation()}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onTabContextMenu(tab.id, e.clientX, e.clientY);
              }}
              title={tab.title}
            >
              <span className="tab-dot" />
              <span className="wb-tab-title">{tab.title}</span>
              {pane.tabIds.length > 1 && (
                <button
                  type="button"
                  className="wb-tab-close"
                  title="关闭"
                  onClick={(e) => {
                    e.stopPropagation();
                    onCloseTab(tab.id);
                  }}
                >
                  ×
                </button>
              )}
            </div>
          );
        })}
        <button type="button" className="wb-tab-add" title="新建标签" onClick={() => onAddTab(pane.id)}>
          ＋
        </button>
      </div>

      <div className="wb-pane-body">
        {pane.tabIds.map((tabId) => {
          const tab = tabs.find((t) => t.id === tabId);
          if (!tab) return null;
          return (
            <div
              key={tabId}
              className="wb-tab-view"
              style={{ display: tabId === pane.activeTabId ? 'block' : 'none', height: '100%' }}
            >
              <Terminal
                accent={tab.accent}
                active={tabId === pane.activeTabId}
                initialDir={tab.pwd}
                onReady={(sessionId) => onReady(tabId, sessionId)}
              />
            </div>
          );
        })}
      </div>

      {edgeDrop && <div className={`wb-drop-strip wb-drop-${edgeDrop}`} />}
    </div>
  );
}

interface DividerProps {
  direction: Direction;
  ratio: number;
  onDrag: (ratio: number) => void;
}

function Divider({ direction, ratio, onDrag }: DividerProps) {
  const handleDown = (e: ReactMouseEvent) => {
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    const parent = el.parentElement;
    if (!parent) return;
    const rect = parent.getBoundingClientRect();
    const total = direction === 'row' ? rect.width : rect.height;
    const startPos = direction === 'row' ? e.clientX : e.clientY;
    const startRatio = ratio;

    const onMove = (ev: MouseEvent) => {
      const pos = direction === 'row' ? ev.clientX : ev.clientY;
      onDrag(clamp(startRatio + (pos - startPos) / total, 0.08, 0.92));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  return (
    <div
      className={`wb-divider ${direction === 'row' ? 'wb-divider-row' : 'wb-divider-col'}`}
      onMouseDown={handleDown}
    />
  );
}
