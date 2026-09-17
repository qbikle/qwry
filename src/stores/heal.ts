/** Self-heal triggers. The mechanics (probe → targeted teardown → gentle
 * reconnect) live in connections.healProfile; this module only decides WHEN:
 * wake from sleep, window refocus, or a session death event. ACTIVE profile
 * only — waking with three bastion profiles must not fire three simultaneous
 * handshakes; the others rebuild lazily on first touch (ensureTabSession
 * already reconnects transparently, and the spare pool makes it instant).
 * Loaded for its side effects from App. */
import { listen } from "@tauri-apps/api/event";
import { isHealArmed, useConnections } from "./connections";
import { useRefreshFx } from "./refreshFx";

const BACKOFF_MS = [2_000, 5_000, 15_000, 30_000];
const attempts = new Map<string, number>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const retryAt = new Map<string, number>();

function clearRetry(profileId: string) {
  const t = timers.get(profileId);
  if (t !== undefined) clearTimeout(t);
  timers.delete(profileId);
  attempts.delete(profileId);
  retryAt.delete(profileId);
}

/** when the next retry fires, for the strip that counts it down (E2 R6);
 * null when nothing is scheduled */
export function nextRetryAt(profileId: string): number | null {
  return retryAt.get(profileId) ?? null;
}

/** kick a heal now; resets the backoff (a fresh death signal, not a retry).
 * manual = the user asked, which today is only ⇧⌘R's hardRefresh: the db
 * glyph acks the gesture and reports the verdict, and the caller awaits the
 * verdict to decide whether any surface refetches. Background triggers stay
 * visually silent unless they actually rebuilt something. */
export function requestHeal(profileId: string, manual = false): Promise<boolean> {
  clearRetry(profileId);
  return run(profileId, manual);
}

async function run(profileId: string, manual = false): Promise<boolean> {
  const c = useConnections.getState();
  // armed = the user connected and never manually disconnected since; heal
  // must never resurrect a connection the user chose to close
  if (!isHealArmed(profileId) || c.activeProfileId !== profileId) {
    clearRetry(profileId);
    return false;
  }
  const fx = useRefreshFx.getState();
  if (manual) fx.begin(profileId);
  // a rejection is a failed verdict, not an abandonment: the fx must always
  // resolve (split discs never wedge) and the backoff chain must keep going
  let ok = false;
  let rebuilt = false;
  try {
    ({ ok, rebuilt } = await c.healProfile(profileId));
  } catch {
    /* verdict stays failed */
  }
  const after = useConnections.getState();
  const stillHere = isHealArmed(profileId) && after.activeProfileId === profileId;
  const held = ok && stillHere;
  if (manual) fx.resolve(profileId);
  else if (held && rebuilt) fx.autoClap(profileId);
  // a hard refresh whose own heal failed is waiting on this chain: the retry
  // that lands is what cycles its surfaces (E2 R6). Dynamic, because refresh
  // imports this module for the chord's own path
  void import("./refresh").then(({ healSettled }) => healSettled(profileId, held));
  if (ok || !stillHere) {
    clearRetry(profileId);
    return held;
  }
  // keep retrying while the app is open: the café case is "wifi lands a
  // minute later". Capped backoff, quiet — the amber/red dot is the story.
  const n = attempts.get(profileId) ?? 0;
  attempts.set(profileId, n + 1);
  // two triggers joining ONE heal pass both land here: replace, never stack
  // (a map overwrite would leak the first timer as a duplicate retry chain)
  const prev = timers.get(profileId);
  if (prev !== undefined) clearTimeout(prev);
  const delay = BACKOFF_MS[Math.min(n, BACKOFF_MS.length - 1)];
  const t = setTimeout(() => {
    timers.delete(profileId);
    retryAt.delete(profileId);
    void run(profileId);
  }, delay);
  timers.set(profileId, t);
  retryAt.set(profileId, Date.now() + delay);
  return false;
}

/** probe-and-heal the active profile (cheap no-op when everything is alive) */
function probeActive() {
  const id = useConnections.getState().activeProfileId;
  if (id && isHealArmed(id)) void requestHeal(id);
}

// wake detection: a 30s tick that arrives very late means the machine slept
// (timers don't run under a shut lid) and the network died with it
let lastTick = Date.now();
let lastProbe = 0;
setInterval(() => {
  const now = Date.now();
  const slept = now - lastTick > 90_000;
  lastTick = now;
  if (slept) {
    lastProbe = now;
    probeActive();
  }
}, 30_000);

// refocus after time away: same probe, debounced — bastion round trips are
// not free, and a focus flurry must not become a probe flurry
window.addEventListener("focus", () => {
  const now = Date.now();
  if (now - lastProbe < 60_000) return;
  lastProbe = now;
  probeActive();
});

// a held session died (tunnel drop, server kill): heal immediately, so by
// the time the user looks over, the dot is already amber → green. App's own
// listener runs markDisconnected; healProfile's probe-first pass is
// idempotent against whichever order the two listeners fire in.
// The catch is not decoration: outside Tauri's bridge this rejects, and an
// unhandled rejection at module scope takes down every suite that reaches
// this store through a surface (E2: the refresh store, and so every component
// that reads whether it is cycling). It goes where it always went, the
// console, rather than nowhere (LESSONS 9).
void listen<{ profile_id: string }>("session-closed", (e) => {
  void requestHeal(e.payload.profile_id);
}).catch((e) => console.error("session-closed listener", e));
