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
// The result slot: a run of one row and up to four columns renders as values
// (ScalarResult: a table of one cell is chrome around nothing); anything
// else mounts the app's ONE grid species in readOnly mode, the turn's
// AgentRun as a StatementState from props alone, so the grid never touches
// the results-tab singletons (LESSONS 4). The grid sizes itself to the header
// plus up to six rows (maxRows) and scrolls inside for the rest, so the
// answer scroller stays honest and the rows it promises clear its own
// horizontal scrollbar.

import { useMemo } from "react";
import { motion } from "motion/react";
import { answerText, footerStatus, renderInline } from "../agent/display";
import type { ProviderId } from "../agent/providers/types";
import type { AgentRun } from "../agent/types";
import { spring } from "../design/springs";
import { Grid } from "../grid/Grid";
import { msText } from "../lib/duration";
import { avatarColor } from "../sidebar/avatar";
import { useAgent, type Exchange } from "../stores/agent";
import { useAsk } from "../stores/ask";
import type { StatementState } from "../stores/results";
import { useTabs } from "../stores/tabs";
import type { Profile } from "../ipc/types";
import type { AskPhase } from "../agent/loop";
import { AssumptionChips } from "./AssumptionChips";
import { FailureBlock } from "./FailureBlock";
import { FollowUps, questionLayoutId } from "./FollowUps";
import { modelLabel } from "./modelSources";
import { SanityLine } from "./SanityLine";
import { sanityStep } from "./sanityStep";
import { isScalarRun, ScalarResult } from "./ScalarResult";
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
  /** the layout id the composer's ghost carried when this question was sent
   * (AskPanel hands it to the one exchange that landed out of the ghost, in
   * the render that mounts it; never to an older echo of the same text): the
   * echo takes it so the text lifts out of the composer into the bubble;
   * absent, the echo pairs with the suggestion chip of the same question
   * (section 6) */
  liftId?: string;
}

const TAB_TITLE_CAP = 40;
const tabTitle = (q: string) => (q.length > TAB_TITLE_CAP ? `${q.slice(0, TAB_TITLE_CAP)}…` : q);

/** rows the grid shows before it scrolls inside its slot */
const GRID_ROWS_SHOWN = 6;


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
  liftId,
}: AnswerBlockProps) {
  const openTrace = useAsk((s) => s.openTrace);
  const pending = useAgent((s) => s.pending[exchange.id]);
  const answer = exchange.answer;
  const run = answer?.run ?? null;
  // a SQL or turn-cap failure still returns an answer carrying the last SQL;
  // a provider failure returns none
  const sql = answer?.sql ?? null;
  const failed = !exchange.streaming && exchange.error !== null;

  // identity-stable per run, or the grid re-estimates widths every render;
  // an empty result keeps the status line and drops the grid (no header-only
  // chrome over nothing); a one-row result is values, not a grid
  const scalar = run !== null && isScalarRun(run);
  const stmt = useMemo(
    () => (run && run.rows.length > 0 && !isScalarRun(run) ? statementFromRun(run, sql) : null),
    [run, sql],
  );

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
      {/* the question echo: the user's words in a bubble at the right edge, the
          anatomy below staying left (ask.css .ans-echo). The newest echo is
          what the sent text or a picked suggestion travels into (section 6):
          a send pairs through the ghost's own id (a nonce, so an older echo of
          the same question in the thread never joins the pairing), a chip pick
          through the question's id. Position-only: text never scales, so the
          shared-layout spring carries the words and the bubble's fill fades in
          behind them (a scaled glyph is a distorted glyph). Motion fixes a
          node's id at mount, so a later change of this prop is inert. Older
          echoes carry no id at all */}
      <motion.div
        className="ans-echo"
        layoutId={isLatest ? liftId ?? questionLayoutId(exchange.question) : undefined}
        layout={isLatest ? "position" : undefined}
        transition={spring.layout}
      >
        {exchange.question}
      </motion.div>

      {/* `waiting`: no answer text yet, so the strip may end in `qwrying…`
          while nothing runs; the word leaves the instant text streams */}
      <ThinkingStrip
        chips={exchange.chips}
        streaming={exchange.streaming}
        phase={phase}
        waiting={exchange.text.length === 0}
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

      {scalar && run && <ScalarResult run={run} />}
      {stmt && (
        <div className="ans-grid">
          <Grid key={exchange.id} statement={stmt} readOnly maxRows={GRID_ROWS_SHOWN} />
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
          pending={pending}
          disabled={busy}
          onToggle={(chipId) => useAgent.getState().togglePending(exchange.id, chipId)}
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
          the header has scrolled away (LESSONS 4). A retry streams over the
          prior answer, whose footer stays until the verdict replaces it */}
      {(!exchange.streaming || exchange.prior !== undefined) && answer && (
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
