import { describe, expect, test } from "bun:test";
import { noun, questionKey, rotateStarters, starterPool, starterQuestions } from "../starters";
import type { SchemaSnapshot, TableInfo } from "../../stores/schema";

const col = (name: string, type: string) => ({
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

const snapshot: SchemaSnapshot = {
  tables: [
    table("users", [col("id", "bigint"), col("created_at", "timestamp with time zone")], {
      reltuples: 1_200_000,
    }),
    table("order_v2", [col("id", "bigint"), col("user_id", "bigint"), col("payment_status", "text")], {
      reltuples: 800_000,
    }),
    table("wardrobe_products", [col("id", "bigint")], {
      reltuples: 5_000_000,
      comment: "LEGACY, superseded by wardrobe_products_v2",
    }),
    table("order_v2_p2025", [col("id", "bigint")], { reltuples: 9_000_000, parent_oid: 42 }),
    table("schema_migrations", [col("version", "text")], { reltuples: 400 }),
  ],
  foreign_keys: [
    {
      src_schema: "public",
      src_table: "order_v2",
      src_cols: ["user_id"],
      dst_schema: "public",
      dst_table: "users",
      dst_cols: ["id"],
    },
  ],
  functions: [],
  schemas: ["public"],
  indexes: [],
  enums: [],
};

describe("starterQuestions", () => {
  test("three distinct questions from the schema's real nouns, de-snaked", () => {
    const qs = starterQuestions(snapshot);
    expect(qs).toHaveLength(3);
    expect(new Set(qs).size).toBe(3);
    for (const q of qs) {
      expect(/users|orders/.test(q)).toBe(true);
      expect(q).not.toMatch(/_/);
      expect(q.endsWith("?")).toBe(true);
    }
  });

  test("never the generic row count, never a LEGACY table, a partition or the migration ledger", () => {
    const qs = starterQuestions(snapshot).join("\n");
    expect(qs).not.toContain("How many rows in each table");
    expect(qs).not.toContain("wardrobe products");
    expect(qs).not.toContain("p2025");
    expect(qs).not.toContain("migration");
  });

  test("the FK edge reads parent → child and the status column is prose", () => {
    const qs = starterQuestions(snapshot);
    expect(qs).toContain("Which users have the most orders?");
    expect(qs).toContain("How are orders split by payment status?");
  });

  test("deterministic per snapshot, whatever the table order", () => {
    const shuffled: SchemaSnapshot = { ...snapshot, tables: [...snapshot.tables].reverse() };
    expect(starterQuestions(shuffled)).toEqual(starterQuestions(snapshot));
  });

  test("questions already asked in the thread are skipped", () => {
    const first = starterQuestions(snapshot);
    const again = starterQuestions(snapshot, new Set([first[0]]));
    expect(again).not.toContain(first[0]);
  });

  test("no snapshot, no suggestions", () => {
    expect(starterQuestions(undefined)).toEqual([]);
  });
});

describe("noun", () => {
  test("de-snakes, folds version twins and pluralises the last word", () => {
    expect(noun("users")).toBe("users");
    expect(noun("order_v2")).toBe("orders");
    expect(noun("wardrobe_products_v2")).toBe("wardrobe products");
    expect(noun("category")).toBe("categories");
    expect(noun("search_match")).toBe("search matches");
    expect(noun("VirtualTryOn")).toBe("virtual try ons");
  });
});

/** the harness schema's shape: five dated tables, three with a status-like
 * column, four FK edges into two hubs, so every shape has something to say */
const rich: SchemaSnapshot = {
  ...snapshot,
  tables: [
    table(
      "notification_history",
      [col("id", "bigint"), col("user_id", "bigint"), col("notification_type", "text"), col("channel", "text"), col("sent_at", "timestamp with time zone")],
      { reltuples: 12_000_000 },
    ),
    table("users", [col("id", "bigint"), col("created_at", "timestamp with time zone"), col("signup_source", "text")], {
      reltuples: 1_200_000,
    }),
    table("wardrobes", [col("id", "bigint"), col("user_id", "bigint"), col("created_at", "timestamp with time zone")], {
      reltuples: 842_000,
    }),
    table("wardrobe_products_v2", [col("id", "bigint"), col("wardrobe_id", "bigint"), col("added_at", "timestamp with time zone")], {
      reltuples: 9_800_000,
    }),
    table("sessions", [col("id", "bigint"), col("user_id", "bigint"), col("platform", "text"), col("started_at", "timestamp with time zone")], {
      reltuples: 3_000_000,
    }),
  ],
  foreign_keys: [
    ["notification_history", "user_id", "users"],
    ["wardrobes", "user_id", "users"],
    ["wardrobe_products_v2", "wardrobe_id", "wardrobes"],
    ["sessions", "user_id", "users"],
  ].map(([src, c, dst]) => ({
    src_schema: "public",
    src_table: src,
    src_cols: [c],
    dst_schema: "public",
    dst_table: dst,
    dst_cols: ["id"],
  })),
};

describe("starterPool", () => {
  test("twelve distinct questions over a rich schema, every one in the register", () => {
    const qs = starterPool(rich);
    expect(qs).toHaveLength(12);
    expect(new Set(qs).size).toBe(12);
    for (const q of qs) {
      expect(q.endsWith("?")).toBe(true);
      expect(q).not.toMatch(/_/);
      expect(q.split(/\s+/).length).toBeLessThanOrEqual(12);
    }
    expect(qs.join("\n")).not.toContain("rows in each table");
  });

  test("opens with the three starterQuestions always showed, then the other shapes", () => {
    const qs = starterPool(rich);
    expect(qs.slice(0, 3)).toEqual(starterQuestions(rich));
    expect(qs.slice(0, 3)).toEqual([
      "How many notification histories were added each month this year?",
      "Which users have the most notification histories?",
      "How are notification histories split by notification type?",
    ]);
    expect(qs).toContain("How many users have no notification histories?");
    expect(qs).toContain("How many notification histories were added in the last 30 days?");
    expect(qs).toContain("Which notification type is most common among notification histories?");
    expect(qs).toContain("How many wardrobe products were added each month this year?");
    expect(qs).toContain("How are sessions split by platform?");
  });

  test("a small schema says less rather than repeating itself, and starterQuestions is its first triple", () => {
    const qs = starterPool(snapshot);
    expect(qs.length).toBeGreaterThanOrEqual(6);
    expect(qs.length).toBeLessThanOrEqual(12);
    expect(new Set(qs).size).toBe(qs.length);
    expect(starterQuestions(snapshot)).toEqual(qs.slice(0, 3));
    expect(qs).toContain("How many users have no orders?");
    expect(qs).toContain("Which payment status is most common among orders?");
  });

  test("deterministic per snapshot, whatever the table order; asked questions are out", () => {
    const shuffled: SchemaSnapshot = { ...rich, tables: [...rich.tables].reverse() };
    expect(starterPool(shuffled)).toEqual(starterPool(rich));
    const first = starterPool(rich)[0];
    expect(starterPool(rich, new Set([first]))).not.toContain(first);
    expect(starterPool(undefined)).toEqual([]);
  });
});

describe("rotateStarters", () => {
  const pool = Array.from({ length: 12 }, (_, i) => `Q${i}?`);

  test("three from the cursor, wrapping around the pool", () => {
    expect(rotateStarters(pool, new Set(), 0)).toEqual(["Q0?", "Q1?", "Q2?"]);
    expect(rotateStarters(pool, new Set(), 3)).toEqual(["Q3?", "Q4?", "Q5?"]);
    expect(rotateStarters(pool, new Set(), 11)).toEqual(["Q11?", "Q0?", "Q1?"]);
    expect(rotateStarters(pool, new Set(), 12)).toEqual(["Q0?", "Q1?", "Q2?"]);
    expect(rotateStarters(pool, new Set(), 27_717)).toEqual(["Q9?", "Q10?", "Q11?"]);
  });

  test("questions asked anywhere in the connection are out, compared by key", () => {
    const taken = new Set([questionKey("  q1? "), questionKey("Q2?…"), questionKey("Q4?")]);
    expect(rotateStarters(pool, taken, 0)).toEqual(["Q0?", "Q3?", "Q5?"]);
    expect(questionKey("Which users  have the most orders?…")).toBe("which users have the most orders?");
  });

  test("fewer than three only when fewer remain; nothing when nothing does", () => {
    expect(rotateStarters(["A?", "B?"], new Set(), 5)).toEqual(["B?", "A?"]);
    expect(rotateStarters(["A?"], new Set([questionKey("A?")]), 0)).toEqual([]);
    expect(rotateStarters([], new Set(), 0)).toEqual([]);
  });
});
