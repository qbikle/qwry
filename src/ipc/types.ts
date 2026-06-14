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
}

export interface ColumnEditMeta {
  col: number;
  table_oid: number;
  attnum: number;
  editable: boolean;
  reason: string | null;
  type_name: string;
  /** this result column is the table's ctid (a row locator, not user-editable) */
  is_ctid: boolean;
  /** soft warning shown on an editable cell (e.g. "editing via ctid") */
  warn: string | null;
}

export interface EditabilityMap {
  statement_index: number;
  columns: ColumnEditMeta[];
  pk_cols: Record<number, number[]>;
  tables: Record<number, string>;
}

export interface RowEdit {
  table_oid: number;
  col: number;
  value: string | null;
  pk: [number, string | null][];
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
    }
  | { type: "finished"; total_ms: number };
