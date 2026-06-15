import { Channel, invoke } from "@tauri-apps/api/core";
import type {
  EditabilityMap,
  EditOutcome,
  ExecOutcome,
  HistoryRow,
  Profile,
  QueryEvent,
  RowEdit,
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

/** most recent queries across all connections (home dashboard) */
export const historyRecent = (limit?: number) =>
  invoke<HistoryRow[]>("history_recent", { limit: limit ?? null });

export const connect = (profileId: string) =>
  invoke<string>("connect", { profileId });

export const disconnect = (sessionId: string) =>
  invoke<void>("disconnect", { sessionId });

export const execute = (sessionId: string, sql: string) =>
  invoke<ExecOutcome>("execute", { sessionId, sql });

export const cancel = (sessionId: string) => invoke<void>("cancel", { sessionId });

export const editability = (sessionId: string, sql: string, statementIndex: number) =>
  invoke<EditabilityMap>("editability", { sessionId, sql, statementIndex });

export const editsPreview = (
  sessionId: string,
  sql: string,
  statementIndex: number,
  edits: RowEdit[],
) => invoke<string[]>("edits_preview", { sessionId, sql, statementIndex, edits });

export const editsApply = (
  sessionId: string,
  sql: string,
  statementIndex: number,
  edits: RowEdit[],
) => invoke<EditOutcome>("edits_apply", { sessionId, sql, statementIndex, edits });

export const deleteRows = (
  sessionId: string,
  sql: string,
  statementIndex: number,
  tableOid: number,
  rows: RowLocator[],
) => invoke<EditOutcome>("delete_rows", { sessionId, sql, statementIndex, tableOid, rows });

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
