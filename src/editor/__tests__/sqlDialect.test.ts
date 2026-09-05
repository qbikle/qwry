// The curated Postgres dialect (sqlDialect.ts): an alias that happens to be
// an interval field keeps the model's case under every keyword-case preset,
// the real keywords still follow the preset, and the exclusion list is
// pinned to what sql-formatter actually calls a keyword, so a version bump
// that drops or renames one fails here instead of quietly re-casing aliases.

import { describe, expect, test } from "bun:test";
import { postgresql } from "sql-formatter";
import { formatPostgres, IDENT_FIELDS } from "../sqlDialect";

const upper = { keywordCase: "upper", dataTypeCase: "upper", functionCase: "lower", tabWidth: 2, expressionWidth: 50 } as const;
const lower = { keywordCase: "lower", dataTypeCase: "lower", functionCase: "lower", tabWidth: 2, expressionWidth: 50 } as const;
const preserve = { keywordCase: "preserve", dataTypeCase: "preserve", functionCase: "preserve", tabWidth: 2, expressionWidth: 50 } as const;

describe("formatPostgres", () => {
  test("the sketch's alias stays `month` under an upper preset", async () => {
    const out = await formatPostgres("SELECT date_trunc('month', sent_at)::date AS month", upper);
    expect(out).toContain("AS month");
    expect(out).not.toContain("MONTH");
    expect(out.startsWith("SELECT")).toBe(true);
  });

  test("keywords still follow the preset around the alias", async () => {
    const out = await formatPostgres("select count(*) as n, min(sent_at) as day from t where x is null group by 1", upper);
    for (const kw of ["SELECT", "AS n", "AS day", "FROM", "WHERE", "IS NULL", "GROUP BY"]) expect(out).toContain(kw);
    expect(out).not.toContain("DAY");
  });

  test("lower and preserve presets leave the alias as written too", async () => {
    expect(await formatPostgres("SELECT x AS Month FROM t", lower)).toContain("as Month");
    expect(await formatPostgres("SELECT x AS Month FROM t", preserve)).toContain("AS Month");
  });

  test("extract keeps the model's field spelling", async () => {
    const out = await formatPostgres("SELECT EXTRACT(YEAR FROM created_at) AS year, count(*) FROM users GROUP BY 1", upper);
    expect(out).toContain("YEAR");
    expect(out).toContain("AS year");
  });

  test("every excluded word is one sql-formatter would otherwise re-case", () => {
    const listed = new Set(postgresql.tokenizerOptions.reservedKeywords);
    for (const w of IDENT_FIELDS) expect(listed.has(w)).toBe(true);
  });
});
