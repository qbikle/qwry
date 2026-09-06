// The `@` grammar and its resolution (ROADMAP W6). The rules under test are
// the ones a UI can only get wrong once: what is a mention (a word boundary,
// a trailing dot, a quote that never closes), what a mention resolves to and
// in which order, and the pair rule (LESSONS 1) that canonicalToken() writes
// only what parseMentions() reads back.

import { describe, expect, test } from "bun:test";
import {
  MENTION_TEXT_CAP,
  type Mention,
  canonicalToken,
  mentionContext,
  mentionSegments,
  mentionTags,
  mentionsIn,
  parseMentions,
  resolveMentions,
} from "../mentions";
import type { SavedQuery } from "../../stores/saved";
import type { ColumnInfo, SchemaSnapshot, TableInfo } from "../../stores/schema";
import type { Thread } from "../types";

// ---- fixtures ---------------------------------------------------------------

const column = (name: string, type = "text", attnum = 1): ColumnInfo => ({
  name,
  attnum,
  type,
  type_oid: 25,
  not_null: false,
  default: null,
});

let oid = 1;
const table = (schema: string, name: string, cols: string[]): TableInfo => ({
  table_oid: oid++,
  schema,
  name,
  kind: "r",
  columns: cols.map((c, i) => column(c, "text", i + 1)),
  pk: [],
});

const snapshot = (tables: TableInfo[]): SchemaSnapshot => ({
  tables,
  foreign_keys: [],
  functions: [],
  schemas: [...new Set(tables.map((t) => t.schema))],
  indexes: [],
  enums: [],
  sequences: [],
  extensions: [],
  server_version_num: 160004,
});

const SNAP = snapshot([
  table("public", "customer", ["customer_id", "email", "first_name"]),
  table("public", "orders", ["id", "total"]),
  table("sales", "orders", ["id", "total", "region"]),
  table("public", "Order Items", ["id", "qty"]),
  table("sales", "Order Items", ["id", "qty"]),
  table("public", "orders_legacy", ["id"]),
]);

const SAVED: SavedQuery[] = [
  { id: "s1", name: "Monthly revenue", sql: "SELECT 1;" },
  { id: "s2", name: "customer", sql: "SELECT 2;" },
  { id: "s3", name: 'He said "hi"', sql: "SELECT 3;" },
];

const thread = (id: string, title: string): Thread => ({
  id,
  profileId: "p",
  title,
  createdAt: "2026-09-06T00:00:00Z",
});

const THREADS = [
  thread("t1", "how many orders were refunded in August"),
  thread("t2", "Monthly revenue"),
  thread("t3", "the current one"),
];

const CTX = { snapshot: SNAP, saved: SAVED, threads: THREADS, currentThreadId: "t3" };

const kinds = (text: string) => mentionsIn(text, CTX).map((m) => `${m.kind}:${m.token}`);

// ---- grammar ----------------------------------------------------------------

describe("the grammar", () => {
  test("an `@` inside a word is not a tag, in any script", () => {
    expect(parseMentions("a@b")).toEqual([]);
    expect(parseMentions("write to sales@orders.com")).toEqual([]);
    expect(parseMentions("नाम@customer")).toEqual([]);
    // a boundary is anything that is not a letter, a digit or an underscore
    expect(parseMentions("कितने @customer हैं")).toHaveLength(1);
    expect(parseMentions("(@customer)")).toHaveLength(1);
    expect(parseMentions("@customer")).toHaveLength(1);
  });

  test("the path stops at three segments and never eats a trailing dot", () => {
    expect(parseMentions("@users.")[0]).toMatchObject({ token: "users", span: [0, 6] });
    expect(parseMentions("@a.b.c.d")[0]).toMatchObject({ token: "a.b.c", parts: ["a", "b", "c"] });
    expect(parseMentions("@users, then")[0].span).toEqual([0, 6]);
    expect(parseMentions("@1users")).toEqual([]);
  });

  test("a quoted name carries its doubled quotes back out", () => {
    const [one] = parseMentions('ask @"He said ""hi""" now');
    expect(one).toMatchObject({
      token: '"He said ""hi"""',
      name: 'He said "hi"',
      parts: [],
    });
    expect(one.span).toEqual([4, 21]);
    expect('ask @"He said ""hi""" now'.slice(4, 21)).toBe('@"He said ""hi"""');
  });

  test("an unclosed quote and an empty name are plain text", () => {
    expect(parseMentions('@"never closed')).toEqual([]);
    expect(parseMentions('@"two\nlines"')).toEqual([]);
    expect(parseMentions('@""')).toEqual([]);
  });

  test("every span is exact and the scan never overlaps", () => {
    const text = 'compare @orders with @"Monthly revenue" for August';
    const raw = parseMentions(text);
    expect(raw.map((r) => text.slice(...r.span))).toEqual(["@orders", '@"Monthly revenue"']);
  });
});

