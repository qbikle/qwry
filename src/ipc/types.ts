// Mirrors src-tauri/src/driver/mod.rs — keep in sync by hand (see CLAUDE.md).

export interface Profile {
  id: string;
  name: string;
  host: string;
  port: number;
  dbname: string;
  user: string;
  sslmode: "disable" | "prefer" | "require";
  color?: string | null;
  /** avatar glyph: a letter/emoji, or "icon:<name>" for a lucide icon; null = auto-initial */
  glyph?: string | null;
  is_prod: boolean;
  /** SSH tunnel: when ssh_host is set, connect through `ssh -L`. host/port
   * above are then the DB address as seen from the ssh server. */
  ssh_host?: string | null;
  ssh_port?: number | null;
  ssh_user?: string | null;
  ssh_key?: string | null;
}

export interface HistoryRow {
  id: number;
  profile_id: string;
  sql: string;
  ms: number;
  rows: number;
  ran_at: string;
}

export interface ColumnMeta {
  name: string;
  type_oid: number;
  table_oid: number;
  attnum: number;
}

/** Cell values are wire text (what psql shows); null = SQL NULL. */
export interface StatementResult {
  index: number;
  sql: string;
  columns: ColumnMeta[];
  rows: (string | null)[][];
  affected: number | null;
  ms: number;
}

export interface ExecOutcome {
  statements: StatementResult[];
}

export interface DriverError {
  message: string;
  position: number | null;
  code: string | null;
  /** PG DETAIL — often the actual answer ("Key (email)=(x) already exists") */
  detail?: string | null;
  /** PG HINT */
  hint?: string | null;
}

/** schema + relation name carried SEPARATELY — never split a dotted string */
export interface TableRef {
  schema: string;
  name: string;
}

export interface ColumnEditMeta {
  col: number;
  table_oid: number;
  attnum: number;
  editable: boolean;
  reason: string | null;
  type_name: string;
  /** SQL-safe cast target (quoted/qualified when needed) for generated `::cast` */
  cast: string;
  /** this result column is the table's ctid (a row locator, not user-editable) */
  is_ctid: boolean;
  /** soft warning shown on an editable cell (e.g. "editing via ctid") */
  warn: string | null;
}

export interface EditabilityMap {
  statement_index: number;
  columns: ColumnEditMeta[];
  pk_cols: Record<number, number[]>;
  /** table_oid → "schema.name" (display only — SQL identity is table_refs) */
  tables: Record<number, string>;
  table_refs: Record<number, TableRef>;
}

export interface RowEdit {
  table_oid: number;
  col: number;
  value: string | null;
  /** SET col = DEFAULT (value ignored) */
  use_default?: boolean;
  pk: [number, string | null][];
  /** old-value predicates ANDed into the WHERE — the ctid row-movement guard */
  guard?: [number, string | null][];
}

/** oid → identity from the schema snapshot (mirror of Rust TableIdentityHint).
 * Lets `editability` skip its pg_class round trip — 1 RTT (the prepare). */
export interface TableIdentityHint {
  table_oid: number;
  schema: string;
  name: string;
  /** PK attnums in index order; empty = no primary key */
  pk_attnums: number[];
  /** pg_class.relkind (r/v/m/p/f) */
  relkind: string;
  /** attnums with attgenerated ≠ '' (GENERATED ALWAYS AS … columns) */
  generated_attnums: number[];
  /** attnums with attidentity = 'a' (GENERATED ALWAYS AS IDENTITY) */
  identity_always_attnums: number[];
}

/** one column of a frontend-supplied edit mapping (Rust ColumnMapHint) */
export interface EditColumnHint {
  col: number;
  table_oid: number;
  attnum: number;
  editable: boolean;
  type_name: string;
  /** SQL-safe cast target from the map */
  cast: string;
  is_ctid: boolean;
  /** real column name; null only allowed for ctid columns */
  name: string | null;
}

/** cached mapping fed back to preview/apply/delete so planning does ZERO
 * catalog round trips (Rust EditMapHint). Built from the EditabilityMap the
 * frontend already fetched + attnum→name from the schema snapshot. */
export interface EditMapHint {
  columns: EditColumnHint[];
  pk_cols: Record<number, number[]>;
  table_refs: Record<number, TableRef>;
}

export interface EditResult {
  ok: boolean;
  message: string | null;
  new_value: string | null;
}

export interface EditOutcome {
  results: EditResult[];
  committed: boolean;
}

export type QueryEvent =
  | { type: "statement_start"; index: number; sql: string }
  | { type: "columns"; index: number; columns: ColumnMeta[] }
  | {
      type: "rows";
      index: number;
      rows: (string | null)[][];
      truncated: [number, number][];
    }
  | {
      type: "statement_done";
      index: number;
      affected: number | null;
      ms: number;
      row_count: number;
      capped: boolean;
    }
  | {
      type: "error";
      index: number;
      message: string;
      position: number | null;
      code: string | null;
      detail: string | null;
      hint: string | null;
    }
  | { type: "finished"; total_ms: number };
