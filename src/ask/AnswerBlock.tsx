// One answer block (AGENT-UX section 2). The skeleton IS the anatomy, top to
// bottom: question echo, thinking strip, answer text, result grid, status,
// SQL row, assumption chips, sanity line, follow-ups, footer; the failure
// block replaces the tail when the exchange ended badly. Parts that do not
// apply are omitted, never reserved (DESIGN rule 2 scope note). Sections fade
// in with --dur-slow opacity (ask.css .ans-body > *), never height. Every fact
// has one slot (DESIGN rule 14): the prose is the model's last block with the
// data it repeats stripped, timing prints through the status register's one
// formatter, and the footer is avatar · turns · time · model · Trace. The
// echo row carries Copy · Restart · Jump Back (EchoActions) and is the door
// to edit mode: a click, or Jump Back, sends the words back to the composer;
// the anatomy under the bubble is one node (Body) so a fold can let it leave
// as one, parked where it stood, on the same fade run backwards.
//
// The result slot: a run of one row and up to four columns renders as values
// (ScalarResult: a table of one cell is chrome around nothing); anything
// else mounts the app's ONE grid species in readOnly mode, the turn's
// AgentRun as a StatementState from props alone, so the grid never touches
// the results-tab singletons (LESSONS 4). The grid sizes itself to the header
// plus up to six rows (maxRows) and scrolls inside for the rest, so the
// answer scroller stays honest and the rows it promises clear its own
// horizontal scrollbar.

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type Ref } from "react";
import { AnimatePresence, motion, usePresence } from "motion/react";
import { answerText, footerStatus, renderInline } from "../agent/display";
import type { ProviderId } from "../agent/providers/types";
import type { AgentRun } from "../agent/types";
import { prefersReducedMotion, spring } from "../design/springs";
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
import { EchoActions, editLiftId } from "./EchoActions";
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

/** a fold shrinks the thread, but the parked anatomy keeps the old scroll
 * extent for its fade, so the clamp the browser would apply to scrollTop when
 * it leaves (a snap at the end of a settled spring) is applied at the click
 * instead, to the end of what stays in the flow (a boxless leaving article
 * measures 0 and is skipped). Never animated: it is the browser's own clamp,
 * moved */
function clampToFlow(sc: HTMLElement): void {
  let end = 0;
  for (const child of sc.children) {
    if (!(child instanceof HTMLElement) || child.dataset.leaving !== undefined) continue;
    end = Math.max(end, child.offsetTop + child.offsetHeight);
  }
  const pad = parseFloat(getComputedStyle(sc).paddingBottom) || 0;
  sc.scrollTop = Math.min(sc.scrollTop, end + pad - sc.clientHeight);
}

/** the anatomy under the bubble as one node (ask.css .ans-body). A fold hands
 * it to AnimatePresence, which keeps it mounted while `data-leaving` runs the
 * section fade backwards; the node asks to go when that fade ends. Reduced
 * motion runs no fade on the CSS side, so the node goes before the frame
 * paints (a layout effect: an effect would let a parked body show for one
 * frame over the settled stack). popLayout hands the child a ref, a prop in
 * React 19 */
