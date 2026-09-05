// Collapsed SQL row (AGENT-UX section 2, item 4): one-line preview in mono;
// expand shows the query in the editor register (a read-only CodeMirror view
// with the app's SQL grammar, highlight and theme, wrapped) with `Copy SQL`
// (copyCue) and `Open in Tab` (useTabs.newTab(sql, tabTitle), never auto-run).
// Both act immediately, so neither carries an ellipsis (WRITING.md rule 2).

import { useLayoutEffect, useRef, useState } from "react";
import { ChevronRight } from "lucide-react";
import { EditorState, Prec } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { PostgreSQL, sql as sqlLang } from "@codemirror/lang-sql";
import { qwryHighlight, qwryTheme } from "../editor/theme";
import { copyCue } from "../lib/copyCue";
import { useSettings } from "../stores/settings";
import { useTabs } from "../stores/tabs";

export interface SqlRowProps {
  sql: string;
  /** the query tab's name when opened (the thread title, capped) */
  tabTitle: string;
  defaultOpen?: boolean;
}

// the row's surface over the editor theme: auto height, the answer's data
// size, the panel showing through (the row itself draws the border)
const rowTheme = EditorView.theme({
  "&": { height: "auto", fontSize: "var(--text-sm)", backgroundColor: "transparent" },
  ".cm-content": { padding: "8px 0" },
  ".cm-line": { padding: "0 12px" },
  ".cm-scroller": { lineHeight: "var(--lh-data)" },
});

const preview = (sql: string) => sql.replace(/\s+/g, " ").trim();

export function SqlRow({ sql, tabTitle, defaultOpen = false }: SqlRowProps) {
  const [open, setOpen] = useState(defaultOpen);
  const hostRef = useRef<HTMLDivElement>(null);
  const dark = useSettings((s) => s.resolved === "dark");

  // layout effect: the view exists before the expanded body paints, so the
  // reveal is one frame, not a blank row and then the SQL
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!open || !host) return;
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: sql,
        extensions: [
          sqlLang({ dialect: PostgreSQL }),
          qwryHighlight,
          qwryTheme(dark),
          Prec.high(rowTheme),
          EditorView.lineWrapping,
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
        ],
      }),
    });
    return () => view.destroy();
  }, [open, sql, dark]);

  return (
    <div className={`ans-sql${open ? " open" : ""}`}>
      <button
        type="button"
        className="ans-sql-head"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <ChevronRight size={12} className="ans-sql-chev" />
        <span>SQL</span>
        <code>{preview(sql)}</code>
      </button>
      {open && (
        <div className="ans-sql-body">
          <div ref={hostRef} className="ans-sql-code" />
          <div className="ans-sql-actions">
            <button type="button" className="btnish" onClick={() => void copyCue(sql)}>
              Copy SQL
            </button>
            <button
              type="button"
              className="btnish"
              onClick={() => useTabs.getState().newTab(sql, tabTitle)}
            >
              Open in Tab
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
