// ⌘F bar over the loaded result rows — same chrome/keys as JsonTree's search
// (⏎/⇧⏎ next/prev · Esc close · match count). Scoped honestly to loaded rows.
import { useEffect, useRef } from "react";
import { ChevronDown, ChevronUp, Search, X } from "lucide-react";
import type { StatementState } from "../stores/results";
import { useGridFilter } from "../stores/gridFilter";
import { useFind, type FindHit } from "../stores/find";

const HIT_CAP = 5000;

export function FindBar({ stmt }: { stmt: StatementState }) {
  const query = useFind((s) => s.query);
  const idx = useFind((s) => s.idx);
  const hits = useFind((s) => s.hits);
  const hitCapped = useFind((s) => s.hitCapped);
  const focusSeq = useFind((s) => s.focusSeq);
  const setQuery = useFind((s) => s.setQuery);
  const setResults = useFind((s) => s.setResults);
  const step = useFind((s) => s.step);
  const close = useFind((s) => s.close);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusSeq]);

  // recompute matches (debounced) whenever the query, the loaded rows or the
  // grid's hidden-column set change. Hidden columns are skipped — a "current
  // hit" the grid can't scroll to reads as a frozen find
  const rows = stmt.rows;
  const hiddenCols = useGridFilter((s) => s.hiddenCols);
  useEffect(() => {
    const t = setTimeout(() => {
      const q = query.trim().toLowerCase();
      if (!q) {
        setResults([], false);
        return;
      }
      const found: FindHit[] = [];
      outer: for (let r = 0; r < rows.length; r++) {
        const row = rows[r];
        for (let c = 0; c < row.length; c++) {
          if (hiddenCols.has(c)) continue;
          const v = row[c];
          // NULL never matches text — searching "null" must not lie
          if (v !== null && v.toLowerCase().includes(q)) {
            found.push({ r, c });
            if (found.length >= HIT_CAP) break outer;
          }
        }
      }
      setResults(found, found.length >= HIT_CAP);
    }, 120);
    return () => clearTimeout(t);
  }, [query, rows, stmt.index, hiddenCols, setResults]);

  // leaving the surface (tab switch, structure toggle) drops stale hits
  useEffect(() => () => setResults([], false), [setResults]);

  const count =
    query.trim() === ""
      ? ""
      : hits.length === 0
        ? "No matches"
        : `${idx + 1} of ${hitCapped ? `${HIT_CAP.toLocaleString()}+` : hits.length.toLocaleString()}`;

  return (
    <div className="find-bar">
      <Search size={12} className="find-icon" />
      <input
        ref={inputRef}
        placeholder="Find in results…"
        value={query}
        spellCheck={false}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          // swallow only unmodified typing keys — ⌘/⌃ chords must bubble to
          // the window shortcuts (⌘I, ⌘G step, …) or they die while finding
          if (!e.metaKey && !e.ctrlKey) e.stopPropagation();
          if (e.key === "Enter") {
            e.preventDefault();
            step(e.shiftKey ? -1 : 1);
          } else if (e.key === "Escape") {
            e.preventDefault();
            close();
          }
        }}
      />
      <span className="find-count">{count}</span>
      <button className="find-btn" title="Previous ⇧⏎" onClick={() => step(-1)}>
        <ChevronUp size={13} />
      </button>
      <button className="find-btn" title="Next ⏎" onClick={() => step(1)}>
        <ChevronDown size={13} />
      </button>
      {stmt.capped && (
        <span
          className="find-capped"
          title={`Result capped — find only sees the ${stmt.rows.length.toLocaleString()} loaded rows of ${stmt.rowCount.toLocaleString()}`}
        >
          loaded {stmt.rows.length.toLocaleString()} of {stmt.rowCount.toLocaleString()} rows
        </span>
      )}
      <button className="find-btn" title="Close esc" onClick={close}>
        <X size={13} />
      </button>
    </div>
  );
}
