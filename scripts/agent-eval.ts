// The bench runner (EVAL.md section 3). Runs THE SAME src/agent/loop.ts the
// app runs, with eval/tools.node.ts and eval/platform.node.ts underneath it,
// and turns the result into a number: execution accuracy against hand-verified
// gold SQL, plus the per-question facts that explain a regression (turns, tool
// calls by name, wall, tokens, prefilter recall, whether the risk classifier
// fired).
//
//   bun scripts/agent-eval.ts --bench eval/bench/pagila.json \
//     --provider claude-code --model claude-haiku-4-5 --jobs 3 --label pagila-haiku-v1
//   bun scripts/agent-eval.ts --bench eval/bench/pagila.json --gold-check
//
// Flags mirror the lab (qwry-agent-lab/agent_cc.py) and so does the progress
// stream: results/progress-<label>.jsonl carries run_start / q / run_end
// events in the lab's own shape, so its dashboard reads a qwry run unchanged.

import { readFileSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { runAsk, MAX_TURNS, type AskAnswer } from "../src/agent/loop";
import { createProvider } from "../src/agent/providers";
import { isPresetId } from "../src/agent/providers/presets";
import { tierOf, type Tier } from "../src/agent/providers/registry";
import type { ProviderId } from "../src/agent/providers/types";
import { PROMPT_VERSION } from "../src/agent/prompt";
import type { SchemaSnapshot } from "../src/stores/schema";
import { introspect, runReadonly, RUN_TIMEOUT_MS, type RawResult } from "../eval/introspect.node";
import { createNodeTools } from "../eval/tools.node";
import { createNodePlatform } from "../eval/platform.node";
import { normalise, sameRows, tieCheck } from "../eval/compare";

const ROOT = resolvePath(dirname(new URL(import.meta.url).pathname), "..");

/** The lab's own Postgres (qwry-agent-lab/README): port 5455, never 5432,
 * which on the maintainer's machine is a production bastion tunnel. */
const DEFAULT_DSN = "postgres://lab@127.0.0.1:5455/pagila";

/** Rows a prediction may return before the comparison refuses to score it,
 * as harness.py run_sql does. A query that returns more than the grid would
 * ever show is not an answer to a bench question. */
const COMPARE_ROW_CAP = 2000;

/** One question's wall-clock ceiling. The loop has a turn cap; this catches a
 * child process that stops talking without exiting. */
const DEFAULT_TIMEOUT_S = 900;

interface Question {
  id: string;
  tier: number;
  tags: string[];
  question: string;
  gold_sql: string | null;
}

type Status = "PASS" | "WRONG" | "EXEC-FAIL" | "RAN";

interface Outcome {
  id: string;
  tier: number;
  tags: string[];
  question: string;
  gold_sql: string | null;
  pred_sql: string | null;
  ok: boolean;
  status: Status;
  error: string | null;
  answer: string;
  turns: number;
  turn_cap: boolean;
  wall_s: number;
  tool_calls: number;
  tools: Record<string, number>;
  in_tokens: number;
  out_tokens: number;
  cache_read: number | null;
  cache_write: number | null;
  candidates: string[];
  recall: boolean | null;
  risky: boolean;
  verdict: AskAnswer["verdict"]["status"];
}

// ---- flags -----------------------------------------------------------------

interface Args {
  bench: string;
  model: string;
  provider: ProviderId;
  tier: Tier | null;
  ids: string[] | null;
  jobs: number;
  out: string | null;
  label: string;
  dsn: string;
  goldCheck: boolean;
  progress: string | null;
  baseUrl: string | null;
  maxTurns: number;
  timeoutS: number;
  claudeBin: string | null;
  baseline: string | null;
}

function parseArgs(argv: string[]): Args {
  const flags = new Map<string, string[]>();
  let key: string | null = null;
  for (const arg of argv) {
    if (arg.startsWith("--")) {
      key = arg.slice(2);
      if (!flags.has(key)) flags.set(key, []);
      const eq = key.indexOf("=");
      if (eq !== -1) {
        const name = key.slice(0, eq);
        flags.delete(key);
        flags.set(name, [key.slice(eq + 1)]);
        key = null;
      }
      continue;
    }
    if (key) flags.get(key)?.push(arg);
  }
  const one = (name: string, fallback: string | null = null): string | null =>
    flags.get(name)?.[0] ?? (flags.has(name) ? "" : fallback);
  const bench = one("bench", "eval/bench/pagila.json") ?? "";
  const model = one("model", "claude-haiku-4-5") ?? "";
  const providerRaw = one("provider", "claude-code") ?? "";
  if (
    providerRaw !== "claude-code" &&
    providerRaw !== "anthropic" &&
    !isPresetId(providerRaw)
  ) {
    throw new Error(
      `unknown provider '${providerRaw}'. Use claude-code, anthropic, or an OpenAI-compatible preset id`,
    );
  }
  const tierRaw = one("tier");
  if (tierRaw && !["small", "mid", "large"].includes(tierRaw)) {
    throw new Error(`unknown tier '${tierRaw}'. Use small, mid or large`);
  }
  const label =
    one("label") || `${bench.replace(/^.*\//, "").replace(/\.json$/, "")}-${model}`;
  return {
    bench,
    model,
    provider: providerRaw as ProviderId,
    tier: (tierRaw as Tier | null) || null,
    ids: flags.get("ids")?.length ? (flags.get("ids") as string[]) : null,
    jobs: Number(one("jobs", "1")) || 1,
    out: one("out") || join("eval/results", `${label}.json`),
    label,
    dsn: one("dsn", DEFAULT_DSN) ?? DEFAULT_DSN,
    goldCheck: flags.has("gold-check"),
    progress: one("progress") || join("eval/results", `progress-${label}.jsonl`),
    baseUrl: one("base-url"),
    maxTurns: Number(one("max-turns", String(MAX_TURNS))) || MAX_TURNS,
    timeoutS: Number(one("timeout", String(DEFAULT_TIMEOUT_S))) || DEFAULT_TIMEOUT_S,
    claudeBin: one("claude-bin"),
    baseline: flags.has("baseline") ? one("baseline") || "eval/baseline.json" : null,
  };
}

// ---- database --------------------------------------------------------------

async function connect(dsn: string): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: dsn });
  await client.connect();
  return client;
}

