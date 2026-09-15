// Threads sheet (AGENT-UX section 1, the header's `Threads`): slides over the
// thread inside the pane, the trace drawer's species and geometry, and lists
// every thread of the connection, one row each: title · when it started ·
// a delete that shows on hover, on the hot row and when focused. `Delete
// All…` sits in the header (soft-danger species; the ellipsis is earned, a
// confirm follows). A row opens its thread and closes the sheet; a delete
// goes through the app's danger confirm; deleting the current thread selects
// the newest that remains, and the last delete leaves the pane's empty state.
//
// Focus (AGENT-UX 12, LESSONS 7): like the trace, a non-modal panel INSIDE
// the pane, so no escStack (⌘J, ⌘W and every window chord keep working).
// The list is a listbox that holds focus; `.hot` is the state-owned roving
// highlight (aria-activedescendant), so the rows themselves are never
// focused and the DOM never owns position. A scoped keydown on the sheet
// root owns exactly what the sheet needs: ↑↓ move the highlight, ↩ opens it,
// ⌫ deletes it (through the same confirm), Esc closes, Tab wraps inside;
// every chord bubbles (LESSONS 10). On open focus moves to the list (the root
// when there is nothing to list); on close it returns to the header's Threads
// button, else to the panel root. No native tooltips on the row controls
// (unreliable in WKWebView): aria-labels name them.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { ArrowLeft, Trash2 } from "lucide-react";
import type { Thread } from "../agent/types";
import { copyCueShow } from "../lib/copyCue";
import { useAgent } from "../stores/agent";
import { useAsk } from "../stores/ask";
import { revealRow } from "./revealRow";
import { threadTime } from "./threadTime";
import "./threads.css";

export interface ThreadsSheetProps {
  profileId: string;
  open: boolean;
  onClose: () => void;
}

const NO_THREADS: Thread[] = [];

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

const rowId = (id: string) => `trow-${id}`;

/** the newest of what remains, by start time; null when nothing does */
function newest(list: Thread[]): Thread | null {
  let best: Thread | null = null;
  for (const t of list) if (!best || t.createdAt > best.createdAt) best = t;
  return best;
}

