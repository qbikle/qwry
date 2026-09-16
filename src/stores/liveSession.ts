/** ONE resolver for "which session does this tab send on".
 *
 * `executedSessionId` is a STAMP: the session a result ran on, written by
 * results.run and by nothing else. The app forgets sessions in five places
 * (markDisconnected's tab branch, connectInner's per-profile wipe,
 * invalidateProfile, closeTabSessions, healInner's reaping) and the stamp
 * survived every one of them, so a dozen call sites were addressing sessions
 * the app itself had already dropped. The backend answered `no such session`
 * (driver/mod.rs NoSession) under a green connection dot, because the dot
 * tracks the PRIMARY and what died was one tab's own session.
 *
 * So the stamp is not an address any more. It is the record of what ran, and
 * an address is asked for here, once, against the live connection.
 */
import { sessionDiedWithTx, skey, useConnections } from "./connections";
import { useResults } from "./results";
import type { DriverError } from "../ipc/types";

/** the backend's own words for a session it no longer holds. Internal by
 * definition: it names a frontend bookkeeping slip, so no strip may show it */
const NO_SESSION = "no such session";

/** what a reader is told instead, and the only thing they can act on */
const LOST = "connection to this tab was lost. Refresh to reconnect";

/** how a resolved session relates to the one the result ran on: null = same
 * session; "info" = rebuilt (autocommit result, the verified pipeline is the
 * real safety); "tx" = rebuilt AND the dead session held an open transaction
 * (its staged reality is gone — this deserves a real warning) */
export type RebuiltKind = "info" | "tx" | null;

const msgOf = (e: unknown): string => {
  const m = (e as { message?: unknown } | null)?.message;
  return typeof m === "string" ? m : String(e);
};

const lostError = (): DriverError => ({ message: LOST, position: null, code: null });

/** the death class: a message from a transport that is gone, however it
 * ended. Deliberately broad, because it decides what results.ts REAPS on and
 * a wrongly reaped session costs one rebuild; what a heal erases is the
 * stricter `isDeathStrip` below. It never rewrites a string either;
 * `humanSessionError` does that, and only for the one internal phrase. */
export function isSessionDeath(msg: string | null | undefined): boolean {
  return (
    !!msg &&
    /connection|closed|communicat|broken pipe|reset|terminat|no such session/i.test(msg)
  );
}

/** the phrases a dead transport actually writes: the driver's own, and the
 * app's sentences for a connection it could not find. Whole phrases, never
 * the bare words above, because the words also live inside real news: a
 * unique violation on `connections_pkey`, a missing `connection_log`, a
 * `reset_at` column. Over-reaping costs a rebuilt session; over-clearing
 * takes a true error off the screen while the user is reading it. */
const DEATH_PHRASE =
  /connection (closed|reset|failed|refused|has been closed|to this tab was lost)|closed the connection|terminating connection|error communicating|broken pipe|no such session|no live connection|origin connection not available/i;

/** SQLSTATEs a dying transport reports under: connection exception (08),
 * admin and crash shutdown (57P01-03), and PG's idle-in-transaction kill
 * (25P03 — the ten minutes humanCloseReason names). A death that never
 * reached the server, or reached it and got no answer, carries no code. */
const DEATH_CODE = /^(08|57P0[123]|25P03)/;

/** may a heal take this strip down? Only one a dead session wrote: the text
 * says death AND, when the error carries a SQLSTATE, so does the code. */
export function isDeathStrip(msg: string | null | undefined, code?: string | null): boolean {
  if (!msg || !DEATH_PHRASE.test(msg)) return false;
  return !code || DEATH_CODE.test(code);
}

/** a DriverError as a strip may show it: the backend's `no such session`
 * becomes the sentence a reader can act on, everything else passes through
 * untouched (a syntax error and a constraint failure are the user's news) */
export function humanSessionError(err: unknown): DriverError {
  const message = msgOf(err);
  if (message.includes(NO_SESSION)) return lostError();
  const e = (err ?? {}) as Partial<DriverError>;
  return {
    message,
    position: e.position ?? null,
    code: e.code ?? null,
    detail: e.detail ?? null,
    hint: e.hint ?? null,
  };
}

/** PG kills a session that sat in an open transaction past
 * idle_in_transaction_session_timeout, which qwry sets to 600000 ms on every
 * session (driver/postgres/mod.rs:99) — the 10 below is that constant, so the
 * two move together (DESIGN rule 14). Other reasons are the driver's own. */
export function humanCloseReason(reason: string): string {
  return reason.includes("idle-in-transaction")
    ? "transaction expired after 10 minutes idle. Uncommitted changes on that tab were rolled back"
    : reason;
}

/** the session a tab was stamped with just before the app forgot it. The tx
 * verdict below needs the dead id, and by then the stamp is already gone
 * (results.ts clears it the moment a session leaves tabSessions). */
const forgottenStamps = new Map<string, string>();