/** A gold or predicted statement, run for COMPARISON rather than for the
 * model: the row cap is the harness's, and the column type OIDs come back so
 * the normaliser can apply the right rule per column. */
async function runForCompare(client: pg.Client, sql: string): Promise<RawResult> {
  const raw = await runReadonly(client, sql, COMPARE_ROW_CAP, RUN_TIMEOUT_MS);
  if (raw.capped) throw new Error(`result exceeded ${COMPARE_ROW_CAP} rows`);
  return raw;
}

// ---- gold check ------------------------------------------------------------

async function goldCheck(client: pg.Client, questions: Question[]): Promise<number> {
  let bad = 0;
  let ties = 0;
  for (const q of questions) {
    if (!q.gold_sql) {
      console.log(`  ${q.id}: no gold SQL`);
      continue;
    }
    let rows = 0;
    try {
      rows = (await runForCompare(client, q.gold_sql)).rowCount;
    } catch (e) {
      bad++;
      console.log(`  ${q.id}: GOLD FAILED - ${(e as Error).message}`);
      continue;
    }
    const tie = await tieCheck(q.gold_sql, async (sql) => {
      const raw = await runForCompare(client, sql);
      return { columns: raw.columns, typeOids: raw.typeOids, rows: raw.rows };
    }).catch(() => ({ checked: false }) as const);
    const note = !tie.checked
      ? ""
      : tie.tie === true
        ? "  TIE AT THE LIMIT BOUNDARY: the gold answer is not unique"
        : tie.tie === null
          ? "  (boundary unreadable: ORDER BY key not in the result)"
          : "  (limit boundary is clean)";
    if (tie.checked && tie.tie === true) ties++;
    console.log(`  ${q.id}: ${rows} rows${note}`);
  }
  const okCount = questions.length - bad;
  console.log(`\n${okCount}/${questions.length} gold queries OK, ${ties} with a tied boundary`);
  return bad + ties;
}

// ---- one question ----------------------------------------------------------

interface RunContext {
  args: Args;
  snapshot: SchemaSnapshot;
  emit: (event: Record<string, unknown>) => void;
  platform: ReturnType<typeof createNodePlatform>;
  register: (ref: string, tools: ReturnType<typeof createNodeTools>) => void;
  release: (ref: string) => void;
  /** gold and prediction both run here, on ONE shared connection, so every
   * verdict in a run is measured against the same session settings */
  compare: (sql: string) => Promise<RawResult>;
}

