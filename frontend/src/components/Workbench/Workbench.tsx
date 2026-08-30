import { useRef, useState, type CSSProperties, type DragEvent, type MouseEvent as ReactMouseEvent } from 'react';
import Terminal from '../Terminal';
import type { Direction, PaneLeaf, PaneNode, Placement } from './types';
import './Workbench.css';

interface WorkbenchProps {
  node: PaneNode;
  activeId: string | null;
  onActivate: (id: string) => void;
  onClose: (leafId: string) => void;
  onReady: (leafId: string, sessionId: string) => void;
  onRatio: (splitId: string, ratio: number) => void;
  onMove: (sourceId: string, targetId: string, placement: Placement) => void;
  onMerge: (sourceId: string) => void;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

// Drop preview: either a split on an edge, or a merge in the centre.
type DropPreview =
  | { id: string; placement: Placement }
  | { id: string; merge: true }
  | null;

export default function Workbench({
  node,
  activeId,
  onActivate,
  onClose,
  onReady,
  onRatio,
  onMove,
  onMerge,
}: WorkbenchProps) {
  // The ref mirrors the source id synchronously so the first dragover (before
  // React re-renders) still sees it.
  const [dragSource, setDragSource] = useState<string | null>(null);
  const dragSourceRef = useRef<string | null>(null);
  const [dropPreview, setDropPreview] = useState<DropPreview>(null);

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
      const drop = dropPreview && dropPreview.id === n.id ? dropPreview : null;
      return (
        <Pane
          leaf={n}
          active={n.id === activeId}
          dragging={n.id === dragSource}
          edgeDrop={drop && 'placement' in drop ? drop.placement : null}
          mergeDrop={drop ? 'merge' in drop : false}
          onActivate={onActivate}
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
            setDropPreview(dropKind(e, e.currentTarget, n.id));
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
            const kind = dropKind(e, e.currentTarget, n.id);
            endDrag();
            if ('merge' in kind) onMerge(src);
            else onMove(src, n.id, kind.placement);
          }}
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

  return <>{render(node)}</>;
}

// dropKind maps a drop point to either a split edge (near the border) or a
// merge (in the centre of the pane).
function dropKind(e: DragEvent, el: HTMLElement, id: string): Exclude<DropPreview, null> {
  const rect = el.getBoundingClientRect();
  const rx = (e.clientX - rect.left) / rect.width;
  const ry = (e.clientY - rect.top) / rect.height;
  const dLeft = rx;
  const dRight = 1 - rx;
  const dTop = ry;
  const dBottom = 1 - ry;
  const min = Math.min(dLeft, dRight, dTop, dBottom);
  if (min > 0.28) return { id, merge: true };
  if (min === dLeft) return { id, placement: 'left' };
  if (min === dRight) return { id, placement: 'right' };
  if (min === dTop) return { id, placement: 'top' };
  return { id, placement: 'bottom' };
}

interface PaneProps {
  leaf: PaneLeaf;
  active: boolean;
  dragging: boolean;
  edgeDrop: Placement | null;
  mergeDrop: boolean;
  onActivate: (id: string) => void;
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
  edgeDrop,
  mergeDrop,
  onActivate,
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
      className={`wb-pane ${active ? 'active' : ''} ${dragging ? 'wb-dragging' : ''} ${mergeDrop ? 'wb-merge' : ''}`}
      onMouseDown={() => onActivate(leaf.id)}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div className="wb-pane-head" style={{ '--tab-accent': leaf.accent } as CSSProperties}>
        <span
          className="wb-pane-drag"
          draggable
          title={`拖拽 ${leaf.title} 到其它面板边缘分屏 / 中心合并`}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
        >
          <span className="tab-dot" />
          <span className="wb-pane-title">{leaf.title}</span>
        </span>
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
