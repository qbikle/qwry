import { useEffect, useRef } from "react";
import { EditorState, Prec } from "@codemirror/state";
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  drawSelection,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import {
  autocompletion,
  completionKeymap,
  closeBrackets,
  closeBracketsKeymap,
} from "@codemirror/autocomplete";
import { bracketMatching, indentOnInput } from "@codemirror/language";
import { sql, PostgreSQL } from "@codemirror/lang-sql";
import { setDiagnostics, lintGutter } from "@codemirror/lint";
import { useState } from "react";
import { motion } from "motion/react";
import { menuIn } from "../design/springs";
import { useConnections } from "../stores/connections";
import { useResults } from "../stores/results";
import { useSettings } from "../stores/settings";
import { qwryCompletion } from "./completion/engine";
import { FnSearch } from "./FnSearch";
import { qwryHighlight, qwryTheme } from "./theme";
import "./editor.css";

export function SqlEditor() {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [fnSearch, setFnSearch] = useState(false);
  const fnInComplete = useSettings((s) => s.fnInComplete);
  const toggleFnInComplete = useSettings((s) => s.toggleFnInComplete);
  // CodeMirror's `dark` flag must match the theme, so remount on theme change
  const isDark = useSettings((s) => s.resolved === "dark");

  useEffect(() => {
    if (!hostRef.current) return;

    const runKeymap = Prec.highest(
      keymap.of([
        {
          key: "Mod-Enter",
          run: (view) => {
            // run selection when present, else whole buffer
            const sel = view.state.selection.main;
            const text = sel.empty
              ? view.state.doc.toString()
              : view.state.sliceDoc(sel.from, sel.to);
            void useResults.getState().run(text);
            return true;
          },
        },
        {
          key: "Mod-.",
          run: () => {
            void useResults.getState().cancel();
            return true;
          },
        },
        {
          key: "Mod-Shift-u",
          run: () => {
            setFnSearch(true);
            return true;
          },
        },
        {
          key: "Mod-e",
          run: (view) => {
            const sel = view.state.selection.main;
            const text = sel.empty
              ? view.state.doc.toString()
              : view.state.sliceDoc(sel.from, sel.to);
            void import("../stores/explain").then(({ useExplain }) =>
              useExplain.getState().run(text),
            );
            return true;
          },
        },
        {
          // defaultKeymap binds Mod-i to selectParentSyntax — we want inspector
          key: "Mod-i",
          run: () => {
            void import("../stores/inspector").then(({ useInspector }) =>
              useInspector.getState().toggle(),
            );
            return true;
          },
        },
      ]),
    );

    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({
        doc: useConnections.getState().sql,
        extensions: [
          runKeymap,
          lineNumbers(),
          history(),
          drawSelection(),
          highlightActiveLine(),
          highlightActiveLineGutter(),
          indentOnInput(),
          bracketMatching(),
          closeBrackets(),
          lintGutter(),
          keymap.of([
            ...closeBracketsKeymap,
            ...completionKeymap,
            ...historyKeymap,
            ...defaultKeymap,
          ]),
          sql({ dialect: PostgreSQL }),
          // grammar/highlighting from lang-sql; completion is OUR engine, which
          // reads the live schema store itself — no reconfiguration needed
          autocompletion({
            activateOnTyping: true,
            maxRenderedOptions: 50,
            override: [qwryCompletion],
          }),
          qwryTheme(isDark),
          qwryHighlight,
          EditorView.updateListener.of((u) => {
            if (u.docChanged) {
              useConnections.getState().setSql(u.state.doc.toString());
            }
          }),
        ],
      }),
    });
    viewRef.current = view;

    // reflect external sql changes (sidebar inserts, restores) into the doc
    const unsub = useConnections.subscribe((s) => {
      const doc = view.state.doc.toString();
      if (s.sql !== doc) {
        view.dispatch({
          changes: { from: 0, to: doc.length, insert: s.sql },
        });
      }
    });

    // PG error position → squiggle (only when the whole buffer was executed)
    const unsubLint = useResults.subscribe((s) => {
      const doc = view.state.doc.toString();
      const failed = s.statements.find((st) => st.error?.position != null);
      if (failed && s.executedSql === doc) {
        const pos = Math.min(failed.error!.position! - 1, doc.length - 1);
        const wordEnd = /[\w$]*/.exec(doc.slice(pos + 1))?.[0].length ?? 0;
        view.dispatch(
          setDiagnostics(view.state, [
            {
              from: Math.max(0, pos),
              to: Math.min(doc.length, pos + 1 + wordEnd),
              severity: "error",
              message: failed.error!.message,
            },
          ]),
        );
      } else {
        view.dispatch(setDiagnostics(view.state, []));
      }
    });

    return () => {
      unsub();
      unsubLint();
      view.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDark]);

  return (
    <div
      className="sql-editor-wrap"
      onContextMenu={(e) => {
        e.preventDefault();
        setMenu({ x: e.clientX, y: e.clientY });
      }}
    >
      <div ref={hostRef} className="sql-editor" />
      {menu && (
        <div
          className="ed-menu-backdrop"
          onMouseDown={(e) => e.target === e.currentTarget && setMenu(null)}
        >
          <motion.div className="ed-menu" style={{ left: menu.x, top: menu.y }} {...menuIn}>
            <button
              onClick={() => {
                setMenu(null);
                void useResults.getState().run();
              }}
            >
              Run <span className="ed-menu-hint">⌘↵</span>
            </button>
            <button
              onClick={() => {
                setMenu(null);
                setFnSearch(true);
              }}
            >
              Search functions… <span className="ed-menu-hint">⌘⇧U</span>
            </button>
            <button
              onClick={() => {
                toggleFnInComplete();
                setMenu(null);
              }}
            >
              Functions in autocomplete: {fnInComplete ? "ON" : "OFF"}
            </button>
          </motion.div>
        </div>
      )}
      {fnSearch && viewRef.current && (
        <FnSearch view={viewRef.current} onClose={() => setFnSearch(false)} />
      )}
    </div>
  );
}
