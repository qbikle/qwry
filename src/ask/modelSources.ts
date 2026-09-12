// UI-side facts about providers and models, shared by the picker, Settings ›
// Models and the setup card (AGENT-UX section 8): what to call a provider, how
// it authenticates, and which models it can offer. Tiers are a word on a badge
// and nothing here explains one (DESIGN rule 11; AGENT-SPEC section 3 is the
// definition). Keys never pass through here: presence is a boolean from the
// Keychain (agentKeyHas) and live model lists go through the Rust relay, which
// injects the key itself (AGENT-SPEC 8.3).

import { tauriPlatform } from "../agent/platform.tauri";
import {
  LOCAL_PRESETS,
  PROVIDER_PRESETS,
  START_HINTS,
  isPresetId,
  listModels,
  modelInfo,
  modelsForPreset,
  presetFor,
  type PresetId,
  type ProviderId,
  type Tier,
} from "../agent/providers/index";
import { agentKeyHas } from "../ipc/commands";
import { useSettings } from "../stores/settings";

export interface ModelChoice {
  providerId: ProviderId;
  model: string;
}

/** Claude Code runs on the user's subscription, hosted providers take a key,
 * local runtimes take a URL. */
export type ProviderAuth = "subscription" | "key" | "url";

/** every provider the UI can name, in display order: Claude Code, the native
 * Anthropic adapter, the hosted presets, then the local runtimes */
export const PROVIDER_ORDER: readonly ProviderId[] = [
  "claude-code",
  "anthropic",
  ...PROVIDER_PRESETS.filter((p) => !LOCAL_PRESETS.has(p.id)).map((p) => p.id),
  ...PROVIDER_PRESETS.filter((p) => LOCAL_PRESETS.has(p.id)).map((p) => p.id),
];

export function providerLabel(id: ProviderId): string {
  if (id === "claude-code") return "Claude Code";
  if (id === "anthropic") return "Anthropic";
  return presetFor(id).label;
}

export function providerAuth(id: ProviderId): ProviderAuth {
  if (id === "claude-code") return "subscription";
  if (id === "anthropic") return "key";
  return LOCAL_PRESETS.has(id) ? "url" : "key";
}

export const isLocal = (id: ProviderId): id is PresetId => isPresetId(id) && LOCAL_PRESETS.has(id);

/** The base URL a runtime is reached at: the Settings override when one is
 * saved, else the preset default. The loop reads the same override through
 * modelChoice(), so what the Settings field probed is what a run reaches. */
export function baseUrlFor(id: PresetId): string {
  return useSettings.getState().agentBaseUrls[id] ?? presetFor(id).baseUrl;
}

/** the override to persist for a URL the user typed: null when it is empty or
 * the preset default, so the map stays sparse */
export function baseUrlOverride(id: PresetId, url: string): string | null {
  const trimmed = url.trim();
  return trimmed === "" || trimmed === presetFor(id).baseUrl ? null : trimmed;
}

/** "http://127.0.0.1:8080/v1" → "127.0.0.1:8080", for group headings */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** how to start a local runtime that did not answer, per preset */
export function startHint(id: ProviderId): string {
  return (isPresetId(id) && START_HINTS[id]) || "Start the server and try again";
}

/** placeholder for the key field: the provider's own prefix when it has one */
export const KEY_PLACEHOLDER: Readonly<Partial<Record<ProviderId, string>>> = {
  anthropic: "sk-ant-…",
  openai: "sk-…",
  openrouter: "sk-or-…",
  gemini: "AIza…",
  groq: "gsk_…",
};

/** The label the pill and the rows print: the registry label minus the family
 * word the group heading already says. "Claude Haiku 4.5" → "Haiku 4.5",
 * "LFM2.5 2.6B (local)" → "LFM2.5 2.6B". */
export function shortLabel(label: string): string {
  return label.replace(/^Claude\s+/, "").replace(/\s*\(local\)$/, "");
}

/** a readable name for a path-shaped id (llama.cpp reports gguf paths) */
export function labelForId(id: string): string {
  const tail = id.split("/").pop() ?? id;
  return tail.replace(/\.gguf$/i, "");
}

/** the registry row for a model, matching a path-shaped local id on its file
 * name too (llama-server reports absolute gguf paths) */
