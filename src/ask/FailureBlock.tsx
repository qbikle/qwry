// Failure (AGENT-UX section 7). Never a dead end (LESSONS 9): the error in
// the error register, the last SQL in an editable field, and the affordances
// per kind: `sql` gets Fix It + Open in Tab + Ask Differently; `turncap` the
// same when a query was tried, Ask Differently alone when none was; `provider`
// gets the provider's own sentence (it already says what to do next) and
// Retry, with the stated wait when there is one; `cancelled` shows `cancelled`
// in the status register and leaves the partial text in place. Errors explain
// and propose; they do not apologise.
//
// The SQL field is the app's one editor species (CodeMirror, the JsonField
// precedent): PostgreSQL highlighting through qwryHighlight, history, line
// wrapping. ⌘↩ inside it is Fix It (claimed, or the window's Run would fire
// too: the inspector's lesson); Esc hands focus back to the panel root. Every
// other chord bubbles (LESSONS 10).

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { EditorState, Prec, Transaction } from "@codemirror/state";
import { EditorView, drawSelection, keymap } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { PostgreSQL, sql as sqlLang } from "@codemirror/lang-sql";
import type { AskErrorKind } from "../agent/loop";
import { Kbd } from "../design/Kbd";
import { qwryHighlight } from "../editor/theme";

export interface FailureBlockProps {
  error: {
    kind: AskErrorKind;
    message: string;
    /** a rate-limited provider stated a wait (AGENT-UX 7); shown as
     * `try again in 20s` while it runs */
    retryAfterMs?: number;
  };
  /** the last SQL the loop tried, editable in the block; null when none ran */
  sql: string | null;
  /** turns spent, for `stopped after N turns` */
  turns: number;
  /** a run is in flight on this thread: actions disabled */
  busy: boolean;
  /** Fix It: the SQL as edited in the field */
  onFixIt: (sql: string) => void;
  onOpenInTab: (sql: string) => void;
  /** Ask Differently: the question lands back in the composer, focused */
  onAskDifferently: () => void;
  onRetry: () => void;
}

const fixTheme = EditorView.theme({
  "&": { background: "transparent", fontSize: "var(--text-sm)" },
  ".cm-content": {
    fontFamily: "var(--font-mono)",
    padding: "var(--sp-2) 0",
    caretColor: "var(--fg)",
  },
  ".cm-line": { padding: "0 var(--sp-3)" },
  "&.cm-focused": { outline: "none" },
  ".cm-cursor": { borderLeftColor: "var(--fg)" },
  ".cm-scroller": { lineHeight: "var(--lh-data)", maxHeight: "220px", overflow: "auto" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
    backgroundColor: "var(--accent-soft) !important",
  },
});

/** Postgres quotes identifiers in double quotes; inside chrome they wear mono
 * instead (WRITING.md, the data/chrome boundary) */
function withIdentifiers(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /"([^"\n]+)"/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(
      <code key={m.index} className="ask-id">
        {m[1]}
      </code>,
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** `message DETAIL: … HINT: …` as Postgres phrases it on one line */
function splitPg(message: string): { main: string; extras: { key: string; text: string }[] } {
  const parts = message.split(/\s*\b(DETAIL|HINT):\s*/);
  const main = parts[0]?.trim() ?? message;
  const extras: { key: string; text: string }[] = [];
  for (let i = 1; i + 1 < parts.length; i += 2) {
    const text = parts[i + 1].trim();
    if (text) extras.push({ key: parts[i].toLowerCase(), text });
  }
  return { main, extras };
}

