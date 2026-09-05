import { describe, expect, test } from "bun:test";
import { noun, starterQuestions } from "../starters";
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
