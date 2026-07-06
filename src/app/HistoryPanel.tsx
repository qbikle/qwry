import { useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { Clock } from "lucide-react";
import { popIn } from "../design/springs";
import * as ipc from "../ipc/commands";
import type { HistoryRow } from "../ipc/types";
import { useConnections } from "../stores/connections";
import { useTabs } from "../stores/tabs";
import { Modal } from "./overlay/Overlay";
import "./app.css";

function relTime(iso: string): string {
  const then = new Date(iso.endsWith("Z") ? iso : iso + "Z").getTime();
  const s = Math.max(0, (Date.now() - then) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** ⌘Y — searchable query history across every connection */
export function HistoryPanel({ onClose }: { onClose: () => void }) {
  const profiles = useConnections((s) => s.profiles);
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<HistoryRow[]>([]);
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  // debounced search; empty query = most recent
  useEffect(() => {
    const t = setTimeout(() => {
      void ipc
        .historySearch(query, null, 100)
        .then((r) => {
          setRows(r);
          setActive(0);
        })
        .catch(() => setRows([]));
    }, query ? 120 : 0);
    return () => clearTimeout(t);
  }, [query]);

  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-i="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const openRow = (r: HistoryRow) => {
    useTabs.getState().newTab(r.sql);
    onClose();
  };

  const profileName = (id: string) =>
    profiles.find((p) => p.id === id)?.name || "deleted connection";

  return (
    <Modal
      onClose={onClose}
      onKey={(e) => {
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          setActive((a) =>
            Math.max(0, Math.min(rows.length - 1, a + (e.key === "ArrowDown" ? 1 : -1))),
          );
        }
        if (e.key === "Enter" && rows[active]) {
          e.preventDefault();
          openRow(rows[active]);
        }
      }}
    >
      <motion.div className="history-panel" {...popIn}>
        <div className="history-head">
          <Clock size={13} />
          <input
            autoFocus
            placeholder="Search query history…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <span className="history-count">{rows.length}</span>
        </div>
        <div className="history-list" ref={listRef}>
          {rows.length === 0 && (
            <div className="history-empty">
              {query ? "No matches." : "No queries yet."}
            </div>
          )}
          {rows.map((r, i) => (
            <button
              key={r.id}
              data-i={i}
              className={`history-row${i === active ? " active" : ""}`}
              onClick={() => openRow(r)}
              onMouseMove={() => setActive(i)}
            >
              <span className="history-sql">{r.sql.replace(/\s+/g, " ")}</span>
              <span className="history-meta">
                {profileName(r.profile_id)} · {r.rows} rows · {Math.round(r.ms)}ms ·{" "}
                {relTime(r.ran_at)}
              </span>
            </button>
          ))}
        </div>
        <div className="history-foot">↑↓ navigate · ↵ open in new tab · esc close</div>
      </motion.div>
    </Modal>
  );
}
