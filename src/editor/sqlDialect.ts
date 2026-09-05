// The Postgres dialect the read-only SQL surfaces format with: sql-formatter's
// `postgresql` minus the words PostgreSQL itself accepts as bare column names
// and models alias with (`AS month`, `AS year`, `AS day`). Measured on
// sql-formatter 15.8.2: its postgresql `reservedKeywords` list (116 words)
// carries the interval fields YEAR MONTH DAY HOUR MINUTE SECOND, so a
// keywordCase preset re-cased the alias the model wrote (`AS MONTH`) and Copy
// SQL disagreed with the grid header (`month`); `identifierCase` never
// reaches a word the tokenizer has already called a keyword, so the list is
// the one lever. Formatted through this dialect the six are identifiers and
// keep the model's spelling everywhere, `extract(year from x)` included
// (W2c gate S3; WRITING data/chrome boundary: data keeps its own clothes).

import type { DialectOptions, FormatOptions } from "sql-formatter";

/** interval fields sql-formatter calls keywords and Postgres accepts as column names */
export const IDENT_FIELDS: ReadonlySet<string> = new Set(["YEAR", "MONTH", "DAY", "HOUR", "MINUTE", "SECOND"]);

/** the curated dialect from an already-loaded sql-formatter module: the one
 * dialect for every surface that formats SQL (the editor's ⇧⌘F and context
 * menu through formatWithPreset, the Ask row through formatPostgres), so one
 * preset has one behaviour everywhere (LESSONS 11) */
export function postgresDialect(mod: typeof import("sql-formatter")): DialectOptions {
  const { postgresql } = mod;
  return {
    ...postgresql,
    tokenizerOptions: {
      ...postgresql.tokenizerOptions,
      reservedKeywords: postgresql.tokenizerOptions.reservedKeywords.filter((k) => !IDENT_FIELDS.has(k)),
    },
  };
}

/** format one statement with the curated dialect; same lazy import as the
 * editor's path (sql-formatter is an eighth of the bundle) */
export async function formatPostgres(src: string, opts: Partial<FormatOptions>): Promise<string> {
  const mod = await import("sql-formatter");
  return mod.formatDialect(src, { ...opts, dialect: postgresDialect(mod) });
}
