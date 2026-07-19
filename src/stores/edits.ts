import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import * as ipc from "../ipc/commands";
import type { EditabilityMap, EditMapHint, EditOutcome, RowEdit } from "../ipc/types";
import { buildEditMapHint, tableIdentityHints } from "../lib/editHints";
import { useResults } from "./results";
import { skey, useConnections } from "./connections";
import { useSchema, type SchemaSnapshot } from "./schema";

export interface PendingEdit {
  stmtIndex: number;
  row: number;
  col: number;
  /** new value; null = SQL NULL */
  value: string | null;
  /** stage SET col = DEFAULT instead of a value */
  useDefault?: boolean;
  /** original cell value for revert/display */
  original: string | null;
}

const keyOf = (stmtIndex: number, row: number, col: number) =>
  `${stmtIndex}:${row}:${col}`;

/** record the current pending map as an undo step; any new edit clears redo */
const pushUndo = (t: { pending: Record<string, PendingEdit>; undoStack: Record<string, PendingEdit>[] }) => ({
  undoStack: [...t.undoStack, t.pending].slice(-100),
  redoStack: [] as Record<string, PendingEdit>[],
});

/** one tab's edit state */
interface TabEdits {
  maps: Record<number, EditabilityMap | "loading" | "unavailable">;
  pending: Record<string, PendingEdit>;
  flash: Set<string>;
  /** snapshots of `pending` for ⌘Z/⌘⇧Z over STAGED edits (not DB state) */
  undoStack: Record<string, PendingEdit>[];
  redoStack: Record<string, PendingEdit>[];
}
const blankEdits = (): TabEdits => ({
  maps: {},
  pending: {},
  flash: new Set(),
  undoStack: [],
  redoStack: [],
});
const UNDO_CAP = 100;

/** the post-commit inverse-SQL undo offer ("Committed … — Undo"). Stamped
 * with the tab AND the exact session that committed: it dies with that
 * session (never offered across reconnects), on DDL, on TTL expiry, and a
 * newer commit on the profile supersedes it (only the latest is offered). */
export interface UndoOffer {
  id: number;
  description: string;
  tabId: string;
  sessionId: string;
  profileId: string;
}

// like results: top-level mirrors the active tab, byTab is the source of truth.
// committing / preview / lastError are global (one commit/preview at a time).
interface EditsState extends TabEdits {
  byTab: Record<string, TabEdits>;
  active: string;
  committing: boolean;
  /** inverse-SQL undo offer for the latest committed batch (global — one
   * commit at a time, mirrors `committing`) */
  undoOffer: UndoOffer | null;
  undoing: boolean;
  preview: {
    statements: string[];
    error: string | null;
    loading?: boolean;
    /** commit hit a schema-shaped error → the SQL was regenerated from a
     * fresh map and must be re-reviewed (writes are never auto-retried) */
    notice?: string | null;
  } | null;
  lastError: string | null;

  syncActive: (tabId: string) => void;
  resetTab: (tabId: string) => void;
  ensureMap: (stmtIndex: number) => void;
  /** DDL ran on this connection — background-refresh every tab's cached
   * editability maps (stale-while-revalidate; failures keep the old map) */
  refreshMapsAfterDdl: () => void;
  setEdit: (e: PendingEdit) => void;
  /** stage many edits as ONE undoable step (fill-down, paste, Set NULL/…) */
  setEditsBatch: (edits: PendingEdit[]) => void;
  clearEdit: (stmtIndex: number, row: number, col: number) => void;
  undo: () => void;
  redo: () => void;
  discardAll: () => void;
  openPreview: () => Promise<void>;
  closePreview: () => void;
  commit: () => Promise<void>;
  /** apply the offered revert through the verified pipeline (⌘⇧Z / click) */
  undoLastCommit: () => Promise<void>;
  clearUndoOffer: () => void;
}

