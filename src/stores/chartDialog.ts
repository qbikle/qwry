// The New Chart dialog's state (F2, AGENT-UX §16ii). The picks, the session
// the preview runs on, and what came back: everything the dialog IS, minus its
// pixels.
//
// It lives in a store and not in the component for the reason `editing` does
// (A3 item 6): the palette's `New Chart…` is a keyboard route into this dialog
// from outside the canvas component, so the flag that opens it cannot be that
// component's own state. Everything else follows it, because a picker whose
// value lived in React and whose run lived here would be two authorities over
// one composition.
//
// The run is the compare path's own shape (canvas.ts `compare`): ONE
// `agent_connect` for the dialog's life, `agent_run_readonly` per change, a
// `disconnect` on close. It is read-only at the server whatever the profile's
// prod flag says (AGENT-SPEC 8.1) and the AST gate refuses anything but a
// SELECT, so the statement this composes is safe on any connection the rail
// holds.
//
// LESSONS 16 sets the order of the act: the cycle goes up in the SAME
// synchronous store write the pick itself causes, before anything has waited
// on the wire, and the 250 ms debounce and the round trip after it show only
// in how long that cycle HOLDS. A run carries a token, so an answer to a pick
// the reader has already moved off is dropped rather than drawn over the one
// they are looking at (LESSONS 3, read from the other side).
//
// canvas.ts must never import this file: `newChart` reaches it through a
// dynamic import for the same reason port.ts exists (two stores that import
// each other are one knot).

import { create } from "zustand";
import { agentConnect, agentRunReadonly, disconnect } from "../ipc/commands";
import { toDomainRun } from "../agent/tools.tauri";
import type { AgentRun } from "../agent/types";
import { RUN_SQL_TIMEOUT_MS } from "../agent/tools";
import {
  capRun,
  chartOf,
  CHART_ROW_CAP,
  firstLine,
  useCanvas,
  type ChartSpec,
  type ResultBlock,
} from "./canvas";
import { useSchema, type TableInfo } from "./schema";
import { useSettings } from "./settings";
import {
  chartAskWords,
  chartSql,
  chartTitle,
  columnKindOf,
  DEFAULT_DATE_LIMIT,
  DEFAULT_LIMIT,
  type Aggregate,
  type ChartPicks,
  type ColumnKind,
  type DateUnit,
} from "../canvas/chartSql";

/** a change waits this long before it reaches the wire: long enough that
 * walking a popover with ↑↓ runs once at the end, short enough that a single
 * pick answers while the hand is still on it */
const DEBOUNCE_MS = 250;

/** one column, as the two column pickers read it */
export interface ChartColumn {
  name: string;
  type: string;
  kind: ColumnKind;
}

export interface ChartDialogState {
  /** the canvas the widget will land on; null = the dialog is not standing */
  canvasId: string | null;
  /** the connection the preview runs on, read off the canvas when it opens */
  profileId: string | null;

  schema: string | null;
  table: string | null;
  /** the table's planner row estimate, the field's own faint context. Null
   * when the snapshot never carried one (an old cache, a never-analyzed
   * relation): the field then wears the name alone (DESIGN rule 11) */
  tableRows: number | null;
  group: string | null;
  /** "text" while nothing is grouped: the `Per` row stands on "date" alone */
  groupKind: ColumnKind;
  unit: DateUnit;
  /** null = `Count rows` */
  measure: string | null;
  agg: Aggregate;
  limit: number;

  /** the statement the picks compose, null until a table AND a group stand */
  sql: string | null;
  /** a run is in flight, or waiting out the debounce before it is */
  running: boolean;
  /** what came back, or null while nothing has */
  run: AgentRun | null;
  /** the server's own first line; the preview goes and the picks stand */
  error: string | null;

  open: (canvasId: string) => void;
  close: () => void;
  pickTable: (schema: string, table: string) => void;
  pickGroup: (column: string) => void;
  pickUnit: (unit: DateUnit) => void;
  pickMeasure: (column: string | null) => void;
  pickAgg: (agg: Aggregate) => void;
  pickLimit: (limit: number) => void;
  /** the widget lands and the dialog closes; null when there is no chart to
   * land, which is also when `Add Chart` is disabled */
  add: () => string | null;
}

