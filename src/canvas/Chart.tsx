// The chart face (A3 item 2): a hand-rolled SVG, no dependency (DECISIONS,
// A3). What can be drawn is the document store's to decide (`chartOf`, one
// predicate with tests and no DOM); this file draws what it is handed.
//
// Bars LIE DOWN whenever the label axis is text: nine thirteen-character
// labels under standing bars collide at the 640 floor and would have to
// rotate or drop, and nothing clips at the floor (DESIGN rule 13). As rows
// they read like the grid's, the labels right-aligned in the status register
// to meet their bars and every value standing at its bar's end in the data
// register, which is what retires the value axis (rule 14). A date label
// draws a line instead: the points at the dates, three y ticks and sparse x
// ticks, both in the status register, no vertical labels anywhere.
//
// C2a gives that rule its condition. On the grid the face knows its WIDTH and
// its HEIGHT, so bars STAND when the span is wider than tall (w/h >= 1.5) and
// every label fits under its own bar; otherwise they lie down, unchanged. The
// fit is measured against the BASE cell and never the rendered one, so the
// same element draws the same chart at 640 and at 1280 and a window drag can
// never flip it. Lying bars then distribute their pitch over the face's
// height (min 40, never under a bar's own thickness) instead of stacking at
// a fixed 24, and the line's plot takes the face's height in place of its
// fixed 132. With no span the geometry is exactly what it was: the pane's
// block is as tall as what it holds.
//
// D1 closes the case C2a's rule left open: a face too short for its own rows.
// The pitch was held at a floor and the rows went on stacking, so a twelve-bar
// chart of three series in a 4x3 element drew 432px of plot into a 292px face,
// through its own status line and 128px into the note below it. It draws the
// rows that FIT now. The document's own answer to the same question is the
// other half (canvas.ts `chartPx`): a chart OPENS at a height read from its
// bars and its series, so nothing is clipped until a hand makes it so.
//
// D2 item 4 moves the count D1 printed on the block's status line INTO the
// face, as the one line that acts on it: `+ 4 more`, the link species at the
// bars' own x, standing where the ninth bar would, and a press on it resizes
// the widget to the height its bars need (the store's `fitChart`, which asks
// `defaultSpanFor` — the same arithmetic that chose the opening height). A
// squeezed face reserves exactly one status line at the plot's foot for it and
// nothing at all while every row fits, so the norm is silent (DESIGN rule 11)
// and `12 rows · 241.6 ms` goes back to saying what the run did (rule 14: the
// count lives in the slot that acts on it).
//
// One scale across every series (two scales in one plot lie) and across every
// row, drawn or not: rescaling to the rows that fit would make the bars lie
// about each other, where the line under them tells the truth. The series are
// in the accent ladder's order (three steps of one hue over the panel), and a
// legend appears only from two series, one status-register line inside the
// face at its top-left.
//
// The SVG is sized by a ResizeObserver on its own box, so the bars take the
// width the card gives them at 640, 960 and 1280 and the geometry is computed
// once per width.

