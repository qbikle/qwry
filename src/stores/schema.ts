import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";

export interface ColumnInfo {
  name: string;
  attnum: number;
  type: string;
  type_oid: number;
  not_null: boolean;
  default: string | null;
}

export interface TableInfo {
  table_oid: number;
  schema: string;
  name: string;
  kind: "r" | "v" | "m" | "p" | "f";
  columns: ColumnInfo[];
  pk: string[];
}

export interface FkInfo {
  src_schema: string;
  src_table: string;
  src_cols: string[];
  dst_schema: string;
  dst_table: string;
  dst_cols: string[];
}

export interface FuncInfo {
  schema: string;
  name: string;
  args: string;
  returns: string;
}

export interface IndexInfo {
  schema: string;
  table: string;
  name: string;
  def: string;
}

export interface SchemaSnapshot {
  tables: TableInfo[];
  foreign_keys: FkInfo[];
  functions: FuncInfo[];
  schemas: string[];
  indexes: IndexInfo[];
}

interface SchemaState {
  /** keyed by profileId */
  snapshots: Record<string, SchemaSnapshot>;
  loading: Record<string, boolean>;
  fetch: (profileId: string, sessionId: string) => Promise<void>;
}

export const useSchema = create<SchemaState>((set) => ({
  snapshots: {},
  loading: {},

  fetch: async (profileId, sessionId) => {
    set((s) => ({ loading: { ...s.loading, [profileId]: true } }));
    try {
      const snap = await invoke<SchemaSnapshot>("introspect", { sessionId });
      set((s) => ({
        snapshots: { ...s.snapshots, [profileId]: snap },
        loading: { ...s.loading, [profileId]: false },
      }));
    } catch (e) {
      console.error("introspect failed", e);
      set((s) => ({ loading: { ...s.loading, [profileId]: false } }));
    }
  },
}));

/** crude DDL sniff — refresh the schema cache after these */
export const looksLikeDdl = (sql: string) =>
  /^\s*(create|alter|drop|comment|grant|revoke|truncate)\b/im.test(sql);