function SqlField({
  value,
  onFixIt,
  onChange,
}: {
  value: string;
  onFixIt: () => void;
  onChange: (sql: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onFixItRef = useRef(onFixIt);
  onFixItRef.current = onFixIt;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

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
                  onFixItRef.current();
                  return true;
                },
              },
              {
                key: "Escape",
                run: (v) => {
                  // back to the panel root, never body: Esc and ⌘. keep scope
                  const panel = v.dom.closest<HTMLElement>(".ask-panel");
                  if (!panel) return false;
                  panel.focus({ preventScroll: true });
                  return true;
                },
              },
            ]),
          ),
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          drawSelection(),
          sqlLang({ dialect: PostgreSQL }),
          qwryHighlight,
          EditorView.lineWrapping,
          fixTheme,
          EditorView.contentAttributes.of({ "aria-label": "SQL to fix" }),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) onChangeRef.current(u.state.doc.toString());
          }),
        ],
      }),
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // the view lives as long as the block; `value` resets go through dispatch
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // a new last attempt replaces the field's text; not a user edit, so it is
  // kept out of the undo history
  useEffect(() => {
    const v = viewRef.current;
    if (v && v.state.doc.toString() !== value) {
      v.dispatch({
        changes: { from: 0, to: v.state.doc.length, insert: value },
        annotations: Transaction.addToHistory.of(false),
      });
    }
  }, [value]);

  return <div className="ans-fixsql" ref={host} />;
}

/** `try again in 20s`, counting down from when the block appeared; gone once
 * the wait has passed (a stale countdown is a false message, LESSONS 9) */
function useRetryWait(retryAfterMs: number | undefined): string | null {
  const [mountedAt] = useState(() => Date.now());
  const [now, setNow] = useState(mountedAt);
  const remaining = retryAfterMs === undefined ? 0 : retryAfterMs - (now - mountedAt);
  useEffect(() => {
    if (remaining <= 0) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [remaining > 0]); // eslint-disable-line react-hooks/exhaustive-deps
  if (remaining <= 0) return null;
  return `try again in ${Math.ceil(remaining / 1000)}s`;
}

export function FailureBlock({
  error,
  sql,
  turns,
  busy,
  onFixIt,
  onOpenInTab,
  onAskDifferently,
  onRetry,
}: FailureBlockProps) {
  const [edited, setEdited] = useState<string>(sql ?? "");
  // a new last attempt (Fix It failed again) becomes the field's text
  useEffect(() => {
    setEdited(sql ?? "");
  }, [sql]);
  const wait = useRetryWait(error.kind === "provider" ? error.retryAfterMs : undefined);
  const pg = useMemo(() => splitPg(error.message), [error.message]);

  if (error.kind === "cancelled") {
    return (
      <div className="ans-status" role="status">
        cancelled
      </div>
    );
  }

  const canFix = !busy && edited.trim() !== "";
  const fixIt = () => {
    if (canFix) onFixIt(edited);
  };

  if (error.kind === "provider") {
    return (
      <>
        <div className="ans-fail" role="alert">
          <div className="ans-fail-title">stopped</div>
          <div className="ans-fail-msg">{withIdentifiers(error.message)}</div>
        </div>
        <div className="ans-acts">
          <button className="btnish primary" disabled={busy} onClick={onRetry}>
            Retry
          </button>
          {wait && <span className="ans-status">{wait}</span>}
        </div>
      </>
    );
  }

  const isCap = error.kind === "turncap";
  const title = isCap
    ? error.message
    : turns > 0
      ? `stopped after ${turns} ${turns === 1 ? "turn" : "turns"}`
      : "query failed";

  return (
    <>
      <div className="ans-fail" role="alert">
        <div className="ans-fail-title">{title}</div>
        <div className="ans-fail-msg">
          {isCap
            ? "the turn cap ended the run before the model settled on an answer"
            : withIdentifiers(pg.main)}
        </div>
        {!isCap &&
          pg.extras.map((x) => (
            <div key={x.key} className="ans-fail-detail">
              <span className="ans-fail-detail-k">{x.key}</span>
              <span>{withIdentifiers(x.text)}</span>
            </div>
          ))}
      </div>

      {sql !== null && <SqlField value={sql} onFixIt={fixIt} onChange={setEdited} />}

      <div className="ans-acts">
        {sql !== null && (
          <button className="btnish primary" disabled={!canFix} onClick={fixIt}>
            Fix It <Kbd chord="cmd+return" />
          </button>
        )}
        {sql !== null && (
          <button className="btnish" disabled={busy} onClick={() => onOpenInTab(edited.trim() || sql)}>
            Open in Tab
          </button>
        )}
        <button className="btnish" disabled={busy} onClick={onAskDifferently}>
          Ask Differently
        </button>
      </div>
    </>
  );
}
