// Distinct-value histogram ("Value distribution" in the header menu).
// Browse tabs run a real GROUP BY on the table over an existing session
// (primary preferred: the tab session is ⌘. cancel's target; plus the
// compiled filter WHERE when the browse store exports it, otherwise
// unfiltered, and the panel says so). Editor results (and json columns,
// which have no server-side equality) bucket client-side over the LOADED
// rows and label the scope honestly. Rendered with tokens only; NULL is its
// own labeled bucket, excluded from the distinct count.
import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { menuIn } from "../design/springs";
import { AnchoredOverlay } from "../app/overlay/Overlay";
import * as ipc from "../ipc/commands";
import {
  bucketize,
  histogramSql,
  HISTOGRAM_TOP,
  type HistBucket,
} from "./spelunkLogic";
import "./grid.css";

export type HistogramMode =
  | {
      kind: "server";
      sessionId: string;
      schema: string;
      table: string;
      where: string | null;
      /** honesty label (e.g. filters not applied); null = clean scope */
      note: string | null;
      /** loaded-row values for the client-side fallback when the server
       * GROUP BY has no equality operator for the type (42883) */
      fallbackValues: (string | null)[];
    }
  | {
      kind: "client";
      values: (string | null)[];
      /** honest scope label, always present ("loaded N rows only", …) */
      note: string;
    };

interface HistResult {
  buckets: HistBucket[];
  total: number;
  /** distinct NON-NULL values: the NULL bucket is labeled separately */
  distinct: number;
  hasNull: boolean;
}

/** per-session epoch for the server GROUP BY: the unmount cancel is only
 * valid while its own epoch is still the latest (same guard as
 * cancelExactCount: the shared primary session may already be running a
 * NEWER query a stale cancel must not kill) */
const histEpoch = new Map<string, number>();

const fmtPct = (share: number): string => {
  const pct = share * 100;
  if (pct > 0 && pct < 1) return "<1%";
  return `${Math.round(pct)}%`;
};

export function Histogram({
  point,
  column,
  mode,
  onClose,
}: {
  point: { x: number; y: number };
  column: string;
  mode: HistogramMode;
  onClose: () => void;
}) {
  const [res, setRes] = useState<HistResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  /** server GROUP BY fell back to client bucketing: its honest scope label */
  const [fallbackNote, setFallbackNote] = useState<string | null>(null);

  useEffect(() => {
    let stale = false;
    if (mode.kind === "client") {
      setRes(bucketize(mode.values));
      return;
    }
    const sid = mode.sessionId;
    const epoch = (histEpoch.get(sid) ?? 0) + 1;
    histEpoch.set(sid, epoch);
    let inflight = true;
    ipc
      .execute(
        sid,
        histogramSql({ schema: mode.schema, table: mode.table, column, where: mode.where }),
      )
      .then((out) => {
        if (stale) return;
        const rows = out.statements[0]?.rows ?? [];
        const total = rows.length > 0 ? Number(rows[0][2]) : 0;
        const groups = rows.length > 0 ? Number(rows[0][3]) : 0;
        const distinct = rows.length > 0 ? Number(rows[0][4]) : 0;
        setRes({
          total,
          distinct,
          hasNull: groups > distinct,
          buckets: rows.map((r) => {
            const count = Number(r[1]);
            return { value: r[0], count, share: total > 0 ? count / total : 0 };
          }),
        });
      })
      .catch((e) => {
        if (stale) return;
        // 42883 (undefined function) = no equality operator for the type
        // (domain-over-json class): the server can't GROUP BY it; bucket the
        // LOADED rows client-side and label the scope honestly
        if (((e as { code?: string | null }).code ?? null) === "42883") {
          setRes(bucketize(mode.fallbackValues));
          setFallbackNote(
            `no server-side equality for this type · computed over ${mode.fallbackValues.length.toLocaleString()} loaded rows`,
          );
          return;
        }
        setErr((e as { message?: string }).message ?? String(e));
      })
      .finally(() => {
        inflight = false;
      });
    return () => {
      stale = true;
      // closing the popup must kill the GROUP BY, not just mute its writes:
      // existing escalating cancel path (CancelToken → pg_cancel_backend).
      // Deferred a tick + epoch re-checked: StrictMode's dev double-mount
      // runs this cleanup while mount #2's query is launching, and a
      // same-tick cancel would land on the NEW query on the shared session
      if (inflight && histEpoch.get(sid) === epoch) {
        queueMicrotask(() => {
          if (histEpoch.get(sid) === epoch) void ipc.cancel(sid).catch(() => {});
        });
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const note = fallbackNote ?? mode.note;

  return (
    <AnchoredOverlay point={point} onClose={onClose} role="dialog" label={`${column} Value Distribution`}>
      <motion.div className="histo" {...menuIn}>
        <div className="histo-head">
          <span className="histo-col">{column}</span>
          <span className="histo-sub">Value Distribution</span>
        </div>
        {err ? (
          <div className="histo-err">{err}</div>
        ) : !res ? (
          <div className="histo-loading">computing…</div>
        ) : res.total === 0 ? (
          <div className="histo-empty">No rows</div>
        ) : (
          <div className="histo-rows">
            {res.buckets.map((b, i) => (
              <div key={i} className="histo-row" title={b.value ?? "NULL"}>
                <span
                  className="histo-bar"
                  style={{ width: `${Math.max(1.5, b.share * 100)}%` }}
                />
                <span className={`histo-val${b.value === null ? " null" : ""}`}>
                  {b.value === null ? (
                    <span className="vgrid-nullchip">NULL</span>
                  ) : b.value === "" ? (
                    <span className="vgrid-emptychip">∅ empty</span>
                  ) : (
                    b.value
                  )}
                </span>
                <span className="histo-count">{b.count.toLocaleString()}</span>
                <span className="histo-pct">{fmtPct(b.share)}</span>
              </div>
            ))}
          </div>
        )}
        {res && !err && (
          <div className="histo-foot">
            {res.distinct + (res.hasNull ? 1 : 0) > HISTOGRAM_TOP ? `top ${HISTOGRAM_TOP} of ` : ""}
            {res.distinct.toLocaleString()} distinct{res.hasNull ? " + NULL" : ""} ·{" "}
            {res.total.toLocaleString()} rows
          </div>
        )}
        {note && <div className="histo-note">{note}</div>}
      </motion.div>
    </AnchoredOverlay>
  );
}
