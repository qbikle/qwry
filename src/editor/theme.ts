import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

export const qwryTheme = EditorView.theme(
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
    ".cm-activeLine": { backgroundColor: "rgba(255,255,255,0.03)" },
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
      boxShadow: "0 8px 24px rgba(0,0,0,0.45)",
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
  { dark: true },
);

export const qwryHighlight = syntaxHighlighting(
  HighlightStyle.define([
    { tag: t.keyword, color: "#c792ea" },
    { tag: t.operator, color: "#89ddff" },
    { tag: t.number, color: "#f78c6c" },
    { tag: t.string, color: "#c3e88d" },
    { tag: t.comment, color: "#5e6673", fontStyle: "italic" },
    { tag: t.typeName, color: "#ffcb6b" },
    { tag: t.propertyName, color: "#82aaff" },
    { tag: t.variableName, color: "#e6e9ef" },
    { tag: t.punctuation, color: "#9aa3b2" },
  ]),
);
