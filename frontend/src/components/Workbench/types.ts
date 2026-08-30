// Split layout model. The layout is a binary tree whose leaves reference PANE
// ids. A pane is a group that holds a stack of tabs (one active); tabs live in
// panes, and the layout only decides how panes are tiled.

export type Direction = 'row' | 'column';
export type Placement = 'left' | 'right' | 'top' | 'bottom';

export interface LeafNode {
  kind: 'leaf';
  paneId: string;
}

export interface SplitNode {
  kind: 'split';
  id: string;
  direction: Direction;
  ratio: number;
  a: LayoutNode;
  b: LayoutNode;
}

export type LayoutNode = LeafNode | SplitNode;

let nodeSeq = 0;
const nextId = () => `split-${++nodeSeq}`;

export function leaf(paneId: string): LeafNode {
  return { kind: 'leaf', paneId };
}

export function makeSplit(direction: Direction, a: LayoutNode, b: LayoutNode): SplitNode {
  return { kind: 'split', id: nextId(), direction, ratio: 0.5, a, b };
}

// updateSplit sets the ratio of the split node `id`.
export function updateSplit(root: LayoutNode, id: string, ratio: number): LayoutNode {
  if (root.kind === 'leaf') return root;
  if (root.id === id) return { ...root, ratio };
  const a = updateSplit(root.a, id, ratio);
  const b = updateSplit(root.b, id, ratio);
  if (a === root.a && b === root.b) return root;
  return { ...root, a, b };
}

// removeLeaf deletes the leaf for `paneId` and collapses its parent to the
// remaining child. Callers never remove the last pane, so the root is always a
// split here.
export function removeLeaf(root: LayoutNode, paneId: string): LayoutNode {
  if (root.kind === 'leaf') return root;
  return prune(root, paneId) ?? root;
}

// prune returns null when the subtree is the removed leaf itself, otherwise the
// (possibly collapsed) subtree. A nested split that lost a child is rebuilt,
// NOT discarded — this is what keeps sibling panes intact on merge.
function prune(node: LayoutNode, paneId: string): LayoutNode | null {
  if (node.kind === 'leaf') {
    return node.paneId === paneId ? null : node;
  }
  const a = prune(node.a, paneId);
  if (a === null) return node.b; // a was the removed leaf → collapse to b
  const b = prune(node.b, paneId);
  if (b === null) return node.a; // b was the removed leaf → collapse to a
  if (a !== node.a || b !== node.b) return { ...node, a, b };
  return node;
}

// insertPane inserts a new leaf (newPaneId) adjacent to the target pane at the
// given placement.
export function insertPane(
  root: LayoutNode,
  targetPaneId: string,
  newPaneId: string,
  placement: Placement,
): LayoutNode {
  if (root.kind === 'leaf') {
    if (root.paneId !== targetPaneId) return root;
    switch (placement) {
      case 'left':
        return makeSplit('row', leaf(newPaneId), root);
      case 'right':
        return makeSplit('row', root, leaf(newPaneId));
      case 'top':
        return makeSplit('column', leaf(newPaneId), root);
      case 'bottom':
        return makeSplit('column', root, leaf(newPaneId));
    }
  }
  const a = insertPane(root.a, targetPaneId, newPaneId, placement);
  const b = insertPane(root.b, targetPaneId, newPaneId, placement);
  if (a === root.a && b === root.b) return root;
  return { ...root, a, b };
}

export function flattenPanes(root: LayoutNode): string[] {
  if (root.kind === 'leaf') return [root.paneId];
  return [...flattenPanes(root.a), ...flattenPanes(root.b)];
}

export function countLeaves(root: LayoutNode): number {
  if (root.kind === 'leaf') return 1;
  return countLeaves(root.a) + countLeaves(root.b);
}
