// One answer block (AGENT-UX section 2). The skeleton IS the anatomy, top to
// bottom: question echo, thinking strip, answer text, result block, status,
// assumption chips, sanity line, follow-ups, footer; the failure
// block replaces the tail when the exchange ended badly. Parts that do not
// apply are omitted, never reserved (DESIGN rule 2 scope note). Sections fade
// in with --dur-slow opacity (ask.css .ans-body > *), never height. Every fact
// has one slot (DESIGN rule 14): the prose is the model's last block with the
// data it repeats stripped, timing prints through the status register's one
// formatter, and the footer is avatar · turns · time · model · Trace. The
// echo row carries Copy · Restart · Jump Back (EchoActions) and is the door
// to edit mode: a click, or Jump Back, sends the words back to the composer;
// the anatomy under the bubble is one node (Body) so a fold can let it leave
// as one, parked where it stood, on the same fade run backwards. The bubble
// keeps the draft's @ chips (W6, MentionText): the question persists as
// typed and re-resolves on render against the connection's current snapshot,
// its saved queries and its threads, so a mention that no longer resolves
// stands as plain text (LESSONS 5).
//
// Everything under the strip is one node (.ans-tail), keyed by the run it
// belongs to: a Restart forgets this exchange's answer and asks again, and the
// answer that stood here leaves as one, parked where it stood and dropping
// 8px as it fades, while a fresh tail takes the flow (W7 item 4). The prose
// carries the exchange's own two actions at its top-right, Copy · Save Query
// (AnswerActions), and the follow-up row under it is the THREAD's, handed down
// by AskPanel so it stands once, under the last answer (item 3).
//
// The result slot is ONE block with two faces (W7, ResultBlock): the table
// (the grid, or the values of a one-row run) and the SQL, with Copy · Flip ·
// Insert floating at its top-right. The collapsed `SQL ▸ first line` row it
// replaces is gone, and with it two always-visible strips (DESIGN rule 15);
// the status line under it stays here, because the rows and the ms are the
// run's whichever face is up.
//
// A4: an exchange that ends `proposed` carries a change nothing has run. The
// block wears its third face over the dry run's sampled rows, and the status
// line ABOVE it becomes the headline (`UPDATE order_v2 · 12 rows`), because a
// proposal announces before it shows and there is no run to print `rows · ms`
// for. After the Run the headline reads the TAB's outcome (`Updated 12 rows ·
// uncommitted`) from the tab's own count, never the preview's (LESSONS 13),
// and the band is gone. Neither adds a strip: the headline stands in the
// status line's own slot.

import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type Ref } from "react";
import { AnimatePresence, motion, usePresence } from "motion/react";
import { answerText, footerStatus } from "../agent/display";
import { canonicalToken, mentionsIn, parseMentions, type Mention } from "../agent/mentions";
import type { ProviderId } from "../agent/providers/types";
import { prefersReducedMotion, spring } from "../design/springs";
import { msText } from "../lib/duration";
import { avatarColor } from "../sidebar/avatar";
import { useAgent, writeVerbOf, type Exchange } from "../stores/agent";
import { useConnections } from "../stores/connections";
import { useSettings } from "../stores/settings";
import { useAsk } from "../stores/ask";
import { useSaved, visibleSaved } from "../stores/saved";
import { useSchema } from "../stores/schema";
import type { Profile } from "../ipc/types";
import type { AskPhase } from "../agent/loop";
import { AnswerActions } from "./AnswerActions";
import { AnswerText } from "./AnswerText";
import { AssumptionChips } from "./AssumptionChips";
import { EchoActions, editLiftId } from "./EchoActions";
import { FailureBlock } from "./FailureBlock";
import { FollowUps, questionLayoutId } from "./FollowUps";
import { MentionText } from "./Mention";
import { modelLabel } from "./modelSources";
import { insertSql, RanHeadline, ResultBlock, WriteHeadline } from "./ResultBlock";
import { SanityLine } from "./SanityLine";
import { sanityStep } from "./sanityStep";
import { ThinkingStrip } from "./ThinkingStrip";

// the grid's statement shape lives with the block that mounts the grid; the
// answer text's own markdown table (W5) reaches it through here, the import
// it has always had
export { statementFromRun } from "./ResultBlock";

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
  /** the thread's follow-up questions when this is the block they stand under
   * (W7 item 3: one row, at the thread's end), empty everywhere else. The row
   * leaves on the empty list, so the panel emptying it is what sends it away */
  followUps: string[];
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

