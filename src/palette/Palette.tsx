import { useEffect, useMemo, useRef, useState } from "react";
import { Command } from "cmdk";
import { motion } from "motion/react";
import { popIn } from "../design/springs";
import { invoke } from "@tauri-apps/api/core";
import {
  BookA,
  Bookmark,
  Check,
  Clock,
  Database,
  ListChecks,
  MessageSquare,
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
import { copyCueError, copyCueShow } from "../lib/copyCue";
import { checkOf, driftLabel, lastCheckOf, runChecks } from "../stores/checks";
import {
  definitionsOf,
  parseDefinition,
  removeDefinition,
  saveDefinition,
  useKnowledge,
} from "../stores/knowledge";
import { useSaved, visibleSaved, type SavedQuery } from "../stores/saved";
import { openSavedQuery } from "../sidebar/SavedQueries";
import { confirmTxRollback, useConnections } from "../stores/connections";
import { useResults } from "../stores/results";
import { useSchema } from "../stores/schema";
import { useSettings, type Mode } from "../stores/settings";
import { useUI } from "../stores/ui";
import { useTabs, visibleTabs } from "../stores/tabs";
import { Modal, useOverlayLayer } from "../app/overlay/Overlay";
import type { HistoryRow } from "../ipc/types";
import "./palette.css";

/** Define mode's own rung of the Esc ladder: the overlay stack owns Escape, so
 * a mode living inside an overlay registers a layer of its own rather than
 * reading the key (the mention completion's precedent, AGENT-UX 1a). */
function EscLayer({ onEsc }: { onEsc: () => void }) {
  useOverlayLayer(onEsc);
  return null;
}

/** Define mode's state: the line being typed, and the term it was loaded from
 * when it came off a row, so an edit that renames a definition moves it
 * instead of leaving a twin behind. */
interface DefineMode {
  from: string | null;
  line: string;
}

/** the Ask way into a row (W7's ⌘↩, A2 item 6a): a quick-ask is asked again, a
 * failed check is asked why, and on every other row it is ↩, so the chord is
 * never dead (LESSONS 9). */
function openAsk(): void {
  window.dispatchEvent(new CustomEvent("qwry:open-ask"));
}

/** one count, read once (LESSONS 13): the run reports what it ran, and the
 * `Run Checks` detail says the same about the run that stands */
function checkCue(total: number, failed: number): string {
  return `${total} check${total === 1 ? "" : "s"}${failed > 0 ? ` · ${failed} failed` : " passed"}`;
}

/** cmdk's value for a saved row: the id disambiguates duplicate names, and the
 * chord handler reads the row back out of it */
const savedValue = (q: SavedQuery) => `saved ${q.id} ${q.name}`;

export function Palette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [history, setHistory] = useState<HistoryRow[]>([]);
  // define mode (A2 item 3): the palette's own input becomes the definition
  // line, `term = meaning`, and the list under it is what already stands. Null
  // = the palette as it was; Esc returns to it with the query it held
  const [define, setDefine] = useState<DefineMode | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

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
  const knowledge = useKnowledge((s) => (activeProfileId ? s.rows[activeProfileId] : undefined));
  const definitions = definitionsOf(knowledge);
  // a saved query with an expectation is a check; its verdict is the row's dot,
  // and every count printed here comes off the same rows (LESSONS 13)
  const checks = saved.filter((q) => checkOf(q) !== null);
  const ran = checks.filter((q) => lastCheckOf(q) !== null);
  const failedChecks = ran.filter((q) => lastCheckOf(q)?.ok === false).length;
  const activeTab = tabs.find((t) => t.id === activeTabId);
  // `Explain with Ask` acts on the tab's SQL: a tab with none is a dead row
  const explainable = activeTab && activeTab.kind === "query" && activeTab.sql.trim() !== "" ? activeTab : null;
  const defining = define !== null;
  // one list of rows, drawn under the heading in the palette and under the
  // line in define mode: what stands is never two lists (DESIGN rule 14)
  const definitionRows = definitions.map((d) => (
    <Command.Item
      key={d.id}
      value={`definition ${d.id} ${d.term}`}
      // ↩ loads the row into the input, where it is edited and deleted by the
      // hint line's own gesture: clear the meaning and press ↩
      onSelect={() => setDefine({ from: d.term, line: `${d.term} = ${d.meaning}` })}
    >
      <BookA size={12} />
      {d.term}
      <span className="pal-detail">{d.meaning}</span>
    </Command.Item>
  ));

  useEffect(() => {
    if (!open) {
      setQuery("");
      setDefine(null);
    }
  }, [open]);

  // fuzzy-match over the WHOLE catalog ourselves, render only the top hits:
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

  // the definition line's grammar is the store's, parsed there and written
  // there (`term = meaning`, the assumption chips' own `=`). A line the parse
  // refuses is a delete when it names a term or came from a row, the hint
  // line's own gesture; an empty line that came from nowhere reaches for the
  // hot row instead, so the keyboard can pick a definition up to edit
  const commitDefine = () => {
    if (!define) return;
    const pid = activeProfileId;
    const parsed = parseDefinition(define.line);
    const typed = define.line.slice(0, define.line.indexOf("=")).trim();
    const gone = define.from && (!parsed || parsed.term !== define.from) ? define.from : null;
    if (!pid) return;
    if (parsed) {
      // an edit that renames the term moves the row rather than twinning it
      void (gone ? removeDefinition(pid, gone) : Promise.resolve())
        .then(() => saveDefinition(pid, parsed.term, parsed.meaning))
        .catch(copyCueError);
      setDefine(null);
      return;
    }
    const term = gone ?? (define.line.includes("=") ? typed : "");
    if (term) {
      void removeDefinition(pid, term).then(() => copyCueShow("Definition removed"), copyCueError);
      setDefine(null);
      return;
    }
    // a half-typed line waits for its meaning rather than being taken for a
    // command; only an empty one reaches for the row under the keyboard
    if (define.line.trim() !== "") return;
    const hot = hotValue();
    const d = hot?.startsWith("definition ")
      ? definitions.find((x) => hot === `definition ${x.id} ${x.term}`)
      : null;
    if (d) setDefine({ from: d.term, line: `${d.term} = ${d.meaning}` });
  };

  /** the row the keyboard is on, read where cmdk keeps it */
  function hotValue(): string | null {
    return (
      rootRef.current
        ?.querySelector('[cmdk-item][aria-selected="true"]')
        ?.getAttribute("data-value") ?? null
    );
  }

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

  // clear must refresh the History group + flash a cue: a silent action that
  // keeps showing deleted rows lies twice
  const clearHistory = (pid: string, olderThanDays: number | null) =>
    invoke("history_clear", { profileId: pid, olderThanDays }).then(async () => {
      copyCueShow("History cleared");
      setHistory(await invoke<HistoryRow[]>("history_search", { profileId: pid, query, limit: 20 }));
    });

  return (
    <Modal backdropClassName="pal-backdrop" label="Command Palette" onClose={close}>
      <motion.div className="pal-wrap" {...popIn}>
      {defining && <EscLayer onEsc={() => setDefine(null)} />}
      <Command
        ref={rootRef}
        className="pal"
        shouldFilter={!defining}
        loop
        // cmdk offers this handler the key first and stands down on a
        // preventDefault, so both chords are read here and nothing else moves
        onKeyDown={(e) => {
          if (e.key !== "Enter") return;
          if (defining) {
            e.preventDefault();
            commitDefine();
            return;
          }
          if (!e.metaKey) return;
          const v = hotValue();
          const q = v?.startsWith("saved ") ? saved.find((x) => v === savedValue(x)) : undefined;
          // ⌘↩ is ↩ on every other row: leave the key to cmdk (LESSONS 9)
          if (!q) return;
          if (q.question) {
            e.preventDefault();
            const question = q.question;
            openAsk();
            close();
            void import("../stores/agent").then(({ useAgent }) => useAgent.getState().ask(question));
          } else if (lastCheckOf(q)?.ok === false) {
            e.preventDefault();
            openAsk();
            close();
            void import("../stores/agent").then(({ useAgent }) => useAgent.getState().askWhy(q));
          }
        }}
      >
        <Command.Input
          autoFocus
          placeholder={defining ? "term = meaning" : "Tables, actions, history…"}
          value={defining ? define.line : query}
          onValueChange={(v) => (define ? setDefine({ ...define, line: v }) : setQuery(v))}
        />
        <Command.List>
          {defining ? (
            <Command.Group heading="Definitions">{definitionRows}</Command.Group>
          ) : (
          <>
          <Command.Empty>No results</Command.Empty>

          <Command.Group heading="Actions">
            <Command.Item
              onSelect={() => {
                // while the editor shows a time-machine snapshot the store sql
                // is the INVISIBLE parked draft: running it here would bypass
                // the editor's own gate
                if (!editorTimeTraveling.current) void useResults.getState().run();
                close();
              }}
            >
              <Play size={12} /> Run Query <kbd>⌘↩</kbd>
            </Command.Item>
            <Command.Item onSelect={() => { useTabs.getState().newTab(); close(); }}>
              <Plus size={12} /> New Tab <kbd>⌘T</kbd>
            </Command.Item>
            <Command.Item
              onSelect={() => {
                // the right pane's inspector radio: opens, switches from Ask,
                // or closes when the inspector is showing
                void import("../stores/sidePane").then(({ useSidePane }) =>
                  useSidePane.getState().toggle("inspector"),
                );
                close();
              }}
            >
              <PanelRight size={12} /> Toggle Inspector <kbd>⌘I</kbd>
            </Command.Item>
            <Command.Item
              value="ask agent question"
              onSelect={() => {
                // opens the pane in Ask (never closes it) and focuses the
                // composer (App owns the focus capture; the palette does not)
                window.dispatchEvent(new CustomEvent("qwry:open-ask"));
                close();
              }}
            >
              <MessageSquare size={12} /> Ask <kbd>⌘J</kbd>
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
              <RefreshCw size={12} /> Refresh Schema <kbd>⌘R</kbd>
            </Command.Item>
            <Command.Item
              value="refresh connection reconnect heal"
              onSelect={() => {
                const pid = useConnections.getState().activeProfileId;
                if (pid) {
                  void import("../stores/heal").then(({ requestHeal }) => requestHeal(pid, true));
                }
                close();
              }}
            >
              <RefreshCw size={12} /> Refresh Connection <kbd>⇧⌘R</kbd>
            </Command.Item>
            <Command.Item
              value="save query bookmark"
              onSelect={() => {
                void useTabs.getState().saveActive();
                close();
              }}
            >
              <Plus size={12} /> Save Query to Sidebar <kbd>⌘S</kbd>
            </Command.Item>
            <Command.Item
              value="restore reopen closed tab"
              onSelect={() => {
                useTabs.getState().restoreClosed();
                close();
              }}
            >
              <Plus size={12} /> Reopen Closed Tab <kbd>⇧⌘T</kbd>
            </Command.Item>
            <Command.Item
              value="format sql beautify"
              onSelect={() => {
                editorFormat.current?.();
                close();
              }}
            >
              <Wand2 size={12} /> Format SQL <kbd>⇧⌘F</kbd>
            </Command.Item>
            <Command.Item
              value="settings preferences"
              onSelect={() => {
                useSettings.getState().setSettingsOpen(true);
                close();
              }}
            >
              <Settings size={12} /> Settings… <kbd>⌘,</kbd>
            </Command.Item>
            <Command.Item
              value="query history panel search"
              onSelect={() => {
                window.dispatchEvent(new CustomEvent("qwry:open-history"));
                close();
              }}
            >
              <Clock size={12} /> Query History <kbd>⌘Y</kbd>
            </Command.Item>
            <Command.Item
              value="disconnect current connection"
              onSelect={() => {
                close();
                // kills EVERY session on the profile (all tabs, tunnel): the
                // only bulk teardown without a guard until now
                void (async () => {
                  const { activeProfileId: pid, profiles } = useConnections.getState();
                  if (!pid) return;
                  const { useEdits } = await import("../stores/edits");
                  // count only THIS profile's tabs: staged edits on another
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
                    `Closes every tab’s session on this connection${
                      pending > 0 ? `. ${pending} staged edit${pending === 1 ? "" : "s"} will be lost` : ""
                    }. Open transactions roll back.`,
                    "Disconnect",
                  );
                  if (ok) void useConnections.getState().invalidateProfile(pid);
                })();
              }}
            >
              <Database size={12} /> Disconnect Current Connection
            </Command.Item>
            <Command.Item
              value="clear history connection"
              onSelect={() => {
                // no confirm() in WKWebView; picking the explicit item is the consent
                if (activeProfileId) void clearHistory(activeProfileId, null);
                close();
              }}
            >
              <Clock size={12} /> Clear History for This Connection
            </Command.Item>
            <Command.Item
              value="clear history older than 7 days"
              onSelect={() => {
                if (activeProfileId) void clearHistory(activeProfileId, 7);
                close();
              }}
            >
              <Clock size={12} /> Clear History Older than 7 Days
            </Command.Item>
            {explainable && (
              <Command.Item
                // the app's own Explain (⌘E) is the plan view, so this verb
                // keeps its qualifier: one term per concept (WRITING rule 5)
                value="explain with ask query plan"
                onSelect={() => {
                  const { sql, name } = explainable;
                  openAsk();
                  close();
                  void import("../stores/agent").then(({ useAgent }) =>
                    useAgent.getState().explainWithAsk(sql, name),
                  );
                }}
              >
                <MessageSquare size={12} /> Explain with Ask
              </Command.Item>
            )}
            {checks.length > 0 && (
              <Command.Item
                value="run checks saved expectations"
                onSelect={() => {
                  const pid = activeProfileId;
                  close();
                  if (pid) {
                    void runChecks(pid).then(
                      (r) => copyCueShow(checkCue(r.total, r.failed)),
                      copyCueError,
                    );
                  }
                }}
              >
                <ListChecks size={12} /> Run Checks
                {ran.length > 0 && (
                  <span className="pal-detail">{checkCue(ran.length, failedChecks)}</span>
                )}
              </Command.Item>
            )}
            <Command.Item
              value="define term meaning definition"
              // the ellipsis is earned: the input becomes the line
              onSelect={() => setDefine({ from: null, line: "" })}
            >
              <Plus size={12} /> Define…
            </Command.Item>
          </Command.Group>

          <Command.Group heading="Open Tabs">
            {tabs.map((t, i) => (
              <Command.Item
                key={t.id}
                // value must be UNIQUE: three "new qwry" tabs with the same
                // value make cmdk collapse/misroute them; the index also makes
                // "tab 2" searchable
                value={`tab ${i + 1} ${t.name} ${t.kind}`}
                onSelect={() => {
                  useTabs.getState().select(t.id);
                  close();
                }}
              >
                {t.kind === "table" ? <Table2 size={12} /> : <SquareTerminal size={12} />}
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
                <X size={12} /> Close Current Tab <kbd>⌘W</kbd>
              </Command.Item>
            )}
          </Command.Group>

          {saved.length > 0 && (
            <Command.Group heading="Saved">
              {saved.map((q) => {
                // a quick-ask kept its question (A2 item 6a): it wears the chat
                // glyph and ⌘↩ asks it again. The heading already says `Saved`,
                // so no row repeats it (DESIGN rule 14)
                const check = lastCheckOf(q);
                const drift = check?.ok === false ? driftLabel(q) : "";
                return (
                  <Command.Item
                    key={q.id}
                    // q.id disambiguates duplicate names, like tabs/connections
                    value={savedValue(q)}
                    onSelect={() => {
                      openSavedQuery(q);
                      close();
                    }}
                  >
                    {q.question ? <MessageSquare size={12} /> : <Bookmark size={12} />}
                    {q.name}
                    {/* only the exception speaks: a passing row is its dot and
                        nothing more (DESIGN rule 11) */}
                    {drift && (
                      <button
                        type="button"
                        className="linkish pal-askwhy"
                        onClick={(e) => {
                          e.stopPropagation();
                          openAsk();
                          close();
                          void import("../stores/agent").then(({ useAgent }) =>
                            useAgent.getState().askWhy(q),
                          );
                        }}
                      >
                        Ask Why
                      </button>
                    )}
                    {drift && <span className="pal-detail">{drift}</span>}
                    {check && <span className={`pal-dot${check.ok ? " ok" : " fail"}`} />}
                  </Command.Item>
                );
              })}
            </Command.Group>
          )}

          {definitions.length > 0 && (
            <Command.Group heading="Definitions">{definitionRows}</Command.Group>
          )}

          <Command.Group heading="Appearance">
            <Command.Item
              value="theme customize palette picker pokemon"
              onSelect={() => {
                useUI.getState().openThemePicker();
                close();
              }}
            >
              <SwatchBook size={12} /> Customize Theme…
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
                <Icon size={12} /> Mode: {label}
                {mode === m && <Check size={12} className="pal-check" />}
              </Command.Item>
            ))}
          </Command.Group>

          {snapshot && tableHits.length > 0 && (
            // forceMount on the GROUP too: cmdk decides group visibility from
            // MATCHING children, so force-mounted items alone leave it hidden
            <Command.Group heading="Tables" forceMount>
              {tableHits.map((t) => (
                <Command.Item
                  key={t.table_oid}
                  // pre-filtered above: exempt from cmdk's own scoring so a
                  // match deep in the catalog can never be re-hidden
                  forceMount
                  value={`table ${t.schema}.${t.name}`}
                  onSelect={() => browseTable(t.table_oid)}
                >
                  <Table2 size={12} />
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
                // p.id disambiguates: two profiles named "prod" would make
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
                <Database size={12} />
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
                  <Clock size={12} />
                  <span className="pal-sql">{h.sql.replace(/\s+/g, " ").slice(0, 90)}</span>
                  <span className="pal-detail">
                    {h.status !== "ok" && `${h.status} · `}
                    {h.rows} rows · {h.ms.toFixed(0)}ms
                  </span>
                </Command.Item>
              ))}
            </Command.Group>
          )}
          </>
          )}
        </Command.List>
      </Command>
      </motion.div>
    </Modal>
  );
}
