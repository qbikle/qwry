// The turn loop (AGENT-SPEC section 4) against a scripted Provider and a
// scripted AgentTools. Every rule section 7 calls provider-neutral is a test
// here: parallel calls in ONE result message, unparseable arguments and
// unknown tool names answered as text, a turn cap that ends the loop, cancel,
// an ownsLoop provider whose tools the loop must NOT re-execute.

import { describe, expect, test } from "bun:test";
import { runAsk, turnCapMessage, type AskEvent } from "../loop";
import { mentionsIn } from "../mentions";
import { writesMessage } from "../prompt";
import type {
  AgentEvent,
  ChatRequest,
  Msg,
  Provider,
  StopReason,
} from "../providers/types";
import {
  CANVAS_TOOL_NAMES,
  TOOL_NAMES,
  TOOL_SCHEMAS,
  type AgentTools,
  type CanvasOutlineEntry,
  type CanvasTools,
  type ToolOutcome,
} from "../tools";
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
      return ok("'G', 'PG'", { table, column, values: ["G", "PG"], more: false, sampled: false });
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
const done = (stopReason: StopReason): AgentEvent => ({ done: { stopReason } });

/** the gate's refusal for a run_sql argument that is not a statement, in the
 * `ERROR: <first line>` shape every tool layer wraps it in (agent.rs
 * PROSE_REASON) */
const PROSE_ERROR =
  "ERROR: this is prose, not SQL. To answer without running a query, reply in text and call no tool";

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
        return ok("'G', 'PG'", { table, column, values: ["G"], more: false, sampled: false });
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
    // each fragment names the call that produced it, and that call is a trace step
    expect(answer.sanity.map((f) => f.stepId)).toEqual(["a", "b"]);
    const toolIds = answer.trace.filter((s) => s.step === "tool").map((s) => s.id);
    for (const f of answer.sanity) expect(f.stepId !== undefined && toolIds.includes(f.stepId)).toBe(true);
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
    const capped = events.find((e) => e.type === "error");
    expect(capped).toMatchObject({ kind: "turncap", message: "stopped after 2 turns" });
  });

  // W7: the maintainer watched twelve turns and read "STOPPED AFTER 1 TURNS".
  // The sentence names the child's own count, and one is singular
  test("the turn cap sentence names the CHILD's turns, and one is one turn", async () => {
    expect(turnCapMessage(12)).toBe("stopped after 12 turns");
    expect(turnCapMessage(1)).toBe("stopped after 1 turn");

    const rec: Recorded = { calls: [], requests: [] };
    const provider = scripted(
      [
        [
          call("a", "run_sql", { sql: "SELECT 1" }),
          { toolResult: { id: "a", name: "run_sql", result: "count\n1\n(1 rows)" } },
          { done: { stopReason: "turnCap" as const, turns: 24 } },
        ],
      ],
      rec,
      true,
    );
    const { answer, events } = await ask(provider, tools(rec));
    expect(answer.verdict).toMatchObject({ status: "turn_cap", turns: 24 });
    // qwry spent ONE turn on this exchange, so its own counter must reach
    // neither the heading nor the footer: the answer's `turns` is what the
    // footer prints, and one fact in two slots must be one number (LESSONS
    // 13, DESIGN rule 14)
    expect(answer.turns).toBe(24);
    expect(answer.verdict.status === "turn_cap" && answer.verdict.turns).toBe(answer.turns);
    expect(events.find((e) => e.type === "error")).toMatchObject({
      kind: "turncap",
      message: "stopped after 24 turns",
    });
  });

  // the same counter reaches the footer of a run that SUCCEEDED: a child that
  // spent nine turns describing, peeking and running is not `1 turn` because
  // qwry called it once (LESSONS 13)
  test("a finished ownsLoop answer's footer count is the child's, not the wrapper's", async () => {
    const rec: Recorded = { calls: [], requests: [] };
    const provider = scripted(
      [
        [
          call("a", "run_sql", { sql: "SELECT count(*) FROM film" }),
          { toolResult: { id: "a", name: "run_sql", result: "count\n1000\n(1 rows)" } },
          { text: answerText },
          { done: { stopReason: "stop" as const, turns: 9 } },
        ],
      ],
      rec,
      true,
    );
    const { answer } = await ask(provider, tools(rec));
    expect(answer.verdict.status).toBe("answered");
    expect(answer.turns).toBe(9);
  });

  // a provider this loop drives reports no count of its own, and then the
  // loop's counter IS the turns the user watched
  test("a loop-driven provider keeps the loop's own turn count", async () => {
    const rec: Recorded = { calls: [], requests: [] };
    const provider = scripted(
      [
        [call("a", "describe_tables", { names: ["film"] }), done("toolCalls")],
        [{ text: answerText }, done("stop")],
      ],
      rec,
    );
    const { answer } = await ask(provider, tools(rec));
    expect(answer.turns).toBe(2);
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

  test("their own turn cap is a turn cap, never an answer", async () => {
    const rec: Recorded = { calls: [], requests: [] };
    // claude -p exhausted --max-turns mid-loop: a tool ran, no final text came
    const provider = scripted(
      [
        [
          call("a", "run_sql", { sql: "SELECT count(*) FROM film" }),
          { toolResult: { id: "a", name: "run_sql", result: "count\n1000\n(1 rows)" } },
          done("turnCap"),
        ],
      ],
      rec,
      true,
    );
    const { answer } = await ask(provider, tools(rec));
    expect(answer.verdict.status).toBe("turn_cap");
    // nothing was re-executed on the way out either
    expect(rec.calls).toEqual([]);
  });

  // W7: the model answered a write request in prose, handed the prose to
  // run_sql, and re-explained itself once per refusal until the turn cap. The
  // adapter counts the strikes on this path and reports proseLoop
  test("a provider that broke its own prose spiral answers with the prose", async () => {
    const rec: Recorded = { calls: [], requests: [] };
    const provider = scripted(
      [
        [
          { text: "I cannot delete rows: this connection is read-only." },
          call("a", "run_sql", { sql: "I cannot delete rows: this connection is read-only." }),
          { toolResult: { id: "a", name: "run_sql", result: PROSE_ERROR, isError: true } },
          call("b", "run_sql", { sql: "I cannot delete rows: this connection is read-only." }),
          { toolResult: { id: "b", name: "run_sql", result: PROSE_ERROR, isError: true } },
          done("proseLoop"),
        ],
      ],
      rec,
      true,
    );
    const { answer } = await ask(provider, tools(rec));
    expect(answer.verdict).toEqual({ status: "answered", sql: null, rowCount: null });
    expect(answer.text).toBe("I cannot delete rows: this connection is read-only.");
    expect(answer.sql).toBeNull();
    expect(answer.run).toBeNull();
    // nothing was run on the way out
    expect(rec.calls).toEqual([]);
  });

  test("a tool outside the five keeps its own name in the trace", async () => {
    const rec: Recorded = { calls: [], requests: [] };
    const provider = scripted(
      [
        [
          call("x", "SendMessage", { to: "someone" }),
          { toolResult: { id: "x", name: "SendMessage", result: "sent", isError: true } },
          { text: answerText },
          done("stop"),
        ],
      ],
      rec,
      true,
    );
    const { answer } = await ask(provider, tools(rec));
    const step = answer.trace.find((s) => s.step === "tool" && s.id === "x");
    expect(step && step.step === "tool" && step.name).toBe("SendMessage");
  });
});

