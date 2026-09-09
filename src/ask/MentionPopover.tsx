// The `@` completion popover (W6): the model picker's box (AGENT-UX section
// 8) opened UPWARD from the composer box at the composer's own width, holding
// what the fragment after the `@` matches, in one run of rows: tables, then
// columns (from two typed characters), then saved queries, then this
// connection's other threads, cmdk (`Command`) inside for the list, the hot
// row and the pointer.
// The filtering is never cmdk's (`shouldFilter={false}`): the app's own
// matcher ranks the rows (mentionRows.ts `sectionsFor` over ask/fuzzy.ts,
// substring in W6 and W7 and a scored subsequence since B2), because a
// library's scorer put `wardrobe_products` under `ord` and no amount of
// tuning it would be OUR rule. The popover UNMOUNTS when nothing matches,
// because a `No results` row is dead text (DESIGN rule 11) and the `@` under
// the caret is the title, so the box has no title and no footer either.
//
// The composer's completion, not an overlay: it portals to <body> on the
// anchored popups' rung but never joins the overlay stack (escStack), the way
// the SQL editor's completion is the editor's own and not a popup over it
// (LESSONS 11, one language). A stack entry stood the app's chord handler
// down for as long as an `@word` was under the caret (App.tsx returns on
// overlayOpen(): ⌘J, ⌘K, ⌘W dropped, LESSONS 10) and put a click catcher
// over Send and the model pill (a press that did nothing, LESSONS 9). So:
// focusless like the picker, the textarea keeps focus and its caret and the
// box refuses mousedown; the keys come through AskPanel's own keydown by the
// handle this exports, which owns ↑↓ (the hot row), → (a category), ↩ and ⇥
// (the pick) and Esc (closes this and nothing else; the pane's Esc ladder
// gets the NEXT Esc) and no other key: ⌫, Home, End, ⌘ chords and typing fall
// through to the textarea, whose next keyup re-reads the fragment. A mousedown
// outside the box, the textarea and the `+` pill closes the popover while the
// press lands where it was aimed (Send sends, the model pill opens the
// picker); one on the textarea is the textarea's, whose click re-reads the
// caret. A pick hands the canonical token to AskPanel, which splices it over
// the token and puts the caret after the space it appends.
//
// Rows are the picker's menu rows (`.picker-item`, `.hot` the highlight) at a
// fixed 28px so a mono identifier row and a text row are one row; a table's
// name and a title ellipsize at their end, a column row is two spans, the
// table part owning the overflow and the column, dot first, always whole
// (DECISIONS W6). The hint slot is data only: a table's row estimate, a
// column's type, nothing for a saved query, a canvas or a thread.
//
// W7 took the four group headings out and gave every row its kind as an icon
// instead (Mention.tsx's MENTION_ICON, the one map the pill reads too, at
// --icon-sm in tier 2 ahead of the name): a heading naming the kind over
// rows that each carry the kind is one fact in two slots (DESIGN rule 14),
// and the kind belongs on the row, where the pick is made (rule 15). The box
// is flat on --bg-panel: the picker's raised tone said "a menu over the
// composer" and the composer's own panel says it with one surface.
//
// ---- B2: the box is sectioned, its height is fixed, and it opens on paths --
//
// W7's empty filter ran ~200 askable tables by row count in one pass, a dump
// reached by keyboard. With an EMPTY filter the box now opens on FIVE CATEGORY
// ROWS (`tables/` · `columns/` · `saved/` · `canvases/` · `threads/`: the kind
// icon, the path word in mono with its slash, the ContextMenu's own submenu
// chevron at the right), then `Recent` (≤4), `Tables` (≤5), `Saved` (≤3),
// `Canvases` (≤3) and `Threads` (≤3) under labelled hairlines, each section
// absent the moment it holds nothing: at most 23 rows and 5 hairlines against
// W7's one run of 200. A section is a hairline with its label at the LEFT of
// the line, never a heading row of its own (the Raycast exemplar), and the
// labels are landmarks on BOUNDARIES, not the kind restated: this list mixes
// one recency section with four kind sections, so a table under `Recent` and
// the first table under `Tables` read as one list without the boundary's name
// (rule 14 binds facts, and W7's strike was against a heading over one kind in
// one run). A row `Recent` shows is not repeated in its own kind section
// below. A typed fragment collapses the whole thing to ONE run with no
// hairlines, the categories it matches on top, then the kinds in their own
// order; inside a completed category, one kind and no hairlines.
//
// ↩, → or a click on a category row narrows the picker: AskPanel splices
// `@tables/` into the draft with NO space (the token you would have typed) and
// re-opens the query on the new fragment, so the box, re-reading it, stands
// inside the kind; ⌫ over the slash is the textarea's own and widens it back.
//
// The box is a FIXED 320px (DESIGN rule 2: chrome sized to its tallest state,
// content swapping inside), W7's cap made the height: rows draw from the top
// and the list scrolls inside when it runs longer, so the hot row and the top
// edge never move for the whole life of the completion, across every filter,
// category and section count. A sparse filter leaves the panel standing below
// its rows (Raycast's own cost, shown honestly in `b2-popover-category`).
// Narrowing is never animated: the rows redraw in place, the height and top
// edge held, the hot row back at the top and the scroller with it, because
// typing is never animated and the SQL editor's completion is the precedent.

