// The generated starter pool (W2d): the schema summary and its size guard,
// the tolerant parser and the rules it enforces (the ones starters.test.ts
// pins for the heuristic pool: no generic row count, no partition, no LEGACY
// table), the call against a scripted provider with the refusals that keep it
// a courtesy, and the schema hash a pool is keyed to.

import { describe, expect, test } from "bun:test";
import {
  STARTER_POOL_SIZE,
  STARTER_PROMPT_CHAR_BUDGET,
  STARTER_SYSTEM_PROMPT,
  STARTER_TABLE_CAP,
  STARTER_WORD_CAP,
  generateStarters,
  parseStarters,
  schemaHash,
  starterMessage,
  starterSummary,
} from "../starterPool";
import type { AgentEvent, ChatRequest, Provider } from "../providers/types";
import type { SchemaSnapshot, TableInfo } from "../../stores/schema";

const col = (name: string, type = "text") => ({
  name,
  attnum: 1,
  type,
  type_oid: 0,
  not_null: false,
  default: null,
});

let oid = 1;
const table = (
  name: string,
  columns: ReturnType<typeof col>[],
  extra: Partial<TableInfo> = {},
): TableInfo => ({
  table_oid: oid++,
  schema: "public",
  name,
  kind: "r",
  columns,
  pk: ["id"],
  reltuples: 1000,
  ...extra,
});

const bare = (tables: TableInfo[], foreign_keys: SchemaSnapshot["foreign_keys"] = []): SchemaSnapshot => ({
  tables,
  foreign_keys,
  functions: [],
  schemas: ["public"],
  indexes: [],
  enums: [],
});

const orders = table("order_v2", [col("id", "bigint"), col("user_id", "bigint"), col("payment_status")], {
  reltuples: 800_000,
});
const snapshot = bare(
  [
    table("users", [col("id", "bigint"), col("created_at", "timestamp with time zone")], {
      reltuples: 1_200_000,
    }),
    orders,
    table("wardrobe_products", [col("id", "bigint")], {
      reltuples: 5_000_000,
      comment: "LEGACY, superseded by wardrobe_products_v2",
    }),
    { ...orders, table_oid: 900, name: "order_v2_p2025", reltuples: 9_000_000, parent_oid: orders.table_oid },
    table("schema_migrations", [col("version")], { reltuples: 400 }),
    table("daily_stats", [col("day", "date"), col("orders", "bigint")], { kind: "v", reltuples: -1 }),
  ],
  [
    {
      src_schema: "public",
      src_table: "order_v2",
      src_cols: ["user_id"],
      dst_schema: "public",
      dst_table: "users",
      dst_cols: ["id"],
    },
  ],
);

function scripted(events: AgentEvent[], seen: ChatRequest[] = [], ownsLoop = false): Provider {
  return {
    id: "openai",
    ownsLoop,
    chat(req) {
      seen.push(req);
      return (async function* () {
        for (const ev of events) yield ev;
      })();
    },
  };
}

const TWELVE = [
  "How many users were created each month this year?",
  "Which users have the most orders?",
  "How are orders split by payment status?",
  "How many users have no orders?",
  "How many orders were placed in the last 30 days?",
  "Which payment status is most common?",
  "What are the 20 most recent orders?",
  "How many users placed more than five orders?",
  "Which month had the most new users?",
  "What share of orders are paid?",
  "How many orders does an average user place?",
  "Which users signed up this week?",
];

describe("starterSummary", () => {
  test("the largest askable tables first, views and banned relations out, FK edges in", () => {
    const s = starterSummary(snapshot);
    expect(s.tables).toEqual(["users", "order_v2"]);
    expect(s.text.split("\n")).toEqual([
      "users(id, created_at)  -- ~1200000 rows",
      "order_v2(id, user_id, payment_status)  -- ~800000 rows",
      "order_v2.user_id -> users.id",
    ]);
    expect(s.banned.sort()).toEqual(["order_v2_p2025", "schema_migrations", "wardrobe_products"]);
    expect(s.text.length).toBeLessThanOrEqual(STARTER_PROMPT_CHAR_BUDGET);
  });

  test("a wide schema stays under the budget: at most 25 tables, columns capped, the rest dropped", () => {
    const wide = bare(
      Array.from({ length: 60 }, (_, i) =>
        table(
          `table_${String(i).padStart(2, "0")}`,
          Array.from({ length: 80 }, (_, c) => col(`column_number_${c}_of_this_table`)),
          { reltuples: 100_000 - i },
        ),
      ),
    );
    const s = starterSummary(wide);
    expect(s.tables.length).toBeLessThanOrEqual(STARTER_TABLE_CAP);
    expect(s.tables[0]).toBe("table_00");
    expect(s.text.length).toBeLessThanOrEqual(STARTER_PROMPT_CHAR_BUDGET);
    expect(s.text).toContain("… +");
    // a tighter budget drops tables before it narrows them further
    const tight = starterSummary(wide, 2000);
    expect(tight.text.length).toBeLessThanOrEqual(2000);
    expect(tight.tables.length).toBeGreaterThanOrEqual(1);
    // one table can always be said, whatever the budget
    expect(starterSummary(wide, 10).tables).toHaveLength(1);
  });

  test("the message names the count it shows and carries every line", () => {
    const s = starterSummary(snapshot);
    const msg = starterMessage(s);
    expect(msg.startsWith("Tables, largest first (2 shown):\n")).toBe(true);
    expect(msg).toContain("order_v2.user_id -> users.id");
  });
});

