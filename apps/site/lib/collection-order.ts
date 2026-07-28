/**
 * Reconciles the site record's saved `collectionOrder` (an array of
 * `rkey`s — the "nav order" the site settings form edits) against the
 * actual current set of collection rkeys: drops any saved rkey for a
 * collection that no longer exists (deleted since the order was last
 * saved) and de-duplicates, then appends any collection not yet present in
 * the saved order (freshly created, or the very first save when
 * `collectionOrder` is empty) at the end, in `allRkeys`' own order.
 */
export function mergeCollectionOrder(order: string[], allRkeys: string[]): string[] {
  const known = new Set(allRkeys);
  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const rkey of order) {
    if (known.has(rkey) && !seen.has(rkey)) {
      deduped.push(rkey);
      seen.add(rkey);
    }
  }
  const missing = allRkeys.filter((rkey) => !seen.has(rkey));
  return [...deduped, ...missing];
}
