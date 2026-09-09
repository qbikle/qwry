// The result block (W7 item 1, DESIGN rule 15: consolidate before you add).
// One bordered box with two faces, replacing the grid slot AND the collapsed
// `SQL ▸ first line` row: the row was a strip naming a fact the grid already
// stood for, so the SQL becomes a FACE of the box the grid was in and two
// always-visible strips become none. The table face is the default when a run
// left rows (the readOnly Grid, or ScalarResult for a one-row run, inside the
// block's own padding); the SQL face is the default when nothing ran, and
// carries the editor register (mono, the app's highlight, wrapped) in a
// read-only CodeMirror view. The status line `9 rows · 412.6 ms` stays under
// both faces, in AnswerBlock, because the rows and the ms are the run's
// whichever face is up.
//
// The cluster is VS Code's floating editor toolbar: three 18px icon buttons
// absolute at the block's top-right (no layout of its own), the block's own
// surface fading in under them so the letters beneath dissolve rather than
// cut, revealed by the block's hover, focus within it, or the harness's
// forced face (ask.css). Copy is the face you are looking at (the rows in the
// grid's own TSV, or the finished SQL), Flip's glyph is the face you will GET
// (lucide Code on the table face, Table on the SQL face), Insert puts the SQL
// at the caret of the active query tab through the editor's own dispatch
// seam, opening a tab only when no editor is mounted and saying which
// happened (LESSONS 9). Insert replaces Open in Tab everywhere in the pane.
//
// The flip is a mode transition (DESIGN rule 2's scope note): the faces
// crossfade on the app's one content-swap preset (swapIn, the leaving one
// parked where it stood by popLayout) while the block's real height springs
// between them on spring.layout, so the status line and everything under it
// ride the spring instead of jumping; reduced motion is the other face at
// once. The chosen face is remembered per exchange for the session
// (useAsk.face), never persisted: it is a way of looking, not a fact.
//
// A4 adds the THIRD face, `preview`: the dry run of a change the model
// proposed and nothing has run. It is a face and not a block of its own,
// because a block would re-author the SQL face, the Flip and the cluster this
// one already has (DESIGN rule 15's second question); it costs 0 new species
// and one new band. It is the default while the exchange is `proposed`, the
// SQL face stays behind Flip, and the cluster is unchanged. Its grid is the
// same readOnly Grid the table face mounts, with one hook: a cell the
// statement changes reads `old -> new` inside the ONE cell (rule 14: never
// two grids), wearing the staged-edit fill and never its dashed outline,
// which is the editable affordance and this cell answers no click (rule 8's
// inverse). INSERT shows the after rows plain and DELETE the before rows
// plain: every cell of an inserted row is new, and a wash over all of them is
// noise, so the one red thing in the block stays the button. While the dry
// run is still in flight the block stands on its SQL face, the face it has
// always fallen to with no rows to show: the statement is known the instant
// the proposal is, and Copy and Insert are live on it, so the manual route
// exists before the round trip does. Nothing the dry run owns is drawn
// early: no headline, no band, and no Flip, which arrives with the second
// face (AGENT-UX 13.2, 13.9).
//
// The band under the faces is the block's own bottom, the confirm's place.
// Its buttons act on the statement, so they stand on the block (rule 15's
// first question) and cannot be a hover (rule 8 lets a control hide only when
// the surface works without finding it, and a destructive action nobody can
// see is a hidden affordance). No Cancel: the block already IS the not-run
// state. The band is one fixture across the whole life of a change and wears
// two faces: the Run before anything happens, and after it the TAB's own
// `Rollback` · `Commit`, because the run opened a transaction and ending it
// is the only thing left to do (B1). It leaves, the block's height springing
// shut over it, when that transaction closes from either side. Every act in
// it is the TAB's, so the band only calls back (`onRun`, `onCommit`,
// `onRollback`, which AnswerBlock hands to the store: the store cannot import
// this tree without pulling the lazy Ask bundle into its own chunk).
//
// The filled button's species follows the VERB, not the fact that a change is
// happening: red states loss (rule 3), so UPDATE and DELETE wear danger and
// an INSERT wears the app's accent, the editor's own `Run ⌘↩`. Commit is the
// irreversible moment of whichever verb ran, so it wears that verb's species
// too; Rollback is the ghost, the button that takes nothing away.
//
// A3 grows the block by PROPS, never by a fork: the canvas hands it the
// faces it may show (a third, the chart, and the diff wearing the table's
// place), the exchange's question as its `headline`, the model's sentence,
// the status line under the faces and the two cluster actions the canvas
// adds (Ask, More). Ask passes none of them, so the pane's block is the W7
// block unchanged, DOM for DOM. Two rules follow the growth: the flip is a
// CYCLE over the faces that are actually available, its glyph naming the
// face you will GET (table, then chart, then SQL, and with two faces exactly
// W7's pair), and a `headline` moves the block into the canvas's layout,
// where the cluster belongs to the BLOCK (question line, prose, faces,
// status) rather than to the bordered box (canvas.css .blk). The preview is
// the one face the canvas never offers: a proposed change is the pane's
// ceremony and a canvas block is a read someone kept.

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { BarChart3, Code, Copy, Import, Table, TriangleAlert } from "lucide-react";
import { EditorState, Prec } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { PostgreSQL, sql as sqlLang } from "@codemirror/lang-sql";
import type { AgentRun } from "../agent/types";
import type { WritePreview } from "../ipc/types";
import type { TxOutcome } from "../stores/agent";
import { spring, swapIn } from "../design/springs";
import { formatSqlText } from "../editor/format";
import { qwryHighlight, qwryTheme } from "../editor/theme";
import { Grid } from "../grid/Grid";
import { copyCue, copyCueShow } from "../lib/copyCue";
import { useAsk } from "../stores/ask";
import type { StatementState } from "../stores/results";
import { useSettings } from "../stores/settings";
import { useTabs } from "../stores/tabs";
import { Chart } from "../canvas/Chart";
import { DiffFace } from "../canvas/DiffFace";
import type { BlockFace, ChartSpec, Diff } from "../stores/canvas";
import { AnswerText } from "./AnswerText";
import { copiedRowsCue, finished, resultTsv } from "./resultCopy";
import { isScalarRun, ScalarResult } from "./ScalarResult";

