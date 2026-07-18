import { create } from "zustand";
import * as ipc from "../ipc/commands";
import { useConnections } from "./connections";

export interface PlanNode {
  type: string;
  relation: string | null;
  index: string | null;
  actualMs: number;
  selfMs: number;
  loops: number;
  actualRows: number;
  planRows: number;
  children: PlanNode[];
}

interface ExplainState {
  open: boolean;
  running: boolean;
  error: string | null;
  root: PlanNode | null;
  executionMs: number;
  planningMs: number;

  run: (sql?: string) => Promise<void>;
  close: () => void;
}

interface RawNode {
  "Node Type": string;
  "Relation Name"?: string;
  "Index Name"?: string;
  "Actual Total Time"?: number;
  "Actual Rows"?: number;
  "Actual Loops"?: number;
  "Plan Rows"?: number;
  Plans?: RawNode[];
}

function convert(raw: RawNode): PlanNode {
  const children = (raw.Plans ?? []).map(convert);
  const loops = raw["Actual Loops"] ?? 1;
  const totalMs = (raw["Actual Total Time"] ?? 0) * loops;
  const childMs = children.reduce((s, c) => s + c.actualMs, 0);
  return {
    type: raw["Node Type"],
    relation: raw["Relation Name"] ?? null,
    index: raw["Index Name"] ?? null,
    actualMs: totalMs,
    selfMs: Math.max(0, totalMs - childMs),
    loops,
    actualRows: raw["Actual Rows"] ?? 0,
    planRows: raw["Plan Rows"] ?? 0,
    children,
  };
}

export const useExplain = create<ExplainState>((set) => ({
  open: false,
  running: false,
  error: null,
  root: null,
  executionMs: 0,
  planningMs: 0,

  run: async (sqlOverride?: string) => {
    const conn = useConnections.getState();
    const sql = sqlOverride ?? conn.sql;
    if (!conn.activeProfileId || !sql.trim()) return;
    // EXPLAIN on the active tab's session so it sees the tab's txn/temp state
    const { useTabs } = await import("./tabs");
    const tabId = useTabs.getState().activeId;
    if (!tabId) return;
    const sessionId = await conn.ensureTabSession(conn.activeProfileId, tabId);
    if (!sessionId) return;

    const { isMutating, confirmDanger } = await import("./danger");
    // scan every statement, not just the buffer head — `SELECT 1; DELETE FROM t`
    // must warn even though the buffer heads at SELECT
    const { splitStatementSpans } = await import("../editor/statements");
    if (splitStatementSpans(sql).some((sp) => isMutating(sql.slice(sp.from, sp.to)))) {
      const ok = await confirmDanger(
        "EXPLAIN ANALYZE executes the statement",
        `This will actually run:\n\n${sql.trim().slice(0, 400)}`,
      );
      if (!ok) return;
    }

    set({ open: true, running: true, error: null, root: null });
    try {
      const out = await ipc.execute(
        sessionId,
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`,
      );
      const cell = out.statements[0]?.rows[0]?.[0];
      if (!cell) throw new Error("no plan returned");
      const parsed = JSON.parse(cell) as Array<{
        Plan: RawNode;
        "Execution Time"?: number;
        "Planning Time"?: number;
      }>;
      set({
        root: convert(parsed[0].Plan),
        executionMs: parsed[0]["Execution Time"] ?? 0,
        planningMs: parsed[0]["Planning Time"] ?? 0,
        running: false,
      });
    } catch (e) {
      set({
        error: (e as { message?: string }).message ?? String(e),
        running: false,
      });
    }
  },

  close: () => set({ open: false, root: null, error: null }),
}));