const EMPTY = {
  canvasId: null,
  profileId: null,
  schema: null,
  table: null,
  tableRows: null,
  group: null,
  groupKind: "text",
  unit: "month",
  measure: null,
  agg: "sum",
  limit: DEFAULT_LIMIT,
  sql: null,
  running: false,
  run: null,
  error: null,
} as const satisfies Partial<ChartDialogState>;

// ---- the run's own machinery ----------------------------------------------
//
// Module scope, not store state: nothing re-renders on a timer or a token, and
// the session is a handle the surface has no use for.

let timer: ReturnType<typeof setTimeout> | null = null;
let token = 0;
/** the dialog's one session, in flight or landed. Every run awaits it, so a
 * pick made before the connection answers still runs exactly once */
let sessionAt: Promise<string> | null = null;

const timeoutMs = (): number => {
  const secs = useSettings.getState().statementTimeoutSecs;
  return secs > 0 ? secs * 1000 : RUN_SQL_TIMEOUT_MS;
};

/** the picks, when they are complete enough to compose a statement */
export function picksOf(s: ChartDialogState): ChartPicks | null {
  if (!s.schema || !s.table || !s.group) return null;
  return {
    schema: s.schema,
    table: s.table,
    group: s.group,
    groupKind: s.groupKind,
    unit: s.unit,
    measure: s.measure,
    agg: s.agg,
    limit: s.limit,
  };
}

/** the block the preview draws: the widget as it WILL stand, built through the
 * same `capRun` every other door into the document goes through, so the bars,
 * the status sentence and the row cap in the dialog are the ones the canvas
 * will hold (DESIGN rule 14) */
export function previewBlock(sql: string | null, run: AgentRun | null): ResultBlock | null {
  if (!run) return null;
  const { rows, status } = capRun(run);
  return {
    id: "chart-preview",
    kind: "result",
    question: "",
    prose: "",
    sql,
    columns: run.columns,
    rows,
    chips: [],
    status,
    ms: run.ms,
    face: "chart",
  };
}

/** the chart the run makes, or null: `Add Chart` stands on exactly this, so
 * the button and the preview can never disagree about whether a chart exists */
export const specOf = (block: ResultBlock | null): ChartSpec | null =>
  block === null ? null : chartOf(block);

async function fire(mine: number, sql: string): Promise<void> {
  // everything the run needs is read BEFORE the first await (LESSONS 3)
  const at = sessionAt;
  const ms = timeoutMs();
  try {
    if (!at) throw new Error("the connection is gone");
    const session = await at;
    const wire = await agentRunReadonly(session, sql, CHART_ROW_CAP + 1, ms);
    // a pick made while this was on the wire owns the preview now
    if (mine !== token) return;
    useChartDialog.setState({ run: toDomainRun(wire), running: false, error: null });
  } catch (e) {
    if (mine !== token) return;
    useChartDialog.setState({ run: null, running: false, error: firstLine(e, "the statement failed") });
  }
}

/** every pick ends here. The cycle is written synchronously, in the same store
 * write the pick caused; only the statement waits (LESSONS 16) */
function schedule(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  const picks = picksOf(useChartDialog.getState());
  if (!picks) {
    // nothing composes yet: the preview is ABSENT, never a sentence saying so
    token++;
    useChartDialog.setState({ sql: null, run: null, running: false, error: null });
    return;
  }
  const sql = chartSql(picks);
  const mine = ++token;
  useChartDialog.setState({ sql, running: true, error: null });
  timer = setTimeout(() => {
    timer = null;
    void fire(mine, sql);
  }, DEBOUNCE_MS);
}