/** which face of the block is up. The canvas document names them (its `diff`
 * stands in the table's place while a comparison holds); `preview` is A4's,
 * the sampled rows of a change that has not run, standing in that same place
 * and never offered by the canvas */
export type ResultFace = BlockFace | "preview";

/** the faces the PANE's block may stand on, in cycle order: the preview leads
 * because a proposal that has sampled rows opens on them, and every read
 * answer filters it straight back out (`shows`) */
const ASK_FACES: readonly ResultFace[] = ["preview", "table", "sql"];

/** rows the grid shows before it scrolls inside the block */
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

/** the SQL at the caret of the active query tab, through the editor's own
 * dispatch (the SchemaTree precedent: the editor bundle is lazy, so the seam
 * is reached by import). A table tab active means no editor is mounted, and a
 * silent no-op reads as broken, so a fresh query tab takes the text and the
 * cue says which happened (LESSONS 9) */
export function insertSql(text: string, tabTitle: string): void {
  void import("../editor/SqlEditor").then(({ editorInsert }) => {
    if (editorInsert.current) {
      editorInsert.current(text);
      copyCueShow("Inserted");
    } else {
      useTabs.getState().newTab(text, tabTitle);
      copyCueShow("Inserted into a new tab");
    }
  });
}

export interface ResultBlockProps {
  /** the face is remembered per exchange for the session (useAsk.face) */
  exchangeId: string;
  /** the run behind the table face; null when nothing ran */
  run: AgentRun | null;
  /** the statement the answer settled on; null when the model ran nothing */
  sql: string | null;
  /** the query tab's name when Insert has to open one */
  tabTitle: string;
  /** A4: the dry run behind the preview face; absent on every read answer */
  preview?: WritePreview | null;
  /** A4: the band's action before anything has run, which runs the statement
   * in a query tab (useAgent.runWrite). Absent with no `onCommit` = no band */
  onRun?: () => void;
  /** B1: the tab's own two, once the statement has run and that tab's
   * transaction is still open (useAgent.commitWrite / rollbackWrite). Present
   * together or not at all: they are one band, and they leave with the
   * transaction, whichever side closes it */
  onCommit?: () => void;
  onRollback?: () => void;
  /** A4: the run is in flight, or the thread is. The buttons are disabled,
   * never hidden: state never resizes chrome (DESIGN rule 2) */
  runBusy?: boolean;
  /** the faces this block may show, in cycle order; Ask's two by default */
  faces?: readonly ResultFace[];
  /** the face the DOCUMENT stands on (the canvas persists it); absent, the
   * face is the session's own memory of this exchange */
  face?: ResultFace;
  onFace?: (face: ResultFace) => void;
  /** the exchange's question as the block's one-line title: the canvas's
   * layout, where the cluster belongs to the block and not to the box */
  headline?: string;
  /** the model's sentence, read-only, above the faces (one exchange is one
   * block: dropping it loses the reading the block was added for) */
  prose?: string;
  /** the status line under the faces; the canvas composes its own, with the
   * assumptions folded in after `assumed` */
  status?: ReactNode;
  /** what the chart face draws, when the canvas offers one (the document
   * store decides whether a chart exists at all: `chartOf`) */
  chart?: ChartSpec | null;
  /** the comparison standing on this block: the diff face's own rows */
  diff?: Diff | null;
  /** cluster actions the surface adds after Insert (the canvas: Ask, More) */
  actions?: ReactNode;
}

