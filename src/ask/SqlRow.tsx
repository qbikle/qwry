// Collapsed SQL row (AGENT-UX section 2): one-line preview in mono; expand
// shows the query in the editor register (a read-only CodeMirror view with
// the app's SQL grammar, highlight and theme, wrapped) with `Copy SQL`
// (copyCue) and `Open in Tab` (useTabs.newTab(text, tabTitle), never
// auto-run). Both act immediately, so neither carries an ellipsis (WRITING.md
// rule 2). The expanded view, the copy and the tab all carry the SAME text:
// the statement through the user's format preset, ending in `;` (the model's
// one-liner wrapped mid-clause at 320 and pasted as a statement that did not
// end; the gate keeps the bare form, the surfaces show the finished one).

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronRight } from "lucide-react";
import { EditorState, Prec } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { PostgreSQL, sql as sqlLang } from "@codemirror/lang-sql";
import { formatSqlText } from "../editor/format";
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
/** the finished form of a statement: exactly one trailing semicolon */
export const finished = (sql: string) => `${sql.trim().replace(/;+$/, "")};`;

export function SqlRow({ sql, tabTitle, defaultOpen = false }: SqlRowProps) {
  const [open, setOpen] = useState(defaultOpen);
  const hostRef = useRef<HTMLDivElement>(null);
  const dark = useSettings((s) => s.resolved === "dark");
  const preset = useSettings((s) => s.formatPreset);
  // the finished text: formatted once the (lazy) formatter lands, bare + `;`
  // until then, so copy and the tab never wait on the import
  const [text, setText] = useState(() => finished(sql));
  useEffect(() => {
    let live = true;
    setText(finished(sql));
    void formatSqlText(sql, preset).then((out) => {
      if (live) setText(finished(out));
    });
    return () => {
      live = false;
    };
  }, [sql, preset]);

  // layout effect: the view exists before the expanded body paints, so the
  // reveal is one frame, not a blank row and then the SQL
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!open || !host) return;
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: text,
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
  }, [open, text, dark]);

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
            <button type="button" className="btnish" onClick={() => void copyCue(text)}>
              Copy SQL
            </button>
            <button
              type="button"
              className="btnish"
              onClick={() => useTabs.getState().newTab(text, tabTitle)}
            >
              Open in Tab
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