describe("the answer is the last text block", () => {
  test("narration before a tool call moves to the trace; the block after it is the answer", async () => {
    const rec: Recorded = { calls: [], requests: [] };
    // claude -p streams the whole conversation as ONE qwry turn: text, a tool
    // call, its result, more text. W2 concatenated all of it into the answer.
    const provider = scripted(
      [
        [
          { text: "I'll look at film first. " },
          { text: "Running the count now." },
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
    expect(answer.verdict.status).toBe("answered");
    expect(answer.text).toBe(answerText);
    // the boundary is announced once, with the whole block the tool call closed
    const narration = events.filter((e) => e.type === "narration");
    expect(narration).toEqual([
      { type: "narration", text: "I'll look at film first. Running the count now." },
    ]);
    // every delta still streamed, and the turn row keeps the raw text entire
    const streamed = events.filter((e) => e.type === "text").map((e) => e.delta).join("");
    expect(streamed).toBe(`I'll look at film first. Running the count now.${answerText}`);
    const turn = answer.trace.find((s) => s.step === "turn");
    expect(turn && turn.step === "turn" && turn.text).toBe(streamed);
  });

  test("the fence of an earlier block still counts when the last block has none", async () => {
    const rec: Recorded = { calls: [], requests: [] };
    const provider = scripted(
      [
        [
          { text: "```sql\nSELECT count(*) FROM film\n```\nRunning it." },
          call("a", "run_sql", { sql: "SELECT count(*) FROM film" }),
          { toolResult: { id: "a", name: "run_sql", result: "count\n1000\n(1 rows)" } },
          { text: "1000 films, one per row." },
          done("stop"),
        ],
      ],
      rec,
      true,
    );
    const { answer } = await ask(provider, tools(rec));
    expect(answer.verdict.status).toBe("answered");
    expect(answer.sql).toBe("SELECT count(*) FROM film");
    expect(answer.text).toBe("1000 films, one per row.");
  });

  test("a closing block that is only the SQL keeps the prose before it", async () => {
    const rec: Recorded = { calls: [], requests: [] };
    const prose = "Revenue for August 2026 was ₹2,277,416 across 482 paid orders.";
    const provider = scripted(
      [
        [
          { text: prose },
          call("a", "run_sql", { sql: "SELECT sum(total) FROM orders" }),
          { toolResult: { id: "a", name: "run_sql", result: "sum\n2277416\n(1 rows)" } },
          { text: "```sql\nSELECT sum(total) FROM orders\n```\nAssumptions: Revenue = Paid Orders" },
          done("stop"),
        ],
      ],
      rec,
      true,
    );
    const { answer } = await ask(provider, tools(rec));
    expect(answer.verdict.status).toBe("answered");
    expect(answer.sql).toBe("SELECT sum(total) FROM orders");
    expect(answer.text.startsWith(prose)).toBe(true);
    expect(answer.assumptions.map((c) => c.label)).toContain("Revenue = Paid Orders");
  });

  test("on the hybrid path a tool turn's text never prefixes the answer", async () => {
    const rec: Recorded = { calls: [], requests: [] };
    const provider = scripted(
      [
        [{ text: "Now retrieving the schema." }, call("a", "describe_tables", { names: ["film"] }), done("toolCalls")],
        [{ text: answerText }, done("stop")],
      ],
      rec,
    );
    const { answer, events } = await ask(provider, tools(rec));
    expect(answer.text).toBe(answerText);
    expect(events.filter((e) => e.type === "narration")).toHaveLength(1);
    // the assistant message the provider replays still carries its own text
    const assistant = rec.requests[1].messages.find((m) => m.role === "assistant");
    expect(assistant && "content" in assistant && assistant.content).toBe("Now retrieving the schema.");
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
    // exactly one error event, and it is the SQL kind: the store keeps the
    // LAST error it sees, so a trailing provider-kind emit would relabel every
    // SQL failure as a provider one and hide the editable SQL + Fix It
    const errors = events.filter((e) => e.type === "error");
    expect(errors).toHaveLength(1);
    expect(errors[errors.length - 1]).toMatchObject({ kind: "sql", message: "syntax error" });
  });
});

// The other half of W7's circuit breaker: on the path where the loop runs
// the tools itself, it counts the refusals. Two in a row and the exchange
// ends with what the model said, because it had already said it
describe("the prose spiral", () => {
  const proseTools = (rec: Recorded, refusals: number) => {
    let seen = 0;
    return tools(rec, {
      async runSql(sql) {
        rec.calls.push({ name: "runSql", args: sql });
        if (seen++ < refusals) {
          return { textForModel: PROSE_ERROR, result: null, error: PROSE_ERROR.slice(7) };
        }
        return ok("count\n1\n(1 rows)", run());
      },
    });
  };

  test("two run_sql refusals of the prose class end the exchange as answered", async () => {
    const rec: Recorded = { calls: [], requests: [] };
    const provider = scripted(
      [
        [
          { text: "Deleting rows is outside what qwry does." },
          call("a", "run_sql", { sql: "Deleting rows is outside what qwry does." }),
          done("toolCalls"),
        ],
        [call("b", "run_sql", { sql: "Deleting rows is outside what qwry does." }), done("toolCalls")],
        // the model would keep going; it never gets the turn
        [{ text: answerText }, done("stop")],
      ],
      rec,
    );
    const { answer, events } = await ask(provider, proseTools(rec, 9));
    expect(answer.verdict).toEqual({ status: "answered", sql: null, rowCount: null });
    expect(answer.text).toBe("Deleting rows is outside what qwry does.");
    expect(answer.turns).toBe(2);
    // the third turn never happened, and nothing errored at the user
    expect(rec.requests).toHaveLength(2);
    expect(events.some((e) => e.type === "error")).toBe(false);
  });

  test("a statement between two refusals resets the count", async () => {
    const rec: Recorded = { calls: [], requests: [] };
    const provider = scripted(
      [
        [{ text: "no" }, call("a", "run_sql", { sql: "prose" }), done("toolCalls")],
        [call("b", "run_sql", { sql: "SELECT count(*) FROM film" }), done("toolCalls")],
        [{ text: "no again" }, call("c", "run_sql", { sql: "prose" }), done("toolCalls")],
        [{ text: answerText }, done("stop")],
      ],
      rec,
    );
    let call_n = 0;
    const t = tools(rec, {
      async runSql(sql) {
        rec.calls.push({ name: "runSql", args: sql });
        call_n++;
        if (call_n === 2 || call_n === 4) return ok("count\n1\n(1 rows)", run());
        return { textForModel: PROSE_ERROR, result: null, error: PROSE_ERROR.slice(7) };
      },
    });
    const { answer } = await ask(provider, t);
    expect(answer.verdict.status).toBe("answered");
    expect(answer.sql).toBe("SELECT count(*) FROM film");
  });

  test("an ordinary SQL error is never a strike: the repair loop still runs", async () => {
    const rec: Recorded = { calls: [], requests: [] };
    const t = tools(rec, {
      async runSql(sql) {
        rec.calls.push({ name: "runSql", args: sql });
        return { textForModel: "ERROR: syntax error", result: null, error: "syntax error" };
      },
    });
    const provider = scripted(
      [
        [call("a", "run_sql", { sql: "SELECT bad" }), done("toolCalls")],
        [call("b", "run_sql", { sql: "SELECT worse" }), done("toolCalls")],
        [{ text: answerText }, done("stop")],
      ],
      rec,
    );
    const { answer } = await ask(provider, t, { maxTurns: 3 });
    // both refusals were ordinary SQL errors, so the loop ran every turn it
    // had and ended on the statement, not on a breaker
    expect(rec.requests).toHaveLength(3);
    expect(answer.verdict).toMatchObject({ status: "failed", sql: "SELECT count(*) FROM film" });
  });
});

describe("error events", () => {
  test("a SQL failure on the hybrid path ends with ONE error event of kind sql", async () => {
    const rec: Recorded = { calls: [], requests: [] };
    const t = tools(rec, {
      async runSql(sql) {
        rec.calls.push({ name: "runSql", args: sql });
        return { textForModel: "ERROR: syntax error", result: null, error: "syntax error" };
      },
    });
    const provider = scripted([[{ text: "```sql\nSELECT bad\n```" }, done("stop")]], rec);
    const { answer, events } = await ask(provider, t, { maxTurns: 2 });
    expect(answer.verdict.status).toBe("failed");
    const errors = events.filter((e) => e.type === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ kind: "sql" });
  });

  test("a provider failure carries the stated wait to the UI", async () => {
    const rec: Recorded = { calls: [], requests: [] };
    const provider = scripted(
      [[{ error: { kind: "rate", message: "rate limited", retryAfterMs: 20_000 } }]],
      rec,
    );
    const { answer, events } = await ask(provider, tools(rec));
    expect(answer.verdict.status).toBe("failed");
    const errors = events.filter((e) => e.type === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ kind: "provider", retryAfterMs: 20_000 });
  });

  test("a finished tool chip carries its arguments and result", async () => {
    const rec: Recorded = { calls: [], requests: [] };
    const provider = scripted(
      [
        [
          { toolCall: { id: "c1", name: "describe_tables", args: '{"names":["film"]}' } },
          done("toolCalls"),
        ],
        [{ text: "One.\n```sql\nSELECT count(*) FROM film\n```\nAssumptions: none" }, done("stop")],
      ],
      rec,
    );
    const { events } = await ask(provider, tools(rec));
    const end = events.find((e) => e.type === "toolEnd");
    expect(end).toMatchObject({
      id: "c1",
      args: '{"names":["film"]}',
      result: expect.stringContaining("CREATE TABLE film"),
    });
  });
});

// A thread cut back to an earlier question resumes a provider session that
// never heard the exchanges it kept, so the store hands the first call after
// the cut a replay of them. It rides the USER message: the system prompt is
// PROMPT_VERSION's, and the eval, which never has a thread, must send the
// same bytes it always did.
describe("a cut thread's replay", () => {
  const REPLAY = "Earlier in this thread:\n\nQ: how many films\nSQL: SELECT 1\nA: One thousand.";

  const oneShot = async (over: Partial<Parameters<typeof runAsk>[0]>) => {
    const rec: Recorded = { calls: [], requests: [] };
    await ask(scripted([[{ text: answerText }, done("stop")]], rec), tools(rec), over);
    return rec.requests[0];
  };
  /** the opening user message; a tool message has no `content` */
  const opening = (req: ChatRequest): string => {
    const first = req.messages[0];
    return "content" in first ? (first.content ?? "") : "";
  };

  test("the replay prefixes the user message and nothing else", async () => {
    const bare = await oneShot({ thread: { id: "t-1", firstCall: true } });
    const cut = await oneShot({
      thread: { id: "t-1", session: "fresh-key", firstCall: true, replay: REPLAY },
    });
    expect(opening(cut)).toBe(`${REPLAY}\n\n${opening(bare)}`);
    expect(cut.system).toBe(bare.system);
    expect(cut.messages).toHaveLength(bare.messages.length);
    // the adapter resumes the key the cut minted; the thread id still names
    // the thread's own MCP session
    expect(cut.thread).toMatchObject({ id: "t-1", session: "fresh-key" });
  });

  test("no thread and a thread with no replay send byte-identical messages", async () => {
    const evaluation = await oneShot({});
    const app = await oneShot({ thread: { id: "t-1", firstCall: true } });
    expect(app.messages).toEqual(evaluation.messages);
    expect(app.system).toBe(evaluation.system);
    expect(evaluation.thread).toBeUndefined();
  });

  test("the small path replays too: a stateless provider had no memory either", async () => {
    const rec: Recorded = { calls: [], requests: [] };
    const provider = scripted([[{ text: "```sql\nSELECT 1\n```" }, done("stop")]], rec);
    await ask(provider, tools(rec), {
      tier: "small",
      thread: { id: "t-1", session: "fresh-key", firstCall: true, replay: REPLAY },
    });
    expect(opening(rec.requests[0])).toStartWith(`${REPLAY}\n\n`);
  });
});

/** the describe call the small path makes carries the prefilter's own picks */
function expect_names(rec: Recorded): unknown {
  return (rec.calls.find((c) => c.name === "describeTables")?.args ?? []) as unknown;
}

// ---- @ context tags (W6) ----------------------------------------------------

describe("the tags the user wrote", () => {
  const ctx = {
    snapshot,
    saved: [{ id: "s1", name: "Monthly revenue", sql: "SELECT 1 AS revenue;" }],
    threads: [
      { id: "t-9", profileId: "p", title: "which films rent most", createdAt: "2026-09-06" },
    ],
    currentThreadId: null,
  };

  const oneAsk = async (over: Partial<Parameters<typeof runAsk>[0]>) => {
    const rec: Recorded = { calls: [], requests: [] };
    const { answer } = await ask(
      scripted([[{ text: answerText }, done("stop")]], rec),
      tools(rec),
      over,
    );
    const first = rec.requests[0].messages[0];
    return { answer, message: "content" in first ? (first.content ?? "") : "" };
  };

  test("the tagged tables lead the candidate block, once each, and a column brings its table", async () => {
    const mentions = mentionsIn("@actor and @customer.email", ctx);
    expect(mentions.map((m) => m.kind)).toEqual(["table", "column"]);
    const { answer } = await oneAsk({ mentions });
    expect(answer.candidates.slice(0, 2)).toEqual(["actor", "customer"]);
    expect(answer.candidates.filter((c) => c === "actor")).toHaveLength(1);
    // the lexical picks give way rather than being dropped: the question's own
    // table is still there, and the cap still binds
    expect(answer.candidates).toContain("film");
    expect(answer.candidates.length).toBeLessThanOrEqual(22);
  });

  test("the block sits under the candidates, above the risk block, question as typed", async () => {
    const mentions = mentionsIn('@actor and @"Monthly revenue"', ctx);
    const { message } = await oneAsk({
      question: "how many actors joined within 30 days? @actor and @\"Monthly revenue\"",
      mentions,
    });
    expect(message).toStartWith('how many actors joined within 30 days? @actor and @"Monthly revenue"\n\n');
    expect(message).toContain(
      '\n\nTAGGED BY THE USER:\ntable public.actor\nsaved query "Monthly revenue":\nSELECT 1 AS revenue;\nRISK CHECK REQUIRED',
    );
    expect(message.indexOf("CANDIDATE TABLES")).toBeLessThan(message.indexOf("TAGGED BY THE USER"));
  });

  test("no tags, no block: the eval path's message is byte-identical", async () => {
    const evaluation = await oneAsk({});
    const empty = await oneAsk({ mentions: [] });
    expect(empty.message).toBe(evaluation.message);
    expect(evaluation.message).not.toContain("TAGGED BY THE USER");
    expect(evaluation.answer.candidates).toEqual(empty.answer.candidates);
  });

  test("the trace's context step carries the tags, and carries none when there were none", async () => {
    const tagged = await oneAsk({ mentions: mentionsIn("@actor", ctx) });
    const step = tagged.answer.trace.find((s) => s.step === "context");
    expect(step).toMatchObject({ mentions: [{ kind: "table", token: "actor" }] });
    const plain = await oneAsk({});
    const bare = plain.answer.trace.find((s) => s.step === "context");
    expect(bare && "mentions" in bare).toBe(false);
  });
});

// ---- writes (A4) ------------------------------------------------------------
// The loop never runs a change. With edits on, the statement the model settled
// on ends the exchange as a PROPOSAL the user runs in a query tab; with them
// off, it ends as the one failure whose way out is Settings. Everything the
// gate does not read as exactly one INSERT / UPDATE / DELETE takes the path it
// always took, and the message the eval sends does not move a byte either way.

describe("a change the model proposed", () => {
  const UPDATE =
    "Marked them paid.\n\n```sql\nUPDATE order_v2 SET payment_status = 'paid' WHERE id = 1\n```\nAssumptions: none";

  /** the write gate, scripted: `wrote` is what it read off the parse tree */
  const gate = (on: boolean, wrote = true, prod = false) => {
    const seen: string[] = [];
    return {
      seen,
      mode: { on, prod, isWrite: async (sql: string) => (seen.push(sql), wrote) },
    };
  };

  const askWith = async (
    text: string,
    mode: Parameters<typeof runAsk>[0]["writes"],
  ) => {
    const rec: Recorded = { calls: [], requests: [] };
    const { answer, events } = await ask(
      scripted([[{ text }, done("stop")]], rec),
      tools(rec),
      mode ? { writes: mode } : {},
    );
    const first = rec.requests[0].messages[0];
    return { answer, events, rec, message: "content" in first ? (first.content ?? "") : "" };
  };

  test("edits on: the exchange ends proposed, carrying the statement, and nothing ran", async () => {
    const g = gate(true);
    const { answer, events, rec } = await askWith(UPDATE, g.mode);
    expect(answer.verdict).toEqual({
      status: "proposed",
      sql: "UPDATE order_v2 SET payment_status = 'paid' WHERE id = 1",
    });
    expect(answer.sql).toBe("UPDATE order_v2 SET payment_status = 'paid' WHERE id = 1");
    expect(answer.run).toBeNull();
    // the statement reached the gate and nothing else
    expect(g.seen).toEqual([answer.sql!]);
    expect(rec.calls.filter((c) => c.name === "runSql")).toHaveLength(0);
    // a proposal is not a failure: no error event, and the prose stands
    expect(events.filter((e) => e.type === "error")).toHaveLength(0);
    expect(answer.text).toStartWith("Marked them paid.");
  });

  test("edits off: the Settings failure, the statement kept, and still no run", async () => {
    const g = gate(false);
    const { answer, events, rec } = await askWith(UPDATE, g.mode);
    expect(answer.verdict).toMatchObject({ status: "failed", message: "edits are off for this connection" });
    expect(answer.sql).toBe("UPDATE order_v2 SET payment_status = 'paid' WHERE id = 1");
    expect(answer.run).toBeNull();
    expect(rec.calls.filter((c) => c.name === "runSql")).toHaveLength(0);
    // its own kind, because its own affordance: Settings, never Fix It
    expect(events.filter((e) => e.type === "error")).toEqual([
      { type: "error", kind: "writesoff", message: "edits are off for this connection" },
    ]);
  });

  test("on production the copy names production, since there is no switch to offer", async () => {
    const { answer } = await askWith(UPDATE, gate(false, true, true).mode);
    expect(answer.verdict).toMatchObject({ status: "failed", message: "edits are off on production" });
  });

  test("a read is untouched: the gate reads no write and the statement runs as ever", async () => {
    const g = gate(true, false);
    const { answer, rec } = await askWith(answerText, g.mode);
    expect(g.seen).toEqual(["SELECT count(*) FROM film"]);
    expect(answer.verdict.status).toBe("answered");
    expect(rec.calls.filter((c) => c.name === "runSql")).toHaveLength(1);
  });

  test("the WRITES block rides the user message only when edits are on, and rides last", async () => {
    const on = await askWith(UPDATE, gate(true).mode);
    expect(on.message).toContain("\nWRITES: the user has allowed changes to this database.");
    expect(on.message.indexOf("CANDIDATE TABLES")).toBeLessThan(on.message.indexOf("WRITES:"));
    expect(on.message.trimEnd()).toEndWith("the question only asks about is read-only work as before.");
  });

  // B1: the block is pinned byte for byte, the way the edits-off message is
  // (below). It is the only place the model is told what the app does with the
  // statement, and the app's whole ceremony rests on it: a fence the user
  // presses Run on, never one they are told to copy somewhere else. A reword
  // that drops a clause changes what the model writes above the fence, so it
  // has to change this line too and be seen doing it
  test("and it says what the app does with the statement, byte for byte", () => {
    expect(writesMessage()).toBe(
      "\nWRITES: the user has allowed changes to this database. If the question asks to change data, finish with exactly ONE INSERT, UPDATE or DELETE\n" +
        "statement in the final ```sql block, with a WHERE clause that names the rows it touches. Do NOT call run_sql with it: run_sql runs reads only.\n" +
        "qwry renders that statement as a preview of the rows it affects, under a Run button the user presses, so never tell anyone to run, copy or paste\n" +
        "it anywhere, never announce the statement, and never open with filler: write one sentence of what will change and why, then the fence. Anything\n" +
        "the question only asks about is read-only work as before.",
    );
  });

  test("the risk block keeps its own place: the writes block follows it", async () => {
    const rec: Recorded = { calls: [], requests: [] };
    await ask(scripted([[{ text: UPDATE }, done("stop")]], rec), tools(rec), {
      question: "how many films were added within 30 days?",
      writes: gate(true).mode,
    });
    const first = rec.requests[0].messages[0];
    const message = "content" in first ? (first.content ?? "") : "";
    expect(message.indexOf("RISK CHECK REQUIRED")).toBeLessThan(message.indexOf("WRITES:"));
  });

  test("edits off sends the eval's message byte for byte, and asks the gate anyway", async () => {
    const g = gate(false, false);
    const evaluation = await askWith(answerText, undefined);
    const off = await askWith(answerText, g.mode);
    expect(off.message).toBe(evaluation.message);
    expect(off.message).not.toContain("WRITES:");
    // the gate still reads every final statement with edits off: that is how a
    // change gets the Settings failure instead of the read gate's own words
    expect(g.seen).toHaveLength(1);
  });

  test("the eval path asks no gate at all", async () => {
    const { answer } = await askWith(UPDATE, undefined);
    // no writes mode, no write check: the statement goes to run_sql, where the
    // READ gate is what refuses it, exactly as it did before this wave
    expect(answer.verdict.status).toBe("answered");
  });

  test("the small tier proposes too: no tier is a reason to run a change", async () => {
    const rec: Recorded = { calls: [], requests: [] };
    const provider = scripted([[{ text: UPDATE }, done("stop")]], rec);
    const { answer } = await ask(provider, tools(rec), {
      tier: "small",
      writes: gate(true).mode,
    });
    expect(answer.verdict.status).toBe("proposed");
    expect(rec.calls.filter((c) => c.name === "runSql")).toHaveLength(0);
    // and the small path's own message never carries the block: its system
    // prompt asks for a SELECT, and two instructions would contradict
    const first = rec.requests[0].messages[0];
    expect("content" in first ? (first.content ?? "") : "").not.toContain("WRITES:");
  });
});

// ---- what the connection knows (A2 item 4) ----------------------------------
//
// Two blocks in the USER message, never in the system prompt, and never at all
// for a run that carries no profile: the eval passes none, so its bytes are
// the measured ones and PROMPT_VERSION does not move. The trace shows each
// block once, under a step of its own, because the context step showing it too
// would be one fact in two slots (DESIGN rule 14).

describe("the knowledge the profile carries", () => {
  const HINT = { kind: "hint" as const, target: "film", text: "one row per title, not per copy" };
  const DEF = { kind: "definition" as const, target: null, text: "catalogue = every film row" };
  const PAIR = { question: "how many films are rated G", sql: "SELECT count(*) FROM film" };

  const oneAsk = async (over: Partial<Parameters<typeof runAsk>[0]>) => {
    const rec: Recorded = { calls: [], requests: [] };
    const { answer } = await ask(
      scripted([[{ text: answerText }, done("stop")]], rec),
      tools(rec),
      over,
    );
    const first = rec.requests[0].messages[0];
    return { answer, message: "content" in first ? (first.content ?? "") : "", rec };
  };

  const stepOf = (answer: { trace: import("../types").TraceStep[] }, step: string) =>
    answer.trace.find((s) => s.step === step);

  test("no profile, no blocks: the eval's message is byte-identical", async () => {
    const evaluation = await oneAsk({});
    const empty = await oneAsk({ knowledge: [], history: [], synonyms: {} });
    expect(empty.message).toBe(evaluation.message);
    expect(evaluation.message).not.toContain("KNOWLEDGE:");
    expect(evaluation.message).not.toContain("EARLIER ANSWERS ON THIS DATABASE:");
    expect(stepOf(evaluation.answer, "knowledge")).toBeUndefined();
    expect(evaluation.answer.promptVersion).toBe("v4");
  });

  test("one hint, one definition and one earlier answer ride the user message", async () => {
    const { message } = await oneAsk({
      question: "how big is the film catalogue?",
      knowledge: [HINT, DEF],
      history: [PAIR],
    });
    expect(message).toContain(
      "\n\nKNOWLEDGE:\nfilm  -- one row per title, not per copy\ncatalogue: every film row" +
        "\n\nEARLIER ANSWERS ON THIS DATABASE:\nQ: how many films are rated G" +
        "\nSQL: SELECT count(*) FROM film",
    );
    // standing reference, so it sits with the candidates it talks about and
    // above what this one question tagged (AGENT-SPEC 4.2)
    expect(message.indexOf("CANDIDATE TABLES")).toBeLessThan(message.indexOf("KNOWLEDGE:"));
  });

  test("the risk block stays last: it is the instruction for the next turn", async () => {
    const { message } = await oneAsk({
      question: "how many films joined the catalogue in the last 30 days?",
      knowledge: [HINT, DEF],
    });
    expect(message.indexOf("KNOWLEDGE:")).toBeLessThan(message.indexOf("RISK CHECK REQUIRED"));
  });

  test("the knowledge step carries what went, and the context step does not repeat it", async () => {
    const { answer, message } = await oneAsk({
      question: "how big is the film catalogue?",
      knowledge: [HINT, DEF, { kind: "synonym", target: "film", text: "catalogue" }],
      history: [PAIR],
    });
    const step = stepOf(answer, "knowledge");
    // a kind with nothing is absent, never a zero (DESIGN rule 11)
    expect(step && step.step === "knowledge" && step.counts).toEqual({
      hints: 1,
      definitions: 1,
      synonyms: 1,
      history: 1,
    });
    const context = stepOf(answer, "context");
    expect(context && context.step === "context" && context.text).not.toContain("KNOWLEDGE:");
    // between them the two steps hold the whole message: nothing sent to a
    // provider is hidden (spec 8.4), and neither step holds the other's half
    const body = step && step.step === "knowledge" ? step.text : "";
    const head = context && context.step === "context" ? context.text : "";
    expect(message).toContain(body);
    expect(message).toContain(head);
    expect(head).not.toContain("EARLIER ANSWERS");
    expect(body.split("\n")[0]).toBe("KNOWLEDGE:");
    expect(body).toContain("\n\nEARLIER ANSWERS ON THIS DATABASE:\n");
  });

  test("a synonym puts its table in front of the candidates the question chose", async () => {
    const { answer, message } = await oneAsk({
      question: "how many actors are in the catalogue?",
      knowledge: [{ kind: "synonym", target: "film", text: "catalogue" }],
    });
    expect(answer.candidates[0]).toBe("film");
    expect(message).toContain("KNOWLEDGE:\ncatalogue -> film");
  });

  test("rows the question never reached for leave no header behind", async () => {
    const { answer, message } = await oneAsk({
      question: "how many films?",
      knowledge: [{ kind: "hint", target: "staff", text: "two rows, both fake" }],
      history: [{ question: "who runs store 2", sql: "SELECT 1" }],
    });
    expect(message).not.toContain("KNOWLEDGE:");
    expect(message).not.toContain("EARLIER ANSWERS");
    expect(stepOf(answer, "knowledge")).toBeUndefined();
  });

  test("the small tier's one call stays the message it was measured as", async () => {
    const rec: Recorded = { calls: [], requests: [] };
    const provider = scripted([[{ text: "```sql\nSELECT 1\n```" }, done("stop")]], rec);
    const { answer } = await ask(provider, tools(rec), {
      question: "how big is the film catalogue?",
      tier: "small",
      knowledge: [HINT, { kind: "synonym", target: "film", text: "catalogue" }],
      history: [PAIR],
    });
    const first = rec.requests[0].messages[0];
    const message = "content" in first ? (first.content ?? "") : "";
    expect(message).toEndWith("Question: how big is the film catalogue?");
    expect(stepOf(answer, "knowledge")).toBeUndefined();
    // the synonym still reaches it, as a candidate rather than as a sentence
    expect(answer.candidates[0]).toBe("film");
  });

  test("what a code entry point attached rides under the tags' own header", async () => {
    const { message } = await oneAsk({
      question: 'Explain this query @"cohort retention"',
      context: 'tab "cohort retention":\nSELECT 1',
      knowledge: [HINT],
    });
    expect(message).toContain('\n\nTAGGED BY THE USER:\ntab "cohort retention":\nSELECT 1');
    // what this question came with sits below what the connection always knows
    expect(message.indexOf("KNOWLEDGE:")).toBeLessThan(message.indexOf("TAGGED BY THE USER:"));
  });
});

// ---- the canvas the answer lands in (B3) ------------------------------------
// The tool list and the user message are both prompt surface (EVAL.md section
// 4), and both are gated on ONE thing: whether the exchange has a canvas
// target. With none, the loop must send the byte-identical five and no CANVAS
// block, which is what every baseline row was measured against; with one, the
// five come first and the three follow, and the block rides last.

describe("the canvas gate", () => {
  const outline = (): CanvasOutlineEntry[] => [
    {
      id: "9c110000-0000-4000-8000-000000000002",
      kind: "result",
      line: "how many orders came from each channel",
      rows: 6,
      columns: ["channel", "orders"],
      face: "chart",
      modelWritten: true,
    },
  ];

  /** A CanvasTools that records what the loop asked of it. */
  function canvasStub(over: Partial<CanvasTools> = {}) {
    const seen: { name: string; args: unknown }[] = [];
    const tools: CanvasTools = {
      canvasId: "cv-1",
      title: "Canvas 4",
      outline: () => [],
      async write(args) {
        seen.push({ name: "write", args });
        return {
          textForModel: 'Wrote 2 blocks to "Canvas 4".',
          result: { canvasId: "cv-1", blockIds: ["b1", "b2"], replaced: 0 },
        };
      },
      async replace(args) {
        seen.push({ name: "replace", args });
        return {
          textForModel: "Replaced b1.",
          result: { canvasId: "cv-1", blockIds: ["b1"], replaced: 1 },
        };
      },
      async read() {
        seen.push({ name: "read", args: null });
        return {
          textForModel: 'Canvas "Canvas 4" is empty, 7 columns wide.',
          result: { canvasId: "cv-1", title: "Canvas 4", columns: 7, blocks: [] },
        };
      },
      ...over,
    };
    return { tools, seen };
  }

  const oneAsk = async (over: Partial<Parameters<typeof runAsk>[0]> = {}) => {
    const rec: Recorded = { calls: [], requests: [] };
    const { answer, events } = await ask(
      scripted([[{ text: answerText }, done("stop")]], rec),
      tools(rec),
      over,
    );
    const first = rec.requests[0].messages[0];
    return {
      answer,
      events,
      rec,
      message: "content" in first ? (first.content ?? "") : "",
      offered: rec.requests[0].tools,
    };
  };

  test("no target: the tools array is deep-equal to the measured five", async () => {
    const { offered } = await oneAsk();
    expect(offered).toEqual([...TOOL_SCHEMAS]);
    expect(offered.map((t) => t.name)).toEqual([...TOOL_NAMES]);
  });

  test("no target: the message is byte-identical and says nothing about a canvas", async () => {
    const plain = await oneAsk();
    const withTools = await oneAsk({ writes: undefined });
    expect(plain.message).toBe(withTools.message);
    expect(plain.message).not.toContain("CANVAS:");
    expect(plain.message).not.toContain("OUTLINE OF");
  });

  test("a target: eight tools, the five first, in file order", async () => {
    const { tools: canvas } = canvasStub();
    const { offered } = await oneAsk({ canvas });
    expect(offered).toHaveLength(8);
    expect(offered.map((t) => t.name)).toEqual([...TOOL_NAMES, ...CANVAS_TOOL_NAMES]);
  });

  test("the CANVAS block rides the user message once, and rides LAST", async () => {
    const { tools: canvas } = canvasStub();
    const { message } = await oneAsk({
      question: "how many films were added within 30 days?",
      writes: { on: true, isWrite: async () => false },
      canvas,
    });
    expect(message.split("CANVAS:")).toHaveLength(2);
    expect(message.indexOf("RISK CHECK REQUIRED")).toBeLessThan(message.indexOf("CANVAS:"));
    expect(message.indexOf("WRITES:")).toBeLessThan(message.indexOf("CANVAS:"));
    expect(message.trimEnd()).toEndWith("is needed here.");
  });

  test("the outline rides the block when the canvas holds blocks, and not when it is empty", async () => {
    const full = canvasStub({ outline });
    const withBlocks = await oneAsk({ canvas: full.tools });
    expect(withBlocks.message).toContain('OUTLINE OF "Canvas 4" (1 block):');
    expect(withBlocks.message).toContain(
      "9c11  result  how many orders came from each channel · 6 rows: channel, orders · chart face",
    );
    const empty = await oneAsk({ canvas: canvasStub().tools });
    expect(empty.message).toContain("CANVAS:");
    expect(empty.message).not.toContain("OUTLINE OF");
  });

  test("the trace's context step carries the block: nothing sent is hidden", async () => {
    const { tools: canvas } = canvasStub({ outline });
    const { answer } = await oneAsk({ canvas });
    const step = answer.trace.find((s) => s.step === "context");
    expect(step && step.step === "context" && step.text).toContain("CANVAS:");
    expect(step && step.step === "context" && step.text).toContain('OUTLINE OF "Canvas 4"');
  });

  test("the small tier gets neither the block nor a tool", async () => {
    const rec: Recorded = { calls: [], requests: [] };
    const { tools: canvas } = canvasStub();
    await ask(scripted([[{ text: "```sql\nSELECT 1\n```" }, done("stop")]], rec), tools(rec), {
      tier: "small",
      canvas,
    });
    expect(rec.requests[0].tools).toEqual([]);
    const first = rec.requests[0].messages[0];
    expect("content" in first ? (first.content ?? "") : "").not.toContain("CANVAS:");
  });
});

describe("the canvas dispatch", () => {
  function stub() {
    const seen: { name: string; args: unknown }[] = [];
    const tools: CanvasTools = {
      canvasId: "cv-1",
      title: "Canvas 4",
      outline: () => [],
      async write(args) {
        seen.push({ name: "write", args });
        return {
          textForModel: 'Wrote 2 blocks to "Canvas 4".',
          result: { canvasId: "cv-1", blockIds: ["b1", "b2"], replaced: 0 },
        };
      },
      async replace(args) {
        seen.push({ name: "replace", args });
        return {
          textForModel: "Replaced b1.",
          result: { canvasId: "cv-1", blockIds: ["b1"], replaced: 1 },
        };
      },
      async read() {
        seen.push({ name: "read", args: null });
        return {
          textForModel: 'Canvas "Canvas 4" is empty, 7 columns wide.',
          result: { canvasId: "cv-1", title: "Canvas 4", columns: 7, blocks: [] },
        };
      },
    };
    return { tools, seen };
  }

  const writeCall = call("c1", "canvas_write", {
    blocks: [{ kind: "result", sql: "SELECT 1" }, { kind: "note", text: "a reading" }],
  });

  test("a canvas_write reaches the tool and its ids reach the store as an event", async () => {
    const rec: Recorded = { calls: [], requests: [] };
    const canvas = stub();
    const { events, answer } = await ask(
      scripted(
        [
          [writeCall, done("toolCalls")],
          [{ text: "Four blocks are on Canvas 4." }, done("stop")],
        ],
        rec,
      ),
      tools(rec),
      { canvas: canvas.tools },
    );
    expect(canvas.seen.map((s) => s.name)).toEqual(["write"]);
    const wrote = events.filter((e) => e.type === "canvasWrite");
    expect(wrote).toEqual([
      { type: "canvasWrite", canvasId: "cv-1", blockIds: ["b1", "b2"], replaced: 0 },
    ]);
    // the trace carries the true name; the chip carries the run species and
    // the strip's own label
    const step = answer.trace.find((s) => s.step === "tool");
    expect(step && step.step === "tool" && step.name).toBe("canvas_write");
    const start = events.find((e) => e.type === "toolStart");
    expect(start).toMatchObject({ name: "run_sql", label: "canvas" });
    // and no AgentTools call was made for it
    expect(rec.calls.filter((c) => c.name === "runSql")).toHaveLength(1);
  });

  test("a canvas_read reports no blocks, so no write event fires", async () => {
    const rec: Recorded = { calls: [], requests: [] };
    const canvas = stub();
    const { events } = await ask(
      scripted(
        [
          [call("c2", "canvas_read", {}), done("toolCalls")],
          [{ text: answerText }, done("stop")],
        ],
        rec,
      ),
      tools(rec),
      { canvas: canvas.tools },
    );
    expect(canvas.seen.map((s) => s.name)).toEqual(["read"]);
    expect(events.filter((e) => e.type === "canvasWrite")).toEqual([]);
  });

  test("with no target a canvas tool is unknown, and the refusal is the one it always was", async () => {
    const rec: Recorded = { calls: [], requests: [] };
    const { answer } = await ask(
      scripted(
        [
          [writeCall, done("toolCalls")],
          [{ text: answerText }, done("stop")],
        ],
        rec,
      ),
      tools(rec),
    );
    const step = answer.trace.find((s) => s.step === "tool");
    expect(step && step.step === "tool" && step.result).toBe(
      "ERROR: unknown tool 'canvas_write'. Valid tools: list_tables, describe_tables, peek_values, run_sql, probe",
    );
  });

  test("with a target the refusal lists the eight it offered", async () => {
    const rec: Recorded = { calls: [], requests: [] };
    const canvas = stub();
    const { answer } = await ask(
      scripted(
        [
          [call("c3", "canvas_burn", {}), done("toolCalls")],
          [{ text: answerText }, done("stop")],
        ],
        rec,
      ),
      tools(rec),
      { canvas: canvas.tools },
    );
    const step = answer.trace.find((s) => s.step === "tool");
    expect(step && step.step === "tool" && step.result).toBe(
      "ERROR: unknown tool 'canvas_burn'. Valid tools: list_tables, describe_tables, " +
        "peek_values, run_sql, probe, canvas_write, canvas_replace, canvas_read",
    );
    expect(canvas.seen).toEqual([]);
  });

  test("prose sent to a result block spirals the same way run_sql's does, and breaks", async () => {
    const rec: Recorded = { calls: [], requests: [] };
    const refused: CanvasTools = {
      ...stub().tools,
      async write() {
        return { textForModel: PROSE_ERROR, result: null, error: "this is prose, not SQL" };
      },
    };
    const { answer } = await ask(
      scripted(
        [
          [{ text: "There are 1000 films." }, writeCall, done("toolCalls")],
          [writeCall, done("toolCalls")],
          [{ text: "still 1000" }, writeCall, done("toolCalls")],
        ],
        rec,
      ),
      tools(rec),
      { canvas: refused },
    );
    expect(answer.verdict.status).toBe("answered");
    expect(answer.sql).toBeNull();
    expect(answer.text).toContain("There are 1000 films.");
  });

  test("the bridge is served for an ownsLoop provider and stopped when the run ends", async () => {
    const rec: Recorded = { calls: [], requests: [] };
    let served = 0;
    let stopped = 0;
    const canvas: CanvasTools = {
      ...stub().tools,
      serve() {
        served += 1;
        return () => {
          stopped += 1;
        };
      },
    };
    await ask(scripted([[{ text: answerText }, done("stop")]], rec, true), tools(rec), {
      canvas,
      thread: { id: "t-1", firstCall: true },
    });
    expect([served, stopped]).toEqual([1, 1]);
    // and a provider this loop drives needs no bridge: it dispatches itself
    const driven: Recorded = { calls: [], requests: [] };
    let servedAgain = 0;
    await ask(scripted([[{ text: answerText }, done("stop")]], driven), tools(driven), {
      canvas: {
        ...canvas,
        serve() {
          servedAgain += 1;
          return () => {};
        },
      },
    });
    expect(servedAgain).toBe(0);
  });
});