/** the sample as the grid's statement shape (statementFromRun's sibling): the
 * dry run carries no types and no timing, and neither has a slot here */
export function statementFromSample(columns: string[], rows: (string | null)[][]): StatementState {
  return {
    index: 0,
    sql: "",
    rows,
    columns: columns.map((name, i) => ({ name, type_oid: 0, table_oid: 0, attnum: i + 1 })),
    truncated: new Set(),
    affected: null,
    ms: 0,
    rowCount: rows.length,
    capped: false,
    done: true,
    error: null,
  };
}

/** the ONE grid a preview shows, and which of its cells changed (DESIGN rule
 * 14: never a before grid beside an after grid). UPDATE shows the after rows
 * with every cell the statement moved carrying its old value; INSERT the
 * after rows plain, DELETE the before rows plain.
 *
 * Pairing the two samples is the whole difficulty: neither is ordered (the
 * before sample is a derived SELECT with a LIMIT, the after rows arrive in
 * the statement's own update order), so position is a guess and a wrong guess
 * prints an old value that was never in that row. So the pair is made on a
 * KEY column when the samples carry one (`keyColumn`: values present, unique
 * on each side and the same set on both, which is what a primary key the
 * statement did not touch looks like) and falls back to position otherwise.
 * A pair whose shapes disagree is read as no change at all rather than as the
 * wrong one. */
export function previewGrid(preview: WritePreview): {
  columns: string[];
  rows: (string | null)[][];
  /** `row:col` -> the value that cell holds today */
  changed: ReadonlyMap<string, string | null>;
} {
  const side = preview.verb === "DELETE" ? preview.before : preview.after;
  const changed = new Map<string, string | null>();
  const { before, after } = preview;
  const pairs =
    preview.verb === "UPDATE" &&
    before.rows.length === after.rows.length &&
    before.columns.length === after.columns.length &&
    before.columns.every((c, i) => c === after.columns[i]);
  if (pairs) {
    const key = keyColumn(before.rows, after.rows, after.columns.length);
    // the before row each after row is the same row as: by key where there is
    // one, else the row that stood in the same place
    const rowBefore = (r: number): (string | null)[] =>
      key === null ? before.rows[r] : before.rows[key.get(after.rows[r][key.col] as string) ?? r];
    for (let r = 0; r < after.rows.length; r++) {
      const was = rowBefore(r);
      for (let c = 0; c < after.columns.length; c++) {
        if (was[c] !== after.rows[r][c]) changed.set(`${r}:${c}`, was[c]);
      }
    }
  }
  return { columns: side.columns, rows: side.rows, changed };
}

/** the column the two samples can be paired on, and where each of its values
 * sits in the BEFORE sample: the first column whose values are present and
 * unique on both sides and identical as a set, which is what a key the
 * statement did not touch looks like. None (a keyless sample, or a statement
 * that moved the key itself) leaves the caller on position. */
