// New Chart (F2, AGENT-UX §16ii): the guided dialog that replaces the
// `Chart…` row's old prefill.
//
// The maintainer's own words are the brief: the row used to drop a sentence
// into the composer, "which user could already do that". So it now opens five
// picks, runs them read-only on the canvas's own connection as they are made,
// draws the WIDGET'S own chart face with the answer, and lands that widget on
// Add. The agent route is one link away and carries the picks with it, because
// a question with a WHERE in it, or two measures, is still the model's to
// write (DESIGN rule 15: this adds one modal and takes a route from nobody).
//
// Everything the dialog IS lives in `stores/chartDialog` (the picks, the
// session, the run); this file is its pixels plus the two things only a
// surface can own: where a popover hangs, and which one stands.
//
// The preview is `Chart.tsx` itself on a block built from the run, at the
// pane's geometry (no span: bars lie down at their fixed pitch, and a line
// takes its fixed 132 as the whole face, dates and all, since a box with a cap
// on it must clear what it holds). Not a picture of the widget, the widget's
// own face, so a chart that would not draw on the canvas does not draw here
// either and `Add Chart` has nothing to enable (LESSONS 13: read the fact off
// whatever produced it).
//
// ask.css rides along because a field's popover reuses the picker's own box
// and menu rows (DESIGN rule 1: a species is defined once), and this dialog
// stands on a canvas tab with the Ask pane closed.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { motion } from "motion/react";
import { ChevronDown, Eye, Globe, Grid2x2, Layers, Search, Table2 } from "lucide-react";
import { Kbd } from "../design/Kbd";
import { panelIn, popIn, spring } from "../design/springs";
import { AnchoredOverlay, Modal } from "../app/overlay/Overlay";
import { fuzzyScore } from "../ask/fuzzy";
import { rowsCount } from "../ask/mentionRows";
import { useCanvas } from "../stores/canvas";
import {
  addStands,
  askWordsOf,
  columnsFor,
  previewBlock,
  specOf,
  tablesFor,
  useChartDialog,
  type ChartColumn,
  type ChartDialogState,
} from "../stores/chartDialog";
import { AGGREGATES, CHART_LIMITS, DATE_UNITS, type Aggregate, type DateUnit } from "./chartSql";
import { Chart } from "./Chart";
import type { TableInfo } from "../stores/schema";
import "../ask/ask.css";
import "./chartDialog.css";

/** which field's list is standing. The picks are the store's; WHICH popover is
 * open is this surface's, because its anchor is a rectangle on this screen */
type PopKind = "table" | "group" | "measure" | "limit";

/** the gap between a field and the box under it, the `+` menu's own (§16cc) */
const POP_GAP = 4;

/** the height the preview hands a line: the pane's own 132 as the WHOLE face,
 * dates included, rather than 132 of plot with the date row drawn past the
 * box's own clip (`.cd-preview`, whose cap is this plus its padding and its
 * hairline). Bars take no fixed height: they lie at the pane's 24px pitch and
 * scroll, a half row standing as its own cue (rule 13) */
export const PREVIEW_LINE_H = 132;

const POP_LABEL: Record<PopKind, string> = {
  table: "Table",
  group: "Group by",
  measure: "Measure",
  limit: "Rows",
};

const TABLE_GLYPH: Record<TableInfo["kind"], ReactNode> = {
  r: <Table2 size={12} />,
  p: <Grid2x2 size={12} />,
  v: <Eye size={12} />,
  m: <Layers size={12} />,
  f: <Globe size={12} />,
};

/** a relation's own hint: its row estimate, or the word for what it is where
 * the planner counts no rows of its own */
const tableCtx = (t: TableInfo): string | null =>
  t.kind === "v" || t.kind === "m" ? "view" : rowsCount(t.reltuples);

// ---- the anchor -----------------------------------------------------------

/** Where a field's box hangs, re-read while the card is still arriving.
 *
 * The modal enters on a transform (`popIn`), and the TABLE popover opens in
 * that very frame by design, so a rect measured once would be the rect of a
 * card that had not finished moving. The point is re-measured each frame until
 * it holds still and then left alone: a handful of reads during an entrance,
 * none after it (LESSONS 7: position derives from this component's own
 * measurement, never from a style written by hand). */
