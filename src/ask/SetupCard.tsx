// Empty state, no model configured (AGENT-UX section 1): one sentence of
// what Ask does, the provider picker, the key field (saved to the Keychain
// through agentKeySet), and a hand-off to Settings › Models. Local presets
// take a base URL instead of a key and are probed for a model; Claude Code
// needs neither. Saving picks the provider's default model as the app default,
// so modelChoice() resolves and the panel switches to the starters.
//
// The note line under the form is a fixed slot: it carries the Keychain
// sentence at rest and the error text on failure, so feedback never moves the
// form (DESIGN rule 2, LESSONS 9).

import { useId, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { PresetId, ProviderId } from "../agent/providers/types";
import { agentKeySet } from "../ipc/commands";
import { useSettings } from "../stores/settings";
import {
  KEY_PLACEHOLDER,
  PROVIDER_ORDER,
  baseUrlFor,
  baseUrlOverride,
  configurable,
  defaultModelFor,
  hostOf,
  probeLocal,
  providerAuth,
  providerLabel,
  startHint,
} from "./modelSources";

export interface SetupCardProps {
  profileId: string;
  /** a provider and model were chosen: the panel switches to the starters */
  onConfigured: () => void;
  /** `Manage Models…` */
  onManage: () => void;
}

const PROVIDERS = PROVIDER_ORDER.filter(configurable);

const KEYCHAIN_NOTE = "Stored in your Keychain. Never in settings, prompts or logs.";
const URL_NOTE = "Local runtimes take a URL instead of a key. Nothing is stored.";
/** the command name is an identifier inside prose: mono (WRITING.md) */
const CLAUDE_NOTE = (
  <>
    Runs the <code className="ask-id">claude</code> command on this Mac with your subscription. No
    key.
  </>
);

function optionFace(id: ProviderId): string {
  const label = providerLabel(id);
  switch (providerAuth(id)) {
    case "subscription":
      return `${label} · your subscription`;
    case "url":
      return `${label} · local`;
    default:
      return label;
  }
}

/** the field owns its typing keys and nothing else (LESSONS 10) */
const swallowTyping = (e: ReactKeyboardEvent<HTMLElement>) => {
  if (!e.metaKey && !e.ctrlKey && e.key !== "Escape") e.stopPropagation();
};

export function SetupCard({ onConfigured, onManage }: SetupCardProps) {
  const [provider, setProvider] = useState<ProviderId>("claude-code");
  const [key, setKey] = useState("");
  const [url, setUrl] = useState<Partial<Record<PresetId, string>>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const uid = useId();

  const auth = providerAuth(provider);
  const label = providerLabel(provider);
  const localUrl = auth === "url" ? url[provider as PresetId] ?? baseUrlFor(provider as PresetId) : "";

  const configure = (model: string) => {
    useSettings.getState().setAgentModel(provider, model);
    onConfigured();
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      if (auth === "subscription") {
        const model = defaultModelFor(provider);
        if (model) configure(model);
        return;
      }
      if (auth === "url") {
        const pid = provider as PresetId;
        const rows = await probeLocal(pid, localUrl);
        if (rows.length === 0) {
          setError(`nothing answered at ${hostOf(localUrl)}. ${startHint(pid)}`);
          return;
        }
        // the URL that answered is the one the loop must reach
        useSettings.getState().setAgentBaseUrl(pid, baseUrlOverride(pid, localUrl));
        configure(rows[0].id);
        return;
      }
      const value = key.trim();
      if (!value) {
        setError("paste a key first");
        return;
      }
      await agentKeySet(provider, value);
      setKey("");
      const model = defaultModelFor(provider);
      if (!model) {
        setError(`key saved. Choose a model for ${label} in Settings › Models`);
        return;
      }
      configure(model);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(`couldn't save the key. ${msg.split("\n")[0]}`);
    } finally {
      setBusy(false);
    }
  };

  const note = auth === "key" ? KEYCHAIN_NOTE : auth === "url" ? URL_NOTE : CLAUDE_NOTE;
  const action = auth === "key" ? "Save Key" : auth === "url" ? "Save URL" : "Use Claude Code";

  return (
    <div className="ask-empty">
      <p className="ask-empty-text">Ask questions about this database in plain language.</p>
      <form className="ask-setup" onSubmit={(e) => void submit(e)}>
        <label className="ask-setup-label" htmlFor={`${uid}-provider`}>
          Provider
        </label>
        <select
          id={`${uid}-provider`}
          value={provider}
          onChange={(e) => {
            setProvider(e.target.value as ProviderId);
            setError(null);
          }}
        >
          {PROVIDERS.map((id) => (
            <option key={id} value={id}>
              {optionFace(id)}
            </option>
          ))}
        </select>

        {auth === "key" && (
          <>
            <label className="ask-setup-label" htmlFor={`${uid}-key`}>
              Key
            </label>
            <div className="ask-setup-row">
              <input
                id={`${uid}-key`}
                type="password"
                autoComplete="new-password"
                spellCheck={false}
                placeholder={KEY_PLACEHOLDER[provider] ?? "API key"}
                value={key}
                onChange={(e) => setKey(e.target.value)}
                onKeyDown={swallowTyping}
              />
              <button className="btnish primary" type="submit" disabled={busy || key.trim() === ""}>
                {action}
              </button>
            </div>
          </>
        )}
        {auth === "url" && (
          <>
            <label className="ask-setup-label" htmlFor={`${uid}-url`}>
              Base URL
            </label>
            <div className="ask-setup-row">
              <input
                id={`${uid}-url`}
                type="url"
                className="ask-id"
                spellCheck={false}
                placeholder={baseUrlFor(provider as PresetId)}
                value={localUrl}
                onChange={(e) => setUrl((u) => ({ ...u, [provider]: e.target.value }))}
                onKeyDown={swallowTyping}
              />
              <button className="btnish primary" type="submit" disabled={busy || localUrl.trim() === ""}>
                {action}
              </button>
            </div>
          </>
        )}
        {auth === "subscription" && (
          <div className="ask-setup-row">
            <button className="btnish primary" type="submit" disabled={busy}>
              {action}
            </button>
          </div>
        )}

        <span className={`ask-setup-note${error ? " error" : ""}`} role={error ? "alert" : undefined}>
          {error ?? note}
        </span>
      </form>
      <button className="linkish" onClick={onManage}>
        Manage Models…
      </button>
    </div>
  );
}
