// The `@` completion popover (W6): the model picker's box (AGENT-UX section
// 8) opened UPWARD from the composer box at the composer's own width, holding
// what the fragment after the `@` matches: Tables, Columns (from two typed
// characters), Saved Queries, Threads, each group drawn only when it has
// rows, cmdk (`Command`) inside for the list, the hot row and the pointer.
// The filtering is not cmdk's: mentionRows.ts matches by substring on the
// name the user would type (cmdk's fuzzy scorer would put `wardrobe_products`
// under `ord`), and the popover UNMOUNTS when nothing matches, because a `No
// results` row is dead text (DESIGN rule 11) and the `@` under the caret is
// the title, so the box has no title and no footer either.
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
// handle this exports, which owns ↑↓ (the hot row), ↩ and ⇥ (the pick) and
// Esc (closes this and nothing else; the pane's Esc ladder gets the NEXT Esc)
// and no other key: Home, End, ⌘ chords and typing fall through to the
// textarea, whose next keyup re-reads the fragment. A mousedown outside the
// box and the textarea closes the popover while the press lands where it was
// aimed (Send sends, the pill opens the picker); one on the textarea is the
// textarea's, whose click re-reads the caret. A pick hands the canonical
// token to AskPanel, which splices it over the token and puts the caret after
// the space it appends.
//
// Rows are the picker's menu rows (`.picker-item`, `.hot` the highlight) at a
// fixed 28px so a mono identifier row and a text row are one row; a table's
// name and a title ellipsize at their end, a column row is two spans, the
// table part owning the overflow and the column, dot first, always whole
// (DECISIONS W6). The hint slot is data only: a table's row estimate, a
// column's type, nothing for a saved query or a thread.

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
import { menuIn } from "../design/springs";
import type { MentionQuery } from "../stores/ask";
import { mentionRows, type MentionRow, type MentionRowsCtx } from "./mentionRows";

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
  /** the draft the query indexes: `draft[at]` is the `@` */
  draft: string;
  /** the composer box (.ask-box): the popover's anchor and width */
  boxRef: RefObject<HTMLDivElement | null>;
  /** the textarea: a mousedown on it is its own, never an outside click */
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  ctx: MentionRowsCtx;
  /** the canonical token of the picked row, `@` included */
  onPick: (token: string) => void;
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
 * click is the pick */
function Row({ row, hot, onPick }: { row: MentionRow; hot: boolean; onPick: () => void }) {
  return (
    <Command.Item className={`picker-item${hot ? " hot" : ""}`} value={row.value} onSelect={onPick}>
      {row.kind === "column" ? (
        <span className="mention-path">
          <span className="mention-pre">{row.label}</span>
          <span className="mention-col">{row.column}</span>
        </span>
      ) : row.kind === "table" ? (
        <span className="mention-name">{row.label}</span>
      ) : (
        <span className="mention-title">{row.label}</span>
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
  draft,
  boxRef,
  textareaRef,
  ctx,
  onPick,
  onClose,
}: MentionPopoverProps) {
  const quoted = draft[query.at + 1] === '"';
  const groups = useMemo(() => mentionRows(query.filter, quoted, ctx), [query.filter, quoted, ctx]);
  const entries = useMemo(
    () => [...groups.tables, ...groups.columns, ...groups.saved, ...groups.threads],
    [groups],
  );

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
  const visible = groups.count > 0 && box !== null;

  const pick = (value: string) => {
    const row = entries.find((e) => e.value === value);
    if (row) onPick(row.token);
  };

  useImperativeHandle(ref, () => ({
    onKey: (e) => {
      if (!visible || e.metaKey || e.ctrlKey || e.altKey) return false;
      const n = entries.length;
      const at = Math.max(0, entries.findIndex((x) => x.value === hotValue));
      const move = (i: number) => setHot({ key, value: entries[i].value });
      if (e.key === "ArrowDown") move((at + 1) % n);
      else if (e.key === "ArrowUp") move((at - 1 + n) % n);
      else if (e.key === "Enter" || e.key === "Tab") pick(hotValue);
      else if (e.key === "Escape") onClose();
      else return false;
      e.preventDefault();
      e.stopPropagation();
      return true;
    },
  }));

  // a press anywhere but the box and the textarea closes the popover on the
  // way down, and the click lands where it was aimed (capture: before a
  // target that stops the event)
  const popRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!visible) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target;
      if (!(t instanceof Node) || popRef.current?.contains(t) || t === textareaRef.current) return;
      onClose();
    };
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, [visible, onClose, textareaRef]);

  if (!visible) return null;

  const group = (title: string, rows: MentionRow[]) =>
    rows.length > 0 && (
      <>
        <div className="picker-group">{title}</div>
        <Command.Group>
          {rows.map((row) => (
            <Row key={row.value} row={row} hot={row.value === hotValue} onPick={() => onPick(row.token)} />
          ))}
        </Command.Group>
      </>
    );

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
            {group("Tables", groups.tables)}
            {group("Columns", groups.columns)}
            {group("Saved Queries", groups.saved)}
            {group("Threads", groups.threads)}
          </Command.List>
        </Command>
      </motion.div>
    </div>,
    document.body,
  );
}
