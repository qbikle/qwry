// Memoized structured-cell parse for the inspector. Parsing + pretty-printing
// a multi-MB jsonb cell on every render (every streamed batch, every raw-mode
// keystroke) burned 100s of ms — cache the result keyed by (cell text, type).
// A small bounded Map LRU, NOT WeakRef (WKWebView GCs WeakRefs aggressively):
// 8 entries covers hopping between a handful of cells without pinning big
// strings' parse trees forever.

import { structuredValue } from "./format";

export interface ParsedCell {
  /** parsed JSON / PG array; undefined when the cell isn't structured */
  structured: unknown;
  /** doc contains a 16+ digit bare number — parse→re-serialize would round it */
  lossyNums: boolean;
  /** pretty-printed JSON; null when not structured or lossy */
  pretty: string | null;
}

interface Entry extends ParsedCell {
  type: string | undefined;
}

export const PARSE_CACHE_CAP = 8;

// a bare number token of 16+ digits exceeds JS float precision — any
// parse→re-serialize path would silently round it (even in untouched
// fields), so tree editing and pretty-printing are disabled for such docs
const LOSSY_NUM_RE = /(?:^|[\s:,[])-?\d{16,}(?:[\s,}\]]|$)/;

const lru = new Map<string, Entry>();

export function parsedCell(value: string, typeName: string | undefined): ParsedCell {
  const hit = lru.get(value);
  if (hit && hit.type === typeName) {
    // refresh recency (Map preserves insertion order)
    lru.delete(value);
    lru.set(value, hit);
    return hit;
  }
  const structured = structuredValue(value, typeName);
  const lossyNums = structured !== undefined && LOSSY_NUM_RE.test(value);
  const pretty =
    structured !== undefined && !lossyNums ? JSON.stringify(structured, null, 2) : null;
  const entry: Entry = { type: typeName, structured, lossyNums, pretty };
  lru.delete(value);
  lru.set(value, entry);
  if (lru.size > PARSE_CACHE_CAP) {
    const oldest = lru.keys().next().value;
    if (oldest !== undefined) lru.delete(oldest);
  }
  return entry;
}

/** test hook — current number of cached entries */
export const parseCacheSize = () => lru.size;
