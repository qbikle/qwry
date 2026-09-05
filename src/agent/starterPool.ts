// The generated starter pool (AGENT-UX section 1, W2d): one tool-less model
// call per connection and schema shape, asking for the twelve questions a
// data analyst would put to this database first. It is a courtesy the way the
// follow-up call is (followups.ts, whose request shape this mirrors): a
// failure costs nothing but the pool, and the heuristic pool in
// src/ask/starters.ts stands in its place. Trace-free on purpose: there is no
// exchange for a trace step to belong to.
//
// `ownsLoop` providers are refused up front, as followups.ts refuses them: the
// claude -p adapter needs a thread with a live database session behind it,
// and the empty state has neither. Those connections keep the heuristic pool.
//
// Runtime-free by law (AGENT-SPEC section 2 rule 2): the only store import is
// a type, erased at compile time, and the provider arrives ready-made.

import type { SchemaSnapshot, TableInfo } from "../stores/schema";
import { buildMeta, type SchemaMeta, type TableMeta } from "./context";
import type { AgentEvent, Provider } from "./providers/types";

export const STARTER_POOL_SIZE = 12;
/** a pool the store keeps has at least this many questions: fewer cannot
 * rotate and would replace twelve heuristics with a couple of lines */
export const STARTER_POOL_MIN = 6;
/** the rule the prompt states and the parser enforces */
export const STARTER_WORD_CAP = 12;
/** the whole-schema summary: the largest tables, this many at most */
export const STARTER_TABLE_CAP = 25;
export const STARTER_COLUMN_CAP = 40;
/** ~4k tokens at the usual four characters a token */
export const STARTER_PROMPT_CHAR_BUDGET = 16_000;
const QUESTION_CHAR_CAP = 160;

/** relations nobody asks questions about; shared with src/ask/starters.ts so
 * the two pools exclude the same tables */
export const SYSTEM_SCHEMAS: ReadonlySet<string> = new Set(["pg_catalog", "information_schema", "pg_toast"]);
export const HOUSEKEEPING = /(migration|alembic_version|flyway|knex_|schema_version|ar_internal_metadata|spatial_ref_sys)/i;
export const LEGACY = /LEGACY/i;

// ---- schema hash ------------------------------------------------------------

/** A stable hash of every relation's schema, name and column names, in one
 * canonical order, so a pool is keyed to the shape it was generated for and a
 * new column or table means a new pool. FNV-1a, 32 bits, eight hex digits;
 * the same text on any machine yields the same hash. */
