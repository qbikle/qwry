// The turn loop (AGENT-SPEC section 4) against a scripted Provider and a
// scripted AgentTools. Every rule section 7 calls provider-neutral is a test
// here: parallel calls in ONE result message, unparseable arguments and
// unknown tool names answered as text, a turn cap that ends the loop, cancel,
// an ownsLoop provider whose tools the loop must NOT re-execute.

import { describe, expect, test } from "bun:test";
import { runAsk, type AskEvent } from "../loop";
import type {
  AgentEvent,
  ChatRequest,
  Msg,
  Provider,
} from "../providers/types";
import type { AgentTools, ToolOutcome } from "../tools";
import type { AgentRun } from "../types";
import type { SchemaSnapshot } from "../../stores/schema";
import snapshotJson from "./fixtures/pagila-snapshot.json";

const snapshot = snapshotJson as unknown as SchemaSnapshot;

const run = (rowCount = 1): AgentRun => ({
  columns: ["count"],
  rows: [[String(rowCount)]],
  rowCount: 1,
  capped: false,
  ms: 3,
});

const ok = <T,>(text: string, result: T): ToolOutcome<T> => ({ textForModel: text, result });

interface Recorded {
  calls: { name: string; args: unknown }[];
  requests: ChatRequest[];
}

/** A provider that replays one array of events per turn. */
function scripted(
  turns: AgentEvent[][],
  rec: Recorded,
  ownsLoop = false,
): Provider {
  let turn = 0;
  return {
    id: "openai",
    ownsLoop,
    chat(req: ChatRequest): AsyncIterable<AgentEvent> {
      rec.requests.push({ ...req, messages: req.messages.map((m) => ({ ...m }) as Msg) });
      const events = turns[Math.min(turn, turns.length - 1)] ?? [];
      turn++;
      return (async function* () {
        for (const ev of events) yield ev;
      })();
    },
  };
}

function tools(rec: Recorded, over: Partial<AgentTools> = {}): AgentTools {
  const note = (name: string, args: unknown) => rec.calls.push({ name, args });
  return {
    async listTables() {
      note("listTables", null);
      return ok("film  (~1000 rows)", []);
    },
    async describeTables(names) {
      note("describeTables", names);
      return ok("CREATE TABLE film (\n  film_id integer PRIMARY KEY\n);", []);
    },
    async peekValues(table, column, limit) {
      note("peekValues", { table, column, limit });
      return ok("'G', 'PG'", { table, column, values: ["G", "PG"], more: false });
    },
    async runSql(sql) {
      note("runSql", sql);
      return ok("count\n1\n(1 rows)", run());
    },
    async probe(sqls) {
      note("probe", sqls);
      return ok("-- probe\ncount\n0\n(1 rows)", []);
    },
    ...over,
  };
}

const answerText = "There are 1000 films.\n\n```sql\nSELECT count(*) FROM film\n```\nAssumptions: none";

const call = (id: string, name: string, args: unknown): AgentEvent => ({
  toolCall: { id, name, args: JSON.stringify(args) },
});
const done = (stopReason: "stop" | "toolCalls"): AgentEvent => ({ done: { stopReason } });

async function ask(
  provider: Provider,
  agentTools: AgentTools,
  over: Partial<Parameters<typeof runAsk>[0]> = {},
) {
  const events: AskEvent[] = [];
  const answer = await runAsk({
    question: "How many films are in the database?",
    snapshot,
    tools: agentTools,
    provider,
    model: "test-model",
    tier: "mid",
    signal: new AbortController().signal,
    onEvent: (e) => events.push(e),
    ...over,
  });
  return { answer, events };
}