// ---- resolution -------------------------------------------------------------

describe("resolution", () => {
  test("a table by name, case-insensitively, public preferred", () => {
    const [one] = mentionsIn("@CUSTOMER", CTX);
    expect(one).toMatchObject({ kind: "table", ref: { schema: "public", table: "customer" } });
    // `orders` exists in two schemas: the bare name is public's
    expect(mentionsIn("@orders", CTX)[0].ref).toEqual({ schema: "public", table: "orders" });
    expect(mentionsIn("@sales.orders", CTX)[0].ref).toEqual({ schema: "sales", table: "orders" });
  });

  test("a column, qualified or not, keeps the snapshot's own spelling", () => {
    expect(mentionsIn("@customer.EMAIL", CTX)[0]).toMatchObject({
      kind: "column",
      ref: { schema: "public", table: "customer", column: "email" },
    });
    expect(mentionsIn("@sales.orders.region", CTX)[0].ref).toEqual({
      schema: "sales",
      table: "orders",
      column: "region",
    });
  });

  test("the ladder stops at the first hit: table, column, saved query, thread", () => {
    // `customer` is a table AND a saved query: the table wins
    expect(kinds("@customer")).toEqual(["table:customer"]);
    // `Monthly revenue` is a saved query AND a thread title: the query wins
    expect(kinds('@"Monthly revenue"')).toEqual(['saved:"Monthly revenue"']);
    expect(kinds('@"how many orders were refunded in August"')).toEqual([
      'thread:"how many orders were refunded in August"',
    ]);
    // a saved query out of a bare token, when nothing owns the name first
    expect(
      resolveMentions(parseMentions("@revenue"), {
        ...CTX,
        saved: [{ id: "s9", name: "Revenue", sql: "SELECT 9;" }],
      })[0],
    ).toMatchObject({ kind: "saved", ref: { id: "s9" } });
  });

  test("the current thread is never its own context", () => {
    expect(kinds('@"the current one"')).toEqual([]);
    expect(
      resolveMentions(parseMentions('@"the current one"'), { ...CTX, currentThreadId: null }),
    ).toHaveLength(1);
  });

  test("a quoted name is one identifier: never split, never a path", () => {
    expect(kinds('@"customer"')).toEqual(['table:"customer"']);
    expect(kinds('@"sales.orders"')).toEqual([]);
    expect(kinds('@"customer.email"')).toEqual([]);
  });

  test("what nothing owns stays plain text, and costs the question nothing", () => {
    expect(kinds("@nope and @customer.nope and @sales.nope.id")).toEqual([]);
    // no snapshot, no table: the ladder simply runs out (it never throws)
    expect(resolveMentions(parseMentions("@orders"), { ...CTX, snapshot: null })).toEqual([]);
    expect(mentionsIn("plain words", CTX)).toEqual([]);
  });

  test("resolution reads the snapshot it is handed, never a cached one", () => {
    const before = mentionsIn("@orders", CTX);
    const after = mentionsIn("@orders", { ...CTX, snapshot: snapshot([table("sales", "orders", ["id"])]) });
    expect(before[0].ref).toEqual({ schema: "public", table: "orders" });
    expect(after[0].ref).toEqual({ schema: "sales", table: "orders" });
  });
});

// ---- what the UI renders ----------------------------------------------------

describe("segments", () => {
  test("every character lands in exactly one segment, in order", () => {
    const text = 'compare @orders with @"Monthly revenue" for August';
    const segments = mentionSegments(text, mentionsIn(text, CTX));
    expect(segments.map((s) => s.text).join("")).toBe(text);
    expect(segments.filter((s) => s.mention).map((s) => s.text)).toEqual([
      "@orders",
      '@"Monthly revenue"',
    ]);
  });

  test("a segment carries the text's own glyphs, not the canonical token", () => {
    const text = "@CUSTOMER counts";
    const [first] = mentionSegments(text, mentionsIn(text, CTX));
    expect(first.text).toBe("@CUSTOMER");
    expect(first.mention?.kind).toBe("table");
  });

  test("nothing resolved is one plain segment; an empty draft is none", () => {
    expect(mentionSegments("just words", [])).toEqual([{ text: "just words" }]);
    expect(mentionSegments("", [])).toEqual([]);
  });

  test("a span the text no longer has is dropped, not sliced", () => {
    const stale = mentionsIn("@customer is here", CTX);
    expect(mentionSegments("no", stale)).toEqual([{ text: "no" }]);
  });
});

