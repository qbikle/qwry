/** Self-heal triggers. The mechanics (probe → targeted teardown → gentle
 * reconnect) live in connections.healProfile; this module only decides WHEN:
 * wake from sleep, window refocus, or a session death event. ACTIVE profile
 * only — waking with three bastion profiles must not fire three simultaneous
 * handshakes; the others rebuild lazily on first touch (ensureTabSession
 * already reconnects transparently, and the spare pool makes it instant).
 * Loaded for its side effects from App. */
import { listen } from "@tauri-apps/api/event";
import { isHealArmed, useConnections } from "./connections";

const BACKOFF_MS = [2_000, 5_000, 15_000, 30_000];
const attempts = new Map<string, number>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();

function clearRetry(profileId: string) {
  const t = timers.get(profileId);
  if (t !== undefined) clearTimeout(t);
  timers.delete(profileId);
  attempts.delete(profileId);
}

/** kick a heal now; resets the backoff (a fresh death signal, not a retry) */
export function requestHeal(profileId: string) {
  clearRetry(profileId);
  void run(profileId);
}

async function run(profileId: string) {
  const c = useConnections.getState();
  // armed = the user connected and never manually disconnected since; heal
  // must never resurrect a connection the user chose to close
  if (!isHealArmed(profileId) || c.activeProfileId !== profileId) {
    clearRetry(profileId);
    return;
  }
  const ok = await c.healProfile(profileId);
  const after = useConnections.getState();
  if (ok || !isHealArmed(profileId) || after.activeProfileId !== profileId) {
    clearRetry(profileId);
    return;
  }
  // keep retrying while the app is open: the café case is "wifi lands a
  // minute later". Capped backoff, quiet — the amber/red dot is the story.
  const n = attempts.get(profileId) ?? 0;
  attempts.set(profileId, n + 1);
  // two triggers joining ONE heal pass both land here: replace, never stack
  // (a map overwrite would leak the first timer as a duplicate retry chain)
  const prev = timers.get(profileId);
  if (prev !== undefined) clearTimeout(prev);
  const t = setTimeout(() => {
    timers.delete(profileId);
    void run(profileId);
  }, BACKOFF_MS[Math.min(n, BACKOFF_MS.length - 1)]);
  timers.set(profileId, t);
}

/** probe-and-heal the active profile (cheap no-op when everything is alive) */
function probeActive() {
  const id = useConnections.getState().activeProfileId;
  if (id && isHealArmed(id)) requestHeal(id);
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
void listen<{ profile_id: string }>("session-closed", (e) => {
  requestHeal(e.payload.profile_id);
});
