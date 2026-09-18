// A flight recorder for the canvas's layout and its gestures (D5), DEV only.
//
// Two waves could not reproduce the maintainer's drag and resize bug in the
// harness, and the reason a probe cannot see it is that the thing under
// suspicion is an ORDER: which layout commit landed between which two pointer
// frames, and what the gesture was holding when it did. A harness rebuilds the
// order it was told to rebuild. This records the order the running app really
// had, on his machine, in the tree that shows the bug.
//
// The whole facility is one branch. `import.meta.env.DEV` is a literal Vite
// folds at build time, so in a release bundle `trace` is an empty function, the
// ring is unreachable and the call sites go with the branch that guards them:
// nothing here reaches a person who is not running `tauri dev`, which is the
// only reason a diagnostic this chatty is allowed to exist at all (DESIGN rule
// 11 is about strings on a surface, and this writes to none).
//
// A trace is read by eye, in a diff between a good drop and a bad one, so the
// record is shaped for reading: cells are always {x,y,w,h}, pixels are always
// integers, and every entry carries the two facts that turn out to matter for
// a layout bug and are free to read - whether the window was even visible, and
// where the page was scrolled to.

import type { Cell } from "./grid";

/** what an entry is about. One kind per seam, and the seams are the five
 * places a cell can move plus the write that records it */
export type TraceKind = "measure" | "commit" | "gesture" | "land" | "autoH" | "persist";

/** why a commit happened. `other` is honest rather than lazy: a title rename
 * and a face swap write the document too, and a trace that named them a move
 * would be worse than one that says it does not know */
export type TraceCause =
  | "move"
  | "resize"
  | "reflow"
  | "growTo/autoH"
  | "model"
  | "migrate"
  | "other";

export interface TraceEntry {
  /** ms since the page loaded, at a tenth: a gesture frame is 8ms, so more
   * digits than this are noise in a record meant to be read */
  t: number;
  kind: TraceKind;
  /** the window was hidden: a commit that lands here is the OS's, not a hand's */
  vis: string | null;
  /** `.cv-scroll`'s own top, because a page that scrolls under a drag moves
   * every client coordinate in the record with it */
  scroll: number | null;
  [field: string]: unknown;
}

export interface CanvasTrace {
  /** the ring, oldest first, one JSON object per line */
  dump: () => string;
  clear: () => void;
  readonly size: number;
}

/** entries, not seconds: a gesture writes one per pointer frame, so 2000 holds
 * roughly fifteen seconds of continuous dragging and every commit around it */
const CAP = 2000;

const ring: TraceEntry[] = [];
/** where the next write lands once the ring is full */
let next = 0;

/** the gesture a commit landed under, if a hand was down when it did. This is
 * the question D5 is asking, and the store cannot answer it: the gesture lives
 * in the surface, so the surface says so here and the store reads it */
let held: string | null = null;

/** a pixel in the record is an integer. Half a pixel never explained a bug and
 * it makes two entries that say the same thing look different */
export const ipx = (n: number): number => Math.round(n);

/** the scroller, looked up once and kept: a drag calls this per frame, and a
 * querySelector per frame is a cost a diagnostic has no right to */
let scroller: Element | null = null;

function scrollTop(): number | null {
  if (typeof document === "undefined") return null;
  if (!scroller?.isConnected) scroller = document.querySelector(".cv-scroll");
  return scroller ? ipx((scroller as HTMLElement).scrollTop) : null;
}

/** one entry. A no-op unless this is a dev build, and the flag is read at the
 * call rather than captured at module load so the test can turn it off */
export function trace(kind: TraceKind, fields: Record<string, unknown> = {}): void {
  if (!import.meta.env.DEV) return;
  const entry: TraceEntry = {
    t: Math.round(performance.now() * 10) / 10,
    kind,
    ...fields,
    vis: typeof document === "undefined" ? null : document.visibilityState,
    scroll: scrollTop(),
  };
  if (ring.length < CAP) {
    ring.push(entry);
    return;
  }
  ring[next] = entry;
  next = (next + 1) % CAP;
}

/** a hand went down on this block, or came off one. The id IS the gesture's
 * name: one pointer holds one element, so a commit that names it says exactly
 * which hand it landed under */
export function gestureLive(id: string | null): void {
  if (!import.meta.env.DEV) return;
  held = id;
}

export const gestureId = (): string | null => held;

const sameCell = (a: Cell, b: Cell): boolean =>
  a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;

/** what a commit MOVED: one row per block whose cell is not the cell it had,
 * the block that lost one included. Blocks are taken structurally rather than
 * as the store's own type, because this file must not import the store the
 * store imports it from */
export function cellsMoved(
  was: readonly { id: string; kind: string; cell?: Cell }[] | undefined,
  now: readonly { id: string; kind: string; cell?: Cell }[],
): { id: string; kind: string; before: Cell | null; after: Cell | null }[] {
  const before = new Map((was ?? []).map((b) => [b.id, b]));
  const out: { id: string; kind: string; before: Cell | null; after: Cell | null }[] = [];
  for (const b of now) {
    const had = before.get(b.id);
    before.delete(b.id);
    const from = had?.cell ?? null;
    const to = b.cell ?? null;
    if (from && to && sameCell(from, to)) continue;
    if (!from && !to) continue;
    out.push({ id: b.id, kind: b.kind, before: from, after: to });
  }
  for (const b of before.values()) out.push({ id: b.id, kind: b.kind, before: b.cell ?? null, after: null });
  return out;
}

export function dump(): string {
  const order = ring.length < CAP ? ring : [...ring.slice(next), ...ring.slice(0, next)];
  return order.map((e) => JSON.stringify(e)).join("\n");
}

export function clear(): void {
  ring.length = 0;
  next = 0;
}

export const traceSize = (): number => ring.length;

// the console's own door, for the session where the palette is not where the
// hand is: the dev app answers `__qwryCanvasTrace.dump()` at any moment
if (import.meta.env.DEV && typeof window !== "undefined") {
  (window as unknown as { __qwryCanvasTrace: CanvasTrace }).__qwryCanvasTrace = {
    dump,
    clear,
    get size() {
      return ring.length;
    },
  };
}
