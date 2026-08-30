import { useRef, useState, type CSSProperties, type DragEvent, type MouseEvent as ReactMouseEvent } from 'react';
import Terminal from '../Terminal';
import type { Direction, PaneLeaf, PaneNode, Placement } from './types';
import './Workbench.css';

interface WorkbenchProps {
  node: PaneNode;
  activeId: string | null;
  onActivate: (id: string) => void;
  onSplit: (leafId: string, direction: Direction) => void;
  onClose: (leafId: string) => void;
  onReady: (leafId: string, sessionId: string) => void;
  onRatio: (splitId: string, ratio: number) => void;
  onMove: (sourceId: string, targetId: string, placement: Placement) => void;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export default function Workbench({
  node,
  activeId,
  onActivate,
  onSplit,
  onClose,
  onReady,
  onRatio,
  onMove,
}: WorkbenchProps) {
  // Pane drag state. The ref mirrors the source id synchronously so the very
  // first dragover (before React re-renders) still sees it.
  const [dragSource, setDragSource] = useState<string | null>(null);
  const dragSourceRef = useRef<string | null>(null);
  const [dropPreview, setDropPreview] = useState<{ id: string; placement: Placement } | null>(null);

  const beginDrag = (id: string) => {
    dragSourceRef.current = id;
    setDragSource(id);
  };
  const endDrag = () => {
    dragSourceRef.current = null;
    setDragSource(null);
    setDropPreview(null);
  };

  const render = (n: PaneNode) => {
    if (n.kind === 'leaf') {
      return (
        <Pane
          leaf={n}
          active={n.id === activeId}
          dragging={n.id === dragSource}
          dropPreview={dropPreview && dropPreview.id === n.id ? dropPreview.placement : null}
          onActivate={onActivate}
          onSplit={onSplit}
          onClose={onClose}
          onReady={onReady}
          onDragStart={(e) => {
            e.dataTransfer.setData('text/plain', n.id);
            e.dataTransfer.effectAllowed = 'move';
            beginDrag(n.id);
          }}
          onDragEnd={endDrag}
          onDragOver={(e) => {
            const src = dragSourceRef.current;
            if (!src || src === n.id) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            setDropPreview({ id: n.id, placement: placementFor(e, e.currentTarget) });
          }}
          onDragLeave={(e) => {
            const el = e.currentTarget as HTMLElement;
            const related = e.relatedTarget as Node | null;
            if (!related || !el.contains(related)) setDropPreview(null);
          }}
          onDrop={(e) => {
            e.preventDefault();
            const src = e.dataTransfer.getData('text/plain') || dragSourceRef.current;
            if (!src || src === n.id) return;
            const placement = placementFor(e, e.currentTarget);
            endDrag();
            onMove(src, n.id, placement);
          }}
        />
      );
    }
    return (
      <div className={`wb-split ${n.direction === 'row' ? 'wb-row' : 'wb-col'}`}>
        <div className="wb-child" style={{ flexGrow: n.ratio }}>
          {render(n.a)}
        </div>
        <Divider direction={n.direction} ratio={n.ratio} onDrag={(r) => onRatio(n.id, r)} />
        <div className="wb-child" style={{ flexGrow: 1 - n.ratio }}>
          {render(n.b)}
        </div>
      </div>
    );
  };

  return <>{render(node)}</>;
}

// placementFor maps a drop point to the nearest pane edge.
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

interface PaneProps {
  leaf: PaneLeaf;
  active: boolean;
  dragging: boolean;
  dropPreview: Placement | null;
  onActivate: (id: string) => void;
  onSplit: (leafId: string, direction: Direction) => void;
  onClose: (leafId: string) => void;
  onReady: (leafId: string, sessionId: string) => void;
  onDragStart: (e: DragEvent<HTMLSpanElement>) => void;
  onDragEnd: () => void;
  onDragOver: (e: DragEvent<HTMLDivElement>) => void;
  onDragLeave: (e: DragEvent<HTMLDivElement>) => void;
  onDrop: (e: DragEvent<HTMLDivElement>) => void;
}

function Pane({
  leaf,
  active,
  dragging,
  dropPreview,
  onActivate,
  onSplit,
  onClose,
  onReady,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDragLeave,
  onDrop,
}: PaneProps) {
  return (
    <div
      className={`wb-pane ${active ? 'active' : ''} ${dragging ? 'wb-dragging' : ''}`}
      onMouseDown={() => onActivate(leaf.id)}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div className="wb-pane-head" style={{ '--tab-accent': leaf.accent } as CSSProperties}>
        <span
          className="wb-pane-drag"
          draggable
          title={`拖拽 ${leaf.title} 到其它面板`}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
        >
          <span className="tab-dot" />
          <span className="wb-pane-title">{leaf.title}</span>
        </span>
        <button
          type="button"
          className="wb-btn"
          title="左右分屏"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => onSplit(leaf.id, 'row')}
        >
          ◧
        </button>
        <button
          type="button"
          className="wb-btn"
          title="上下分屏"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => onSplit(leaf.id, 'column')}
        >
          ⬒
        </button>
        <button
          type="button"
          className="wb-btn wb-close"
          title="关闭面板"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => onClose(leaf.id)}
        >
          ×
        </button>
      </div>
      <div className="wb-pane-body">
        <Terminal
          accent={leaf.accent}
          active={active}
          initialDir={leaf.pwd}
          onReady={(sessionId) => onReady(leaf.id, sessionId)}
        />
      </div>
      {dropPreview && <div className={`wb-drop-strip wb-drop-${dropPreview}`} />}
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
