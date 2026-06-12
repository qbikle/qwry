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
    const sessionId = conn.activeProfileId ? conn.sessions[conn.activeProfileId] : null;
    if (!sessionId || !sql.trim()) return;

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
