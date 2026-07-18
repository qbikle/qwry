import { useEffect, useRef } from "react";
import { EditorState, Prec, type Extension, type Text } from "@codemirror/state";
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  drawSelection,
  placeholder,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { FORMAT_PRESETS, formatDefault, formatWithPreset, minifyBuffer } from "./format";
import {
  cteStandaloneSql,
  parseCtes,
  spanAtCursor,
  splitStatementSpans,
  updateStatementSpans,
  type ChangedRange,
  type StmtSpan,
} from "./statements";
import { Decoration, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import {
  autocompletion,
  completionKeymap,
  closeBrackets,
  closeBracketsKeymap,
} from "@codemirror/autocomplete";
import { bracketMatching, indentOnInput } from "@codemirror/language";
import { sql, PostgreSQL } from "@codemirror/lang-sql";
import { setDiagnostics, lintGutter } from "@codemirror/lint";
import {
  search,
  searchKeymap,
  openSearchPanel,
  highlightSelectionMatches,
} from "@codemirror/search";
import { useState } from "react";
import { useConnections } from "../stores/connections";
import { useExplain } from "../stores/explain";
import { useInspector } from "../stores/inspector";
import { useResults } from "../stores/results";
import { useSettings } from "../stores/settings";
import { editorFocusSignal, useTabs } from "../stores/tabs";
import { qwryCompletion } from "./completion/engine";
import { FnSearch } from "./FnSearch";
import { qwryHighlight, qwryTheme } from "./theme";
import { ContextMenu, type MenuNode } from "../app/overlay/ContextMenu";
import "./editor.css";

/** what ⌘↵ / the Run button should execute: the selection if any, else the
 * STATEMENT under the caret (Run All ⌘⇧↵ takes the whole buffer). offset =
 * where the text sits in the buffer, so error squiggles land right. Set while
 * the editor is mounted so the toolbar matches ⌘↵. */
export const editorRunText: {
  current: (() => { text: string; offset: number }) | null;
} = { current: null };

/** caret inside a CTE definition → menu entry to run just that CTE (with its
 * preceding definitions as dependencies) */
function cteMenuItem(view: EditorView): MenuNode[] {
  const pos = view.state.selection.main.head;
  const doc = view.state.doc.toString();
  const span = spanAtCursor(doc, pos);
  if (!span) return [];
  const stmt = doc.slice(span.from, span.to);
  const parsed = parseCtes(stmt);
  if (!parsed) return [];
  const rel = pos - span.from;
  const idx = parsed.ctes.findIndex((c) => rel >= c.defFrom && rel <= c.defTo);
  if (idx === -1) return [];
  const name = parsed.ctes[idx].name;
  return [
    {
      kind: "item",
      label: `Run CTE ${name} standalone`,
      onSelect: () => {
        const sql = cteStandaloneSql(stmt, parsed, idx);
        void useResults.getState().run(sql, 0);
      },
    },
  ];
}

/** clipboard → SQL fragment at the caret. Lines (and tab-separated cells)
 * become literals; values that are all plain numbers stay unquoted. */
async function smartPaste(view: EditorView, shape: "in" | "values") {
  const { readText } = await import("@tauri-apps/plugin-clipboard-manager");
  const text = (await readText().catch(() => "")) ?? "";
  const rows = text
    .split(/\r?\n/)
    .map((l) => l.split("\t").map((c) => c.trim()))
    .filter((cells) => cells.some((c) => c !== ""));
  if (rows.length === 0) return;
  const NUM = /^-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
  const flat = rows.flat().filter((c) => c !== "");
  const allNum = flat.every((c) => NUM.test(c));
  const lit = (v: string) => (allNum ? v : `'${v.replace(/'/g, "''")}'`);
  const frag =
    shape === "in"
      ? `(${flat.map(lit).join(", ")})`
      : rows.map((cells) => `(${cells.map(lit).join(", ")})`).join(",\n");
  const sel = view.state.selection.main;
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert: frag },
    selection: { anchor: sel.from + frag.length },
  });
  view.focus();
}