function keyColumn(
  before: (string | null)[][],
  after: (string | null)[][],
  cols: number,
): { col: number; get: (v: string) => number | undefined } | null {
  for (let c = 0; c < cols; c++) {
    const at = new Map<string, number>();
    let ok = true;
    for (let r = 0; r < before.length && ok; r++) {
      const v = before[r][c];
      if (v === null || at.has(v)) ok = false;
      else at.set(v, r);
    }
    if (!ok) continue;
    const seen = new Set<string>();
    for (let r = 0; r < after.length && ok; r++) {
      const v = after[r][c];
      if (v === null || seen.has(v) || !at.has(v)) ok = false;
      else seen.add(v);
    }
    if (ok) return { col: c, get: (v) => at.get(v) };
  }
  return null;
}

/** the count in the status register, singular at 1 (WRITING) */
export const rowsText = (n: number) => `${n.toLocaleString()} ${n === 1 ? "row" : "rows"}`;

/** the gate's verb in the two registers the wave needs: the control's Title
 * Case and the status line's past tense. The gate allows exactly three verbs,
 * so an unknown one is impossible; it renders as itself rather than as a
 * guess if one ever arrives. */
const VERB_TITLE: Record<string, string> = { INSERT: "Insert", UPDATE: "Update", DELETE: "Delete" };
const VERB_PAST: Record<string, string> = { INSERT: "Inserted", UPDATE: "Updated", DELETE: "Deleted" };

/** the danger button's label: the verb and the count, Title Case, never the
 * table (the headline has it). The house's danger grammar, where a
 * destructive label names its object (confirmDanger's `Delete 2 Questions`),
 * outranks rule 14's one-slot reading here, and both slots read the dry run's
 * one `exact_rows` (LESSONS 13). 0 is kept and enabled: the statement is
 * legal and the tab's outcome is the truth. */
export function runLabel(verb: string, rows: number): string {
  const word = VERB_TITLE[verb] ?? verb;
  return `${word} ${rows.toLocaleString()} ${rows === 1 ? "Row" : "Rows"}`;
}

/** what the tab did, in the status register: `Updated 12 rows` */
export function ranText(verb: string, rows: number): string {
  return `${VERB_PAST[verb] ?? verb} ${rowsText(rows)}`;
}

/** B1: which face the band wears, and whether it stands at all. One place, so
 * the block and its tests cannot disagree about it: the TAB's two while the
 * transaction the run opened is still open (the surface hands them over only
 * then), the Run while a dry run stands and nothing has happened yet, and no
 * band once the change is settled or a reload has lost the transaction. */
export function bandFace(
  p: Pick<ResultBlockProps, "preview" | "onRun" | "onCommit" | "onRollback">,
): "run" | "tx" | null {
  if (p.onCommit && p.onRollback) return "tx";
  return p.preview && p.onRun ? "run" : null;
}

/** B1: the filled button's species, by the VERB of the change. Red states
 * loss (DESIGN rule 3), so UPDATE and DELETE wear danger and an INSERT wears
 * the app's accent, the editor's own `Run ⌘↩`; Commit is the irreversible
 * moment of whichever verb ran and wears what that verb wears. A change
 * nobody can name wears danger, which is the safe read of it. */
export const bandSpecies = (verb: string | null | undefined): "primary" | "danger" =>
  verb === "INSERT" ? "primary" : "danger";

/** A4: the block's own status line, standing ABOVE it, because a proposal
 * announces before it shows and a preview has no `rows · ms` line under it
 * (nothing ran). `UPDATE order_v2 · 12 rows` in the thinking chip's two tones,
 * the verb muted, the table lit in mono, the count muted. A true warning is a
 * FRAGMENT of this same line in the sanity line's grammar (AGENT-UX 4: a
 * warning fragment carries the glyph and tier 1, the rest sits at tier 2),
 * the lifted fragments under ONE glyph: `DELETE notification_history · no
 * WHERE · 48,213 rows`. `many_rows` alone lifts the count. Each separator
 * rides INSIDE the fragment it precedes, so a wrap at the 320 floor never
 * ends a line on a hanging `·`. */
