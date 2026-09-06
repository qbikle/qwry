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

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Code, Copy, Import, Table } from "lucide-react";
import { EditorState, Prec } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { PostgreSQL, sql as sqlLang } from "@codemirror/lang-sql";
import type { AgentRun } from "../agent/types";
import { spring, swapIn } from "../design/springs";
import { formatSqlText } from "../editor/format";
import { qwryHighlight, qwryTheme } from "../editor/theme";
import { Grid } from "../grid/Grid";
import { copyCue, copyCueShow } from "../lib/copyCue";
import { useAsk } from "../stores/ask";
import type { StatementState } from "../stores/results";
import { useSettings } from "../stores/settings";
import { useTabs } from "../stores/tabs";
import { copiedRowsCue, finished, resultTsv } from "./resultCopy";
import { isScalarRun, ScalarResult } from "./ScalarResult";

/** which face of the block is up */
export type ResultFace = "table" | "sql";

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

export function ResultBlock({ exchangeId, run, sql, tabTitle }: ResultBlockProps) {
  // the table face: a one-row run is values, not a grid (a table of one cell
  // is chrome around nothing); an empty result has no table face at all, so
  // the block stands on its SQL rather than on a header over nothing
  const scalar = run !== null && isScalarRun(run);
  const stmt = useMemo(
    () => (run && run.rows.length > 0 && !isScalarRun(run) ? statementFromRun(run, sql) : null),
    [run, sql],
  );
  const hasTable = scalar || stmt !== null;

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
  // the default is the table when a run left rows, the SQL when it did not
  // (a failed run, or an answer that never ran one); a face the exchange
  // cannot show is never the face
  const face: ResultFace = !hasTable ? "sql" : sql === null ? "table" : (remembered ?? "table");
  const canFlip = hasTable && sql !== null;

  // the block's own height, sprung between the faces. popLayout parks the
  // leaving face out of the flow, so this wrapper measures the arriving one
  // the frame it lands and the box springs to it under `overflow: hidden`
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

  const copy = () => {
    if (face === "table" && run) void copyCue(resultTsv(run), copiedRowsCue(run.rows.length));
    else void copyCue(text, "Copied SQL");
  };

  return (
    <motion.div
      className={`rb ${face}`}
      animate={{ height: h ?? "auto" }}
      initial={false}
      transition={spring.layout}
    >
      <div className="rb-faces" ref={facesRef}>
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.div
            key={face}
            className="rb-face"
            initial={swapIn.initial}
            animate={swapIn.animate}
            exit={{ opacity: 0 }}
            transition={swapIn.transition}
          >
            {face === "sql" ? (
              <SqlFace text={text} />
            ) : scalar && run ? (
              <div className="rb-scalar">
                <ScalarResult run={run} />
              </div>
            ) : stmt ? (
              <Grid key={exchangeId} statement={stmt} readOnly maxRows={GRID_ROWS_SHOWN} />
            ) : null}
          </motion.div>
        </AnimatePresence>
      </div>

      <div className="acts-float">
        <button type="button" className="iconbtn iconbtn-sm" title="Copy" aria-label="Copy" onClick={copy}>
          <Copy size={12} />
        </button>
        {canFlip && (
          <button
            type="button"
            className="iconbtn iconbtn-sm"
            title={face === "table" ? "Show SQL" : "Show Table"}
            aria-label={face === "table" ? "Show SQL" : "Show Table"}
            onClick={() => setFace(exchangeId, face === "table" ? "sql" : "table")}
          >
            {face === "table" ? <Code size={12} /> : <Table size={12} />}
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
      </div>
    </motion.div>
  );
}