// memo: a streamed delta replaces one Exchange and the thread's array, so the
// panel renders every block; the settled ones get the same props (patchExchange
// keeps their identity, `asked` is stable per question list) and skip, or a
// delta's cost would grow with the thread (ARCHITECTURE ideology 1)
export const AnswerBlock = memo(function AnswerBlock({
  exchange,
  profile,
  threadId,
  isLatest,
  busy,
  phase,
  asked,
  followUps,
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

  const hasRun = run !== null || exchange.chips.some((c) => c.name === "run_sql" && !c.isError);
  // a cancelled run keeps its last SQL reachable: the failure block shows only
  // `cancelled` for it (section 7), so the block is the one way to it. A
  // failure that ran nothing has no block, because its SQL is already in the
  // failure block's own editable field (DESIGN rule 14)
  const blockSql = sql !== null && (!failed || exchange.error?.kind === "cancelled") ? sql : null;
  // the prose the clipboard takes, and the test the cluster mounts on: the
  // slot's own projection (agent/display), so Copy writes what the answer says
  // and the cluster never floats over a slot with nothing under it. Not
  // computed while the text streams, where the cluster is absent anyway and
  // the slot is already parsing every delta
  const prose = useMemo(
    () => (exchange.streaming ? "" : answerText(exchange.text)),
    [exchange.streaming, exchange.text],
  );
  // the answer's cluster is absent while the run is on (there is nothing to
  // copy or save yet) and on a failure, whose actions are the failure block's
  const answerActs = !failed && answer !== null && prose !== "";
  // W7 item 4: a Restart forgets this exchange's answer (the store's `forgot`)
  // and asks the question again. The tail's key is the run it belongs to, so
  // it moves exactly once, at the Restart: the verdict that ends the run
  // re-keys nothing and the answer slot keeps the live region it streamed into
  const forgot = exchange.forgot === true;
  const [runSeq, setRunSeq] = useState(0);
  const [wasForgot, setWasForgot] = useState(forgot);
  if (forgot !== wasForgot) {
    setWasForgot(forgot);
    if (forgot) setRunSeq((n) => n + 1);
  }
  // section 4: a fragment opens the trace AT the call that produced it, the
  // peek behind `checked <col> values` included, not merely somewhere in it
  const showProbe = (index: number) => {
    const fragment = answer?.sanity[index];
    openTrace(exchange.id, answer && fragment ? sanityStep(fragment, answer.trace) : null);
  };
  const model = modelLabel({ providerId: exchange.provider as ProviderId, model: exchange.model });

  // A4: the exchange proposed a change. `proposed` = nothing has run and the
  // band stands; `ran` = the tab took it, the band is gone and the headline
  // reads the TAB's rows. `uncommitted` is bound to that tab's LIVE
  // transaction, so the word leaves the moment the tab commits, rolls back or
  // closes and can never stand over a committed change (LESSONS 9)
  const preview = exchange.preview ?? null;
  const proposed = exchange.status === "proposed";
  const ranWrite = exchange.status === "ran";
  // the verb of a run, from the dry run while it stands and from the STATEMENT
  // after a reload, which is the only one of the two appdb keeps: a preview
  // described a moment that has passed and is not persisted, and the fact that
  // this exchange ran must survive reopening the thread (LESSONS 9)
  const ranVerb = preview?.verb ?? writeVerbOf(exchange.answer?.sql ?? null);
  const uncommitted = useConnections((s) => (exchange.ranTab ? s.txTabs[exchange.ranTab] === true : false));
  const writing = useAgent((s) => s.writing[exchange.id] === true);

  // the chips in the echo (W6): resolved once per exchange against what the
  // connection has now, never against what it had when the question was sent.
  // The one exception is a tab (A2 item 5): its pill is minted from the
  // exchange's own `tabName` over the token the question already carries, and
  // never looked up, because a tab closed since must not un-pill a bubble
  // that reported what it sent (AGENT-UX 15). The token is the tab's however
  // the connection now uses that name, the same claim the store makes when
  // the question is sent (stores/agent `ask`)
  const snapshot = useSchema((s) => s.snapshots[profileId]);
  const saved = useSaved((s) => s.queries);
  const threads = useAgent((s) => s.threads[profileId]);
  const tabName = exchange.tabName;
  const mentions = useMemo(() => {
    const resolved = mentionsIn(question, {
      snapshot,
      saved: visibleSaved(saved, profileId),
      threads: threads ?? [],
      currentThreadId: threadId,
    });
    if (!tabName) return resolved;
    const token = canonicalToken("tab", { name: tabName }).slice(1);
    const raw = parseMentions(question).find((r) => r.token === token);
    if (!raw) return resolved;
    const tab: Mention = { span: raw.span, token, kind: "tab", ref: { name: tabName } };
    return [...resolved.filter((m) => m.token !== token), tab];
  }, [question, snapshot, saved, threads, profileId, threadId, tabName]);

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
        <MentionText text={question} mentions={mentions} />
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

            {/* everything under the strip as one node: a Restart forgets the
                answer and asks again, so what stood here parks where it stood
                and drops 8px as it fades (spring.layout) while a fresh tail
                takes the flow, its answer slot empty and ready to be streamed
                into. Reduced motion is the swap at once */}
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.div
                key={`tail-${runSeq}`}
                className="ans-tail"
                exit={{ opacity: 0, y: 8 }}
                transition={spring.layout}
              >
                {/* the prose and the exchange's own two actions. The slot is
                    the cluster's positioning box, so Copy · Save Query sit at
                    the answer's top-right and the hover that reveals them is
                    the prose's, not the whole anatomy's (ask.css .ans-prose).
                    The text is mounted from the start and empty until the first
                    delta: a live region announces changes to content it already
                    owns, so one that arrives WITH its first text is silent for
                    that text (section 12). The parser (agent/display.ts) drops
                    the fence, the Assumptions line and, with a run on screen,
                    any table of the results, which have their own slots below
                    (rule 14); an empty parse renders no node, so
                    .ans-text:empty collapses the slot out of the flow with no
                    gap (rule 2) while it stays in the accessibility tree. A run
                    is on screen from the moment its chip lands, not from the
                    verdict: the final text streams after the run and would show
                    a table of it for the length of the stream otherwise */}
                <div className="ans-prose">
                  <AnswerText raw={exchange.text} hasRun={hasRun} live={isLatest} />
                  {answerActs && <AnswerActions question={exchange.question} prose={prose} sql={sql} />}
                </div>

                {/* the proposal's headline: the block's own status line,
                    standing above it (0 new strips), and a warning riding in
                    it as one fragment rather than as a line of its own */}
                {proposed && preview && <WriteHeadline preview={preview} />}
                {ranWrite && ranVerb && (
                  <RanHeadline verb={ranVerb} rows={exchange.ranRows ?? 0} uncommitted={uncommitted} />
                )}

                {(run !== null || blockSql !== null || preview !== null) && (
                  <ResultBlock
                    exchangeId={exchange.id}
                    run={run}
                    sql={blockSql}
                    tabTitle={tabTitle(exchange.question)}
                    preview={preview}
                    // the Run belongs to the query tab, not to the block: the
                    // store hands the statement to the tab's own run path, and
                    // the tab's Commit / Rollback take it from there
                    onRun={proposed ? () => void useAgent.getState().runWrite(exchange.id) : undefined}
                    runBusy={writing || busy}
                  />
                )}
                {run && (
                  <div className="ans-status">
                    <span>
                      {run.rowCount.toLocaleString()} {run.rowCount === 1 ? "row" : "rows"} · {msText(run.ms)}
                      {run.capped ? ` · showing ${run.rows.length.toLocaleString()}` : ""}
                    </span>
                  </div>
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
                    onInsert={(text) => insertSql(text, tabTitle(exchange.question))}
                    onAskDifferently={() => {
                      const a = useAsk.getState();
                      a.setDraft(exchange.question);
                      a.requestFocus();
                    }}
                    // A4: on production the same block would offer Settings for
                    // a row that does not exist (a dead end, LESSONS 9), so the
                    // copy names production and the row is Ask Differently alone
                    prod={profile.is_prod}
                    onSettings={() => useSettings.getState().setSettingsOpen(true, "models")}
                    onRetry={() => void useAgent.getState().retry(exchange.id)}
                    onContinue={() => void useAgent.getState().continueFrom(exchange.id)}
                  />
                )}

                {/* the thread's row, under its last answer only (W7 item 3):
                    the panel hands the questions down and empties them the
                    instant one is sent, and the row fades itself away */}
                {!failed && answer && (
                  <FollowUps
                    questions={followUps}
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
              </motion.div>
            </AnimatePresence>
          </Body>
        )}
      </AnimatePresence>
    </article>
  );
});
