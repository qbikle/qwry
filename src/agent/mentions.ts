// The `@` grammar (ROADMAP W6): what the composer parses, what the popover
// inserts, what the loop sends. Pure and runtime-free by law (AGENT-SPEC
// section 2 rule 2): never a network call, never a store import, never a
// cache. The caller passes what it already has (the connection's snapshot,
// the visible saved queries, the connection's threads) and every resolution
// builds its Maps for that one call, because a mention resolved against
// yesterday's schema is exactly the stale-cache refusal LESSONS 5 forbids:
// a tag that stops resolving becomes plain text and the question still runs.
//
// Serialize and parse are born as a pair (LESSONS 1): canonicalToken() writes
// what parseMentions() reads back, quotes doubled the way Postgres doubles
// them, and mentions.test.ts walks names through both.
//
// The ladder has seven rungs: table, column, saved query, thread, canvas block
// (A3), canvas (B2, its own kind since B3). The two canvas rungs are last and
// are the only ones naming something the user built rather than something the
// connection has, so a saved query and a block of one name still send the
// saved query, and a rung added after them never re-decides a collision that
// already had an answer.
//
// B3 gives the canvas its own kind rather than a flag inside BlockRef: a
// canvas is the one tag that names where an ANSWER GOES, not what a question
// is about, so it sends no `TAGGED BY THE USER:` line at all (the `CANVAS:`
// block describes the canvas, once, DESIGN rule 14) while a block sends its
// statement and its shape. A boolean deciding which of two contexts a kind
// writes was a kind doing two jobs; kinds 6 -> 7, flags 1 -> 0.
//
// Two words that look alike and are not: `token` is what the user tagged
// WITHOUT the leading `@` (`order_v2`, `users.email`, `"Monthly revenue"`),
// which is what the trace's tagged line prints; canonicalToken() returns what
// the popover INSERTS, which is `@` + that.
//
// B2 adds the picker's five PATHS to the grammar: `@tables/order_v2`,
// `@columns/order_v2.total`, `@saved/"Orders by day"`, `@canvases/"August
// finance"`, `@threads/"is the USD share growing"`. A path is a route through
// the completion, never a namespace: it is stripped before anything else
// looks at the tag, so `@tables/order_v2` and `@order_v2` are the same
// Mention with the same `token`, and the resolve ladder, the TAGGED block,
// the trace's tagged line, the prefilter's must-include list, the eval's
// byte-identical messages and the bubble's pill all read exactly what they
// read before B2. The typed glyphs still own the span, so the pill in the
// draft paints over the path the user can see.

import type { SchemaSnapshot, TableInfo } from "../stores/schema";
import type { SavedQuery } from "../stores/saved";
import type { MentionKind, Thread } from "./types";
import type { ImageRoute } from "./providers/types";
import { handleOf } from "./tools";

/** `[start, end)` over the question text, the leading `@` included: the
 * backdrop paints one pill over exactly these glyphs. */
export type Span = [number, number];

/** A relation, as the snapshot spells it (never as the user typed it). */
export interface TableRef {
  schema: string;
  table: string;
}

export interface ColumnRef {
  schema: string;
  table: string;
  column: string;
}

export interface SavedRef {
  id: string;
  name: string;
  sql: string;
}

/** A canvas block, as its document holds it (A3 item 4). The one kind that
 * names something the USER built: a block is not a thing the connection has,
 * so it never comes off the snapshot and the caller hands the visible ones
 * over like everything else here. `name` is what the token quotes (a result
 * block's question line, a note's first line); the rest is what the model is
 * given about it. */
export interface BlockRef {
  id: string;
  name: string;
  /** the statement the block ran; absent on a note */
  sql?: string | null;
  /** the run's columns, the shape half of what the model is told */
  columns?: readonly string[];
  rowCount?: number | null;
  /** a note's own words: what a note carries instead of a run */
  text?: string | null;
  /** C2b: this block is a SHEET OF INK. The one ref whose content is not a
   * sentence, and the flag rather than the picture on purpose: a PNG frozen
   * here at the moment `Ask` was pressed and a PNG `canvas_read` renders at
   * the moment it is called are two pictures of one drawing, and a stroke
   * drawn between the press and the send would make the two doors disagree
   * about a sheet the user is looking at (LESSONS 13). So the ref names the
   * drawing and the DOCUMENT is read when the picture is actually wanted */
  drawing?: true;
  /** C2b: the canvas that holds this block. A block's pill implies its canvas
   * (AGENT-UX 16l's fifth route), which is what lets a question about a
   * drawing offer `canvas_read` on the one wire that carries a picture by
   * tool and no other way. Absent on a ref remembered before this wave */
  canvasId?: string;
}

