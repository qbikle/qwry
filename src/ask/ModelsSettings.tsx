// Settings › Models (AGENT-UX section 8): one row per provider (name, key or
// base URL field, status), the Keychain sentence, and the defaults: the model
// for the active connection and the app default. Keys go through agentKeySet /
// agentKeyHas / agentKeyDelete: a key is written on blur or ↩, the field clears,
// and the value never comes back into TypeScript (AGENT-SPEC 8.3). Local
// runtimes take a URL and are probed live for their model list.
// Mounted by SettingsModal after the Query section, in the settings-section /
// settings-row skin (one modal, one skin; the sketch's standalone modal is a
// deviation the W2 plan records).

import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { PresetId, ProviderId } from "../agent/providers/types";
import { agentKeyDelete, agentKeySet } from "../ipc/commands";
import { useConnections } from "../stores/connections";
import { useSettings } from "../stores/settings";
import {
  KEY_PLACEHOLDER,
  LOCAL,
  PROVIDER_ORDER,
  baseUrlFor,
  baseUrlOverride,
  decodeChoice,
  defaultModelFor,
  encodeChoice,
  groupsFrom,
  loadKeys,
  optionLabel,
  probeLocal,
  providerAuth,
  providerLabel,
  type ModelChoice,
  type ModelRow,
  type SourceState,
} from "./modelSources";

export interface ModelsSettingsProps {
  /** the active connection, for the per-connection default row; null on home */
  profileId: string | null;
  /** the modal was opened for this section (`Manage Models…`):
   * scroll the heading into view once, instantly (never animate scroll) */
  reveal?: boolean;
}

/** a settings input owns its typing keys and nothing else (LESSONS 10):
 * ⌘/⌃ chords bubble to the window; escStack already took Esc at capture */
const swallowTyping = (e: ReactKeyboardEvent<HTMLInputElement>) => {
  if (!e.metaKey && !e.ctrlKey) e.stopPropagation();
};

type KeyStatus = "checking" | "saved" | "no key" | "not saved";
type LocalStatus = "checking" | "not running" | number;

function StatusChip({ tone, children }: { tone: "ok" | "muted" | "err"; children: string }) {
  return (
    <span className={`ask-models-st ${tone}`}>
      <span className="ask-models-dot" />
      {children}
    </span>
  );
}

/** Configuring a provider from Settings makes Ask usable straight away: with
 * no app default yet, the provider's own default model becomes it. */
function adoptIfUnset(id: ProviderId) {
  const s = useSettings.getState();
  if (s.agentProvider && s.agentModel) return;
  const model = defaultModelFor(id);
  if (model) s.setAgentModel(id, model);
}

