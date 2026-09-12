// The answer slot (AGENT-UX section 2 item 3, W5): the model's last text
// block as blocks in the pane's own registers. parseBlocks (agent/display.ts)
// owns what a block IS and what the anatomy already shows (the SQL fence, the
// Assumptions line and, with a run on screen, any table of the results never
// reach here: DESIGN rule 14); this file owns what a block looks like.
//
// A lead-in wears the trace-kind face (the picker's group heading is the
// same species): a label over its group, never a heading hierarchy. Lists
// keep their marker in tier 2 and their items 4px apart, with no clamp: a
// clipped answer lies (LESSONS 9), so the two-line cap on a bullet is the
// prompt's ask and the presentation score's check, never the renderer's
// knife. A quote is a hairline rule and tier 2; a non-SQL code block is the
// editor register (mono, panel-inset, wraps, no highlighting); a table the
// model drew for itself, with no run to restate, is the app's one grid
// species in readOnly mode, header plus up to six rows, the shape
// AnswerBlock gives a run. Figures set in tabular numerals at weight 600,
// whether or not the model bolded them (bold stays 650, the figure below it:
// the face is the emphasis). Links open in the browser through the opener
// plugin, http(s) only; any other scheme is its text.
//
// Streaming: the slot re-renders on every delta and nothing inside it
// animates (blocks are keyed by index and kind, so a block that grows keeps
// its node and a block that changes kind cannot: the parser promises it never
// does once its first line is complete). The section fade is the slot's
// (ask.css .ans-body > *); the live region is the slot too, polite on the
// newest exchange, and it stays :empty when nothing renders so the column
// gap reserves nothing for it (rule 2) while the region stays in the tree.

import { openUrl } from "@tauri-apps/plugin-opener";
import { Fragment, useMemo, type ReactNode } from "react";
import { inlineTokens, parseBlocks, type Block } from "../agent/display";
import { Grid } from "../grid/Grid";
import { statementFromRun } from "./AnswerBlock";

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
const HTTP = /^https?:\/\//i;

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

function block(b: Block, i: number): ReactNode {
  const key = `${i}:${b.kind}`;
  switch (b.kind) {
    case "p":
      return <p key={key}>{inline(b.text)}</p>;
    case "lead":
      return (
        <div key={key} className="ans-lead">
          {inline(b.text)}
        </div>
      );
    case "list": {
      const items = b.items.map((it, j) => <li key={j}>{inline(it)}</li>);
      return b.ordered ? <ol key={key}>{items}</ol> : <ul key={key}>{items}</ul>;
    }
    case "quote":
      return <blockquote key={key}>{inline(b.text)}</blockquote>;
    case "code":
      return <pre key={key}>{b.text}</pre>;
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