/** A canvas document, by the title its tab wears (B2), the ladder's seventh
 * kind (B3). The caller hands over the ones a question may name, like every
 * other rung; a canvas whose tab is closed is not one of them, and a tag
 * naming it stays plain text (LESSONS 5). The model is told nothing here: the
 * tag is a DESTINATION, and where the answer goes is stated once, by the
 * `CANVAS:` block the loop appends for the target this tag resolved to
 * (canvas-agent-spec 3.3). Reading the document is a tool, not a paste. */
export interface CanvasRef {
  id: string;
  title: string;
}

export interface ThreadRef {
  id: string;
  title: string;
  /** the thread's exchanges as the tag block sends them (Q / SQL / A each).
   * The resolver never sets it: a replay is an appdb read and this module
   * does none. The store fills it in on the way to the loop, and nothing
   * else reads it. */
  replay?: string;
}

/** A query tab, by the name it wore when `Explain with Ask` fired. The
 * statement is NOT here: it travelled in the exchange's own context line and
 * stands in the trace, and the pill names what was sent (AGENT-UX 15). */
export interface TabRef {
  name: string;
}

/** One resolved tag. The ref is the thing itself, so no consumer ever splits
 * a dotted string back apart (LESSONS 4). */
export type Mention =
  | { span: Span; token: string; kind: "table"; ref: TableRef }
  | { span: Span; token: string; kind: "column"; ref: ColumnRef }
  | { span: Span; token: string; kind: "saved"; ref: SavedRef }
  | { span: Span; token: string; kind: "thread"; ref: ThreadRef }
  | { span: Span; token: string; kind: "tab"; ref: TabRef }
  | { span: Span; token: string; kind: "block"; ref: BlockRef }
  | { span: Span; token: string; kind: "canvas"; ref: CanvasRef };

/** The five paths the completion offers as rows and accepts as typed
 * prefixes (B2 item 2), in the order the box draws them. */
export const MENTION_PATHS = ["tables", "columns", "saved", "canvases", "threads"] as const;
export type MentionPath = (typeof MENTION_PATHS)[number];

/** One `@…` span the grammar found, before anything is known about what it
 * names. An unresolved one is plain text: no chip, no context. */
export interface RawMention {
  span: Span;
  /** the text after the `@` and after any `kind/` path, as typed:
   * `order_v2`, `users.email`, `"Monthly revenue"` (escapes included). The
   * path is NOT here: it is how the tag was reached, not what it names */
  token: string;
  /** the path typed after the `@`, null when the tag is bare. Kept so the
   * completion can tell where the caret stands; resolution ignores it */
  path: MentionPath | null;
  /** an identifier path's segments; empty for a quoted name */
  parts: string[];
  /** a quoted name with its `""` escapes resolved; null for a path */
  name: string | null;
}

/** What resolution needs, all of it from the caller (never fetched here).
 * `saved` is the connection's visible bookmarks and `threads` its threads in
 * the Threads sheet's own order, newest first. */
export interface MentionCtx {
  snapshot: SchemaSnapshot | null | undefined;
  saved: readonly SavedQuery[];
  threads: readonly Thread[];
  /** the thread being asked in: never its own context */
  currentThreadId?: string | null;
  /** the canvas blocks a question may name (A3). Optional: a caller with no
   * canvas open passes none, and the rung simply has nothing on it */
  blocks?: readonly BlockRef[];
  /** the canvases a question may name (B2), in the order their tabs stand.
   * Optional on the same terms */
  canvases?: readonly CanvasRef[];
}

/** One segment of the question: a run of plain text, or a mention's own
 * glyphs with the mention that claimed them. */
export interface MentionSegment {
  text: string;
  mention?: Mention;
}

/** How much of a saved query's SQL and of a tagged thread's replay the model
 * is given. A page and a half of text each: enough for the query or the four
 * or five exchanges a tag actually refers to, small enough that two tags
 * cannot bury the question they belong to. */