export function ModelsSettings({ profileId, reveal = false }: ModelsSettingsProps) {
  const headingRef = useRef<HTMLDivElement>(null);
  const [keys, setKeys] = useState<SourceState["keys"]>({});
  const [failed, setFailed] = useState<Partial<Record<ProviderId, boolean>>>({});
  const [drafts, setDrafts] = useState<Partial<Record<ProviderId, string>>>({});
  const [urls, setUrls] = useState<Partial<Record<PresetId, string>>>({});
  const [local, setLocal] = useState<Partial<Record<PresetId, ModelRow[]>>>({});
  const [localStatus, setLocalStatus] = useState<Partial<Record<PresetId, LocalStatus>>>({});

  const agentProvider = useSettings((s) => s.agentProvider);
  const agentModel = useSettings((s) => s.agentModel);
  const perConn = useSettings((s) => (profileId ? s.agentByConn[profileId] : undefined));
  const connName = useConnections((s) =>
    profileId ? s.profiles.find((p) => p.id === profileId)?.name ?? null : null,
  );

  // one Keychain pass and one probe per local runtime on mount; each row
  // re-probes on its own when its URL is edited. The probes take no `live`
  // flag: StrictMode's throwaway first mount would consume the dedupe key and
  // discard the answer (ROADMAP gotcha), leaving the chip on `checking`
  useEffect(() => {
    let live = true;
    void loadKeys().then((k) => {
      if (live) setKeys(k);
    });
    for (const id of LOCAL) void probe(id, baseUrlFor(id));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // the section this modal was opened for lands in view on mount; the modal
  // is a fresh mount every open, so once is every time it was asked for
  useEffect(() => {
    if (reveal) headingRef.current?.scrollIntoView({ block: "start" });
  }, [reveal]);

  // the URL each runtime is currently probed at: a blur that changed nothing
  // does not re-probe (the chip would flicker), and a slower probe of an
  // earlier URL finds itself superseded after its await and drops its answer,
  // so the chip never describes a URL the field no longer holds (LESSONS 3, 9).
  // Liveness is not the guard: React ignores a set on an unmounted component
  const probed = useRef<Partial<Record<PresetId, string>>>({});
  async function probe(id: PresetId, url: string) {
    if (probed.current[id] === url) return;
    probed.current[id] = url;
    setLocalStatus((s) => ({ ...s, [id]: "checking" }));
    const rows = await probeLocal(id, url || undefined);
    if (probed.current[id] !== url) return;
    setLocal((s) => ({ ...s, [id]: rows }));
    setLocalStatus((s) => ({ ...s, [id]: rows.length > 0 ? rows.length : "not running" }));
  }

  /** the URL field commits on blur or ↩: the override persists (sparse, the
   * preset default is never stored) and the runtime is probed at it */
  function commitUrl(id: PresetId, url: string) {
    useSettings.getState().setAgentBaseUrl(id, baseUrlOverride(id, url));
    void probe(id, url.trim() || baseUrlFor(id));
  }

  async function saveKey(id: ProviderId) {
    const key = (drafts[id] ?? "").trim();
    if (!key) return;
    try {
      await agentKeySet(id, key);
      setDrafts((d) => ({ ...d, [id]: "" }));
      setFailed((f) => ({ ...f, [id]: false }));
      setKeys((k) => ({ ...k, [id]: true }));
      adoptIfUnset(id);
    } catch {
      setFailed((f) => ({ ...f, [id]: true }));
    }
  }

  async function forgetKey(id: ProviderId) {
    try {
      await agentKeyDelete(id);
      setKeys((k) => ({ ...k, [id]: false }));
      setFailed((f) => ({ ...f, [id]: false }));
    } catch {
      setFailed((f) => ({ ...f, [id]: true }));
    }
  }

  const keyStatus = (id: ProviderId): KeyStatus => {
    if (failed[id]) return "not saved";
    const has = keys[id];
    if (has === undefined) return "checking";
    return has ? "saved" : "no key";
  };

  const state: SourceState = { keys, local };
  const perChoice: ModelChoice | null = perConn
    ? { providerId: perConn.provider as ProviderId, model: perConn.model }
    : null;
  const appChoice: ModelChoice | null =
    agentProvider && agentModel ? { providerId: agentProvider as ProviderId, model: agentModel } : null;

  const options = (choice: ModelChoice | null) =>
    groupsFrom(state, choice)
      .filter((g) => g.rows.length > 0)
      .map((g) => (
        <optgroup key={g.id} label={providerLabel(g.id)}>
          {g.rows.map((r) => (
            <option key={r.id} value={encodeChoice(g.id, r.id)}>
              {optionLabel(r)}
            </option>
          ))}
        </optgroup>
      ));

  return (
    <>
      <div className="settings-section" id="settings-models" ref={headingRef}>
        Models
      </div>
      <div className="ask-models">
        {PROVIDER_ORDER.map((id) => {
          const auth = providerAuth(id);
          const label = providerLabel(id);
          if (auth === "subscription") {
            return (
              <div key={id} className="ask-models-row">
                <span className="ask-models-name">{label}</span>
                <span className="ask-models-field">
                  <span className="settings-hint">No key needed</span>
                </span>
                <StatusChip tone="ok">uses your subscription</StatusChip>
              </div>
            );
          }
          if (auth === "url") {
            const pid = id as PresetId;
            const url = urls[pid] ?? baseUrlFor(pid);
            const st = localStatus[pid] ?? "checking";
            return (
              <div key={id} className="ask-models-row">
                <span className="ask-models-name">{label}</span>
                <span className="ask-models-field">
                  <input
                    type="url"
                    className="ask-models-input ask-id"
                    placeholder={baseUrlFor(pid)}
                    aria-label={`${label} base URL`}
                    spellCheck={false}
                    value={url}
                    onChange={(e) => setUrls((u) => ({ ...u, [pid]: e.target.value }))}
                    onBlur={() => commitUrl(pid, url)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        commitUrl(pid, url);
                      }
                      swallowTyping(e);
                    }}
                  />
                </span>
                {typeof st === "number" ? (
                  <StatusChip tone="ok">{st === 1 ? "1 model" : `${st} models`}</StatusChip>
                ) : (
                  <StatusChip tone="muted">{st}</StatusChip>
                )}
              </div>
            );
          }
          const status = keyStatus(id);
          const saved = status === "saved";
          return (
            <div key={id} className="ask-models-row">
              <span className="ask-models-name">{label}</span>
              <span className="ask-models-field">
                <input
                  type="password"
                  className="ask-models-input"
                  placeholder={saved ? "Paste a new key to replace it" : KEY_PLACEHOLDER[id] ?? "API key"}
                  aria-label={`${label} API key`}
                  autoComplete="new-password"
                  spellCheck={false}
                  value={drafts[id] ?? ""}
                  onChange={(e) => setDrafts((d) => ({ ...d, [id]: e.target.value }))}
                  onBlur={() => void saveKey(id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void saveKey(id);
                    }
                    swallowTyping(e);
                  }}
                />
                {saved && (
                  <button className="linkish" onClick={() => void forgetKey(id)}>
                    Forget Key
                  </button>
                )}
              </span>
              <StatusChip tone={saved ? "ok" : status === "not saved" ? "err" : "muted"}>
                {status}
              </StatusChip>
            </div>
          );
        })}
      </div>
      <div className="settings-hint ask-models-note">
        Keys go to your Keychain and never appear again. Local runtimes take a URL instead.
      </div>

      {profileId && (
        <div className="settings-row">
          <span className="settings-label">
            Model for <span className="ask-id">{connName ?? profileId}</span>
          </span>
          <select
            className="settings-select"
            aria-label="Model for this connection"
            value={perChoice ? encodeChoice(perChoice.providerId, perChoice.model) : ""}
            onChange={(e) => {
              const s = useSettings.getState();
              const c = decodeChoice(e.target.value);
              if (c) s.setAgentConnModel(profileId, c.providerId, c.model);
              else s.dropAgentConn(profileId);
            }}
          >
            <option value="">App default</option>
            {options(perChoice)}
          </select>
        </div>
      )}
      <div className="settings-row">
        <span className="settings-label">App Default</span>
        <select
          className="settings-select"
          aria-label="App default model"
          value={appChoice ? encodeChoice(appChoice.providerId, appChoice.model) : ""}
          onChange={(e) => {
            const c = decodeChoice(e.target.value);
            if (c) useSettings.getState().setAgentModel(c.providerId, c.model);
          }}
        >
          {!appChoice && (
            <option value="" disabled>
              No model
            </option>
          )}
          {options(appChoice)}
        </select>
      </div>
    </>
  );
}
