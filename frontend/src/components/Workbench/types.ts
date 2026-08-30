// Split-pane layout model. The workbench is a binary tree: leaves are terminal
// panes, split nodes hold exactly two children side-by-side (row) or stacked
// (column). `ratio` is the size share of the first child (0..1).

export type Direction = 'row' | 'column';

export interface PaneLeaf {
  kind: 'leaf';
  id: string;
  title: string;
  accent: string;
  pwd: string;
  sessionId: string | null;
}

export interface PaneSplit {
  kind: 'split';
  id: string;
  direction: Direction;
  ratio: number;
  a: PaneNode;
  b: PaneNode;
}

export type PaneNode = PaneLeaf | PaneSplit;

let nodeSeq = 0;
const nextId = () => `pane-${++nodeSeq}`;

export function newLeaf(partial?: Partial<Omit<PaneLeaf, 'kind' | 'id'>>): PaneLeaf {
  return {
    kind: 'leaf',
    id: nextId(),
    title: partial?.title ?? '终端',
    accent: partial?.accent ?? '#4f8cff',
    pwd: partial?.pwd ?? '',
    sessionId: null,
  };
}

export function makeSplit(direction: Direction, a: PaneNode, b: PaneNode): PaneSplit {
  return { kind: 'split', id: nextId(), direction, ratio: 0.5, a, b };
}

// updateLeaf replaces the leaf `id` with fn(leaf) (which may be a split).
export function updateLeaf(root: PaneNode, id: string, fn: (leaf: PaneLeaf) => PaneNode): PaneNode {
  if (root.kind === 'leaf') {
    return root.id === id ? fn(root) : root;
  }
  const a = updateLeaf(root.a, id, fn);
  const b = updateLeaf(root.b, id, fn);
  if (a === root.a && b === root.b) return root;
  return { ...root, a, b };
}

// updateSplit sets the ratio of the split node `id`.
export function updateSplit(root: PaneNode, id: string, ratio: number): PaneNode {
  if (root.kind === 'leaf') return root;
  if (root.id === id) return { ...root, ratio };
  const a = updateSplit(root.a, id, ratio);
  const b = updateSplit(root.b, id, ratio);
  if (a === root.a && b === root.b) return root;
  return { ...root, a, b };
}

// removeLeaf deletes the leaf `id` and collapses its parent to the remaining
// child. Returns the new root and the removed leaf (or null when absent).
export function removeLeaf(root: PaneNode, id: string): [PaneNode, PaneLeaf | null] {
  if (root.kind === 'leaf') {
    return root.id === id ? [root, root] : [root, null];
  }
  const [a, ra] = removeLeaf(root.a, id);
  if (ra) return [root.b, ra];
  const [b, rb] = removeLeaf(root.b, id);
  if (rb) return [root.a, rb];
  if (a !== root.a || b !== root.b) return [{ ...root, a, b }, null];
  return [root, null];
}

// flattenLeaves lists all leaves in depth-first order (for persistence).
export function flattenLeaves(root: PaneNode): PaneLeaf[] {
  if (root.kind === 'leaf') return [root];
  return [...flattenLeaves(root.a), ...flattenLeaves(root.b)];
}

export function countLeaves(root: PaneNode): number {
  if (root.kind === 'leaf') return 1;
  return countLeaves(root.a) + countLeaves(root.b);
}

// buildColumn folds a list of leaves into a balanced column (stacked) split.
export function buildColumn(leaves: PaneLeaf[]): PaneNode {
  if (leaves.length === 1) return leaves[0];
  const mid = Math.floor(leaves.length / 2);
  return makeSplit('column', buildColumn(leaves.slice(0, mid)), buildColumn(leaves.slice(mid)));
}
