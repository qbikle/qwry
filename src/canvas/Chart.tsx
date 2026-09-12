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
// One scale across every series (two scales in one plot lie), the series in
// the accent ladder's order (three steps of one hue over the panel), and a
// legend only from two series, one status-register line inside the face at
// its top-left.
//
// The SVG is sized by a ResizeObserver on its own box, so the bars take the
// width the card gives them at 640, 960 and 1280 and the geometry is computed
// once per width.

import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { ChartSpec } from "../stores/canvas";
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
}

/** the row the x labels take under standing bars, and the line above every
 * bar its value stands in: both one status line (16) with 2px of air */
const X_LABEL_H = 18;
const VALUE_H = 18;
/** the tallest a lying bar's row grows to, however much height the cells give
 * it: past this the rows read as a list of headings, not as a chart */
const PITCH_MAX = 40;

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
  const pitch = faceH > 0 ? Math.max(floor, Math.min(PITCH_MAX, (faceH - legH) / n)) : natural;
  const max = Math.max(1, ...spec.series.flatMap((s) => s.values));
  const x0 = labW + 8;
  const plotW = Math.max(24, w - x0 - valW - 8);
  return { ns, labW, valW, barH, gap, pitch, legH, max, x0, plotW, h: legH + n * pitch };
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
  const { ns, labW, barH, gap, pitch, legH, max, x0, plotW, h } = barLayout(spec, w, faceH);
  const rows = spec.labels.map((label, ri) => {
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
  return { h, children: [...legendOf(spec, x0), ...rows] };
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
    </div>
  );
}