function useFieldPoint(
  ref: RefObject<HTMLButtonElement | null>,
  open: boolean,
): { x: number; y: number } | null {
  const [point, setPoint] = useState<{ x: number; y: number } | null>(null);
  useLayoutEffect(() => {
    if (!open) {
      setPoint(null);
      return;
    }
    let frame = 0;
    let still = 0;
    const read = () => {
      const el = ref.current;
      if (el) {
        const r = el.getBoundingClientRect();
        const next = { x: r.left, y: r.bottom + POP_GAP };
        setPoint((p) => {
          if (p && p.x === next.x && p.y === next.y) {
            still += 1;
            return p;
          }
          still = 0;
          return next;
        });
      }
      // held for six frames: the entrance is over and nothing else here moves
      if (still < 6) frame = requestAnimationFrame(read);
    };
    read();
    return () => cancelAnimationFrame(frame);
  }, [ref, open]);
  return point;
}

// ---- the rows a list holds ------------------------------------------------

interface Row {
  key: string;
  glyph?: ReactNode;
  label: string;
  /** an identifier wears data's clothes; `Count rows` is chrome and does not */
  mono: boolean;
  ctx: string | null;
  active: boolean;
  onPick: () => void;
}

/** one run of rows; `head` names a schema, and is absent in a list of one run
 * (a heading over one kind says what every row under it already says, rule 14) */
interface Section {
  head: string | null;
  rows: Row[];
}

const columnRow = (c: ChartColumn, active: boolean, onPick: () => void): Row => ({
  key: c.name,
  label: c.name,
  mono: true,
  ctx: c.type,
  active,
  onPick,
});

// ---- the field ------------------------------------------------------------

function Field({
  value,
  ctx,
  mono,
  wide,
  open,
  disabled,
  label,
  fieldRef,
  onOpen,
}: {
  value: string;
  ctx?: string | null;
  mono?: boolean;
  wide?: boolean;
  open: boolean;
  disabled: boolean;
  label: string;
  fieldRef: RefObject<HTMLButtonElement | null>;
  onOpen: () => void;
}) {
  return (
    <button
      ref={fieldRef}
      type="button"
      className={`field${wide ? " wide" : ""}${open ? " active" : ""}`}
      aria-label={label}
      aria-haspopup="listbox"
      aria-expanded={open}
      disabled={disabled}
      onClick={onOpen}
    >
      <span className={`field-v${mono ? " mono" : ""}`}>{value}</span>
      {ctx ? <span className="field-ctx">{ctx}</span> : null}
      <ChevronDown size={12} />
    </button>
  );
}

function Seg<T extends string>({
  options,
  value,
  onPick,
  label,
}: {
  options: readonly T[];
  value: T;
  onPick: (v: T) => void;
  label: string;
}) {
  return (
    <div className="settings-seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o} type="button" className={o === value ? "active" : ""} onClick={() => onPick(o)}>
          {o[0].toUpperCase() + o.slice(1)}
        </button>
      ))}
    </div>
  );
}

/** the caret lands in the search the frame the box mounts, and never again on
 * a remount the filter causes (LESSONS 7: `autoFocus` re-fires, a ref does not) */
function useCaret(input: RefObject<HTMLInputElement | null>, open: boolean): void {
  useEffect(() => {
    if (!open) return;
    const take = () => input.current?.focus({ preventScroll: true });
    take();
    // the box paints hidden until the primitive has clamped it, and a hidden
    // element takes no focus: one more frame settles it
    if (document.activeElement !== input.current) {
      const frame = requestAnimationFrame(take);
      return () => cancelAnimationFrame(frame);
    }
  }, [input, open]);
}

// ---- the card -------------------------------------------------------------

/** The dialog's body, with no Modal around it and no store under it: the modal
 * is the primitive's, the state is the store's, and this is what they hold
 * between them. The state arrives as a PROP rather than through the hook so a
 * render test can draw any set of picks it likes; the hook lives one component
 * out (`ChartDialogCard`), where React is the only thing reading it. */