/** Every tool call the question made, by name, read off the trace. For a
 * provider with `ownsLoop` the trace is the only record there is: `claude -p`
 * ran the calls itself and reported them back (AGENT-SPEC section 7). The
 * loop's own final `run_sql` is one of these, because it is one. */
function toolCounts(answer: AskAnswer): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const step of answer.trace) {
    if (step.step === "tool") counts[step.name] = (counts[step.name] ?? 0) + 1;
  }
  return counts;
}

async function evaluate(ctx: RunContext, q: Question): Promise<Outcome> {
  const { args } = ctx;
  const client = await connect(args.dsn);
  // the thread id IS the session ref the platform resolves tools by, AND the
  // `claude -p` --session-id, which the CLI requires to be a bare uuid
  const ref = randomUUID();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), args.timeoutS * 1000);
  const started = Date.now();
  let answer: AskAnswer | null = null;
  let failure: string | null = null;
  try {
    const tools = createNodeTools({ client, snapshot: ctx.snapshot });
    ctx.register(ref, tools);
    const provider = createProvider(
      {
        providerId: args.provider,
        model: args.model,
        ...(args.baseUrl ? { baseUrl: args.baseUrl } : {}),
      },
      ctx.platform,
    );
    const tier = args.tier ?? tierOf(args.model, args.provider).tier;
    answer = await runAsk({
      question: q.question,
      snapshot: ctx.snapshot,
      tools,
      provider,
      model: args.model,
      tier,
      signal: controller.signal,
      thread: { id: ref, firstCall: true },
      maxTurns: args.maxTurns,
      goldSql: q.gold_sql,
    });
  } catch (e) {
    failure = (e as Error).message;
  } finally {
    clearTimeout(timer);
    ctx.release(ref);
    await client.end().catch(() => undefined);
  }
  const wall = (Date.now() - started) / 1000;

  const predSql = answer?.sql ?? null;
  let predRows: string[][] | null = null;
  let error: string | null = failure;
  if (predSql) {
    try {
      const raw = await ctx.compare(predSql);
      predRows = normalise(raw.rows, raw.typeOids);
    } catch (e) {
      error = (e as Error).message;
    }
  } else if (!error) {
    const verdict = answer?.verdict;
    error =
      verdict?.status === "failed"
        ? verdict.message
        : verdict?.status === "turn_cap"
          ? `stopped after ${verdict.turns} turns`
          : verdict?.status === "cancelled"
            ? `cancelled after ${args.timeoutS}s`
            : "no SQL in the answer";
  }

  let goldRows: string[][] | null = null;
  if (q.gold_sql) {
    const raw = await ctx.compare(q.gold_sql);
    goldRows = normalise(raw.rows, raw.typeOids);
  }

  const ok =
    goldRows === null ? predRows !== null : predRows !== null && sameRows(predRows, goldRows);
  const status: Status =
    goldRows === null
      ? predRows !== null
        ? "RAN"
        : "EXEC-FAIL"
      : predRows === null
        ? "EXEC-FAIL"
        : ok
          ? "PASS"
          : "WRONG";

  const usage = answer?.usage ?? { input: 0, output: 0 };
  const tools = answer ? toolCounts(answer) : {};
  return {
    id: q.id,
    tier: q.tier,
    tags: q.tags,
    question: q.question,
    gold_sql: q.gold_sql,
    pred_sql: predSql,
    ok,
    status,
    error,
    answer: (answer?.text ?? "").slice(-600),
    turns: answer?.turns ?? 0,
    turn_cap: answer?.verdict.status === "turn_cap",
    wall_s: Math.round(wall * 10) / 10,
    tool_calls: Object.values(tools).reduce((a, b) => a + b, 0),
    tools,
    in_tokens: usage.input,
    out_tokens: usage.output,
    cache_read: usage.cacheRead ?? null,
    cache_write: usage.cacheWrite ?? null,
    candidates: answer?.candidates ?? [],
    recall: answer?.recall ?? null,
    risky: answer?.risky ?? false,
    verdict: answer?.verdict.status ?? "failed",
  };
}

// ---- summary ---------------------------------------------------------------

