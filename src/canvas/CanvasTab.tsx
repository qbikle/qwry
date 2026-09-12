// The canvas, as a tab of the main card (A3 item 6, C2a). A GRID of blocks at
// the card's own width, 16px in from every edge, a 12px gutter between cells,
// and no chrome of its own: no toolbar, no strip, no frame per block. The tab
// is the strip (DESIGN rule 15: the blocks stand here under 0 always-visible
// controls, before the grid and after it).
//
// The page's geometry belongs to CanvasGrid: the column count read from the
// width, the cell frames, the drag and the resize, the placeholder and the
// live region. This file stays what it was, the surface that knows the KINDS:
// which block is a result, which a note and which a drawing, what each one's
// cluster holds, what its menu says and which of them holds the caret. The
// grip joins every cluster as its first action (the one surface every kind
// drags by), the title line of a result is its second, and `Move Up` / `Move
// Down` leave every menu: a place on a grid is a drag or an arrow key, and a
// row that splices the reading order would move nothing a reader can see
// (4 rows to 3 on a result, 3 to 1 on a note).
//
// The empty canvas is EMPTY: zero strings and zero controls. What it does
// carry is a CARET, in the page's first cell, because a blank card with a
// caret is a page and a blank card with nothing is nothing at all, and the
// difference is one caret (B3; A3's counts hold, a caret being no control).
// On a grid the caret lands in the CELL THE PRESS WAS IN (C2b), not at the
// end of a list: a page of cells has a place for a press to mean, and the
// cells show themselves for the length of that press and leave with it. The
// line is one cell wide and grows by its words, the note's own rule.
// The caret line is an empty note being written and NOT yet a block: the
// store's own note would reach appdb on its 400 ms debounce, so a stray click
// used to leave a row behind, and three clicks left three (the boxes the
// maintainer saw). One click gives one caret line, a second click gives the
// same one, the first words make it a block through `addNote`, and a caret
// that loses focus with nothing in it leaves nothing anywhere. The palette's
// `New Note` is the keyboard route and mints the store's note as it always
// did; its blur removes it the same way.
//
// A block is a result, a note or a drawing. The result is the pane's own ResultBlock,
// grown by props rather than forked: the TITLE line is the exchange's
// question, which stands once, on the answer's first block, and the model's
// own six-word title on its other results (rule 14: the question once); a
// one-row result stands on its VALUES, since a grid of one row is chrome
// around figures that are their own row; the model's sentence rides read-only
// above the faces, the status line folds the assumptions in after one
// lowercase `assumed`, and the cluster is Grip · Copy · Flip · Insert · Ask ·
// More (6 hot, 0 at rest). The note is NoteBlock's, the same picture with
// Grip · Copy · Ask · More. The drawing is Drawing's, which draws its own
// sheet and its own cluster (Grip · Pen ▾ · Undo · Redo · Copy · Ask · More,
// 7 hot and 0 at rest) and is handed the two things only the page knows: the
// grip, and whether an `Ask` EXISTS at all. It does not where the chosen
// model cannot read an image (C2b call 4): the button is absent, never
// disabled and never explained, because a capability that does not exist has
// no control (DESIGN rule 2's matrix). `More` is the block's menu and the one
// a right-click opens: what is left in it acts on the block's place in the
// document rather than on its content (Compare With, Delete), so it leaves
// the cluster for the menu.
//
// Motion adds no preset (DECISIONS, A3, and C2a keeps it): a block arrives
// WHOLE on `panelIn`, the card's own entrance, at the cells the engine placed
// it in, with the elements it displaced making room on `spring.layout`; a
// block the model REPLACED lands where the old one stood on `swapIn`, the
// flip's own crossfade, so the change reads as a change; a
// removed block fades where it stands while the gap closes on the same
// spring. Nothing streams in word by word: the pane's thinking strip is the
// one loading UI, and a page that assembles in whole blocks is read as it
// grows. When an answer's FIRST block lands out of view the canvas scrolls
// once, to that block's title, and the blocks after it land below with no
// further scroll (LESSONS 7: one scroll authority per gesture). Focus never
// moves into the canvas on a write: the composer keeps the caret.

