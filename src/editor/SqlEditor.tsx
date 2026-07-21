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
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
  isolateHistory,
} from "@codemirror/commands";
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
  completionStatus,
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
import { History } from "lucide-react";
import * as ipc from "../ipc/commands";
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

// run/format/time-travel registries live in editorBus.ts so the shell can
// read them without pulling this (CodeMirror-heavy, lazily loaded) module
export { editorRunText, editorFormat, editorTimeTraveling } from "./editorBus";
import { editorRunText, editorFormat, editorTimeTraveling } from "./editorBus";

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
      label: "Run CTE Standalone",
      hint: name,
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

/** appdb timestamps are UTC "YYYY-MM-DD HH:MM:SS" (datetime('now')) — render
 * as a local wall-clock time for the time-machine banner; snapshots from
 * another day carry the date (a bare "14:03" would read as today's) */
function snapTime(ts: string): string {
  const d = new Date(ts.endsWith("Z") ? ts : ts.replace(" ", "T") + "Z");
  if (isNaN(d.getTime())) return ts;
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) return time;
  const date = d.toLocaleDateString([], {
    month: "short",
    day: "numeric",
    ...(d.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}),
  });
  return `${date}, ${time}`;
}

/** insert text at the caret (sidebar column double-click etc.) */
export const editorInsert: { current: ((text: string) => void) | null } = { current: null };

