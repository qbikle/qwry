// The note block (A3 item 2): the second of the canvas's two kinds, and the
// only one the user writes. Prose, the model's or their own, rendered by the
// pane's own AnswerText so a paragraph, a lead-in, a list, a quote or a
// figure reads on the canvas exactly as it reads in an answer (one renderer,
// one register), and edited where it stands.
//
// Nothing frames it (DECISIONS, A3: a hairline box per block is one chrome
// frame times n, and Freeform frames nothing). Its cluster is the block's
// only chrome and rests invisible: **Grip · Copy · Ask · More**, 4 hot and 0
// at rest, the icon-button species in its 18px tier revealed the way every
// cluster in the app is revealed (ask.css .acts-float). The grip is C2a's and
// comes FIRST, because the one thing every kind does the same way is move
// (the canvas hands it in, so a note in a pane would have none). `More` is
// the block's menu and the one a right-click opens; with the grid under it
// there is one row left in it, `Delete…`, since a place is now a drag or an
// arrow key and never a menu row (3 rows to 1).
//
// Edit is a mode of the same box, not a second box: the read view already
// carries the composer's padding under a transparent border, outdented over
// its own margin the way a `.mention` pill outdents (ask.css), so entering
// edit fades a border in AROUND the words and moves no glyph (AGENT-UX
// section 16, the motion note). B3 finishes that: edit adds the RING and
// nothing else, one 1px accent hairline fading in over --dur-quick with no
// fill step and no border step under it, because a step from one visible
// border to another is a jump and a darker card under the words is a second
// surface. An EMPTY note in edit is a caret and no ring at all: a ring around
// nothing is a rounded box with a thinner line, and the ring arrives with the
// first glyph (note.css .note-box.ring).
//
// ⌘↩ commits, Esc cancels, and a note emptied in edit deletes itself on
// commit with no dialog: the preview IS the commit, the fold's own contract
// (DECISIONS, W4). BLUR is that same commit one step earlier (B3): leaving
// the words keeps them, so a tab switch never loses a draft, and a box that
// never had any leaves with the caret, which is what three empty boxes on a
// page were. The menu's `Delete…` is the other direction of the same
// ellipsis contract (WRITING rule 2) and goes through the app's danger
// confirm, because a note is words with no way back.

import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Copy, Ellipsis, MessageSquare } from "lucide-react";
import { kindTools, type BlockTool } from "./blockTools";
import { AnswerText } from "../ask/AnswerText";
import { Kbd } from "../design/Kbd";
import { copyCue } from "../lib/copyCue";
import { ContextMenu, type MenuNode } from "../app/overlay/ContextMenu";
import type { NoteBlock as CanvasNoteBlock } from "../stores/canvas";
import "../ask/ask.css";
import "./note.css";

/** the name a note answers to: its first line, markdown markers off, capped
 * where a saved query's name and a thread's title are capped. It is the
 * pill's text when the note is asked about and the detail of its delete
 * confirm, so one derivation serves both (LESSONS 4) */
