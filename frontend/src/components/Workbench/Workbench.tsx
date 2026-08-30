import type { CSSProperties, MouseEvent as ReactMouseEvent } from 'react';
import Terminal from '../Terminal';
import type { Direction, PaneLeaf, PaneNode } from './types';
import './Workbench.css';

interface WorkbenchProps {
  node: PaneNode;
  activeId: string | null;
  onActivate: (id: string) => void;
  onSplit: (leafId: string, direction: Direction) => void;
  onClose: (leafId: string) => void;
  onReady: (leafId: string, sessionId: string) => void;
  onRatio: (splitId: string, ratio: number) => void;
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
}: WorkbenchProps) {
  if (node.kind === 'leaf') {
    return (
      <Pane
        leaf={node}
        active={node.id === activeId}
        onActivate={onActivate}
        onSplit={onSplit}
        onClose={onClose}
        onReady={onReady}
      />
    );
  }

  return (
    <div className={`wb-split ${node.direction === 'row' ? 'wb-row' : 'wb-col'}`}>
      <div className="wb-child" style={{ flexGrow: node.ratio }}>
        <Workbench
          node={node.a}
          activeId={activeId}
          onActivate={onActivate}
          onSplit={onSplit}
          onClose={onClose}
          onReady={onReady}
          onRatio={onRatio}
        />
      </div>
      <Divider direction={node.direction} ratio={node.ratio} onDrag={(r) => onRatio(node.id, r)} />
      <div className="wb-child" style={{ flexGrow: 1 - node.ratio }}>
        <Workbench
          node={node.b}
          activeId={activeId}
          onActivate={onActivate}
          onSplit={onSplit}
          onClose={onClose}
          onReady={onReady}
          onRatio={onRatio}
        />
      </div>
    </div>
  );
}

interface PaneProps {
  leaf: PaneLeaf;
  active: boolean;
  onActivate: (id: string) => void;
  onSplit: (leafId: string, direction: Direction) => void;
  onClose: (leafId: string) => void;
  onReady: (leafId: string, sessionId: string) => void;
}

function Pane({ leaf, active, onActivate, onSplit, onClose, onReady }: PaneProps) {
  return (
    <div className={`wb-pane ${active ? 'active' : ''}`} onMouseDown={() => onActivate(leaf.id)}>
      <div className="wb-pane-head" style={{ '--tab-accent': leaf.accent } as CSSProperties}>
        <span className="tab-dot" />
        <span className="wb-pane-title" title={leaf.title}>
          {leaf.title}
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
