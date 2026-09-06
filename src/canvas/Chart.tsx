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
export function barLayout(spec: ChartSpec, w: number) {
  const ns = spec.series.length;
  const labW = Math.min(LABEL_CAP, Math.max(...spec.labels.map((l) => widthOf(l, UI_ADV))));
  const valW = Math.max(...spec.series.flatMap((s) => s.values.map((v) => widthOf(fmt(v), MONO_ADV))));
  const barH = ns === 1 ? 12 : 8;
  const gap = 3;
  const pitch = ns === 1 ? 24 : ns * barH + (ns - 1) * gap + 12;
  const legH = ns > 1 ? 24 : 0;
  const max = Math.max(1, ...spec.series.flatMap((s) => s.values));
  const x0 = labW + 8;
  const plotW = Math.max(24, w - x0 - valW - 8);
  return { ns, labW, valW, barH, gap, pitch, legH, max, x0, plotW, h: legH + spec.labels.length * pitch };
}

/** bars: one row per label, one bar per series inside it */
function bars(spec: ChartSpec, w: number): Geometry {
  const { ns, labW, barH, gap, pitch, legH, max, x0, plotW, h } = barLayout(spec, w);
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
export function lineLayout(spec: ChartSpec, w: number) {
  const ns = spec.series.length;
  const legH = ns > 1 ? 24 : 0;
  const plotH = 132;
  const xLabH = 18;
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
function line(spec: ChartSpec, w: number): Geometry {
  const { legH, plotH, ticks, yLabW, x0, every, xAt, yAt, h } = lineLayout(spec, w);
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

export function Chart({ spec }: { spec: ChartSpec }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  // a layout effect and the entry's CONTENT box: the first paint is already
  // the right size (never a zero-width chart for one frame) and a card resize
  // redraws once, without a resize listener of its own
  useLayoutEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    setW(el.clientWidth);
    const ro = new ResizeObserver(([entry]) => setW(Math.round(entry.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const geo = w > 0 ? (spec.kind === "line" ? line(spec, w) : bars(spec, w)) : null;
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