describe("canonicalToken", () => {
  test("the schema shows only when it is not public", () => {
    expect(canonicalToken("table", { schema: "public", table: "customer" })).toBe("@customer");
    expect(canonicalToken("table", { schema: "sales", table: "orders" })).toBe("@sales.orders");
    expect(canonicalToken("column", { schema: "public", table: "customer", column: "email" })).toBe(
      "@customer.email",
    );
    expect(canonicalToken("column", { schema: "sales", table: "orders", column: "region" })).toBe(
      "@sales.orders.region",
    );
  });

  test("a saved query and a thread are always quoted, so a one-word name is never a table", () => {
    expect(canonicalToken("saved", { id: "s1", name: "Monthly revenue", sql: "" })).toBe(
      '@"Monthly revenue"',
    );
    expect(canonicalToken("thread", { id: "t1", title: "orders" })).toBe('@"orders"');
    expect(canonicalToken("saved", { id: "s3", name: 'He said "hi"', sql: "" })).toBe(
      '@"He said ""hi"""',
    );
  });

  test("what it writes, the grammar reads back: the same thing, every kind", () => {
    const back = (token: string, ref: Mention["ref"]) => {
      const found = mentionsIn(`ask ${token} please`, CTX);
      expect(found).toHaveLength(1);
      expect(found[0].ref).toEqual(ref);
    };
    const customer = { schema: "public", table: "customer" };
    const salesOrders = { schema: "sales", table: "orders" };
    const spaced = { schema: "public", table: "Order Items" };
    const email = { schema: "public", table: "customer", column: "email" };
    const region = { schema: "sales", table: "orders", column: "region" };
    const query = { id: "s3", name: 'He said "hi"', sql: "SELECT 3;" };
    const other = { id: "t1", title: "how many orders were refunded in August" };
    back(canonicalToken("table", customer), customer);
    back(canonicalToken("table", salesOrders), salesOrders);
    back(canonicalToken("table", spaced), spaced);
    back(canonicalToken("column", email), email);
    back(canonicalToken("column", region), region);
    back(canonicalToken("saved", query), query);
    back(canonicalToken("thread", other), other);
  });

  test("the one thing the grammar cannot spell: a schema-qualified name that needs quotes", () => {
    // there is no quoted PATH form, so `sales."Order Items"` has no token; the
    // popover offers no row it cannot insert
    expect(mentionsIn(canonicalToken("table", { schema: "sales", table: "Order Items" }), CTX)).toEqual([]);
  });
});

// ---- the context block ------------------------------------------------------

describe("the tagged block", () => {
  const tagged = (text: string) => mentionContext(mentionsIn(text, CTX));

  test("one line per tag, in the order they were typed", () => {
    expect(tagged("@orders and @customer.email and @sales.orders.region")).toBe(
      "table public.orders\ncolumn customer.email\ncolumn sales.orders.region",
    );
  });

  test("a saved query carries its SQL, a thread its replay, both named", () => {
    expect(tagged('@"Monthly revenue"')).toBe('saved query "Monthly revenue":\nSELECT 1;');
    const [tag] = mentionsIn('@"how many orders were refunded in August"', CTX);
    const withReplay: Mention = { ...tag, ref: { ...(tag.ref as { id: string; title: string }), replay: "Q: a\nSQL: none\nA: b" } } as Mention;
    expect(mentionContext([withReplay])).toBe(
      'thread "how many orders were refunded in August":\nQ: a\nSQL: none\nA: b',
    );
    // a thread whose turns could not be read is still tagged, by name
    expect(tagged('@"how many orders were refunded in August"')).toBe(
      'thread "how many orders were refunded in August"',
    );
  });

  test("a long query is cut and says so, because a halved query reads as a whole one", () => {
    const sql = `SELECT ${"x".repeat(4000)}`;
    const out = mentionContext([
      { span: [0, 1], token: "q", kind: "saved", ref: { id: "s", name: "Big", sql } },
    ]);
    expect(out.startsWith('saved query "Big":\nSELECT xxx')).toBe(true);
    expect(out.endsWith("\n… (truncated)")).toBe(true);
    expect(out.length).toBe('saved query "Big":\n'.length + MENTION_TEXT_CAP + "\n… (truncated)".length);
  });

  test("the same thing tagged twice is one line", () => {
    expect(tagged("@orders vs @ORDERS")).toBe("table public.orders");
  });

  test("nothing tagged is an empty block, which keeps the header off the message", () => {
    expect(mentionContext([])).toBe("");
    expect(tagged("plain question")).toBe("");
  });

  test("the trace carries the kind and the token, the `@` already gone", () => {
    expect(mentionTags(mentionsIn('@orders and @"Monthly revenue"', CTX))).toEqual([
      { kind: "table", token: "orders" },
      { kind: "saved", token: '"Monthly revenue"' },
    ]);
  });
});
