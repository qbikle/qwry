// What a connection reached for last (B2 item 1): the `Recent` section of the
// `@` completion, and the recency half of its `Tables` order. One small list
// per connection, newest first, persisted the way the starter pools and the
// model choices are (zustand's own `persist`, sanitized at hydrate): a
// connection's recents come back with it, and a bad or half-written blob
// hydrates to nothing rather than throwing.
//
// A row here is a POINTER, never a copy: a kind and the key that names the
// thing inside its own store (a table by `schema.table`, a saved query and a
// thread and a canvas by id). The name, the row estimate, the type are read
// off the live connection when the row is drawn, so a dropped table or a
// deleted bookmark is simply not a row (LESSONS 5: cached metadata may
// inform, never refuse; DESIGN rule 14: one slot per fact, and this is not
// it). Which is also why there is no timestamp: the ORDER is the recency, and
// nothing in the app prints an age for a completion row.
//
// Three seams fill it, one line each, at the moments a user would call
// "using" something: a table tab opened (stores/tabs), a canvas written to
// (stores/canvas), and the tags a question actually SENT (stores/agent) —
// what was picked from the popover and then asked, not what was typed and
// deleted.

import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { Mention } from "../agent/mentions";

/** The kinds a connection remembers: the `@` ladder's rungs a popover row
 * can stand for. `tab` is never typed and a canvas BLOCK is not offered as a
 * row this wave (B3), so neither is ever remembered. */
export type RecentKind = "table" | "column" | "saved" | "thread" | "canvas";

/** one pointer into the connection's own stores */
export interface Recent {
  kind: RecentKind;
  /** a table `schema.table`, a column `schema.table.column`, everything else
   * the id its own store gives it */
  key: string;
}

/** how many a connection remembers. `Recent` shows at most four; `Tables`
 * reads further down the list for its recency order, and the rest is the
 * headroom that keeps a rename or a reopen from evicting the section */
export const RECENTS_CAP = 24;

interface RecentsState {
  /** keyed by profileId, newest first */
  byProfile: Record<string, Recent[]>;

  /** this connection used this thing just now. A repeat moves it to the
   * front instead of adding a second row */
  touch: (profileId: string | null | undefined, kind: RecentKind, key: string) => void;
  /** every tag one question sent, in the order they were typed (the first
   * stays the most recent) */
  touchMentions: (profileId: string | null | undefined, mentions: readonly Mention[]) => void;
  /** the thing is gone for good (a deleted canvas): a pointer to nothing
   * would offer a row that resolves to nothing */
  forget: (profileId: string | null | undefined, kind: RecentKind, key: string) => void;
  /** a deleted connection's recents die with it */
  drop: (profileId: string) => void;
}

const same = (a: Recent, kind: RecentKind, key: string) => a.kind === kind && a.key === key;

/** The recent a resolved tag stands for, or null for a kind no row can be:
 * a query tab (minted by `Explain with Ask`, never typed) and a canvas block
 * (not offered as a row this wave). */
export function recentOf(m: Mention): Recent | null {
  switch (m.kind) {
    case "table":
      return { kind: "table", key: `${m.ref.schema}.${m.ref.table}` };
    case "column":
      return { kind: "column", key: `${m.ref.schema}.${m.ref.table}.${m.ref.column}` };
    case "saved":
      return { kind: "saved", key: m.ref.id };
    case "thread":
      return { kind: "thread", key: m.ref.id };
    // the ladder's fifth rung carries both a canvas and a block inside one
    // (mentions.ts BlockRef.canvas); only the canvas has a row
    case "block":
      return m.ref.canvas ? { kind: "canvas", key: m.ref.id } : null;
    case "tab":
      return null;
  }
}

const KINDS: readonly RecentKind[] = ["table", "column", "saved", "thread", "canvas"];

const isRecent = (v: unknown): v is Recent => {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return typeof r.key === "string" && r.key.length > 0 && KINDS.includes(r.kind as RecentKind);
};

/** a persisted blob may be half-written or from another version: keep only
 * well-formed pointers, capped, and never throw at hydrate */
function sanitize(persisted: unknown): Pick<RecentsState, "byProfile"> {
  const p = (typeof persisted === "object" && persisted !== null ? persisted : {}) as {
    byProfile?: unknown;
  };
  const byProfile: Record<string, Recent[]> = {};
  if (typeof p.byProfile === "object" && p.byProfile !== null) {
    for (const [id, list] of Object.entries(p.byProfile as Record<string, unknown>)) {
      if (!Array.isArray(list)) continue;
      const kept: Recent[] = [];
      for (const one of list) {
        if (!isRecent(one) || kept.some((k) => same(k, one.kind, one.key))) continue;
        kept.push({ kind: one.kind, key: one.key });
        if (kept.length === RECENTS_CAP) break;
      }
      if (kept.length > 0) byProfile[id] = kept;
    }
  }
  return { byProfile };
}

/** newest first, one row per thing, capped */
const front = (list: readonly Recent[], next: readonly Recent[]): Recent[] => {
  const out = [...next];
  for (const held of list) {
    if (out.some((o) => same(o, held.kind, held.key))) continue;
    out.push(held);
    if (out.length === RECENTS_CAP) break;
  }
  return out.slice(0, RECENTS_CAP);
};

export const useRecents = create<RecentsState>()(
  persist(
    (set) => ({
      byProfile: {},

      touch: (profileId, kind, key) => {
        if (!profileId || !key) return;
        set((s) => ({
          byProfile: { ...s.byProfile, [profileId]: front(s.byProfile[profileId] ?? [], [{ kind, key }]) },
        }));
      },

      touchMentions: (profileId, mentions) => {
        if (!profileId) return;
        const next: Recent[] = [];
        for (const m of mentions) {
          const one = recentOf(m);
          if (one && !next.some((n) => same(n, one.kind, one.key))) next.push(one);
        }
        if (next.length === 0) return;
        set((s) => ({
          byProfile: { ...s.byProfile, [profileId]: front(s.byProfile[profileId] ?? [], next) },
        }));
      },

      forget: (profileId, kind, key) => {
        if (!profileId) return;
        set((s) => {
          const held = s.byProfile[profileId];
          if (!held?.some((h) => same(h, kind, key))) return s;
          return {
            byProfile: { ...s.byProfile, [profileId]: held.filter((h) => !same(h, kind, key)) },
          };
        });
      },

      drop: (profileId) =>
        set((s) => {
          if (!(profileId in s.byProfile)) return s;
          const { [profileId]: _gone, ...rest } = s.byProfile;
          return { byProfile: rest };
        }),
    }),
    {
      name: "qwry.recents",
      partialize: (s) => ({ byProfile: s.byProfile }),
      merge: (persisted, current) => ({ ...current, ...sanitize(persisted) }),
    },
  ),
);