function sessionAndSql(): { sessionId: string; sql: string } | null {
  const res = useResults.getState();
  const sessionId = res.executedSessionId;
  if (!sessionId || !res.executedSql) return null;
  return { sessionId, sql: res.executedSql };
}

/** the user declined writing through a rebuilt session */
const DECLINED = Symbol("declined");

/** resolve a LIVE session for commit/preview. The result's executedSessionId
 * may be dead (network drop, dev rebuild) — re-resolve a session ON THE
 * PROFILE THE RESULT CAME FROM. Never the active rail selection: clicking
 * another connected profile (staging→prod!) must not redirect a ⌘S commit
 * to a different database. */
async function liveSessionId(tabId: string): Promise<string | typeof DECLINED | null> {
  const conn = useConnections.getState();
  const res = useResults.getState();
  const tab = res.byTab[tabId];
  const profileId = tab?.executedProfileId ?? null;
  if (profileId && tabId) {
    const sid = await conn.ensureTabSession(profileId, tabId);
    if (sid) {
      // a REBUILT session gets stamped back — pg-notice routing keys on
      // executedSessionId, so trigger NOTICEs raised during a commit on the
      // new session would otherwise match no tab and vanish
      if (tab && tab.executedSessionId !== sid) {
        // the executed session died and this one was built fresh — any open
        // transaction died with it; writing against current state needs consent
        const { confirmDanger } = await import("./danger");
        const ok = await confirmDanger(
          "Connection was rebuilt",
          "The connection this result ran on was rebuilt (any open transaction is gone).\nCommit against the current database state?",
          "Commit",
        );
        if (!ok) return DECLINED;
        useResults.setState((st) => {
          const cur = st.byTab[tabId];
          if (!cur) return st;
          const next = { ...cur, executedSessionId: sid };
          return {
            byTab: { ...st.byTab, [tabId]: next },
            ...(st.active === tabId ? { executedSessionId: sid } : {}),
          };
        });
      }
      return sid;
    }
  }
  return tab?.executedSessionId ?? null;
}

/** ctid row-movement guard: rows move under UPDATE/VACUUM FULL, so a ctid
 * locator alone could hit a different row — pin identity with the row's old
 * values (every same-table column in the result; truncated cells excluded,
 * their displayed prefix isn't the stored value). The backend ANDs these into
 * the locator, so a moved row becomes matched ≠ 1 instead of a wrong row. */
export function ctidGuardPairs(
  map: EditabilityMap,
  tableOid: number,
  stmt: { rows: (string | null)[][]; truncated: Set<string> },
  row: number,
): [number, string | null][] {
  const guard: [number, string | null][] = [];
  const seen = new Set<number>();
  for (const c of map.columns) {
    if (c.table_oid !== tableOid || c.is_ctid || c.attnum <= 0) continue;
    if (stmt.truncated.has(`${row}:${c.col}`) || seen.has(c.attnum)) continue;
    seen.add(c.attnum);
    guard.push([c.col, stmt.rows[row]?.[c.col] ?? null]);
  }
  return guard;
}

export const TRUNCATED_LOCATOR_MSG =
  "locator value is truncated — cannot safely identify this row";

/** group pending edits into RowEdit payloads for one statement (active tab).
 * `used[i]` is the PendingEdit behind `rowEdits[i]` — results from the backend
 * come back in this order, so mapping against `used` (not the unfiltered
 * input) can never patch the wrong cell when a non-editable edit was dropped. */
