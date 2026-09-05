// Trace drawer (AGENT-UX section 5): slides over the thread inside the card
// (CSS transform, --dur-slow / --ease-std) and lists every step in loop order:
// context (candidates, expandable to the exact block sent), each model turn
// (raw text, thinking), each tool call with its arguments and result, the
// verdict. Timing per step in the status register; the verdict row carries
// none, its ms is the whole run and the header already states that (DESIGN
// rule 14). Teaching surface: keycaps allowed. Nothing is summarised away,
// and the drawer says nothing about that norm (rule 11): the one note strip
// is Claude Code's, because its harness prefix is the one thing qwry cannot
// show, and no other provider gets a strip at all.
//
// Focus (AGENT-UX 12, LESSONS 7): the drawer is a non-modal panel INSIDE the
// card, so it does not use escStack (that stack makes every window chord
// stand down, which is right for a modal and wrong here: ⌘J and ⌘W must keep
// working with the trace open). Instead a scoped keydown on the drawer root
// owns exactly two keys: Tab wraps inside the drawer, Esc closes it; every
// chord bubbles to AskPanel and the window (LESSONS 10). On open, focus moves
// to the step that was asked for (a chip or a sanity fragment) or to the
// drawer root; on close it returns to the opener, else to the panel root.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { ArrowLeft } from "lucide-react";
import type { TraceStep } from "../agent/types";
import { secondsText } from "../lib/duration";
import type { Exchange } from "../stores/agent";
import { useAsk } from "../stores/ask";
import { revealRow } from "./revealRow";

export interface TraceDrawerProps {
  open: boolean;
  /** the exchange whose trace is showing; null while closed */
  exchange: Exchange | null;
  /** the tool step to expand and scroll to first (a chip or sanity fragment
   * opened the drawer), null for the footer link */
  focusStepId: string | null;
  onClose: () => void;
}

type Kind = "context" | "model" | "tool" | "verdict";

type ToolStep = Extract<TraceStep, { step: "tool" }>;

/** One rendered row. `body` null = nothing to expand (a chip of a run still
 * streaming: its arguments and result arrive with the answer). */
interface Row {
  key: string;
  kind: Kind;
  kindLabel: string;
  label: ReactNode;
  ms: number | null;
  body: ReactNode | null;
}

const toolKey = (id: string) => `tool:${id}`;