export const useChartDialog = create<ChartDialogState>((set, get) => ({
  ...EMPTY,

  open: (canvasId) => {
    const meta = Object.values(useCanvas.getState().canvases)
      .flat()
      .find((c) => c.id === canvasId);
    if (!meta) return;
    token++;
    if (timer) clearTimeout(timer);
    timer = null;
    set({ ...EMPTY, canvasId, profileId: meta.profileId });
    // the session opens WITH the dialog, so the first pick runs on a
    // connection that is already up rather than paying for one (the compare
    // path's own shape). The catch is only here to keep an opening that fails
    // from surfacing as an unhandled rejection: the run awaits this same
    // promise and reports the failure in the status slot where the reader is
    // looking
    const at = agentConnect(meta.profileId);
    sessionAt = at;
    at.catch(() => {});
  },

  close: () => {
    if (timer) clearTimeout(timer);
    timer = null;
    // whatever is on the wire now answers nobody
    token++;
    const at = sessionAt;
    sessionAt = null;
    if (at) void at.then((id) => disconnect(id)).catch(() => {});
    set({ ...EMPTY });
  },

  pickTable: (schema, table) => {
    const info = tableInfo(get().profileId, schema, table);
    // the columns are the new table's, so no pick made against the old one
    // survives: a group that named a column this table does not have would
    // compose a statement that cannot run (LESSONS 5's inverse)
    set({
      schema,
      table,
      tableRows: rowsOf(info),
      group: null,
      groupKind: "text",
      measure: null,
      limit: DEFAULT_LIMIT,
    });
    schedule();
  },

  pickGroup: (column) => {
    const s = get();
    const kind = kindOf(columnsFor(s), column);
    set({
      group: column,
      groupKind: kind,
      // the row cap's default belongs to the ROW's own label, so a date group
      // opens on twelve months under `Last` and every other group on ten bars
      // under `Top`. Only crossing that line moves it: a count the reader
      // chose is theirs, and two text groups in a row never reset it
      ...((kind === "date") === (s.groupKind === "date")
        ? null
        : { limit: kind === "date" ? DEFAULT_DATE_LIMIT : DEFAULT_LIMIT }),
    });
    schedule();
  },

  pickUnit: (unit) => {
    set({ unit });
    schedule();
  },

  pickMeasure: (column) => {
    set({ measure: column });
    schedule();
  },

  pickAgg: (agg) => {
    set({ agg });
    schedule();
  },

  pickLimit: (limit) => {
    set({ limit });
    schedule();
  },

  add: () => {
    const s = get();
    const picks = picksOf(s);
    const spec = specOf(previewBlock(s.sql, s.run));
    if (!s.canvasId || !s.sql || !s.run || !picks || s.running || !spec) return null;
    const id = useCanvas
      .getState()
      .addChart(s.canvasId, { title: chartTitle(picks), sql: s.sql, run: s.run });
    get().close();
    return id;
  },
}));

// ---- the schema the pickers read ------------------------------------------

const tableInfo = (
  profileId: string | null,
  schema: string,
  table: string,
): TableInfo | undefined =>
  profileId === null
    ? undefined
    : useSchema
        .getState()
        .snapshots[profileId]?.tables.find((t) => t.schema === schema && t.name === table);

/** the planner's estimate, or null where there is none to show. `-1` is
 * pg_class's own "never analyzed": a field wearing `-1` would be a number that
 * means nothing (LESSONS 9) */
const rowsOf = (info: TableInfo | undefined): number | null => {
  const n = info?.reltuples;
  return typeof n === "number" && n >= 0 ? n : null;
};

/** the chosen table's columns, each read once for its kind. Empty until a
 * table stands, which is what keeps the two column pickers disabled */
export function columnsFor(s: ChartDialogState): ChartColumn[] {
  if (!s.schema || !s.table) return [];
  const info = tableInfo(s.profileId, s.schema, s.table);
  return (info?.columns ?? []).map((c) => ({
    name: c.name,
    type: c.type,
    kind: columnKindOf(c.type),
  }));
}

const kindOf = (columns: readonly ChartColumn[], name: string): ColumnKind =>
  columns.find((c) => c.name === name)?.kind ?? "text";

/** the tables the Table picker offers, this connection's whole snapshot in the
 * order the sidebar holds them */
export function tablesFor(profileId: string | null): TableInfo[] {
  if (!profileId) return [];
  return useSchema.getState().snapshots[profileId]?.tables ?? [];
}

/** whether `Add Chart` stands: a chart exists and nothing is in flight. The
 * button and the ↩ that does the same thing read this one answer, so they can
 * never disagree about whether there is a widget to land (DESIGN rule 14) */
export function addStands(s: ChartDialogState): boolean {
  return !s.running && picksOf(s) !== null && specOf(previewBlock(s.sql, s.run)) !== null;
}

/** the words `Ask instead` leaves behind: whatever has been picked so far */
export const askWordsOf = (s: ChartDialogState): string =>
  chartAskWords({
    table: s.table,
    group: s.group,
    groupKind: s.groupKind,
    unit: s.unit,
    measure: s.measure,
    agg: s.agg,
  });

/** the store door the `+` menu's `Chart…` row and the palette's `New Chart…`
 * both take, so neither surface has to hold the store to open it */
export const openChartDialog = (canvasId: string): void =>
  useChartDialog.getState().open(canvasId);