function buildRowEdits(
  pending: PendingEdit[],
  map: EditabilityMap,
  stmtIndex: number,
  tabId: string,
): { rowEdits: RowEdit[]; used: PendingEdit[]; truncatedLocators: number } {
  // read the EDIT'S OWN tab — the top-level mirror follows whichever tab is
  // active, and the user can switch tabs while a commit is in flight; PK
  // values pulled from another tab's rows would write through the WRONG row
  const res = useResults.getState();
  const stmt = (res.byTab[tabId]?.statements ?? res.statements).find(
    (s) => s.index === stmtIndex,
  );
  if (!stmt) return { rowEdits: [], used: [], truncatedLocators: 0 };
  const rowEdits: RowEdit[] = [];
  const used: PendingEdit[] = [];
  let truncatedLocators = 0;
  for (const e of pending) {
    const colMeta = map.columns[e.col];
    if (!colMeta?.editable) continue;
    const pkColIdxs = map.pk_cols[colMeta.table_oid] ?? [];
    // a truncated locator cell holds only the display prefix (>8KB text PK) —
    // a WHERE built from it matches 0 rows with a misleading message; refuse
    if (pkColIdxs.some((pc) => stmt.truncated.has(`${e.row}:${pc}`))) {
      truncatedLocators++;
      continue;
    }
    const pk: [number, string | null][] = pkColIdxs.map((pc) => [pc, stmt.rows[e.row]?.[pc] ?? null]);
    const guard: [number, string | null][] =
      pkColIdxs.length > 0 && map.columns[pkColIdxs[0]]?.is_ctid
        ? ctidGuardPairs(map, colMeta.table_oid, stmt, e.row)
        : [];
    rowEdits.push({
      table_oid: colMeta.table_oid,
      col: e.col,
      value: e.value,
      use_default: e.useDefault ?? false,
      pk,
      guard,
    });
    used.push(e);
  }
  return { rowEdits, used, truncatedLocators };
}

type SetFn = (fn: (s: EditsState) => Partial<EditsState>) => void;

function writeEdits(set: SetFn, tabId: string, partial: Partial<TabEdits> | ((t: TabEdits) => Partial<TabEdits>)) {
  set((s) => {
    const cur = s.byTab[tabId] ?? blankEdits();
    const p = typeof partial === "function" ? partial(cur) : partial;
    const next = { ...cur, ...p };
    const byTab = { ...s.byTab, [tabId]: next };
    return tabId === s.active ? { byTab, ...next } : { byTab };
  });
}

// ---- cached-mapping feed (perf batch A/B) -----------------------------------

/** SQLSTATE class 42 (undefined column/table/function, …) = the cached
 * mapping is schema-stale — refetch it; reads may retry, writes may NOT */
const isSchemaErr = (e: unknown): boolean => {
  const code = (e as { code?: string | null } | null)?.code;
  return typeof code === "string" && code.startsWith("42");
};

const errMsg = (e: unknown) => (e as { message?: string }).message ?? String(e);

/** schema snapshot of the profile a tab's result came from (hint source) */
function snapshotFor(tabId: string): SchemaSnapshot | undefined {
  const pid = useResults.getState().byTab[tabId]?.executedProfileId;
  return pid ? useSchema.getState().snapshots[pid] : undefined;
}

/** hint-less (server-truth) refetch of one statement's editability map */
async function refetchMap(
  set: SetFn,
  tabId: string,
  stmtIndex: number,
): Promise<EditabilityMap | null> {
  const rt = useResults.getState().byTab[tabId];
  if (!rt?.executedSessionId || !rt.executedSql) return null;
  try {
    const map = await ipc.editability(rt.executedSessionId, rt.executedSql, stmtIndex, null);
    writeEdits(set, tabId, (t) => ({ maps: { ...t.maps, [stmtIndex]: map } }));
    return map;
  } catch {
    return null; // keep the old map — commit-time verification still guards
  }
}

interface PreviewEntry {
  stmtIndex: number;
  rowEdits: RowEdit[];
  used: PendingEdit[];
  hint: EditMapHint | null;
}

/** the exact inputs the open preview was generated from — commit reuses them
 * so the executed SQL is byte-for-byte what the modal showed (same backend
 * generator + same inputs). Invalidated whenever pending edits change. */
let previewPayload: {
  sql: string;
  pendingSig: string;
  entries: PreviewEntry[];
  truncatedLocators: number;
} | null = null;

