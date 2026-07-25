// Searchable function palette: insert any of the 3.5k pg functions without
// polluting the typed completion flow.
import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
import { popIn } from "../design/springs";
import type { EditorView } from "@codemirror/view";
import { useConnections } from "../stores/connections";
import { useSchema, type FuncInfo } from "../stores/schema";
import { bumpUsage } from "./completion/usage";
import "./editor.css";

function score(needle: string, hay: string): number {
  if (hay.startsWith(needle)) return 3;
  if (hay.includes(needle)) return 2;
  let i = 0;
  for (const ch of hay) {
    if (ch === needle[i]) i++;
    if (i === needle.length) return 1;
  }
  return needle.length === 0 ? 1 : 0;
}

export function FnSearch({ view, onClose }: { view: EditorView; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const activeProfileId = useConnections((s) => s.activeProfileId);
  const snapshot = useSchema((s) =>
    activeProfileId ? s.snapshots[activeProfileId] : undefined,
  );

  const matches = useMemo(() => {
    const fns = snapshot?.functions ?? [];
    const q = query.toLowerCase();
    return fns
      .map((f) => ({ f, s: score(q, f.name.toLowerCase()) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s || a.f.name.length - b.f.name.length)
      .slice(0, 60)
      .map((x) => x.f);
  }, [snapshot, query]);

  useEffect(() => setSelected(0), [query]);

  const insert = (f: FuncInfo) => {
    bumpUsage("fn", f.name);
    const sel = view.state.selection.main;
    view.dispatch({
      changes: { from: sel.from, to: sel.to, insert: `${f.name}()` },
      selection: { anchor: sel.from + f.name.length + 1 },
    });
    onClose();
    view.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      view.focus();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected((s) => Math.min(matches.length - 1, s + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((s) => Math.max(0, s - 1));
    } else if (e.key === "Enter" && matches[selected]) {
      e.preventDefault();
      insert(matches[selected]);
    }
  };

  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-i="${selected}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  return (
    <div className="fn-search-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <motion.div className="fn-search" {...popIn}>
        <input
          autoFocus
          placeholder="Search functions…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="fn-list" ref={listRef}>
          {matches.map((f, i) => (
            <div
              key={`${f.schema}.${f.name}.${i}`}
              data-i={i}
              className={`fn-item${i === selected ? " hot" : ""}`}
              onMouseDown={(e) => {
                e.preventDefault();
                insert(f);
              }}
              onMouseEnter={() => setSelected(i)}
            >
              <span className="fn-name">{f.name}</span>
              <span className="fn-sig">({f.args}) → {f.returns}</span>
            </div>
          ))}
          {matches.length === 0 && <div className="fn-empty">No matches</div>}
        </div>
      </motion.div>
    </div>
  );
}