export const MENTION_TEXT_CAP = 1500;

const PUBLIC = "public";

// ---- grammar ---------------------------------------------------------------

/** `@`, an optional `kind/` path (B2), then an identifier path of at most
 * three segments (table, schema.table, table.column, schema.table.column) or
 * `@"a quoted name"` where `""` stands for one quote, as it does in a
 * Postgres identifier. No newline inside the quotes: an unclosed one would
 * otherwise swallow the rest of the draft. A path with nothing after it
 * (`@tables/`) is a fragment mid-typing, not a tag: the alternation fails and
 * the scan falls back to reading `tables` as the name, which is what it is
 * until the next character arrives. */
const MENTION = new RegExp(
  `@(?:(${MENTION_PATHS.join("|")})\\/)?(?:"((?:[^"\\n]|"")*)"|([A-Za-z_][A-Za-z0-9_]*(?:\\.[A-Za-z_][A-Za-z0-9_]*){0,2}))`,
  "g",
);

/** A letter, digit or underscore in ANY script: `a@b` and `नाम@users` are one
 * word each, not a tag. matchAll() iterates over its own copy of the regex,
 * so the `g` flag above keeps no lastIndex between calls (risk.ts's bug). */
const WORDY = /[\p{L}\p{N}_]/u;

const BARE = /^[A-Za-z_][A-Za-z0-9_]*$/;

const quoted = (name: string) => `"${name.replace(/"/g, '""')}"`;

/** Every `@…` span in the text, in reading order. Never overlapping: the
 * scan resumes after each match. */
export function parseMentions(text: string): RawMention[] {
  const out: RawMention[] = [];
  for (const m of text.matchAll(MENTION)) {
    const at = m.index ?? 0;
    if (at > 0 && WORDY.test(text[at - 1])) continue;
    const path = (m[1] ?? null) as MentionPath | null;
    const name = m[2] === undefined ? null : m[2].replace(/""/g, '"');
    // `@""` names nothing, and an empty name would match an unnamed thread
    if (name !== null && name.length === 0) continue;
    out.push({
      span: [at, at + m[0].length],
      // the path is dropped HERE, once, so nothing downstream has to know it
      // existed: the token is the canonical one either way
      token: m[0].slice(1 + (path ? path.length + 1 : 0)),
      path,
      parts: name === null ? m[3].split(".") : [],
      name,
    });
  }
  return out;
}

// ---- resolution ------------------------------------------------------------

interface Index {
  byName: Map<string, TableInfo>;
  byQualified: Map<string, TableInfo>;
}

/** Two Maps over the snapshot's relations, built per call. A bare name
 * prefers `public`, then the snapshot's own order; a qualified one is exact.
 * Every relation the connection has is taggable, whatever its kind: what the
 * popover OFFERS is the popover's rule (no legacy row), and a name the user
 * typed that the database has is not a mistake to swallow. */
function indexTables(snapshot: SchemaSnapshot | null | undefined): Index {
  const byName = new Map<string, TableInfo>();
  const byQualified = new Map<string, TableInfo>();
  for (const t of snapshot?.tables ?? []) {
    const qualified = `${t.schema.toLowerCase()}.${t.name.toLowerCase()}`;
    if (!byQualified.has(qualified)) byQualified.set(qualified, t);
    const bare = t.name.toLowerCase();
    const held = byName.get(bare);
    if (!held || (held.schema !== PUBLIC && t.schema === PUBLIC)) byName.set(bare, t);
  }
  return { byName, byQualified };
}

const columnOf = (t: TableInfo | undefined, name: string): string | null =>
  t?.columns.find((c) => c.name.toLowerCase() === name.toLowerCase())?.name ?? null;

/** Resolve each span in one order and stop at the first hit: table, column,
 * saved query, thread, canvas block, canvas (seven kinds, `tab` never typed).
 * An unresolved span is dropped,
 * which is what leaves it plain text on screen and out of the context block.
 * The two canvas rungs are last because they are the only ones naming
 * something outside the database: a saved query and a block of the same name
 * send the saved query, exactly as they did before the canvas existed, and
 * B2's canvas rung was appended rather than inserted so that no collision
 * that already had an answer got a new one. A path the user typed
 * (`@saved/…`) does not narrow this ladder: it is how the completion was
 * walked, and two spellings of one tag must send one thing. */
