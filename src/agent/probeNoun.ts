// The noun a probe chip wears (AGENT-UX section 2 item 2: `probe sent_at`,
// the sketch's chip; the W2b gate's S3 was a bare `probe` beside chips that
// name their object). A probe verifies one assumption: a timestamp's range,
// a filter's row count, a column's distinct values. Its subject is the first
// column its first statement measures: the SELECT list first (`min(sent_at),
// max(sent_at)`), then the WHERE clause when the list measures only `count(*)`
// (`WHERE created_at < signup_at`), then GROUP BY; a statement that names no
// column falls back to the first table it reads from, and one that names
// neither leaves the chip bare.
//
// A tokenizer, not a parser: string literals, comments and numbers are
// skipped; a quoted identifier keeps its spelling; a qualified name keeps its
// last segment (`u.created_at` → `created_at`, `public.users` → `users`).
// Clause context follows SELECT / FROM / JOIN / WHERE / GROUP BY and is saved
// across parentheses, so a subquery's clauses count and a function's
// arguments belong to the clause around it (the FROM inside `extract(year
// from x)` switches nothing). A word after AS or `::` is an alias or a type,
// never a column; a word after a closing paren or another word in the SELECT
// list is an implicit alias; a word before `(` is a function.

interface Tok {
  kind: "word" | "punct" | "literal";
  text: string;
  /** a quoted or qualified name: an identifier whatever it spells */
  ident: boolean;
}

const KEYWORDS = new Set(
  (
    "SELECT ALL DISTINCT FROM JOIN LEFT RIGHT INNER OUTER FULL CROSS NATURAL LATERAL ON USING " +
    "WHERE GROUP BY HAVING ORDER ASC DESC NULLS FIRST LAST LIMIT OFFSET FETCH NEXT ROWS ROW ONLY " +
    "UNION INTERSECT EXCEPT WITH RECURSIVE AS AND OR NOT IN IS NULL TRUE FALSE UNKNOWN BETWEEN " +
    "LIKE ILIKE SIMILAR EXISTS ANY SOME ARRAY CASE WHEN THEN ELSE END INTERVAL FILTER OVER " +
    "PARTITION WINDOW RANGE GROUPS UNBOUNDED PRECEDING FOLLOWING CURRENT EXCLUDE TIES OTHERS " +
    "WITHIN CAST EXTRACT COLLATE AT ZONE TIME TIMESTAMP DATE VALUES DEFAULT ESCAPE SYMMETRIC " +
    "ASYMMETRIC TABLESAMPLE TO FOR ISNULL NOTNULL CUBE ROLLUP SETS DO NOTHING RETURNING"
  ).split(" "),
);

/** keywords that open a function's argument list rather than a subquery */
const FN_KEYWORDS = new Set(["CAST", "EXTRACT", "COALESCE", "NULLIF", "GREATEST", "LEAST", "POSITION", "SUBSTRING", "TRIM", "OVERLAY"]);

/** `extract(year from x)`, `date_part('month', x)`: field names inside a
 * function's parens are arguments, not columns; a bare column named `month`
 * outside one is a column */
const FIELDS = new Set(
  "YEAR MONTH WEEK DAY HOUR MINUTE SECOND QUARTER DOW DOY EPOCH CENTURY DECADE MILLENNIUM ISODOW ISOYEAR JULIAN TIMEZONE MICROSECONDS MILLISECONDS".split(
    " ",
  ),
);

/** an alias or a type phrase after AS / `::` runs until one of these, a
 * punctuation mark or a literal (`x::timestamp with time zone FROM t`) */
const STOP_WORDS = new Set(
  "FROM JOIN WHERE GROUP HAVING ORDER LIMIT OFFSET ON USING AND OR UNION INTERSECT EXCEPT WINDOW WHEN THEN ELSE END FILTER OVER LEFT RIGHT INNER FULL CROSS NATURAL".split(
    " ",
  ),
);

const isSpace = (c: string) => c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f" || c === "\v";
const isDigit = (c: string) => c >= "0" && c <= "9";
const isWordStart = (c: string) => (c >= "A" && c <= "Z") || (c >= "a" && c <= "z") || c === "_";
const isWordChar = (c: string) => isWordStart(c) || isDigit(c) || c === "$";

