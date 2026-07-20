import type { ColumnMeta } from "../ipc/types";
import { qi, qualifyDotted } from "../lib/sqlIdent";

export type CopyFormat = "tsv" | "csv" | "json" | "markdown" | "insert";

type Cell = string | null;

const csvEscape = (v: string) =>
  /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;

// Excel-convention TSV: cells containing tab/newline/quote are quoted, the
// data itself is NEVER mutated (the old tab→spaces replacement corrupted
// values; raw newlines split one cell into two rows on paste)
const tsvEscape = (v: string) =>
  /[\t\n\r"]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;

const sqlLiteral = (v: Cell) =>
  v === null ? "NULL" : `'${v.replace(/'/g, "''")}'`;

/** exact inverse of the TSV writer (Excel convention): a field that STARTS
 * with a quote is quoted — it may contain tabs/newlines, `""` is a literal
 * quote; any other field is verbatim. Line endings (\n, \r\n, \r) are record
 * separators ONLY outside quotes — a quoted field's bytes are never touched
 * (a global \r normalization silently corrupted Windows-origin cell data).
 * Returns null on malformed input (unterminated quote / garbage after a
 * closing quote) so callers can fall back to a naive split instead of
 * silently mangling non-TSV text. */
export function parseTsv(text: string): string[][] | null {
  const n = text.length;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let i = 0;
  // width of a record break at j (0 = not a break)
  const brk = (j: number) =>
    text[j] === "\n" ? 1 : text[j] === "\r" ? (text[j + 1] === "\n" ? 2 : 1) : 0;
  let endedOnBreak = false;
  while (i < n) {
    if (text[i] === '"') {
      // quoted field — the loop is always at field start here
      i++;
      let closed = false;
      while (i < n) {
        if (text[i] === '"') {
          if (text[i + 1] === '"') {
            field += '"';
            i += 2;
            continue;
          }
          i++;
          closed = true;
          break;
        }
        field += text[i++];
      }
      if (!closed) return null;
      if (i < n && text[i] !== "\t" && brk(i) === 0) return null;
    } else {
      while (i < n && text[i] !== "\t" && brk(i) === 0) field += text[i++];
    }
    if (i >= n) {
      endedOnBreak = false;
      break;
    }
    if (text[i] === "\t") {
      row.push(field);
      field = "";
      i++;
      endedOnBreak = false;
      continue;
    }
    i += brk(i);
    row.push(field);
    rows.push(row);
    row = [];
    field = "";
    endedOnBreak = true;
  }
  // a trailing line ending is a record terminator, not a phantom empty row
  if (!(endedOnBreak && field === "" && row.length === 0)) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export function formatCells(
  columns: ColumnMeta[],
  rows: Cell[][],
  format: CopyFormat,
  opts?: {
    /** dotted "schema.name" of the (single) source table for INSERT */
    table?: string;
    /** column indexes (relative to `columns`) that are ctid locators */
    ctidCols?: ReadonlySet<number>;
  },
): string {
  const names = columns.map((c) => c.name);
  // duplicate result names (SELECT a.id, b.id) must not silently collapse
  const jsonKeys = (() => {
    const seen = new Map<string, number>();
    return names.map((n, i) => {
      const base = n || `col${i}`;
      const c = seen.get(base) ?? 0;
      seen.set(base, c + 1);
      return c === 0 ? base : `${base}_${c + 1}`;
    });
  })();
  switch (format) {
    case "tsv":
      return rows
        .map((r) => r.map((v) => (v === null ? "" : tsvEscape(v))).join("\t"))
        .join("\n");
    case "csv":
      return [
        names.map(csvEscape).join(","),
        ...rows.map((r) => r.map((v) => (v === null ? "" : csvEscape(v))).join(",")),
      ].join("\n");
    case "json":
      return JSON.stringify(
        rows.map((r) => Object.fromEntries(r.map((v, i) => [jsonKeys[i], v]))),
        null,
        2,
      );
    case "markdown": {
      // newlines inside a cell would break the table row structure
      const mdCell = (v: Cell) =>
        v === null ? "" : v.replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
      const header = `| ${names.join(" | ")} |`;
      const sep = `| ${names.map(() => "---").join(" | ")} |`;
      const body = rows.map((r) => `| ${r.map(mdCell).join(" | ")} |`).join("\n");
      return [header, sep, body].join("\n");
    }
    case "insert": {
      const keep = names.map((_, i) => i).filter((i) => !opts?.ctidCols?.has(i));
      const target = opts?.table ? qualifyDotted(opts.table) : "your_table";
      const collist = keep.map((i) => qi(names[i])).join(", ");
      return rows
        .map(
          (r) =>
            `INSERT INTO ${target} (${collist}) VALUES (${keep
              .map((i) => sqlLiteral(r[i]))
              .join(", ")});`,
        )
        .join("\n");
    }
  }
}