export function schemaHash(snapshot: SchemaSnapshot): string {
  const lines = snapshot.tables
    .map((t) => `${t.schema}.${t.name}(${t.columns.map((c) => c.name).join(",")})`)
    .sort();
  const text = lines.join("\n");
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

// ---- schema summary -----------------------------------------------------------

export interface StarterSummary {
  /** the text the model reads: one line per table, then the FK edges among them */
  text: string;
  /** display names of the tables shown, largest first */
  tables: string[];
  /** raw names of the relations the model must not build a question on:
   * partitions, LEGACY twins and the migration ledger */
  banned: string[];
}

const isTable = (kind: TableInfo["kind"]) => kind === "r" || kind === "p";

/** a table nobody asks questions about: a partition or inheritance child (the
 * parent is the relation), a system schema, the migration ledger, a LEGACY
 * twin. Read from the snapshot, because buildMeta keeps an inheritance child
 * whose parent is a plain table (Timescale's shape) and drops only the
 * children of declared partitioned parents. */
const banned = (t: TableInfo) =>
  t.parent_oid != null ||
  SYSTEM_SCHEMAS.has(t.schema) ||
  HOUSEKEEPING.test(t.name) ||
  LEGACY.test(t.comment ?? "");

const key = (t: { schema: string; name: string }) => `${t.schema}.${t.name}`;

const bySize = (a: TableMeta, b: TableMeta) =>
  b.approxRows - a.approxRows || a.display.localeCompare(b.display);

/** `name(col, col, … +N)  -- ~rows; comment`, then `a.col -> b.col` per FK
 * edge among the tables shown: the candidate block's shape (context.ts
 * indexFor) with a row estimate the model can weigh and a column cap a wide
 * table cannot blow through */
function render(meta: SchemaMeta, tables: readonly TableMeta[], colCap: number): string {
  const shown = new Set(tables.map((t) => t.display));
  const lines = tables.map((t) => {
    const cols = t.columns.slice(0, colCap).map((c) => c.name);
    const more = t.columns.length > colCap ? `, … +${t.columns.length - colCap}` : "";
    const rows = t.approxRows >= 0 ? `~${t.approxRows} rows` : null;
    const note = [rows, t.comment].filter(Boolean).join("; ");
    return `${t.display}(${cols.join(", ")}${more})${note ? `  -- ${note}` : ""}`;
  });
  for (const fk of meta.fks) {
    if (shown.has(fk.src) && shown.has(fk.dst)) {
      lines.push(`${fk.src}.${fk.srcCol} -> ${fk.dst}.${fk.dstCol}`);
    }
  }
  return lines.join("\n");
}

/** The compact schema the prompt carries: the largest askable tables with
 * their columns and the foreign keys among them, kept under `budget`
 * characters by dropping the smallest tables to eight, then halving the
 * column cap to eight, then dropping tables to one. */
export function starterSummary(
  snapshot: SchemaSnapshot,
  budget = STARTER_PROMPT_CHAR_BUDGET,
): StarterSummary {
  const meta = buildMeta(snapshot);
  const out = snapshot.tables.filter((t) => isTable(t.kind) && banned(t));
  const outKeys = new Set(out.map(key));
  const kept = meta.tables.filter((t) => isTable(t.kind) && !outKeys.has(key(t))).sort(bySize);

  const tables = kept.slice(0, STARTER_TABLE_CAP);
  let colCap = STARTER_COLUMN_CAP;
  let text = render(meta, tables, colCap);
  while (text.length > budget) {
    if (tables.length > 8) tables.pop();
    else if (colCap > 8) colCap = Math.max(8, Math.floor(colCap / 2));
    else if (tables.length > 1) tables.pop();
    else break;
    text = render(meta, tables, colCap);
  }
  return { text, tables: tables.map((t) => t.display), banned: out.map((t) => t.name) };
}

// ---- prompt -----------------------------------------------------------------

/** The starter call's system prompt. Kept apart from prompt.ts's SYSTEM_PROMPT
 * so the cached prefix of the main loop never changes and PROMPT_VERSION
 * stays tied to the measured prompts alone (the FOLLOWUP_SYSTEM_PROMPT
 * precedent). */
export const STARTER_SYSTEM_PROMPT =
  "You suggest the first questions a data analyst would ask of a PostgreSQL database " +
  "they have just opened. Given its largest tables with their columns and the foreign " +
  `keys among them, write exactly ${STARTER_POOL_SIZE} questions, one per line: each a ` +
  `complete question of at most ${STARTER_WORD_CAP} words ending in a question mark, each ` +
  "answerable by one SELECT against the listed tables, phrased in plain words the way a " +
  "person types (say orders, not order_v2), none a generic row count, none naming a table " +
  "that is not listed, none repeating another. Prefer trends over time, joins between the " +
  `listed tables, and distributions over status-like columns. Output ONLY the ${STARTER_POOL_SIZE} ` +
  "lines. No numbering, no bullets, no commentary.";

/** the one user message of the starter call */
export function starterMessage(summary: StarterSummary): string {
  return `Tables, largest first (${summary.tables.length} shown):\n${summary.text}`;
}

// ---- parser -----------------------------------------------------------------

const BULLET = /^[\s\-*•>]+|^\d+[.)]\s*|^Q\d*[:.)]\s*/i;
const QUOTES = /^["'“”‘’]+|["'“”‘’,]+$/g;
const LEAD_IN = /^(here (are|is)|these (are|questions)|sure|okay|certainly)\b/i;
/** the generic row count in every costume: "How many rows in each table?",
 * "What is the row count of every table?", "How many tables are there?" */
const GENERIC = /\brows?\b[^?]*\b(each|every|per|all)\b[^?]*\btables?\b|\btables?\b[^?]*\b(row counts?|rows)\b|\bhow many tables\b/i;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const wordCount = (s: string) => s.split(/\s+/).filter(Boolean).length;
const normKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** a JSON array of strings anywhere in the reply, else null */
function jsonStrings(text: string): string[] | null {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end <= start) return null;
  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1));
    if (!Array.isArray(parsed)) return null;
    const strings = parsed.filter((x): x is string => typeof x === "string");
    return strings.length > 0 ? strings : null;
  } catch {
    return null;
  }
}

/** The model's reply as starter questions: a JSON array or one question per
 * line, bullets, numbering and quotes stripped; each a question of at most
 * STARTER_WORD_CAP words; never the generic row count, never a question that
 * names a banned relation (a partition, a LEGACY twin, the migration ledger,
 * matched as a whole identifier so `order_v2` never bans "orders"); no
 * duplicates; at most `cap`. */
export function parseStarters(
  text: string,
  banned: readonly string[] = [],
  cap = STARTER_POOL_SIZE,
): string[] {
  const items = jsonStrings(text) ?? text.split("\n");
  const bans = banned
    .filter((n) => n.trim() !== "")
    .map((n) => new RegExp(`(^|[^A-Za-z0-9_])${escapeRe(n)}([^A-Za-z0-9_]|$)`, "i"));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of items) {
    if (out.length === cap) break;
    const line = raw.replace(BULLET, "").replace(QUOTES, "").replace(/\s+/g, " ").trim();
    if (!line || line.length > QUESTION_CHAR_CAP || !line.endsWith("?")) continue;
    if (LEAD_IN.test(line)) continue;
    if (wordCount(line) > STARTER_WORD_CAP) continue;
    if (GENERIC.test(line)) continue;
    if (bans.some((re) => re.test(line))) continue;
    const key = normKey(line);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line);
  }
  return out;
}

// ---- the call ---------------------------------------------------------------

export interface StarterRequest {
  snapshot: SchemaSnapshot;
  provider: Provider;
  model: string;
  signal: AbortSignal;
}

/** One tool-less call for the pool; [] on refusal, error, abort or an empty
 * schema. Never throws: the heuristic pool is the answer to every failure. */
export async function generateStarters(req: StarterRequest): Promise<string[]> {
  if (req.provider.ownsLoop || req.signal.aborted) return [];
  const summary = starterSummary(req.snapshot);
  if (summary.tables.length === 0) return [];
  let text = "";
  try {
    const stream = req.provider.chat({
      system: STARTER_SYSTEM_PROMPT,
      messages: [{ role: "user", content: starterMessage(summary) }],
      tools: [],
      model: req.model,
      signal: req.signal,
    });
    for await (const ev of stream as AsyncIterable<AgentEvent>) {
      if (req.signal.aborted) return [];
      if ("text" in ev) text += ev.text;
      else if ("error" in ev) return [];
    }
  } catch {
    return [];
  }
  return parseStarters(text, summary.banned);
}
