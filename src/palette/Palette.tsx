import { useEffect, useMemo, useState } from "react";
import { Command } from "cmdk";
import { motion } from "motion/react";
import { popIn } from "../design/springs";
import { invoke } from "@tauri-apps/api/core";
import {
  Bookmark,
  Check,
  Clock,
  Database,
  Monitor,
  Moon,
  PanelRight,
  Play,
  Plus,
  RefreshCw,
  Settings,
  SquareTerminal,
  Sun,
  SwatchBook,
  Table2,
  Wand2,
  X,
} from "lucide-react";
import { editorFormat, editorTimeTraveling } from "../editor/editorBus";
import { copyCueShow } from "../lib/copyCue";
import { useSaved, visibleSaved } from "../stores/saved";
import { openSavedQuery } from "../sidebar/SavedQueries";
import { confirmTxRollback, useConnections } from "../stores/connections";
import { useResults } from "../stores/results";
import { useSchema } from "../stores/schema";
import { useSettings, type Mode } from "../stores/settings";
import { useUI } from "../stores/ui";
import { useTabs, visibleTabs } from "../stores/tabs";
import { Modal } from "../app/overlay/Overlay";
import type { HistoryRow } from "../ipc/types";
import "./palette.css";

export function Palette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [history, setHistory] = useState<HistoryRow[]>([]);

  const profiles = useConnections((s) => s.profiles);
  const allTabs = useTabs((s) => s.tabs);
  const pinnedTabs = useTabs((s) => s.pinned);
  const activeTabId = useTabs((s) => s.activeId);
  const activeProfileId = useConnections((s) => s.activeProfileId);
  const mode = useSettings((s) => s.mode);
  const setMode = useSettings((s) => s.setMode);
  const snapshot = useSchema((s) =>
    activeProfileId ? s.snapshots[activeProfileId] : undefined,
  );
  // palette lists the CURRENT connection's workspace, like the strip
  const tabs = visibleTabs(allTabs, pinnedTabs, activeProfileId);
  const allSaved = useSaved((s) => s.queries);
  const saved = visibleSaved(allSaved, activeProfileId);

  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  // fuzzy-match over the WHOLE catalog ourselves, render only the top hits —
  // the old first-400 slice made every table past index 400 unfindable
  const tableHits = useMemo(() => {
    const all = snapshot?.tables ?? [];
    const q = query.trim().toLowerCase();
    if (!q) return all.slice(0, 50);
    const scored: { t: (typeof all)[number]; score: number }[] = [];
    for (const t of all) {
      const hay = `${t.schema}.${t.name}`.toLowerCase();
      // rank: exact name > prefix > substring > subsequence
      let score = -1;
      if (t.name.toLowerCase() === q) score = 0;
      else if (t.name.toLowerCase().startsWith(q)) score = 1;
      else if (hay.includes(q)) score = 2;
      else {
        let i = 0;
        for (const ch of hay) if (ch === q[i]) i++;
        if (i === q.length) score = 3;
      }
      if (score >= 0) scored.push({ t, score });
    }
    scored.sort((a, b) => a.score - b.score || a.t.name.length - b.t.name.length);
    return scored.slice(0, 50).map((s) => s.t);
  }, [snapshot, query]);

  // history search follows the query text
  useEffect(() => {
    if (!open || !activeProfileId) return;
    const t = setTimeout(() => {
      void invoke<HistoryRow[]>("history_search", {
        profileId: activeProfileId,
        query,
        limit: 20,
      }).then(setHistory);
    }, 120);
    return () => clearTimeout(t);
  }, [open, query, activeProfileId]);

  if (!open) return null;

  const close = () => onClose();

  const browseTable = (oid: number) => {
    const t = snapshot?.tables.find((t) => t.table_oid === oid);
    if (t) {
      void import("../stores/browser").then(({ useBrowser }) =>
        useBrowser.getState().openTable(t),
      );
    }
    close();
  };

  const loadHistory = (sql: string) => {
    useTabs.getState().newTab(sql, "history");
    close();
  };

  // clear must refresh the History group + flash a cue — a silent action that
  // keeps showing deleted rows lies twice
  const clearHistory = (pid: string, olderThanDays: number | null) =>
    invoke("history_clear", { profileId: pid, olderThanDays }).then(async () => {
      copyCueShow("History cleared");
      setHistory(await invoke<HistoryRow[]>("history_search", { profileId: pid, query, limit: 20 }));
    });

  return (
    <Modal backdropClassName="pal-backdrop" label="Command palette" onClose={close}>
      <motion.div className="pal-wrap" {...popIn}>
      <Command className="pal" shouldFilter={true} loop>
        <Command.Input
          autoFocus
          placeholder="Tables, actions, history…"
          value={query}
          onValueChange={setQuery}
        />
        <Command.List>
          <Command.Empty>No results</Command.Empty>

          <Command.Group heading="Actions">
            <Command.Item
              onSelect={() => {
                // while the editor shows a time-machine snapshot the store sql
                // is the INVISIBLE parked draft — running it here would bypass
                // the editor's own gate
                if (!editorTimeTraveling.current) void useResults.getState().run();
                close();
              }}
            >
              <Play size={13} /> Run query <kbd>⌘↵</kbd>
            </Command.Item>
            <Command.Item onSelect={() => { useTabs.getState().newTab(); close(); }}>
              <Plus size={13} /> New tab <kbd>⌘T</kbd>
            </Command.Item>
            <Command.Item
              onSelect={() => {
                void import("../stores/inspector").then(({ useInspector }) =>
                  useInspector.getState().toggle(),
                );
                close();
              }}
            >
              <PanelRight size={13} /> Toggle inspector <kbd>⌘I</kbd>
            </Command.Item>
            <Command.Item
              onSelect={() => {
                const { activeProfileId: pid, sessions } = useConnections.getState();
                if (pid && sessions[pid]) {
                  void useSchema.getState().fetch(pid, sessions[pid]);
                }
                close();
              }}
            >
              <RefreshCw size={13} /> Refresh schema <kbd>⌘R</kbd>
            </Command.Item>
            <Command.Item
              value="save query bookmark"
              onSelect={() => {
                void useTabs.getState().saveActive();
                close();
              }}
            >
              <Plus size={13} /> Save query to sidebar <kbd>⌘S</kbd>
            </Command.Item>
            <Command.Item
              value="restore closed tab"
              onSelect={() => {
                useTabs.getState().restoreClosed();
                close();
              }}
            >
              <Plus size={13} /> Restore closed tab <kbd>⌘⇧T</kbd>
            </Command.Item>
            <Command.Item
              value="format sql beautify"
              onSelect={() => {
                editorFormat.current?.();
                close();
              }}
            >
              <Wand2 size={13} /> Format SQL <kbd>⌘⇧F</kbd>
            </Command.Item>
            <Command.Item
              value="settings preferences"
              onSelect={() => {
                useSettings.getState().setSettingsOpen(true);
                close();
              }}
            >
              <Settings size={13} /> Settings… <kbd>⌘,</kbd>
            </Command.Item>
            <Command.Item
              value="query history panel search"
              onSelect={() => {
                window.dispatchEvent(new CustomEvent("qwry:open-history"));
                close();
              }}
            >
              <Clock size={13} /> Query history panel <kbd>⌘Y</kbd>
            </Command.Item>
            <Command.Item
              value="disconnect current connection"
              onSelect={() => {
                close();
                // kills EVERY session on the profile (all tabs, tunnel) — the
                // only bulk teardown without a guard until now
                void (async () => {
                  const { activeProfileId: pid, profiles } = useConnections.getState();
                  if (!pid) return;
                  const { useEdits } = await import("../stores/edits");
                  // count only THIS profile's tabs — staged edits on another
                  // connection survive its disconnect and must not inflate
                  // the warning
                  const tabList = useTabs.getState().tabs;
                  const pending = Object.entries(useEdits.getState().byTab).reduce(
                    (n, [tabId, t]) => {
                      const cnt = Object.keys(t.pending).length;
                      if (cnt === 0) return n;
                      const owner =
                        tabList.find((x) => x.id === tabId)?.profile_id ??
                        useResults.getState().byTab[tabId]?.executedProfileId ??
                        null;
                      return owner === pid ? n + cnt : n;
                    },
                    0,
                  );
                  const name = profiles.find((p) => p.id === pid)?.name ?? "connection";
                  const { confirmDanger } = await import("../stores/danger");
                  const ok = await confirmDanger(
                    `Disconnect ${name}?`,
                    `Closes every tab's session on this connection${
                      pending > 0 ? ` — ${pending} staged edit${pending === 1 ? "" : "s"} will be lost` : ""
                    }. Open transactions roll back.`,
                    "Disconnect",
                  );
                  if (ok) void useConnections.getState().invalidateProfile(pid);
                })();
              }}
            >
              <Database size={13} /> Disconnect current
            </Command.Item>
            <Command.Item
              value="clear history connection"
              onSelect={() => {
                // no confirm() in WKWebView; picking the explicit item is the consent
                if (activeProfileId) void clearHistory(activeProfileId, null);
                close();
              }}
            >
              <Clock size={13} /> Clear history (this connection)
            </Command.Item>
            <Command.Item
              value="clear history older than 7 days"
              onSelect={() => {
                if (activeProfileId) void clearHistory(activeProfileId, 7);
                close();
              }}
            >
              <Clock size={13} /> Clear history older than 7 days
            </Command.Item>
          </Command.Group>

          <Command.Group heading="Open tabs">
            {tabs.map((t, i) => (
              <Command.Item
                key={t.id}
                // value must be UNIQUE — three "new qwry" tabs with the same
                // value make cmdk collapse/misroute them; the index also makes
                // "tab 2" searchable
                value={`tab ${i + 1} ${t.name} ${t.kind}`}
                onSelect={() => {
                  useTabs.getState().select(t.id);
                  close();
                }}
              >
                {t.kind === "table" ? <Table2 size={13} /> : <SquareTerminal size={13} />}
                <span className={t.id === activeTabId ? "pal-tab-active" : ""}>{t.name}</span>
                <span className="pal-detail">tab {i + 1}</span>
              </Command.Item>
            ))}
            {activeTabId && (
              <Command.Item
                value="close current tab"
                onSelect={() => {
                  void import("../stores/closeGuard").then(({ useCloseGuard }) =>
                    useCloseGuard.getState().request(activeTabId),
                  );
                  close();
                }}
              >
                <X size={13} /> Close current tab <kbd>⌘W</kbd>
              </Command.Item>
            )}
          </Command.Group>

          {saved.length > 0 && (
            <Command.Group heading="Saved">
              {saved.map((q) => (
                <Command.Item
                  key={q.id}
                  // q.id disambiguates duplicate names, like tabs/connections
                  value={`saved ${q.id} ${q.name}`}
                  onSelect={() => {
                    openSavedQuery(q);
                    close();
                  }}
                >
                  <Bookmark size={13} />
                  {q.name}
                  <span className="pal-detail">saved</span>
                </Command.Item>
              ))}
            </Command.Group>
          )}

          <Command.Group heading="Appearance">
            <Command.Item
              value="theme customize palette picker pokemon"
              onSelect={() => {
                useUI.getState().openThemePicker();
                close();
              }}
            >
              <SwatchBook size={13} /> Customize theme…
            </Command.Item>
            {(
              [
                ["dark", "Dark", Moon],
                ["light", "Light", Sun],
                ["system", "System", Monitor],
              ] as [Mode, string, typeof Moon][]
            ).map(([m, label, Icon]) => (
              <Command.Item
                key={m}
                value={`mode ${label}`}
                onSelect={() => {
                  setMode(m);
                  close();
                }}
              >
                <Icon size={13} /> Mode: {label}
                {mode === m && <Check size={13} className="pal-check" />}
              </Command.Item>
            ))}
          </Command.Group>

          {snapshot && tableHits.length > 0 && (
            // forceMount on the GROUP too — cmdk decides group visibility from
            // MATCHING children, so force-mounted items alone leave it hidden
            <Command.Group heading="Tables" forceMount>
              {tableHits.map((t) => (
                <Command.Item
                  key={t.table_oid}
                  // pre-filtered above — exempt from cmdk's own scoring so a
                  // match deep in the catalog can never be re-hidden
                  forceMount
                  value={`table ${t.schema}.${t.name}`}
                  onSelect={() => browseTable(t.table_oid)}
                >
                  <Table2 size={13} />
                  {t.schema === "public" ? t.name : `${t.schema}.${t.name}`}
                  <span className="pal-detail">{t.columns.length} cols</span>
                </Command.Item>
              ))}
            </Command.Group>
          )}

          <Command.Group heading="Connections">
            {profiles.map((p) => (
              <Command.Item
                key={p.id}
                // p.id disambiguates — two profiles named "prod" would make
                // cmdk activate whichever is first in the DOM, not the arrowed one
                value={`connect ${p.name} ${p.id}`}
                onSelect={() => {
                  close();
                  void (async () => {
                    const c = useConnections.getState();
                    // connected → switch to it; reconnecting would tear down
                    // every tab session on the profile
                    if (c.connState[p.id] === "connected") {
                      c.setActive(p.id);
                      c.setHome(null);
                      return;
                    }
                    if (await confirmTxRollback(p.id, "Connect")) void c.connect(p.id);
                  })();
                }}
              >
                <Database size={13} />
                {p.name}
                {p.is_prod && <span className="badge badge-danger">PROD</span>}
              </Command.Item>
            ))}
          </Command.Group>

          {history.length > 0 && (
            <Command.Group heading="History">
              {history.map((h) => (
                <Command.Item
                  key={h.id}
                  value={`history ${h.id} ${h.sql.slice(0, 80)}`}
                  onSelect={() => loadHistory(h.sql)}
                >
                  <Clock size={13} />
                  <span className="pal-sql">{h.sql.replace(/\s+/g, " ").slice(0, 90)}</span>
                  <span className="pal-detail">
                    {h.status !== "ok" && `${h.status} · `}
                    {h.rows} rows · {h.ms.toFixed(0)}ms
                  </span>
                </Command.Item>
              ))}
            </Command.Group>
          )}
        </Command.List>
      </Command>
      </motion.div>
    </Modal>
  );
}
