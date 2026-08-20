/** Query-tab grid scroll positions, keyed `tabId:stmtIndex`. The grid is
 * keyed per tab+statement (phantom-row selection class, see ResultsPane), so
 * a tab switch REMOUNTS it and a plain ref dies with the unmount; the map
 * outlives it, same discipline as browseScrollLeft. A fresh run reads from
 * the top: the run-start reset in stores/results.ts drops the tab's entries
 * (this module stays store-free so Grid ↔ results can both import it). */

const queryScroll = new Map<string, { top: number; left: number }>();

/** stale keys accumulate over a long session; entries are two numbers, but
 * an unbounded map is still a leak with a story. FIFO cap, no LRU ceremony. */
const CAP = 200;

export function saveQueryScroll(key: string, top: number, left: number) {
  if (top === 0 && left === 0) {
    queryScroll.delete(key);
    return;
  }
  queryScroll.delete(key);
  queryScroll.set(key, { top, left });
  if (queryScroll.size > CAP) {
    const oldest = queryScroll.keys().next().value;
    if (oldest !== undefined) queryScroll.delete(oldest);
  }
}

export function readQueryScroll(key: string): { top: number; left: number } | undefined {
  return queryScroll.get(key);
}

export function dropTabQueryScroll(tabId: string) {
  const prefix = `${tabId}:`;
  for (const k of queryScroll.keys()) {
    if (k.startsWith(prefix)) queryScroll.delete(k);
  }
}
