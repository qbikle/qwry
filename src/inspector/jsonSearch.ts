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

export interface CapWindowResult {
  /** first rendered child index (inclusive) */
  start: number;
  /** end of the rendered slice (exclusive) */
  end: number;
  /** children hidden above the window */
  before: number;
  /** children hidden below the window */
  after: number;
  /** "prefix" = normal cap from 0; "hit" = window revealed around a ⌘F hit */
  mode: "prefix" | "hit";
}

/** block anchor for a hit-revealed window — stable within a CHILD_CAP block,
 * so stepping between nearby hits doesn't remount the slice */
export const hitBase = (hitIndex: number) => Math.floor(hitIndex / CHILD_CAP) * CHILD_CAP;

/** which children to render. Without a hit (or with one inside the prefix)
 * this is the plain [0, shown) cap. A hit BEYOND the prefix re-windows to a
 * bounded CHILD_CAP slice around the hit — never the whole prefix up to it
 * (revealing hit 40,000 must mount ~CHILD_CAP nodes, not 40,001).
 * prevExtra/nextExtra are transient expander growth of the hit window; they
 * only apply while the cursor stays in the same block, so "show next" during
 * a reveal can't permanently pin a giant window. */
export function capWindow(
  total: number,
  shown: number,
  hitIndex: number | null,
  prevExtra = 0,
  nextExtra = 0,
): CapWindowResult {
  const prefixEnd = Math.min(total, shown);
  if (hitIndex == null || hitIndex < prefixEnd) {
    return { start: 0, end: prefixEnd, before: 0, after: total - prefixEnd, mode: "prefix" };
  }
  const base = hitBase(Math.min(hitIndex, Math.max(0, total - 1)));
  const start = Math.max(0, base - prevExtra);
  const end = Math.min(total, base + CHILD_CAP + nextExtra);
  return { start, end, before: start, after: total - end, mode: "hit" };
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
