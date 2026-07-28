/**
 * Moves the item at `fromIndex` to `toIndex`, returning a new array (never
 * mutates `items`). Backs both the collection editor's HTML5 drag-reorder of
 * a collection's photographs and the site settings form's up/down reorder
 * of nav order and links — the same "reorder a small ordered list" shape
 * shows up in both, so it's a single generic helper rather than two
 * near-duplicate ones.
 *
 * Out-of-range indices, or a no-op `fromIndex === toIndex`, return `items`
 * unchanged (same array reference) so callers can skip a re-render.
 */
export function moveItem<T>(items: T[], fromIndex: number, toIndex: number): T[] {
  if (fromIndex === toIndex) return items;
  if (fromIndex < 0 || fromIndex >= items.length) return items;
  if (toIndex < 0 || toIndex >= items.length) return items;

  const copy = items.slice();
  const [moved] = copy.splice(fromIndex, 1);
  copy.splice(toIndex, 0, moved as T);
  return copy;
}