export function ChartDialogBody({
  s,
  onAdd,
}: {
  s: ChartDialogState;
  onAdd?: (blockId: string) => void;
}) {
  const [pop, setPop] = useState<PopKind | null>(null);
  const [filter, setFilter] = useState("");
  const [hot, setHot] = useState(0);
  const tableRef = useRef<HTMLButtonElement>(null);
  const groupRef = useRef<HTMLButtonElement>(null);
  const measureRef = useRef<HTMLButtonElement>(null);
  const limitRef = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);

  // the first pick is the first thing on screen: the Table list opens WITH the
  // dialog and the caret is already in its search
  useEffect(() => setPop("table"), []);
  useCaret(search, pop === "table");

  const ref =
    pop === "group" ? groupRef : pop === "measure" ? measureRef : pop === "limit" ? limitRef : tableRef;
  const point = useFieldPoint(ref, pop !== null);

  const openPop = (kind: PopKind) => {
    setFilter("");
    setHot(0);
    setPop(kind);
  };
  const closePop = useCallback(() => setPop(null), []);

  const columns = columnsFor(s);
  const tables = tablesFor(s.profileId);

  // ---- the lists ----------------------------------------------------------

  const tableSections = useMemo<Section[]>(() => {
    // the app's own matcher, never a library's (the `@` popover's rule): the
    // rows are grouped by schema in the snapshot's own order, and inside a
    // schema the filter ranks them, ties falling to that same order
    const hits = tables
      .map((t, i) => ({ t, i, score: fuzzyScore(filter, t.name) }))
      .filter((h) => h.score > 0)
      .sort((a, b) => b.score - a.score || a.i - b.i);
    const heads: string[] = [];
    const by = new Map<string, Row[]>();
    for (const { t } of hits) {
      if (!by.has(t.schema)) {
        heads.push(t.schema);
        by.set(t.schema, []);
      }
      by.get(t.schema)?.push({
        key: `${t.schema}.${t.name}`,
        glyph: TABLE_GLYPH[t.kind],
        label: t.name,
        mono: true,
        ctx: tableCtx(t),
        active: s.schema === t.schema && s.table === t.name,
        onPick: () => {
          useChartDialog.getState().pickTable(t.schema, t.name);
          setPop(null);
          // the pick made, the caret moves to the row that follows it
          requestAnimationFrame(() => groupRef.current?.focus({ preventScroll: true }));
        },
      });
    }
    return heads.map((head) => ({ head, rows: by.get(head) ?? [] }));
  }, [tables, filter, s.schema, s.table]);

  const groupSections = useMemo<Section[]>(
    () => [
      {
        head: null,
        rows: columns.map((c) =>
          columnRow(c, s.group === c.name, () => {
            useChartDialog.getState().pickGroup(c.name);
            closePop();
          }),
        ),
      },
    ],
    [columns, s.group, closePop],
  );

  const measureSections = useMemo<Section[]>(
    () => [
      {
        head: null,
        rows: [
          {
            key: "count",
            label: "Count rows",
            mono: false,
            ctx: null,
            active: s.measure === null,
            onPick: () => {
              useChartDialog.getState().pickMeasure(null);
              closePop();
            },
          },
          ...columns
            .filter((c) => c.kind === "numeric")
            .map((c) =>
              columnRow(c, s.measure === c.name, () => {
                useChartDialog.getState().pickMeasure(c.name);
                closePop();
              }),
            ),
        ],
      },
    ],
    [columns, s.measure, closePop],
  );

  const limitSections = useMemo<Section[]>(() => {
    // the standing value always has a row of its own: a picker whose list
    // omits its own value has a state its list cannot reach (rule 2's matrix)
    const offered = CHART_LIMITS.includes(s.limit)
      ? [...CHART_LIMITS]
      : [...CHART_LIMITS, s.limit].sort((a, b) => a - b);
    return [
      {
        head: null,
        rows: offered.map((n) => ({
          key: String(n),
          label: String(n),
          mono: true,
          ctx: null,
          active: n === s.limit,
          onPick: () => {
            useChartDialog.getState().pickLimit(n);
            closePop();
          },
        })),
      },
    ];
  }, [s.limit, closePop]);

  const sections =
    pop === "table"
      ? tableSections
      : pop === "group"
        ? groupSections
        : pop === "measure"
          ? measureSections
          : limitSections;
  const flat = sections.flatMap((x) => x.rows);

  // ---- the answer ---------------------------------------------------------

  const block = useMemo(() => previewBlock(s.sql, s.run), [s.sql, s.run]);
  const spec = useMemo(() => specOf(block), [block]);
  const dated = s.groupKind === "date";
  const canAdd = addStands(s);
  // the box stands while a run is in flight and while a chart stands, and is
  // ABSENT otherwise: a box explaining that it is empty is the string rule 11
  // refuses, and a failure takes the preview with it
  const stands = s.running || spec !== null;

  const add = () => {
    const id = useChartDialog.getState().add();
    if (id) onAdd?.(id);
  };
  const addRef = useRef(add);
  addRef.current = add;

  return (
    <>
      <div className="cd-title">New Chart</div>

      <div className="cd-row">
        <span className="cd-label">Table</span>
        <div className="cd-ctl">
          <Field
            fieldRef={tableRef}
            label="Table"
            value={s.table ? `${s.schema}.${s.table}` : ""}
            ctx={s.table ? rowsCount(s.tableRows) : null}
            mono
            wide
            open={pop === "table"}
            disabled={tables.length === 0}
            onOpen={() => openPop("table")}
          />
        </div>
      </div>

      <div className="cd-row">
        <span className="cd-label">Group by</span>
        <div className="cd-ctl">
          <Field
            fieldRef={groupRef}
            label="Group by"
            value={s.group ?? ""}
            mono
            wide
            open={pop === "group"}
            disabled={columns.length === 0}
            onOpen={() => openPop("group")}
          />
        </div>
      </div>

      {/* the unit row stands ONLY over a date group: with nothing to truncate
          it would be four controls answering nothing (rule 11) */}
      {dated && (
        <div className="cd-row">
          <span className="cd-label">Per</span>
          <div className="cd-ctl">
            <Seg<DateUnit>
              label="Per"
              options={DATE_UNITS}
              value={s.unit}
              onPick={(unit) => useChartDialog.getState().pickUnit(unit)}
            />
          </div>
        </div>
      )}

      <div className="cd-row">
        <span className="cd-label">Measure</span>
        <div className="cd-ctl">
          <Field
            fieldRef={measureRef}
            label="Measure"
            value={s.measure ?? "Count rows"}
            mono={s.measure !== null}
            open={pop === "measure"}
            disabled={columns.length === 0}
            onOpen={() => openPop("measure")}
          />
          {s.measure !== null && (
            <Seg<Aggregate>
              label="Aggregate"
              options={AGGREGATES}
              value={s.agg}
              onPick={(agg) => useChartDialog.getState().pickAgg(agg)}
            />
          )}
        </div>
      </div>

      <div className="cd-row">
        {/* a date group takes the NEWEST N, so the row says which end it takes */}
        <span className="cd-label">{dated ? "Last" : "Top"}</span>
        <div className="cd-ctl">
          <Field
            fieldRef={limitRef}
            label={dated ? "Last" : "Top"}
            value={String(s.limit)}
            mono
            open={pop === "limit"}
            disabled={s.table === null}
            onOpen={() => openPop("limit")}
          />
        </div>
      </div>

      {stands && (
        <motion.div className="cd-preview" {...panelIn}>
          {spec && !s.running ? (
            <Chart spec={spec} faceH={spec.kind === "line" ? PREVIEW_LINE_H : undefined} />
          ) : (
            // the widget's own cycle, not a spinner (E2 R3, same geometry)
            <div className="cd-skel" aria-hidden="true">
              <i style={{ width: "62%" }} />
              <i style={{ width: "48%" }} />
              <i style={{ width: "41%" }} />
              <i style={{ width: "30%" }} />
              <i style={{ width: "22%" }} />
            </div>
          )}
        </motion.div>
      )}

      {s.sql !== null && (
        <>
          <div className={`cd-status${s.error ? " err" : ""}`}>
            {s.error ?? (s.running ? "" : (block?.status ?? ""))}
          </div>
          <div className="cd-sql">{s.sql}</div>
        </>
      )}

      <div className="cd-actions">
        <button
          type="button"
          className="linkish"
          onClick={() => {
            // the picks leave WITH the question: the link is a change of route,
            // never a reset (the `Chart…` row's own prefill, now carrying words)
            const words = askWordsOf(useChartDialog.getState());
            const canvasId = s.canvasId;
            useChartDialog.getState().close();
            if (canvasId) useCanvas.getState().askForChart(canvasId, words);
          }}
        >
          Ask instead
        </button>
        <button type="button" className="btnish" onClick={() => useChartDialog.getState().close()}>
          Cancel
        </button>
        <button type="button" className="btnish primary" disabled={!canAdd} onClick={add}>
          Add Chart <Kbd chord="return" />
        </button>
      </div>

      {pop !== null && point !== null && (
        <AnchoredOverlay
          point={point}
          onClose={closePop}
          role="listbox"
          label={POP_LABEL[pop]}
          onKey={(e) => {
            if (e.metaKey || e.ctrlKey || e.altKey) return;
            if (e.key === "ArrowDown") setHot((h) => (flat.length ? (h + 1) % flat.length : 0));
            else if (e.key === "ArrowUp")
              setHot((h) => (flat.length ? (h - 1 + flat.length) % flat.length : 0));
            else if (e.key === "Enter") flat[hot]?.onPick();
            // every other key belongs to the search field: an input may swallow
            // only the keys it owns (LESSONS 10)
            else return;
            e.preventDefault();
            e.stopImmediatePropagation();
          }}
        >
          <motion.div
            className={`picker-pop field-pop${pop === "table" ? " searchable" : ""}`}
            {...popIn}
            transition={spring.snappy}
          >
            {pop === "table" && (
              <div className="field-search">
                <Search size={12} />
                <input
                  ref={search}
                  value={filter}
                  aria-label="Filter Tables"
                  spellCheck={false}
                  autoComplete="off"
                  onChange={(e) => {
                    setFilter(e.target.value);
                    setHot(0);
                  }}
                />
              </div>
            )}
            <FieldList sections={sections} hot={hot} onHot={setHot} />
          </motion.div>
        </AnchoredOverlay>
      )}
    </>
  );
}