export function resolveMentions(raw: readonly RawMention[], ctx: MentionCtx): Mention[] {
  if (raw.length === 0) return [];
  const tables = indexTables(ctx.snapshot);
  const saved = new Map<string, SavedQuery>();
  for (const q of ctx.saved) {
    const key = q.name.toLowerCase();
    if (!saved.has(key)) saved.set(key, q);
  }
  const threads = new Map<string, Thread>();
  for (const t of ctx.threads) {
    if (t.id === ctx.currentThreadId) continue;
    const key = t.title.toLowerCase();
    if (!threads.has(key)) threads.set(key, t);
  }
  const blocks = new Map<string, BlockRef>();
  for (const b of ctx.blocks ?? []) {
    const key = b.name.toLowerCase();
    if (!blocks.has(key)) blocks.set(key, b);
  }
  const canvases = new Map<string, CanvasRef>();
  for (const c of ctx.canvases ?? []) {
    const key = c.title.toLowerCase();
    if (!canvases.has(key)) canvases.set(key, c);
  }

  const out: Mention[] = [];
  for (const one of raw) {
    // a quoted name is one literal identifier: it is never split on its dots,
    // the way "a.b" is one name in Postgres
    const parts = one.name === null ? one.parts : [one.name];
    const bare = parts.length === 1 ? tables.byName.get(parts[0].toLowerCase()) : undefined;
    const qualified =
      parts.length === 2 && one.name === null
        ? tables.byQualified.get(`${parts[0].toLowerCase()}.${parts[1].toLowerCase()}`)
        : undefined;
    const table = qualified ?? bare;
    if (table) {
      out.push({
        span: one.span,
        token: one.token,
        kind: "table",
        ref: { schema: table.schema, table: table.name },
      });
      continue;
    }

    if (one.name === null && (parts.length === 2 || parts.length === 3)) {
      const owner =
        parts.length === 2
          ? tables.byName.get(parts[0].toLowerCase())
          : tables.byQualified.get(`${parts[0].toLowerCase()}.${parts[1].toLowerCase()}`);
      const column = columnOf(owner, parts[parts.length - 1]);
      if (owner && column) {
        out.push({
          span: one.span,
          token: one.token,
          kind: "column",
          ref: { schema: owner.schema, table: owner.name, column },
        });
        continue;
      }
    }

    // the name as typed, quotes stripped: what the Bookmarks list and the
    // Threads sheet show is what the user tagged
    const text = one.name ?? one.token;
    const query = saved.get(text.toLowerCase());
    if (query) {
      out.push({
        span: one.span,
        token: one.token,
        kind: "saved",
        ref: { id: query.id, name: query.name, sql: query.sql },
      });
      continue;
    }
    const thread = threads.get(text.toLowerCase());
    if (thread) {
      out.push({
        span: one.span,
        token: one.token,
        kind: "thread",
        ref: { id: thread.id, title: thread.title },
      });
      continue;
    }
    const block = blocks.get(text.toLowerCase());
    if (block) {
      out.push({ span: one.span, token: one.token, kind: "block", ref: block });
      continue;
    }
    const canvas = canvases.get(text.toLowerCase());
    if (canvas) {
      out.push({ span: one.span, token: one.token, kind: "canvas", ref: canvas });
    }
  }
  return out;
}

/** Parse and resolve in one call: what a render does, where the text and the
 * context arrive together. */
export function mentionsIn(text: string, ctx: MentionCtx): Mention[] {
  return resolveMentions(parseMentions(text), ctx);
}

// ---- rendering -------------------------------------------------------------

/** The question split into plain runs and mention runs, in order, covering
 * every character exactly once. The mention runs carry the TEXT'S OWN glyphs,
 * never the canonical token: the backdrop paints behind what the textarea
 * painted, and a pill that rewrote a letter would move the caret. */
export function mentionSegments(
  text: string,
  mentions: readonly Mention[],
): MentionSegment[] {
  const out: MentionSegment[] = [];
  let at = 0;
  for (const m of [...mentions].sort((a, b) => a.span[0] - b.span[0])) {
    const [start, end] = m.span;
    if (start < at || end > text.length) continue;
    if (start > at) out.push({ text: text.slice(at, start) });
    out.push({ text: text.slice(start, end), mention: m });
    at = end;
  }
  if (at < text.length) out.push({ text: text.slice(at) });
  return out;
}

