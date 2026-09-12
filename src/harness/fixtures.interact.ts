// Round-2 interaction states for the Ask fixture harness, built on the locked
// sketch's answer exchange (fixtures.ts): `pending` (one assumption chip
// flipped off, the retry pill floating over the composer), `retry` (a retry
// streaming over the prior answer: one running `run` chip in the strip, the
// old prose, grid and footer still on screen, the Stop face) and `strip` (nine
// tool chips, so the thinking strip scrolls and both edge fades show). The
// integrator wires these into fixtures.ts / AskHarness.tsx / ask-frames.ts;
// this file only exports the seeds. Types are the store's own, so a shape
// change is a tsc failure, never a frame that quietly renders something else.

import type { AskPhase } from "../agent/loop";
import type { TraceStep } from "../agent/types";
import type { Exchange, ToolChip } from "../stores/agent";
import { exchangeFor } from "./fixtures";

export type InteractState = "pending" | "retry" | "strip";
export const INTERACT_STATES: readonly InteractState[] = ["pending", "retry", "strip"];

export interface InteractSeed {
  exchange: Exchange;
  /** useAgent.pending: the exchange's wanted chip states that differ */
  pending: Record<string, Record<string, boolean>>;
  busy: boolean;
  phase: AskPhase | null;
  /** the strip's scrollLeft after mount (a settled still cannot show both
   * fades from a chip arrival alone); null leaves the strip where it mounts */
  stripScroll: number | null;
}

function base(): Exchange {
  const ex = exchangeFor("answer");
  if (!ex) throw new Error("fixtures: the answer exchange is missing");
  return ex;
}

/** the chip the sketch's pending frame draws off: `This Year = 2026` */
const FLIPPED = "model:1";

const tool = (c: ToolChip): TraceStep => ({
  step: "tool",
  ms: c.ms ?? 0,
  id: c.id,
  name: c.name,
  args: c.args,
  result: c.result ?? "",
  isError: c.isError,
});

const chip = (
  id: string,
  name: ToolChip["name"],
  label: string,
  ms: number,
  args: string,
  result: string,
): ToolChip => ({ id, name, label, ms, isError: false, args, result });

function pending(): InteractSeed {
  const exchange: Exchange = { ...base(), id: "harness-ex-pending" };
  return {
    exchange,
    pending: { [exchange.id]: { [FLIPPED]: false } },
    busy: false,
    phase: null,
    stripScroll: null,
  };
}

function retry(): InteractSeed {
  const prior = base();
  const run = prior.chips.find((c) => c.name === "run_sql");
  if (!run) throw new Error("fixtures: the answer exchange has no run chip");
  const exchange: Exchange = {
    ...prior,
    id: "harness-ex-retry",
    streaming: true,
    chips: [{ ...run, id: "retry-call-1", ms: null, result: null }],
    thinking: "",
    error: null,
    prior: {
      text: prior.text,
      thinking: prior.thinking,
      chips: prior.chips,
      answer: prior.answer,
      error: prior.error,
    },
  };
  return {
    exchange,
    pending: { [exchange.id]: { [FLIPPED]: false } },
    busy: true,
    phase: "running",
    stripScroll: null,
  };
}

function strip(): InteractSeed {
  const prior = base();
  const run = prior.chips.find((c) => c.name === "run_sql");
  if (!run) throw new Error("fixtures: the answer exchange has no run chip");
  const describe = (id: string, table: string, ms: number) =>
    chip(id, "describe_tables", `describe ${table}`, ms, JSON.stringify({ names: [table] }), `${table} (…)`);
  const peek = (id: string, column: string, ms: number) =>
    chip(
      id,
      "peek_values",
      `peek ${column}`,
      ms,
      JSON.stringify({ table: "public.users", column }),
      `${column}: 4 distinct values`,
    );
  // the loop names a probe by what it measures (probeNoun): the chip reads
  // `probe sent_at`, never bare `probe`
  const probe = (id: string, noun: string, sql: string, ms: number) =>
    chip(id, "probe", `probe ${noun}`, ms, JSON.stringify({ sqls: [sql] }), "min | max\n2019-03-04 | 2026-09-05");
  const chips: ToolChip[] = [
    describe("strip-1", "users", 388),
    peek("strip-2", "is_deleted", 61),
    describe("strip-3", "notification_history", 412),
    peek("strip-4", "channel", 74),
    probe("strip-5", "sent_at", "SELECT min(sent_at), max(sent_at) FROM notification_history", 688),
    describe("strip-6", "sessions", 302),
    peek("strip-7", "platform", 58),
    probe("strip-8", "started_at", "SELECT count(*) FROM sessions WHERE started_at > now() - interval '1 day'", 240),
    { ...run, id: "strip-9" },
  ];
  const answer = prior.answer;
  if (!answer) throw new Error("fixtures: the answer exchange has no answer");
  // the trace carries the same nine calls, so every chip opens a real step
  const trace: TraceStep[] = [
    ...answer.trace.filter((s) => s.step !== "tool"),
    ...chips.map(tool),
  ];
  const exchange: Exchange = {
    ...prior,
    id: "harness-ex-strip",
    chips,
    answer: { ...answer, trace },
  };
  return { exchange, pending: {}, busy: false, phase: null, stripScroll: 120 };
}

export function interactSeed(state: InteractState): InteractSeed {
  switch (state) {
    case "pending":
      return pending();
    case "retry":
      return retry();
    case "strip":
      return strip();
  }
}
