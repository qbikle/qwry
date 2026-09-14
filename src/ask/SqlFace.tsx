// The app's ONE read-only SQL surface: a CodeMirror view in the editor's own
// grammar, highlight and theme. Two places show a statement nobody may type
// into, and they are the same species (DESIGN rule 1): the result block's SQL
// face, and a `sql` fence in the answer's prose that no run on screen owns
// (AGENT-UX section 2c). They differ only in the box around them, which is why
// the theme is a parameter and nothing else is.
//
// Its own file rather than ResultBlock's, because ResultBlock renders
// AnswerText and AnswerText renders this: one import each way is a cycle.
import { useLayoutEffect, useRef } from "react";
import { EditorState, Prec } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { PostgreSQL, sql as sqlLang } from "@codemirror/lang-sql";
import { qwryHighlight, qwryTheme } from "../editor/theme";
import { useSettings } from "../stores/settings";

/** the block's face: auto height, the answer's data size, the block showing
 * through (the block draws the border and the corners) */
const blockTheme = EditorView.theme({
  "&": { height: "auto", fontSize: "var(--text-sm)", backgroundColor: "transparent" },
  ".cm-content": { padding: "8px 0" },
  ".cm-line": { padding: "0 12px" },
  ".cm-scroller": { lineHeight: "var(--lh-data)" },
});

/** and prose's: the editor's own inset and the answer's own data size, since
 * a code block in the answer is the editor's face exactly (D2 item 7) and the
 * plain `pre` beside it is at --text-md. The box around it is ask.css's
 * `.ans-sql`, so this stays transparent here too */
const proseTheme = EditorView.theme({
  "&": { height: "auto", fontSize: "var(--text-md)", backgroundColor: "transparent" },
  ".cm-content": { padding: "10px 0" },
  ".cm-line": { padding: "0 12px" },
  ".cm-scroller": { lineHeight: "var(--lh-data)" },
});

/** the read-only view of the statement, in the app's own SQL grammar,
 * highlight and theme, wrapped so the floor never scrolls it sideways */
export function SqlFace({ text, variant = "block" }: { text: string; variant?: "block" | "prose" }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const dark = useSettings((s) => s.resolved === "dark");
  // layout effect: the view exists before the face paints, so the flip is one
  // frame, not an empty box and then the SQL
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: text,
        extensions: [
          sqlLang({ dialect: PostgreSQL }),
          qwryHighlight,
          qwryTheme(dark),
          Prec.high(variant === "prose" ? proseTheme : blockTheme),
          EditorView.lineWrapping,
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
        ],
      }),
    });
    return () => view.destroy();
  }, [text, dark, variant]);
  return <div ref={hostRef} className="rb-sql" />;
}