export function infoFor(modelId: string, providerId: ProviderId) {
  return modelInfo(modelId, providerId) ?? modelInfo(labelForId(modelId), providerId);
}

/** the pill's model label: the registry label when known, else the raw id */
export function modelLabel(choice: ModelChoice | null): string {
  if (!choice) return "No model";
  return shortLabel(infoFor(choice.model, choice.providerId)?.label ?? labelForId(choice.model));
}

/** tier for the pipeline gate with the file-name fallback; unknown = mid and
 * says so (AGENT-SPEC section 3) */
export function tierFor(choice: ModelChoice): { tier: Tier; known: boolean } {
  const info = infoFor(choice.model, choice.providerId);
  return info ? { tier: info.tier, known: true } : { tier: "mid", known: false };
}

/** "200k ctx" · "1M ctx" · "" when the registry does not know */
export function contextHint(tokens: number): string {
  if (tokens <= 0) return "";
  if (tokens >= 1_000_000) return `${Math.round(tokens / 1_000_000)}M ctx`;
  const k = tokens % 1024 === 0 ? tokens / 1024 : Math.round(tokens / 1000);
  return `${k}k ctx`;
}

export interface ModelRow {
  id: string;
  label: string;
  tier: Tier;
  known: boolean;
  contextWindow: number;
}

export interface ProviderGroup {
  id: ProviderId;
  /** the provider's name, and only an exception's qualifier after it:
   * "Claude Code", "llama.cpp · 127.0.0.1:8080", "Ollama · not running",
   * "OpenAI · no key" (DESIGN rule 11: the norm is silent) */
  title: string;
  rows: ModelRow[];
  /** no key saved: the group offers the hand-off to Settings instead of rows */
  needsKey: boolean;
}

function registryRows(id: ProviderId): ModelRow[] {
  return modelsForPreset(id).map((m) => ({
    id: m.id,
    label: shortLabel(m.label),
    tier: m.tier,
    known: true,
    contextWindow: m.contextWindow,
  }));
}

/** the row for a chosen model the registry has never seen: mid and unverified */
function rowForChoice(choice: ModelChoice): ModelRow {
  const info = infoFor(choice.model, choice.providerId);
  return {
    id: choice.model,
    label: shortLabel(info?.label ?? labelForId(choice.model)),
    tier: info?.tier ?? "mid",
    known: !!info,
    contextWindow: info?.contextWindow ?? 0,
  };
}

function withChoice(rows: ModelRow[], id: ProviderId, choice: ModelChoice | null): ModelRow[] {
  if (!choice || choice.providerId !== id || rows.some((r) => r.id === choice.model)) return rows;
  return [...rows, rowForChoice(choice)];
}

/** Whether saving a key for this provider yields a usable configuration: the
 * picker needs a model id to offer, and routers (OpenRouter, Together,
 * Fireworks) have no registry rows yet. Their keys still save in Settings. */
export function configurable(id: ProviderId): boolean {
  return providerAuth(id) !== "key" || modelsForPreset(id).length > 0;
}

/** the model a freshly configured provider starts on */
export function defaultModelFor(id: ProviderId): string | null {
  if (id === "claude-code" || id === "anthropic") return "claude-haiku-4-5";
  const preset = presetFor(id);
  return preset.quirks.defaultModel ?? modelsForPreset(id)[0]?.id ?? null;
}

const PROBE_MS = 3000;

/** Live models at a local runtime, [] when nothing answers within the probe
 * window. A refused connection here is a server that was never started
 * (presets.ts), so silence is the answer, not an error. */