export function ThreadsSheet({ profileId, open, onClose }: ThreadsSheetProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const threads = useAgent((s) => s.threads[profileId]) ?? NO_THREADS;
  const currentId = useAgent((s) => s.activeThread[profileId] ?? null);

  // the clock is read once per opening: a row's `3h ago` is what it was when
  // the sheet came up, never re-ticking under the pointer
  const now = useMemo(() => new Date(), [open]);

  // ---- the roving highlight ----
  const [hot, setHot] = useState(0);
  const hotIndex = threads.length === 0 ? -1 : Math.min(hot, threads.length - 1);
  const hotThread = hotIndex >= 0 ? threads[hotIndex] : null;

  // ---- open / close: capture the opener, return focus to the Threads button ----
  const openerRef = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open) {
      if (!wasOpen.current) {
        const ae = document.activeElement;
        openerRef.current = ae instanceof HTMLElement ? ae : null;
        // the highlight starts on the current thread, else on the newest
        const cur = threads.findIndex((t) => t.id === currentId);
        setHot(cur >= 0 ? cur : 0);
      }
      wasOpen.current = true;
      // synchronous: the list is committed and `.open` already applied, and a
      // deferred focus can land after the next keystroke
      const list = listRef.current;
      const target = list && threads.length > 0 ? list : rootRef.current;
      target?.focus({ preventScroll: true });
      return;
    }
    if (!wasOpen.current) return;
    wasOpen.current = false;
    const opener = openerRef.current;
    openerRef.current = null;
    const id = requestAnimationFrame(() => {
      // the card is collapsing: App.tsx owns that focus restore
      if (!useAsk.getState().open) return;
      const root = rootRef.current;
      const ae = document.activeElement;
      const inside = !!root && root.contains(ae);
      // an action that deliberately focused something else on close wins
      if (ae && ae !== document.body && !inside) return;
      const panel = root?.closest<HTMLElement>(".ask-panel") ?? null;
      const button =
        panel?.querySelector<HTMLElement>('.ask-head [aria-label="Threads"], .ask-head [title="Threads"]') ??
        null;
      const target =
        button && !button.matches(":disabled")
          ? button
          : opener && opener.isConnected && !root?.contains(opener)
            ? opener
            : panel;
      target?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(id);
    // the highlight seed reads the list as it was when the sheet opened
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // the hot row stays in view as the keyboard moves it: instant, never
  // animated (the scroller belongs to the user)
  useEffect(() => {
    if (!open || !hotThread) return;
    const list = listRef.current;
    revealRow(list, list?.querySelector<HTMLElement>(`[id="${rowId(hotThread.id)}"]`) ?? null);
  }, [open, hotThread]);

  // ---- actions ----
  const openRow = useCallback(
    (t: Thread) => {
      if (t.id !== currentId) void useAgent.getState().openThread(profileId, t.id);
      onClose();
    },
    [currentId, onClose, profileId],
  );

  const deleteRow = useCallback(
    async (t: Thread) => {
      const { confirmDanger } = await import("../stores/danger");
      const ok = await confirmDanger(
        "Delete This Thread?",
        "Its questions and answers leave the history on this Mac.",
        "Delete Thread",
      );
      if (!ok) return;
      const wasCurrent = useAgent.getState().activeThread[profileId] === t.id;
      try {
        await useAgent.getState().deleteThread(profileId, t.id);
      } catch {
        // the row stays; the cue toast is the app's one failure flash for
        // an action with no pane of its own (the export precedent)
        copyCueShow("delete failed");
        return;
      }
      const agent = useAgent.getState();
      const rest = agent.threads[profileId] ?? NO_THREADS;
      if (wasCurrent) {
        const next = newest(rest);
        if (next) void agent.openThread(profileId, next.id);
      }
      if (rest.length === 0) onClose();
    },
    [onClose, profileId],
  );

  const deleteAll = useCallback(async () => {
    const { confirmDanger } = await import("../stores/danger");
    const ok = await confirmDanger(
      "Delete All Threads?",
      "Every question and answer for this connection leaves the history on this Mac.",
      "Delete All",
    );
    if (!ok) return;
    try {
      await useAgent.getState().deleteAllThreads(profileId);
    } catch {
      copyCueShow("delete failed");
    }
    if ((useAgent.getState().threads[profileId] ?? NO_THREADS).length === 0) onClose();
  }, [onClose, profileId]);

  // ---- keyboard ----
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!open) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return; // chords belong to the window
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }
    const root = rootRef.current;
    if (!root) return;
    const target = e.target as HTMLElement;
    // the list's keys act only while the list (or the sheet root) has focus:
    // ↩ on the Back or Delete All button is that button's own
    const inList = target === root || target === listRef.current || !!target.closest(".threads-list");
    if (inList && threads.length > 0) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        const dir = e.key === "ArrowDown" ? 1 : -1;
        setHot((hotIndex + dir + threads.length) % threads.length);
        listRef.current?.focus({ preventScroll: true });
        return;
      }
      if (e.key === "Home" || e.key === "End") {
        e.preventDefault();
        e.stopPropagation();
        setHot(e.key === "Home" ? 0 : threads.length - 1);
        return;
      }
      if (e.key === "Enter" && hotThread) {
        e.preventDefault();
        e.stopPropagation();
        openRow(hotThread);
        return;
      }
      if (e.key === "Backspace" && hotThread) {
        e.preventDefault();
        e.stopPropagation();
        void deleteRow(hotThread);
        return;
      }
    }
    // the trap owns Tab alone; every chord bubbles (LESSONS 10)
    if (e.key === "Tab") {
      const list = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (list.length === 0) {
        e.preventDefault();
        return;
      }
      const first = list[0];
      const last = list[list.length - 1];
      const active = document.activeElement;
      if (e.shiftKey) {
        if (active === first || active === root || !root.contains(active)) {
          e.preventDefault();
          last.focus({ preventScroll: true });
        }
      } else if (active === last || !root.contains(active)) {
        e.preventDefault();
        first.focus({ preventScroll: true });
      }
    }
  };

  // clicks inside the sheet keep focus in the sheet (WKWebView never focuses
  // a button on click) and never reach the panel's own click-to-focus
  const onMouseDown = (e: ReactMouseEvent<HTMLDivElement>) => {
    e.stopPropagation();
    const t = e.target as HTMLElement;
    if (t.closest("button")) return;
    (t.closest(".threads-list") ? listRef.current : rootRef.current)?.focus({ preventScroll: true });
  };

  return (
    <div
      ref={rootRef}
      className={`threads${open ? " open" : ""}`}
      role="region"
      aria-label="Threads"
      aria-hidden={!open}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onMouseDown={onMouseDown}
    >
      <header className="threads-head">
        <button className="iconbtn" aria-label="Back" onClick={onClose}>
          <ArrowLeft size={14} />
        </button>
        <span className="threads-title">Threads</span>
        <span className="ask-grow" />
        <button className="soft-danger" disabled={threads.length === 0} onClick={() => void deleteAll()}>
          Delete All…
        </button>
      </header>

      <div
        ref={listRef}
        className="threads-list"
        role="listbox"
        aria-label="Threads"
        aria-activedescendant={hotThread ? rowId(hotThread.id) : undefined}
        tabIndex={open ? 0 : -1}
      >
        {threads.map((t, i) => {
          const isCurrent = t.id === currentId;
          return (
            <div
              key={t.id}
              id={rowId(t.id)}
              role="option"
              aria-selected={isCurrent}
              className={`trow${isCurrent ? " active" : ""}${i === hotIndex ? " hot" : ""}`}
              onMouseMove={() => {
                if (i !== hotIndex) setHot(i);
              }}
              onClick={() => openRow(t)}
            >
              <span className="trow-title">{t.title}</span>
              <span className="trow-time">{threadTime(t.createdAt, now)}</span>
              <button
                className="iconbtn trow-del"
                aria-label="Delete Thread"
                tabIndex={-1}
                onClick={(e) => {
                  e.stopPropagation();
                  void deleteRow(t);
                }}
              >
                <Trash2 size={14} />
              </button>
            </div>
          );
        })}
        {threads.length === 0 && <div className="threads-empty">No threads</div>}
      </div>
    </div>
  );
}