describe("the hybrid path", () => {
  test("parallel tool turn, then run, then answer", async () => {
    const rec: Recorded = { calls: [], requests: [] };
    // describe_tables cannot finish until peek_values has started: a
    // sequential loop would deadlock here rather than quietly pass
    let peekStarted!: () => void;
    const gate = new Promise<void>((resolve) => {
      peekStarted = resolve;
    });
    const t = tools(rec, {
      async describeTables(names) {
        rec.calls.push({ name: "describeTables", args: names });
        await gate;
        return ok("CREATE TABLE film (\n  film_id integer PRIMARY KEY\n);", []);
      },
      async peekValues(table, column) {
        rec.calls.push({ name: "peekValues", args: { table, column } });
        peekStarted();
        return ok("'G', 'PG'", { table, column, values: ["G"], more: false });
      },
    });
    const provider = scripted(
      [
        [
          call("a", "describe_tables", { names: ["film"] }),
          call("b", "peek_values", { table: "film", column: "rating" }),
          done("toolCalls"),
        ],
        [call("c", "run_sql", { sql: "SELECT count(*) FROM film" }), done("toolCalls")],
        [{ text: answerText }, done("stop")],
      ],
      rec,
    );

    const { answer, events } = await ask(provider, t);

    expect(answer.verdict.status).toBe("answered");
    expect(answer.sql).toBe("SELECT count(*) FROM film");
    expect(answer.turns).toBe(3);
    // the model already ran exactly this statement: the user waits for no
    // second execution of it
    expect(rec.calls.filter((c) => c.name === "runSql")).toHaveLength(1);
    // all results of one parallel turn arrive in ONE tool message
    const toolMsgs = rec.requests[1].messages.filter((m) => m.role === "tool");
    expect(toolMsgs).toHaveLength(1);
    expect((toolMsgs[0] as { results: unknown[] }).results).toHaveLength(2);
    // and the chips the strip shows name their objects
    const labels = events.filter((e) => e.type === "toolStart").map((e) => e.label);
    expect(labels).toEqual(["describe film", "peek rating", "run"]);
    expect(answer.assumptions).toEqual([]);
  });

  test("the candidate block and the risk block reach the model", async () => {
    const rec: Recorded = { calls: [], requests: [] };
    const provider = scripted([[{ text: answerText }, done("stop")]], rec);
    await ask(provider, tools(rec), {
      question: "What percentage of films are rated G within 30 days?",
    });
    const first = rec.requests[0].messages[0] as { content: string };
    expect(first.content).toContain("CANDIDATE TABLES (pre-selected from 24 tables");
    expect(first.content).toContain("RISK CHECK REQUIRED");
    expect(first.content).toContain("film(");
  });

  test("a peeked column and a probe fragment become the sanity line", async () => {
    const rec: Recorded = { calls: [], requests: [] };
    const t = tools(rec, {
      async probe(sqls) {
        rec.calls.push({ name: "probe", args: sqls });
        return ok("-- probe", [
          {
            sql: sqls[0],
            run: null,
            error: null,
            fragment: { text: "release year 2006 → 2026", warn: false, sql: sqls[0] },
          },
        ]);
      },
    });
    const provider = scripted(
      [
        [
          call("a", "peek_values", { table: "film", column: "rating" }),
          call("b", "probe", { sqls: ["SELECT min(release_year), max(release_year) FROM film"] }),
          done("toolCalls"),
        ],
        [{ text: answerText }, done("stop")],
      ],
      rec,
    );
    const { answer } = await ask(provider, t);
    expect(answer.sanity.map((f) => f.text)).toEqual([
      "checked rating values",
      "release year 2006 → 2026",
    ]);
  });
});

describe("untrusted tool arguments", () => {
  test("an unknown tool name comes back as text listing the valid ones", async () => {
    const rec: Recorded = { calls: [], requests: [] };
    const provider = scripted(
      [
        [call("a", "drop_everything", {}), done("toolCalls")],
        [{ text: answerText }, done("stop")],
      ],
      rec,
    );
    const { answer } = await ask(provider, tools(rec));
    expect(rec.calls).toEqual([{ name: "runSql", args: "SELECT count(*) FROM film" }]);
    const step = answer.trace.find((s) => s.step === "tool");
    expect(step && step.step === "tool" && step.result).toContain("unknown tool 'drop_everything'");
    expect(step && step.step === "tool" && step.result).toContain("list_tables, describe_tables");
    expect(answer.verdict.status).toBe("answered");
  });

  test("arguments that are not JSON come back as text, not an exception", async () => {
    const rec: Recorded = { calls: [], requests: [] };
    const provider = scripted(
      [
        [{ toolCall: { id: "a", name: "run_sql", args: "{not json" } }, done("toolCalls")],
        [{ text: answerText }, done("stop")],
      ],
      rec,
    );
    const { answer } = await ask(provider, tools(rec));
    const step = answer.trace.find((s) => s.step === "tool");
    expect(step && step.step === "tool" && step.result).toContain("not valid JSON");
    expect(step && step.step === "tool" && step.isError).toBe(true);
  });

  test("a tool called without its required argument is told which one", async () => {
    const rec: Recorded = { calls: [], requests: [] };
    const provider = scripted(
      [
        [call("a", "describe_tables", { tables: ["film"] }), done("toolCalls")],
        [{ text: answerText }, done("stop")],
      ],
      rec,
    );
    const { answer } = await ask(provider, tools(rec));
    const step = answer.trace.find((s) => s.step === "tool");
    expect(step && step.step === "tool" && step.result).toContain("describe_tables needs `names`");
    expect(rec.calls.some((c) => c.name === "describeTables")).toBe(false);
  });
});

