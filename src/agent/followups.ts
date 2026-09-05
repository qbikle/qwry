// Follow-up suggestions (AGENT-SPEC section 4.6, AGENT-UX section 6): one
// more model call after an answered verdict, no tools, three questions the
// user could type next. It runs outside runAsk so the answer lands first and
// the chips fade in when they exist (AGENT-UX section 2); the eval harness
// never calls it, so the measured loop is untouched.
//
// Provider-neutral like the loop (section 7) and just as visible: the call is
// returned as a trace step so nothing sent to a provider is hidden (section
// 8.4). `ownsLoop` providers are refused up front: a `claude -p` side call
// would `--resume` the thread and write itself into the conversation.

import type { AgentEvent, Provider } from "./providers/types";
import type { TokenUsage, TraceStep } from "./types";
import { FOLLOWUP_SYSTEM_PROMPT, followUpMessage } from "./prompt";

export const FOLLOWUPS_SHOWN = 3;
const QUESTION_CAP = 160;

export interface FollowUpRequest {
  question: string;
  /** the model's final prose */
  answer: string;
  sql: string | null;
  /** every question already asked in the thread, the current one included */
  asked: string[];
  provider: Provider;
  model: string;
  signal: AbortSignal;
  now?: () => number;
}

export interface FollowUpResult {
  questions: string[];
  /** the call as the trace shows it; null when no call was made */
  step: Extract<TraceStep, { step: "followups" }> | null;
}

const BULLET = /^[\s\-*•>]+|^\d+[.)]\s*|^Q\d*[:.)]\s*/i;
const QUOTES = /^["'“”‘’]+|["'“”‘’]+$/g;

/** the model's reply as questions: one per line, bullets and numbering
 * stripped, no duplicates, nothing already asked, at most three */
export function parseFollowUps(text: string, asked: readonly string[] = []): string[] {
  const seen = new Set(asked.map((q) => q.trim().toLowerCase()));
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    if (out.length === FOLLOWUPS_SHOWN) break;
    const line = raw.replace(BULLET, "").replace(QUOTES, "").trim();
    if (!line || line.length > QUESTION_CAP || !line.endsWith("?")) continue;
    if (/^(here|these|follow[- ]?ups?)\b/i.test(line)) continue;
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line);
  }
  return out;
}

export async function suggestFollowUps(req: FollowUpRequest): Promise<FollowUpResult> {
  if (req.provider.ownsLoop || req.signal.aborted) return { questions: [], step: null };
  const now = req.now ?? (() => Date.now());
  const started = now();
  const prompt = followUpMessage({
    question: req.question,
    answer: req.answer,
    sql: req.sql,
    asked: req.asked,
  });
  const usage: TokenUsage = { input: 0, output: 0 };
  let text = "";
  try {
    const stream = req.provider.chat({
      system: FOLLOWUP_SYSTEM_PROMPT,
      messages: [{ role: "user", content: prompt }],
      tools: [],
      model: req.model,
      signal: req.signal,
    });
    for await (const ev of stream as AsyncIterable<AgentEvent>) {
      if (req.signal.aborted) return { questions: [], step: null };
      if ("text" in ev) text += ev.text;
      else if ("usage" in ev) {
        usage.input += ev.usage.input;
        usage.output += ev.usage.output;
      } else if ("error" in ev) {
        // suggestions are a courtesy: a failure here costs the chips, never
        // the answer, and never reaches the failure block
        return { questions: [], step: null };
      }
    }
  } catch {
    return { questions: [], step: null };
  }
  const questions = parseFollowUps(text, req.asked);
  return {
    questions,
    step: {
      step: "followups",
      ms: Math.round(now() - started),
      prompt,
      text,
      questions,
      usage,
    },
  };
}