export function SqlEditor() {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [fnSearch, setFnSearch] = useState(false);
  // buffer time-machine banner: non-null while a past run is shown read-only
  const [tt, setTt] = useState<{ time: string; pos: number; count: number } | null>(null);
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

    // ------------------------------------------------------------------
    // Buffer time-machine (⌃⌘←/→). While viewing, the LIVE EditorState is
    // parked in ttState.draftState (doc + selection + undo history) and the
    // view shows a throwaway READ-ONLY state per snapshot — swaps go through
    // setState, which bypasses the update listener, so a snapshot can never
    // leak into the sql store / tab persistence. Enter restores the snapshot
    // as ONE undoable transaction; Esc returns the parked state untouched.
    let ttState: {
      snaps: ipc.BufferSnapshot[];
      idx: number;
      draftState: EditorState;
    } | null = null;

    // ⌥↑/⌥↓ quick history walk (psql). Slot 0 = the live draft; i>=1 maps to
    // snaps[i-1] (newest-first). Unlike the time-machine this REPLACES the
    // buffer per step (each an undoable tx) — no banner, no read-only.
    let walk: { snaps: string[]; idx: number; draft: string } | null = null;
    let walkDispatching = false;

    const showSnap = (view: EditorView) => {
      const t = ttState!;
      const snap = t.snaps[t.idx];
      view.setState(
        EditorState.create({
          doc: snap.sql,
          extensions: [extensions, EditorState.readOnly.of(true)],
        }),
      );
      // setState bypasses the update listener — same discipline as tab switch
      lastSyncedSql = null;
      hasDiags = true;
      editorTimeTraveling.current = true;
      setTt({ time: snapTime(snap.taken_at), pos: t.idx + 1, count: t.snaps.length });
      view.focus();
    };

    /** never-lose-work: a live draft about to be replaced by history text
     * (⏎-restore, ⌥-walk leaving slot 0, a walk killed mid-cycle) joins the
     * snapshot trail first — same trail the feature exists to provide. The
     * appdb layer dedupes, so a draft equal to the newest snapshot no-ops. */
    const parkDraft = (tabId: string | null, draft: string, newestSnap: string | undefined) => {
      if (!tabId || draft.trim() === "" || draft === newestSnap) return;
      void ipc
        .bufferSnapshotAdd(tabId, draft)
        .catch((e) => console.error("buffer_snapshot_add failed", e));
    };

    /** leave time-travel, restoring the parked live state. `apply` then lays
     * the viewed snapshot over the live buffer as one undoable tx (⌘Z works) */
    const exitTimeTravel = (view: EditorView, apply: boolean) => {
      const t = ttState;
      if (!t) return;
      ttState = null;
      editorTimeTraveling.current = false;
      setTt(null);
      view.setState(t.draftState);
      lastSyncedSql = null;
      hasDiags = true;
      if (apply) {
        // the live draft is about to be overwritten through the store — park
        // it in the trail FIRST so ⏎-restore can never lose a never-run draft
        parkDraft(
          useTabs.getState().activeId,
          t.draftState.doc.toString(),
          t.snaps[0]?.sql,
        );
        const sql = t.snaps[t.idx].sql;
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: sql },
          selection: { anchor: sql.length },
          annotations: isolateHistory.of("full"),
          scrollIntoView: true,
        });
      } else {
        // safety net: an external setSql that landed while viewing must win
        // over the parked draft (the store subscriber was suspended)
        const storeSql = useConnections.getState().sql;
        if (!docEqualsString(view.state.doc, storeSql)) {
          view.dispatch({
            changes: { from: 0, to: view.state.doc.length, insert: storeSql },
          });
        }
      }
      view.focus();
    };

    const ttStepBack = (view: EditorView): boolean => {
      walk = null; // the two steppers never interleave
      if (ttState) {
        if (ttState.idx + 1 < ttState.snaps.length) {
          ttState.idx++;
          showSnap(view);
        }
        return true;
      }
      const tabId = useTabs.getState().activeId;
      if (!tabId) return true;
      const draftState = view.state;
      void ipc
        .bufferSnapshotsList(tabId)
        .then((snaps) => {
          // stale press: anything moved meanwhile (typing, tab switch, a
          // second ⌃⌘← that already entered) — drop it
          if (editorGone || ttState || view.state !== draftState) return;
          if (useTabs.getState().activeId !== tabId) return;
          // the newest snapshot usually IS the current buffer (it just ran) —
          // start at the first one that differs
          let idx = 0;
          while (idx < snaps.length && docEqualsString(draftState.doc, snaps[idx].sql)) idx++;
          if (idx >= snaps.length) return; // no older version to show
          ttState = { snaps, idx, draftState };
          showSnap(view);
        })
        .catch((e) => console.error("buffer_snapshots_list failed", e));
      return true;
    };

    const ttStepFwd = (view: EditorView): boolean => {
      if (!ttState) return false;
      if (ttState.idx === 0) {
        exitTimeTravel(view, false); // forward past the newest = back to live
      } else {
        ttState.idx--;
        showSnap(view);
      }
      return true;
    };

    // ⌥↑ STARTS a walk only when the caret sits at the absolute doc start,
    // nothing is selected, no completion popup is open, and the buffer is a
    // single statement or ≤10 lines (whole scripts are protected — the keys
    // fall through to moveLine there). Mid-walk only the selection/completion
    // gates apply, so repeated presses cycle without re-homing the caret.
    const walkGateOk = (view: EditorView): boolean =>
      view.state.selection.main.empty && completionStatus(view.state) === null;

    const walkTextAt = (i: number): string => (i === 0 ? walk!.draft : walk!.snaps[i - 1]);

    const walkStep = (view: EditorView, delta: 1 | -1) => {
      const w = walk;
      if (!w) return;
      // skip entries identical to what's shown (list dedupe is only
      // consecutive; the draft often equals the newest snapshot)
      const cur = view.state.doc;
      let i = w.idx + delta;
      while (i >= 0 && i <= w.snaps.length && docEqualsString(cur, walkTextAt(i))) i += delta;
      if (i < 0 || i > w.snaps.length) return;
      w.idx = i;
      const text = walkTextAt(i);
      walkDispatching = true;
      try {
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: text },
          selection: { anchor: text.length },
          annotations: isolateHistory.of("full"),
          scrollIntoView: true,
        });
      } finally {
        walkDispatching = false;
      }
    };

    const walkStart = (view: EditorView) => {
      const tabId = useTabs.getState().activeId;
      if (!tabId) return;
      const startState = view.state;
      void ipc
        .bufferSnapshotsList(tabId)
        .then((snaps) => {
          if (editorGone || walk || ttState || view.state !== startState) return;
          if (useTabs.getState().activeId !== tabId) return;
          if (snaps.length === 0) return;
          const draft = startState.doc.toString();
          const w = { snaps: snaps.map((s) => s.sql), idx: 0, draft };
          walk = w;
          walkStep(view, 1);
          if (w.idx === 0) {
            walk = null; // nothing older that differs
          } else {
            // slot 0 was left: the draft now lives only in walk RAM and each
            // step REPLACES the buffer through the store — park it first
            parkDraft(tabId, draft, w.snaps[0]);
          }
        })
        .catch((e) => console.error("buffer_snapshots_list failed", e));
    };

    const runKeymap = Prec.highest(
      keymap.of([
        {
          // run selection when present, else the statement under the caret.
          // Swallowed while time-traveling — the banner owns Enter/Esc there
          // and running the VIEWED text would be a silent foot-gun.
          key: "Mod-Enter",
          run: (view) => {
            if (ttState) return true;
            walk = null; // a run ends the ⌥↑ cycle (psql-style)
            const t = runTarget(view);
            void useResults.getState().run(t.text, t.offset);
            return true;
          },
        },
        {
          key: "Mod-Shift-Enter",
          run: (view) => {
            if (ttState) return true;
            walk = null;
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
            if (ttState) return true; // FnSearch inserts into the buffer
            setFnSearch(true);
            return true;
          },
        },
        {
          // explain mirrors ⌘↵ scope: selection, else statement under caret
          key: "Mod-e",
          run: (view) => {
            if (ttState) return true;
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
        {
          // format dispatches straight to the doc — must not touch a snapshot
          key: "Mod-Shift-f",
          run: (view) => {
            if (!ttState) void formatDefault(view);
            return true;
          },
        },
        // ---- buffer time-machine ----
        { key: "Ctrl-Cmd-ArrowLeft", run: ttStepBack },
        { key: "Ctrl-Cmd-ArrowRight", run: ttStepFwd },
        {
          key: "Enter",
          run: (view) => {
            if (!ttState) return false;
            exitTimeTravel(view, true); // restore = one undoable transaction
            return true;
          },
        },
        {
          key: "Escape",
          run: (view) => {
            if (!ttState) return false;
            exitTimeTravel(view, false); // back to the live buffer untouched
            return true;
          },
        },
        // ---- ⌥↑/⌥↓ in-editor history stepping (psql muscle memory) ----
        {
          key: "Alt-ArrowUp",
          run: (view) => {
            if (ttState) return true;
            if (!walkGateOk(view)) return false;
            if (walk) {
              walkStep(view, 1);
              return true;
            }
            if (view.state.selection.main.head !== 0) return false;
            if (
              view.state.doc.lines > 10 &&
              splitStatementSpans(view.state.doc.toString()).length > 1
            )
              return false;
            walkStart(view);
            return true;
          },
        },
        {
          key: "Alt-ArrowDown",
          run: (view) => {
            if (ttState) return true;
            if (!walkGateOk(view)) return false;
            if (walk) {
              walkStep(view, -1);
              return true;
            }
            // dead walk: it leaves the caret at the doc END, where another ⌥↓
            // used to fall through to moveLineDown — a silent line reorder
            // where the user expected history nav. At the end edge (where
            // moveLineDown is a no-op anyway) restart the walk instead; the
            // start edge stays with moveLineDown, which is real editing there.
            if (view.state.selection.main.head !== view.state.doc.length) return false;
            if (
              view.state.doc.lines > 10 &&
              splitStatementSpans(view.state.doc.toString()).length > 1
            )
              return false;
            walkStart(view); // no-ops when no snapshots exist
            return true;
          },
        },
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
          // a real edit invalidates the ⌥↑ walk (its draft slot went stale);
          // our own walk steps survive via the flag
          if (walk && !walkDispatching) walk = null;
          // belt: a read-only snapshot view must NEVER flow into the store —
          // doc changes can't normally happen there, but a leak would persist
          // snapshot text over the user's live buffer
          if (ttState) return;
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
      // a tab switch mid-time-travel parks the OLD tab's LIVE state (never
      // the read-only viewing state); the ⌥↑ walk dies with tab focus
      const parked = ttState ? ttState.draftState : view.state;
      if (ttState) {
        ttState = null;
        editorTimeTraveling.current = false;
        setTt(null);
      }
      // a walk killed away from slot 0 holds its draft ONLY in RAM (the
      // buffer + store show a snapshot) — park it before it dies
      if (walk && walk.idx !== 0) parkDraft(currentTab, walk.draft, walk.snaps[0]);
      walk = null;
      if (currentTab) tabStates.set(currentTab, parked);
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

    // toolbar Run/Explain read this so they honour the same scope as ⌘↵.
    // While time-traveling they see an empty target (run/explain no-op on
    // blank sql) — the mouse paths must not execute the VIEWED snapshot.
    editorRunText.current = () => (ttState ? { text: "", offset: 0 } : runTarget(view));
    editorFormat.current = () => {
      if (!ttState) void formatDefault(view);
    };
    editorInsert.current = (text) => {
      if (ttState) return; // snapshots are read-only
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
      // viewing a snapshot: the live buffer is parked in ttState.draftState —
      // reflecting store sql into the READ-ONLY view would clobber the
      // snapshot; exitTimeTravel reconciles any external change on the way out
      if (ttState) return;
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
      // theme/wrap remount starts outside time-travel (the live buffer is in
      // the tab store; the fresh mount rebuilds from it)
      ttState = null;
      editorTimeTraveling.current = false;
      // a walk killed by the remount away from slot 0: same RAM-only draft
      if (walk && walk.idx !== 0) parkDraft(currentTab, walk.draft, walk.snaps[0]);
      walk = null;
      setTt(null);
      editorRunText.current = null;
      editorFormat.current = null;
      editorInsert.current = null;
      view.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDark, wrapLines]);

  return (
    <div
      className={`sql-editor-wrap${tt ? " tt-viewing" : ""}`}
      onContextMenu={(e) => {
        e.preventDefault();
        // the menu's actions (run/format/paste) all target the live buffer —
        // suppress it while a read-only snapshot is shown
        if (!tt) setMenu({ x: e.clientX, y: e.clientY });
      }}
    >
      <div ref={hostRef} className="sql-editor" />
      {tt && (
        <div className="tt-banner" role="status">
          <span className="tt-glyph">
            <History size={12} />
          </span>
          viewing run from {tt.time}
          <span className="tt-pos">
            {tt.pos}/{tt.count}
          </span>
          <span className="tt-hint">⏎ restores · esc returns · ⌃⌘←→ step</span>
        </div>
      )}
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
                if (v) void formatDefault(v);
              },
            },
            {
              kind: "submenu",
              label: "Format As",
              items: [
                ...FORMAT_PRESETS.map(
                  (p): MenuNode => ({
                    kind: "item",
                    label: p.label,
                    hint: p.id === defaultPreset ? "default" : undefined,
                    onSelect: () => {
                      const v = viewRef.current;
                      if (v) void formatWithPreset(v, p.id);
                    },
                  }),
                ),
                { kind: "sep" },
                {
                  kind: "item",
                  label: "Minify",
                  hint: "one line",
                  onSelect: () => {
                    const v = viewRef.current;
                    if (v) minifyBuffer(v);
                  },
                },
              ],
            },
            {
              kind: "submenu",
              label: "Paste As",
              items: [
                {
                  kind: "item",
                  label: "IN List",
                  hint: "('a', 'b', …)",
                  onSelect: () => {
                    const v = viewRef.current;
                    if (v) void smartPaste(v, "in");
                  },
                },
                {
                  kind: "item",
                  label: "VALUES Rows",
                  hint: "(a, b), (c, d)",
                  onSelect: () => {
                    const v = viewRef.current;
                    if (v) void smartPaste(v, "values");
                  },
                },
              ],
            },
            {
              kind: "item",
              label: "Find and Replace…",
              hint: "⌘F",
              onSelect: () => {
                const v = viewRef.current;
                if (v) {
                  openSearchPanel(v);
                }
              },
            },
            { kind: "item", label: "Search Functions…", hint: "⌘⇧U", onSelect: () => setFnSearch(true) },
            { kind: "sep" },
            {
              kind: "item",
              label: `Functions in Autocomplete: ${fnInComplete ? "On" : "Off"}`,
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
