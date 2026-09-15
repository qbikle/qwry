// Follow-up suggestions (AGENT-SPEC section 4.6, AGENT-UX section 6): one
// more model call after an answered verdict, no tools, three questions the
// user could type next. It runs outside runAsk so the answer lands first and
// the chips fade in when they exist (AGENT-UX section 2); the eval harness
// never calls it, so the measured loop is untouched.
//
// W7: the chips stand ONCE, under the thread's last answer, so the call is
// per thread and reads the whole conversation. Per-exchange rows are gone;
// what a thread is currently suggesting lives in useAgent.followUps.
//
// Provider-neutral like the loop (section 7) and just as visible: the call is
// returned as a trace step so nothing sent to a provider is hidden (section
// 8.4). The call goes through `sideText`: a hosted provider's tool-less
// `chat`, or an `ownsLoop` provider's thread-free `sideChat` (a `claude -p`
// with no `--resume`, so the thread's conversation never sees it).

import { sideText } from "./providers/side";
import type { Provider, SideChatResult } from "./providers/types";
import type { TraceStep } from "./types";
import { FOLLOWUP_SYSTEM_PROMPT, followUpMessage } from "./prompt";

export const FOLLOWUPS_SHOWN = 3;
const QUESTION_CAP = 160;

export interface FollowUpRequest {
  /** the WHOLE thread as one transcript (W7): the store builds it with
   * `replayOf`, one Q / SQL / first-sentence block per exchange, oldest
   * dropped under the cap. One row of chips stands at the thread's end, so
   * one call reads everything asked and answered */
  thread: string;
  /** every question already asked in the thread, the current one included.
   * It is in `thread` too; this is the parser's filter, not the prompt's */
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
  if (req.signal.aborted) return { questions: [], step: null };
  const now = req.now ?? (() => Date.now());
  const started = now();
  const prompt = followUpMessage({ thread: req.thread });
  let out: SideChatResult;
  try {
    out = await sideText(req.provider, {
      system: FOLLOWUP_SYSTEM_PROMPT,
      user: prompt,
      model: req.model,
      signal: req.signal,
    });
  } catch {
    // suggestions are a courtesy: a failure here costs the chips, never the
    // answer, and never reaches the failure block
    return { questions: [], step: null };
  }
  if (req.signal.aborted) return { questions: [], step: null };
  const questions = parseFollowUps(out.text, req.asked);
  return {
    questions,
    step: {
      step: "followups",
      ms: Math.round(now() - started),
      prompt,
      text: out.text,
      questions,
      ...(out.usage ? { usage: out.usage } : {}),
    },
  };
}
