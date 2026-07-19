import { useEffect, useRef, useState } from "react";
import { Pin, Plus, SquareTerminal, Table, X } from "lucide-react";
import { useSaved } from "../stores/saved";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { useTabs, visibleTabs } from "../stores/tabs";
import { useCloseGuard } from "../stores/closeGuard";
import { skey, useConnections } from "../stores/connections";
import { ContextMenu, type MenuNode } from "../app/overlay/ContextMenu";
import { AnchoredOverlay } from "../app/overlay/Overlay";
import { motion } from "motion/react";
import { popIn } from "../design/springs";
import "./editor.css";

export function TabBar() {
  const allTabs = useTabs((s) => s.tabs);
  const pinnedSet = useTabs((s) => s.pinned);
  const activeProfileIdSel = useConnections((s) => s.activeProfileId);
  const profiles = useConnections((s) => s.profiles);
  // per-connection workspace: only this connection's tabs + pins + legacy
  const tabs = visibleTabs(allTabs, pinnedSet, activeProfileIdSel);
  const activeId = useTabs((s) => s.activeId);
  const select = useTabs((s) => s.select);
  const requestClose = useCloseGuard((s) => s.request);
  const newTab = useTabs((s) => s.newTab);
  const rename = useTabs((s) => s.rename);
  const closeOthers = useTabs((s) => s.closeOthers);
  const closeToRight = useTabs((s) => s.closeToRight);
  const closeAll = useTabs((s) => s.closeAll);
  const saveError = useTabs((s) => s.saveError);
  const pinned = pinnedSet;
  const togglePin = useTabs((s) => s.togglePin);
  /** pin badge: origin connection's color + name (orphan = origin deleted) */
  const pinMeta = (t: { profile_id: string | null }) => {
    const origin = profiles.find((p) => p.id === t.profile_id);
    return {
      color: origin?.color ?? "var(--accent)",
      label: origin
        ? `Pinned — ${origin.name || origin.host}`
        : t.profile_id === null
          ? "Pinned"
          : "Pinned — origin connection deleted",
    };
  };
  const savedQueries = useSaved((s) => s.queries);
  // bookmarked tab whose buffer drifted from the saved copy → dirty dot
  const savedDirty = (t: { saved_id: string | null; sql: string }) =>
    !!t.saved_id && savedQueries.some((q) => q.id === t.saved_id && q.sql !== t.sql);
  // file-backed tab whose buffer drifted from the on-disk copy → same dot
  const fileDirty = (t: { file_path?: string; file_saved_sql?: string; sql: string }) =>
    t.file_path != null && t.sql !== t.file_saved_sql;
  const isDirty = (t: {
    saved_id: string | null;
    sql: string;
    file_path?: string;
    file_saved_sql?: string;
  }) => savedDirty(t) || fileDirty(t);
  const activeProfileId = useConnections((s) => s.activeProfileId);
  const txTabs = useConnections((s) => s.txTabs);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  const [pinInfo, setPinInfo] = useState<{ x: number; y: number; id: string } | null>(null);
  const activeRef = useRef<HTMLDivElement>(null);
  const newBtnRef = useRef<HTMLButtonElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const moveTab = useTabs((s) => s.moveTab);
  // drag-reorder: threshold keeps plain clicks as select; dropIdx is the
  // INSERTION boundary (0..tabs.length); a line marks it while dragging
  const dragState = useRef<{ fromIdx: number; started: boolean; startX: number } | null>(null);
  const [dropIdx, setDropIdx] = useState<number | null>(null);

  const boundaryFromX = (clientX: number): number => {
    const strip = stripRef.current;
    if (!strip) return 0;
    const els = [...strip.querySelectorAll<HTMLElement>(".tab")];
    for (let i = 0; i < els.length; i++) {
      const r = els[i].getBoundingClientRect();
      if (clientX < r.left + r.width / 2) return i;
    }
    return els.length;
  };

  const beginTabDrag = (idx: number, e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const t = e.target as HTMLElement;
    if (t.closest(".tab-close") || t.tagName === "INPUT") return;
    dragState.current = { fromIdx: idx, started: false, startX: e.clientX };
    const onMove = (me: MouseEvent) => {
      const d = dragState.current;
      if (!d) return;
      if (!d.started && Math.abs(me.clientX - d.startX) < 5) return;
      d.started = true;
      setDropIdx(boundaryFromX(me.clientX));
    };
    const onUp = (me: MouseEvent) => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      const d = dragState.current;
      dragState.current = null;
      setDropIdx(null);
      if (d?.started) {
        const to = boundaryFromX(me.clientX);
        if (to !== d.fromIdx && to !== d.fromIdx + 1) moveTab(d.fromIdx, to);
      }
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  // keep the active tab in view: slide the strip just enough to reveal it (no
  // movement when it's already visible). When it's the last tab, reveal the +
  // button instead so it stays visible alongside the tab.
  useEffect(() => {
    const lastActive = tabs.length > 0 && tabs[tabs.length - 1].id === activeId;
    const el = lastActive ? newBtnRef.current : activeRef.current;
    el?.scrollIntoView({ behavior: "smooth", inline: "nearest", block: "nearest" });
  }, [activeId, tabs.length]);

  const tabMenu = (id: string): MenuNode[] => {
    const t = tabs.find((x) => x.id === id);
    if (!t) return [];
    const idx = tabs.findIndex((x) => x.id === id);
    const items: MenuNode[] = [
      {
        kind: "item",
        label: pinned.has(id) ? "Unpin" : "Pin",
        onSelect: () => togglePin(id),
      },
      {
        kind: "item",
        label: "Rename",
        onSelect: () => {
          setRenaming(id);
          setDraft(t.name);
        },
      },
    ];
    if (t.kind === "query") {
      items.push({ kind: "item", label: "Duplicate", onSelect: () => newTab(t.sql, t.name) });
      items.push({
        kind: "item",
        label: "Copy SQL",
        disabled: !t.sql.trim(),
        onSelect: () => void writeText(t.sql),
      });
    }
    items.push({ kind: "sep" });
    items.push({ kind: "item", label: "Close", hint: "⌘W", onSelect: () => requestClose(id) });
    if (tabs.length > 1)
      items.push({ kind: "item", label: "Close others", onSelect: () => closeOthers(id) });
    if (idx < tabs.length - 1)
      items.push({ kind: "item", label: "Close to the right", onSelect: () => closeToRight(id) });
    items.push({ kind: "item", label: "Close all", onSelect: () => closeAll() });
    return items;
  };

  return (
    // NB: no dbl-click-new-tab here — the strip is a tauri drag region, and
    // macOS double-click-to-zoom on drag regions would fire alongside it
    <div className="tabbar" data-tauri-drag-region ref={stripRef}>
      {tabs.map((t, i) => (
        <div
          key={t.id}
          ref={t.id === activeId ? activeRef : null}
          className={`tab${t.id === activeId ? " active" : ""}${
            pinned.has(t.id) ? " is-pinned" : ""
          }${dropIdx !== null && dragState.current?.fromIdx === i ? " dragging" : ""}${
            dropIdx === i ? " drop-before" : ""
          }${dropIdx === i + 1 && i === tabs.length - 1 ? " drop-after" : ""}`}
          // pinned tabs wear their ORIGIN connection's color everywhere —
          // under a red connection a blue pin stays blue
          style={
            pinned.has(t.id)
              ? ({ "--tab-conn": pinMeta(t).color } as React.CSSProperties)
              : undefined
          }
          onMouseDown={(e) => beginTabDrag(i, e)}
          onAuxClick={(e) => {
            // middle-click closes — browser muscle memory (pinned excluded)
            if (e.button === 1 && !pinned.has(t.id)) requestClose(t.id);
          }}
          onClick={() => select(t.id)}
          onDoubleClick={() => {
            setRenaming(t.id);
            setDraft(t.name);
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setMenu({ x: e.clientX, y: e.clientY, id: t.id });
          }}
        >
          {renaming === t.id ? (
            <input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") {
                  rename(t.id, draft.trim() || t.name);
                  setRenaming(null);
                } else if (e.key === "Escape") {
                  setRenaming(null);
                }
              }}
              onBlur={() => {
                rename(t.id, draft.trim() || t.name);
                setRenaming(null);
              }}
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            <span className="tab-name">
              {pinned.has(t.id) && (
                <span
                  className="tab-pin-glyph"
                  style={{ color: pinMeta(t).color }}
                  title={pinMeta(t).label}
                  onClick={(e) => {
                    // click = INFO, never unpin (unpin lives in the context
                    // menu / closing) — a destructive one-click pin was a trap
                    e.stopPropagation();
                    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                    setPinInfo({ x: r.left, y: r.bottom + 6, id: t.id });
                  }}
                  onMouseDown={(e) => e.stopPropagation()}
                  onDoubleClick={(e) => e.stopPropagation()}
                >
                  <Pin size={10} className="tab-pin" />
                </span>
              )}
              <span className="tab-icon" title={t.kind === "table" ? "Table" : "Query"}>
                {t.kind === "table" ? <Table size={12} /> : <SquareTerminal size={12} />}
              </span>
              {activeProfileId && txTabs[skey(activeProfileId, t.id)] && (
                <span className="tab-tx" title="Open transaction on this tab" />
              )}
              {t.name}
            </span>
          )}
          <button
            className={`tab-close${isDirty(t) ? " dirty" : ""}`}
            title={
              fileDirty(t)
                ? "Buffer differs from the file on disk — ⌘⇧S saves it · click to close"
                : savedDirty(t)
                  ? "Buffer differs from the saved query — ⌘S updates it · click to close"
                  : "Close ⌘W"
            }
            onClick={(e) => {
              e.stopPropagation();
              requestClose(t.id);
            }}
          >
            <span className="tc-x">
              <X size={11} />
            </span>
            <span className="tc-dot" />
          </button>
        </div>
      ))}
      <button ref={newBtnRef} className="tab-new" title="New tab ⌘T" onClick={() => newTab()}>
        <Plus size={13} />
      </button>
      {saveError && (
        <span
          className="tab-save-warn"
          title="Saving tabs to disk is failing — your query text may not survive a restart. Retrying automatically."
        >
          ⚠ not saving
        </span>
      )}
      {menu && (
        <ContextMenu point={menu} items={tabMenu(menu.id)} onClose={() => setMenu(null)} />
      )}
      {pinInfo &&
        (() => {
          const t = allTabs.find((x) => x.id === pinInfo.id);
          if (!t) return null;
          const meta = pinMeta(t);
          const firstLine = t.sql.split("\n").find((l) => l.trim()) ?? "";
          return (
            <AnchoredOverlay
              point={pinInfo}
              onClose={() => setPinInfo(null)}
              role="dialog"
              label="Pinned tab info"
            >
              <motion.div className="pin-info" {...popIn}>
                <div className="pin-info-head">
                  <span className="pin-info-dot" style={{ background: meta.color }} />
                  {meta.label}
                </div>
                <div className="pin-info-row">
                  <span>{t.kind === "table" ? "Table tab" : "Query tab"}</span>
                  <span className="pin-info-name">{t.name}</span>
                </div>
                {firstLine && <div className="pin-info-sql">{firstLine.slice(0, 80)}</div>}
                <div className="pin-info-hint">
                  Visible on every connection · runs against the ACTIVE one
                  <br />
                  Unpin: right-click → Unpin (closing also unpins)
                </div>
              </motion.div>
            </AnchoredOverlay>
          );
        })()}
    </div>
  );
}
