import { useLayoutEffect, useState, type CSSProperties } from "react";

/** The stand-in the results pane shows while it refetches (E2 R3/R5).
 *
 * It is measured off the very grid it covers, never described independently:
 * the column the reader's eye is parked on has to be in the same place when
 * the bars replace it and again when the rows come back, and a second
 * description of the grid's geometry would drift from the first the day a
 * density token moves. Only the columns the virtualizer has mounted are
 * measured, which is exactly the columns on screen.
 */
interface Geometry {
  headerH: number;
  rowH: number;
  rows: number;
  cols: { left: number; width: number }[];
}

/** deterministic bar widths: a skeleton that reshuffles on every render reads
 * as loading data rather than as a held shape */
const barPct = (r: number, c: number) => 45 + ((r * 23 + c * 37) % 45);

function measure(host: HTMLElement | null): Geometry | null {
  if (!host) return null;
  const header = host.querySelector<HTMLElement>(".vgrid-header");
  const hcells = host.querySelectorAll<HTMLElement>(".vgrid-header .vgrid-hcell");
  if (!header || hcells.length === 0) return null;
  const box = host.getBoundingClientRect();
  const headerH = header.getBoundingClientRect().height;
  const rowH =
    host.querySelector<HTMLElement>(".vgrid-rownum")?.getBoundingClientRect().height ||
    parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue("--grid-rh"),
    ) ||
    headerH;
  const cols = [...hcells].map((el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left - box.left, width: r.width };
  });
  // the rows the virtualizer has on screen, not the viewport's capacity: a
  // fourteen-row table blanks fourteen rows and leaves the rest of the pane
  // the empty it already was
  const mounted = host.querySelectorAll(".vgrid-rownum").length;
  const fits = Math.ceil((box.height - headerH) / rowH);
  return { headerH, rowH, rows: Math.max(1, Math.min(mounted || fits, fits)), cols };
}

export function GridSkeleton({
  host,
  leaving,
}: {
  /** the pane the grid lives in; measured once, when the cycle starts */
  host: { current: HTMLElement | null };
  /** the fresh rows have landed: fade out over the grid coming back */
  leaving: boolean;
}) {
  const [geo, setGeo] = useState<Geometry | null>(null);
  // layout effect, so the measured bars paint in the same frame the grid
  // starts fading: a frame of nothing is the blank R3 forbids
  useLayoutEffect(() => setGeo(measure(host.current)), [host]);
  // the measure lands in the same commit; until it does there is nothing
  // truthful to draw, and an empty panel over the rows would be worse than
  // the frame of grid it replaces (R3)
  if (!geo) return null;
  const cell = (left: number, width: number, top: number, h: number): CSSProperties => ({
    left,
    width,
    top,
    height: h,
  });
  return (
    <div className={`grid-skel${leaving ? " leaving" : ""}`} aria-hidden="true">
      <div className="gs-header" style={{ height: geo.headerH }}>
        {geo.cols.map((c, i) => (
          <div key={i} className="gs-cell" style={cell(c.left, c.width, 0, geo.headerH)}>
            <span className="gs-bar" style={{ width: `${30 + ((i * 17) % 34)}%` }} />
          </div>
        ))}
      </div>
      {Array.from({ length: geo.rows }, (_, r) => (
        <div key={r} className="gs-row" style={{ top: geo.headerH + r * geo.rowH, height: geo.rowH }}>
          {geo.cols.map((c, i) => (
            <div key={i} className="gs-cell" style={cell(c.left, c.width, 0, geo.rowH)}>
              <span className="gs-bar" style={{ width: `${barPct(r, i)}%` }} />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
