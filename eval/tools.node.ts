// AgentTools over `pg` for the headless harness (EVAL.md section 3,
// AGENT-SPEC section 2 rule 2). The twin of src/agent/tools.tauri.ts: same
// interface, same MODEL-FACING TEXT, different transport. The PR gate scores
// the app's own loop through this file, so any drift between the two is a
// drift in what the numbers mean.
//
// Every renderer is imported from src/agent/context.ts rather than reproduced,
// which is what keeps the two implementations byte-identical by construction.
// The three helpers this file does copy (`resolve`, `nameList`, `valueMap`)
// are private to tools.tauri.ts today; hoisting them into context.ts is a
// request on the owner of that file, and until then the copies below are
// deliberately literal.

import type { Client } from "pg";
import {
  PEEK_MAX,
  PROBE_MAX,
  UI_ROW_CAP,
  type AgentTools,
  type PeekOutcome,
  type ProbeOutcome,
  type TableBrief,
  type TableDescription,
  type ToolOutcome,
} from "../src/agent/tools";
import type { AgentRun } from "../src/agent/types";
import type { SchemaSnapshot } from "../src/stores/schema";
import {
  buildMeta,
  formatPeek,
  formatProbes,
  formatRun,
  formatTableList,
  probeFragment,
  renderDescribe,
  type ColumnValueEntry,
  type ColumnValueMap,
  type SchemaMeta,
  type TableMeta,
} from "../src/agent/context";
import {
  PROBE_TIMEOUT_MS,
  RUN_TIMEOUT_MS,
  describeValues,
  firstLine,
  peekValues,
  runReadonly,
  type RawResult,
  type TableRef,
  type TableValues,
} from "./introspect.node";

/** Rows a probe result shows (AGENT-SPEC section 5, agent.rs PROBE_ROW_CAP). */
export const PROBE_ROW_CAP = 5;

export interface NodeToolsInit {
  client: Client;
  snapshot: SchemaSnapshot;
  /** statement_timeout for run_sql; the app reads it from useSettings */
  timeoutMs?: number;
  /** every tool call the loop or a `claude -p` child made, in order: the
   * harness counts calls by name and the app's trace panel is the twin */
  onCall?: (call: { tool: string; ms: number; bytes: number; isError: boolean }) => void;
}

const toRun = (raw: RawResult): AgentRun => ({
  columns: raw.columns,
  rows: raw.rows,
  rowCount: raw.rowCount,
  capped: raw.capped,
  ms: raw.ms,
});

/** Names the model may use, for an error that teaches rather than refuses
 * (tools.tauri.ts nameList). */
function nameList(meta: SchemaMeta, limit = 60): string {
  const names = meta.tables.map((t) => t.display);
  return names.length > limit
    ? `${names.slice(0, limit).join(", ")} … (${names.length} in total)`
    : names.join(", ");
}

/** Resolve a name as the MODEL wrote it: bare, quoted, wrong case, or already
 * qualified. Never splits a dotted string blindly (LESSONS 4); the dotted form
 * is only accepted when it matches a display name the index emitted
 * (tools.tauri.ts resolve). */
function resolve(meta: SchemaMeta, raw: string): TableMeta | null {
  const name = raw.trim().replace(/^"(.*)"$/, "$1");
  const exact = meta.byDisplay.get(name);
  if (exact) return exact;
  const lower = name.toLowerCase();
  const bare = meta.tables.filter((t) => t.name.toLowerCase() === lower);
  if (bare.length === 1) return bare[0];
  const qualified = meta.tables.filter(
    (t) => `${t.schema}.${t.name}`.toLowerCase() === lower,
  );
  if (qualified.length === 1) return qualified[0];
  const ci = meta.tables.filter((t) => t.display.toLowerCase() === lower);
  return ci.length === 1 ? ci[0] : null;
}

/** The describe call's own answer, keyed the way the renderer reads it
 * (tools.tauri.ts valueMap). */
function valueMap(values: TableValues[], meta: SchemaMeta): ColumnValueMap {
  const out: ColumnValueMap = new Map();
  for (const t of values) {
    const table = meta.tables.find((m) => m.schema === t.schema && m.name === t.name);
    if (!table) continue;
    const cols = new Map<string, ColumnValueEntry>();
    for (const c of t.columns) {
      cols.set(c.column, { values: c.values, more: c.more, comment: c.comment });
    }
    out.set(table.display, cols);
  }
  return out;
}