import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { motion } from "motion/react";
import { Ellipsis, MessageSquare } from "lucide-react";
import { ResultBlock, type ResultFace } from "../ask/ResultBlock";
import { isScalarRun } from "../ask/ScalarResult";
import { ContextMenu, type MenuNode } from "../app/overlay/ContextMenu";
import { Kbd } from "../design/Kbd";
import { panelIn, swapIn } from "../design/springs";
import { copyCueShow } from "../lib/copyCue";
import { msText } from "../lib/duration";
import {
  chartOf,
  defaultSpanFor,
  drawingName,
  facesOf,
  statusOf,
  useCanvas,
  type Block,
  type DrawingBlock as DrawingBlockDoc,
  type NoteBlock as NoteBlockDoc,
  type ResultBlock as ResultBlockDoc,
  type StatusLine,
} from "../stores/canvas";
import { canSeeImages } from "../stores/agent";
import { useSettings } from "../stores/settings";
import { CanvasGrid, Grip, type GridPage } from "./CanvasGrid";
import { compareWithMenu } from "./compareMenu";
import { Drawing } from "./Drawing";
import { NoteBlock, noteName } from "./NoteBlock";
import type { Cell } from "./grid";
import "./canvas.css";

/** What a MODEL-written block carries beyond A3's document (B3, the tool
 * handler's own fields): the model's title, in the question line's slot on
 * every result of an answer but its first, and the exchange that wrote the
 * block, which is what the one scroll per answer reads. Both optional, both
 * absent on a block a person's press added, and read structurally so this
 * surface never disagrees with the store about who declares them. */
export interface WrittenBlock {
  /** at most six words, Sentence case, identifiers in backticks */
  title?: string;
  /** the exchange id, the only record of WHOSE the block is */
  wroteBy?: string;
}

/** those fields, read off a document block: a downcast, so the surface
 * compiles whether the store declares them yet or not */
const written = (block: Block): WrittenBlock => block as Block & WrittenBlock;

/** the block's title line: the exchange's question, which stands ONCE on the
 * answer's first block, then the model's own title on its other results, then
 * nothing. A model's note carries none, because the question above it is the
 * section's heading and a second one would be the same fact twice (rule 14). */
export function titleOf(block: Block): string {
  // a drawing carries no line of words at all: what it is called is its first
  // text label, and that is drawn ON it (drawingName), never above it
  if (block.kind === "drawing") return "";
  return block.question || written(block).title || "";
}

/** what makes a block a different READING of the same slot. A replace keeps
 * the block's id and its place, so the id alone cannot tell a rewrite from a
 * re-render; the content's own signature can, and the new block then
 * crossfades over the old where it stood instead of arriving as a new one. */
export function revOf(block: Block): string {
  if (block.kind === "note") return block.text;
  // a drawing's ink is not a second reading of one slot: strokes land under a
  // hand on the sheet, and a key that moved with them would remount the
  // element mid-drawing and take its undo stack and its caret with it
  if (block.kind === "drawing") return "draw";
  return `${block.sql ?? ""}|${block.rows.length}|${block.ms}`;
}

/** the caret line's stand-in block: an empty note, in edit, belonging to the
 * page and not to the document until its first words */
const DRAFT: NoteBlockDoc = { id: "cv-draft", kind: "note", text: "" };

/** the status line under a result's faces: the run's facts, then the
 * comparison's two sides when one stands, then the assumptions after one
 * lowercase lead. The labels are tier 1 and the lead and the numbers tier 2
 * (canvas.css .blk .ans-status): a chip on the canvas toggles nothing, and a
 * chip that answers no click is a control costume on a non-control */
function Status({ line }: { line: StatusLine }) {
  return (
    <>
      {line.facts}
      {line.sides.map((s) => (
        <Fragment key={s.name}>
          {" · "}
          <span className="asm">{s.name}</span> {msText(s.ms)}
        </Fragment>
      ))}
      {line.assumed.length > 0 && (
        <>
          {" · assumed "}
          {line.assumed.map((a, i) => (
            <Fragment key={a}>
              {i > 0 && " · "}
              <span className="asm">{a}</span>
            </Fragment>
          ))}
        </>
      )}
    </>
  );
}

