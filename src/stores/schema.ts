import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";

export interface ColumnInfo {
  name: string;
  attnum: number;
  type: string;
  type_oid: number;
  not_null: boolean;
  default: string | null;
  /** attgenerated ('' none, 's' stored); undefined on pre-v0.7 cached snapshots */
  generated?: string;
  /** attidentity ('' none, 'a' always, 'd' by default); undefined on old caches */
  identity?: string;
  /** COMMENT ON COLUMN (pg_description); undefined on pre-v0.8 caches */
  comment?: string | null;
}

export interface TableInfo {
  table_oid: number;
  schema: string;
  name: string;
  kind: "r" | "v" | "m" | "p" | "f";
  columns: ColumnInfo[];
  pk: string[];
  /** pg_class.relhassubclass — the table has inheritance children (Timescale
   * hypertables are relkind='r' parents); child heaps have colliding ctids so
   * ctid keyset must be refused. undefined on pre-v0.7.1 cached snapshots =
   * UNKNOWN → refuse (fail safe; corrected by the live introspect). */
  has_children?: boolean | null;
  /** pg_class.reltuples planner row estimate (-1 = never analyzed); sizes the
   * ctid keyset gate. undefined on pre-v0.7.1 cached snapshots. */
  reltuples?: number | null;
  /** COMMENT ON TABLE (pg_description); undefined on pre-v0.8 caches */
  comment?: string | null;
  /** pg_inherits parent oid — the sidebar nests partitions/children under
   * their parent. undefined/null = top-level relation or pre-v0.8 cache. */
  parent_oid?: number | null;
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

export interface EnumInfo {
  schema: string;
  name: string;
  labels: string[];
}

export interface SeqInfo {
  schema: string;
  name: string;
  /** format_type of pg_sequence.seqtypid (int8/int4/int2) */
  data_type: string | null;
}

export interface ExtInfo {
  name: string;
  version: string;
  /** schema the extension's objects live in */
  schema: string;
}

export interface SchemaSnapshot {
  tables: TableInfo[];
  foreign_keys: FkInfo[];
  functions: FuncInfo[];
  schemas: string[];
  indexes: IndexInfo[];
  /** user-defined enum types — powers type-aware cell editors */
  enums: EnumInfo[];
  /** user-schema sequences — sidebar section; undefined on pre-v0.8 caches */
  sequences?: SeqInfo[];
  /** installed extensions — sidebar section; undefined on pre-v0.8 caches */
  extensions?: ExtInfo[];
  /** current_setting('server_version_num') captured at introspect — gates
   * ctid keyset pagination (tid btree ops are PG 14+). Absent on old caches. */
  server_version_num?: number | null;
}

interface SchemaState {
  /** keyed by profileId */
  snapshots: Record<string, SchemaSnapshot>;
  loading: Record<string, boolean>;
  /** last introspection failure per profile — a silently blank sidebar lies */
  errors: Record<string, string | null>;
  /** provenance per profile. Ordering guard for the persisted-cache path: a
   * cache hydrate may NEVER overwrite server data (any completed fetch is
   * fresher than any persisted snapshot), while a fetch always overwrites. */
  source: Record<string, "cache" | "server">;
  /** instant sidebar/completion at connect time: apply the last persisted
   * snapshot (stale-while-revalidate) while the real introspect runs */
  hydrate: (profileId: string) => Promise<void>;
  fetch: (profileId: string, sessionId: string) => Promise<void>;
}

/** connection identity the cache is bound to — must match connections.connSig
 * (dynamic import avoids a static store cycle at module-eval time) */
async function cacheSig(profileId: string): Promise<string | null> {
  const { useConnections, connSig } = await import("./connections");
  const p = useConnections.getState().profiles.find((x) => x.id === profileId);
  return p ? connSig(p) : null;
}

export const useSchema = create<SchemaState>((set, get) => ({
  snapshots: {},
  loading: {},
  errors: {},
  source: {},

  hydrate: async (profileId) => {
    // something is already showing (from this run) — never regress it to disk
    if (get().snapshots[profileId]) return;
    try {
      const sig = await cacheSig(profileId);
      if (!sig) return;
      const { schemaCacheGet } = await import("../ipc/commands");
      const raw = await schemaCacheGet(profileId, sig);
      if (!raw) return;
      const snap = JSON.parse(raw) as SchemaSnapshot;
      if (!Array.isArray(snap.tables)) return; // corrupt cache — ignore
      set((s) => {
        // re-check at apply time: an in-flight fetch may have landed while we
        // read the cache — server data always wins over a hydrate
        if (s.snapshots[profileId]) return s;
        return {
          snapshots: { ...s.snapshots, [profileId]: snap },
          source: { ...s.source, [profileId]: "cache" },
        };
      });
    } catch {
      // cache is an accelerator only — any failure means "no hydrate"
    }
  },

  fetch: async (profileId, sessionId) => {
    set((s) => ({ loading: { ...s.loading, [profileId]: true } }));
    try {
      // cache_key/sig make the backend persist the fresh snapshot for the
      // NEXT connect's instant hydrate
      const sig = await cacheSig(profileId);
      const snap = await invoke<SchemaSnapshot>("introspect", {
        sessionId,
        cacheKey: sig ? profileId : null,
        cacheSig: sig,
      });
      set((s) => ({
        snapshots: { ...s.snapshots, [profileId]: snap },
        source: { ...s.source, [profileId]: "server" },
        loading: { ...s.loading, [profileId]: false },
        errors: { ...s.errors, [profileId]: null },
      }));
    } catch (e) {
      console.error("introspect failed", e);
      set((s) => ({
        loading: { ...s.loading, [profileId]: false },
        errors: {
          ...s.errors,
          [profileId]: (e as { message?: string }).message ?? String(e),
        },
      }));
    }
  },
}));

// (the old whole-buffer looksLikeDdl sniff is gone — results.ts now checks
// the EXECUTED statements' heads, which can't false-positive inside literals)
