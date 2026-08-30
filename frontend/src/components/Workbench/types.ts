// Split layout model. The layout is a binary tree whose leaves reference tab
// ids (NOT sessions): tabs live in the tab bar and are always mounted, and the
// layout only decides which tabs are visible and how they are tiled.

export type Direction = 'row' | 'column';
export type Placement = 'left' | 'right' | 'top' | 'bottom';

export interface LeafNode {
  kind: 'leaf';
  tabId: string;
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

export function leaf(tabId: string): LeafNode {
  return { kind: 'leaf', tabId };
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

// removeLeaf deletes the leaf for `tabId` and collapses its parent. Returns
// the new root and whether the tab was found and removed.
export function removeLeaf(root: LayoutNode, tabId: string): [LayoutNode, boolean] {
  if (root.kind === 'leaf') {
    return root.tabId === tabId ? [root, true] : [root, false];
  }
  const [a, ra] = removeLeaf(root.a, tabId);
  if (ra) return [root.b, true];
  const [b, rb] = removeLeaf(root.b, tabId);
  if (rb) return [root.a, true];
  if (a !== root.a || b !== root.b) return [{ ...root, a, b }, false];
  return [root, false];
}

// moveLeaf detaches the source tab and re-attaches it next to the target tab
// at the given placement.
export function moveLeaf(
  root: LayoutNode,
  sourceTabId: string,
  targetTabId: string,
  placement: Placement,
): LayoutNode {
  if (sourceTabId === targetTabId) return root;
  const [pruned, removed] = removeLeaf(root, sourceTabId);
  if (!removed) return root;
  return insertLeaf(pruned, targetTabId, sourceTabId, placement);
}

function insertLeaf(
  root: LayoutNode,
  targetTabId: string,
  sourceTabId: string,
  placement: Placement,
): LayoutNode {
  if (root.kind === 'leaf') {
    if (root.tabId !== targetTabId) return root;
    switch (placement) {
      case 'left':
        return makeSplit('row', leaf(sourceTabId), root);
      case 'right':
        return makeSplit('row', root, leaf(sourceTabId));
      case 'top':
        return makeSplit('column', leaf(sourceTabId), root);
      case 'bottom':
        return makeSplit('column', root, leaf(sourceTabId));
    }
  }
  const a = insertLeaf(root.a, targetTabId, sourceTabId, placement);
  const b = insertLeaf(root.b, targetTabId, sourceTabId, placement);
  if (a === root.a && b === root.b) return root;
  return { ...root, a, b };
}

// addAtEdge splits the whole layout, placing `tabId` on the given edge. If the
// tab is already visible it is first removed, so it ends up moved to the edge.
export function addAtEdge(root: LayoutNode, tabId: string, placement: Placement): LayoutNode {
  let base = root;
  if (containsTab(base, tabId)) {
    base = removeLeaf(base, tabId)[0];
  }
  switch (placement) {
    case 'left':
      return makeSplit('row', leaf(tabId), base);
    case 'right':
      return makeSplit('row', base, leaf(tabId));
    case 'top':
      return makeSplit('column', leaf(tabId), base);
    case 'bottom':
      return makeSplit('column', base, leaf(tabId));
  }
}

export function flattenTabs(root: LayoutNode): string[] {
  if (root.kind === 'leaf') return [root.tabId];
  return [...flattenTabs(root.a), ...flattenTabs(root.b)];
}

export function countLeaves(root: LayoutNode): number {
  if (root.kind === 'leaf') return 1;
  return countLeaves(root.a) + countLeaves(root.b);
}

export function containsTab(root: LayoutNode, tabId: string): boolean {
  if (root.kind === 'leaf') return root.tabId === tabId;
  return containsTab(root.a, tabId) || containsTab(root.b, tabId);
}

// ---- Geometry (absolute positioning keeps all terminals mounted) --------

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number; // fractions of the container (0..1)
}

export interface DividerPos {
  id: string;
  direction: Direction;
  x: number; // boundary centre, fraction
  y: number;
}

export interface LayoutGeometry {
  leaves: { tabId: string; rect: Rect }[];
  dividers: DividerPos[];
}

export function computeLayout(node: LayoutNode, r: Rect): LayoutGeometry {
  if (node.kind === 'leaf') {
    return { leaves: [{ tabId: node.tabId, rect: r }], dividers: [] };
  }
  const leaves: { tabId: string; rect: Rect }[] = [];
  const dividers: DividerPos[] = [];
  if (node.direction === 'row') {
    const aw = r.w * node.ratio;
    const a = computeLayout(node.a, { x: r.x, y: r.y, w: aw, h: r.h });
    const b = computeLayout(node.b, { x: r.x + aw, y: r.y, w: r.w - aw, h: r.h });
    leaves.push(...a.leaves, ...b.leaves);
    dividers.push({ id: node.id, direction: 'row', x: r.x + aw, y: r.y + r.h / 2 }, ...a.dividers, ...b.dividers);
  } else {
    const ah = r.h * node.ratio;
    const a = computeLayout(node.a, { x: r.x, y: r.y, w: r.w, h: ah });
    const b = computeLayout(node.b, { x: r.x, y: r.y + ah, w: r.w, h: r.h - ah });
    leaves.push(...a.leaves, ...b.leaves);
    dividers.push({ id: node.id, direction: 'column', x: r.x + r.w / 2, y: r.y + ah }, ...a.dividers, ...b.dividers);
  }
  return { leaves, dividers };
}
