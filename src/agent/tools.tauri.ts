// AgentTools over the Tauri agent commands (AGENT-SPEC section 5). The other
// file under src/agent allowed to import Tauri and a store; eval/tools.node.ts
// implements the same interface over `pg` and MUST return the same text, since
// the PR gate scores this loop through that one.
//
// This file owns the ONE wire-to-domain conversion: src/ipc/types.ts is the
// snake_case mirror of the Rust records, src/agent/types.ts is the camelCase
// domain the loop works in (w1-ownership deviation 2).
//
// The claude -p provider does not come through here at all: it calls qwry's
// MCP server, and src-tauri/src/agent_mcp.rs mirrors the text these tools
// return byte for byte. A change to either is a change to both.

import {
  agentDescribe,
  agentPeekValues,
  agentProbe,
  agentRunReadonly,
} from "../ipc/commands";
import type { AgentRun as AgentRunWire, TableRef, TableValues } from "../ipc/types";
import { useSettings } from "../stores/settings";
import type { SchemaSnapshot } from "../stores/schema";
import {
  PEEK_MAX,
  PROBE_MAX,
  RUN_SQL_TIMEOUT_MS,
  UI_ROW_CAP,
  type AgentTools,
  type PeekOutcome,
  type ProbeOutcome,
  type TableBrief,
  type TableDescription,
  type ToolOutcome,
} from "./tools";
import type { AgentRun } from "./types";
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
} from "./context";

export interface TauriToolsInit {
  /** the thread's dedicated read-only session (agent_connect) */
  sessionId: string;
  /** the active connection's cached snapshot: list_tables and every name
   * resolution read it, so no round trip pays for structure twice */
  snapshot: SchemaSnapshot;
  /** overrides the statement_timeout setting; 0 falls through to the section 5
   * default, exactly as the setting's own 0 does */
  timeoutMs?: number;
}

/** Wire record to domain record. The two shapes exist on purpose; this is the
 * only place they meet. */
export function toDomainRun(w: AgentRunWire): AgentRun {
  return {
    columns: w.columns,
    rows: w.rows,
    rowCount: w.row_count,
    capped: w.capped,
    ms: w.ms,
  };
}

const firstLine = (e: unknown): string => {
  const raw =
    e instanceof Error
      ? e.message
      : typeof e === "string"
        ? e
        : ((e as { message?: string } | null)?.message ?? String(e));
  return raw.split("\n")[0].trim() || "query failed";
};

/** Names the model may use, for an error that teaches rather than refuses. */
function nameList(meta: SchemaMeta, limit = 60): string {
  const names = meta.tables.map((t) => t.display);
  return names.length > limit
    ? `${names.slice(0, limit).join(", ")} … (${names.length} in total)`
    : names.join(", ");
}

/** Resolve a name as the MODEL wrote it: bare, quoted, wrong case, or already
 * qualified. Never splits a dotted string blindly (LESSONS 4): the dotted form
 * is only accepted when it matches a display name the index actually emitted. */
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

/** The describe call's own answer, keyed the way the renderer reads it. The
 * comment comes from the database as of this call, so it reaches the model
 * even when it was added since the last introspect; the cached snapshot's
 * copy stays the fallback. */
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

export function createTauriTools(init: TauriToolsInit): AgentTools {
  const meta = buildMeta(init.snapshot);
  // 0 means "no timeout" for a session (ipc/commands.ts connect), a shape a
  // tool call does not have: agent.rs would clamp it to the one-second FLOOR,
  // handing the tightest timeout to whoever switched the timeout off. It falls
  // through to the section 5 default instead, as platform.tauri.ts does.
  const timeout = () => {
    const ms = init.timeoutMs ?? useSettings.getState().statementTimeoutSecs * 1000;
    return ms > 0 ? ms : RUN_SQL_TIMEOUT_MS;
  };

  const unknown = (kind: string, name: string): ToolOutcome<never> => ({
    textForModel: `ERROR: unknown ${kind} '${name}'. Valid names: ${nameList(meta)}`,
    result: null,
    error: `unknown ${kind} '${name}'`,
  });

  return {
    async listTables(): Promise<ToolOutcome<TableBrief[]>> {
      const result: TableBrief[] = meta.tables.map((t) => ({
        schema: t.schema,
        name: t.name,
        approxRows: Math.max(t.approxRows, 0),
        comment: t.comment,
      }));
      return { textForModel: formatTableList(meta), result };
    },

    async describeTables(names): Promise<ToolOutcome<TableDescription[]>> {
      const picked: TableMeta[] = [];
      for (const raw of names) {
        const t = resolve(meta, raw);
        if (!t) return unknown("table", raw);
        if (!picked.includes(t)) picked.push(t);
      }
      const refs: TableRef[] = picked.map((t) => ({ schema: t.schema, name: t.name }));
      let values: TableValues[] = [];
      try {
        values = await agentDescribe(init.sessionId, refs);
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
      return { textForModel, result };
    },

    async peekValues(table, column, limit = 20): Promise<ToolOutcome<PeekOutcome>> {
      const t = resolve(meta, table);
      if (!t) return unknown("table", table);
      const col = t.columns.find(
        (c) => c.name.toLowerCase() === column.trim().replace(/^"(.*)"$/, "$1").toLowerCase(),
      );
      if (!col) {
        return {
          textForModel:
            `ERROR: no column '${column}' on ${t.display}. ` +
            `Columns: ${t.columns.map((c) => c.name).join(", ")}`,
          result: null,
          error: `no column '${column}' on ${t.display}`,
        };
      }
      const capped = Math.max(1, Math.min(Math.trunc(limit), PEEK_MAX));
      try {
        const peek = await agentPeekValues(init.sessionId, t.schema, t.name, col.name, capped);
        const result: PeekOutcome = {
          table: t.display,
          column: col.name,
          values: peek.values,
          more: peek.more,
          sampled: peek.sampled,
        };
        return { textForModel: formatPeek(peek.values, peek.more, peek.sampled), result };
      } catch (e) {
        return { textForModel: `ERROR: ${firstLine(e)}`, result: null, error: firstLine(e) };
      }
    },

    async runSql(sql): Promise<ToolOutcome<AgentRun>> {
      try {
        const wire = await agentRunReadonly(init.sessionId, sql, UI_ROW_CAP, timeout());
        const run = toDomainRun(wire);
        return { textForModel: formatRun(run), result: run };
      } catch (e) {
        return { textForModel: `ERROR: ${firstLine(e)}`, result: null, error: firstLine(e) };
      }
    },

    async probe(sqls): Promise<ToolOutcome<ProbeOutcome[]>> {
      const asked = sqls.slice(0, PROBE_MAX);
      try {
        const wire = await agentProbe(init.sessionId, asked);
        const result: ProbeOutcome[] = wire.map((p) => {
          const run = p.run ? toDomainRun(p.run) : null;
          return {
            sql: p.sql,
            run,
            error: p.error,
            fragment: run ? probeFragment(p.sql, run) : null,
          };
        });
        return { textForModel: formatProbes(result), result };
      } catch (e) {
        return { textForModel: `ERROR: ${firstLine(e)}`, result: null, error: firstLine(e) };
      }
    },
  };
}