const pendingSig = (pending: Record<string, PendingEdit>) =>
  JSON.stringify(Object.entries(pending).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

/** group pending edits per statement into ready-to-send payloads */
function buildEntries(
  tab: TabEdits,
  tabId: string,
): { entries: PreviewEntry[]; skipped: number; truncatedLocators: number } {
  const byStmt = new Map<number, PendingEdit[]>();
  for (const e of Object.values(tab.pending)) {
    const arr = byStmt.get(e.stmtIndex) ?? [];
    arr.push(e);
    byStmt.set(e.stmtIndex, arr);
  }
  const snap = snapshotFor(tabId);
  const entries: PreviewEntry[] = [];
  let skipped = 0;
  let truncatedLocators = 0;
  for (const [stmtIndex, stmtEdits] of byStmt) {
    const map = tab.maps[stmtIndex];
    if (!map || map === "loading" || map === "unavailable") {
      skipped += stmtEdits.length;
      continue;
    }
    const built = buildRowEdits(stmtEdits, map, stmtIndex, tabId);
    truncatedLocators += built.truncatedLocators;
    skipped += stmtEdits.length - built.used.length - built.truncatedLocators;
    if (built.rowEdits.length === 0) continue;
    entries.push({
      stmtIndex,
      rowEdits: built.rowEdits,
      used: built.used,
      hint: buildEditMapHint(map, snap),
    });
  }
  return { entries, skipped, truncatedLocators };
}

/** frontend TTL for the undo toast — slightly under the backend's 15-minute
 * row TTL (which stays the source of truth at undo_log_take time) */
const UNDO_OFFER_TTL_MS = 14.5 * 60 * 1000;
let undoOfferTimer: number | null = null;

/** monotonic guard over offer resolutions: every set/clear AND every refresh
 * fetch bumps it, so a stale in-flight fetch can never override a newer
 * resolution (e.g. a resetTab clear, or a later commit's fresher offer) */
let offerSeq = 0;

function setUndoOffer(offer: UndoOffer | null) {
  offerSeq++;
  if (undoOfferTimer !== null) {
    window.clearTimeout(undoOfferTimer);
    undoOfferTimer = null;
  }
  useEdits.setState({ undoOffer: offer });
  if (offer) {
    undoOfferTimer = window.setTimeout(() => {
      if (useEdits.getState().undoOffer?.id === offer.id) {
        useEdits.setState({ undoOffer: null });
      }
    }, UNDO_OFFER_TTL_MS);
  }
}

/** fetch the newest undo row for the profile and surface it — only when it
 * was written by the EXACT session this tab committed on (session-stamped) */
export async function refreshUndoOffer(tabId: string, sessionId: string, profileId: string) {
  const seq = ++offerSeq;
  try {
    const row = await ipc.undoLogLatest(profileId);
    if (seq !== offerSeq) return; // superseded while in flight — stay stale-silent
    if (row && row.session_key === sessionId) {
      setUndoOffer({ id: row.id, description: row.description, tabId, sessionId, profileId });
    }
  } catch {
    /* no offer — never let the undo surface break the commit path */
  }
}

export const useEdits = create<EditsState>((set, get) => ({
  ...blankEdits(),
  byTab: {},
  active: "",
  committing: false,
  undoOffer: null,
  undoing: false,
  preview: null,
  lastError: null,

  syncActive: (tabId) => set((s) => ({ active: tabId, ...(s.byTab[tabId] ?? blankEdits()) })),

  resetTab: (tabId) => {
    writeEdits(set, tabId, blankEdits());
    if (tabId === get().active) set({ preview: null, lastError: null });
    // the tab's result context is gone — its undo offer goes with it
    if (get().undoOffer?.tabId === tabId) setUndoOffer(null);
  },

  ensureMap: (stmtIndex) => {
    const tabId = get().active;
    if ((get().byTab[tabId] ?? blankEdits()).maps[stmtIndex]) return;
    const ctx = sessionAndSql();
    if (!ctx) return;
    writeEdits(set, tabId, (t) => ({ maps: { ...t.maps, [stmtIndex]: "loading" } }));
    // snapshot identity hints let the backend skip its pg_class trip — the
    // map lands after ONE round trip (the prepare)
    const snap = snapshotFor(tabId);
    const hints = snap ? tableIdentityHints(snap) : null;
    ipc
      .editability(ctx.sessionId, ctx.sql, stmtIndex, hints)
      .then((map) => writeEdits(set, tabId, (t) => ({ maps: { ...t.maps, [stmtIndex]: map } })))
      .catch(() =>
        writeEdits(set, tabId, (t) => ({ maps: { ...t.maps, [stmtIndex]: "unavailable" } })),
      );
  },

  refreshMapsAfterDdl: () => {
    // schema drift invalidates the undo offer (same DDL-sniff signal that
    // refreshes the editability maps) — a revert against a shifted schema
    // would only roll back honestly, but don't even offer it
    if (get().undoOffer) setUndoOffer(null);
    const res = useResults.getState();
    for (const [tabId, t] of Object.entries(get().byTab)) {
      for (const k of Object.keys(t.maps)) {
        const idx = Number(k);
        if (t.maps[idx] === "loading") continue;
        if (!res.byTab[tabId]?.executedSessionId) continue;
        void refetchMap(set, tabId, idx);
      }
    }
  },

  setEdit: (e) => {
    const tabId = get().active;
    const k = keyOf(e.stmtIndex, e.row, e.col);
    if (e.value === e.original && !e.useDefault) {
      writeEdits(set, tabId, (t) => {
        if (!(k in t.pending)) return {};
        const { [k]: _, ...rest } = t.pending;
        return { pending: rest, ...pushUndo(t) };
      });
      return;
    }
    writeEdits(set, tabId, (t) => ({
      pending: { ...t.pending, [k]: e },
      ...pushUndo(t),
    }));
  },

  setEditsBatch: (edits) => {
    if (edits.length === 0) return;
    const tabId = get().active;
    writeEdits(set, tabId, (t) => {
      const pending = { ...t.pending };
      for (const e of edits) {
        const k = keyOf(e.stmtIndex, e.row, e.col);
        if (e.value === e.original && !e.useDefault) delete pending[k];
        else pending[k] = e;
      }
      return { pending, ...pushUndo(t) };
    });
  },

  clearEdit: (stmtIndex, row, col) => {
    const tabId = get().active;
    writeEdits(set, tabId, (t) => {
      const k = keyOf(stmtIndex, row, col);
      if (!(k in t.pending)) return {};
      const { [k]: _, ...rest } = t.pending;
      return { pending: rest, ...pushUndo(t) };
    });
  },

  undo: () => {
    writeEdits(set, get().active, (t) => {
      const prev = t.undoStack[t.undoStack.length - 1];
      if (!prev) return {};
      return {
        pending: prev,
        undoStack: t.undoStack.slice(0, -1),
        redoStack: [...t.redoStack, t.pending].slice(-UNDO_CAP),
      };
    });
  },

  redo: () => {
    writeEdits(set, get().active, (t) => {
      const next = t.redoStack[t.redoStack.length - 1];
      if (!next) return {};
      return {
        pending: next,
        redoStack: t.redoStack.slice(0, -1),
        undoStack: [...t.undoStack, t.pending].slice(-UNDO_CAP),
      };
    });
  },

  discardAll: () => {
    writeEdits(set, get().active, (t) =>
      Object.keys(t.pending).length === 0 ? {} : { pending: {}, ...pushUndo(t) },
    );
    set({ preview: null, lastError: null });
  },

  openPreview: async () => {
    const tabId = get().active;
    const sql = useResults.getState().executedSql;
    const tab = get().byTab[tabId] ?? blankEdits();
    if (!sql || Object.keys(tab.pending).length === 0) return;
    previewPayload = null;
    // modal opens INSTANTLY in a loading state — resolving the session may
    // cross the tunnel (1-2s on a bastion); making ⌘S wait for that read as
    // "the app is sluggish". With a warm mapping the preview itself is
    // generated with ZERO server round trips.
    set({ preview: { statements: [], error: null, loading: true } });
    const sessionId = await liveSessionId(tabId);
    if (sessionId === DECLINED) {
      set({ preview: null });
      return;
    }
    if (!sessionId) {
      set({ preview: { statements: [], error: "no live connection" } });
      return;
    }
    if (!get().preview?.loading) return; // user Esc'd while we were fetching

    const gen = async (entries: PreviewEntry[]) => {
      const all: string[] = [];
      for (const en of entries) {
        const sqls = await ipc.editsPreview(sessionId, sql, en.stmtIndex, en.rowEdits, en.hint);
        all.push(...sqls);
      }
      return all;
    };

    let { entries, truncatedLocators } = buildEntries(get().byTab[tabId] ?? blankEdits(), tabId);
    try {
      let statements: string[];
      try {
        statements = await gen(entries);
      } catch (e) {
        // schema drifted under the cached mapping → refetch the maps once
        // (server truth), rebuild, retry silently. Preview is a read — safe.
        if (!isSchemaErr(e)) throw e;
        for (const en of entries) await refetchMap(set, tabId, en.stmtIndex);
        ({ entries, truncatedLocators } = buildEntries(get().byTab[tabId] ?? blankEdits(), tabId));
        statements = await gen(entries);
      }
      if (!get().preview?.loading) return; // closed mid-fetch — don't reopen
      previewPayload = {
        sql,
        pendingSig: pendingSig((get().byTab[tabId] ?? blankEdits()).pending),
        entries,
        truncatedLocators,
      };
      set({
        preview: {
          statements,
          error: statements.length === 0 && truncatedLocators > 0 ? TRUNCATED_LOCATOR_MSG : null,
          notice:
            statements.length > 0 && truncatedLocators > 0
              ? `${truncatedLocators} edit${truncatedLocators === 1 ? "" : "s"} excluded: ${TRUNCATED_LOCATOR_MSG}`
              : null,
        },
      });
    } catch (e) {
      if (!get().preview?.loading) return;
      set({ preview: { statements: [], error: errMsg(e) } });
    }
  },

  closePreview: () => set({ preview: null }),

  commit: async () => {
    const sql = useResults.getState().executedSql;
    const tabId = get().active;
    const tab = get().byTab[tabId] ?? blankEdits();
    const edits = Object.values(tab.pending);
    if (!sql || edits.length === 0 || get().committing) return;
    set({ committing: true, lastError: null });
    const sessionId = await liveSessionId(tabId);
    if (sessionId === DECLINED) {
      set({ committing: false });
      return;
    }
    if (!sessionId) {
      set({ committing: false, lastError: "no live connection" });
      return;
    }
    // the await above can take seconds (reconnect) — if the tab's result set
    // was replaced meanwhile, PK locators would be built from the NEW query's
    // rows at the OLD map's column positions. Abort instead.
    if (useResults.getState().byTab[tabId]?.executedSql !== sql) {
      set({ committing: false, lastError: "result set changed — commit aborted" });
      return;
    }

    // byte-for-byte contract: when committing from an open preview, run the
    // EXACT inputs the preview SQL was generated from (same rowEdits + same
    // mapping hint through the same backend generator = identical SQL) —
    // a snapshot refresh between ⌘S and Enter can't shift the plan.
    const sig = pendingSig(tab.pending);
    const stashed =
      previewPayload && previewPayload.sql === sql && previewPayload.pendingSig === sig
        ? previewPayload
        : null;
    const { entries, skipped, truncatedLocators } = stashed
      ? {
          entries: stashed.entries,
          skipped:
            edits.length -
            stashed.entries.reduce((n, en) => n + en.used.length, 0) -
            stashed.truncatedLocators,
          truncatedLocators: stashed.truncatedLocators,
        }
      : buildEntries(tab, tabId);

    const committedKeys: string[] = [];
    const errs: string[] = [];
    let schemaChanged = false;
    let threw = false;
    for (const en of entries) {
      let outcome: EditOutcome;
      try {
        outcome = await ipc.editsApply(sessionId, sql, en.stmtIndex, en.rowEdits, en.hint);
      } catch (e) {
        if (isSchemaErr(e)) {
          // the batch rolled back server-side; the mapping is schema-stale.
          // NEVER auto-retry a write — regenerate the preview below.
          schemaChanged = true;
        } else {
          threw = true;
          errs.push(errMsg(e));
        }
        break;
      }
      const { used } = en;
      if (outcome.committed) {
        // patch the EDIT'S tab explicitly — the user may have switched tabs
        // while the commit round trip was in flight
        useResults.getState().patchStatement(
          en.stmtIndex,
          (rows) => {
            const copy = rows.map((r) => [...r]);
            used.forEach((e, i) => {
              const res = outcome.results[i];
              if (res?.ok) copy[e.row][e.col] = res.new_value;
            });
            return copy;
          },
          tabId,
        );
        // browse tabs: a patched sort/tiebreak key column invalidates the
        // pinned keyset — the next page must re-run, not seek from the
        // patched value (dynamic import mirrors the existing store wiring)
        {
          const stmtCols =
            useResults.getState().byTab[tabId]?.statements.find((st) => st.index === en.stmtIndex)
              ?.columns ?? [];
          const patchedCols = [
            ...new Set(
              used
                .filter((_, i) => outcome.results[i]?.ok)
                .map((e) => stmtCols[e.col]?.name)
                .filter((n): n is string => !!n),
            ),
          ];
          if (patchedCols.length > 0) {
            void import("./browser").then(({ useBrowser }) =>
              useBrowser.getState().noteCommittedPatch(tabId, patchedCols),
            );
          }
        }
        writeEdits(set, tabId, (t) => {
          const flash = new Set(t.flash);
          used.forEach((e, i) => {
            if (outcome.results[i]?.ok) flash.add(keyOf(e.stmtIndex, e.row, e.col));
          });
          return { flash };
        });
        setTimeout(() => writeEdits(set, tabId, { flash: new Set() }), 900);
        used.forEach((e, i) => {
          if (outcome.results[i]?.ok) committedKeys.push(keyOf(e.stmtIndex, e.row, e.col));
        });
      } else {
        // backend rolled the whole statement batch back (a row matched ≠ 1)
        const msgs = [...new Set(outcome.results.map((r) => r.message).filter(Boolean))];
        errs.push(`rolled back — ${msgs.join("; ")}`);
      }
    }
    if (skipped > 0) {
      errs.push(`${skipped} edit${skipped === 1 ? "" : "s"} skipped (no editability info) — still staged`);
    }
    if (truncatedLocators > 0) {
      errs.push(
        `${truncatedLocators} edit${truncatedLocators === 1 ? "" : "s"} skipped — ${TRUNCATED_LOCATOR_MSG}`,
      );
    }
    // clear ONLY what actually committed — even when a later statement failed;
    // rolled-back and skipped edits stay staged so work is never silently lost
    writeEdits(set, tabId, (t) => {
      const pending = { ...t.pending };
      for (const key of committedKeys) delete pending[key];
      return { pending };
    });
    previewPayload = null;

    // something committed → the backend persisted a revert plan; offer Undo
    // (session-stamped: only when the newest row came from THIS session)
    if (committedKeys.length > 0) {
      const profileId = useResults.getState().byTab[tabId]?.executedProfileId;
      if (profileId) void refreshUndoOffer(tabId, sessionId, profileId);
    }

    if (schemaChanged) {
      // refetch the maps (server truth), regenerate the preview SQL from the
      // still-pending edits and put it back in front of the user for review
      for (const en of entries) await refetchMap(set, tabId, en.stmtIndex);
      const rebuilt = buildEntries(get().byTab[tabId] ?? blankEdits(), tabId);
      try {
        const all: string[] = [];
        for (const en of rebuilt.entries) {
          const sqls = await ipc.editsPreview(sessionId, sql, en.stmtIndex, en.rowEdits, en.hint);
          all.push(...sqls);
        }
        previewPayload = {
          sql,
          pendingSig: pendingSig((get().byTab[tabId] ?? blankEdits()).pending),
          entries: rebuilt.entries,
          truncatedLocators: rebuilt.truncatedLocators,
        };
        set({
          committing: false,
          preview: {
            statements: all,
            error: null,
            notice: "schema changed — review the updated SQL before committing",
          },
          lastError: errs.length > 0 ? errs.join(" · ") : null,
        });
      } catch (e) {
        set({
          committing: false,
          preview: { statements: [], error: errMsg(e) },
          lastError: errs.length > 0 ? errs.join(" · ") : "schema changed — commit rolled back",
        });
      }
      return;
    }

    set({
      // an exception keeps the modal open (the user may retry); a completed
      // pass closes it (per-row failures are reported in the status bar)
      ...(threw ? {} : { preview: null }),
      committing: false,
      lastError: errs.length > 0 ? errs.join(" · ") : null,
    });
  },

  undoLastCommit: async () => {
    const offer = get().undoOffer;
    if (!offer || get().undoing || get().committing) return;
    // NEVER across reconnects: the tab's live session must still be the exact
    // session that committed (the backend re-checks the same stamp)
    const live = useConnections.getState().tabSessions[skey(offer.profileId, offer.tabId)];
    if (live !== offer.sessionId) {
      setUndoOffer(null);
      set({ lastError: "undo unavailable — connection changed since the commit" });
      return;
    }
    set({ undoing: true });
    try {
      const out = await ipc.undoApply(offer.sessionId, offer.id);
      setUndoOffer(null); // single-shot: the row is consumed either way
      if (out.committed) {
        set({ undoing: false, lastError: null });
        // refresh the grid with the exact SQL this result came from — AWAITED
        // so its resetTab has already fired before the redo offer is fetched
        // (the old fire-and-forget order let resetTab wipe the fresh offer)
        const rt = useResults.getState().byTab[offer.tabId];
        if (rt?.executedSql && useResults.getState().active === offer.tabId) {
          await useResults.getState().run(rt.executedSql, rt.executedOffset);
        }
        // the undo commit wrote its own undo row — redo emerges as the next offer
        void refreshUndoOffer(offer.tabId, offer.sessionId, offer.profileId);
      } else {
        // stale undo: the verified batch rolled back fully — say so honestly
        set({ undoing: false, lastError: out.message ?? "undo rolled back" });
      }
    } catch (e) {
      setUndoOffer(null);
      set({ undoing: false, lastError: errMsg(e) });
    }
  },

  clearUndoOffer: () => setUndoOffer(null),
}));

export const editKey = keyOf;

// follow the active tab (results owns the canonical active tab id)
if (useResults.getState().active) useEdits.getState().syncActive(useResults.getState().active);
useResults.subscribe((s, p) => {
  if (s.active !== p.active) useEdits.getState().syncActive(s.active);
});

// the session that committed died → its undo offer dies with it (a revert on
// a rebuilt session is exactly the "across reconnects" case we never allow)
void listen<{ session_id: string }>("session-closed", (e) => {
  const o = useEdits.getState().undoOffer;
  if (o && o.sessionId === e.payload.session_id) useEdits.getState().clearUndoOffer();
});
