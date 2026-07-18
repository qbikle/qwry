// Pure search/cap logic for JsonTree — extracted so it stays testable without
// the component (and so the render layer can't accidentally grow O(n) work).

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type Path = (string | number)[];

/** children rendered per container before the "show next…" expander */
export const CHILD_CAP = 200;
/** nodes the search walk visits before stopping (partial results, flagged) */
export const SEARCH_NODE_CAP = 50_000;

/** stable unique id for a node (used for visibility/refs/hit cursor) */
export const pid = (p: Path) => JSON.stringify(p);

/** how many children to render: at least `shown`, stretched to cover a hit
 * the ⌘F cursor is sitting on (revealing is derived — no state churn) */
export function capWindow(
  total: number,
  shown: number,
  hitIndex: number | null,
): { renderCount: number; remaining: number } {
  const need = hitIndex != null ? hitIndex + 1 : 0;
  const renderCount = Math.min(total, Math.max(shown, need));
  return { renderCount, remaining: total - renderCount };
}

export function isPathPrefix(prefix: Path, full: Path): boolean {
  if (prefix.length >= full.length) return false;
  for (let i = 0; i < prefix.length; i++) if (prefix[i] !== full[i]) return false;
  return true;
}

export interface SearchResult {
  visible: Set<string>;
  forceOpen: Set<string>;
  hits: string[];
  /** the walk stopped at the node cap — matches beyond it are missing */
  capped: boolean;
}

export function computeSearch(json: Json, query: string, nodeCap = SEARCH_NODE_CAP): SearchResult {
  const q = query.toLowerCase();
  const visible = new Set<string>();
  const forceOpen = new Set<string>();
  const hits: string[] = [];
  let visited = 0;
  let capped = false;
  if (!q) return { visible, forceOpen, hits, capped };

  // `forced` = an ancestor key matched, so this whole subtree stays visible
  function walk(value: Json, path: Path, key: string | number | null, forced: boolean): boolean {
    if (visited >= nodeCap) {
      capped = true;
      return false;
    }
    visited++;
    const id = pid(path);
    const keyMatch = key !== null && String(key).toLowerCase().includes(q);
    const isObj = value !== null && typeof value === "object";

    if (keyMatch) hits.push(id);

    let childMatch = false;
    if (isObj) {
      const entries = Array.isArray(value)
        ? value.map((v, i) => [i, v] as const)
        : Object.entries(value as Record<string, Json>);
      for (const [ck, cv] of entries) {
        if (walk(cv as Json, [...path, ck], ck, forced || keyMatch)) childMatch = true;
        if (capped) break;
      }
    }

    let valMatch = false;
    if (!isObj) {
      const s = value === null ? "null" : String(value);
      valMatch = s.toLowerCase().includes(q);
      if (valMatch && !keyMatch) hits.push(id);
    }

    const selfMatch = keyMatch || valMatch;
    if (forced || selfMatch || childMatch) {
      visible.add(id);
      // open this container if a descendant matched, or to reveal a matched
      // key's own subtree
      if (isObj && (childMatch || keyMatch || forced)) forceOpen.add(id);
      return true;
    }
    return false;
  }
  walk(json, [], null, false);
  return { visible, forceOpen, hits, capped };
}
