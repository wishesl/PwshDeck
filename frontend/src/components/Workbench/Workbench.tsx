import { useRef, useState, type CSSProperties, type DragEvent, type MouseEvent as ReactMouseEvent } from 'react';
import Terminal from '../Terminal';
import { computeLayout, type Direction, type LayoutNode, type Placement } from './types';
import './Workbench.css';

export interface TabView {
  id: string;
  title: string;
  accent: string;
  pwd: string;
  sessionId: string | null;
}

interface WorkbenchProps {
  layout: LayoutNode;
  tabs: TabView[];
  activeId: string;
  onActivate: (id: string) => void;
  onClosePane: (tabId: string) => void;
  onReady: (tabId: string, sessionId: string) => void;
  onRatio: (splitId: string, ratio: number) => void;
  onSplitAtEdge: (tabId: string, placement: Placement) => void;
  onMovePane: (sourceId: string, targetId: string, placement: Placement) => void;
  onMergePane: (sourceId: string) => void;
}

type DragPayload = { type: 'tab' | 'pane'; tabId: string };
type DropPreview =
  | { kind: 'root'; placement: Placement }
  | { kind: 'pane'; tabId: string; placement: Placement }
  | { kind: 'merge'; tabId: string }
  | null;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export default function Workbench({
  layout,
  tabs,
  activeId,
  onActivate,
  onClosePane,
  onReady,
  onRatio,
  onSplitAtEdge,
  onMovePane,
  onMergePane,
}: WorkbenchProps) {
  const [dragPayload, setDragPayload] = useState<DragPayload | null>(null);
  const dragRef = useRef<DragPayload | null>(null);
  const [dropPreview, setDropPreview] = useState<DropPreview>(null);

  const beginDrag = (p: DragPayload) => {
    dragRef.current = p;
    setDragPayload(p);
  };
  const endDrag = () => {
    dragRef.current = null;
    setDragPayload(null);
    setDropPreview(null);
  };

  const geo = computeLayout(layout, { x: 0, y: 0, w: 1, h: 1 });

  const rootDragOver = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDropPreview({ kind: 'root', placement: placementFor(e, e.currentTarget) });
  };

  const rootDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const p = readPayload(e);
    endDrag();
    if (!p) return;
    onSplitAtEdge(p.tabId, placementFor(e, e.currentTarget));
  };

  return (
    <div className="wb-root" onDragOver={rootDragOver} onDrop={rootDrop} onDragLeave={rootDragLeave(() => setDropPreview(null))}>
      {tabs.map((tab) => {
        const pos = geo.leaves.find((l) => l.tabId === tab.id);
        const visible = !!pos;
        const isMergeTarget = dropPreview?.kind === 'merge' && dropPreview.tabId === tab.id;
        const edgeDrop =
          dropPreview?.kind === 'pane' && dropPreview.tabId === tab.id ? dropPreview.placement : null;
        return (
          <div
            key={tab.id}
            className={`wb-pane ${tab.id === activeId ? 'active' : ''} ${dragPayload?.tabId === tab.id ? 'wb-dragging' : ''} ${isMergeTarget ? 'wb-merge' : ''}`}
            style={
              visible && pos
                ? { left: `${pos.rect.x * 100}%`, top: `${pos.rect.y * 100}%`, width: `${pos.rect.w * 100}%`, height: `${pos.rect.h * 100}%` }
                : { display: 'none' }
            }
            onMouseDown={() => onActivate(tab.id)}
            onDragOver={(e) => {
              const p = dragRef.current;
              if (!p || p.type !== 'pane' || p.tabId === tab.id) return;
              e.preventDefault();
              e.stopPropagation();
              e.dataTransfer.dropEffect = 'move';
              const placement = placementFor(e, e.currentTarget);
              setDropPreview(nearEdge(e, e.currentTarget) ? { kind: 'pane', tabId: tab.id, placement } : { kind: 'merge', tabId: tab.id });
            }}
            onDrop={(e) => {
              e.preventDefault();
              e.stopPropagation();
              const p = readPayload(e);
              endDrag();
              if (!p || p.type !== 'pane' || p.tabId === tab.id) return;
              const placement = placementFor(e, e.currentTarget);
              if (nearEdge(e, e.currentTarget)) onMovePane(p.tabId, tab.id, placement);
              else onMergePane(p.tabId);
            }}
          >
            <div className="wb-pane-head" style={{ '--tab-accent': tab.accent } as CSSProperties}>
              <span
                className="wb-pane-drag"
                draggable
                title={`拖拽 ${tab.title}`}
                onDragStart={(e) => {
                  e.dataTransfer.setData('text/plain', JSON.stringify({ type: 'pane', tabId: tab.id }));
                  e.dataTransfer.effectAllowed = 'move';
                  beginDrag({ type: 'pane', tabId: tab.id });
                }}
                onDragEnd={endDrag}
              >
                <span className="tab-dot" />
                <span className="wb-pane-title">{tab.title}</span>
              </span>
              {visible && geo.leaves.length > 1 && (
                <button
                  type="button"
                  className="wb-btn wb-close"
                  title="收起此面板（回到标签）"
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={() => onClosePane(tab.id)}
                >
                  ×
                </button>
              )}
            </div>
            <div className="wb-pane-body">
              <Terminal
                accent={tab.accent}
                active={tab.id === activeId}
                initialDir={tab.pwd}
                onReady={(sessionId) => onReady(tab.id, sessionId)}
              />
            </div>
            {edgeDrop && <div className={`wb-drop-strip wb-drop-${edgeDrop}`} />}
          </div>
        );
      })}

      {dropPreview?.kind === 'root' && (
        <div className={`wb-root-strip wb-root-${dropPreview.placement}`} />
      )}

      {geo.dividers.map((d) => {
        // Find the owning split's current ratio.
        const ratio = ratioOf(layout, d.id);
        return (
          <Divider
            key={d.id}
            id={d.id}
            direction={d.direction}
            x={d.x}
            y={d.y}
            ratio={ratio}
            onDrag={(r) => onRatio(d.id, r)}
          />
        );
      })}
    </div>
  );
}

function readPayload(e: DragEvent): DragPayload | null {
  try {
    const raw = e.dataTransfer.getData('text/plain');
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (p && (p.type === 'tab' || p.type === 'pane') && typeof p.tabId === 'string') return p;
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

function nearEdge(e: DragEvent, el: HTMLElement): boolean {
  const rect = el.getBoundingClientRect();
  const rx = (e.clientX - rect.left) / rect.width;
  const ry = (e.clientY - rect.top) / rect.height;
  return Math.min(rx, 1 - rx, ry, 1 - ry) <= 0.28;
}

function ratioOf(node: LayoutNode, id: string): number {
  if (node.kind === 'split') {
    if (node.id === id) return node.ratio;
    return ratioOf(node.a, id) || ratioOf(node.b, id);
  }
  return 0.5;
}

function rootDragLeave(fn: () => void) {
  return (e: DragEvent<HTMLDivElement>) => {
    const el = e.currentTarget as HTMLElement;
    const related = e.relatedTarget as Node | null;
    if (!related || !el.contains(related)) fn();
  };
}

interface DividerProps {
  id: string;
  direction: Direction;
  x: number;
  y: number;
  ratio: number;
  onDrag: (ratio: number) => void;
}

function Divider({ direction, x, y, ratio, onDrag }: DividerProps) {
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
      style={direction === 'row' ? { left: `${x * 100}%` } : { top: `${y * 100}%` }}
      onMouseDown={handleDown}
    />
  );
}
