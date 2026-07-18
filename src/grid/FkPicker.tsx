// FK-cell picker (Postico parity): while editing a foreign-key cell, pick the
// referenced row from a live-searched list instead of typing the key blind.
// Anchored overlay (own esc-stack entry — Esc closes the picker, not the cell
// editor); the search runs a read-only SELECT on the tab's EXISTING session
// (never a new one), debounced ~200ms, identifiers/literals quoted through
// the shared safe helpers only. Errors render here, honestly.
import { useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { menuIn } from "../design/springs";
import { AnchoredOverlay } from "../app/overlay/Overlay";
import * as ipc from "../ipc/commands";
import { useResults } from "../stores/results";
import { fkPickerSql, type FkPickTarget } from "./spelunkLogic";
import "./grid.css";

const DEBOUNCE_MS = 200;

export function FkPicker({
  point,
  target,
  onPick,
  onClose,
}: {
  point: { x: number; y: number };
  target: FkPickTarget;
  /** stage the picked referenced-key value through the editor-commit path */
  onPick: (value: string) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<(string | null)[][]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const seq = useRef(0);
  const firstFetch = useRef(true);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // the ACTIVE tab's session — the same one the result ran on; a picker on
    // a dead session reports instead of silently showing nothing
    const sessionId = useResults.getState().executedSessionId;
    if (!sessionId) {
      setErr("no live session for this tab");
      setLoading(false);
      return;
    }
    const id = ++seq.current;
    setLoading(true);
    const delay = firstFetch.current ? 0 : DEBOUNCE_MS;
    firstFetch.current = false;
    const t = setTimeout(() => {
      ipc
        .execute(sessionId, fkPickerSql(target, q))
        .then((out) => {
          if (seq.current !== id) return; // superseded by newer keystroke
          setRows(out.statements[0]?.rows ?? []);
          setErr(null);
          setActive(0);
        })
        .catch((e) => {
          if (seq.current !== id) return;
          setErr((e as { message?: string }).message ?? String(e));
        })
        .finally(() => {
          if (seq.current === id) setLoading(false);
        });
    }, delay);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, target]);

  // keyboard nav keeps the active row visible
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-i="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const pick = (row: (string | null)[] | undefined) => {
    const v = row?.[0];
    if (v == null) return; // a NULL referenced key can't be staged from here
    onPick(v);
  };

  return (
    <AnchoredOverlay
      point={point}
      onClose={onClose}
      onKey={(e) => {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          e.stopImmediatePropagation();
          setActive((c) => Math.min(rows.length - 1, c + 1));
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          e.stopImmediatePropagation();
          setActive((c) => Math.max(0, c - 1));
        } else if (e.key === "Enter") {
          e.preventDefault();
          e.stopImmediatePropagation();
          pick(rows[active]);
        }
      }}
    >
      <motion.div className="fkpick" {...menuIn}>
        <input
          className="fkpick-input"
          // eslint-disable-next-line jsx-a11y/no-autofocus
          autoFocus
          value={q}
          placeholder={`Search ${target.table}…`}
          spellCheck={false}
          onChange={(e) => setQ(e.target.value)}
        />
        <div className="fkpick-list" ref={listRef}>
          {err ? (
            <div className="fkpick-err">{err}</div>
          ) : rows.length === 0 && !loading ? (
            <div className="fkpick-empty">no matching rows</div>
          ) : (
            rows.map((r, i) => (
              <div
                key={i}
                data-i={i}
                className={`fkpick-row${i === active ? " hot" : ""}${r[0] == null ? " disabled" : ""}`}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(r)}
              >
                <span className="fkpick-key">
                  {r[0] == null ? <span className="vgrid-nullchip">NULL</span> : r[0]}
                </span>
                {target.labelCols.length > 0 && (
                  <span className="fkpick-labels">
                    {r
                      .slice(1)
                      .map((v) => (v === null ? "NULL" : v === "" ? "∅" : v))
                      .join(" · ")}
                  </span>
                )}
              </div>
            ))
          )}
        </div>
        <div className="fkpick-foot">
          <span>
            {loading
              ? "searching…"
              : err
                ? `${target.schema === "public" ? "" : `${target.schema}.`}${target.table}`
                : `${rows.length}${rows.length === 50 ? " (first 50)" : ""} row${rows.length === 1 ? "" : "s"} · ${target.refCol}`}
          </span>
          <span className="fkpick-keys">↑↓ · ↩ pick · esc</span>
        </div>
      </motion.div>
    </AnchoredOverlay>
  );
}
