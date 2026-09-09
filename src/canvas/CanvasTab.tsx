// The canvas, as a tab of the main card (A3 item 6). One column of blocks at
// the card's own width, 20px in from every edge, 16px apart, and no chrome of
// its own: no toolbar, no strip, no frame per block. The tab is the strip
// (DESIGN rule 15: three blocks stand here under 0 always-visible controls).
//
// The empty canvas is EMPTY: zero strings and zero controls. What it does
// carry is a CARET, at the page's first line, because a blank card with a
// caret is a page and a blank card with nothing is nothing at all, and the
// difference is one caret (B3; A3's counts hold, a caret being no control).
// The caret line is an empty note being written and NOT yet a block: the
// store's own note would reach appdb on its 400 ms debounce, so a stray click
// used to leave a row behind, and three clicks left three (the boxes the
// maintainer saw). One click gives one caret line, a second click gives the
// same one, the first words make it a block through `addNote`, and a caret
// that loses focus with nothing in it leaves nothing anywhere. The palette's
// `New Note` is the keyboard route and mints the store's note as it always
// did; its blur removes it the same way.
//
// A block is a result or a note. The result is the pane's own ResultBlock,
// grown by props rather than forked: the TITLE line is the exchange's
// question, which stands once, on the answer's first block, and the model's
// own six-word title on its other results (rule 14: the question once); a
// one-row result stands on its VALUES, since a grid of one row is chrome
// around figures that are their own row; the model's sentence rides read-only
// above the faces, the status line folds the assumptions in after one
// lowercase `assumed`, and the cluster is Copy · Flip · Insert · Ask · More
// (5 hot, 0 at rest). The note is NoteBlock's, the same picture with Copy ·
// Ask · More. `More` is the block's menu and the one a right-click opens:
// place actions (Compare With, Move Up, Move Down, Delete) act on the block's
// position in the document rather than on its content, so they leave the
// cluster for the menu.
//
// Motion adds no preset (DECISIONS, A3): a block arrives WHOLE on `panelIn`,
// the card's own entrance, with the blocks under it making room on
// `spring.layout`; a block the model REPLACED lands where the old one stood
// on `swapIn`, the flip's own crossfade, so the change reads as a change; a
// removed block fades where it stands while the gap closes on the same
// spring. Nothing streams in word by word: the pane's thinking strip is the
// one loading UI, and a page that assembles in whole blocks is read as it
// grows. When an answer's FIRST block lands out of view the canvas scrolls
// once, to that block's title, and the blocks after it land below with no
// further scroll (LESSONS 7: one scroll authority per gesture). Focus never
// moves into the canvas on a write: the composer keeps the caret.

import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
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
  facesOf,
  statusOf,
  useCanvas,
  type Block,
  type NoteBlock as NoteBlockDoc,
  type ResultBlock as ResultBlockDoc,
  type StatusLine,
} from "../stores/canvas";
import { compareWithMenu } from "./compareMenu";
import { NoteBlock } from "./NoteBlock";
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
  return block.question || written(block).title || "";
}

/** what makes a block a different READING of the same slot. A replace keeps
 * the block's id and its place, so the id alone cannot tell a rewrite from a
 * re-render; the content's own signature can, and the new block then
 * crossfades over the old where it stood instead of arriving as a new one. */