/** What the popover inserts for a pick: `@users`, `@sales.users` when the
 * schema is not public, `@users.email`, `@"Monthly revenue"`. A saved query
 * and a thread are always quoted, so a one-word name can never be read as a
 * table first. A name outside `[A-Za-z_][A-Za-z0-9_]*` is quoted when it
 * stands alone; the grammar has no quoted PATH, so a column of such a table
 * has no token (the popover does not offer one). */
export function canonicalToken(kind: "table", ref: TableRef): string;
export function canonicalToken(kind: "column", ref: ColumnRef): string;
export function canonicalToken(kind: "saved", ref: SavedRef): string;
export function canonicalToken(kind: "thread", ref: ThreadRef): string;
export function canonicalToken(kind: "tab", ref: TabRef): string;
export function canonicalToken(kind: "block", ref: BlockRef): string;
export function canonicalToken(kind: "canvas", ref: CanvasRef): string;
export function canonicalToken(kind: MentionKind, ref: Mention["ref"]): string {
  // one cast per branch: the overloads above are the contract callers see
  switch (kind) {
    case "table": {
      const r = ref as TableRef;
      const path = r.schema === PUBLIC ? [r.table] : [r.schema, r.table];
      return path.every((p) => BARE.test(p))
        ? `@${path.join(".")}`
        : `@${quoted(path.length === 1 ? r.table : path.join("."))}`;
    }
    case "column": {
      const r = ref as ColumnRef;
      const path = r.schema === PUBLIC ? [r.table, r.column] : [r.schema, r.table, r.column];
      return `@${path.join(".")}`;
    }
    case "saved":
      return `@${quoted((ref as SavedRef).name)}`;
    case "thread":
      return `@${quoted((ref as ThreadRef).title)}`;
    // never typed and never offered by the popover: the two Explain entries
    // write it, and the echo reads it back off the exchange (AGENT-UX 15)
    case "tab":
      return `@${quoted((ref as TabRef).name)}`;
    case "block":
      return `@${quoted((ref as BlockRef).name)}`;
    // quoted by its title, the same form everything the user built wears:
    // `@"Canvas 4"` is the canonical target token B2's `@canvases/"Canvas 4"`
    // canonicalises to (canvas-agent 3.4)
    case "canvas":
      return `@${quoted((ref as CanvasRef).title)}`;
  }
}

// ---- the context block (AGENT-SPEC section 4.2) ----------------------------

/** the same thing tagged twice is one line of context */
function refKey(m: Mention): string {
  switch (m.kind) {
    case "table":
      return `table:${m.ref.schema}.${m.ref.table}`;
    case "column":
      return `column:${m.ref.schema}.${m.ref.table}.${m.ref.column}`;
    case "saved":
      return `saved:${m.ref.id}`;
    case "thread":
      return `thread:${m.ref.id}`;
    case "tab":
      return `tab:${m.ref.name}`;
    case "block":
      return `block:${m.ref.id}`;
    case "canvas":
      return `canvas:${m.ref.id}`;
  }
}

/** Text the model reads, so a cut says so: a silently halved query reads as
 * the whole query and is answered as one (LESSONS 9). Exported because the
 * app's own composed context lines (a tab's statement, A2 item 5) ride under
 * the same header and must cut by the same rule. */
export const clip = (text: string) =>
  text.length <= MENTION_TEXT_CAP
    ? text
    : `${text.slice(0, MENTION_TEXT_CAP)}\n… (truncated)`;

/** What a tagged DRAWING's line says, which depends entirely on how the
 * picture is travelling on THIS run (providers `imageRouteFor`). Three wires,
 * three sentences, and each of them true where it is printed: a line claiming
 * an attachment on a wire that carries none is the exact lie maintainer call
 * 3 forbids, and it is the model that pays for it. */
const drawingSaid = (id: string, route: ImageRoute): string =>
  route === "message"
    ? "a drawing, attached as an image"
    : route === "tool"
      ? `a drawing: call canvas_read with block_id ${handleOf(id)} to see it`
      : "a drawing; its picture cannot travel on this connection";

