import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
import { Clock } from "lucide-react";
import { popIn } from "../design/springs";
import { Kbd } from "../design/Kbd";
import * as ipc from "../ipc/commands";
import type { HistoryRow, HistoryStatus } from "../ipc/types";
import { useConnections } from "../stores/connections";
import { useTabs } from "../stores/tabs";
import { Modal } from "./overlay/Overlay";
import "./app.css";
import "./history.css";

/** appdb stamps UTC "YYYY-MM-DD HH:MM:SS": normalize to a parseable ISO */
const parseTs = (iso: string): Date =>
  new Date(iso.endsWith("Z") ? iso : iso.replace(" ", "T") + "Z");

function relTime(d: Date): string {
  const s = Math.max(0, (Date.now() - d.getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function dayLabel(d: Date): string {
  const now = new Date();
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((startOf(now) - startOf(d)) / 86400000);
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(d.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}),
  });
}

const norm = (sql: string) => sql.replace(/\s+/g, " ").trim();

const STATUS_FILTERS: (HistoryStatus | "all")[] = ["all", "ok", "error", "cancelled"];
/** chip display text. The filter VALUES above stay lowercase code tokens */
const STATUS_CHIP: Record<HistoryStatus | "all", string> = {
  all: "All",
  ok: "OK",
  error: "Error",
  cancelled: "Cancelled",
};
const STATUS_DOT: Record<HistoryStatus, string> = {
  ok: "var(--ok)",
  error: "var(--danger)",
  cancelled: "var(--fg-faint)",
};

/** one keyboard-navigable entry: a group head (newest run, ×N badge when the
 * group collapsed more) or an expanded member (older run of the same SQL) */
interface Run {
  row: HistoryRow;
  size: number;
  headId: number;
  member: boolean;
  /** non-ok runs hidden under a collapsed head, surfaced on the badge */
  hiddenErrs: number;
}

