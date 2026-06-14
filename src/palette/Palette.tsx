import { useEffect, useState } from "react";
import { Command } from "cmdk";
import { motion } from "motion/react";
import { popIn } from "../design/springs";
import { invoke } from "@tauri-apps/api/core";
import {
  Check,
  Clock,
  Database,
  Monitor,
  Moon,
  PanelRight,
  Play,
  Plus,
  RefreshCw,
  Sun,
  Table2,
} from "lucide-react";
import { useConnections } from "../stores/connections";
import { useResults } from "../stores/results";
import { useSchema } from "../stores/schema";
import { useSettings, type Theme } from "../stores/settings";
import { useTabs } from "../stores/tabs";
import "./palette.css";

interface HistoryRow {
  id: number;
  sql: string;
  ms: number;
  rows: number;
  ran_at: string;
}

export function Palette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [history, setHistory] = useState<HistoryRow[]>([]);

  const profiles = useConnections((s) => s.profiles);
  const activeProfileId = useConnections((s) => s.activeProfileId);
  const theme = useSettings((s) => s.theme);
  const setTheme = useSettings((s) => s.setTheme);
  const snapshot = useSchema((s) =>
    activeProfileId ? s.snapshots[activeProfileId] : undefined,
  );

  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

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
    void import("../stores/browser").then(({ useBrowser }) => {
      useBrowser.getState().close();
      useTabs.getState().newTab(sql, "history");
    });
    close();
  };

  return (
    <div className="pal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <motion.div className="pal-wrap" {...popIn}>
      <Command className="pal" shouldFilter={true} loop>
        <Command.Input
          autoFocus
          placeholder="Tables, actions, history…"
          value={query}
          onValueChange={setQuery}
          onKeyDown={(e) => e.key === "Escape" && close()}
        />
        <Command.List>
          <Command.Empty>No results</Command.Empty>

          <Command.Group heading="Actions">
            <Command.Item onSelect={() => { void useResults.getState().run(); close(); }}>
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
              value="clear history all"
              onSelect={() => {
                // no confirm() in WKWebView; picking the explicit "(all)" item is the consent
                if (activeProfileId) {
                  void invoke("history_clear", {
                    profileId: activeProfileId,
                    olderThanDays: null,
                  }).then(() => setHistory([]));
                }
                close();
              }}
            >
              <Clock size={13} /> Clear history (all)
            </Command.Item>
            <Command.Item
              value="clear history older than 7 days"
              onSelect={() => {
                if (activeProfileId) {
                  void invoke("history_clear", {
                    profileId: activeProfileId,
                    olderThanDays: 7,
                  });
                }
                close();
              }}
            >
              <Clock size={13} /> Clear history older than 7 days
            </Command.Item>
          </Command.Group>

          <Command.Group heading="Appearance">
            {(
              [
                ["dark", "Dark", Moon],
                ["light", "Light", Sun],
                ["system", "System", Monitor],
              ] as [Theme, string, typeof Moon][]
            ).map(([t, label, Icon]) => (
              <Command.Item
                key={t}
                value={`theme ${label}`}
                onSelect={() => {
                  setTheme(t);
                  close();
                }}
              >
                <Icon size={13} /> Theme: {label}
                {theme === t && <Check size={13} className="pal-check" />}
              </Command.Item>
            ))}
          </Command.Group>

          {snapshot && (
            <Command.Group heading="Tables">
              {snapshot.tables.slice(0, 400).map((t) => (
                <Command.Item
                  key={t.table_oid}
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
                value={`connect ${p.name}`}
                onSelect={() => {
                  void useConnections.getState().connect(p.id);
                  close();
                }}
              >
                <Database size={13} />
                {p.name}
                {p.is_prod && <span className="pal-prod">PROD</span>}
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
                    {h.rows} rows · {h.ms.toFixed(0)}ms
                  </span>
                </Command.Item>
              ))}
            </Command.Group>
          )}
        </Command.List>
      </Command>
      </motion.div>
    </div>
  );
}
