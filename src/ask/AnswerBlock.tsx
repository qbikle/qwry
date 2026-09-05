// One answer block (AGENT-UX section 2). The skeleton IS the anatomy, top to
// bottom: question echo, thinking strip, answer text, result grid, status,
// SQL row, assumption chips, sanity line, follow-ups, footer; the failure
// block replaces the tail when the exchange ended badly. Parts that do not
// apply are omitted, never reserved (DESIGN rule 2 scope note). Sections fade
// in with --dur-slow opacity (ask.css .ans > *), never height. Every fact has
// one slot (DESIGN rule 14): the prose is the model's last block with the
// data it repeats stripped, timing prints through the status register's one
// formatter, and the footer is avatar · turns · time · model · Trace.
//
// The grid slot mounts the app's ONE grid species in readOnly mode: the
// turn's AgentRun becomes a StatementState from props alone, so the grid
// never touches the results-tab singletons (LESSONS 4). The host sizes the
// slot to the header plus up to six rows; the grid scrolls inside for the
// rest, so the answer scroller stays honest.

import { useMemo } from "react";
import { motion } from "motion/react";
import { answerText, footerStatus, renderInline } from "../agent/display";
import type { ProviderId } from "../agent/providers/types";
import type { AgentRun } from "../agent/types";
import { spring } from "../design/springs";
import { Grid, GRID_HEADER_H, gridRowHeight } from "../grid/Grid";
import { msText } from "../lib/duration";
import { avatarColor } from "../sidebar/avatar";
import { useAgent, type Exchange } from "../stores/agent";
import { useAsk } from "../stores/ask";
import type { StatementState } from "../stores/results";
import { useSettings } from "../stores/settings";
import { useTabs } from "../stores/tabs";
import type { Profile } from "../ipc/types";
import type { AskPhase } from "../agent/loop";
import { AssumptionChips } from "./AssumptionChips";
import { FailureBlock } from "./FailureBlock";
import { FollowUps, questionLayoutId } from "./FollowUps";
import { modelLabel } from "./modelSources";
import { SanityLine } from "./SanityLine";
import { sanityStep } from "./sanityStep";
import { SqlRow } from "./SqlRow";
import { ThinkingStrip } from "./ThinkingStrip";

export interface AnswerBlockProps {
  exchange: Exchange;
  /** the connection the thread belongs to: provenance rides the footer
   * (AGENT-UX section 9) */
  profile: Profile;
  threadId: string;
  /** the newest block: its streamed text is the polite live region */
  isLatest: boolean;
  /** a run is in flight on this thread (chips and actions disable) */
  busy: boolean;
  phase: AskPhase | null;
  /** every question already asked in the thread (follow-ups never repeat one) */
  asked: ReadonlySet<string>;
}

const TAB_TITLE_CAP = 40;
const tabTitle = (q: string) => (q.length > TAB_TITLE_CAP ? `${q.slice(0, TAB_TITLE_CAP)}…` : q);

/** rows the grid shows before it scrolls inside its slot */
const GRID_ROWS_SHOWN = 6;
/** the slot's own top and bottom hairline (.ans-grid border, border-box) */
const GRID_HAIRLINES = 2;


/** the turn's run as the grid's statement shape. Column types are not on the
 * wire yet (type_oid 0, no colTypes): alignment is value-sniffed, no glyphs. */
export function statementFromRun(run: AgentRun, sql: string | null): StatementState {
  return {
    index: 0,
    sql: sql ?? "",
    rows: run.rows,
    columns: run.columns.map((name, i) => ({ name, type_oid: 0, table_oid: 0, attnum: i + 1 })),
    truncated: new Set(),
    affected: null,
    ms: run.ms,
    rowCount: run.rowCount,
    capped: run.capped,
    done: true,
    error: null,
  };
}

