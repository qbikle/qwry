import type { ColumnMeta } from "../ipc/types";

export type CopyFormat = "tsv" | "csv" | "json" | "markdown" | "insert";

type Cell = string | null;

const csvEscape = (v: string) =>
  /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;

const sqlLiteral = (v: Cell) =>
  v === null ? "NULL" : `'${v.replace(/'/g, "''")}'`;

export function formatCells(
  columns: ColumnMeta[],
  rows: Cell[][],
  format: CopyFormat,
  table = "your_table",
): string {
  const names = columns.map((c) => c.name);
  switch (format) {
    case "tsv":
      return rows
        .map((r) => r.map((v) => (v === null ? "" : v.replace(/\t/g, "    "))).join("\t"))
        .join("\n");
    case "csv":
      return [
        names.map(csvEscape).join(","),
        ...rows.map((r) => r.map((v) => (v === null ? "" : csvEscape(v))).join(",")),
      ].join("\n");
    case "json":
      return JSON.stringify(
        rows.map((r) => Object.fromEntries(r.map((v, i) => [names[i] ?? `col${i}`, v]))),
        null,
        2,
      );
    case "markdown": {
      const header = `| ${names.join(" | ")} |`;
      const sep = `| ${names.map(() => "---").join(" | ")} |`;
      const body = rows
        .map((r) => `| ${r.map((v) => (v === null ? "" : v.replace(/\|/g, "\\|"))).join(" | ")} |`)
        .join("\n");
      return [header, sep, body].join("\n");
    }
    case "insert":
      return rows
        .map(
          (r) =>
            `INSERT INTO ${table} (${names.join(", ")}) VALUES (${r
              .map(sqlLiteral)
              .join(", ")});`,
        )
        .join("\n");
  }
}