export function noteForgottenStamp(tabId: string, sessionId: string) {
  forgottenStamps.set(tabId, sessionId);
}

/** the LIVE session for a tab, on the profile its result came from — never
 * the active rail selection: clicking another connected profile
 * (staging→prod!) must not redirect this tab's next send to a different
 * database. A rebuilt session is stamped back before it is handed out,
 * because pg-notice routes on the stamp: a NOTICE raised on the new session
 * would otherwise match no tab and vanish while the user watched for it. */
export async function liveSessionFor(
  tabId: string,
): Promise<{ sid: string; rebuilt: RebuiltKind } | null> {
  if (!tabId) return null;
  const before = useResults.getState().byTab[tabId];
  const profileId = before?.executedProfileId ?? null;
  if (!profileId) return null;
  const old = before?.executedSessionId ?? forgottenStamps.get(tabId) ?? null;
  const sid = await useConnections.getState().ensureTabSession(profileId, tabId);
  if (!sid) return null;
  if (useResults.getState().byTab[tabId]?.executedSessionId === sid) {
    return { sid, rebuilt: null };
  }
  forgottenStamps.delete(tabId);
  useResults.setState((st) => {
    const cur = st.byTab[tabId];
    if (!cur) return st;
    const next = { ...cur, executedSessionId: sid };
    return {
      byTab: { ...st.byTab, [tabId]: next },
      ...(st.active === tabId ? { executedSessionId: sid } : {}),
    };
  });
  return { sid, rebuilt: old && sessionDiedWithTx(old) ? "tx" : "info" };
}

/** the backend refused a handle: drop it the way every other death drops one,
 * so results.ts's own subscription clears the stamp along with it */
function forgetSession(tabId: string, sessionId: string) {
  const conn = useConnections.getState();
  const key = Object.entries(conn.tabSessions).find(([, sid]) => sid === sessionId)?.[0];
  const profileId =
    key?.split("::")[0] ?? useResults.getState().byTab[tabId]?.executedProfileId;
  if (profileId) conn.markDisconnected(profileId, sessionId, null);
}

/** Run `fn` on the tab's live session. Resolving and sending are not one act:
 * a server-side kill can land between them, and the backend answers
 * NoSession. That answer is the app's cue to forget the handle, not something
 * to show — forget it, resolve once more, send again. A second refusal is a
 * connection that is not coming back on this attempt, and says so. */
export async function withLiveSession<T>(
  tabId: string,
  fn: (sessionId: string) => Promise<T>,
): Promise<T> {
  const live = await liveSessionFor(tabId);
  if (!live) throw lostError();
  try {
    return await fn(live.sid);
  } catch (e) {
    if (!msgOf(e).includes(NO_SESSION)) throw e;
    forgetSession(tabId, live.sid);
    const again = await liveSessionFor(tabId);
    if (!again || again.sid === live.sid) throw lostError();
    try {
      return await fn(again.sid);
    } catch (e2) {
      if (!msgOf(e2).includes(NO_SESSION)) throw e2;
      throw lostError();
    }
  }
}

/** A heal finished on a profile (⇧⌘R, wake, a death event's backoff). The
 * probe rebuilt connections and, before this, touched nothing a tab could
 * see: the stamp stayed dead and the red strip stayed up, so the gesture the
 * user reached for changed nothing they were looking at (LESSONS 13).
 * Two acts, both narrow: re-resolve the active tab's session, and take down
 * only the strips a dead session wrote. */
export async function afterHeal(profileId: string): Promise<void> {
  const conn = useConnections.getState();
  const { useTabs } = await import("./tabs");
  const tabId = useTabs.getState().activeId;
  if (tabId && conn.activeProfileId === profileId) {
    // only a tab whose result CAME FROM this profile re-stamps: liveSessionFor
    // resolves against the tab's own origin, and for a tab still showing
    // another profile's result that would reconnect THAT profile
    // (ensureTabSession connects a missing primary) and flip the rail to it —
    // a heal of one connection opening another the user had closed (heal.ts:34).
    // A tab that ran elsewhere, or never ran, just gets the warm session its
    // first ⌘↩ on this profile would have paid for.
    const ranOn = useResults.getState().byTab[tabId]?.executedProfileId ?? null;
    if (ranOn === profileId) await liveSessionFor(tabId);
    else if (!conn.tabSessions[skey(profileId, tabId)]) {
      void conn.ensureTabSession(profileId, tabId);
    }
  }
  const tabIds = Object.entries(useResults.getState().byTab)
    .filter(([, t]) => t.executedProfileId === profileId)
    .map(([id]) => id);
  if (tabIds.length === 0) return;
  const { clearDeathStrip } = await import("./results");
  const { clearDeathStrips } = await import("./browser");
  const { clearDeathStrip: clearEditsDeathStrip } = await import("./edits");
  for (const id of tabIds) {
    clearDeathStrip(id);
    clearDeathStrips(id);
  }
  clearEditsDeathStrip(tabIds);
}
