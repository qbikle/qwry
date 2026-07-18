import { Channel, invoke } from "@tauri-apps/api/core";
import { useSettings } from "../stores/settings";
import type {
  EditabilityMap,
  EditMapHint,
  EditOutcome,
  ExecOutcome,
  HistoryRow,
  HistoryStatus,
  Profile,
  QueryEvent,
  RowEdit,
  TableIdentityHint,
  TableStats,
} from "./types";

/** (result-column index, text value) pairs locating one row by PK or ctid */
export type RowLocator = [number, string | null][];

export const profilesList = () => invoke<Profile[]>("profiles_list");

export const profileSave = (profile: Profile, password?: string) =>
  invoke<void>("profile_save", { profile, password: password ?? null });

export const profileDelete = (id: string) => invoke<void>("profile_delete", { id });

/** drop a profile's cached SSH tunnel so the next connect rebuilds it */
export const invalidateProfile = (profileId: string) =>
  invoke<void>("invalidate_profile", { profileId });

export const setProfileOrder = (ids: string[]) =>
  invoke<void>("set_profile_order", { ids });

/** clone a connection onto a different database (DB switcher) */
export const cloneConnection = (srcProfileId: string, dbname: string) =>
  invoke<Profile>("clone_connection", { srcProfileId, dbname });

/** postgres:// URI for a profile — password included only when asked */
export const connectionUri = (profileId: string, includePassword: boolean) =>
  invoke<string>("connection_uri", { profileId, includePassword });

/** most recent queries across all connections (home dashboard) */
export const historyRecent = (limit?: number) =>
  invoke<HistoryRow[]>("history_recent", { limit: limit ?? null });

/** record one run — failed/cancelled runs enter history too, flagged */
export const historyAdd = (
  profileId: string,
  sql: string,
  ms: number,
  rows: number,
  status: HistoryStatus,
) => invoke<void>("history_add", { profileId, sql, ms, rows, status });

/** search history — profileId null searches across every connection */
export const historySearch = (query: string, profileId?: string | null, limit?: number) =>
  invoke<HistoryRow[]>("history_search", {
    profileId: profileId ?? null,
    query,
    limit: limit ?? null,
  });

export const connect = (profileId: string) => {
  // read at call time — every new session picks up the current setting
  const secs = useSettings.getState().statementTimeoutSecs;
  return invoke<string>("connect", {
    profileId,
    statementTimeoutMs: secs > 0 ? secs * 1000 : 0, // 0 = no timeout
  });
};

export interface TestResult {
  latency_ms: number;
  server_version: string;
  tls: boolean;
}

/** ephemeral connect → SELECT version() → disconnect (connection editor probe) */
export const testConnection = (profile: Profile, password?: string) =>
  invoke<TestResult>("test_connection", { profile, password: password ?? null });

export const disconnect = (sessionId: string) =>
  invoke<void>("disconnect", { sessionId });

export const execute = (sessionId: string, sql: string) =>
  invoke<ExecOutcome>("execute", { sessionId, sql });

export const cancel = (sessionId: string) => invoke<void>("cancel", { sessionId });

/** server-deparsed CREATE TABLE + constraints + indexes for one table */
export const tableDdl = (sessionId: string, schema: string, table: string) =>
  invoke<string>("table_ddl", { sessionId, schema, table });

/** Structure-tab depth: constraints, indexes (+scan counts), triggers,
 * sizes, pg_stat activity, comments — one round trip, read-only */
export const tableStats = (sessionId: string, schema: string, table: string) =>
  invoke<TableStats>("table_stats", { sessionId, schema, table });

/** `tablesHint` (from the schema snapshot) lets the backend skip its pg_class
 * round trip — editability then costs only the prepare(). Null → full derive. */
export const editability = (
  sessionId: string,
  sql: string,
  statementIndex: number,
  tablesHint?: TableIdentityHint[] | null,
) =>
  invoke<EditabilityMap>("editability", {
    sessionId,
    sql,
    statementIndex,
    tablesHint: tablesHint ?? null,
  });

/** `mapHint` = the cached column mapping (EditabilityMap + names) — planning
 * then does ZERO server round trips. Null → full server-side derivation. */
export const editsPreview = (
  sessionId: string,
  sql: string,
  statementIndex: number,
  edits: RowEdit[],
  mapHint?: EditMapHint | null,
) =>
  invoke<string[]>("edits_preview", {
    sessionId,
    sql,
    statementIndex,
    edits,
    mapHint: mapHint ?? null,
  });

export const editsApply = (
  sessionId: string,
  sql: string,
  statementIndex: number,
  edits: RowEdit[],
  mapHint?: EditMapHint | null,
) =>
  invoke<EditOutcome>("edits_apply", {
    sessionId,
    sql,
    statementIndex,
    edits,
    mapHint: mapHint ?? null,
  });

export const deleteRows = (
  sessionId: string,
  sql: string,
  statementIndex: number,
  tableOid: number,
  rows: RowLocator[],
  mapHint?: EditMapHint | null,
) =>
  invoke<EditOutcome>("delete_rows", {
    sessionId,
    sql,
    statementIndex,
    tableOid,
    rows,
    mapHint: mapHint ?? null,
  });

/** one full (untruncated) cell by table identity + row locator — SQL is
 * generated server-side with real column names and proper quoting */
export const fetchCell = (
  sessionId: string,
  sql: string,
  statementIndex: number,
  col: number,
  locator: RowLocator,
  mapHint?: EditMapHint | null,
) =>
  invoke<string | null>("fetch_cell", {
    sessionId,
    sql,
    statementIndex,
    col,
    locator,
    mapHint: mapHint ?? null,
  });

export interface SessionInfo {
  tls: boolean;
  backend_pid: number;
}

/** live session facts: whether TLS is actually on (sslmode=prefer can
 * silently downgrade) and the server backend pid */
export const sessionInfo = (sessionId: string) =>
  invoke<SessionInfo>("session_info", { sessionId });

/** pg_terminate_backend via a fresh control connection — the last cancel
 * tier; only ever offered behind an explicit confirm */
export const terminateBackend = (sessionId: string) =>
  invoke<void>("terminate_backend", { sessionId });

/** last persisted schema snapshot for a profile (raw JSON, parse in TS);
 * null when absent or the stored sig no longer matches the profile */
export const schemaCacheGet = (profileId: string, sig: string) =>
  invoke<string | null>("schema_cache_get", { profileId, sig });

export const insertRow = (
  sessionId: string,
  schema: string,
  table: string,
  cols: string[],
  values: (string | null)[],
) => invoke<ExecOutcome>("insert_row", { sessionId, schema, table, cols, values });

/** Streaming execution. Resolves when the whole batch finishes (or errors). */
export const executeStream = (
  sessionId: string,
  sql: string,
  onEvent: (ev: QueryEvent) => void,
) => {
  const channel = new Channel<QueryEvent>();
  channel.onmessage = onEvent;
  return invoke<void>("execute_stream", { sessionId, sql, onEvent: channel });
};