import {
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type Ref,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { Command } from "cmdk";
import { motion } from "motion/react";
import { ChevronRight } from "lucide-react";
import { menuIn } from "../design/springs";
import type { MentionQuery } from "../stores/ask";
import { MENTION_ICON } from "./Mention";
import { sectionsFor, type MentionRow, type MentionRowsCtx } from "./mentionRows";

/** the box hangs 4px above the composer box; the box's top edge is the anchor */
const POP_GAP = 4;

/** what the composer's keydown offers the popover before anything else */
export interface MentionPopoverHandle {
  /** true when the popover took the key (and stopped it); false leaves the
   * key to the textarea, untouched */
  onKey: (e: ReactKeyboardEvent<HTMLTextAreaElement>) => boolean;
}

export interface MentionPopoverProps {
  ref?: Ref<MentionPopoverHandle>;
  query: MentionQuery;
  /** the fragment stands inside `@"…"`: a saved query, a canvas or a thread,
   * never a relation and never a path. AskPanel owns the answer, because the
   * `+` pill's query has no `@` in the draft to read it from */
  quoted: boolean;
  /** the composer box (.ask-box): the popover's anchor and width */
  boxRef: RefObject<HTMLDivElement | null>;
  /** the textarea: a mousedown on it is its own, never an outside click */
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  ctx: MentionRowsCtx;
  /** the canonical token of the picked row, `@` included */
  onPick: (token: string) => void;
  /** a category row: `@tables/` at the caret, no space, the box standing */
  onNarrow: (token: string) => void;
  /** Esc or a mousedown outside the box: close this popover only */
  onClose: () => void;
}

interface Box {
  x: number;
  y: number;
  width: number;
}

/** the hot row, remembered with the fragment it was chosen for: a new
 * fragment starts at the top again, the way cmdk's own search does */
interface Hot {
  key: string;
  value: string;
}

/** one row; cmdk's own pointer-move selects it (onValueChange, below) and its
 * click is the pick. A category row wears the path word in mono (it is the
 * token you would type) and the ContextMenu's submenu chevron: a row that
 * opens a level wears the mark every such row in the app wears (rule 1). No
 * count rides its hint slot (rule 11: delete `202` and nothing is lost) */
function Row({ row, hot, onTake }: { row: MentionRow; hot: boolean; onTake: () => void }) {
  const Kind = MENTION_ICON[row.kind];
  const category = row.path !== undefined;
  return (
    <Command.Item className={`picker-item${hot ? " hot" : ""}`} value={row.value} onSelect={onTake}>
      <Kind size={12} />
      {row.kind === "column" ? (
        <span className="mention-path">
          <span className="mention-pre">{row.label}</span>
          <span className="mention-col">{row.column}</span>
        </span>
      ) : row.kind === "table" || category ? (
        <span className="mention-name">{row.label}</span>
      ) : (
        <span className="mention-title">{row.label}</span>
      )}
      {category && (
        <>
          <span className="ask-grow" />
          <span className="mention-arrow">
            <ChevronRight size={12} />
          </span>
        </>
      )}
      {row.hint !== null && (
        <>
          <span className="ask-grow" />
          <span className="picker-ctx">{row.hint}</span>
        </>
      )}
    </Command.Item>
  );
}

export function MentionPopover({
  ref,
  query,
  quoted,
  boxRef,
  textareaRef,
  ctx,
  onPick,
  onNarrow,
  onClose,
}: MentionPopoverProps) {
  const list = useMemo(() => sectionsFor(query.filter, quoted, ctx), [query.filter, quoted, ctx]);
  const entries = list.rows;

  const key = `${quoted ? '"' : ""}${query.filter}`;
  const [hot, setHot] = useState<Hot | null>(null);
  const hotValue =
    hot !== null && hot.key === key && entries.some((e) => e.value === hot.value)
      ? hot.value
      : entries[0]?.value ?? "";

  // the anchor: the composer box's top-left, 4px up, and its outer width;
  // re-measured when the box grows (a wrapping fragment adds a line under
  // the caret) or the window moves it
  const [box, setBox] = useState<Box | null>(null);
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      const next = { x: r.left, y: r.top - POP_GAP, width: r.width };
      setBox((b) => (b && b.x === next.x && b.y === next.y && b.width === next.width ? b : next));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [boxRef]);

  // nothing to pick closes the box (rule 11); the first commit measures the
  // anchor and the second mounts the box, before either paints. Unmounted,
  // the handle owns no key either: ↩ over an empty match sends
  const visible = list.count > 0 && box !== null;

  const popRef = useRef<HTMLDivElement>(null);
  // narrowing redraws the rows inside a box whose height and top edge are
  // held, so the scroller goes back to the top with the hot row (the box's own
  // rule: the hot row never moves while the completion lives)
  useLayoutEffect(() => {
    if (popRef.current) popRef.current.scrollTop = 0;
  }, [key]);

  const take = (row: MentionRow | undefined) => {
    if (!row) return;
    if (row.path !== undefined) onNarrow(row.token);
    else onPick(row.token);
  };

  useImperativeHandle(ref, () => ({
    onKey: (e) => {
      if (!visible || e.metaKey || e.ctrlKey || e.altKey) return false;
      const n = entries.length;
      const at = Math.max(0, entries.findIndex((x) => x.value === hotValue));
      const row = entries[at];
      const move = (i: number) => setHot({ key, value: entries[i].value });
      if (e.key === "ArrowDown") move((at + 1) % n);
      else if (e.key === "ArrowUp") move((at - 1 + n) % n);
      else if (e.key === "ArrowRight") {
        // a level opens; every other row leaves → to the caret
        if (row?.path === undefined) return false;
        onNarrow(row.token);
      } else if (e.key === "Enter" || e.key === "Tab") take(row);
      else if (e.key === "Escape") onClose();
      else return false;
      e.preventDefault();
      e.stopPropagation();
      return true;
    },
  }));

  // a press anywhere but the box, the textarea and the `+` pill closes the
  // popover on the way down, and the click lands where it was aimed (capture:
  // before a target that stops the event). The pill is exempt because it is
  // the box's own opener: closing it here would make every press of it a
  // close and a re-open in one turn
  useEffect(() => {
    if (!visible) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target;
      if (!(t instanceof Node) || popRef.current?.contains(t) || t === textareaRef.current) return;
      if (t instanceof Element && t.closest(".ask-add")) return;
      onClose();
    };
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, [visible, onClose, textareaRef]);

  if (!visible) return null;

  return createPortal(
    <div className="picker-anchor mention-anchor" style={{ left: box.x, top: box.y, width: box.width }}>
      <motion.div
        ref={popRef}
        className="picker-pop mention-pop"
        {...menuIn}
        // focusless like the picker: the caret stays in the textarea
        onMouseDown={(e) => e.preventDefault()}
      >
        <Command
          shouldFilter={false}
          value={hotValue}
          onValueChange={(value) => setHot({ key, value })}
          label="Tags"
        >
          <Command.List label="Tags">
            {list.sections.map((section, i) => (
              <div key={section.label ?? `run-${i}`}>
                {section.label !== null && (
                  // a hairline with its label at the left, never a heading row
                  // and never a cmdk group: ↑↓ skip it because it is not an
                  // item at all
                  <div className="mention-sep" role="presentation">
                    {section.label}
                  </div>
                )}
                {section.rows.map((row) => (
                  <Row key={row.value} row={row} hot={row.value === hotValue} onTake={() => take(row)} />
                ))}
              </div>
            ))}
          </Command.List>
        </Command>
      </motion.div>
    </div>,
    document.body,
  );
}