export async function probeLocal(id: PresetId, baseUrl?: string): Promise<ModelRow[]> {
  const preset = presetFor(id);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), PROBE_MS);
  });
  try {
    const listed = await Promise.race([listModels(tauriPlatform, preset, baseUrl), timeout]);
    return listed.map((m) => {
      const info = infoFor(m.id, id);
      return {
        id: m.id,
        label: shortLabel(info?.label ?? m.label),
        tier: info?.tier ?? m.tier,
        known: !!info || m.known,
        contextWindow: info?.contextWindow ?? 0,
      };
    });
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/** Which providers are reachable right now: key presence per hosted provider,
 * live models per local runtime. An absent entry means "not answered yet",
 * which is neither a missing key nor a dead runtime. */
export interface SourceState {
  keys: Partial<Record<ProviderId, boolean>>;
  local: Partial<Record<PresetId, ModelRow[]>>;
}

export const HOSTED: readonly ProviderId[] = PROVIDER_ORDER.filter((id) => providerAuth(id) === "key");
export const LOCAL: readonly PresetId[] = PROVIDER_ORDER.filter(isLocal);

/** presence per hosted provider; a Keychain read that fails reads as no key */
export async function loadKeys(ids: readonly ProviderId[] = HOSTED): Promise<SourceState["keys"]> {
  const flags = await Promise.all(ids.map((id) => agentKeyHas(id).catch(() => false)));
  const keys: SourceState["keys"] = {};
  ids.forEach((id, i) => {
    keys[id] = flags[i];
  });
  return keys;
}

export async function loadSourceState(): Promise<SourceState> {
  const [keys, probes] = await Promise.all([
    loadKeys(),
    Promise.all(LOCAL.map((id) => probeLocal(id, baseUrlFor(id)))),
  ]);
  const local: SourceState["local"] = {};
  LOCAL.forEach((id, i) => {
    local[id] = probes[i];
  });
  return { keys, local };
}

/** The groups the picker shows: Claude Code always; every hosted provider
 * with a key; every local runtime that answered; and the chosen provider even
 * when it did neither (`· no key` / `· not running`), so the pill's choice has
 * a row to point at. Everything else is a Settings matter behind `Manage
 * Models…`; a rowless heading teaches nothing a menu should (DESIGN rule 11).
 * A provider whose state has not answered yet appears only when chosen, under
 * its bare name, so nothing paints and then vanishes. */
export function groupsFrom(state: SourceState, choice: ModelChoice | null): ProviderGroup[] {
  const groups: ProviderGroup[] = [];
  for (const id of PROVIDER_ORDER) {
    const chosen = choice?.providerId === id;
    const label = providerLabel(id);
    const auth = providerAuth(id);
    if (auth === "subscription") {
      groups.push({ id, title: label, rows: withChoice(registryRows(id), id, choice), needsKey: false });
      continue;
    }
    if (auth === "url") {
      if (!isPresetId(id)) continue;
      const live = state.local[id];
      if (live === undefined) {
        if (chosen) {
          groups.push({ id, title: label, rows: withChoice(registryRows(id), id, choice), needsKey: false });
        }
        continue;
      }
      if (live.length === 0 && !chosen) continue;
      groups.push({
        id,
        title: `${label} · ${live.length > 0 ? hostOf(baseUrlFor(id)) : "not running"}`,
        rows: withChoice(live.length > 0 ? live : registryRows(id), id, choice),
        needsKey: false,
      });
      continue;
    }
    const hasKey = state.keys[id];
    if (hasKey === undefined) {
      if (chosen) {
        groups.push({ id, title: label, rows: withChoice(registryRows(id), id, choice), needsKey: false });
      }
      continue;
    }
    if (hasKey) {
      groups.push({ id, title: label, rows: withChoice(registryRows(id), id, choice), needsKey: false });
    } else if (chosen) {
      // the chosen row stays visible above the hand-off so the pill's choice
      // is explained rather than orphaned
      groups.push({ id, title: `${label} · no key`, rows: withChoice([], id, choice), needsKey: true });
    }
  }
  return groups;
}

/** the synchronous first paint before the Keychain and the runtimes answer */
export function initialGroups(choice: ModelChoice | null): ProviderGroup[] {
  return groupsFrom({ keys: {}, local: {} }, choice);
}

/** `Haiku 4.5 · mid`: the select-option face for a model row. An unverified
 * model wears the tier the loop gates it at, with no `?` face (rule 11). */
export function optionLabel(row: ModelRow): string {
  return `${row.label} · ${row.tier}`;
}

/** the select value for a provider + model pair; JSON so a model id may hold
 * any character */
export const encodeChoice = (providerId: ProviderId, model: string) =>
  JSON.stringify([providerId, model]);

export function decodeChoice(value: string): ModelChoice | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    const [providerId, model] = parsed;
    if (typeof providerId !== "string" || typeof model !== "string") return null;
    if (!PROVIDER_ORDER.includes(providerId as ProviderId)) return null;
    return { providerId: providerId as ProviderId, model };
  } catch {
    return null;
  }
}
