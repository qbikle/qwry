// The intellisense core: a CodeMirror CompletionSource scoped by QueryCtx.
// All data comes from the in-memory SchemaSnapshot: zero IPC per keystroke.

import {
  pickedCompletion,
  snippetCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import type { EditorView } from "@codemirror/view";
import type { SchemaSnapshot, TableInfo } from "../../stores/schema";
import { queryContext, type QueryCtx, type TableRef } from "./context";
import { bumpUsage, usageBoost } from "./usage";
import { useConnections } from "../../stores/connections";
import { useSchema } from "../../stores/schema";
import { useSettings } from "../../stores/settings";

const KEYWORDS =
  `select from where join left right inner outer full cross on as and or not in is null distinct group by order having limit offset insert into values update set delete returning union all exists between like ilike case when then else end asc desc with using primary key create table index view alter drop add column constraint references default unique check cascade begin commit rollback explain analyze vacuum count sum avg min max coalesce nullif cast interval true false`.split(
    " ",
  );

const needsQuote = (name: string) => !/^[a-z_][a-z0-9_$]*$/.test(name);
const q = (name: string) => (needsQuote(name) ? `"${name.replace(/"/g, '""')}"` : name);

function track(kind: string, name: string) {
  return (view: EditorView, completion: Completion, from: number, to: number) => {
    bumpUsage(kind, name);
    view.dispatch({
      changes: { from, to, insert: completion.label },
      selection: { anchor: from + completion.label.length },
      annotations: pickedCompletion.of(completion),
    });
  };
}

const SNIPPETS: Completion[] = [
  snippetCompletion("SELECT ${*} FROM ${table} LIMIT ${100}", {
    label: "sel",
    detail: "SELECT … FROM …",
    type: "snippet",
    boost: 1,
  }),
  snippetCompletion("INSERT INTO ${table} (${cols}) VALUES (${vals})", {
    label: "ins",
    detail: "INSERT INTO …",
    type: "snippet",
    boost: 1,
  }),
  snippetCompletion("UPDATE ${table} SET ${col} = ${val} WHERE ${cond}", {
    label: "upd",
    detail: "UPDATE … SET …",
    type: "snippet",
    boost: 1,
  }),
  snippetCompletion("SELECT count(*) FROM ${table}", {
    label: "cnt",
    detail: "count rows",
    type: "snippet",
    boost: 1,
  }),
];

function resolveTables(ctx: QueryCtx, snap: SchemaSnapshot): Map<TableRef, TableInfo> {
  const m = new Map<TableRef, TableInfo>();
  for (const ref of ctx.tables) {
    const t = snap.tables.find(
      (t) =>
        t.name.toLowerCase() === ref.name &&
        (ref.schema ? t.schema.toLowerCase() === ref.schema : true),
    );
    if (t) m.set(ref, t);
  }
  return m;
}

function columnOptions(
  scoped: Map<TableRef, TableInfo>,
  opts: { detailAlias: boolean },
): Completion[] {
  const out: Completion[] = [];
  const seen = new Set<string>();
  for (const [ref, table] of scoped) {
    for (const col of table.columns) {
      const dedupe = `${col.name}`;
      const ambiguous = seen.has(dedupe);
      seen.add(dedupe);
      out.push({
        label: q(col.name),
        type: "property",
        detail: `${col.type}${opts.detailAlias ? ` · ${ref.alias}` : ""}`,
        boost: 3 + usageBoost("col", col.name) - (ambiguous ? 0.5 : 0),
        apply: track("col", col.name),
      });
    }
  }
  return out;
}

function tableOptions(snap: SchemaSnapshot, schemaFilter: string | null): Completion[] {
  return snap.tables
    .filter((t) => (schemaFilter ? t.schema.toLowerCase() === schemaFilter : true))
    .map((t) => ({
      label: schemaFilter || t.schema === "public" ? q(t.name) : `${q(t.schema)}.${q(t.name)}`,
      type: t.kind === "v" || t.kind === "m" ? "interface" : "class",
      detail: t.kind === "v" || t.kind === "m" ? "view" : `${t.columns.length} cols`,
      boost: 2 + usageBoost("tbl", t.name),
      apply: track("tbl", t.name),
    }));
}

function schemaOptions(snap: SchemaSnapshot): Completion[] {
  return snap.schemas.map((s) => ({
    label: q(s),
    type: "namespace",
    detail: "schema",
    boost: 0.5,
  }));
}

function aliasOptions(ctx: QueryCtx): Completion[] {
  return ctx.tables.map((ref) => ({
    label: ref.alias,
    type: "namespace",
    detail: ref.name === ref.alias ? "table" : `= ${ref.name}`,
    boost: 2.5,
  }));
}

function functionOptions(snap: SchemaSnapshot): Completion[] {
  return snap.functions.map((f) => ({
    label: f.name,
    type: "function",
    detail: `(${f.args}) → ${f.returns}`,
    boost: -1 + usageBoost("fn", f.name),
    apply: (view, completion, from, to) => {
      bumpUsage("fn", f.name);
      view.dispatch({
        changes: { from, to, insert: `${f.name}()` },
        selection: { anchor: from + f.name.length + 1 },
        annotations: pickedCompletion.of(completion),
      });
    },
  }));
}

function keywordOptions(): Completion[] {
  return KEYWORDS.map((k) => ({
    label: k.toUpperCase(),
    type: "keyword",
    boost: -2,
  }));
}

/** FK-driven `JOIN x ON …` and `ON a = b` suggestions */
function joinOptions(ctx: QueryCtx, snap: SchemaSnapshot): Completion[] {
  const out: Completion[] = [];
  const scoped = resolveTables(ctx, snap);

  const aliasFor = (schema: string, name: string): string | null => {
    for (const [ref, t] of scoped) {
      if (t.schema === schema && t.name === name) return ref.alias;
    }
    return null;
  };

  if (ctx.clause === "join") {
    // suggest tables connected by FK to anything in scope
    for (const fk of snap.foreign_keys) {
      const srcAlias = aliasFor(fk.src_schema, fk.src_table);
      const dstAlias = aliasFor(fk.dst_schema, fk.dst_table);
      let other: { schema: string; table: string; cond: string } | null = null;
      if (srcAlias && !dstAlias) {
        const t = fk.dst_table;
        other = {
          schema: fk.dst_schema,
          table: t,
          cond: fk.src_cols.map((c, i) => `${t}.${q(fk.dst_cols[i])} = ${srcAlias}.${q(c)}`).join(" AND "),
        };
      } else if (dstAlias && !srcAlias) {
        const t = fk.src_table;
        other = {
          schema: fk.src_schema,
          table: t,
          cond: fk.dst_cols.map((c, i) => `${t}.${q(fk.src_cols[i])} = ${dstAlias}.${q(c)}`).join(" AND "),
        };
      }
      if (other) {
        const tref = other.schema === "public" ? q(other.table) : `${q(other.schema)}.${q(other.table)}`;
        out.push({
          label: `${tref} ON ${other.cond}`,
          type: "class",
          detail: "FK join",
          boost: 5,
        });
      }
    }
  }

  if (ctx.clause === "on" && ctx.lastJoined) {
    const last = ctx.lastJoined;
    for (const fk of snap.foreign_keys) {
      const pairs: Array<[string, string, string[], string[]]> = [
        [fk.src_table, fk.dst_table, fk.src_cols, fk.dst_cols],
        [fk.dst_table, fk.src_table, fk.dst_cols, fk.src_cols],
      ];
      for (const [a, b, ac, bc] of pairs) {
        if (a !== last.name) continue;
        const otherAlias = ctx.tables.find((r) => r.name === b && r !== last)?.alias;
        if (!otherAlias) continue;
        out.push({
          label: ac
            .map((c, i) => `${last.alias}.${q(c)} = ${otherAlias}.${q(bc[i])}`)
            .join(" AND "),
          type: "constant",
          detail: "FK match",
          boost: 5,
        });
      }
    }
  }
  return out;
}

interface BuiltLists {
  allTables: Completion[];
  /** allTables with the default-clause demotion pre-applied: the per-keystroke
   * `.map(spread)` over the whole catalog was pure allocation churn */
  allTablesDemoted: Completion[];
  allFunctions: Completion[];
  allSchemas: Completion[];
  schemaNames: Set<string>;
}

const ALL_KEYWORDS = keywordOptions();
const listCache = new WeakMap<SchemaSnapshot, BuiltLists>();

function builtLists(snap: SchemaSnapshot): BuiltLists {
  let lists = listCache.get(snap);
  if (!lists) {
    const allTables = tableOptions(snap, null);
    lists = {
      allTables,
      allTablesDemoted: allTables.map((t) => ({ ...t, boost: (t.boost ?? 0) - 2.5 })),
      allFunctions: functionOptions(snap),
      allSchemas: schemaOptions(snap),
      schemaNames: new Set(snap.schemas.map((s) => s.toLowerCase())),
    };
    listCache.set(snap, lists);
  }
  return lists;
}

/**
 * Stable completion source: reads the CURRENT snapshot from the store on every
 * invocation, so schema refreshes (and HMR) need no editor reconfiguration.
 */
export async function qwryCompletion(
  cmCtx: CompletionContext,
): Promise<CompletionResult | null> {
  const { activeProfileId } = useConnections.getState();
  const snap = activeProfileId
    ? useSchema.getState().snapshots[activeProfileId]
    : undefined;
  if (!snap) {
    const word = cmCtx.matchBefore(/[\w$]*/);
    if (!word || (word.from === word.to && !cmCtx.explicit)) return null;
    return { from: word.from, options: ALL_KEYWORDS, validFor: /^[\w$]*$/ };
  }
  return makeCompletionSource(snap, useSettings.getState().fnInComplete)(cmCtx);
}

export function makeCompletionSource(snap: SchemaSnapshot, fnInComplete = false) {
  const { allTables, allTablesDemoted, allFunctions, allSchemas, schemaNames } = builtLists(snap);
  const allKeywords = ALL_KEYWORDS;

  return (cmCtx: CompletionContext): CompletionResult | null => {
    const word = cmCtx.matchBefore(/[\w$"]*/);
    if (!word) return null;
    if (word.from === word.to && !cmCtx.explicit) {
      // auto-popup only after ident chars or a dot
      const prev = cmCtx.state.sliceDoc(Math.max(0, cmCtx.pos - 1), cmCtx.pos);
      if (prev !== ".") return null;
    }

    const ctx = queryContext(cmCtx.state, cmCtx.pos);
    const scoped = resolveTables(ctx, snap);

    let options: Completion[];

    if (ctx.qualifier) {
      if (schemaNames.has(ctx.qualifier)) {
        // schema.<tables>
        options = tableOptions(snap, ctx.qualifier);
      } else {
        // alias.<columns>: exact table only
        const hit = [...scoped.entries()].find(([ref]) => ref.alias === ctx.qualifier);
        const direct = hit
          ? new Map([hit])
          : new Map(
              [...scoped.entries()].filter(([ref]) => ref.name === ctx.qualifier),
            );
        options = columnOptions(direct, { detailAlias: false });
      }
    } else {
      switch (ctx.clause) {
        case "from":
        case "join":
        case "into":
        case "update":
          options = [
            ...joinOptions(ctx, snap),
            ...allTables,
            ...allSchemas,
            ...allKeywords,
          ];
          break;
        case "on":
          options = [
            ...joinOptions(ctx, snap),
            ...columnOptions(scoped, { detailAlias: true }),
            ...aliasOptions(ctx),
            ...allKeywords,
          ];
          break;
        case "start":
          options = [...SNIPPETS, ...allKeywords, ...allTables];
          break;
        default:
          // select / where / group / order / having / set / values / returning
          // functions are noisy (3.5k in pg_catalog): explicit trigger (^Space)
          // or the settings toggle opts them into the typed flow
          options = [
            ...columnOptions(scoped, { detailAlias: true }),
            ...aliasOptions(ctx),
            ...(cmCtx.explicit || fnInComplete ? allFunctions : []),
            ...allTablesDemoted,
            ...allKeywords,
          ];
      }
    }

    return {
      from: word.from,
      options,
      validFor: /^[\w$"]*$/,
    };
  };
}
