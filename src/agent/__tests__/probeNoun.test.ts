// The probe chip's noun (probeNoun.ts) over the shapes the eval benches and
// the prompt's own examples produce: min/max of a timestamp, a count under a
// filter, a distinct list, a grouped count, a subquery, a CTE, functions
// whose arguments hide clause words (extract … from, cast … as), qualified
// and quoted names, and the statements that name no column at all. Then the
// loop: a probe call's toolStart label carries the noun.

import { describe, expect, test } from "bun:test";
import { probeNoun } from "../probeNoun";
import { runAsk, type AskEvent } from "../loop";
import type { AgentEvent, ChatRequest, Provider, StopReason } from "../providers/types";
import type { AgentTools, ToolOutcome } from "../tools";
import type { SchemaSnapshot } from "../../stores/schema";
import snapshotJson from "./fixtures/pagila-snapshot.json";

describe("probeNoun: the SELECT list names the subject", () => {
  test("min and max of a timestamp", () => {
    expect(probeNoun(["SELECT min(sent_at), max(sent_at) FROM notification_history"])).toBe("sent_at");
  });
  test("a distinct list", () => {
    expect(probeNoun(["SELECT DISTINCT payment_status FROM order_v2"])).toBe("payment_status");
  });
  test("a grouped count", () => {
    expect(probeNoun(["SELECT payment_status, count(*) FROM order_v2 GROUP BY 1 ORDER BY 2 DESC LIMIT 5"])).toBe(
      "payment_status",
    );
  });
  test("the SELECT list outranks the filter", () => {
    expect(probeNoun(["SELECT min(created_at), max(created_at) FROM users WHERE NOT is_deleted"])).toBe("created_at");
  });
  test("a function around the column, an alias after it", () => {
    expect(probeNoun(["SELECT date_trunc('month', sent_at)::date AS month, count(*) FROM t GROUP BY 1"])).toBe("sent_at");
    expect(probeNoun(["SELECT to_char(payment_date, 'YYYY-MM') AS month, SUM(amount) AS total FROM payment GROUP BY 1"])).toBe(
      "payment_date",
    );
  });
  test("extract's FROM and cast's AS are arguments, not clauses", () => {
    expect(probeNoun(["SELECT extract(year from created_at) AS year, count(*) FROM users GROUP BY 1"])).toBe("created_at");
    expect(probeNoun(["SELECT CAST(rental_count AS numeric) FROM weekly"])).toBe("rental_count");
    expect(probeNoun(["SELECT x::timestamp with time zone, y FROM t"])).toBe("x");
  });
  test("a CASE reads its first tested column", () => {
    expect(probeNoun(["SELECT CASE WHEN amount > 100 THEN 'big' ELSE 'small' END AS size, count(*) FROM payment GROUP BY 1"])).toBe(
      "amount",
    );
  });
  test("qualified and quoted names keep their last segment and spelling", () => {
    expect(probeNoun(["SELECT c.name, count(*) FROM category c GROUP BY c.name"])).toBe("name");
    expect(probeNoun(['SELECT "Month", count(*) FROM "Sales" GROUP BY 1'])).toBe("Month");
    expect(probeNoun(["SELECT count(*) FROM public.users u WHERE u.created_at > u.deleted_at"])).toBe("created_at");
  });
});

describe("probeNoun: a count under a filter names the filtered column", () => {
  test("count(*) with WHERE", () => {
    expect(probeNoun(["SELECT count(*) FROM rental WHERE rental_date < '2005-01-01'"])).toBe("rental_date");
    expect(probeNoun(["SELECT count(*) FROM sessions WHERE started_at > now() - interval '1 day'"])).toBe("started_at");
    expect(probeNoun(["SELECT count(*) FROM orders WHERE created_at < signup_at"])).toBe("created_at");
  });
  test("a FILTER clause is a WHERE", () => {
    expect(probeNoun(["SELECT count(*) FILTER (WHERE opened_at IS NULL) FROM notification_history"])).toBe("opened_at");
  });
  test("a subquery's SELECT list counts", () => {
    expect(
      probeNoun(["SELECT count(*) FROM (SELECT customer_id FROM rental GROUP BY 1 HAVING count(*) > 1) s"]),
    ).toBe("customer_id");
  });
  test("a CTE's SELECT list counts first", () => {
    expect(
      probeNoun([
        "WITH weekly AS (SELECT date_trunc('week', rental_date)::date AS wk, count(*) AS n FROM rental GROUP BY 1) SELECT wk, n FROM weekly",
      ]),
    ).toBe("rental_date");
  });
  test("GROUP BY when SELECT and WHERE name nothing", () => {
    expect(probeNoun(["SELECT count(*) FROM t GROUP BY region"])).toBe("region");
  });
});

