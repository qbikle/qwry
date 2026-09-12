// The generated starter pools (AGENT-UX section 1, W2d): one pool per
// connection, keyed to the schema shape it was generated for, and one cursor
// per connection that walks the pool three questions at a time. Both persist,
// so a connection's questions rotate across launches and the model is asked
// once per schema shape, not once per launch.
//
// The pool is a courtesy (src/agent/starterPool.ts): `ensurePool` fires ONE
// generation per connection at a time, a no-op when a pool for the current
// shape exists, and swallows every failure, because the heuristic pool
// (src/ask/starters.ts) stands whenever this store has nothing to say. The
// empty state reads through useStarters (src/ask/useStarters.ts), which is
// where a pool meets the questions already asked.

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { tauriPlatform } from "../agent/platform.tauri";
import { providerFor } from "../agent/providers/index";
import {
  STARTER_POOL_MIN,
  STARTER_POOL_SIZE,
  generateStarters,
  schemaHash,
} from "../agent/starterPool";
import type { ModelChoice } from "./agent";
import type { SchemaSnapshot } from "./schema";

export interface StarterPool {
  /** schemaHash() of the snapshot the pool was generated for */
  schemaHash: string;
  questions: string[];
  /** epoch ms */
  generatedAt: number;
}

interface StartersState {
  /** keyed by profileId */
  pools: Record<string, StarterPool>;
  /** keyed by profileId: where the next triple starts */
  cursors: Record<string, number>;

  /** a pool for this connection's current schema shape, generated if absent:
   * at most one generation in flight per connection, failures silent */
  ensurePool: (profileId: string, snapshot: SchemaSnapshot | undefined, choice: ModelChoice | null) => void;
  /** the empty state was shown: the next show starts three further on */
  advance: (profileId: string) => void;
}

/** The generation seam, agent.ts's `runner` shape: tests stand a scripted
 * generator in here, the store's own logic stays real. */
export const generator = { generateStarters };

/** the cursor wraps here: the least common multiple of 1 through 12, so
 * `cursor % n` stays continuous across the wrap for every pool size a triple
 * can be cut from (a pool never exceeds STARTER_POOL_SIZE) */
export const CURSOR_WRAP = 27_720;
/** how far one show moves the cursor */
export const CURSOR_STEP = 3;

/** Not state: which connections have a generation out right now. */
const inFlight = new Set<string>();

const isPool = (v: unknown): v is StarterPool => {
  if (typeof v !== "object" || v === null) return false;
  const p = v as Record<string, unknown>;
  return (
    typeof p.schemaHash === "string" &&
    Array.isArray(p.questions) &&
    p.questions.every((q) => typeof q === "string") &&
    typeof p.generatedAt === "number"
  );
};

/** a persisted blob may be half-written or from another version: keep only
 * well-formed pools and finite cursors, never throw at hydrate */
function sanitize(persisted: unknown): Pick<StartersState, "pools" | "cursors"> {
  const p = (typeof persisted === "object" && persisted !== null ? persisted : {}) as {
    pools?: unknown;
    cursors?: unknown;
  };
  const pools: Record<string, StarterPool> = {};
  if (typeof p.pools === "object" && p.pools !== null) {
    for (const [id, pool] of Object.entries(p.pools as Record<string, unknown>)) {
      if (isPool(pool)) pools[id] = { ...pool, questions: pool.questions.slice(0, STARTER_POOL_SIZE) };
    }
  }
  const cursors: Record<string, number> = {};
  if (typeof p.cursors === "object" && p.cursors !== null) {
    for (const [id, c] of Object.entries(p.cursors as Record<string, unknown>)) {
      if (typeof c === "number" && Number.isFinite(c)) cursors[id] = ((Math.trunc(c) % CURSOR_WRAP) + CURSOR_WRAP) % CURSOR_WRAP;
    }
  }
  return { pools, cursors };
}

export const useStarterPools = create<StartersState>()(
  persist(
    (set, get) => ({
      pools: {},
      cursors: {},

      ensurePool: (profileId, snapshot, choice) => {
        if (!snapshot || !choice || inFlight.has(profileId)) return;
        const hash = schemaHash(snapshot);
        if (get().pools[profileId]?.schemaHash === hash) return;
        let provider;
        try {
          provider = providerFor(choice, tauriPlatform);
        } catch {
          // a persisted provider id no adapter claims: the heuristics stand
          return;
        }
        inFlight.add(profileId);
        void generator
          .generateStarters({ snapshot, provider, model: choice.model, signal: new AbortController().signal })
          .then((questions) => {
            if (questions.length < STARTER_POOL_MIN) return;
            set((s) => ({
              pools: {
                ...s.pools,
                [profileId]: {
                  schemaHash: hash,
                  questions: questions.slice(0, STARTER_POOL_SIZE),
                  generatedAt: Date.now(),
                },
              },
            }));
          })
          .catch(() => {})
          .finally(() => inFlight.delete(profileId));
      },

      advance: (profileId) =>
        set((s) => ({
          cursors: { ...s.cursors, [profileId]: ((s.cursors[profileId] ?? 0) + CURSOR_STEP) % CURSOR_WRAP },
        })),
    }),
    {
      name: "qwry.starters",
      partialize: (s) => ({ pools: s.pools, cursors: s.cursors }),
      merge: (persisted, current) => ({ ...current, ...sanitize(persisted) }),
    },
  ),
);