/** one result block. Its own component so the run the grid reads is built
 * once per block and not once per render of the canvas: the grid keys off the
 * statement it is handed, and a fresh object every render would rebuild it
 * under every hover (ARCHITECTURE ideology 1) */
function CanvasResult({
  block,
  canvasId,
  status,
  span,
  ask,
  more,
}: {
  block: ResultBlockDoc;
  canvasId: string;
  status: StatusLine | null;
  /** the cells the element stands on: the chart reads its aspect from them,
   * and the table reads how many rows it shows from the height they leave */
  span: { w: number; h: number };
  /** the two the canvas adds to the cluster; the block orders them with the
   * rest through `kindTools` (blockTools.ts) */
  ask: ReactNode;
  more: ReactNode;
}) {
  const run = useMemo(
    () => ({
      columns: block.columns,
      rows: block.rows,
      rowCount: block.rows.length,
      capped: false,
      ms: block.ms,
    }),
    [block.columns, block.rows, block.ms],
  );
  // a one-row result stands on its VALUES: the figures are their own row, so
  // a grid of one row is chrome around them and the face draws no boundary
  // (ScalarResult, canvas.css .rb-vals). Five or more columns is more facts
  // than a figure row carries, and that one-row result stands on its GRID
  // instead (ScalarResult's own rule): the face falls back rather than
  // standing empty, which is the rule every face here follows
  const values = (face: ResultFace): ResultFace =>
    face === "values" && !isScalarRun(run) ? "table" : face;
  return (
    <ResultBlock
      exchangeId={block.id}
      run={run}
      sql={block.sql}
      tabTitle={titleOf(block)}
      headline={titleOf(block)}
      prose={block.prose}
      status={status ? <Status line={status} /> : null}
      faces={facesOf(block).map(values)}
      face={values(block.face)}
      // `preview` is the pane's own face (a proposed write) and is never in
      // `facesOf`, so the document can never be asked to stand on it
      onFace={(face) => {
        if (face !== "preview") useCanvas.getState().setFace(canvasId, block.id, face);
      }}
      chart={chartOf(block)}
      diff={block.diff ?? null}
      span={span}
      lead={<Grip />}
      ask={ask}
      more={more}
    />
  );
}

/** Ask about this block. Module-level, so the row is handed no callback that
 * is new on every render of the page */
const askAbout = (b: ResultBlockDoc) => {
  void import("../stores/agent").then(({ useAgent }) =>
    useAgent.getState().askAbout({ id: b.id, name: titleOf(b), sql: b.sql, columns: b.columns, rowCount: b.rows.length }),
  );
};

/** `Ask` on a drawing: the same token the other two kinds write into the
 * composer, naming the SHEET. The element has no words for the model to
 * read, so what the ref carries is the drawing's identity and the canvas it
 * stands on, and the picture itself is rendered from the document when the
 * question is actually sent (stores/agent `runInto`) or when the model calls
 * `canvas_read({ block_id })`. One renderer, read at the moment it is used,
 * so a stroke drawn between this press and the Send cannot leave the two
 * doors handing out two different pictures of one sheet (LESSONS 13).
 *
 * The button only exists where the chosen model reads images (canSeeImages),
 * so nothing here is a wire that cannot carry one. */
const askDrawing = (block: DrawingBlockDoc, name: string, canvasId: string) => {
  void import("../stores/agent").then(({ useAgent }) =>
    useAgent.getState().askAbout({ id: block.id, name, drawing: true, canvasId }),
  );
};

/** one block's row, memoised by the block it draws. Every write to the
 * document rebuilds its array — a face flip, a note's words, a rename, a menu
 * opening — so the list re-rendered every block whenever any one of them
 * changed; the props here are the block itself, the cells it stands on and
 * the flags the page owns, so a flip renders the block that flipped
 * (ARCHITECTURE ideology 1). `arrive` is the preset itself and not its
 * spread, so what decides a skip is the preset's own identity, and `entering`
 * is what the grid's own AnimatePresence used to say with `initial={false}`:
 * the blocks that stood here when the canvas opened do not arrive, the ones
 * an answer writes do */
