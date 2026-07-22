/** Sessions whose death the app itself ordered — the terminate tier, user
 * disconnects, profile teardown. An in-flight run on one of these rejects
 * with a connection-closed shape; the results store reads this set to
 * classify that rejection as the cancel it was, never a scary error.
 * Written by connections.ts (every ordered disconnect) and results.ts
 * (terminate tier); consumed + pruned by results.ts when a run settles.
 * Own module: results ↔ connections already import in one direction, and a
 * cycle here would be load-order roulette for the store wiring. */
export const terminatedSessions = new Set<string>();