export function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src[i];
    if (isSpace(c)) {
      i++;
      continue;
    }
    if (c === "-" && src[i + 1] === "-") {
      const e = src.indexOf("\n", i);
      i = e === -1 ? n : e + 1;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const e = src.indexOf("*/", i + 2);
      i = e === -1 ? n : e + 2;
      continue;
    }
    if (c === "'") {
      let j = i + 1;
      while (j < n) {
        if (src[j] === "'") {
          if (src[j + 1] === "'") {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      out.push({ kind: "literal", text: src.slice(i, j + 1), ident: false });
      i = j + 1;
      continue;
    }
    if (c === "$") {
      const m = /^\$[A-Za-z_]*\$/.exec(src.slice(i));
      if (m) {
        const tag = m[0];
        const e = src.indexOf(tag, i + tag.length);
        const stop = e === -1 ? n : e + tag.length;
        out.push({ kind: "literal", text: src.slice(i, stop), ident: false });
        i = stop;
        continue;
      }
    }
    if (isDigit(c) || (c === "." && isDigit(src[i + 1] ?? ""))) {
      let j = i + 1;
      while (j < n && (isWordChar(src[j]) || src[j] === ".")) j++;
      out.push({ kind: "literal", text: src.slice(i, j), ident: false });
      i = j;
      continue;
    }
    if (isWordStart(c) || c === '"') {
      const parts: string[] = [];
      let ident = false;
      let j = i;
      for (;;) {
        if (src[j] === '"') {
          const e = src.indexOf('"', j + 1);
          const stop = e === -1 ? n : e;
          parts.push(src.slice(j + 1, stop));
          ident = true;
          j = stop + 1;
        } else if (src[j] === "*") {
          parts.push("*");
          j++;
        } else {
          let k = j;
          while (k < n && isWordChar(src[k])) k++;
          parts.push(src.slice(j, k));
          j = k;
        }
        const next = src[j + 1] ?? "";
        if (src[j] === "." && (isWordStart(next) || next === '"' || next === "*")) {
          j++;
          continue;
        }
        break;
      }
      out.push({ kind: "word", text: parts[parts.length - 1], ident: ident || parts.length > 1 });
      i = j;
      continue;
    }
    if (c === ":" && src[i + 1] === ":") {
      out.push({ kind: "punct", text: "::", ident: false });
      i += 2;
      continue;
    }
    out.push({ kind: "punct", text: c, ident: false });
    i++;
  }
  return out;
}

type Ctx = "select" | "from" | "where" | "group" | "other";

/** the object the first probe statement is about, or null for a bare chip */
export function probeNoun(sqls: readonly string[]): string | null {
  const sql = sqls[0];
  if (!sql || !sql.trim()) return null;
  const toks = tokenize(sql);
  const cols: Partial<Record<Ctx, string>> = {};
  let table: string | null = null;
  let ctx: Ctx = "other";
  // one entry per open paren: the clause to restore, and whether the paren
  // is a function's argument list (clause keywords inside switch nothing)
  const stack: { ctx: Ctx; fn: boolean }[] = [];
  let fnDepth = 0;
  // after AS or `::`: an alias or a type phrase, skipped word by word
  let skipping = false;
  // in a FROM clause the first word is the table; the rest is alias or ON
  let fromTaken = false;

  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    const prev = toks[i - 1];
    const next = toks[i + 1];
    const upper = t.kind === "word" && !t.ident ? t.text.toUpperCase() : "";
    const keyword = upper !== "" && KEYWORDS.has(upper);

    if (t.kind === "punct") {
      skipping = false;
      if (t.text === "(") {
        const fn = prev?.kind === "word" && (prev.ident || !KEYWORDS.has(prev.text.toUpperCase()) || FN_KEYWORDS.has(prev.text.toUpperCase()));
        stack.push({ ctx, fn });
        if (fn) fnDepth++;
        else if (ctx === "from") fromTaken = true;
      } else if (t.text === ")") {
        const top = stack.pop();
        if (top) {
          ctx = top.ctx;
          if (top.fn) fnDepth--;
        }
      } else if (t.text === "::") {
        skipping = true;
      }
      continue;
    }
    if (t.kind === "literal") {
      skipping = false;
      continue;
    }

    if (skipping) {
      if (t.ident || !STOP_WORDS.has(upper)) continue;
      skipping = false;
    }

    if (keyword) {
      if (upper === "AS") {
        skipping = true;
        continue;
      }
      if (fnDepth > 0) continue;
      switch (upper) {
        case "SELECT":
          ctx = "select";
          break;
        case "FROM":
        case "JOIN":
          ctx = "from";
          fromTaken = false;
          break;
        case "WHERE":
          ctx = "where";
          break;
        case "GROUP":
          ctx = "group";
          break;
        case "HAVING":
        case "ORDER":
        case "LIMIT":
        case "OFFSET":
        case "ON":
        case "USING":
        case "UNION":
        case "INTERSECT":
        case "EXCEPT":
        case "WINDOW":
        case "WITH":
        case "PARTITION":
        case "FETCH":
          ctx = "other";
          break;
      }
      continue;
    }

    // a plain word: a column, a table, an alias or a function name
    if (t.text === "*" || t.text === "") continue;
    if (next?.kind === "punct" && next.text === "(") continue;
    if (fnDepth > 0 && !t.ident && FIELDS.has(upper)) continue;
    if (ctx === "from") {
      if (!fromTaken) {
        fromTaken = true;
        if (table === null) table = t.text;
      }
      continue;
    }
    if (ctx === "other") continue;
    if (ctx === "select" && fnDepth === 0 && prev && ((prev.kind === "punct" && prev.text === ")") || (prev.kind === "word" && !KEYWORDS.has(prev.text.toUpperCase())) || prev.kind === "literal")) {
      continue;
    }
    if (cols[ctx] === undefined) cols[ctx] = t.text;
  }

  return cols.select ?? cols.where ?? cols.group ?? table;
}
