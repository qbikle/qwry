import { Channel, invoke } from "@tauri-apps/api/core";
import type {
  EditabilityMap,
  EditOutcome,
  ExecOutcome,
  Profile,
  QueryEvent,
  RowEdit,
} from "./types";

export const profilesList = () => invoke<Profile[]>("profiles_list");

export const profileSave = (profile: Profile, password?: string) =>
  invoke<void>("profile_save", { profile, password: password ?? null });

export const profileDelete = (id: string) => invoke<void>("profile_delete", { id });

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
