// One-row results (AGENT-UX section 2 item 4, W2c finding 7): a table of one
// cell is chrome around nothing, so a run of exactly one row renders as
// values, not as a grid. One column: the value in the data register (mono,
// tabular, the answer's one big number) with the column name as its caption.
// Two to four columns: name over value, one pair per column, stacked in a
// single column until the slot is 480px wide and flowing as a row of pairs
// from there (ask.css .ans-kv; the wrapper is the container the query reads).
// Five or more: the grid, which is the honest shape for that many facts.
//
// The values are the grid's truth in the grid's registers: NULL and '' wear
// the grid's own chips (grid.css), text stays wire text, and only a numeric
// value gains thousands separators, by string surgery on the integer part
// (Intl over BigInt, never Number: LESSONS 2, past 2^53 the digits change).
// Everything is plain selectable text; ⌘C copies what is selected (DESIGN
// rule 11: no copy button to discover).

import type { AgentRun } from "../agent/types";
import "../grid/grid.css";

/** the widest one-row result that reads as values rather than a grid */
export const SCALAR_MAX_COLS = 4;

export const isScalarRun = (run: AgentRun): boolean =>
  run.rows.length === 1 && run.columns.length >= 1 && run.columns.length <= SCALAR_MAX_COLS;

// integer / decimal wire shapes with no leading zero (a zip code, a padded id
// and a year with a leading zero are text that happens to be digits)
const INT = /^(0|[1-9]\d*)$/;
const DEC = /^(0|[1-9]\d*)\.(\d+)$/;

const grouped = new Intl.NumberFormat(undefined, { useGrouping: true, maximumFractionDigits: 0 });
const DECIMAL_SEP =
  new Intl.NumberFormat(undefined).formatToParts(1.5).find((p) => p.type === "decimal")?.value ?? ".";

/** `48213` → `48,213`, `-1234.50` → `-1,234.50`, anything else verbatim */
export function groupDigits(v: string): string {
  const neg = v.startsWith("-");
  const body = neg ? v.slice(1) : v;
  const sign = neg ? "-" : "";
  if (INT.test(body)) return sign + grouped.format(BigInt(body));
  const m = DEC.exec(body);
  if (!m) return v;
  return `${sign}${grouped.format(BigInt(m[1]))}${DECIMAL_SEP}${m[2]}`;
}

function Value({ v }: { v: string | null }) {
  if (v === null) return <span className="vgrid-nullchip">NULL</span>;
  if (v === "") return <span className="vgrid-emptychip">∅ empty</span>;
  return <>{groupDigits(v)}</>;
}

/** the big register is for a value read at a glance (a count, a sum, a
 * date); past this many characters (a URL, a UUID, a sentence) the value
 * drops to the stacked form's register and wraps as text */
const GLANCE_CHARS = 24;

export function ScalarResult({ run }: { run: AgentRun }) {
  const row = run.rows[0] ?? [];
  if (run.columns.length === 1) {
    const v = row[0] ?? null;
    const long = v !== null && groupDigits(v).length > GLANCE_CHARS;
    return (
      <div className="ans-scalar">
        <span className={`ans-scalar-v${long ? " long" : ""}`}>
          <Value v={v} />
        </span>
        <span className="ans-scalar-k">{run.columns[0]}</span>
      </div>
    );
  }
  return (
    <div className="ans-kv-slot">
      <dl className="ans-kv">
        {run.columns.map((name, i) => (
          <div className="ans-kv-row" key={`${i}:${name}`}>
            <dt className="ans-kv-k">{name}</dt>
            <dd className="ans-kv-v">
              <Value v={row[i] ?? null} />
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