describe("parseStarters", () => {
  test("one question per line, bullets, numbering and quotes stripped, at most twelve", () => {
    const text = TWELVE.map((q, i) => (i % 3 === 0 ? `${i + 1}. ${q}` : i % 3 === 1 ? `- "${q}"` : `• ${q}`))
      .concat(["13) One question too many?"])
      .join("\n");
    const out = parseStarters(text);
    expect(out).toEqual(TWELVE);
    expect(out).toHaveLength(STARTER_POOL_SIZE);
  });

  test("a JSON array is read the same way, commentary around it ignored", () => {
    const text = `Here you go:\n${JSON.stringify(TWELVE.slice(0, 3))}\nAnything else?`;
    expect(parseStarters(text)).toEqual(TWELVE.slice(0, 3));
  });

  test("lead-ins, non-questions, long questions and repeats are dropped", () => {
    const long = Array.from({ length: STARTER_WORD_CAP + 1 }, (_, i) => `w${i}`).join(" ") + "?";
    const text = [
      "Here are twelve questions:",
      "Some commentary without a mark",
      long,
      "Which users have the most orders?",
      "which users have the most orders?",
      "Which users have the most orders",
    ].join("\n");
    expect(parseStarters(text)).toEqual(["Which users have the most orders?"]);
  });

  test("never the generic row count, in any of its costumes", () => {
    const text = [
      "How many rows in each table?",
      "How many rows does every table have?",
      "What is the row count of all tables?",
      "How many tables are there?",
      "How many orders were placed this year?",
    ].join("\n");
    expect(parseStarters(text)).toEqual(["How many orders were placed this year?"]);
  });

  test("a question naming a banned relation is dropped; a folded twin is not", () => {
    const banned = ["order_v2_p2025", "wardrobe_products", "schema_migrations"];
    const text = [
      "How many rows does order_v2_p2025 hold?",
      "What is in wardrobe_products?",
      "Which schema_migrations ran last?",
      "How many wardrobe products were added this month?",
      "How many orders came from order_v2 this week?",
    ].join("\n");
    expect(parseStarters(text, banned)).toEqual([
      "How many wardrobe products were added this month?",
      "How many orders came from order_v2 this week?",
    ]);
  });

  test("empty text and no banned names are fine", () => {
    expect(parseStarters("")).toEqual([]);
    expect(parseStarters("\n\n", [""])).toEqual([]);
  });
});

describe("generateStarters", () => {
  const base = { snapshot, model: "test-model", signal: new AbortController().signal };

  test("one tool-less call carrying the summary, the reply parsed with the schema's bans", async () => {
    const seen: ChatRequest[] = [];
    const provider = scripted(
      [
        { text: TWELVE.slice(0, 6).join("\n") + "\n" },
        { text: "How many rows does order_v2_p2025 hold?\n" + TWELVE.slice(6).join("\n") },
        { usage: { input: 900, output: 120 } },
        { done: { stopReason: "stop" } },
      ],
      seen,
    );
    const out = await generateStarters({ ...base, provider });
    expect(out).toEqual(TWELVE);
    expect(seen).toHaveLength(1);
    expect(seen[0].system).toBe(STARTER_SYSTEM_PROMPT);
    expect(seen[0].tools).toEqual([]);
    expect(seen[0].messages).toHaveLength(1);
    expect(seen[0].messages[0]).toMatchObject({ role: "user" });
    const content = (seen[0].messages[0] as { content: string }).content;
    expect(content).toContain("order_v2(id, user_id, payment_status)");
    expect(content).not.toContain("wardrobe_products(");
    expect(seen[0].model).toBe("test-model");
  });

  test("an ownsLoop provider is never called: the empty state has no thread to resume", async () => {
    const seen: ChatRequest[] = [];
    expect(await generateStarters({ ...base, provider: scripted([], seen, true) })).toEqual([]);
    expect(seen).toHaveLength(0);
  });

  test("a provider error, a thrown stream and an aborted signal each cost only the pool", async () => {
    expect(await generateStarters({ ...base, provider: scripted([{ error: { kind: "rate", message: "slow" } }]) })).toEqual([]);
    const thrower: Provider = {
      id: "openai",
      ownsLoop: false,
      chat() {
        throw new Error("boom");
      },
    };
    expect(await generateStarters({ ...base, provider: thrower })).toEqual([]);
    const ctl = new AbortController();
    ctl.abort();
    const seen: ChatRequest[] = [];
    expect(await generateStarters({ ...base, provider: scripted([], seen), signal: ctl.signal })).toEqual([]);
    expect(seen).toHaveLength(0);
  });

  test("a schema with nothing askable makes no call", async () => {
    const seen: ChatRequest[] = [];
    const empty = bare([table("schema_migrations", [col("version")])]);
    expect(await generateStarters({ ...base, snapshot: empty, provider: scripted([], seen) })).toEqual([]);
    expect(seen).toHaveLength(0);
  });
});

describe("schemaHash", () => {
  test("eight hex digits, stable across table order, changed by a column", () => {
    const h = schemaHash(snapshot);
    expect(h).toMatch(/^[0-9a-f]{8}$/);
    expect(schemaHash({ ...snapshot, tables: [...snapshot.tables].reverse() })).toBe(h);
    const grown: SchemaSnapshot = {
      ...snapshot,
      tables: snapshot.tables.map((t) =>
        t.name === "users" ? { ...t, columns: [...t.columns, col("email")] } : t,
      ),
    };
    expect(schemaHash(grown)).not.toBe(h);
    // row estimates and comments are not shape
    const restated: SchemaSnapshot = {
      ...snapshot,
      tables: snapshot.tables.map((t) => ({ ...t, reltuples: 1, comment: "x" })),
    };
    expect(schemaHash(restated)).toBe(h);
  });
});