export function revOf(block: Block): string {
  return block.kind === "note" ? block.text : `${block.sql ?? ""}|${block.rows.length}|${block.ms}`;
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
  actions,
}: {
  block: ResultBlockDoc;
  canvasId: string;
  status: StatusLine | null;
  actions: ReactNode;
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
      actions={actions}
    />
  );
}

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

  /** the caret line standing on the page, by nonce. The nonce is monotonic so
   * a click always remounts the line and the caret lands in it: a click that
   * follows a blur has already committed whatever words were there */
  const [caret, setCaret] = useState<number | null>(null);
  const nonce = useRef(0);
  const write = () => {
    nonce.current += 1;
    setCaret(nonce.current);
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

  const askAbout = (b: ResultBlockDoc) => {
    void import("../stores/agent").then(({ useAgent }) =>
      useAgent.getState().askAbout({
        id: b.id,
        name: titleOf(b),
        sql: b.sql,
        columns: b.columns,
        rowCount: b.rows.length,
      }),
    );
  };

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
   * clears the comparison. Move Up is disabled on the first block, never
   * hidden (DESIGN rule 2) */
  const menuFor = (b: ResultBlockDoc, i: number): MenuNode[] => {
    const place: MenuNode[] = [
      { kind: "item", label: "Move Up", disabled: i === 0, onSelect: () => useCanvas.getState().move(canvasId, b.id, -1) },
      {
        kind: "item",
        label: "Move Down",
        disabled: i === blocks.length - 1,
        onSelect: () => useCanvas.getState().move(canvasId, b.id, 1),
      },
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

  const openMenu = (blockId: string, x: number, y: number) => setMenu({ x, y, blockId });

  return (
    <div
      className="cv-scroll"
      ref={scroll}
      onClick={(e) => {
        // the card itself, and the tail under the last block, are where a
        // click writes; a click that landed on a block is the block's
        if (e.target === e.currentTarget) write();
      }}
    >
      <AnimatePresence mode="popLayout" initial={false}>
        {blocks.map((b, i) => {
          // a replaced block crossfades where it stood; a new one arrives
          const arrive = seen.current.has(b.id) ? swapIn : panelIn;
          const title = titleOf(b);
          if (b.kind === "note") {
            return (
              <motion.div
                key={`${b.id}:${revOf(b)}`}
                layout
                {...arrive}
                exit={{ opacity: 0 }}
                className={`cv-item${title ? " titled" : ""}`}
              >
                <NoteBlock
                  block={b}
                  editing={editingId === b.id}
                  canMoveUp={i > 0}
                  canMoveDown={i < blocks.length - 1}
                  onEdit={() => useCanvas.getState().beginEdit(b.id)}
                  onCommit={(text) => {
                    useCanvas.getState().updateNote(canvasId, b.id, text);
                    useCanvas.getState().endEdit();
                  }}
                  onCancel={() => {
                    // a note that never had words leaves with the cancel:
                    // an empty block is a block being written, and one nobody
                    // wrote is not a block (the fold's own contract)
                    if (b.text === "") useCanvas.getState().remove(canvasId, b.id);
                    useCanvas.getState().endEdit();
                  }}
                  onDelete={() => {
                    useCanvas.getState().remove(canvasId, b.id);
                    useCanvas.getState().endEdit();
                  }}
                  onMove={(dir) => useCanvas.getState().move(canvasId, b.id, dir)}
                />
              </motion.div>
            );
          }
          const status = statusOf(b);
          return (
            <motion.div
              key={`${b.id}:${revOf(b)}`}
              layout
              {...arrive}
              exit={{ opacity: 0 }}
              className={`blk${title ? " titled" : ""}`}
              data-block={b.id}
              tabIndex={0}
              onContextMenu={(e) => {
                // the faces box owns its own right-click (the grid retargets
                // its selection and opens the cell menu): two menus at one
                // press is a bug, so the block's menu answers everywhere else
                // on the block, and `More` is its always-there route
                if ((e.target as HTMLElement).closest(".rb")) return;
                e.preventDefault();
                openMenu(b.id, e.clientX, e.clientY);
              }}
              onKeyDown={(e) => {
                if (e.target !== e.currentTarget) return;
                if (e.key !== "Backspace" && e.key !== "Delete") return;
                e.preventDefault();
                useCanvas.getState().remove(canvasId, b.id);
              }}
            >
              <CanvasResult
                block={b}
                canvasId={canvasId}
                status={status}
                actions={
                  <>
                    <button
                      type="button"
                      className="iconbtn iconbtn-sm"
                      title="Ask"
                      aria-label="Ask"
                      onClick={() => askAbout(b)}
                    >
                      <MessageSquare size={12} />
                    </button>
                    <button
                      type="button"
                      className={`iconbtn iconbtn-sm${menu?.blockId === b.id ? " active" : ""}`}
                      title="More"
                      aria-label="More"
                      aria-haspopup="menu"
                      onClick={(e) => {
                        const r = e.currentTarget.getBoundingClientRect();
                        openMenu(b.id, r.right, r.bottom + 4);
                      }}
                    >
                      <Ellipsis size={12} />
                    </button>
                  </>
                }
              />
            </motion.div>
          );
        })}
      </AnimatePresence>
      {caret !== null && (
        // the caret line: one empty note in edit, at the page's last line,
        // outside the document until its first words reach `addNote`
        <div className="cv-item" key={caret}>
          <NoteBlock
            block={DRAFT}
            editing
            canMoveUp={false}
            canMoveDown={false}
            onEdit={() => {}}
            onCommit={(text) => {
              setCaret(null);
              useCanvas.getState().addNote(canvasId, text);
            }}
            onCancel={() => setCaret(null)}
            onDelete={() => setCaret(null)}
            onMove={() => {}}
          />
        </div>
      )}
      {menu &&
        (() => {
          // the note's menu is NoteBlock's own; this one is the result's
          const at = blocks.findIndex((b) => b.id === menu.blockId);
          const b = at < 0 ? null : blocks[at];
          if (!b || b.kind !== "result") return null;
          return <ContextMenu point={menu} items={menuFor(b, at)} onClose={() => setMenu(null)} />;
        })()}
    </div>
  );
}