describe("failure shapes", () => {
  test("the turn cap ends the loop with a Fix It verdict, never a silent stop", async () => {
    const rec: Recorded = { calls: [], requests: [] };
    const provider = scripted(
      [[call("a", "list_tables", {}), done("toolCalls")]],
      rec,
    );
    const { answer, events } = await ask(provider, tools(rec), { maxTurns: 2 });
    expect(answer.verdict.status).toBe("turn_cap");
    expect(answer.turns).toBe(2);
    expect(events.some((e) => e.type === "error" && e.kind === "turncap")).toBe(true);
  });

  test("a failing statement is fed back once and the repair answers", async () => {
    const rec: Recorded = { calls: [], requests: [] };
    let first = true;
    const t = tools(rec, {
      async runSql(sql) {
        rec.calls.push({ name: "runSql", args: sql });
        if (first) {
          first = false;
          return {
            textForModel: 'ERROR: column "nope" does not exist',
            result: null,
            error: 'column "nope" does not exist',
          };
        }
        return ok("count\n1\n(1 rows)", run());
      },
    });
    const provider = scripted(
      [
        [{ text: "```sql\nSELECT nope FROM film\n```" }, done("stop")],
        [{ text: answerText }, done("stop")],
      ],
      rec,
    );
    const { answer } = await ask(provider, t);
    expect(answer.verdict.status).toBe("answered");
    const sent = rec.requests[1].messages;
    const repair = sent[sent.length - 1] as { content: string };
    expect(repair.content).toContain("That query failed with this error");
    expect(repair.content).toContain('column "nope" does not exist');
  });

  test("a provider error is a failure with the provider's own words", async () => {
    const rec: Recorded = { calls: [], requests: [] };
    const provider = scripted(
      [[{ error: { kind: "rate", message: "rate limited, retry in 30s" } }]],
      rec,
    );
    const { answer, events } = await ask(provider, tools(rec));
    expect(answer.verdict.status).toBe("failed");
    expect(events.some((e) => e.type === "error" && e.kind === "provider")).toBe(true);
  });

  test("cancel stops the loop and says so", async () => {
    const rec: Recorded = { calls: [], requests: [] };
    const controller = new AbortController();
    const provider = scripted(
      [[{ text: "thinking" }, { text: answerText }, done("stop")]],
      rec,
    );
    const answer = await runAsk({
      question: "How many films?",
      snapshot,
      tools: tools(rec),
      provider,
      model: "test-model",
      tier: "mid",
      signal: controller.signal,
      onEvent: (e) => {
        if (e.type === "text") controller.abort();
      },
    });
    expect(answer.verdict.status).toBe("cancelled");
    expect(rec.calls.some((c) => c.name === "runSql")).toBe(false);
  });
});

describe("providers that own their own loop", () => {
  test("their tool results are recorded, never re-executed", async () => {
    const rec: Recorded = { calls: [], requests: [] };
    const provider = scripted(
      [
        [
          call("a", "run_sql", { sql: "SELECT count(*) FROM film" }),
          { toolResult: { id: "a", name: "run_sql", result: "count\n1000\n(1 rows)" } },
          { text: answerText },
          done("stop"),
        ],
      ],
      rec,
      true,
    );
    const { answer, events } = await ask(provider, tools(rec));
    // the loop never called AgentTools for the model's own statement; the one
    // call it did make is the post step executing the final SQL
    expect(rec.calls).toEqual([{ name: "runSql", args: "SELECT count(*) FROM film" }]);
    const step = answer.trace.find((s) => s.step === "tool" && s.id === "a");
    expect(step && step.step === "tool" && step.result).toContain("1000");
    expect(events.some((e) => e.type === "toolEnd" && e.id === "a")).toBe(true);
    expect(answer.verdict.status).toBe("answered");
  });
});

describe("the small tier", () => {
  test("schema up front, one shot, and at most two repairs", async () => {
    const rec: Recorded = { calls: [], requests: [] };
    let attempt = 0;
    const t = tools(rec, {
      async runSql(sql) {
        rec.calls.push({ name: "runSql", args: sql });
        attempt++;
        if (attempt === 1) {
          return { textForModel: "ERROR: syntax error", result: null, error: "syntax error" };
        }
        return ok("count\n1\n(1 rows)", run());
      },
    });
    const provider = scripted(
      [
        [{ text: "```sql\nSELECT counts(*) FROM film\n```" }, done("stop")],
        [{ text: "```sql\nSELECT count(*) FROM film\n```" }, done("stop")],
      ],
      rec,
    );
    const { answer } = await ask(provider, t, { tier: "small" });

    expect(answer.verdict.status).toBe("answered");
    expect(answer.turns).toBe(2);
    // no tool loop on this tier: the schema arrives in the prompt
    expect(rec.requests[0].tools).toEqual([]);
    const firstMsg = rec.requests[0].messages[0] as { content: string };
    expect(firstMsg.content).toContain("CREATE TABLE film");
    expect(firstMsg.content).toContain("Question: How many films");
    expect(rec.calls[0]).toEqual({ name: "describeTables", args: expect_names(rec) });
  });

  test("three failures end as a failure carrying the last error", async () => {
    const rec: Recorded = { calls: [], requests: [] };
    const t = tools(rec, {
      async runSql(sql) {
        rec.calls.push({ name: "runSql", args: sql });
        return { textForModel: "ERROR: syntax error", result: null, error: "syntax error" };
      },
    });
    const provider = scripted([[{ text: "```sql\nSELECT bad\n```" }, done("stop")]], rec);
    const { answer, events } = await ask(provider, t, { tier: "small" });
    expect(answer.verdict.status).toBe("failed");
    expect(rec.calls.filter((c) => c.name === "runSql")).toHaveLength(3);
    expect(events.some((e) => e.type === "error" && e.kind === "sql")).toBe(true);
  });
});

/** the describe call the small path makes carries the prefilter's own picks */
function expect_names(rec: Recorded): unknown {
  return (rec.calls.find((c) => c.name === "describeTables")?.args ?? []) as unknown;
}
