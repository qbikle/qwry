// Shell builder's fixtures for the Ask harness (W2c): the `threads` state.
// The Threads sheet is open over the locked sketch's answered thread; five
// threads of the `staging` connection, the current one first (its row is
// .active), the second row .hot with its delete showing (the integrator's
// post-mount hook, `shellAfterMount`, moves the highlight there with one
// ArrowDown, the way a keyboard user would). Times are laid out relative to
// the clock at load so the column reads `3h ago · yesterday · Sep 2 · Aug 30
// · Aug 28` on any day the frames run (the sketch's rows; the dates shift
// with the calendar, the registers do not).
//
// Wiring (fixtures.ts / AskHarness.tsx / tauriShim.ts / ask-frames.ts are the
// integrator's): add "threads" to HARNESS_STATES; seed useAgent with
// SHELL_THREADS as the profile's threads, SHELL_THREADS[0].id as the active
// thread and the answered exchange under it (exchangeFor("threads") = the
// answer); seed useAsk with `threadsOpen: true`; have the shim's
// agent_thread_list return SHELL_THREAD_ROWS for this state (AskPanel's mount
// calls loadThreads, which would otherwise overwrite the five with the one
// fixture row); call shellAfterMount(state) in the harness's post-mount
// effect before stamping data-harness-ready.

import type { Thread } from "../agent/types";
import type { AgentThread } from "../ipc/types";

export const SHELL_STATES = ["threads"] as const;
export type ShellState = (typeof SHELL_STATES)[number];

const PROFILE_ID = "harness-staging";

/** today's clock, backed off so the first row stays on today's calendar day
 * (`3h ago`; a run in the small hours reads `Nm ago`, still today's register) */
function threeHoursAgo(now: Date): Date {
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 1);
  const t = new Date(now.getTime() - 3 * 3600_000);
  return t > midnight ? t : midnight;
}
const yesterdayNoon = (now: Date) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 12);
const daysAgo = (now: Date, d: number) =>
  new Date(now.getFullYear(), now.getMonth(), now.getDate() - d, 10, 15);

const NOW = new Date();

const TITLES = [
  "How many notification histories were added each month this year?",
  "Which users have the most notification histories?",
  "Wardrobes with more than 50 products",
  "Signups per week this quarter",
  "Notification types sent most in August",
];
const STAMPS = [threeHoursAgo(NOW), yesterdayNoon(NOW), daysAgo(NOW, 3), daysAgo(NOW, 6), daysAgo(NOW, 8)];

/** newest first, the order agent_thread_list returns; the first is the
 * locked sketch's thread (`harness-thread`), so the answered exchange sits
 * behind the sheet */
export const SHELL_THREADS: Thread[] = TITLES.map((title, i) => ({
  id: i === 0 ? "harness-thread" : `harness-thread-${i + 1}`,
  profileId: PROFILE_ID,
  title,
  createdAt: STAMPS[i].toISOString(),
}));

/** the same five as appdb rows, for the shim's agent_thread_list */
export const SHELL_THREAD_ROWS: AgentThread[] = SHELL_THREADS.map((t) => ({
  id: t.id,
  profile_id: t.profileId,
  title: t.title,
  created_at: t.createdAt,
}));

/** after the pane has mounted: one ArrowDown on the sheet's list moves the
 * highlight off the current row onto the second, so the frame shows the
 * .hot row and its revealed delete beside the .active one (the sketch) */
export function shellAfterMount(state: string): void {
  if (state !== "threads") return;
  const list = document.querySelector<HTMLElement>(".threads-list");
  list?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
}
