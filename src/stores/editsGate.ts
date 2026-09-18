/** What a run must know about staged edits before it replaces a result set:
 * whether a commit is building PK locators against the rows on screen, how
 * many edits are staged on a tab, and the editability maps the swap re-aims
 * the inspected cell by.
 *
 * Own module for sessionFlags.ts's reason, one step further. edits.ts imports
 * results.ts (edits are about a result set, and that direction is the real
 * one), so results.ts could only reach back through `await import("./edits")`
 * — three of them, and each one an await standing between a refresh gesture
 * and its own `execute_stream`. An await there is not a module fetch the
 * wire pays for; it is a yield, and what the queue holds at that moment is
 * React's flush of the skeletons the plan wrote a tick earlier, so the
 * statement left 38 ms after the chord that asked for it (LESSONS 16, E3's
 * own open item: the app answered in the frame and then held the wire for a
 * render). The store registers itself here as it evaluates and every read is
 * synchronous, so a plan that decided everything before its first await can
 * still be checked without taking one.
 *
 * Unregistered means edits.ts has never been imported, which means nothing
 * has ever been staged: the defaults are the truth then, not a guess. */
import type { EditMapSlot } from "./edits";

export interface EditsGate {
  /** a commit is on the wire: one is in flight app-wide at a time */
  committing: () => boolean;
  /** edits staged on this tab, the count the discard prompt names */
  staged: (tabId: string) => number;
  /** the tab's editability maps, as they stand */
  maps: (tabId: string) => Record<number, EditMapSlot>;
}

let gate: EditsGate | null = null;

/** edits.ts's own registration, at its module scope */
export function setEditsGate(next: EditsGate): void {
  gate = next;
}

export const committingNow = (): boolean => gate?.committing() ?? false;
export const stagedOn = (tabId: string): number => gate?.staged(tabId) ?? 0;
export const mapsOn = (tabId: string): Record<number, EditMapSlot> => gate?.maps(tabId) ?? {};
