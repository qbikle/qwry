// The canvas, as a tab of the main card (A3 item 6). One column of blocks at
// the card's own width, 20px in from every edge, 16px apart, and no chrome of
// its own: no toolbar, no strip, no frame per block. The tab is the strip
// (DESIGN rule 15: three blocks stand here under 0 always-visible controls).
//
// The empty canvas is EMPTY: zero strings and zero controls, a text cursor
// over the card, and a click writes the first note (the palette's `New Note`
// is the keyboard route). `Add an answer from Ask, or write a note.` was one
// string against none and died on the deletion test (DESIGN rule 11); Add to
// Canvas already announces itself in every answer's cluster, and the Ask
// empty state has stood with no sentence since W2. The tail under the last
// block is at least 64px of the same invitation (canvas.css .cv-scroll).
//
// A block is a result or a note. The result is the pane's own ResultBlock,
// grown by props rather than forked: the question line is its title, the
// model's sentence rides read-only above the faces, the status line folds the
// assumptions in after one lowercase `assumed`, and the cluster is Copy ·
// Flip · Insert · Ask · More (5 hot, 0 at rest). The note is NoteBlock's, the
// same picture with Copy · Ask · More. `More` is the block's menu and the one
// a right-click opens: place actions (Compare With, Move Up, Move Down,
// Delete) act on the block's position in the document rather than on its
// content, so they leave the cluster for the menu.
//
// Motion adds no preset (DECISIONS, A3): a block arrives on `panelIn`, the
// card's own entrance, with the blocks under it making room on
// `spring.layout`; a removed block fades where it stands while the gap closes
// on the same spring; a face flips as W7's block flips, inside ResultBlock.

import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Ellipsis, MessageSquare } from "lucide-react";
import { ResultBlock } from "../ask/ResultBlock";
import { ContextMenu, type MenuNode } from "../app/overlay/ContextMenu";
import { Kbd } from "../design/Kbd";
import { panelIn } from "../design/springs";
import { copyCueShow } from "../lib/copyCue";
import { msText } from "../lib/duration";
import {
  chartOf,
  facesOf,
  statusOf,
  useCanvas,
  type ResultBlock as ResultBlockDoc,
  type StatusLine,
} from "../stores/canvas";
import { compareWithMenu } from "./compareMenu";
import { NoteBlock } from "./NoteBlock";
import "./canvas.css";

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
  return (
    <ResultBlock
      exchangeId={block.id}
      run={run}
      sql={block.sql}
      tabTitle={block.question}
      headline={block.question}
      prose={block.prose}
      status={status ? <Status line={status} /> : null}
      faces={facesOf(block)}
      face={block.face}
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
  // which block holds the caret. A note with no words is by definition one
  // being written (an emptied note deletes itself on commit), and the id
  // itself is the STORE's, not this component's: the palette's New Note is a
  // keyboard route into edit from outside the canvas, and one caret written
  // by two owners is two carets (LESSONS 7)
  const editingId = useCanvas((s) => s.editing);
  const [menu, setMenu] = useState<{ x: number; y: number; blockId: string } | null>(null);
  const profileId = meta?.profileId ?? null;

  useEffect(() => {
    if (profileId) void useCanvas.getState().load(profileId);
  }, [profileId]);

  /** a click on the card writes: the note lands at the end and takes the
   * caret at once, since a note with no words is a note being written */
  const write = () => {
    const c = useCanvas.getState();
    c.beginEdit(c.addNote(canvasId, ""));
  };

  const askAbout = (b: ResultBlockDoc) => {
    void import("../stores/agent").then(({ useAgent }) =>
      useAgent.getState().askAbout({
        id: b.id,
        name: b.question,
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
      onClick={(e) => {
        // the card itself, and the tail under the last block, are where a
        // click writes; a click that landed on a block is the block's
        if (e.target === e.currentTarget) write();
      }}
    >
      <AnimatePresence initial={false}>
        {blocks.map((b, i) => {
          if (b.kind === "note") {
            return (
              <motion.div key={b.id} layout {...panelIn} exit={{ opacity: 0 }} className="cv-item">
                <NoteBlock
                  block={b}
                  editing={editingId === b.id || b.text === ""}
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
              key={b.id}
              layout
              {...panelIn}
              exit={{ opacity: 0 }}
              className="blk"
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