function Body({ ref, children }: { ref?: Ref<HTMLDivElement>; children: ReactNode }) {
  const [isPresent, safeToRemove] = usePresence();
  useLayoutEffect(() => {
    if (!isPresent && prefersReducedMotion()) safeToRemove?.();
  }, [isPresent, safeToRemove]);
  return (
    <div
      ref={ref}
      className="ans-body"
      data-leaving={isPresent ? undefined : ""}
      aria-hidden={isPresent ? undefined : true}
      onAnimationEnd={(e) => {
        if (!isPresent && e.target === e.currentTarget) safeToRemove?.();
      }}
    >
      {children}
    </div>
  );
}

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
  // edit mode (W4): the exchange whose question is in the composer leaves
  // with its words (the sketch's variant B), every exchange after it folds to
  // its bubble alone, dimmed, and the ones before keep their anatomy with
  // Restart and Jump Back held
  const edit = useAsk((s) => s.edit);
  const editing = edit !== null && edit.threadId === threadId;
  const isEditSource = editing && edit.exchangeId === exchange.id;
  const folded = useAgent((s) => {
    if (!editing || isEditSource) return false;
    const list = s.exchanges[threadId] ?? [];
    const at = list.findIndex((e) => e.id === edit.exchangeId);
    return at !== -1 && list.findIndex((e) => e.id === exchange.id) > at;
  });
  // variant B: the edited exchange leaves with its words, but its anatomy
  // fades out parked where it stood like every folding one's (Body), so the
  // article stays, boxless (ask.css .ans[data-leaving]), until that fade ends
  const [bodyGone, setBodyGone] = useState(false);
  useEffect(() => {
    if (!isEditSource) setBodyGone(false);
  }, [isEditSource]);
  // the fold's scroll (clampToFlow): a microtask, so it lands after the
  // panel's own pins in this commit and after motion has measured the
  // bubbles (their springs are in the scroller's content space, so a scroll
  // moved afterwards shifts them with everything else, as the browser's clamp
  // would). Reduced motion removes the anatomy at once and the browser clamps
  const articleRef = useRef<HTMLElement>(null);
  const folding = folded || isEditSource;
  useLayoutEffect(() => {
    if (!folding || prefersReducedMotion()) return;
    const sc = articleRef.current?.closest(".ask-scroll");
    if (sc instanceof HTMLElement) queueMicrotask(() => clampToFlow(sc));
  }, [folding]);
  // the bubble's place in the edit travel. motion fixes a node's layoutId at
  // mount, and this bubble mounted under the send lift's or a chip pick's id
  // (or none), so a click cannot simply hand it the edit id: `leaving`
  // remounts it under editLiftId for ONE frame, long enough for motion to
  // measure it there, and the mode begins on the next frame, the exchange
  // unmounting as the composer's ghost mounts under the same id, so the words
  // travel from the bubble's box. `back` is the id kept once the mode has
  // held it: Esc remounts the exchange in the commit the ghost leaves and the
  // words travel home into a fill that fades in behind them; a later edit
  // of the same bubble needs no arming frame
  const [arm, setArm] = useState<null | "leaving" | "back">(null);
  useEffect(() => {
    if (isEditSource && arm === "leaving") setArm("back");
  }, [isEditSource, arm]);
  const profileId = profile.id;
  const { id: exchangeId, question } = exchange;
  useEffect(() => {
    if (arm !== "leaving") return;
    const id = requestAnimationFrame(() => {
      useAsk.getState().beginEdit({ profileId, threadId, exchangeId, question });
      // refused: the bubble goes back to its id
      if (useAsk.getState().edit?.exchangeId !== exchangeId) setArm(null);
    });
    return () => cancelAnimationFrame(id);
  }, [arm, profileId, threadId, exchangeId, question]);
  const armEdit = () => {
    if (busy || editing || folded) return;
    if (arm === "back") useAsk.getState().beginEdit({ profileId, threadId, exchangeId, question });
    else setArm("leaving");
  };
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

  // the question echo: the user's words in a bubble at the right edge, the
  // anatomy below staying left (ask.css .ans-echo-row). The newest echo is
  // what the sent text or a picked suggestion travels into (section 6): a
  // send pairs through the ghost's own id (a nonce, so an older echo of the
  // same question in the thread never joins the pairing), a chip pick through
  // the question's id; a bubble asked to travel back into the composer
  // remounts under the edit id (`arm`, above). Position-only: text never
  // scales, so the shared-layout spring carries the words and the bubble's
  // fill fades in behind them (a scaled glyph is a distorted glyph). Motion
  // fixes a node's id at mount, so the key changes with the id. Older echoes
  // that were never edited carry no id at all. Every bubble is a layout node
  // whose dependency is the mode: it springs into the stack on a fold and
  // home on the unfold, and on any other re-render it moves with its plain
  // siblings (a bubble measured every render would spring on a chip pick
  // while its anatomy jumped: the W2d gate's S3, twice over). The cluster
  // (Copy · Restart · Jump Back) sits left of the bubble and is absent on a
  // folded one; a plain click on the bubble is Jump Back, a drag-select stays
  // a select, and the bubble is a div of selectable text, never a button: its
  // keyboard route is the cluster (DESIGN rule 8)
  const echoRow = (
    <div className="ans-echo-row">
      {!folded && (
        <EchoActions exchange={exchange} threadId={threadId} held={busy || editing} onJumpBack={armEdit} />
      )}
      <motion.div
        key={arm === null ? "echo" : "edit"}
        className={`ans-echo${folded ? " folded" : ""}${arm === "leaving" ? " arming" : ""}`}
        layoutId={
          arm !== null ? editLiftId(exchange.id) : isLatest ? liftId ?? questionLayoutId(exchange.question) : undefined
        }
        layout="position"
        layoutDependency={editing}
        transition={spring.layout}
        onClick={() => {
          const sel = window.getSelection();
          if (sel && !sel.isCollapsed) return;
          armEdit();
        }}
      >
        {exchange.question}
      </motion.div>
    </div>
  );

  // the fold, one gesture: what stays travels (the bubbles, on spring.layout),
  // what goes fades where it stood (the anatomy, popLayout parking it against
  // the scroller while the stack settles over it). The edited exchange keeps
  // no bubble (the composer holds its words) and goes once its anatomy has;
  // a later one stands as its dimmed bubble alone
  if (isEditSource && bodyGone) return null;
  const bodyLeft = () => {
    if (useAsk.getState().edit?.exchangeId === exchangeId) setBodyGone(true);
  };

  return (
    <article
      ref={articleRef}
      className="ans"
      data-exchange={exchange.id}
      data-leaving={isEditSource ? "" : undefined}
    >
      {!isEditSource && echoRow}

      <AnimatePresence mode="popLayout" initial={false} onExitComplete={bodyLeft}>
        {!folded && !isEditSource && (
          <Body key="body">
            {/* `waiting`: no answer text yet, so the strip may end in `qwrying…`
                while nothing runs; the word leaves the instant text streams */}
            <ThinkingStrip
              chips={exchange.chips}
              streaming={exchange.streaming}
              phase={phase}
              waiting={exchange.text.length === 0}
              onChipClick={(chipId) => openTrace(exchange.id, chipId)}
            />

            {/* mounted from the start and empty until the first delta: a live
                region announces changes to content it already owns, so one that
                arrives WITH its first text is silent for that text (section 12).
                The display strip (agent/display.ts) drops the fence, the
                Assumptions line and any table, which have their own slots below
                (rule 14); an empty result renders no node, so .ans-text:empty
                collapses it out of the flow with no gap (rule 2) while it stays
                in the accessibility tree */}
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

            {/* a cancelled run keeps its last SQL reachable: the failure block
                shows only `cancelled` for it (section 7), so the row is the one
                way to it */}
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
                // a provider failure on a re-run leaves the PREVIOUS answer's
                // SQL in place (rearm keeps the answer); the block must not
                // offer it as the statement that failed
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

            {/* the connection's dot is the block's one provenance mark (section
                9), the titlebar's conn-dot at the same 8px: it stays with the
                rows when the header has scrolled away (LESSONS 4). A retry
                streams over the prior answer, whose footer stays until the
                verdict replaces it */}
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
          </Body>
        )}
      </AnimatePresence>
    </article>
  );
}
