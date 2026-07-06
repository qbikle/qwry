import { useEffect, useRef } from "react";
import { EditorState, Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { json } from "@codemirror/lang-json";
import { qwryHighlight } from "../editor/theme";
import "./inspector.css";

const jsonTheme = EditorView.theme({
  "&": { background: "transparent", fontSize: "var(--text-sm)" },
  ".cm-content": {
    fontFamily: "var(--font-mono)",
    padding: "8px 0",
    caretColor: "var(--fg)",
  },
  ".cm-line": { padding: "0 10px" },
  "&.cm-focused": { outline: "none" },
  ".cm-cursor": { borderLeftColor: "var(--fg)" },
  ".cm-scroller": { lineHeight: "1.55" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
    backgroundColor: "var(--accent-soft) !important",
  },
});

/** colorized JSON view/editor via CodeMirror — reliable colours for both
 * viewing (readOnly) and editing. */
export function JsonField({
  value,
  readOnly,
  autoFocus,
  onChange,
  onSave,
  onCancel,
}: {
  value: string;
  readOnly?: boolean;
  /** focus on mount with the caret AFTER the value */
  autoFocus?: boolean;
  onChange?: (v: string) => void;
  onSave?: () => void;
  onCancel?: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;

  useEffect(() => {
    if (!host.current) return;
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          Prec.highest(
            keymap.of([
              {
                key: "Mod-Enter",
                run: () => {
                  onSaveRef.current?.();
                  return true;
                },
              },
              {
                key: "Escape",
                run: () => {
                  onCancelRef.current?.();
                  return true;
                },
              },
            ]),
          ),
          json(),
          qwryHighlight,
          EditorView.lineWrapping,
          EditorState.readOnly.of(!!readOnly),
          EditorView.editable.of(!readOnly),
          jsonTheme,
          EditorView.updateListener.of((u) => {
            if (u.docChanged) onChangeRef.current?.(u.state.doc.toString());
          }),
        ],
      }),
    });
    viewRef.current = view;
    if (autoFocus && !readOnly) {
      view.focus();
      view.dispatch({ selection: { anchor: view.state.doc.length } });
    }
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // recreate when read-only flips
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readOnly]);

  // reflect external value changes (cell switch / discard) without a loop
  useEffect(() => {
    const v = viewRef.current;
    if (v && v.state.doc.toString() !== value) {
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } });
    }
  }, [value]);

  return <div className={`jsonfield${readOnly ? " ro" : ""}`} ref={host} />;
}