/** status register: `48 ms`, `2.9 s` */
export function fmtMs(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

const firstLine = (s: string) => s.split("\n").find((l) => l.trim() !== "")?.trim() ?? "";

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

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

/** what a tool call was about, in a few words: `users, orders`, `users.is_deleted`,
 * `2 queries`, `12 rows` */
function toolSummary(step: ToolStep): string {
  const args = parseArgs(step.args);
  switch (step.name) {
    case "list_tables":
      return "";
    case "describe_tables":
      return strings(args.names).join(", ");
    case "peek_values":
      return [args.table, args.column].filter((x) => typeof x === "string").join(".");
    case "probe": {
      const n = strings(args.sqls).length;
      return n > 0 ? plural(n, "query", "queries") : "";
    }
    case "run_sql": {
      if (!step.isError) {
        const m = /\((\d+) rows?\b/.exec(step.result);
        if (m) return plural(Number(m[1]), "row", "rows");
      }
      return typeof args.sql === "string" ? clip(firstLine(args.sql), 48) : "";
    }
    default:
      return clip(firstLine(step.args), 48);
  }
}

/** the arguments as the model wrote them, SQL shown as SQL rather than as an
 * escaped JSON string */
function argsText(step: ToolStep): string {
  const args = parseArgs(step.args);
  if (step.name === "run_sql" && typeof args.sql === "string") return args.sql;
  if (step.name === "probe") {
    const sqls = strings(args.sqls);
    if (sqls.length > 0) return sqls.join("\n\n");
  }
  return step.args;
}

function Sub({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <div className="trace-sub">{label}</div>
      <div>{children}</div>
    </>
  );
}

/** one tool call: the row the trace shows for it, and the row a finished chip
 * shows before the answer lands (same renderer, so they never drift) */
function toolRow(step: ToolStep, ms: number | null): Row {
  const summary = toolSummary(step);
  return {
    key: toolKey(step.id),
    kind: "tool",
    kindLabel: "tool",
    label: (
      <>
        <code>{step.name}</code>
        {summary ? ` ${summary}` : ""}
        {step.isError && <span className="trace-err"> · error</span>}
      </>
    ),
    ms,
    body: (
      <>
        <Sub label="args">{argsText(step)}</Sub>
        <Sub label="result">{step.result || <span className="trace-empty">empty</span>}</Sub>
      </>
    ),
  };
}

/** the loop's trace in loop order, one row per step; turn rows summarise the
 * tool calls that followed them until the next turn */
function rowsFromTrace(exchange: Exchange, trace: TraceStep[], timed: boolean): Row[] {
  const answer = exchange.answer;
  const rows: Row[] = [];
  const ms = (n: number) => (timed ? n : null);
  for (let i = 0; i < trace.length; i++) {
    const step = trace[i];
    switch (step.step) {
      case "context":
        rows.push({
          key: "context",
          kind: "context",
          kindLabel: "context",
          label: `${plural(step.candidates.length, "candidate table", "candidate tables")}${
            answer?.risky ? " · risk check on" : ""
          }`,
          ms: ms(step.ms),
          body: step.text,
        });
        break;
      case "turn": {
        const calls: string[] = [];
        for (let j = i + 1; j < trace.length; j++) {
          const next = trace[j];
          if (next.step !== "tool") break;
          const summary = toolSummary(next);
          calls.push(summary ? `${next.name}(${summary})` : next.name);
        }
        const label = calls.length > 0 ? calls.join(" · ") : step.text ? clip(firstLine(step.text), 120) : "no text";
        rows.push({
          key: `turn:${step.index}`,
          kind: "model",
          kindLabel: `turn ${step.index + 1}`,
          label,
          ms: ms(step.ms),
          body:
            step.thinking || step.text ? (
              <>
                {step.thinking && <Sub label="thinking">{step.thinking}</Sub>}
                {step.text && (step.thinking ? <Sub label="text">{step.text}</Sub> : step.text)}
              </>
            ) : (
              <span className="trace-empty">no text this turn</span>
            ),
        });
        break;
      }
      case "tool":
        rows.push(toolRow(step, ms(step.ms)));
        break;
      case "verdict": {
        const v = step.verdict;
        const head =
          v.status === "answered"
            ? `answered${v.rowCount !== null ? ` · ${plural(v.rowCount, "row", "rows")}` : ""}`
            : v.status === "failed"
              ? `failed · ${clip(firstLine(v.message), 80)}`
              : v.status === "turn_cap"
                ? `turn cap · ${plural(v.turns, "turn", "turns")}`
                : "cancelled";
        const assumptions = answer?.assumptions ?? [];
        const warnings = (answer?.sanity ?? []).filter((f) => f.warn).length;
        const label =
          head +
          (assumptions.length > 0 ? ` · ${plural(assumptions.length, "assumption", "assumptions")}` : "") +
          (warnings > 0 ? ` · ${plural(warnings, "warning", "warnings")}` : "");
        const lines: string[] = [];
        if (assumptions.length > 0) {
          lines.push(`Assumptions: ${assumptions.map((a) => `${a.label}${a.active ? "" : " (off)"}`).join("; ")}`);
        }
        if (v.status === "failed") lines.push(v.message);
        if (v.sql) lines.push(v.sql);
        // no time cell: the verdict's ms is elapsed-since-start, the run's
        // total, and the header prints that once (DESIGN rule 14)
        rows.push({
          key: "verdict",
          kind: "verdict",
          kindLabel: "verdict",
          label,
          ms: null,
          body: lines.length > 0 ? lines.join("\n\n") : head,
        });
        break;
      }
      case "followups":
        // the one model call made after the verdict (spec 4.6); shown because
        // nothing sent to a provider is hidden (spec 8.4). It is outside the
        // loop's turn count, so its kind is the species, not an ordinal: the
        // kind column is 56px and `FOLLOW-UPS` broke onto two lines in it
        rows.push({
          key: "followups",
          kind: "model",
          kindLabel: "model",
          label: plural(step.questions.length, "follow-up", "follow-ups"),
          ms: ms(step.ms),
          body: (
            <>
              <Sub label="sent">{step.prompt}</Sub>
              <Sub label="text">{step.text || <span className="trace-empty">empty</span>}</Sub>
            </>
          ),
        });
        break;
      default:
        break;
    }
  }
  return rows;
}

/** while the answer is still streaming the trace does not exist yet; the
 * chips are what is known: a finished chip already carries its arguments and
 * result, so it opens; a running one is a static row until it lands */
function rowsFromChips(exchange: Exchange): Row[] {
  return exchange.chips.map((c) => {
    if (c.result === null) {
      return {
        key: toolKey(c.id),
        kind: "tool",
        kindLabel: "tool",
        label: (
          <>
            <code>{c.name}</code> {c.label}
          </>
        ),
        ms: c.ms,
        body: null,
      };
    }
    return toolRow(
      { step: "tool", ms: c.ms ?? 0, id: c.id, name: c.name, args: c.args, result: c.result, isError: c.isError },
      c.ms,
    );
  });
}

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function TraceDrawer({ open, exchange, focusStepId, onClose }: TraceDrawerProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const answer = exchange?.answer ?? null;
  // a reloaded thread carries its tool steps but no step timings (appdb never
  // held them, the store writes 0): a 0 ms probe is a lie, so the cells go
  const timed = (answer?.turns ?? 0) > 0;

  const rows = useMemo<Row[]>(() => {
    if (!exchange) return [];
    if (answer) return rowsFromTrace(exchange, answer.trace, timed);
    return rowsFromChips(exchange);
  }, [exchange, answer, timed]);

  // the one qualifier (DESIGN rule 12): the run's turns and total, the footer's
  // status line without the model. The step list beneath already shows what
  // ran, so no count of any step kind rides here (rule 11: deleting `· 1 probe`
  // loses nothing the TOOL rows do not say). A reloaded thread stores no
  // turn count and may store no time; a zero of either is not printed
  const summary = useMemo(() => {
    if (!exchange) return "";
    if (!answer) return exchange.streaming ? "thinking" : "";
    const parts: string[] = [];
    if (answer.turns > 0) parts.push(plural(answer.turns, "turn", "turns"));
    if (answer.ms > 0) parts.push(secondsText(answer.ms));
    return parts.join(" · ");
  }, [exchange, answer]);

  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = useCallback((key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  // ---- open / close: capture the opener, return focus to it ----
  const openerRef = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open) {
      if (!wasOpen.current) {
        const ae = document.activeElement;
        openerRef.current = ae instanceof HTMLElement ? ae : null;
      }
      wasOpen.current = true;
      return;
    }
    if (!wasOpen.current) return;
    wasOpen.current = false;
    const opener = openerRef.current;
    openerRef.current = null;
    const id = requestAnimationFrame(() => {
      // the card is collapsing: App.tsx owns that focus restore
      if (!useAsk.getState().open) return;
      const root = rootRef.current;
      const ae = document.activeElement;
      const inside = !!root && root.contains(ae);
      // an action that deliberately focused something else on close wins
      if (ae && ae !== document.body && !inside) return;
      const panel = root?.closest<HTMLElement>(".ask-panel") ?? null;
      const target = opener && opener.isConnected && !root?.contains(opener) ? opener : panel;
      target?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(id);
  }, [open]);

  // ---- reveal: expand and scroll to the asked-for step, focus it ----
  const firstKey = rows[0]?.key ?? null;
  const revealedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!open || !exchange) {
      revealedFor.current = null;
      return;
    }
    const fresh = revealedFor.current !== exchange.id;
    revealedFor.current = exchange.id;
    const key = focusStepId ? toolKey(focusStepId) : firstKey;
    setExpanded((prev) => {
      const next = fresh ? new Set<string>() : new Set(prev);
      if (key) next.add(key);
      return next;
    });
    const id = requestAnimationFrame(() => {
      const root = rootRef.current;
      if (!root) return;
      let target: HTMLElement | null = null;
      if (key) {
        for (const el of root.querySelectorAll<HTMLElement>("[data-step]")) {
          if (el.dataset.step === key) {
            target = el.querySelector<HTMLElement>(".trace-step-h");
            break;
          }
        }
      }
      (target ?? root).focus({ preventScroll: true });
      // instant, never animated, and only the step list moves: the scroller
      // belongs to the user, and the pane must never scroll sideways to
      // meet a drawer still sliding in (revealRow)
      revealRow(root.querySelector<HTMLElement>(".trace-steps"), target);
    });
    return () => cancelAnimationFrame(id);
    // firstKey is derived from rows, which change while a run streams; the
    // reveal is about WHICH step was asked for, not about the list growing
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, exchange?.id, focusStepId]);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!open) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }
    // the trap owns Tab alone; every chord bubbles (LESSONS 10)
    if (e.key === "Tab" && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const root = rootRef.current;
      if (!root) return;
      const list = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (list.length === 0) {
        e.preventDefault();
        return;
      }
      const first = list[0];
      const last = list[list.length - 1];
      const active = document.activeElement;
      if (e.shiftKey) {
        if (active === first || active === root || !root.contains(active)) {
          e.preventDefault();
          last.focus({ preventScroll: true });
        }
      } else if (active === last || !root.contains(active)) {
        e.preventDefault();
        first.focus({ preventScroll: true });
      }
    }
  };

  // clicks inside the drawer keep focus in the drawer (WKWebView never
  // focuses a button on click); text in a step body stays selectable
  const onMouseDown = (e: ReactMouseEvent<HTMLDivElement>) => {
    e.stopPropagation();
    const t = e.target as HTMLElement;
    if (t.closest("button")) return;
    rootRef.current?.focus({ preventScroll: true });
  };

  // only the exception speaks (DESIGN rule 11): every other provider's trace
  // is complete, and a strip saying so is dead space. One sentence that holds
  // one line at the 320 floor (rule 13: the strip is chrome and is the same
  // height at every width; ~50 characters of --text-2xs fit the floor)
  const note = exchange?.provider === "claude-code" ? "Claude Code’s harness prefix is not shown." : null;

  return (
    <div
      ref={rootRef}
      className={`trace${open ? " open" : ""}`}
      role="region"
      aria-label="Trace"
      aria-hidden={!open}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onMouseDown={onMouseDown}
    >
      <header className="trace-head">
        <button className="iconbtn" title="Back" aria-label="Back" onClick={onClose}>
          <ArrowLeft size={14} />
        </button>
        <span className="trace-title">Trace</span>
        <span className="ask-grow">{summary}</span>
      </header>

      <div className="trace-steps">
        {rows.map((row) => {
          const isOpen = row.body !== null && expanded.has(row.key);
          const head = (
            <>
              <span className={`trace-kind${row.kind === "context" ? "" : ` ${row.kind}`}`}>{row.kindLabel}</span>
              <span className="trace-lbl">{row.label}</span>
              {row.ms !== null && <span className="trace-ms">{fmtMs(row.ms)}</span>}
            </>
          );
          return (
            <div key={row.key} className={`trace-step${isOpen ? " expanded" : ""}`} data-step={row.key}>
              {row.body === null ? (
                <div className="trace-step-h static">{head}</div>
              ) : (
                <button className="trace-step-h" aria-expanded={isOpen} onClick={() => toggle(row.key)}>
                  {head}
                </button>
              )}
              {isOpen && <div className="trace-step-b">{row.body}</div>}
            </div>
          );
        })}
        {exchange && !answer && (
          <div className="trace-empty">
            {exchange.streaming
              ? "still thinking · context, turns and the verdict land with the answer"
              : "no steps recorded · the run ended before the loop started"}
          </div>
        )}
        {exchange && answer && rows.length === 0 && <div className="trace-empty">no steps recorded</div>}
      </div>

      {note && <div className="trace-note">{note}</div>}
    </div>
  );
}