const NAME_CAP = 80;
const MARKER = /^(#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s+)/;

export function noteName(text: string): string {
  const first = text.split("\n").find((l) => l.trim().length > 0) ?? "";
  const bare = first.trim().replace(MARKER, "").replace(/[*_`]/g, "").trim();
  return bare.length > NAME_CAP ? `${bare.slice(0, NAME_CAP)}…` : bare;
}

export interface NoteBlockProps {
  block: CanvasNoteBlock;
  /** the canvas owns which block is being edited: one caret on the document */
  editing: boolean;
  /** the cluster's first action, handed in by the surface that can move this
   * block: the grid's grip. Absent anywhere the note cannot be moved */
  lead?: ReactNode;
  /** a click on the words, and the palette's New Note on a fresh one */
  onEdit: () => void;
  /** ⌘↩, or a blur with words left: the source as the textarea holds it */
  onCommit: (text: string) => void;
  /** Esc: the words go back to what they were. A note that never had any
   * deletes instead, so the palette's `New Note` leaves nothing behind */
  onCancel: () => void;
  /** the confirm, when there was one, has already been answered */
  onDelete: () => void;
}

export function NoteBlock({ block, editing, lead, onEdit, onCommit, onCancel, onDelete }: NoteBlockProps) {
  const [draft, setDraft] = useState(block.text);
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const ta = useRef<HTMLTextAreaElement | null>(null);
  const words = draft.trim().length > 0;
  // the ring FADES: the box mounts with a transparent border and takes the
  // accent on the next frame, so a note the reader clicked and an empty one
  // that just took its first glyph both gain the hairline over --dur-quick
  // (a transition cannot run on the frame an element mounts). Reduced motion
  // is instant, from tokens.css's own duration kill
  const [ring, setRing] = useState(false);
  useEffect(() => {
    if (!editing || !words) {
      setRing(false);
      return;
    }
    const id = requestAnimationFrame(() => setRing(true));
    return () => cancelAnimationFrame(id);
  }, [editing, words]);

  // the words the box opens with are the words on screen; a note the canvas
  // rewrote under a live edit (an Ask reply landing) is not silently adopted
  useEffect(() => {
    if (editing) setDraft(block.text);
  }, [editing, block.text]);

  // the caret takes the end and the box takes the text's own height: a note
  // in edit is the same shape it was reading (no scrollbar, no jump). The
  // WIDTH is the canvas's now (a note stands on cells and a corner can widen
  // it mid-edit), so the words are measured again whenever it changes, and
  // never when only the height did: that is the loop this observer would
  // otherwise be
  useLayoutEffect(() => {
    const el = ta.current;
    if (!editing || !el) return;
    const fit = () => {
      el.style.height = "auto";
      el.style.height = `${el.scrollHeight}px`;
    };
    fit();
    let width = el.clientWidth;
    const ro = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width === width) return;
      width = entry.contentRect.width;
      fit();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [editing, draft]);

  useEffect(() => {
    const el = ta.current;
    if (!editing || !el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [editing]);

  /** an emptied note deletes itself: the preview is the commit, and a blur
   * is a commit (B3), so nothing empty is ever left standing */
  const commit = () => {
    const next = draft.trim();
    if (next) onCommit(next);
    else onDelete();
  };

  /** Esc puts the words back, and a note that never had any leaves with the
   * box: the palette's `New Note` opens an empty one, and cancelling it must
   * not leave a blank block standing in the document */
  const cancel = () => {
    if (block.text.trim()) onCancel();
    else onDelete();
  };

  /** words with no way back go through the app's danger confirm; the note's
   * first line names the object in data's clothes (WRITING, identifiers
   * inside chrome, form 3) */
  const remove = async () => {
    const name = noteName(block.text);
    if (!name) {
      onDelete();
      return;
    }
    const { confirmDanger } = await import("../stores/danger");
    if (await confirmDanger("Delete Note?", `“${name}”`, "Delete Note")) onDelete();
  };

  const ask = () => {
    void import("../stores/agent").then(({ useAgent }) =>
      useAgent.getState().askAbout({ id: block.id, name: noteName(block.text), text: block.text }),
    );
  };

  // one row, and it stands: `More` is also the right-click's menu and the
  // keyboard's route to `Delete…`, not a button in a costume
  const menu: MenuNode[] = [
    {
      kind: "item",
      label: "Delete…",
      hint: <Kbd chord="delete" />,
      danger: true,
      onSelect: () => void remove(),
    },
  ];

  const openMenu = (e: { clientX: number; clientY: number; preventDefault: () => void }) => {
    e.preventDefault();
    setMenuAt({ x: e.clientX, y: e.clientY });
  };

  // the cluster's own four, by the name the table knows them under: the order
  // and the roster are `kindTools`'s, so a note and a result can never drift
  // into two orders. The grip is the canvas's, handed in: a note in a pane
  // has nothing to drag itself over
  const tools: Partial<Record<BlockTool, ReactNode>> = {
    grip: lead,
    copy: (
      <button
        type="button"
        className="iconbtn iconbtn-sm"
        title="Copy"
        aria-label="Copy"
        onClick={() => void copyCue(block.text, "Copied note")}
      >
        <Copy size={12} />
      </button>
    ),
    ask: (
      <button type="button" className="iconbtn iconbtn-sm" title="Ask" aria-label="Ask" onClick={ask}>
        <MessageSquare size={12} />
      </button>
    ),
    more: (
      <button
        type="button"
        className={`iconbtn iconbtn-sm${menuAt ? " active" : ""}`}
        title="More"
        aria-label="More"
        aria-haspopup="menu"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setMenuAt({ x: r.right, y: r.bottom + 4 });
        }}
      >
        <Ellipsis size={12} />
      </button>
    ),
  };

  if (editing) {
    return (
      <div className={`blk blk-note${block.question ? "" : " noq"} edit`} data-block={block.id}>
        {block.question && <div className="blk-q">{block.question}</div>}
        <div className={`note-box${ring ? " ring" : ""}`} onKeyDown={(e) => e.stopPropagation()}>
          <textarea
            ref={ta}
            className="ask-ta"
            aria-label="Note"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            // leaving the words is keeping them, the fold's own contract one
            // step earlier; a box that never had any was not a block and
            // leaves with the caret
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                commit();
              } else if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                cancel();
              }
            }}
          />
        </div>
      </div>
    );
  }

  return (
    <div
      className={`blk blk-note${block.question ? "" : " noq"}`}
      data-block={block.id}
      // the block takes focus so backspace can reach it, the result block's
      // own reason for a tabIndex (CanvasTab's .blk)
      tabIndex={0}
      onContextMenu={openMenu}
      onKeyDown={(e) => {
        if (e.key !== "Backspace" && e.key !== "Delete") return;
        e.preventDefault();
        void remove();
      }}
    >
      {block.question && <div className="blk-q">{block.question}</div>}
      <div
        className="note-body"
        onClick={() => {
          // a drag that selected text is a select, never an edit (the
          // question bubble's own rule, AGENT-UX section 2 item 1)
          const sel = window.getSelection();
          if (sel && !sel.isCollapsed) return;
          onEdit();
        }}
      >
        <AnswerText raw={block.text} hasRun={false} live={false} />
      </div>
      <div className="acts-float">
        {kindTools("note").map((tool) => (
          <Fragment key={tool}>{tools[tool]}</Fragment>
        ))}
      </div>
      {menuAt && <ContextMenu point={menuAt} items={menu} onClose={() => setMenuAt(null)} />}
    </div>
  );
}