/** allocation-free equality between a CodeMirror rope and a string —
 * length check first, then chunk-wise compare (never materializes the doc) */
function docEqualsString(doc: Text, s: string): boolean {
  if (doc.length !== s.length) return false;
  let pos = 0;
  const iter = doc.iter();
  for (iter.next(); !iter.done; iter.next()) {
    if (!s.startsWith(iter.value, pos)) return false;
    pos += iter.value.length;
  }
  return pos === s.length;
}

/** subtle band over the statement the caret sits in — makes the ⌘↵ scope
 * visible at a glance. Only drawn when the buffer holds 2+ statements. */
const stmtScopeDeco = Decoration.line({ class: "cm-stmt-scope" });
const stmtScopePlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet = Decoration.none;
    // spans are kept incrementally — a keystroke typically re-lexes only a
    // small window around the edit. Not a hard <16ms guarantee: the final
    // span must be re-lexed to the doc end before it is trusted, so one
    // giant statement still costs O(text after the edit) per keystroke
    spans: StmtSpan[];
    lastFrom = -1;
    lastTo = -1;
    constructor(view: EditorView) {
      this.spans = splitStatementSpans(view.state.doc.toString());
      this.decorations = this.build(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged) {
        const ranges: ChangedRange[] = [];
        u.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
          ranges.push({ fromA, toA, fromB, toB });
        });
        this.spans = updateStatementSpans(this.spans, ranges, u.state.doc);
        // line layout may have moved even within an unchanged span
        this.lastFrom = -1;
        this.lastTo = -1;
        this.decorations = this.build(u.view);
      } else if (u.selectionSet) {
        this.decorations = this.build(u.view);
      }
    }
    build(view: EditorView): DecorationSet {
      const spans = this.spans;
      if (spans.length < 2) {
        this.lastFrom = -1;
        this.lastTo = -1;
        return Decoration.none;
      }
      const pos = view.state.selection.main.head;
      let span = spans[spans.length - 1];
      for (const sp of spans) {
        if (pos <= sp.to || pos < sp.from) {
          span = sp;
          break;
        }
      }
      // caret moved within the same statement — decorations still valid
      if (span.from === this.lastFrom && span.to === this.lastTo) return this.decorations;
      this.lastFrom = span.from;
      this.lastTo = span.to;
      const from = view.state.doc.lineAt(span.from).number;
      const to = view.state.doc.lineAt(span.to).number;
      // a pasted 5k-line VALUES statement must not mint 5k decorations per
      // keystroke — past this size the band adds nothing anyway
      if (to - from > 300) return Decoration.none;
      const decos = [];
      for (let l = from; l <= to; l++) {
        decos.push(stmtScopeDeco.range(view.state.doc.line(l).from));
      }
      return Decoration.set(decos);
    }
  },
  { decorations: (v) => v.decorations },
);

/** selection → it; else statement under caret; else whole buffer */
function runTarget(view: EditorView): { text: string; offset: number } {
  const sel = view.state.selection.main;
  if (!sel.empty) {
    return { text: view.state.sliceDoc(sel.from, sel.to), offset: sel.from };
  }
  const doc = view.state.doc.toString();
  const span = spanAtCursor(doc, sel.head);
  if (span) return { text: doc.slice(span.from, span.to), offset: span.from };
  return { text: doc, offset: 0 };
}

/** Query ▸ Format SQL (menu) reaches the mounted editor through this */
export const editorFormat: { current: (() => void) | null } = { current: null };

/** insert text at the caret (sidebar column double-click etc.) */
export const editorInsert: { current: ((text: string) => void) | null } = { current: null };

