import { create } from "zustand";

interface DangerState {
  prompt: { id: number; title: string; detail: string; confirmLabel: string } | null;
  resolver: ((ok: boolean) => void) | null;
  resolve: (ok: boolean) => void;
}

export const useDanger = create<DangerState>((set, get) => ({
  prompt: null,
  resolver: null,
  resolve: (ok) => {
    get().resolver?.(ok);
    set({ prompt: null, resolver: null });
  },
}));

let promptSeq = 0;

/** async confirm for destructive operations (window.confirm is a WKWebView stub).
 * `confirmLabel` names the ACTION ("Discard", "Delete", "Quit") — a generic
 * label on a destructive button makes users misread what they're agreeing to. */
export function confirmDanger(
  title: string,
  detail: string,
  confirmLabel = "Run anyway",
): Promise<boolean> {
  return confirmDangerLive(title, detail, confirmLabel).done;
}

/** confirm whose detail can be UPDATED while it's open — the no-WHERE prompt
 * opens immediately with "estimating…" and streams planner estimates in
 * (blocking the modal on an EXPLAIN that may be lock-stuck made ⌘↵ hang).
 * `update` silently no-ops once this prompt is resolved or displaced. */
export function confirmDangerLive(
  title: string,
  detail: string,
  confirmLabel = "Run anyway",
): { done: Promise<boolean>; update: (detail: string) => void } {
  const id = ++promptSeq;
  const done = new Promise<boolean>((resolve) => {
    // a new prompt displacing an open one must not orphan the old caller's
    // promise — resolve it false (treated as "cancelled")
    useDanger.getState().resolver?.(false);
    useDanger.setState({ prompt: { id, title, detail, confirmLabel }, resolver: resolve });
  });
  const update = (next: string) => {
    const cur = useDanger.getState().prompt;
    if (cur?.id !== id) return; // resolved or displaced — a late estimate is noise
    useDanger.setState({ prompt: { ...cur, detail: next } });
  };
  return { done, update };
}

import { splitStatementSpans } from "../editor/statements";

/** UPDATE or DELETE statements with no WHERE clause — real statement
 * boundaries (a `;` inside a string/comment no longer splits) */
export function dangerousStatements(sql: string): string[] {
  return splitStatementSpans(sql)
    .map((sp) => sql.slice(sp.from, sp.to).trim())
    .filter((s) => /^(update|delete)\b/i.test(s) && !/\bwhere\b/i.test(s));
}

export const isMutating = (sql: string) =>
  /^\s*(insert|update|delete|truncate|drop|alter)\b/i.test(sql.trim());