import { useContext, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { BarsFit, ChartSpec } from "../stores/canvas";
import { Widget } from "./widget";
import { CELL_W_BASE, GUTTER } from "./grid";

/** the accent ladder: three steps of one hue over the panel */
const LADDER = [
  "var(--accent)",
  "color-mix(in srgb, var(--accent) 45%, var(--bg-panel))",
  "color-mix(in srgb, var(--accent) 22%, var(--bg-panel))",
];

/** the widest a label may be before it is ellipsized rather than allowed to
 * eat the plot (rule 13: growth feeds the bars, never the axis) */
const LABEL_CAP = 150;
/** UI text and mono text at --text-xs: the two average advances the geometry
 * lays out on. A measured string per row would re-measure on every width for
 * a two-pixel gain */
const UI_ADV = 6.4;
const MONO_ADV = 6.8;

const fmt = (v: number) => v.toLocaleString("en-US");
const widthOf = (s: string, adv: number) => Math.round(s.length * adv) + 4;
const clip = (s: string, px: number) =>
  s.length * UI_ADV <= px ? s : `${s.slice(0, Math.max(1, Math.floor(px / UI_ADV) - 1))}…`;

interface Geometry {
  h: number;
  children: ReactNode;
  /** the rows this face could hold, of the rows there are, when a hand made
   * the box too short for all of them. Absent while they all fit: the norm is
   * silent (DESIGN rule 11). It is what `+ N more` counts, and the line stands
   * at `fitX`, the bars' own left edge, where the next bar would have been */
  fit?: BarsFit;
  fitX?: number;
}

/** the row the x labels take under standing bars, and the line above every
 * bar its value stands in: both one status line (16) with 2px of air */
const X_LABEL_H = 18;
const VALUE_H = 18;
/** the tallest a lying bar's row grows to, however much height the cells give
 * it: past this the rows read as a list of headings, not as a chart */
const PITCH_MAX = 40;
/** the one status line a squeezed face reserves at the plot's foot for
 * `+ N more` (D2 item 4). Nothing is reserved while every row fits */
const MORE_H = 16;

/** bars STAND when the cells are wider than tall and every label fits under
 * its own bar. Measured at the BASE cell, so the answer belongs to the span
 * and not to the window (a stretch can never flip a chart on its side) */
export function standing(spec: ChartSpec, span: { w: number; h: number }): boolean {
  if (spec.kind === "line" || span.w / span.h < 1.5) return false;
  const base = span.w * CELL_W_BASE + (span.w - 1) * GUTTER;
  const g = standLayout(spec, base, 0);
  const per = g.plotW / spec.labels.length - 8;
  return spec.labels.every((l) => widthOf(l, UI_ADV) <= per);
}

/** the legend: one status-register line inside the face, from two series */
function legendOf(spec: ChartSpec, x0: number): ReactNode[] {
  if (spec.series.length < 2) return [];
  let x = x0;
  return spec.series.map((s, i) => {
    const at = x;
    x += 12 + s.name.length * UI_ADV + 16;
    return (
      <g key={`leg-${s.name}`}>
        <rect x={at} y={4} width={8} height={8} rx={2} fill={LADDER[i]} />
        <text className="lbl" x={at + 12} y={12}>
          {s.name}
        </text>
      </g>
    );
  });
}

/** the bars' numbers, apart from their marks: one row per label, one bar per
 * series inside it, ONE scale across every series (two scales in one plot
 * lie), and the plot taking whatever the labels and the values leave */
export function barLayout(spec: ChartSpec, w: number, faceH = 0) {
  const ns = spec.series.length;
  const n = spec.labels.length;
  const labW = Math.min(LABEL_CAP, Math.max(...spec.labels.map((l) => widthOf(l, UI_ADV))));
  const valW = Math.max(...spec.series.flatMap((s) => s.values.map((v) => widthOf(fmt(v), MONO_ADV))));
  const barH = ns === 1 ? 12 : 8;
  const gap = 3;
  const legH = ns > 1 ? 24 : 0;
  // the rows own the face's height when the cells gave it one, and never
  // squeeze under the bars they hold; with no face height they stack at the
  // pane's own 24 (or at what two series need)
  const natural = ns === 1 ? 24 : ns * barH + (ns - 1) * gap + 12;
  const floor = ns === 1 ? 16 : ns * barH + (ns - 1) * gap + 4;
  // the rows a hand-shrunk face can actually hold. Squeezed past their own
  // floor the bars used to keep stacking and the plot drew straight through
  // the status line and into the element below it (D1 item 6); it draws the
  // rows that FIT instead and hands how many of the labels they are up to the
  // block, which says it on the status line it already has. The whole of the
  // face is the plot's, since the count is not drawn in here
  const full = faceH > 0 ? Math.max(0, faceH - legH) : 0;
  const fits = faceH <= 0 || n * floor <= full;
  // squeezed, the face keeps one status line of its own height back for the
  // `+ N more` the bars it dropped are answered by (D2 item 4)
  const room = fits ? full : Math.max(0, full - MORE_H);
  const shown = fits ? n : Math.max(1, Math.min(n, Math.floor(room / floor)));
  const pitch = faceH > 0 ? Math.max(floor, Math.min(PITCH_MAX, room / shown)) : natural;
  const max = Math.max(1, ...spec.series.flatMap((s) => s.values));
  const x0 = labW + 8;
  const plotW = Math.max(24, w - x0 - valW - 8);
  return {
    ns,
    labW,
    valW,
    barH,
    gap,
    pitch,
    legH,
    max,
    x0,
    plotW,
    shown,
    total: n,
    h: legH + shown * pitch,
  };
}

/** standing bars: the face's height IS the value axis, three ticks at its
 * left in the status register (the line's own ticks), the labels under the
 * bars and every value above its own, which is what retires the axis here as
 * it does lying down (rule 14) */
export function standLayout(spec: ChartSpec, w: number, faceH = 0) {
  const ns = spec.series.length;
  const n = spec.labels.length;
  const legH = ns > 1 ? 24 : 0;
  const max = Math.max(1, ...spec.series.flatMap((s) => s.values));
  const ticks = [max, max / 2, 0];
  const yLabW = Math.max(...ticks.map((t) => widthOf(fmt(Math.round(t)), UI_ADV)));
  const x0 = yLabW + 8;
  const plotW = Math.max(24, w - x0 - 8);
  const top = legH + VALUE_H;
  const plotH = Math.max(24, (faceH > 0 ? faceH : 132) - top - X_LABEL_H);
  const pitch = plotW / n;
  const gap = 3;
  const barW = Math.max(2, Math.min(24, (pitch - 8 - (ns - 1) * gap) / ns));
  return {
    ns,
    legH,
    ticks,
    yLabW,
    x0,
    plotW,
    plotH,
    pitch,
    barW,
    gap,
    max,
    top,
    yAt: (v: number) => top + plotH - (plotH * v) / max,
    h: top + plotH + X_LABEL_H,
  };
}

/** bars: one row per label, one bar per series inside it */
function bars(spec: ChartSpec, w: number, faceH: number): Geometry {
  const { ns, labW, barH, gap, pitch, legH, max, x0, plotW, shown, total, h } = barLayout(spec, w, faceH);
  // ONE scale across every series and across every row, drawn or not: rescaling
  // to the rows that fit would make the bars lie about each other, where the
  // line under them tells the truth about how many there are
  const rows = spec.labels.slice(0, shown).map((label, ri) => {
    const y = legH + ri * pitch;
    return (
      <g key={`${label}-${ri}`}>
        <text className="lbl" x={labW} y={y + pitch / 2 + 4} textAnchor="end">
          {clip(label, labW)}
        </text>
        {spec.series.map((s, si) => {
          const by = y + (pitch - (ns * barH + (ns - 1) * gap)) / 2 + si * (barH + gap);
          const bw = Math.max(1, Math.round((plotW * s.values[ri]) / max));
          return (
            <g key={s.name}>
              <rect x={x0} y={by} width={bw} height={barH} rx={2} fill={LADDER[si]} />
              <text className="val" x={x0 + bw + 6} y={by + barH / 2 + 4}>
                {fmt(s.values[ri])}
              </text>
            </g>
          );
        })}
      </g>
    );
  });
  return {
    h,
    children: [...legendOf(spec, x0), ...rows],
    ...(shown < total ? { fit: { shown, total }, fitX: x0 } : null),
  };
}

/** the line's numbers: three y ticks at the left, sparse x ticks under the
 * plot, both in the status register, and no vertical label anywhere */
export function lineLayout(spec: ChartSpec, w: number, faceH = 0) {
  const ns = spec.series.length;
  const legH = ns > 1 ? 24 : 0;
  const xLabH = X_LABEL_H;
  // the plot takes the face's height where the cells gave it one, and the
  // pane's own 132 where nothing did
  const plotH = faceH > 0 ? Math.max(24, faceH - legH - xLabH) : 132;
  const max = Math.max(1, ...spec.series.flatMap((s) => s.values));
  const ticks = [max, max / 2, 0];
  const yLabW = Math.max(...ticks.map((t) => widthOf(fmt(Math.round(t)), UI_ADV)));
  const x0 = yLabW + 8;
  const plotW = Math.max(24, w - x0 - 8);
  const n = spec.labels.length;
  return {
    legH,
    plotH,
    ticks,
    yLabW,
    x0,
    plotW,
    /** one x label in four, and always the last */
    every: Math.max(1, Math.ceil(n / 4)),
    xAt: (i: number) => x0 + (n === 1 ? plotW / 2 : (plotW * i) / (n - 1)),
    yAt: (v: number) => legH + plotH - (plotH * v) / max,
    h: legH + plotH + xLabH,
  };
}

/** a date label: the points at the dates, one line per series on one scale */
function line(spec: ChartSpec, w: number, faceH: number): Geometry {
  const { legH, plotH, ticks, yLabW, x0, every, xAt, yAt, h } = lineLayout(spec, w, faceH);
  const n = spec.labels.length;
  return {
    h,
    children: [
      ...legendOf(spec, x0),
      ...ticks.map((t) => (
        <text key={`y-${t}`} className="lbl" x={yLabW} y={yAt(t) + 4} textAnchor="end">
          {fmt(Math.round(t))}
        </text>
      )),
      // one label in four, and always the last; a tick that would land closer
      // to the last than the step allows is dropped instead of collided into
      // it (DESIGN rule 13: nothing overlaps at the floor)
      ...spec.labels.map((label, i) =>
        i === n - 1 || (i % every === 0 && n - 1 - i >= every) ? (
          <text
            key={`x-${label}-${i}`}
            className="lbl"
            x={xAt(i)}
            y={legH + plotH + 14}
            textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"}
          >
            {label}
          </text>
        ) : null,
      ),
      ...spec.series.map((s, si) => (
        <g key={`s-${s.name}`}>
          <polyline
            points={s.values.map((v, i) => `${xAt(i)},${yAt(v)}`).join(" ")}
            fill="none"
            stroke={LADDER[si]}
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
          {s.values.map((v, i) => (
            <circle key={`${s.name}-${i}`} cx={xAt(i)} cy={yAt(v)} r={2.5} fill={LADDER[si]} />
          ))}
        </g>
      )),
    ],
  };
}

/** standing bars: one group per label across the plot's width, the value over
 * every bar and the label under it */
function standBars(spec: ChartSpec, w: number, faceH: number): Geometry {
  const { ns, ticks, yLabW, x0, plotH, pitch, barW, gap, top, yAt, h } = standLayout(spec, w, faceH);
  const groups = spec.labels.map((label, i) => {
    const left = x0 + i * pitch;
    return (
      <g key={`${label}-${i}`}>
        <text className="lbl" x={left + pitch / 2} y={top + plotH + 14} textAnchor="middle">
          {clip(label, pitch - 8)}
        </text>
        {spec.series.map((s, si) => {
          const bx = left + (pitch - (ns * barW + (ns - 1) * gap)) / 2 + si * (barW + gap);
          const y = yAt(s.values[i]);
          return (
            <g key={s.name}>
              <rect x={bx} y={y} width={barW} height={Math.max(1, top + plotH - y)} rx={2} fill={LADDER[si]} />
              <text className="val" x={bx + barW / 2} y={y - 5} textAnchor="middle">
                {fmt(s.values[i])}
              </text>
            </g>
          );
        })}
      </g>
    );
  });
  return {
    h,
    children: [
      ...legendOf(spec, x0),
      ...ticks.map((t) => (
        <text key={`y-${t}`} className="lbl" x={yLabW} y={yAt(t) + 4} textAnchor="end">
          {fmt(Math.round(t))}
        </text>
      )),
      ...groups,
    ],
  };
}

export function Chart({ spec, span }: { spec: ChartSpec; span?: { w: number; h: number } }) {
  // the cells this face stands in, when it stands in some: what `+ N more`
  // resizes. Null in the pane, where nothing is ever squeezed
  const widget = useContext(Widget);
  const hostRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  // a layout effect and the entry's CONTENT box: the first paint is already
  // the right size (never a zero-width chart for one frame) and a card resize
  // redraws once, without a resize listener of its own. The HEIGHT is read the
  // same way and matters only on the grid, where the cells give the face one
  useLayoutEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    setBox({ w: el.clientWidth, h: el.clientHeight });
    const ro = new ResizeObserver(([entry]) =>
      setBox({ w: Math.round(entry.contentRect.width), h: Math.round(entry.contentRect.height) }),
    );
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const w = box.w;
  // with no span the box is as tall as what it holds, which is what `0` says
  const faceH = span ? box.h : 0;
  const geo =
    w > 0
      ? spec.kind === "line"
        ? line(spec, w, faceH)
        : span && standing(spec, span)
          ? standBars(spec, w, faceH)
          : bars(spec, w, faceH)
      : null;
  // what the layout could not draw, which only the grid can act on: the line
  // under the plot counts it and the press gives the widget the height
  const fit = geo?.fit ?? null;
  const shown = fit?.shown ?? 0;
  const total = fit?.total ?? 0;
  return (
    <div className="cv-chart" ref={hostRef}>
      {geo && (
        <svg
          width={w}
          height={geo.h}
          viewBox={`0 0 ${w} ${geo.h}`}
          role="img"
          aria-label={`${spec.series.map((s) => s.name).join(", ")} by ${spec.label}`}
        >
          {geo.children}
        </svg>
      )}
      {/* the bars this box could not hold, and the press that gives them room:
          one line in the plot's own column, where the next bar would stand.
          The widget springs to the height its bars need (spring.layout, the
          resize snap's own) and the line goes with the squeeze that caused it */}
      {fit && widget && (
        <div className="cv-more" style={{ marginLeft: geo?.fitX ?? 0 }}>
          <button
            type="button"
            className="linkish"
            onClick={() =>
              void import("../stores/canvas").then(({ useCanvas }) =>
                useCanvas.getState().fitChart(widget.canvasId, widget.blockId, widget.columns()),
              )
            }
          >
            {`+ ${total - shown} more`}
          </button>
        </div>
      )}
    </div>
  );
}