/** ⌘Y: searchable query history across every connection */
export function HistoryPanel({ onClose }: { onClose: () => void }) {
  const profiles = useConnections((s) => s.profiles);
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<HistoryRow[]>([]);
  const [fetchError, setFetchError] = useState(false);
  const [profileFilter, setProfileFilter] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<HistoryStatus | "all">("all");
  /** expanded group head row ids */
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  // debounced search; empty query = most recent. The per-connection chip is
  // pushed into history_search (its API already filters by profile); the
  // status chips filter client-side (grouping is client-side anyway).
  useEffect(() => {
    // stale guard: a slow older response resolving after a newer one must not
    // overwrite it (the timeout debounces the CALL, not the response)
    let stale = false;
    const t = setTimeout(() => {
      void ipc
        .historySearch(query, profileFilter, 100)
        .then((r) => {
          if (stale) return;
          setRows(r);
          setFetchError(false);
          setActive(0);
        })
        .catch(() => {
          if (stale) return;
          // an empty list would lie: say the fetch failed
          setRows([]);
          setFetchError(true);
        });
    }, query ? 120 : 0);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [query, profileFilter]);

  const filtered = useMemo(
    () => (statusFilter === "all" ? rows : rows.filter((r) => r.status === statusFilter)),
    [rows, statusFilter],
  );

  // group adjacent runs of the same RAW SQL on the same connection. Raw
  // equality, never normalized: whitespace inside string literals is data,
  // and two queries differing only there must not collapse into one entry
  const groups = useMemo(() => {
    const gs: HistoryRow[][] = [];
    for (const r of filtered) {
      const last = gs[gs.length - 1];
      if (last && last[0].sql === r.sql && last[0].profile_id === r.profile_id) {
        last.push(r);
      } else {
        gs.push([r]);
      }
    }
    return gs;
  }, [filtered]);

  // flatten (respecting expansion) and interleave day dividers; `runs` is the
  // keyboard-navigable list, `items` the render list. Dividers are computed
  // per RENDERED row (head and expanded members alike) so a group whose
  // members cross midnight gets a divider at the boundary instead of filing
  // older runs under the head's day.
  const { items, runs } = useMemo(() => {
    const items: ({ divider: string } | { run: Run; runIdx: number })[] = [];
    const runs: Run[] = [];
    let day = "";
    const push = (run: Run) => {
      const label = dayLabel(parseTs(run.row.ran_at));
      if (label !== day) {
        items.push({ divider: label });
        day = label;
      }
      items.push({ run, runIdx: runs.length });
      runs.push(run);
    };
    for (const g of groups) {
      const open = expanded.has(g[0].id);
      push({
        row: g[0],
        size: g.length,
        headId: g[0].id,
        member: false,
        hiddenErrs: open ? 0 : g.slice(1).filter((r) => r.status !== "ok").length,
      });
      if (g.length > 1 && open) {
        for (const r of g.slice(1)) {
          push({ row: r, size: g.length, headId: g[0].id, member: true, hiddenErrs: 0 });
        }
      }
    }
    return { items, runs };
  }, [groups, expanded]);

  useEffect(() => {
    setActive((a) => Math.max(0, Math.min(runs.length - 1, a)));
  }, [runs.length]);

  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-i="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const toggle = (headId: number) =>
    setExpanded((s) => {
      const n = new Set(s);
      if (n.has(headId)) n.delete(headId);
      else n.add(headId);
      return n;
    });

  const openRow = (r: HistoryRow) => {
    useTabs.getState().newTab(r.sql);
    onClose();
  };

  const profileName = (id: string) =>
    profiles.find((p) => p.id === id)?.name || "deleted connection";

  const runRow = (run: Run, runIdx: number) => {
    const r = run.row;
    const ts = parseTs(r.ran_at);
    return (
      <button
        key={`${r.id}${run.member ? "m" : ""}`}
        data-i={runIdx}
        className={`history-row${runIdx === active ? " hot" : ""}${run.member ? " member" : ""}`}
        onClick={() => openRow(r)}
        onMouseMove={() => setActive(runIdx)}
      >
        {!run.member && (
          <span className="history-sqlline">
            <span className="history-sql">{norm(r.sql)}</span>
            {run.size > 1 && (
              <span
                role="button"
                className={`history-xn${expanded.has(run.headId) ? " active" : ""}${run.hiddenErrs > 0 ? " has-err" : ""}`}
                title={`${run.size} ${
                  // a status-chip filter can glue runs that were NOT adjacent
                  // in real history: don't claim "consecutive" there
                  statusFilter === "all"
                    ? "consecutive identical runs"
                    : "identical runs (may be non-consecutive, the list is filtered)"
                } · click to ${
                  expanded.has(run.headId) ? "collapse" : "expand"
                }${run.hiddenErrs > 0 ? ` · ${run.hiddenErrs} not ok` : ""}`}
                onClick={(e) => {
                  e.stopPropagation();
                  toggle(run.headId);
                }}
              >
                ×{run.size}
              </span>
            )}
          </span>
        )}
        <span className="history-meta">
          {r.status !== "ok" && (
            <span className={`history-dot ${r.status}`} title={r.status} />
          )}
          {r.status !== "ok" && `${r.status} · `}
          {profileName(r.profile_id)} · {r.rows} rows · {Math.round(r.ms)}ms ·{" "}
          <span className="history-when" title={ts.toLocaleString()}>
            {relTime(ts)}
          </span>
        </span>
      </button>
    );
  };

  return (
    <Modal
      label="Query History"
      onClose={onClose}
      onKey={(e) => {
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          setActive((a) =>
            Math.max(0, Math.min(runs.length - 1, a + (e.key === "ArrowDown" ? 1 : -1))),
          );
        }
        if (e.key === "ArrowRight") {
          const r = runs[active];
          if (r && !r.member && r.size > 1 && !expanded.has(r.headId)) {
            e.preventDefault();
            toggle(r.headId);
          }
        }
        if (e.key === "ArrowLeft") {
          const r = runs[active];
          if (r && expanded.has(r.headId)) {
            e.preventDefault();
            // land on the group head (indexes before it are unaffected)
            setActive(runs.findIndex((x) => x.headId === r.headId));
            toggle(r.headId);
          }
        }
        if (e.key === "Enter" && runs[active]) {
          e.preventDefault();
          openRow(runs[active].row);
        }
      }}
    >
      <motion.div className="history-panel" {...popIn}>
        <div className="history-head">
          <Clock size={14} />
          <input
            autoFocus
            placeholder="Search query history…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <span className="history-count">{filtered.length}</span>
        </div>
        <div className="history-chips">
          <button
            className={`history-chip${profileFilter === null ? " active" : ""}`}
            onClick={() => setProfileFilter(null)}
          >
            All
          </button>
          {profiles.map((p) => (
            <button
              key={p.id}
              className={`history-chip${profileFilter === p.id ? " active" : ""}`}
              onClick={() => setProfileFilter(profileFilter === p.id ? null : p.id)}
            >
              <span
                className="history-chip-dot"
                style={{ background: p.color ?? "var(--accent)" }}
              />
              {p.name}
            </button>
          ))}
          <span className="history-chips-sep" />
          {STATUS_FILTERS.map((s) => (
            <button
              key={s}
              className={`history-chip${statusFilter === s ? " active" : ""}`}
              onClick={() => setStatusFilter(s)}
            >
              {s !== "all" && (
                <span className="history-chip-dot" style={{ background: STATUS_DOT[s] }} />
              )}
              {STATUS_CHIP[s]}
            </button>
          ))}
        </div>
        <div className="history-list" ref={listRef}>
          {runs.length === 0 && (
            <div className="history-empty">
              {fetchError
                ? "Couldn’t load history"
                : query || statusFilter !== "all" || profileFilter
                  ? "No matches"
                  : "No queries yet. Queries you run appear here"}
            </div>
          )}
          {items.map((it, i) =>
            "divider" in it ? (
              <div key={`d${i}`} className="history-day">
                {it.divider}
              </div>
            ) : (
              runRow(it.run, it.runIdx)
            ),
          )}
        </div>
        <div className="history-foot">
          <Kbd chord="up" />
          <Kbd chord="down" /> navigate · <Kbd chord="right" />/<Kbd chord="left" /> expand/collapse
          · <Kbd chord="return" /> open in new tab · <Kbd chord="esc" /> close
        </div>
      </motion.div>
    </Modal>
  );
}