function FieldList({
  sections,
  hot,
  onHot,
}: {
  sections: Section[];
  hot: number;
  onHot: (i: number) => void;
}) {
  let i = -1;
  return (
    <>
      {sections.map((section, s) => (
        <div key={section.head ?? `run-${s}`}>
          {section.head !== null && <div className="picker-group">{section.head}</div>}
          {section.rows.map((row) => {
            i += 1;
            const at = i;
            return (
              <button
                key={row.key}
                type="button"
                className={`picker-item${at === hot ? " hot" : ""}${row.active ? " active" : ""}`}
                onMouseMove={() => onHot(at)}
                onClick={row.onPick}
              >
                {row.glyph}
                <span className={row.mono ? "field-name" : "picker-label"}>{row.label}</span>
                {row.ctx !== null && (
                  <>
                    <span className="ask-grow" />
                    <span className="picker-ctx">{row.ctx}</span>
                  </>
                )}
              </button>
            );
          })}
        </div>
      ))}
    </>
  );
}

/** the body, wired to the store */
export function ChartDialogCard({ onAdd }: { onAdd?: (blockId: string) => void }) {
  return <ChartDialogBody s={useChartDialog()} onAdd={onAdd} />;
}

export function ChartDialog() {
  const canvasId = useChartDialog((s: ChartDialogState) => s.canvasId);
  if (!canvasId) return null;
  return <ChartDialogModal key={canvasId} />;
}

function ChartDialogModal() {
  // ↩ adds, but only while this modal is the topmost layer: a standing popover
  // is a layer of its own and escStack gives the key to it, so the two can
  // never race for one keystroke
  const enabled = useChartDialog(addStands);
  return (
    <Modal
      label="New Chart"
      onClose={() => useChartDialog.getState().close()}
      onKey={(e) => {
        if (e.key !== "Enter" || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
        if (!enabled) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        const id = useChartDialog.getState().add();
        if (id) focusWidget(id);
      }}
    >
      <motion.div
        className="chart-modal"
        initial={popIn.initial}
        animate={popIn.animate}
        layout
        // the rows under the preview travel on the layout spring as it lands or
        // leaves; the card itself still arrives on the modal's own pop
        transition={{ ...popIn.transition, layout: spring.layout }}
      >
        <ChartDialogCard onAdd={focusWidget} />
      </motion.div>
    </Modal>
  );
}

/** the new widget takes the caret, the frame after the overlay has put it back
 * on whatever opened the dialog */
function focusWidget(blockId: string): void {
  requestAnimationFrame(() =>
    document.querySelector<HTMLElement>(`[data-block="${blockId}"]`)?.focus({ preventScroll: true }),
  );
}