describe("probeNoun: fallbacks", () => {
  test("no column: the first table", () => {
    expect(probeNoun(["SELECT count(*) FROM payment"])).toBe("payment");
    expect(probeNoun(["SELECT * FROM public.film LIMIT 5"])).toBe("film");
    expect(probeNoun(["SELECT count(*) FROM rental r JOIN inventory i ON r.inventory_id = i.inventory_id"])).toBe("rental");
  });
  test("no column and no table: nothing", () => {
    expect(probeNoun(["SELECT 1"])).toBeNull();
    expect(probeNoun(["SELECT now()"])).toBeNull();
    expect(probeNoun([])).toBeNull();
    expect(probeNoun([""])).toBeNull();
    expect(probeNoun(["   "])).toBeNull();
  });
  test("only the first statement speaks", () => {
    expect(probeNoun(["SELECT count(*) FROM film", "SELECT min(release_year) FROM film"])).toBe("film");
  });
  test("comments and strings are skipped", () => {
    expect(probeNoun(["-- min(fake_col)\nSELECT /* also fake_col */ min(release_year) FROM film WHERE title <> 'from x'"])).toBe(
      "release_year",
    );
  });
  test("hostile text never throws", () => {
    for (const sql of ["SELECT ((( FROM", "'unterminated", '"unterminated', "$$dollar", ")))", "SELECT a.", "::"]) {
      expect(() => probeNoun([sql])).not.toThrow();
    }
  });
});

// ---- the loop: the chip label carries the noun -----------------------------

const snapshot = snapshotJson as unknown as SchemaSnapshot;
const ok = <T,>(text: string, result: T): ToolOutcome<T> => ({ textForModel: text, result });
const answerText = "There are 1000 films.\n\n```sql\nSELECT count(*) FROM film\n```\nAssumptions: none";

function scripted(turns: AgentEvent[][]): Provider {
  let turn = 0;
  return {
    id: "openai",
    ownsLoop: false,
    chat(_req: ChatRequest): AsyncIterable<AgentEvent> {
      const events = turns[Math.min(turn, turns.length - 1)] ?? [];
      turn++;
      return (async function* () {
        for (const ev of events) yield ev;
      })();
    },
  };
}

const agentTools: AgentTools = {
  async listTables() {
    return ok("film  (~1000 rows)", []);
  },
  async describeTables() {
    return ok("CREATE TABLE film (\n  film_id integer PRIMARY KEY\n);", []);
  },
  async peekValues(table, column) {
    return ok("'G', 'PG'", { table, column, values: ["G", "PG"], more: false, sampled: false });
  },
  async runSql() {
    return ok("count\n1\n(1 rows)", { columns: ["count"], rows: [["1"]], rowCount: 1, capped: false, ms: 3 });
  },
  async probe() {
    return ok("-- probe\ncount\n0\n(1 rows)", []);
  },
};

const call = (id: string, name: string, args: unknown): AgentEvent => ({
  toolCall: { id, name, args: JSON.stringify(args) },
});
const done = (stopReason: StopReason): AgentEvent => ({ done: { stopReason } });

describe("the probe chip", () => {
  test("names its column, its table, or nothing", async () => {
    const events: AskEvent[] = [];
    await runAsk({
      question: "How many films are in the database?",
      snapshot,
      tools: agentTools,
      provider: scripted([
        [
          call("a", "probe", { sqls: ["SELECT min(release_year), max(release_year) FROM film"] }),
          call("b", "probe", { sqls: ["SELECT count(*) FROM film"] }),
          call("c", "probe", { sqls: ["SELECT 1"] }),
          call("d", "probe", { sqls: [] }),
          done("toolCalls"),
        ],
        [call("e", "run_sql", { sql: "SELECT count(*) FROM film" }), done("toolCalls")],
        [{ text: answerText }, done("stop")],
      ]),
      model: "test-model",
      tier: "mid",
      signal: new AbortController().signal,
      onEvent: (e) => events.push(e),
    });
    const labels = events.filter((e) => e.type === "toolStart").map((e) => e.label);
    expect(labels).toEqual(["probe release_year", "probe film", "probe", "probe", "run"]);
  });
});
