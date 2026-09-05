// Starters builder's fixtures for the Ask harness (W2d): the empty state's
// rotating starters, both pools.
//
//   starters           a twelve-question generated pool for the harness
//                      connection, cursor 3, so the mount shows the SECOND
//                      triple (indices 3..5) and moves the cursor on to 6
//   starters-fallback  no generated pool: the heuristic twelve over the
//                      fixture schema, cursor 0, the first triple (the three
//                      the `empty` state has always shown)
//
// Both are the configured empty state under the fixture's Claude Code choice:
// `ensurePool` fires on mount and the adapter's side call reaches
// `agent_claude_spawn`, which the shim rejects (no fixture), so the pool falls
// back at once, no frame depends on a shim answer and the seeded pool is the
// one shown.
//
// Wiring (fixtures.ts / AskHarness.tsx / ask-frames.ts are the integrator's):
// add STARTER_STATES to HARNESS_STATES; `exchangeFor` returns null for both
// (no thread, like `empty`); in `seed`, after the agent store, call
// `useStarterPools.setState(startersSeed(state))` for these states, and
// `useStarterPools.setState({ pools: {}, cursors: {} })` for every other, so a
// pool persisted by an earlier harness page never leaks into a frame; the
// empty state must render through useStarters (src/ask/useStarters.ts) for
// the seed to matter. Same conventions as fixtures.ts: the store's own types,
// the harness connection `staging` on `auth_new`, every question in the
// register of the sketch's empty state (plain words, at most twelve, a
// question mark).

import { schemaHash } from "../agent/starterPool";
import type { StarterPool } from "../stores/starters";
import { FIXTURE } from "./fixtures";

export const STARTER_STATES = ["starters", "starters-fallback"] as const;
export type StarterState = (typeof STARTER_STATES)[number];

/** twelve questions a model would write over the fixture schema (users,
 * notification_history, wardrobes, wardrobe_products_v2, sessions); the
 * first three are the locked sketch's empty state, the second triple is the
 * one the `starters` frame shows */
export const STARTER_POOL_QUESTIONS: readonly string[] = [
  "How many users signed up each week this quarter?",
  "Which notification types were sent most in August?",
  "How many wardrobes have more than 50 products?",
  "Which channels have the highest open rate?",
  "How many sessions did each platform see this month?",
  "Which signup sources bring users who build wardrobes?",
  "How many users have never opened a notification?",
  "What share of notifications were opened within a day?",
  "Which users added the most products this year?",
  "How many wardrobes were created each month this year?",
  "Which platform had the most sessions last week?",
  "How many deleted users still receive notifications?",
];

/** the cursor the `starters` state mounts with: the second triple shows */
export const STARTER_CURSOR = 3;

/** the starter pools store's seed for a state */
export function startersSeed(state: StarterState): { pools: Record<string, StarterPool>; cursors: Record<string, number> } {
  const pid = FIXTURE.profile.id;
  if (state === "starters-fallback") return { pools: {}, cursors: { [pid]: 0 } };
  return {
    pools: {
      [pid]: {
        schemaHash: schemaHash(FIXTURE.snapshot),
        questions: [...STARTER_POOL_QUESTIONS],
        generatedAt: Date.parse("2026-09-05T10:00:00Z"),
      },
    },
    cursors: { [pid]: STARTER_CURSOR },
  };
}