export function AnswerBlock({
  exchange,
  profile,
  threadId,
  isLatest,
  busy,
  phase,
  asked,
}: AnswerBlockProps) {
  const openTrace = useAsk((s) => s.openTrace);
  const gridDensity = useSettings((s) => s.gridDensity);
  const answer = exchange.answer;
  const run = answer?.run ?? null;
  // a SQL or turn-cap failure still returns an answer carrying the last SQL;
  // a provider failure returns none
  const sql = answer?.sql ?? null;
  const failed = !exchange.streaming && exchange.error !== null;

  // identity-stable per run, or the grid re-estimates widths every render;
  // an empty result keeps the status line and drops the grid (no header-only
  // chrome over nothing)
  const stmt = useMemo(
    () => (run && run.rows.length > 0 ? statementFromRun(run, sql) : null),
    [run, sql],
  );
  const gridHeight = stmt
    ? GRID_HEADER_H +
      Math.min(stmt.rows.length, GRID_ROWS_SHOWN) * gridRowHeight(gridDensity) +
      GRID_HAIRLINES
    : 0;

  const openInTab = (text: string) => {
    useTabs.getState().newTab(text, tabTitle(exchange.question));
  };
  // section 4: a fragment opens the trace AT the call that produced it, the
  // peek behind `checked <col> values` included, not merely somewhere in it
  const showProbe = (index: number) => {
    const fragment = answer?.sanity[index];
    openTrace(exchange.id, answer && fragment ? sanityStep(fragment, answer.trace) : null);
  };
  const model = modelLabel({ providerId: exchange.provider as ProviderId, model: exchange.model });

  return (
    <article className="ans" data-exchange={exchange.id}>
      {/* the newest echo is what a picked suggestion morphs into (section 6);
          older echoes drop the shared id so a repeated question never pairs */}
      <motion.div
        className="ans-echo"
        layoutId={isLatest ? questionLayoutId(exchange.question) : undefined}
        transition={spring.layout}
      >
        {exchange.question}
      </motion.div>

      <ThinkingStrip
        chips={exchange.chips}
        streaming={exchange.streaming}
        phase={phase}
        onChipClick={(chipId) => openTrace(exchange.id, chipId)}
      />

      {/* mounted from the start and empty until the first delta: a live region
          announces changes to content it already owns, so one that arrives
          WITH its first text is silent for that text (section 12). The display
          strip (agent/display.ts) drops the fence, the Assumptions line and
          any table, which have their own slots below (rule 14); an empty
          result renders no node, so .ans-text:empty collapses it out of the
          flow with no gap (rule 2) while it stays in the accessibility tree */}
      <div className="ans-text" aria-live={isLatest ? "polite" : "off"} aria-atomic={false}>
        {renderInline(answerText(exchange.text))}
      </div>

      {stmt && (
        <div className="ans-grid" style={{ height: gridHeight }}>
          <Grid key={exchange.id} statement={stmt} readOnly />
        </div>
      )}
      {run && (
        <div className="ans-status">
          <span>
            {run.rowCount.toLocaleString()} {run.rowCount === 1 ? "row" : "rows"} · {msText(run.ms)}
            {run.capped ? ` · showing ${run.rows.length.toLocaleString()}` : ""}
          </span>
        </div>
      )}

      {/* a cancelled run keeps its last SQL reachable: the failure block shows
          only `cancelled` for it (section 7), so the row is the one way to it */}
      {sql && (!failed || exchange.error?.kind === "cancelled") && (
        <SqlRow sql={sql} tabTitle={tabTitle(exchange.question)} />
      )}

      {!failed && answer && answer.assumptions.length > 0 && (
        <AssumptionChips
          assumptions={answer.assumptions}
          disabled={busy}
          onToggle={(chipId) => void useAgent.getState().toggleAssumption(exchange.id, chipId)}
        />
      )}

      {!failed && answer && answer.sanity.length > 0 && (
        <SanityLine fragments={answer.sanity} onShowProbe={showProbe} />
      )}

      {failed && exchange.error && (
        <FailureBlock
          error={exchange.error}
          // a provider failure on a re-run leaves the PREVIOUS answer's SQL in
          // place (rearm keeps the answer); the block must not offer it as the
          // statement that failed
          sql={exchange.error.kind === "provider" ? null : sql}
          busy={busy}
          onFixIt={(edited) => void useAgent.getState().fixIt(exchange.id, edited)}
          onOpenInTab={openInTab}
          onAskDifferently={() => {
            const a = useAsk.getState();
            a.setDraft(exchange.question);
            a.requestFocus();
          }}
          onRetry={() => void useAgent.getState().retry(exchange.id)}
        />
      )}

      {!failed && answer && (
        <FollowUps
          questions={answer.followUps}
          asked={asked}
          disabled={busy}
          onPick={(q) => void useAgent.getState().ask(q)}
        />
      )}

      {/* the connection's dot is the block's one provenance mark (section 9),
          the titlebar's conn-dot at the same 8px: it stays with the rows when
          the header has scrolled away (LESSONS 4) */}
      {!exchange.streaming && answer && (
        <div className="ans-foot" data-thread={threadId}>
          <span className="ans-dot" style={{ background: avatarColor(profile) }} aria-hidden="true" />
          <span className="ans-foot-meta">{footerStatus(answer.turns, answer.ms, model)}</span>
          <span className="ask-grow" />
          <button type="button" className="linkish" onClick={() => openTrace(exchange.id)}>
            Trace
          </button>
        </div>
      )}
    </article>
  );
}