/** Today where the run happened, YYYY-MM-DD. */
function localDate(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

const pct = (n: number, d: number) => (d === 0 ? "  -  " : `${Math.round((100 * n) / d)}%`.padStart(5));

function fraction(rows: Outcome[]): string {
  const passed = rows.filter((r) => r.ok).length;
  return `${String(passed).padStart(3)}/${String(rows.length).padEnd(3)} ${pct(passed, rows.length)}`;
}

function avg(rows: Outcome[], pick: (r: Outcome) => number | null): number | null {
  const vals = rows.map(pick).filter((v): v is number => typeof v === "number");
  if (vals.length === 0) return null;
  return Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10;
}

function summarise(args: Args, results: Outcome[]): string {
  const lines: string[] = [];
  const passed = results.filter((r) => r.ok).length;
  const recallRows = results.filter((r) => r.recall !== null);
  const recall = recallRows.length
    ? recallRows.filter((r) => r.recall).length / recallRows.length
    : null;
  lines.push("");
  lines.push(`${args.label}  ${args.model} via ${args.provider}  prompt ${PROMPT_VERSION}`);
  lines.push(`overall   ${fraction(results)}`);
  lines.push("");
  lines.push("  by tier      pass          turns  tools   wall    out");
  for (const tier of [...new Set(results.map((r) => r.tier))].sort()) {
    const rows = results.filter((r) => r.tier === tier);
    lines.push(
      `  tier ${tier}       ${fraction(rows)}   ${String(avg(rows, (r) => r.turns) ?? "-").padStart(5)}` +
        `  ${String(avg(rows, (r) => r.tool_calls) ?? "-").padStart(5)}` +
        `  ${String(avg(rows, (r) => r.wall_s) ?? "-").padStart(5)}s` +
        `  ${String(avg(rows, (r) => r.out_tokens) ?? "-").padStart(6)}`,
    );
  }
  const groups = [...new Set(results.flatMap((r) => r.tags))].sort();
  if (groups.length) {
    lines.push("");
    lines.push("  by group     pass");
    for (const g of groups) {
      const rows = results.filter((r) => r.tags.includes(g));
      lines.push(`  ${g.padEnd(11)}  ${fraction(rows)}`);
    }
  }
  const capped = results.filter((r) => r.turn_cap);
  const failed = results.filter((r) => r.status === "EXEC-FAIL");
  const wrong = results.filter((r) => r.status === "WRONG");
  lines.push("");
  lines.push(
    `  turns ${avg(results, (r) => r.turns) ?? "-"} avg, cap hits ${capped.length}` +
      `   recall ${recall === null ? "-" : `${Math.round(recall * 100)}%`}` +
      `   risky ${results.filter((r) => r.risky).length}/${results.length}`,
  );
  lines.push(
    `  tokens in ${avg(results, (r) => r.in_tokens) ?? "-"}  cached ${avg(results, (r) => r.cache_read) ?? "-"}` +
      `  out ${avg(results, (r) => r.out_tokens) ?? "-"}   wall ${avg(results, (r) => r.wall_s) ?? "-"}s avg`,
  );
  const allTools: Record<string, number> = {};
  for (const r of results) {
    for (const [name, n] of Object.entries(r.tools)) allTools[name] = (allTools[name] ?? 0) + n;
  }
  lines.push(`  tools ${Object.entries(allTools).map(([k, v]) => `${k}=${v}`).join(" ") || "none"}`);
  if (wrong.length) lines.push(`  WRONG      ${wrong.map((r) => r.id).join(" ")}`);
  if (failed.length) lines.push(`  EXEC-FAIL  ${failed.map((r) => r.id).join(" ")}`);
  if (capped.length) lines.push(`  TURN CAP   ${capped.map((r) => r.id).join(" ")}`);
  lines.push("");
  lines.push(`${passed}/${results.length}`);
  return lines.join("\n");
}

// ---- the PR gate (EVAL.md section 4) --------------------------------------

interface BaselineRow {
  bench: string;
  provider: string;
  model: string;
  prompt_version: string;
  passed: number;
  total: number;
  recall: number | null;
  turn_cap_hits: number;
  avg_turns: number | null;
  date: string;
}

interface Baseline {
  note?: string;
  runs: BaselineRow[];
}

/** A run's numbers against the committed baseline for the same bench, model
 * and PROMPT_VERSION. Three ways to fail, all from EVAL.md section 4: more
 * than one question lost, any turn-cap hit, or prefilter recall below the
 * baseline. A baseline that does not exist for this combination is NOT a
 * pass: it is reported as unmeasured, so a green run never stands in for a
 * measurement nobody took. */
export function gateAgainst(
  baseline: Baseline,
  run: { bench: string; provider: string; model: string; passed: number; total: number; recall: number | null; turnCapHits: number },
): { ok: boolean; lines: string[] } {
  const bench = run.bench.replace(/^.*\//, "");
  const row = baseline.runs.find(
    (r) =>
      r.bench.replace(/^.*\//, "") === bench &&
      r.model === run.model &&
      r.provider === run.provider &&
      r.prompt_version === PROMPT_VERSION,
  );
  if (!row) {
    return {
      ok: false,
      lines: [
        `no baseline for ${bench} + ${run.model} via ${run.provider} + prompt ${PROMPT_VERSION}.`,
        "Record one with the measured table in the commit message (EVAL.md section 4).",
      ],
    };
  }
  const lines = [
    `baseline ${row.passed}/${row.total} recall ${row.recall ?? "-"} (${row.date})`,
    `this run ${run.passed}/${run.total} recall ${run.recall ?? "-"}`,
  ];
  let ok = true;
  if (run.passed < row.passed - 1) {
    ok = false;
    lines.push(`FAIL: ${row.passed - run.passed} questions below the baseline (1 is tolerated)`);
  }
  if (run.turnCapHits > 0) {
    ok = false;
    lines.push(`FAIL: ${run.turnCapHits} question(s) hit the turn cap`);
  }
  if (row.recall !== null && run.recall !== null && run.recall < row.recall) {
    ok = false;
    lines.push(`FAIL: prefilter recall ${run.recall} is below the baseline ${row.recall}`);
  }
  if (ok) lines.push("gate: pass");
  return { ok, lines };
}

// ---- main ------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const benchPath = resolvePath(ROOT, args.bench);
  let questions = JSON.parse(readFileSync(benchPath, "utf8")) as Question[];
  if (args.ids) questions = questions.filter((q) => args.ids?.includes(q.id));
  if (questions.length === 0) throw new Error(`no questions selected from ${args.bench}`);

  const goldClient = await connect(args.dsn);
  try {
    if (args.goldCheck) {
      const bad = await goldCheck(goldClient, questions);
      process.exitCode = bad ? 1 : 0;
      return;
    }

    const snapshot = await introspect(goldClient);
    const registry = new Map<string, ReturnType<typeof createNodeTools>>();
    const platform = createNodePlatform({
      toolsFor: (ref) => registry.get(ref),
      ...(args.claudeBin ? { claudeBin: args.claudeBin } : {}),
      // a child that dies before it speaks leaves only stderr behind, and a
      // silent harness turns that into "no SQL produced" with no cause
      ...(process.env.QWRY_EVAL_DEBUG
        ? { onStderr: (line: string) => console.error(`  [claude] ${line}`) }
        : {}),
    });

    const progressPath = args.progress ? resolvePath(ROOT, args.progress) : null;
    if (progressPath) mkdirSync(dirname(progressPath), { recursive: true });
    const emit = (event: Record<string, unknown>) => {
      if (!progressPath) return;
      appendFileSync(
        progressPath,
        `${JSON.stringify({ ts: Math.round(Date.now() / 100) / 10, ...event })}\n`,
      );
    };

    console.log(
      `${args.label}: ${questions.length} questions, ${args.model} via ${args.provider}, ` +
        `${snapshot.tables.length} tables, jobs ${args.jobs}`,
    );
    emit({
      ev: "run_start",
      label: args.label,
      model: `${args.model} · ${args.provider}`,
      context: "agent",
      repair: args.maxTurns,
      total: questions.length,
      schema_chars: snapshot.tables.length,
    });

    // one shared connection for every comparison, so the runs queue behind a
    // chain: a PostgreSQL session runs one statement at a time, and three
    // workers pointing at one session is the deprecation warning `pg` prints
    let lock: Promise<unknown> = Promise.resolve();
    const compare = (sql: string): Promise<RawResult> => {
      const next = lock.then(
        () => runForCompare(goldClient, sql),
        () => runForCompare(goldClient, sql),
      );
      lock = next.catch(() => undefined);
      return next;
    };

    const ctx: RunContext = {
      args,
      snapshot,
      emit,
      platform,
      register: (ref, tools) => registry.set(ref, tools),
      release: (ref) => registry.delete(ref),
      compare,
    };

    const queue = [...questions];
    const results: Outcome[] = [];
    const worker = async () => {
      for (;;) {
        const q = queue.shift();
        if (!q) return;
        const outcome = await evaluate(ctx, q).catch(
          (e: Error): Outcome => ({
            id: q.id,
            tier: q.tier,
            tags: q.tags,
            question: q.question,
            gold_sql: q.gold_sql,
            pred_sql: null,
            ok: false,
            status: "EXEC-FAIL",
            error: e.message,
            answer: "",
            turns: 0,
            turn_cap: false,
            wall_s: 0,
            tool_calls: 0,
            tools: {},
            in_tokens: 0,
            out_tokens: 0,
            cache_read: null,
            cache_write: null,
            candidates: [],
            recall: null,
            risky: false,
            verdict: "failed",
          }),
        );
        results.push(outcome);
        console.log(
          `  ${outcome.id.padEnd(7)} ${outcome.status.padEnd(9)} turns=${outcome.turns}` +
            ` tools=${outcome.tool_calls} ${String(outcome.wall_s).padStart(5)}s` +
            ` out=${outcome.out_tokens} recall=${outcome.recall ?? "-"}` +
            (outcome.error ? `  ${outcome.error.slice(0, 90)}` : ""),
        );
        ctx.emit({
          ev: "q",
          id: outcome.id,
          tier: outcome.tier,
          tags: outcome.tags,
          question: outcome.question,
          gold_sql: outcome.gold_sql,
          pred_sql: outcome.pred_sql,
          status: outcome.status,
          ok: outcome.ok,
          lat: outcome.wall_s,
          attempts: [
            {
              sql: outcome.pred_sql,
              error: outcome.error,
              turns: outcome.turns,
              tools: outcome.tools,
            },
          ],
        });
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, args.jobs) }, worker));
    platform.stop();

    results.sort((a, b) => (a.id < b.id ? -1 : 1));
    const passed = results.filter((r) => r.ok).length;
    emit({ ev: "run_end", label: args.label, passed, total: results.length });

    const summary = summarise(args, results);
    console.log(summary);

    if (args.out) {
      const outPath = resolvePath(ROOT, args.out);
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(
        outPath,
        `${JSON.stringify(
          {
            config: {
              bench: args.bench,
              model: args.model,
              provider: args.provider,
              tier: args.tier,
              jobs: args.jobs,
              max_turns: args.maxTurns,
              prompt_version: PROMPT_VERSION,
              label: args.label,
              // local, not UTC: a run just after midnight should not be
              // dated yesterday in the baseline a human reads
              date: localDate(),
            },
            summary: {
              passed,
              total: results.length,
              turn_cap_hits: results.filter((r) => r.turn_cap).length,
              avg_turns: avg(results, (r) => r.turns),
              avg_tool_calls: avg(results, (r) => r.tool_calls),
              avg_wall_s: avg(results, (r) => r.wall_s),
              avg_in_tokens: avg(results, (r) => r.in_tokens),
              avg_out_tokens: avg(results, (r) => r.out_tokens),
              recall: (() => {
                const rows = results.filter((r) => r.recall !== null);
                return rows.length
                  ? Math.round((100 * rows.filter((r) => r.recall).length) / rows.length) / 100
                  : null;
              })(),
            },
            results,
          },
          null,
          1,
        )}\n`,
      );
      console.log(`wrote ${args.out}`);
    }

    process.exitCode = 0;
    if (args.baseline) {
      const recallRows = results.filter((r) => r.recall !== null);
      const recall = recallRows.length
        ? Math.round((100 * recallRows.filter((r) => r.recall).length) / recallRows.length) / 100
        : null;
      const baseline = JSON.parse(
        readFileSync(resolvePath(ROOT, args.baseline), "utf8"),
      ) as Baseline;
      const gate = gateAgainst(baseline, {
        bench: args.bench,
        provider: args.provider,
        model: args.model,
        passed,
        total: results.length,
        recall,
        turnCapHits: results.filter((r) => r.turn_cap).length,
      });
      console.log(`\n${gate.lines.join("\n")}`);
      if (!gate.ok) process.exitCode = 1;
    }
  } finally {
    await goldClient.end().catch(() => undefined);
  }
}

// importable for its own unit test: `gateAgainst` is the PR gate's whole
// decision, and a gate nothing tests is a gate nobody trusts
if (import.meta.main) await main();