const CanvasRow = memo(function CanvasRow({
  block,
  canvasId,
  cell,
  name,
  canAsk,
  arrive,
  entering,
  editing,
  menuHere,
  onMenu,
}: {
  block: Block;
  canvasId: string;
  cell: Cell;
  /** what this block answers to, so the row builds no second derivation of it */
  name: string;
  /** whether the chosen model reads images (C2b call 4). A drawing's `Ask` is
   * ABSENT where it does not: the enforcement is the missing button, never a
   * disabled one and never a sentence (DESIGN rule 2's matrix) */
  canAsk: boolean;
  arrive: typeof panelIn | typeof swapIn;
  entering: boolean;
  editing: boolean;
  /** this block's menu is the one standing */
  menuHere: boolean;
  onMenu: (blockId: string, x: number, y: number) => void;
}) {
  const enter = {
    initial: entering ? arrive.initial : false,
    animate: arrive.animate,
    transition: arrive.transition,
  };
  if (block.kind === "note") {
    return (
      <motion.div {...enter} className="cv-item">
        <NoteBlock
          block={block}
          editing={editing}
          lead={<Grip />}
          onEdit={() => useCanvas.getState().beginEdit(block.id)}
          onCommit={(text) => {
            useCanvas.getState().updateNote(canvasId, block.id, text);
            useCanvas.getState().endEdit();
          }}
          onCancel={() => {
            // a note that never had words leaves with the cancel:
            // an empty block is a block being written, and one nobody
            // wrote is not a block (the fold's own contract)
            if (block.text === "") useCanvas.getState().remove(canvasId, block.id);
            useCanvas.getState().endEdit();
          }}
          onDelete={() => {
            useCanvas.getState().remove(canvasId, block.id);
            useCanvas.getState().endEdit();
          }}
        />
      </motion.div>
    );
  }
  if (block.kind === "drawing") {
    // the sheet draws itself, its own cluster and its own menu; what the page
    // hands it is the two things only the page knows: the grip (this block can
    // be moved) and whether an `Ask` exists at all
    return (
      <motion.div {...enter} className="cv-item">
        <Drawing
          block={block}
          canvasId={canvasId}
          cell={cell}
          lead={<Grip />}
          ask={
            canAsk ? (
              <button
                type="button"
                className="iconbtn iconbtn-sm"
                title="Ask"
                aria-label="Ask"
                onClick={() => askDrawing(block, name, canvasId)}
              >
                <MessageSquare size={12} />
              </button>
            ) : null
          }
          onDelete={() => useCanvas.getState().remove(canvasId, block.id)}
        />
      </motion.div>
    );
  }
  return (
    <motion.div
      {...enter}
      className="blk"
      data-block={block.id}
      tabIndex={0}
      onContextMenu={(e) => {
        // the faces box owns its own right-click (the grid retargets
        // its selection and opens the cell menu): two menus at one
        // press is a bug, so the block's menu answers everywhere else
        // on the block, and `More` is its always-there route
        if ((e.target as HTMLElement).closest(".rb")) return;
        e.preventDefault();
        onMenu(block.id, e.clientX, e.clientY);
      }}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key !== "Backspace" && e.key !== "Delete") return;
        e.preventDefault();
        useCanvas.getState().remove(canvasId, block.id);
      }}
    >
      <CanvasResult
        block={block}
        canvasId={canvasId}
        status={statusOf(block)}
        span={cell}
        ask={
          <button
            type="button"
            className="iconbtn iconbtn-sm"
            title="Ask"
            aria-label="Ask"
            onClick={() => askAbout(block)}
          >
            <MessageSquare size={12} />
          </button>
        }
        more={
          <button
            type="button"
            className={`iconbtn iconbtn-sm${menuHere ? " active" : ""}`}
            title="More"
            aria-label="More"
            aria-haspopup="menu"
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              onMenu(block.id, r.right, r.bottom + 4);
            }}
          >
            <Ellipsis size={12} />
          </button>
        }
      />
    </motion.div>
  );
});

/** whether a press landed on the PAGE rather than on a block: the scroller
 * itself, the grid's own ground between the elements, and the tail under the
 * last one. A press on an element is the element's, as it always was */