/** The lines under `TAGGED BY THE USER:` (prompt.ts owns that header): one
 * per tag, in the order they were typed, a table and a column naming
 * themselves and a saved query and a thread carrying their text. Empty when
 * nothing was tagged, which is what keeps the header off the message.
 *
 * `route` is how a picture travels on this run, and the ONLY thing a drawing
 * ref's line is built from: the caller reads it once (loop.ts) and the trace
 * prints the same answer, so the words the model gets and the words the user
 * reads can never disagree. */
export function mentionContext(mentions: readonly Mention[], route: ImageRoute = "message"): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const m of mentions) {
    const key = refKey(m);
    if (seen.has(key)) continue;
    seen.add(key);
    switch (m.kind) {
      case "table":
        lines.push(`table ${m.ref.schema}.${m.ref.table}`);
        break;
      case "column": {
        const owner =
          m.ref.schema === PUBLIC ? m.ref.table : `${m.ref.schema}.${m.ref.table}`;
        lines.push(`column ${owner}.${m.ref.column}`);
        break;
      }
      case "saved": {
        const sql = m.ref.sql.trim();
        lines.push(sql ? `saved query "${m.ref.name}":\n${clip(sql)}` : `saved query "${m.ref.name}"`);
        break;
      }
      case "thread": {
        const replay = (m.ref.replay ?? "").trim();
        lines.push(replay ? `thread "${m.ref.title}":\n${clip(replay)}` : `thread "${m.ref.title}"`);
        break;
      }
      // the statement rides the exchange's own context line beside these
      // (stores/agent explainWithAsk), so the tag says only which tab
      case "tab":
        lines.push(`query tab "${m.ref.name}"`);
        break;
      // a canvas is a destination, not context: the `CANVAS:` block the loop
      // appends names it, describes it and carries its outline, so a line
      // here would be the same fact in a second slot (DESIGN rule 14), and
      // what is ON it is a tool's answer rather than a paste (B3)
      case "canvas":
        break;
      case "block": {
        // the block's own record: what it asked, what it ran, and the SHAPE
        // of what came back. Never the rows: the block stands on the canvas
        // beside the answer, and a paste of its table would be the same data
        // in a second slot (DESIGN rule 14)
        const parts = [`canvas block "${m.ref.name}"`];
        const sql = m.ref.sql?.trim();
        if (sql) parts.push(clip(sql));
        const columns = m.ref.columns ?? [];
        const rows = m.ref.rowCount == null ? null : `${m.ref.rowCount} row${m.ref.rowCount === 1 ? "" : "s"}`;
        const shape = columns.length > 0 ? `${rows ? `${rows}: ` : ""}${columns.join(", ")}` : rows;
        if (shape) parts.push(shape);
        const note = m.ref.text?.trim();
        if (note) parts.push(clip(note));
        // a drawing has no words and no run: the line says where the picture
        // IS, in the words of the route it is actually on. Saying so beats
        // sending an image block with nothing naming it, and beats naming an
        // attachment the wire never carried
        if (m.ref.drawing) parts.push(drawingSaid(m.ref.id, route));
        lines.push(parts.length === 1 ? parts[0] : `${parts[0]}:\n${parts.slice(1).join("\n")}`);
        break;
      }
    }
  }
  return lines.join("\n");
}

/** The drawings the tags name, in the order they were typed and deduped by
 * the ref key `mentionContext` dedupes by, so a drawing tagged twice is one
 * picture and one line. What comes back is the BLOCK, never a rendered PNG:
 * this file is pure and the document is a store, so the caller renders each
 * one at the moment it sends (stores/agent `runInto`) and both doors onto a
 * sheet read the same document at the same instant (LESSONS 13). Kept beside
 * the lines so the words and the pictures of one question are built by one
 * grammar (DESIGN rule 14). */
export function mentionDrawings(mentions: readonly Mention[]): { id: string; canvasId?: string }[] {
  const seen = new Set<string>();
  const out: { id: string; canvasId?: string }[] = [];
  for (const m of mentions) {
    if (m.kind !== "block" || !m.ref.drawing) continue;
    const key = refKey(m);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ id: m.ref.id, ...(m.ref.canvasId ? { canvasId: m.ref.canvasId } : {}) });
  }
  return out;
}

/** What the trace's context step carries, and what its summary line prints:
 * the kind that decides how a tag was sent, and the token without its `@`. */
export function mentionTags(mentions: readonly Mention[]): { kind: MentionKind; token: string }[] {
  return mentions.map((m) => ({ kind: m.kind, token: m.token }));
}