export function WriteHeadline({ preview }: { preview: WritePreview }) {
  const warn = preview.warnings.length > 0;
  const frags = preview.warnings.includes("missing_where")
    ? ["no WHERE", rowsText(preview.exact_rows)]
    : [rowsText(preview.exact_rows)];
  return (
    <div className="ans-status rb-head">
      <span>{preview.verb}</span>
      <code>{preview.table}</code>
      {frags.map((f, i) => (
        <span key={f} className={i === 0 && warn ? "warn" : warn ? "lit" : undefined}>
          <span className="sep" aria-hidden="true">
            ·
          </span>
          {i === 0 && warn && <TriangleAlert size={12} />}
          {f}
        </span>
      ))}
    </div>
  );
}

/** B1: what the tab's transaction is doing to a run that has happened.
 * `open` is the live transaction, the two ended states are what the app
 * itself sent, and null is everything it cannot see: a reload, a typed
 * COMMIT, a session that died. */
export type RanTx = "open" | TxOutcome | null;

/** A4: the same line after Run, reading the TAB's outcome and never the
 * preview's number (LESSONS 13). It follows that tab for the whole of the
 * transaction's life, in three readings and never a fourth. All three lit as
 * the exception speaking (DESIGN rule 11): a state the user caused by
 * pressing a button a second ago is not yet the silent norm, and the norm is
 * the plain `Deleted 1 row` a reload comes back to. A rollback takes the
 * count with it and replaces the whole line, because nothing was changed for
 * a count to report (LESSONS 9: the line the user is left with has to be
 * true). */
export function RanHeadline({ verb, rows, tx }: { verb: string; rows: number; tx: RanTx }) {
  const sep = (
    <span className="sep" aria-hidden="true">
      ·
    </span>
  );
  // a rollback is the whole line, not a fragment on the end of one: `Deleted
  // 1 row` is false the instant the transaction is gone, so both halves of the
  // reading are the exception speaking and both stand at tier 1
  if (tx === "rolledback") {
    return (
      <div className="ans-status rb-head">
        <span className="lit">Rolled back</span>
        <span className="lit">{sep}nothing changed</span>
      </div>
    );
  }
  return (
    <div className="ans-status rb-head">
      <span>{ranText(verb, rows)}</span>
      {tx === "open" && <span className="lit">{sep}uncommitted</span>}
      {tx === "committed" && <span className="lit">{sep}committed</span>}
    </div>
  );
}

// the SQL face over the editor theme: auto height, the answer's data size,
// the block showing through (the block draws the border and the corners)
const faceTheme = EditorView.theme({
  "&": { height: "auto", fontSize: "var(--text-sm)", backgroundColor: "transparent" },
  ".cm-content": { padding: "8px 0" },
  ".cm-line": { padding: "0 12px" },
  ".cm-scroller": { lineHeight: "var(--lh-data)" },
});

/** the read-only view of the statement, in the app's own SQL grammar,
 * highlight and theme, wrapped so the floor never scrolls it sideways */
function SqlFace({ text }: { text: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const dark = useSettings((s) => s.resolved === "dark");
  // layout effect: the view exists before the face paints, so the flip is one
  // frame, not an empty box and then the SQL
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: text,
        extensions: [
          sqlLang({ dialect: PostgreSQL }),
          qwryHighlight,
          qwryTheme(dark),
          Prec.high(faceTheme),
          EditorView.lineWrapping,
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
        ],
      }),
    });
    return () => view.destroy();
  }, [text, dark]);
  return <div ref={hostRef} className="rb-sql" />;
}

