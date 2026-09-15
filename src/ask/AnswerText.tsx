// The answer slot (AGENT-UX section 2 item 3, W5): the model's last text
// block as blocks in the pane's own registers. parseBlocks (agent/display.ts)
// owns what a block IS and what the anatomy already shows (the SQL fence, the
// Assumptions line and, with a run on screen, any table of the results never
// reach here: DESIGN rule 14); this file owns what a block looks like.
//
// D2 item 7, the rhythm: prose is 13 / 20px at tier 1 and paragraphs are 8
// apart; a list, a code block and the model's table are blocks inside the
// prose and take 16 above and below (ask.css). A lead-in of at most four
// words wears the trace-kind face (the picker's group heading is the same
// species): a label over its group, never a heading hierarchy. A LONGER
// heading is a sentence, not a label, and renders as prose that opens the
// group under it (.ans-colon, 4 to its group), which is what stopped the
// maintainer's `Here are the 70 ERP tables:` from shouting in small caps; a
// paragraph the model ended with a colon opens its group the same way. The
// count is the renderer's, not the parser's: the parser says a lead-in was
// MARKED, this file says whether it is short enough to be set as one.
//
// Lists keep their marker in tier 2 and their items 4px apart, with no clamp:
// a clipped answer lies (LESSONS 9), so the two-line cap on a bullet is the
// prompt's ask and the presentation score's check, never the renderer's
// knife. The marker is the item's own first cell rather than a ::marker (D1
// item 5: an ordinal right-aligned in a fixed gutter, so `1.` and `70.` end
// on one edge instead of hanging off the answer's left side), which takes
// the list's semantics with the UA's markers and gives them back as a role.
// Past twelve items the list FOLDS (D2 item 6): the twelfth is the last one
// drawn and one `Show All 70` line stands under it, in the list's own text
// column. Opened, it stays open for the exchange and for the session (the
// reader asked for the list; there is no way back). A quote is a hairline
// rule and tier 2; a code block is the editor's own face, the tokens
// src/editor draws with and no second palette, and when the fence holds a
// statement no run on screen owns it is the read-only SQL face itself, with
// the app's own grammar and highlight (D2 item 7); a table the model drew for
// itself, with no run to restate, is the app's one grid species in readOnly
// mode, header plus up to six rows, the shape AnswerBlock gives a run.
// Figures set in tabular numerals at weight 600, whether or not the model
// bolded them (bold stays 650, the figure below it: the face is the
// emphasis). Links open in the browser through the opener plugin, http(s)
// only; any other scheme is its text.
//
// Streaming: the slot re-renders on every delta and nothing inside it
// animates (blocks are keyed by index and kind, so a block that grows keeps
// its node and a block that changes kind cannot: the parser promises it never
// does once its first line is complete). A list past the fold is the same
// promise: what is drawn is the twelve items that settled before the
// thirteenth arrived, so the box does not move while the tail streams. The
// section fade is the slot's (ask.css .ans-body > *); the live region is the
// slot too, polite on the newest exchange, and it stays :empty when nothing
// renders so the column gap reserves nothing for it (rule 2) while the region
// stays in the tree.

