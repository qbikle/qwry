// Which trace step produced a sanity fragment (AGENT-UX section 4: "clicking
// a fragment shows the probe that produced it"). A fragment produced by the
// loop names its call (`stepId`, agent/types.ts SanityFragment), and that id
// wins whenever the trace carries it (LESSONS 4: provenance is structural).
// Fragments without one (answers persisted before the field existed) fall
// back to the structural match below. A probe
// whose `sqls` lists it; the args are compared parsed, because the raw JSON
// escapes the quotes and newlines a real statement has. A `checked <col>
// values` fragment has no SQL at all (loop.ts sanityLine builds it from the
// peek_values calls), so it matches the first peek_values call whose column
// the text names, whole-word, so `status` never claims `payment_status`.
// Null when nothing in the trace claims the fragment: the caller then opens
// the trace at the top rather than pretending some other step is the probe.

import type { SanityFragment, TraceStep } from "../agent/types";

type ToolStep = Extract<TraceStep, { step: "tool" }>;

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function sanityStep(fragment: SanityFragment, trace: TraceStep[]): string | null {
  const tools = trace.filter((t): t is ToolStep => t.step === "tool");
  const stepId = fragment.stepId;
  if (stepId !== undefined && tools.some((t) => t.id === stepId)) return stepId;
  const sql = fragment.sql;
  if (sql !== undefined) {
    const probe = tools.find(
      (t) =>
        t.name === "probe" && (strings(parseArgs(t.args).sqls).includes(sql) || t.args.includes(sql)),
    );
    return probe?.id ?? null;
  }
  for (const t of tools) {
    if (t.name !== "peek_values") continue;
    const column = parseArgs(t.args).column;
    if (typeof column !== "string" || column === "") continue;
    if (new RegExp(`\\b${escapeRe(column)}\\b`).test(fragment.text)) return t.id;
  }
  return null;
}