export function ResultBlock({
  exchangeId,
  run,
  sql,
  tabTitle,
  preview = null,
  onRun,
  onCommit,
  onRollback,
  runBusy = false,
  faces = ASK_FACES,
  face: docFace,
  onFace,
  headline,
  prose,
  status,
  chart = null,
  diff = null,
  actions,
}: ResultBlockProps) {
  // the table face: a one-row run is values, not a grid (a table of one cell
  // is chrome around nothing); an empty result has no table face at all, so
  // the block stands on its SQL rather than on a header over nothing. A
  // comparison standing on the block IS the table face (DESIGN rule 14)
  const scalar = run !== null && isScalarRun(run);
  const stmt = useMemo(
    () => (run && run.rows.length > 0 && !isScalarRun(run) ? statementFromRun(run, sql) : null),
    [run, sql],
  );
  const hasTable = scalar || stmt !== null;

  // A4's face, in the table face's slot: the sampled rows of a change that has
  // not run. A sample with no rows (a statement whose count is 0, legal and
  // still worth running) shows no grid at all, so the block stands on its SQL,
  // the same law the table face has always followed
  const pv = useMemo(() => (preview ? previewGrid(preview) : null), [preview]);
  const pvStmt = useMemo(
    () => (pv && pv.rows.length > 0 ? statementFromSample(pv.columns, pv.rows) : null),
    [pv],
  );
  const hasPreview = pvStmt !== null;

  // the finished text: formatted once the (lazy) formatter lands, bare + `;`
  // until then, so Copy and Insert never wait on the import
  const preset = useSettings((s) => s.formatPreset);
  const [text, setText] = useState(() => (sql === null ? "" : finished(sql)));
  useEffect(() => {
    if (sql === null) return;
    let live = true;
    setText(finished(sql));
    void formatSqlText(sql, preset).then((out) => {
      if (live) setText(finished(out));
    });
    return () => {
      live = false;
    };
  }, [sql, preset]);

  const remembered = useAsk((s) => s.face[exchangeId]);
  const setFace = useAsk((s) => s.setFace);
  // the faces this block can actually stand on, in cycle order. The default
  // is the first one it can show: the preview while a proposal has rows to
  // sample, then the table when a run left rows, the SQL when neither (a
  // failed run, an answer that never ran one, or a dry run still in flight);
  // a face the exchange cannot show is never the face, remembered or not, and
  // the flip is the next one along the cycle
  const shows = (f: ResultFace) =>
    f === "table"
      ? hasTable
      : f === "preview"
        ? hasPreview
        : f === "chart"
          ? chart !== null
          : f === "diff"
            ? diff !== null
            : sql !== null;
  const available = faces.filter(shows);
  const chosen = docFace ?? remembered;
  const face: ResultFace = chosen && available.includes(chosen) ? chosen : (available[0] ?? "sql");
  const canFlip = available.length > 1;
  const next = available[(available.indexOf(face) + 1) % Math.max(1, available.length)] ?? face;
  const flipTo = () => (onFace ? onFace(next) : setFace(exchangeId, next));
  // the glyph names the face you will GET (W7's rule, over more faces now):
  // the diff and the preview wear the table's, since both stand in its place
  const nextLabel = next === "chart" ? "Show Chart" : next === "sql" ? "Show SQL" : "Show Table";

  const band = bandFace({ preview, onRun, onCommit, onRollback });
  const species = bandSpecies(preview?.verb);

  // the block's own height, sprung between the faces AND over the band as it
  // leaves. popLayout parks the leaving face (and the leaving band) out of the
  // flow, so this wrapper measures what is arriving the frame it lands and the
  // box springs to it under `overflow: hidden`
  const facesRef = useRef<HTMLDivElement>(null);
  const [h, setH] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = facesRef.current;
    if (!el) return;
    setH(el.offsetHeight);
    const ro = new ResizeObserver(() => setH(el.offsetHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Copy is the face you are looking at: the rows in the grid's own TSV on
  // every face that shows them (the chart and the diff are those same rows),
  // the sample's rows on the preview, the finished statement on the SQL face.
  // A sample is what the block HOLDS, so its cue counts what it copied and
  // never the statement's own `exact_rows`
  const copy = () => {
    if (face === "preview" && pv)
      void copyCue(
        resultTsv({ columns: pv.columns, rows: pv.rows, rowCount: pv.rows.length, capped: false, ms: 0 }),
        copiedRowsCue(pv.rows.length),
      );
    else if (face !== "sql" && run) void copyCue(resultTsv(run), copiedRowsCue(run.rows.length));
    else void copyCue(text, "Copied SQL");
  };

  // the cluster is VS Code's floating toolbar: at the BOX's top-right in the
  // pane, at the BLOCK's in the canvas, where the question line is the row it
  // centres on and the actions act on the whole block (canvas.css .blk)
  const cluster = (
    <div className="acts-float">
      <button type="button" className="iconbtn iconbtn-sm" title="Copy" aria-label="Copy" onClick={copy}>
        <Copy size={12} />
      </button>
      {canFlip && (
        <button
          type="button"
          className="iconbtn iconbtn-sm"
          title={nextLabel}
          aria-label={nextLabel}
          onClick={flipTo}
        >
          {next === "chart" ? <BarChart3 size={12} /> : next === "sql" ? <Code size={12} /> : <Table size={12} />}
        </button>
      )}
      {sql !== null && (
        <button
          type="button"
          className="iconbtn iconbtn-sm"
          title="Insert SQL"
          aria-label="Insert SQL"
          onClick={() => insertSql(text, tabTitle)}
        >
          <Import size={12} />
        </button>
      )}
      {actions}
    </div>
  );

  // what the chosen face actually draws. Null only on the canvas, where a
  // comparison over the cap IS its status line and nothing else: the block
  // then stands without a box rather than around an empty one
  const content =
    face === "sql" ? (
      <SqlFace text={text} />
    ) : face === "preview" && pvStmt && pv ? (
      <Grid
        key={`${exchangeId}-preview`}
        statement={pvStmt}
        readOnly
        maxRows={GRID_ROWS_SHOWN}
        changed={pv.changed}
      />
    ) : face === "chart" && chart ? (
      <Chart spec={chart} />
    ) : face === "diff" && diff ? (
      diff.capped ? null : <DiffFace diff={diff} />
    ) : scalar && run ? (
      <div className="rb-scalar">
        <ScalarResult run={run} />
      </div>
    ) : stmt ? (
      <Grid key={exchangeId} statement={stmt} readOnly maxRows={GRID_ROWS_SHOWN} />
    ) : null;

  const box = (
    <motion.div
      className={`rb ${face}`}
      animate={{ height: h ?? "auto" }}
      initial={false}
      transition={spring.layout}
    >
      <div className="rb-inner" ref={facesRef}>
        <div className="rb-faces">
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.div
              key={face}
              className="rb-face"
              initial={swapIn.initial}
              animate={swapIn.animate}
              exit={{ opacity: 0 }}
              transition={swapIn.transition}
            >
              {content}
            </motion.div>
          </AnimatePresence>
        </div>

        {/* the band: the block's own bottom, the change's own actions at the
            right. Before the Run it holds the Run; after it, the TAB's two,
            because a transaction the statement opened is what there is left
            to do and it belongs on the object it acts on (DESIGN rule 15's
            first question). The two faces crossfade in place on swapIn: the
            band is one fixture through the whole change, and it leaves only
            when the transaction does, parked out of the flow while the
            block's height springs shut over it */}
        <AnimatePresence mode="popLayout" initial={false}>
          {band !== null && (
            <motion.div
              key={band}
              className="rb-act"
              initial={swapIn.initial}
              animate={swapIn.animate}
              exit={{ opacity: 0, transition: spring.layout }}
              transition={swapIn.transition}
            >
              {band === "tx" ? (
                <>
                  {/* the ghost species: rolling back loses nothing that was
                      not already provisional, and the irreversible half of
                      this pair is the other one */}
                  <button type="button" className="btnish" disabled={runBusy} onClick={onRollback}>
                    Rollback
                  </button>
                  <button
                    type="button"
                    className={`btnish ${species}`}
                    disabled={runBusy}
                    onClick={onCommit}
                  >
                    Commit
                  </button>
                </>
              ) : (
                preview && (
                  <button
                    type="button"
                    className={`btnish ${species}`}
                    disabled={runBusy}
                    onClick={onRun}
                  >
                    {runLabel(preview.verb, preview.exact_rows)}
                  </button>
                )
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      {headline === undefined && cluster}
    </motion.div>
  );

  if (headline === undefined) return box;

  // the canvas's block: the question line as its title, the model's sentence
  // read-only above the faces, the status line under them with the
  // assumptions folded in, and one cluster over the question line
  return (
    <>
      <div className="blk-q" title={headline}>
        {headline}
      </div>
      {prose ? <AnswerText raw={prose} hasRun={run !== null} live={false} /> : null}
      {content !== null && box}
      {status !== undefined && <div className="ans-status">{status}</div>}
      {cluster}
    </>
  );
}
