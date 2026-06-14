import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

// All colours come from CSS tokens so the editor follows the active theme.
// The `dark` flag still has to match the theme (it drives CodeMirror's own
// defaults), so the editor is remounted when the theme changes.
export const qwryTheme = (dark: boolean) =>
  EditorView.theme(
    {
      "&": {
        height: "100%",
        fontSize: "13px",
        backgroundColor: "var(--bg-panel)",
        color: "var(--fg)",
      },
      ".cm-content": {
        fontFamily: "var(--font-mono)",
        caretColor: "var(--accent)",
        padding: "10px 0",
      },
      ".cm-line": { padding: "0 12px" },
      "&.cm-focused": { outline: "none" },
      ".cm-cursor": { borderLeftColor: "var(--accent)" },
      "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
        backgroundColor: "var(--accent-soft) !important",
      },
      ".cm-activeLine": { backgroundColor: "var(--cm-active-line)" },
      ".cm-gutters": {
        backgroundColor: "var(--bg-panel)",
        color: "var(--fg-faint)",
        border: "none",
        fontFamily: "var(--font-mono)",
        fontSize: "11px",
      },
      ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--fg-muted)" },
      ".cm-tooltip": {
        backgroundColor: "var(--bg-raised)",
        border: "1px solid var(--border-strong)",
        borderRadius: "8px",
        overflow: "hidden",
        boxShadow: "var(--shadow-pop)",
      },
      ".cm-tooltip.cm-tooltip-autocomplete > ul": {
        fontFamily: "var(--font-mono)",
        fontSize: "12px",
        maxHeight: "260px",
      },
      ".cm-tooltip.cm-tooltip-autocomplete > ul > li": {
        padding: "3px 10px",
      },
      ".cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]": {
        backgroundColor: "var(--accent)",
        color: "white",
      },
      ".cm-completionDetail": {
        color: "var(--fg-faint)",
        fontStyle: "normal",
        marginLeft: "1em",
      },
      ".cm-completionIcon": { width: "1.2em", opacity: 0.7 },
    },
    { dark },
  );

export const qwryHighlight = syntaxHighlighting(
  HighlightStyle.define([
    { tag: t.keyword, color: "var(--syn-keyword)" },
    { tag: t.operator, color: "var(--syn-operator)" },
    { tag: t.number, color: "var(--syn-number)" },
    { tag: t.string, color: "var(--syn-string)" },
    { tag: t.comment, color: "var(--syn-comment)", fontStyle: "italic" },
    { tag: t.typeName, color: "var(--syn-type)" },
    { tag: t.propertyName, color: "var(--syn-prop)" },
    { tag: t.variableName, color: "var(--syn-var)" },
    { tag: t.punctuation, color: "var(--syn-punct)" },
  ]),
);
