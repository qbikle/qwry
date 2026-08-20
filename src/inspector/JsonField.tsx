import { useEffect, useRef } from "react";
import { EditorState, Prec, Transaction } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { history, historyKeymap } from "@codemirror/commands";
import { json } from "@codemirror/lang-json";
import { closeSearchPanel, search, searchKeymap, searchPanelOpen } from "@codemirror/search";
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

/** colorized JSON view/editor via CodeMirror: reliable colours for both
 * viewing (readOnly) and editing. */
export function JsonField({
  value,
  readOnly,
  autoFocus,
  searchable,
  onView,
  onChange,
  onSave,
  onCancel,
}: {
  value: string;
  readOnly?: boolean;
  /** focus on mount with the caret AFTER the value */
  autoFocus?: boolean;
  /** opt-in ⌘F: CM search panel + keymap (the editor's own machinery).
   *  OFF by default: RecordView/ValuePop instances must not grow a second
   *  ⌘F claim inside modals. Constant per call site (read once at mount). */
  searchable?: boolean;
  /** observe the live EditorView (null on unmount): lets the owner open
   *  the search panel from a shell-level ⌘F without reaching into the DOM */
  onView?: (view: EditorView | null) => void;
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
  const onViewRef = useRef(onView);
  onViewRef.current = onView;

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
                run: (v) => {
                  // layered close: an open search panel absorbs the first Esc
                  if (searchPanelOpen(v.state)) {
                    closeSearchPanel(v);
                    return true;
                  }
                  if (onCancelRef.current) {
                    onCancelRef.current();
                    return true;
                  }
                  // no cancel handler: decline. In modal contexts escStack
                  // claims Escape at window capture before CM ever sees it,
                  // so this path only matters for future non-overlay hosts
                  return false;
                },
              },
            ]),
          ),
          // the editor's own find machinery (search({top}) + searchKeymap):
          // ⌘F/⌘G/Esc behave identically to the SQL editor's panel
          ...(searchable ? [search({ top: true }), keymap.of(searchKeymap)] : []),
          // without history() ⌘Z falls through to the browser's contenteditable
          // undo, which mutates the DOM behind CM's back: cursor jumps, text stays
          history(),
          keymap.of(historyKeymap),
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
    onViewRef.current?.(view);
    if (autoFocus && !readOnly) {
      view.focus();
      view.dispatch({ selection: { anchor: view.state.doc.length } });
    }
    return () => {
      onViewRef.current?.(null);
      view.destroy();
      viewRef.current = null;
    };
    // recreate when read-only flips
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readOnly]);

  // reflect external value changes (cell switch / discard) without a loop.
  // addToHistory:false — an external reset isn't a user edit; ⌘Z must never
  // resurrect a discarded draft or a previous cell's value
  useEffect(() => {
    const v = viewRef.current;
    if (v && v.state.doc.toString() !== value) {
      v.dispatch({
        changes: { from: 0, to: v.state.doc.length, insert: value },
        annotations: Transaction.addToHistory.of(false),
      });
    }
  }, [value]);

  return <div className={`jsonfield${readOnly ? " ro" : ""}`} ref={host} />;
}
