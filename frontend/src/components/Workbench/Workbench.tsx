import { useRef, useState, type CSSProperties, type DragEvent, type MouseEvent as ReactMouseEvent } from 'react';
import Terminal from '../Terminal';
import { computeLayout, type Direction, type LayoutNode, type Placement } from './types';
import './Workbench.css';

const TAB_BAR_H = 28;

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

  const geo = computeLayout(layout, { x: 0, y: 0, w: 1, h: 1 });
  const paneRects = new Map(geo.leaves.map((l) => [l.paneId, l.rect]));
  const tabPane = new Map<string, string>();
  for (const pane of panes) {
    for (const tid of pane.tabIds) tabPane.set(tid, pane.id);
  }

  return (
    <div className="wb-root">
      {/* Tab bars (one per pane) */}
      {panes.map((pane) => {
        const rect = paneRects.get(pane.id);
        if (!rect) return null;
        const merge = dropPreview?.paneId === pane.id && 'merge' in dropPreview;
        return (
          <div
            key={pane.id}
            className={`wb-pane-tabs ${pane.id === activePaneId ? 'active' : ''} ${merge ? 'wb-tabs-merge' : ''}`}
            style={{ left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.w * 100}%` }}
            onDragOver={(e) => {
              const src = dragRef.current;
              if (!src) return;
              e.preventDefault();
              e.stopPropagation();
              e.dataTransfer.dropEffect = 'move';
              setDropPreview({ paneId: pane.id, merge: true });
            }}
            onDrop={(e) => {
              e.preventDefault();
              e.stopPropagation();
              const src = readTabId(e);
              endDrag();
              if (src) onMoveTab(src, pane.id);
            }}
          >
            {pane.tabIds.map((tid) => {
              const tab = tabs.find((t) => t.id === tid);
              if (!tab) return null;
              const isActive = tid === pane.activeTabId;
              return (
                <div
                  key={tid}
                  className={`wb-tab ${isActive ? 'active' : ''} ${dragTabId === tid ? 'dragging' : ''}`}
                  style={{ '--tab-accent': tab.accent } as CSSProperties}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData('text/plain', JSON.stringify({ type: 'tab', tabId: tid }));
                    e.dataTransfer.effectAllowed = 'move';
                    beginDrag(tid);
                  }}
                  onDragEnd={endDrag}
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelectTab(pane.id, tid);
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    onTabContextMenu(tid, e.clientX, e.clientY);
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
                        onCloseTab(tid);
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
        );
      })}

      {/* Terminals (all mounted; only the active tab of each pane is shown) */}
      {tabs.map((tab) => {
        const paneId = tabPane.get(tab.id);
        const pane = paneId ? panes.find((p) => p.id === paneId) : undefined;
        const isActive = !!pane && pane.activeTabId === tab.id;
        const rect = isActive && paneId ? paneRects.get(paneId) : undefined;
        const edgeDrop =
          isActive && paneId && dropPreview?.paneId === paneId && 'placement' in dropPreview
            ? dropPreview.placement
            : null;
        return (
          <div
            key={tab.id}
            className={`wb-term-wrap ${isActive && paneId === activePaneId ? 'active' : ''}`}
            style={
              rect
                ? {
                    left: `${rect.x * 100}%`,
                    top: `calc(${rect.y * 100}% + ${TAB_BAR_H}px)`,
                    width: `${rect.w * 100}%`,
                    height: `calc(${rect.h * 100}% - ${TAB_BAR_H}px)`,
                  }
                : { display: 'none' }
            }
            onMouseDown={() => pane && onSelectTab(pane.id, pane.activeTabId)}
            onDragOver={(e) => {
              const src = dragRef.current;
              if (!src || !paneId) return;
              e.preventDefault();
              e.stopPropagation();
              e.dataTransfer.dropEffect = 'move';
              setDropPreview({ paneId, placement: placementFor(e, e.currentTarget) });
            }}
            onDrop={(e) => {
              e.preventDefault();
              e.stopPropagation();
              const src = readTabId(e);
              endDrag();
              if (src && paneId) onSplitTab(src, paneId, placementFor(e, e.currentTarget));
            }}
          >
            <Terminal
              accent={tab.accent}
              active={isActive}
              initialDir={tab.pwd}
              onReady={(sessionId) => onReady(tab.id, sessionId)}
            />
            {edgeDrop && <div className={`wb-drop-strip wb-drop-${edgeDrop}`} />}
          </div>
        );
      })}

      {/* Dividers */}
      {geo.dividers.map((d) => (
        <Divider
          key={d.id}
          direction={d.direction}
          x={d.x}
          y={d.y}
          size={d.size}
          ratio={d.ratio}
          onDrag={(r) => onRatio(d.id, r)}
        />
      ))}
    </div>
  );
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

interface DividerProps {
  direction: Direction;
  x: number;
  y: number;
  size: number;
  ratio: number;
  onDrag: (ratio: number) => void;
}

function Divider({ direction, x, y, size, ratio, onDrag }: DividerProps) {
  const handleDown = (e: ReactMouseEvent) => {
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    const root = el.parentElement;
    if (!root) return;
    const rootRect = root.getBoundingClientRect();
    const total = direction === 'row' ? rootRect.width * size : rootRect.height * size;
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
      style={direction === 'row' ? { left: `${x * 100}%` } : { top: `${y * 100}%` }}
      onMouseDown={handleDown}
    />
  );
}