import { openUrl } from "@tauri-apps/plugin-opener";
import { animate } from "motion/react";
import { Fragment, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { inlineTokens, isSqlFence, parseBlocks, type Block } from "../agent/display";
import { spring } from "../design/springs";
import { Grid } from "../grid/Grid";
import { statementFromRun } from "./AnswerBlock";
import { SqlFace } from "./SqlFace";

export interface AnswerTextProps {
  /** the exchange's streamed text, as the model wrote it */
  raw: string;
  /** a run is on screen (grid or value): a markdown table is then the grid
   * restated and never renders */
  hasRun: boolean;
  /** the newest exchange: its slot is the polite live region */
  live: boolean;
}

/** rows a model's own table shows before it scrolls inside its slot (the
 * result grid's window, AnswerBlock GRID_ROWS_SHOWN) */
const TABLE_ROWS_SHOWN = 6;
/** items a list shows before it folds (D2 item 6). Twelve is what a reader
 * scans without scrolling past the answer; the thirteenth is what a query
 * would have returned, which is what PROMPT v5 asks the model for */
const FOLD_AT = 12;
/** words past which a marked lead-in is a sentence, not a label (D2 item 7) */
const LEAD_WORDS_MAX = 4;
const HTTP = /^https?:\/\//i;

const words = (text: string): number => text.trim().split(/\s+/).length;

/** a line that opens the group under it, rather than titling it: a heading
 * too long to set as a label, or a paragraph the model ended with a colon.
 * Prose at 400, 4px to its group (ask.css .ans-colon) */
const opensGroup = (text: string): boolean => text.trimEnd().endsWith(":");

/** The fold's memory, per list, for the session: opened, a list stays open
 * through a re-render, a stream delta and the remount a thread switch costs.
 * The key is the twelve items ABOVE the fold, which have settled by the time a
 * thirteenth exists, so a list still streaming keeps the key it opened under
 * (agent/display.ts: no rule reads backwards across a completed line). Two
 * exchanges that answered with the same list share one memory, which is the
 * same list twice and not two facts. */
const opened = new Set<string>();
const foldKey = (ordered: boolean, items: string[]): string =>
  `${ordered ? "o" : "u"}\u0000${items.slice(0, FOLD_AT).join("\u0000")}`;

/** emphasis is a register, not a leaf: bold, italic and link text pass
 * through the tokenizer again, so a figure inside a bolded phrase is still a
 * figure (a bold that IS a figure the tokenizer already hands over as one). A
 * link whose text was an identifier in backticks (`code`) keeps its mono; a
 * link inside a link is its text */
function inline(text: string, inLink = false): ReactNode[] {
  return inlineTokens(text).map((t, i) => {
    switch (t.kind) {
      case "text":
        return t.text;
      case "bold":
        return <b key={i}>{inline(t.text, inLink)}</b>;
      case "italic":
        return <i key={i}>{inline(t.text, inLink)}</i>;
      case "code":
        return <code key={i}>{t.text}</code>;
      case "figure":
        return (
          <span key={i} className="fig">
            {t.text}
          </span>
        );
      case "link": {
        const label = t.code ? <code>{t.text}</code> : inline(t.text, true);
        if (inLink || !HTTP.test(t.href)) return <Fragment key={i}>{label}</Fragment>;
        const href = t.href;
        return (
          <a
            key={i}
            href={href}
            onClick={(e) => {
              // the webview must never navigate: the page IS the app
              e.preventDefault();
              void openUrl(href);
            }}
          >
            {label}
          </a>
        );
      }
    }
  });
}

/** the model's own comparison, when no run is on screen to restate: the grid
 * species from the run shape, with no timing (the status line is the run's,
 * and there is none) */
function TableBlock({ header, rows }: { header: string[]; rows: string[][] }) {
  const stmt = useMemo(
    () => statementFromRun({ columns: header, rows, rowCount: rows.length, capped: false, ms: 0 }, null),
    [header, rows],
  );
  return (
    <div className="ans-grid">
      <Grid statement={stmt} readOnly maxRows={TABLE_ROWS_SHOWN} />
    </div>
  );
}

/** A list, folded past twelve items (D2 item 6).
 *
 * The marker is drawn in the item's own gutter cell (ask.css: a fixed gutter
 * is the only way `1.` and `70.` end on one edge), which costs
 * `list-style: none`, and WebKit drops a list's semantics with its markers.
 * `role="list"` puts them back, so the answer is still a list of n items to a
 * screen reader (section 12), and a folded one is honestly a list of twelve
 * with a button under it rather than a seventy that lies about what is drawn.
 *
 * The fold is a MODE, and it opens one way: the reader asked for the list.
 * Motion is the box's height on spring.layout and the rows past the fold
 * fading in on --dur-slow (ask.css .ans-more), with the line gone at once;
 * both collapse to instant under reduced motion (springs.ts hands back the
 * instant variant, tokens.css kills the fade). The travel is driven from the
 * one layout effect the flip runs, never from a layout prop: a prop would
 * animate the box on every streamed item too, and a list grows the way prose
 * grows by its next word. The height leaves as soon as it lands, so a pane
 * resized later reflows the list instead of clipping it. */
function ListBlock({ ordered, items }: { ordered: boolean; items: string[] }) {
  const foldable = items.length > FOLD_AT;
  const key = foldable ? foldKey(ordered, items) : "";
  const [shown, setShown] = useState(false);
  const open = !foldable || shown || opened.has(key);
  const boxRef = useRef<HTMLDivElement>(null);
  // the height the twelve stood at, read BEFORE the rest reach the DOM: the
  // click is the only moment the folded box is still on screen
  const fromRef = useRef<number | null>(null);

  useLayoutEffect(() => {
    const box = boxRef.current;
    const from = fromRef.current;
    fromRef.current = null;
    if (!box || from === null) return;
    const to = box.offsetHeight;
    if (to === from) return;
    // the origin is written HERE, not left to the animation's first frame: a
    // keyframe lands one frame late and that frame would paint the whole list
    box.style.overflow = "hidden";
    box.style.height = `${from}px`;
    const run = animate(box, { height: [`${from}px`, `${to}px`] }, spring.layout);
    void run.finished.then(
      () => {
        box.style.height = "";
        box.style.overflow = "";
      },
      // a stop on unmount: nothing to clear, and nothing to report
      () => {},
    );
    return () => run.stop();
  }, [open]);

  const rows = open ? items : items.slice(0, FOLD_AT);
  // the rows past the fold are the only ones that fade: everything above it
  // was already on screen and must not move (the fold's own motion note)
  const li = rows.map((it, j) => (
    <li key={j} className={j >= FOLD_AT ? "ans-more" : undefined}>
      {inline(it)}
    </li>
  ));
  return (
    <>
      <div className="ans-list" ref={boxRef}>
        {ordered ? <ol role="list">{li}</ol> : <ul role="list">{li}</ul>}
      </div>
      {!open && (
        <div className="ans-fold" data-ordered={ordered ? "" : undefined}>
          <button
            type="button"
            className="linkish"
            onClick={() => {
              fromRef.current = boxRef.current?.offsetHeight ?? null;
              opened.add(key);
              setShown(true);
            }}
          >
            Show All {items.length}
          </button>
        </div>
      )}
    </>
  );
}

function block(b: Block, i: number): ReactNode {
  const key = `${i}:${b.kind}`;
  switch (b.kind) {
    case "p":
      return (
        <p key={key} className={opensGroup(b.text) ? "ans-colon" : undefined}>
          {inline(b.text)}
        </p>
      );
    case "lead":
      // a label is at most four words; anything longer is a sentence, and a
      // sentence set in small caps shouts (D2 item 7)
      return words(b.text) <= LEAD_WORDS_MAX ? (
        <div key={key} className="ans-lead">
          {inline(b.text)}
        </div>
      ) : (
        <p key={key} className="ans-colon">
          {inline(b.text)}
        </p>
      );
    case "list":
      return <ListBlock key={key} ordered={b.ordered} items={b.items} />;
    case "quote":
      return <blockquote key={key}>{inline(b.text)}</blockquote>;
    case "code":
      // a statement no run on screen owns is the model's own, and it wears the
      // app's ONE read-only SQL face, the same view the result block's SQL face
      // is (DESIGN rule 1, AGENT-UX section 2c). The box around it is the same
      // box the plain fence gets, so the two are one species with one of them
      // highlighted; every other tag stays plain
      return isSqlFence(b.lang, b.text) ? (
        <div key={key} className="ans-sql">
          <SqlFace text={b.text} variant="prose" />
        </div>
      ) : (
        <pre key={key}>{b.text}</pre>
      );
    case "table":
      return <TableBlock key={key} header={b.header} rows={b.rows} />;
  }
}

export function AnswerText({ raw, hasRun, live }: AnswerTextProps) {
  const blocks = useMemo(() => parseBlocks(raw, { hasRun }), [raw, hasRun]);
  return (
    <div className="ans-text" aria-live={live ? "polite" : "off"} aria-atomic={false}>
      {blocks.map(block)}
    </div>
  );
}