const onPage = (e: { target: EventTarget | null; currentTarget: EventTarget | null }): boolean => {
  const t = e.target as HTMLElement | null;
  return t !== null && (t === e.currentTarget || t.classList.contains("cvg"));
};

/** the element's key: a replaced block keeps its id and its cells, so what
 * tells a rewrite from a re-render is the content's own signature */
const keyOf = (block: Block): string => `${block.id}:${revOf(block)}`;

/** which drawing of the document this is, counted from 1 in reading order:
 * what an unlabelled sheet is called, the way an untitled note is called
 * `Note`. The count is the document's, so two sheets never answer to one name */
const ordinalOf = (blocks: readonly Block[], id: string): number => {
  let n = 0;
  for (const b of blocks) {
    if (b.kind !== "drawing") continue;
    n += 1;
    if (b.id === id) break;
  }
  return Math.max(1, n);
};

/** what the live region, the element's own label and an `@` pill call it: the
 * title it carries, a note's first line, a drawing's first label, and the
 * kind's own word when it has none (WRITING, identifiers inside chrome). One
 * derivation for all three readers (LESSONS 4) */
export function nameOf(block: Block, blocks: readonly Block[] = []): string {
  if (block.kind === "note") return noteName(block.text) || "Note";
  if (block.kind === "drawing") return drawingName(block) || `Drawing ${ordinalOf(blocks, block.id)}`;
  return titleOf(block) || "Result";
}

/** and what KIND it is, which for a result is the face it stands on: the
 * geometry line reads `Orders by channel · chart · 4 by 3 at column 1, row 2` */
const kindOf = (block: Block): string =>
  block.kind === "note" ? "note" : block.kind === "drawing" ? "drawing" : block.face;