export function createNodeTools(init: NodeToolsInit): AgentTools {
  const meta = buildMeta(init.snapshot);
  const timeout = init.timeoutMs ?? RUN_TIMEOUT_MS;

  const record = (tool: string, started: number, text: string, isError: boolean) => {
    init.onCall?.({ tool, ms: Date.now() - started, bytes: text.length, isError });
  };

  const unknown = (kind: string, name: string): ToolOutcome<never> => ({
    textForModel: `ERROR: unknown ${kind} '${name}'. Valid names: ${nameList(meta)}`,
    result: null,
    error: `unknown ${kind} '${name}'`,
  });

  return {
    async listTables(): Promise<ToolOutcome<TableBrief[]>> {
      const started = Date.now();
      const result: TableBrief[] = meta.tables.map((t) => ({
        schema: t.schema,
        name: t.name,
        approxRows: Math.max(t.approxRows, 0),
        comment: t.comment,
      }));
      const textForModel = formatTableList(meta);
      record("list_tables", started, textForModel, false);
      return { textForModel, result };
    },

    async describeTables(names): Promise<ToolOutcome<TableDescription[]>> {
      const started = Date.now();
      const picked: TableMeta[] = [];
      for (const raw of names) {
        const t = resolve(meta, raw);
        if (!t) {
          const out = unknown("table", raw);
          record("describe_tables", started, out.textForModel, true);
          return out;
        }
        if (!picked.includes(t)) picked.push(t);
      }
      const refs: TableRef[] = picked.map((t) => ({ schema: t.schema, name: t.name }));
      let values: TableValues[] = [];
      try {
        values = await describeValues(init.client, refs);
      } catch {
        // pg_stats values are an accelerant, never the definition: a failure
        // here costs sample values, not the DDL (LESSONS 5)
        values = [];
      }
      const byTable = valueMap(values, meta);
      const textForModel = renderDescribe(
        meta,
        picked.map((t) => t.display),
        byTable,
      );
      const result: TableDescription[] = picked.map((t) => {
        const cols = byTable.get(t.display);
        return {
          schema: t.schema,
          name: t.name,
          comment: t.comment,
          columns: t.columns.map((c) => {
            const fk = meta.fks.find((f) => f.src === t.display && f.srcCol === c.name);
            const dst = fk ? meta.byDisplay.get(fk.dst) : undefined;
            return {
              name: c.name,
              type: c.type,
              notNull: c.notNull,
              isPrimaryKey: t.pk.includes(c.name),
              references:
                fk && dst ? { schema: dst.schema, name: dst.name, column: fk.dstCol } : null,
              comment: cols?.get(c.name)?.comment ?? c.comment,
              values: cols?.get(c.name)?.values ?? [],
            };
          }),
        };
      });
      record("describe_tables", started, textForModel, false);
      return { textForModel, result };
    },

    async peekValues(table, column, limit = 20): Promise<ToolOutcome<PeekOutcome>> {
      const started = Date.now();
      const t = resolve(meta, table);
      if (!t) {
        const out = unknown("table", table);
        record("peek_values", started, out.textForModel, true);
        return out;
      }
      const col = t.columns.find(
        (c) => c.name.toLowerCase() === column.trim().replace(/^"(.*)"$/, "$1").toLowerCase(),
      );
      if (!col) {
        const out: ToolOutcome<PeekOutcome> = {
          textForModel:
            `ERROR: no column '${column}' on ${t.display}. ` +
            `Columns: ${t.columns.map((c) => c.name).join(", ")}`,
          result: null,
          error: `no column '${column}' on ${t.display}`,
        };
        record("peek_values", started, out.textForModel, true);
        return out;
      }
      const capped = Math.max(1, Math.min(Math.trunc(limit), PEEK_MAX));
      try {
        const peek = await peekValues(init.client, t.schema, t.name, col.name, capped);
        const textForModel = formatPeek(peek.values, peek.more, peek.sampled);
        record("peek_values", started, textForModel, false);
        return {
          textForModel,
          result: {
            table: t.display,
            column: col.name,
            values: peek.values,
            more: peek.more,
            sampled: peek.sampled,
          },
        };
      } catch (e) {
        const text = `ERROR: ${firstLine(e)}`;
        record("peek_values", started, text, true);
        return { textForModel: text, result: null, error: firstLine(e) };
      }
    },

    async runSql(sql): Promise<ToolOutcome<AgentRun>> {
      const started = Date.now();
      try {
        const run = toRun(await runReadonly(init.client, sql, UI_ROW_CAP, timeout));
        const textForModel = formatRun(run);
        record("run_sql", started, textForModel, false);
        return { textForModel, result: run };
      } catch (e) {
        const text = `ERROR: ${firstLine(e)}`;
        record("run_sql", started, text, true);
        return { textForModel: text, result: null, error: firstLine(e) };
      }
    },

    async probe(sqls): Promise<ToolOutcome<ProbeOutcome[]>> {
      const started = Date.now();
      // truncate rather than refuse, as tools.tauri.ts does: a model that
      // asked for a seventh probe still deserves the first six answers
      const asked = sqls.slice(0, PROBE_MAX);
      const result: ProbeOutcome[] = [];
      for (const sql of asked) {
        try {
          const run = toRun(await runReadonly(init.client, sql, PROBE_ROW_CAP, PROBE_TIMEOUT_MS));
          result.push({ sql, run, error: null, fragment: probeFragment(sql, run) });
        } catch (e) {
          result.push({ sql, run: null, error: firstLine(e), fragment: null });
        }
      }
      const textForModel = formatProbes(result);
      record("probe", started, textForModel, false);
      return { textForModel, result };
    },
  };
}
