import { create } from "zustand";

interface DangerState {
  prompt: { title: string; detail: string } | null;
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

/** async confirm for destructive operations (window.confirm is a WKWebView stub) */
export function confirmDanger(title: string, detail: string): Promise<boolean> {
  return new Promise((resolve) => {
    useDanger.setState({ prompt: { title, detail }, resolver: resolve });
  });
}

/** UPDATE or DELETE statements with no WHERE clause */
export function dangerousStatements(sql: string): string[] {
  return sql
    .split(";")
    .map((s) => s.trim())
    .filter((s) => /^(update|delete)\b/i.test(s) && !/\bwhere\b/i.test(s));
}

export const isMutating = (sql: string) =>
  /^\s*(insert|update|delete|truncate|drop|alter)\b/i.test(sql.trim());