export function CanvasTab({ canvasId }: { canvasId: string }) {
  const doc = useCanvas((s) => s.docs[canvasId]);
  const meta = useCanvas((s) => Object.values(s.canvases).flat().find((c) => c.id === canvasId));
  const blocks = doc?.blocks ?? [];
  // which block holds the caret. The id is the STORE's, not this component's:
  // the palette's New Note is a keyboard route into edit from outside the
  // canvas, and one caret written by two owners is two carets (LESSONS 7)
  const editingId = useCanvas((s) => s.editing);
  const [menu, setMenu] = useState<{ x: number; y: number; blockId: string } | null>(null);
  const profileId = meta?.profileId ?? null;
  const loaded = useCanvas((s) => (profileId ? s.loaded[profileId] === true : false));
  const scroll = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (profileId) void useCanvas.getState().load(profileId);
  }, [profileId]);

  /** the caret line standing on the page, by nonce and by CELL. The nonce is
   * monotonic so a click always remounts the line and the caret lands in it: a
   * click that follows a blur has already committed whatever words were there.
   * The cell is where the click WAS (C2b call 6): a page of cells has a place
   * for a press to mean, and the caret goes to the one it landed in rather
   * than to the end of a list */
  const [caret, setCaret] = useState<{ n: number; cell: Cell } | null>(null);
  const nonce = useRef(0);
  /** the grid's own pitch, handed over on mount: ONE arithmetic for the cell a
   * press is in and the cell an element snaps to (DESIGN rule 14) */
  const pageRef = useRef<GridPage | null>(null);
  const page = useCallback((api: GridPage | null) => {
    pageRef.current = api;
  }, []);
  const write = (at?: { x: number; y: number }) => {
    nonce.current += 1;
    // a press NAMES a cell, so the caret takes that one and nothing around it
    // (the sticky the vocabulary already has: a note is the one kind that
    // stands on a single cell) and grows by its words from there. The page's
    // own caret names nothing, so it opens at the kind's default span, read
    // from the same table `addNote` opens a note with (DESIGN rule 14)
    const span = at ? { w: 1, h: 1 } : defaultSpanFor(DRAFT);
    setCaret({ n: nonce.current, cell: { x: at?.x ?? 0, y: at?.y ?? 0, ...span } });
  };

  /** the words the caret line committed, as a block in the cell it stood in.
   * Three of the document's own doors and one render: the note is placed,
   * held to the cell it was typed in and sized to what it holds, all before
   * the debounce that writes any of it (a caret is not worth a fourth door) */
  const land = (text: string, cell: Cell) => {
    const store = useCanvas.getState();
    const columns = pageRef.current?.columns() ?? store.columnsOf(canvasId);
    const id = store.addNote(canvasId, text);
    store.resizeTo(canvasId, id, { w: cell.w, h: cell.h }, columns, { auto: true });
    store.moveTo(canvasId, id, { x: cell.x, y: cell.y }, columns);
  };

  // an empty canvas hands the page the caret, once, when the document is
  // KNOWN to be empty: a list still loading is not an empty canvas, and a
  // caret dropped into a document that then arrives would sit under it
  const opened = useRef(false);
  useEffect(() => {
    if (!loaded || opened.current) return;
    opened.current = true;
    if ((useCanvas.getState().docs[canvasId]?.blocks.length ?? 0) === 0) write();
  }, [canvasId, loaded]);

  // which ids stood here a render ago: an id that is new ARRIVES (panelIn),
  // one that stood here under different content was REPLACED (swapIn)
  const seen = useRef<Set<string>>(new Set());
  useEffect(() => {
    seen.current = new Set(blocks.map((b) => b.id));
  }, [blocks]);

  // one scroll per answer, to the first block that answer wrote, and only
  // when that block's title is out of view. Vertical, instant and this
  // container's own, revealRow's rule: a page that followed every arrival
  // would yank the reader off the block they were reading. The blocks that
  // already stood when the canvas opened are not arrivals
  const answered = useRef<Set<string>>(new Set());
  const seeded = useRef(false);
  useEffect(() => {
    const el = scroll.current;
    if (!el || !loaded) return;
    if (!seeded.current) {
      seeded.current = true;
      for (const b of blocks) {
        const ex = written(b).wroteBy;
        if (ex !== undefined) answered.current.add(ex);
      }
      return;
    }
    for (const b of blocks) {
      const ex = written(b).wroteBy;
      if (ex === undefined || answered.current.has(ex)) continue;
      const node = el.querySelector<HTMLElement>(`[data-block="${b.id}"]`);
      if (!node) continue;
      answered.current.add(ex);
      const view = el.getBoundingClientRect();
      const top = node.getBoundingClientRect().top;
      if (top >= view.top && top <= view.bottom - 24) return;
      // the page's own inset is where the title comes to rest, read off the
      // page rather than repeated here (canvas.css .cv-scroll)
      el.scrollTop += top - view.top - parseFloat(getComputedStyle(el).paddingTop);
      return;
    }
  }, [blocks, loaded]);

  /** the picker's answer: a sibling runs the block's statement read-only and
   * the diff takes the table's place; the compared one again clears it */
  const compare = (b: ResultBlockDoc, profileB: string | null) => {
    if (profileB === null) {
      useCanvas.getState().clearCompare(canvasId, b.id);
      return;
    }
    void useCanvas
      .getState()
      .compare(canvasId, b.id, profileB)
      .then((out) => {
        // a comparison that could not be made says why, in the app's one cue
        // (LESSONS 9): a face that silently did not appear reads as a bug
        if (!out.ok) copyCueShow(out.message);
      });
  };

  /** the block's menu, and the one a right-click opens. Compare's picker is a
   * menu and More is a menu, so it is ONE menu: a submenu of the connection's
   * siblings with a mark on the compared one, and picking the marked one
   * clears the comparison. `Move Up` and `Move Down` are gone with C2a (a
   * place on a grid is a drag or an arrow key, and splicing the reading order
   * moves nothing a reader can see), so the menu is 3 rows where it was 4 */
  const menuFor = (b: ResultBlockDoc): MenuNode[] => {
    const place: MenuNode[] = [
      { kind: "sep" },
      {
        kind: "item",
        label: "Delete",
        hint: <Kbd chord="delete" />,
        danger: true,
        // a result's Delete acts at once: the exchange still stands in its
        // thread and Add to Canvas rebuilds the block (DECISIONS, A3)
        onSelect: () => useCanvas.getState().remove(canvasId, b.id),
      },
    ];
    // a block with no statement has nothing to run on a sibling: the row
    // stands disabled rather than absent (DESIGN rule 2's matrix)
    const picker: MenuNode =
      b.sql && profileId
        ? compareWithMenu({
            profileId,
            comparedTo: b.diff?.b.profileId ?? null,
            onPick: (target) => compare(b, target),
          })
        : { kind: "item", label: "Compare With", disabled: true, onSelect: () => {} };
    return [picker, ...place];
  };

  const openMenu = useCallback((blockId: string, x: number, y: number) => setMenu({ x, y, blockId }), []);

  // the page's own first commit: the blocks that stood here when the canvas
  // opened are not arrivals, and only what lands after it wears an entrance
  const entered = useRef(false);
  useEffect(() => {
    entered.current = true;
  }, []);

  /** what every block answers to, read once against the document it is in:
   * the grid's label and live region and the row's own `Ask` name it alike */
  const naming = useCallback((b: Block) => nameOf(b, blocks), [blocks]);

  /** C2b call 4: whether the chosen model reads an image, read as state so a
   * model swapped in Settings takes the drawing's `Ask` with it. The two
   * facts behind it are the provider's wire and the model's own row
   * (stores/agent canSeeImages); this subscribes to the settings the switch
   * and the picker write, and the answer is one boolean */
  const sees = useSettings(() => (profileId ? canSeeImages(profileId) : false));

  const renderBlock = useCallback(
    (b: Block, cell: Cell) => (
      // a replaced block crossfades where it stood; a new one arrives
      <CanvasRow
        block={b}
        canvasId={canvasId}
        cell={cell}
        name={naming(b)}
        canAsk={sees}
        arrive={seen.current.has(b.id) ? swapIn : panelIn}
        entering={entered.current}
        editing={editingId === b.id}
        menuHere={menu?.blockId === b.id}
        onMenu={openMenu}
      />
    ),
    [canvasId, editingId, menu?.blockId, naming, openMenu, sees],
  );

  return (
    <div
      className="cv-scroll"
      ref={scroll}
      onPointerDown={(e) => {
        // the cells show for the length of the press and leave with it: at
        // rest nothing says where a cell is, and putting something somewhere
        // is exactly when that matters (a drag's own lattice, same rule)
        if (e.button !== 0 || !onPage(e)) return;
        pageRef.current?.lattice(true);
        const off = () => {
          pageRef.current?.lattice(false);
          window.removeEventListener("pointerup", off);
          window.removeEventListener("pointercancel", off);
        };
        window.addEventListener("pointerup", off);
        window.addEventListener("pointercancel", off);
      }}
      onClick={(e) => {
        // the card itself, the page under the elements and the tail below it
        // are where a click writes; a click that landed on a block is the
        // block's own
        if (onPage(e)) write(pageRef.current?.cellAt(e.clientX, e.clientY));
      }}
    >
      <CanvasGrid
        canvasId={canvasId}
        blocks={blocks}
        columnsHint={(doc as (typeof doc & { lastColumns?: number }) | undefined)?.lastColumns}
        renderBlock={renderBlock}
        keyOf={keyOf}
        nameOf={naming}
        kindOf={kindOf}
        page={page}
        draft={
          caret === null
            ? null
            : {
                cell: caret.cell,
                // the caret line: one empty note in edit, standing in the cell
                // the click landed in and outside the document until its first
                // words reach `addNote`
                node: (
                  <div className="cv-item" key={caret.n}>
                    <NoteBlock
                      block={DRAFT}
                      editing
                      onEdit={() => {}}
                      onCommit={(text) => {
                        const cell = caret.cell;
                        setCaret(null);
                        land(text, cell);
                      }}
                      onCancel={() => setCaret(null)}
                      onDelete={() => setCaret(null)}
                    />
                  </div>
                ),
              }
        }
      />
      {menu &&
        (() => {
          // the note's menu is NoteBlock's own; this one is the result's
          const b = blocks.find((x) => x.id === menu.blockId);
          if (!b || b.kind !== "result") return null;
          return <ContextMenu point={menu} items={menuFor(b)} onClose={() => setMenu(null)} />;
        })()}
    </div>
  );
}