export function SqlEditor() {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [fnSearch, setFnSearch] = useState(false);
  const fnInComplete = useSettings((s) => s.fnInComplete);
  const toggleFnInComplete = useSettings((s) => s.toggleFnInComplete);
  // CodeMirror's `dark` flag must match the theme, so remount on theme change
  const isDark = useSettings((s) => s.resolved === "dark");
  // wrap is an extension → remount; font size flows through a CSS var (no remount)
  const wrapLines = useSettings((s) => s.wrapLines);
  const defaultPreset = useSettings((s) => s.formatPreset);

  useEffect(() => {
    if (!hostRef.current) return;

    // the exact string handed to setSql — lets the connections subscriber
    // dismiss its own echo (and every unrelated store update) by IDENTITY
    // instead of re-materializing + comparing a 2MB doc each time
    let lastSyncedSql: string | null = null;
    // whether we currently show PG-error diagnostics — a streamed result
    // arrives in many batches and each one used to dispatch a clearing
    // transaction (plus an O(doc) toString); skip when there's nothing to clear
    let hasDiags = false;

    const runKeymap = Prec.highest(
      keymap.of([
        {
          // run selection when present, else the statement under the caret
          key: "Mod-Enter",
          run: (view) => {
            const t = runTarget(view);
            void useResults.getState().run(t.text, t.offset);
            return true;
          },
        },
        {
          key: "Mod-Shift-Enter",
          run: (view) => {
            void useResults.getState().run(view.state.doc.toString(), 0);
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
          // explain mirrors ⌘↵ scope: selection, else statement under caret
          key: "Mod-e",
          run: (view) => {
            void useExplain.getState().run(runTarget(view).text);
            return true;
          },
        },
        {
          // defaultKeymap binds Mod-i to selectParentSyntax — we want inspector
          key: "Mod-i",
          run: () => {
            useInspector.getState().toggle();
            return true;
          },
        },
        { key: "Mod-Shift-f", run: formatDefault },
      ]),
    );

    const extensions: Extension[] = [
      runKeymap,
      lineNumbers(),
      history(),
      drawSelection(),
      // multi-cursor: ⌥-click adds a caret (drawSelection renders them)
      EditorState.allowMultipleSelections.of(true),
      ...(wrapLines ? [EditorView.lineWrapping] : []),
      highlightActiveLine(),
      highlightActiveLineGutter(),
      indentOnInput(),
      bracketMatching(),
      closeBrackets(),
      lintGutter(),
      // ⌘F find/replace panel (top) + highlight other occurrences of the selection
      search({ top: true }),
      highlightSelectionMatches(),
      keymap.of([
        ...closeBracketsKeymap,
        ...completionKeymap,
        ...historyKeymap,
        ...defaultKeymap,
        ...searchKeymap,
        indentWithTab,
      ]),
      sql({ dialect: PostgreSQL }),
      // grammar/highlighting from lang-sql; completion is OUR engine, which
      // reads the live schema store itself — no reconfiguration needed
      autocompletion({
        activateOnTyping: true,
        maxRenderedOptions: 50,
        override: [qwryCompletion],
      }),
      stmtScopePlugin,
      placeholder("SELECT …   —   ⌘↵ run statement · ⌘⇧↵ run all · ⌘K palette"),
      qwryTheme(isDark),
      qwryHighlight,
      EditorView.updateListener.of((u) => {
        if (u.docChanged) {
          // ONE materialization per edit — the store, the tabs mirror and the
          // echo check below all share this exact string
          const sql = u.state.doc.toString();
          lastSyncedSql = sql;
          useConnections.getState().setSql(sql);
        }
      }),
    ];
    const makeState = (doc: string) => EditorState.create({ doc, extensions });

    const view = new EditorView({
      parent: hostRef.current,
      state: makeState(useConnections.getState().sql),
    });
    viewRef.current = view;
    // ⌘T contract: land typing. A single focus() after a fresh mount is
    // UNRELIABLE in WKWebView (silently dropped when issued in the same task
    // as the mount) — retry until CM itself reports focus, ~350ms deadline.
    // ⌘T contract: land typing. The signal is consumed ONLY once focus is
    // CONFIRMED — a mount that dies before winning focus (StrictMode's dev
    // double-effect throwaway, any remount race) leaves it set for the mount
    // that actually survives. The loop halts with its own view's lifecycle.
    const claimFocus = () => {
      let tries = 20;
      const attempt = () => {
        if (editorGone) return; // this view was destroyed — a successor claims
        if (view.hasFocus) {
          editorFocusSignal.current = false; // consumed on SUCCESS only
          return;
        }
        if (tries-- <= 0) return; // give up, signal stays for a retry path
        window.focus();
        view.focus();
        requestAnimationFrame(attempt);
      };
      attempt();
    };
    let editorGone = false;
    if (editorFocusSignal.current) claimFocus();

    // ONE EditorState PER TAB. A tab switch swaps the whole state (doc,
    // selection, UNDO HISTORY) instead of replacing the document in a shared
    // state — a doc-replace lands on the shared undo stack, so ⌘Z in tab B
    // would restore tab A's SQL into B and persist it (cross-tab corruption).
    // Cache dies with this effect, so a theme remount starts states fresh.
    const tabStates = new Map<string, EditorState>();
    let currentTab = useTabs.getState().activeId;
    const unsubTabs = useTabs.subscribe((s) => {
      if (s.activeId === currentTab) {
        // same tab — just prune cached states of closed tabs
        for (const id of [...tabStates.keys()]) {
          if (!s.tabs.some((t) => t.id === id)) tabStates.delete(id);
        }
        return;
      }
      if (currentTab) tabStates.set(currentTab, view.state);
      currentTab = s.activeId;
      const next = s.tabs.find((t) => t.id === s.activeId);
      if (!next) return;
      const cached = tabStates.get(next.id);
      // stale-cache guard: the tab's sql is kept in sync with the doc while
      // active, so a mismatch means something changed it while inactive
      view.setState(
        cached && docEqualsString(cached.doc, next.sql) ? cached : makeState(next.sql),
      );
      // setState bypasses the update listener: the synced-string identity is
      // stale now, and a cached state may carry diagnostics we didn't count
      lastSyncedSql = null;
      hasDiags = true;
      // ⌘T while the editor is already mounted — same landing
      if (editorFocusSignal.current) claimFocus();
    });

    // toolbar Run/Explain read this so they honour the same scope as ⌘↵
    editorRunText.current = () => runTarget(view);
    editorFormat.current = () => formatDefault(view);
    editorInsert.current = (text) => {
      const sel = view.state.selection.main;
      view.dispatch({
        changes: { from: sel.from, to: sel.to, insert: text },
        selection: { anchor: sel.from + text.length },
      });
      view.focus();
    };

    // reflect SAME-TAB external sql changes into the doc. Tab switches are
    // handled by the state swap above (which runs first — select() sets
    // activeId before setSql — so by the time this fires the doc already
    // matches and it no-ops). This fires on EVERY connections-store update
    // (connState, txTabs, …), so the fast paths matter: identity check for
    // our own echo, then length + chunk compare — never a full toString.
    const unsub = useConnections.subscribe((s) => {
      if (s.sql === lastSyncedSql) return;
      if (docEqualsString(view.state.doc, s.sql)) {
        lastSyncedSql = s.sql;
        return;
      }
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: s.sql },
      });
    });

    // PG error position → squiggle. Works for whole-buffer runs AND
    // statement/selection runs: the executed text must still sit at its
    // recorded offset in the buffer (i.e. the user hasn't edited over it).
    // fires per streamed batch — touch the doc ONLY when there's a failure to
    // place (bounded slices, no toString) and never dispatch a no-op clear
    const unsubLint = useResults.subscribe((s) => {
      const failed = s.statements.find((st) => st.error?.position != null);
      if (failed) {
        const docLen = view.state.doc.length;
        const off = s.executedOffset ?? 0;
        const stillThere =
          s.executedSql != null &&
          off + s.executedSql.length <= docLen &&
          view.state.sliceDoc(off, off + s.executedSql.length) === s.executedSql;
        if (stillThere) {
          const pos = Math.min(off + failed.error!.position! - 1, docLen - 1);
          const wordEnd =
            /[\w$]*/.exec(view.state.sliceDoc(pos + 1, Math.min(docLen, pos + 257)))?.[0]
              .length ?? 0;
          // PG's DETAIL/HINT are often the actual answer — show them at the squiggle
          const err = failed.error!;
          const message = [
            err.message,
            err.detail ? `DETAIL: ${err.detail}` : null,
            err.hint ? `HINT: ${err.hint}` : null,
          ]
            .filter(Boolean)
            .join("\n");
          view.dispatch(
            setDiagnostics(view.state, [
              {
                from: Math.max(0, pos),
                to: Math.min(docLen, pos + 1 + wordEnd),
                severity: "error",
                message,
              },
            ]),
          );
          hasDiags = true;
          return;
        }
      }
      if (hasDiags) {
        view.dispatch(setDiagnostics(view.state, []));
        hasDiags = false;
      }
    });

    return () => {
      unsub();
      unsubLint();
      unsubTabs();
      editorGone = true; // stop any in-flight focus loop on this view
      editorRunText.current = null;
      editorFormat.current = null;
      editorInsert.current = null;
      view.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDark, wrapLines]);

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
        <ContextMenu
          point={menu}
          onClose={() => setMenu(null)}
          layerClassName="ed-menu-backdrop"
          items={[
            {
              kind: "item",
              label: "Run",
              hint: "⌘↵",
              onSelect: () => {
                const v = viewRef.current;
                if (!v) return;
                const t = runTarget(v);
                void useResults.getState().run(t.text, t.offset);
              },
            },
            ...(viewRef.current ? cteMenuItem(viewRef.current) : []),
            {
              kind: "item",
              label: "Format SQL",
              hint: "⌘⇧F",
              onSelect: () => {
                const v = viewRef.current;
                if (v) formatDefault(v);
              },
            },
            {
              kind: "submenu",
              label: "Format as…",
              items: [
                ...FORMAT_PRESETS.map(
                  (p): MenuNode => ({
                    kind: "item",
                    label: p.label,
                    hint: p.id === defaultPreset ? "default" : undefined,
                    onSelect: () => {
                      const v = viewRef.current;
                      if (v) formatWithPreset(v, p.id);
                    },
                  }),
                ),
                { kind: "sep" },
                {
                  kind: "item",
                  label: "Minify (one line)",
                  onSelect: () => {
                    const v = viewRef.current;
                    if (v) minifyBuffer(v);
                  },
                },
              ],
            },
            {
              kind: "submenu",
              label: "Paste as…",
              items: [
                {
                  kind: "item",
                  label: "IN list — ('a', 'b', …)",
                  onSelect: () => {
                    const v = viewRef.current;
                    if (v) void smartPaste(v, "in");
                  },
                },
                {
                  kind: "item",
                  label: "VALUES rows — (a, b), (c, d)",
                  onSelect: () => {
                    const v = viewRef.current;
                    if (v) void smartPaste(v, "values");
                  },
                },
              ],
            },
            {
              kind: "item",
              label: "Find / replace…",
              hint: "⌘F",
              onSelect: () => {
                const v = viewRef.current;
                if (v) {
                  openSearchPanel(v);
                }
              },
            },
            { kind: "item", label: "Search functions…", hint: "⌘⇧U", onSelect: () => setFnSearch(true) },
            { kind: "sep" },
            {
              kind: "item",
              label: `Functions in autocomplete: ${fnInComplete ? "ON" : "OFF"}`,
              onSelect: () => toggleFnInComplete(),
            },
          ]}
        />
      )}
      {fnSearch && viewRef.current && (
        <FnSearch view={viewRef.current} onClose={() => setFnSearch(false)} />
      )}
    </div>
  );
}
