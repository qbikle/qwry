import { create } from "zustand";
import { persist } from "zustand/middleware";
// the two provider tables only, by their own paths rather than through
// providers/index.ts: they are pure data with no imports of their own, where
// the barrel would drag every adapter into the eager settings module
import { carriesImages } from "../agent/providers/presets";
import { baseModelId, visionOf } from "../agent/providers/registry";
import type { ProviderId } from "../agent/providers/types";
import {
  applyTheme,
  DEFAULT_PALETTE,
  PALETTES,
  sanitizePalette,
  setGlassAlpha,
  type Mode,
  type Palette,
  connectionPalette,
} from "../design/theme";

export type { Mode } from "../design/theme";

interface SettingsState {
  /** include pg functions in the typed completion flow (always available via ^Space) */
  fnInComplete: boolean;
  toggleFnInComplete: () => void;

  /** editor font size in px */
  fontSize: number;
  setFontSize: (n: number) => void;
  /** results grid font size in px */
  gridFontSize: number;
  setGridFontSize: (n: number) => void;
  /** results grid row density */
  gridDensity: "compact" | "normal" | "comfortable";
  setGridDensity: (d: "compact" | "normal" | "comfortable") => void;
  /** soft-wrap long lines in the SQL editor */
  wrapLines: boolean;
  toggleWrapLines: () => void;
  /** server-side statement_timeout, seconds; applies to NEW connections */
  statementTimeoutSecs: number;
  setStatementTimeoutSecs: (n: number) => void;

  /** Ask: the provider the agent talks to, and the model within it
   * (AGENT-SPEC section 9). Plain strings, because they are persisted wire
   * values validated against the model registry at use time; the API key
   * itself lives in the Keychain and never lands here. */
  agentProvider: string | null;
  agentModel: string | null;
  /** per-connection overrides, sparse: an absent entry follows the app-wide
   * choice, so setting one never disturbs the others */
  agentByConn: Record<string, { provider: string; model: string }>;
  setAgentModel: (provider: string | null, model: string | null) => void;
  setAgentConnModel: (profileId: string, provider: string, model: string) => void;
  /** a deleted profile's model choice dies with it. NOT its edits permission:
   * this also fires when the user picks `App default` in the model row, and a
   * model choice is not a permission (A4). `connections.deleteProfile` revokes
   * the permission itself, where the connection actually dies */
  dropAgentConn: (profileId: string) => void;
  /** A4: per-connection permission for Ask to PROPOSE a change (one INSERT /
   * UPDATE / DELETE in the final fence, never a tool call). Sparse and off by
   * default: an absent entry is off, so a connection that was never switched
   * on cannot be switched on by a bad merge. A production connection has no
   * row at all (ModelsSettings) and the dry run refuses before it connects */
  agentWrites: Record<string, boolean>;
  setAgentWrites: (profileId: string, on: boolean) => void;
  /** C2b: per-install answers to the registry's `"unknown"` vision rows, keyed
   * by model, sparse and off by default. A per-model fact belongs to the model
   * (registry.ts), and this is the same fact learned on one machine rather
   * than from a document, so it stays out of the registry file and lands here */
  agentVision: Record<string, boolean>;
  setAgentVision: (modelId: string, on: boolean) => void;
  /** per-provider base URL overrides (local runtimes, gateways), sparse: an
   * absent entry means the preset default; the loop and the probes read the
   * same map so what Settings tested is what a run reaches */
  agentBaseUrls: Record<string, string>;
  /** null (or an empty string) drops the override */
  setAgentBaseUrl: (providerId: string, url: string | null) => void;

  /** default ⇧⌘F style: id into FORMAT_PRESETS */
  formatPreset: string;
  setFormatPreset: (id: string) => void;
  /** keyword/type case applied by every preset */
  formatKeywordCase: "upper" | "lower" | "preserve";
  setFormatKeywordCase: (c: "upper" | "lower" | "preserve") => void;

  /** UI (chrome) zoom percent, ⌘+/⌘−/⌘0: 70–150, 100 = actual size */
  uiZoom: number;
  setUiZoom: (n: number) => void;

  /** settings modal */
  settingsOpen: boolean;
  /** the section a caller asked the modal to open scrolled to (`models` from
   * the Ask picker); runtime only, cleared when the modal closes */
  settingsSection: string | null;
  setSettingsOpen: (v: boolean, section?: string) => void;

  /** gutter glass opacity 0.1–0.9 (lower = more see-through vibrancy) */
  glassAlpha: number;
  setGlass: (a: number) => void;

  /** dark / light / system */
  mode: Mode;
  /** active palette id (curated or custom) */
  paletteId: string;
  matchConnection: boolean;
  connAccent: string | null;
  setMatchConnection: (on: boolean) => void;
  setConnAccent: (c: string | null) => void;
  /** one theme everywhere (default) vs per-connection themes */
  themeEverywhere: boolean;
  /** per-connection theme choices, sparse: an absent entry follows the app
   * theme, so turning the toggle off changes nothing until a pick lands */
  connThemes: Record<string, ConnThemeChoice>;
  /** the active workspace's profile id (runtime only, pushed by the
   * connections store): the per-connection theme scope key */
  activeConnId: string | null;
  setThemeEverywhere: (on: boolean) => void;
  setActiveConnId: (id: string | null) => void;
  /** a deleted profile's theme dies with it */
  dropConnTheme: (profileId: string) => void;
  /** user-created palettes */
  customThemes: Palette[];
  /** resolved render mode after applying system pref */
  resolved: "dark" | "light";

  setMode: (m: Mode) => void;
  setPalette: (id: string) => void;
  addCustomTheme: (p: Palette) => void;
  removeCustomTheme: (id: string) => void;
}

/** one theme decision: a palette, or Match Connection with the palette as
 * its disconnected fallback */
export interface ConnThemeChoice {
  paletteId: string;
  match: boolean;
}

/** the choice the current scope resolves to: the active connection's entry
 * when per-connection themes are on, the app theme otherwise */
export function themeChoice(
  s: Pick<
    SettingsState,
    "themeEverywhere" | "activeConnId" | "connThemes" | "paletteId" | "matchConnection"
  >,
): ConnThemeChoice {
  if (!s.themeEverywhere && s.activeConnId) {
    const entry = s.connThemes[s.activeConnId];
    if (entry) return entry;
  }
  return { paletteId: s.paletteId, match: s.matchConnection };
}

/** route a pick to the scope it belongs to: the active connection's map
 * entry when per-connection themes are on, the app theme fields otherwise */
function scopedChoice(s: SettingsState, choice: ConnThemeChoice): Partial<SettingsState> {
  if (!s.themeEverywhere && s.activeConnId) {
    return { connThemes: { ...s.connThemes, [s.activeConnId]: choice } };
  }
  return { paletteId: choice.paletteId, matchConnection: choice.match };
}

function systemDark(): boolean {
  return !(
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-color-scheme: light)").matches
  );
}

/* rehydrate validation: a corrupt qwry.settings blob (NaN sizes, garbage
 * enums, mangled custom themes) must degrade field-by-field to defaults, never
 * propagate invalid CSS vars app-wide */
const finite = (v: unknown, lo: number, hi: number, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : fallback;

/** UI zoom bounds; ⌘0 resets to 100 */
export const ZOOM_MIN = 70;
export const ZOOM_MAX = 150;
export const ZOOM_STEP = 10;
const clampZoom = (n: number) =>
  Number.isFinite(n) ? Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.round(n))) : 100;
const pick = <T,>(v: unknown, allowed: readonly T[], fallback: T): T =>
  allowed.includes(v as T) ? (v as T) : fallback;

function sanitizeSettings(persisted: unknown, current: SettingsState): SettingsState {
  const p = (typeof persisted === "object" && persisted !== null ? persisted : {}) as Record<
    string,
    unknown
  >;
  const customThemes = Array.isArray(p.customThemes)
    ? p.customThemes.map(sanitizePalette).filter((t): t is Palette => t !== null)
    : current.customThemes;
  const knownPalettes = new Set([...PALETTES, ...customThemes].map((t) => t.id));
  return {
    ...current,
    fnInComplete: typeof p.fnInComplete === "boolean" ? p.fnInComplete : current.fnInComplete,
    fontSize: finite(p.fontSize, 10, 20, current.fontSize),
    gridFontSize: finite(p.gridFontSize, 10, 18, current.gridFontSize),
    gridDensity: pick(
      p.gridDensity,
      ["compact", "normal", "comfortable"] as const,
      current.gridDensity,
    ),
    wrapLines: typeof p.wrapLines === "boolean" ? p.wrapLines : current.wrapLines,
    statementTimeoutSecs: finite(p.statementTimeoutSecs, 0, 7200, current.statementTimeoutSecs),
    agentProvider: typeof p.agentProvider === "string" ? p.agentProvider : null,
    agentModel: typeof p.agentModel === "string" ? p.agentModel : null,
    agentByConn: sanitizeAgentConns(p.agentByConn),
    agentWrites: sanitizeAgentWrites(p.agentWrites),
    agentVision: sanitizeAgentVision(p.agentVision),
    agentBaseUrls: sanitizeBaseUrls(p.agentBaseUrls),
    formatPreset: typeof p.formatPreset === "string" ? p.formatPreset : current.formatPreset,
    formatKeywordCase: pick(
      p.formatKeywordCase,
      ["upper", "lower", "preserve"] as const,
      current.formatKeywordCase,
    ),
    uiZoom: finite(p.uiZoom, ZOOM_MIN, ZOOM_MAX, current.uiZoom),
    glassAlpha: finite(p.glassAlpha, 0, 1, current.glassAlpha),
    mode: pick(p.mode, ["system", "dark", "light"] as const, current.mode),
    // a paletteId pointing at a palette that no longer exists (corrupt custom
    // theme, version downgrade) would leave the picker with ZERO active cards
    // while the app silently wears the fallback; degrade to the default
    paletteId:
      typeof p.paletteId === "string" && knownPalettes.has(p.paletteId)
        ? p.paletteId
        : DEFAULT_PALETTE,
    matchConnection: typeof p.matchConnection === "boolean" ? p.matchConnection : false,
    themeEverywhere: typeof p.themeEverywhere === "boolean" ? p.themeEverywhere : true,
    connThemes: sanitizeConnThemes(p.connThemes, knownPalettes),
    customThemes,
  };
}

/** persisted agent model choices, one per connection. A half-written entry
 * is dropped rather than repaired: a connection with no override follows the
 * app-wide choice, which is always a valid state. */
function sanitizeAgentConns(v: unknown): Record<string, { provider: string; model: string }> {
  if (typeof v !== "object" || v === null) return {};
  const out: Record<string, { provider: string; model: string }> = {};
  for (const [k, raw] of Object.entries(v as Record<string, unknown>)) {
    const e = raw as { provider?: unknown; model?: unknown } | null;
    if (e && typeof e.provider === "string" && typeof e.model === "string") {
      out[k] = { provider: e.provider, model: e.model };
    }
  }
  return out;
}

/** A4 (AGENT-UX 13.1): may Ask propose a change on this connection? The
 * per-connection switch, and never on production, where the switch has no row
 * to be on: the capability does not exist there this wave, so what depends on
 * it is ABSENT rather than disabled (DESIGN rule 2's matrix). Pure and
 * dependency-free, so a component can call it inside its own selector, the
 * agent store can call it before its first await, and the grid can ask the
 * question without pulling the Ask chunk in behind it.
 */
export function writesAllowed(
  agentWrites: Record<string, boolean>,
  profileId: string,
  isProd: boolean,
): boolean {
  return !isProd && agentWrites[profileId] === true;
}

/** persisted write permissions, one per connection (A4). Only `true`
 * survives: anything else is off, and off is what an absent entry means, so a
 * corrupt map can never read as a granted permission. */
function sanitizeAgentWrites(v: unknown): Record<string, boolean> {
  if (typeof v !== "object" || v === null) return {};
  const out: Record<string, boolean> = {};
  for (const [k, raw] of Object.entries(v as Record<string, unknown>)) {
    if (raw === true) out[k] = true;
  }
  return out;
}

/** persisted vision answers, one per model (C2b). Only `true` survives, the
 * shape agentWrites uses: a corrupt map can never read as a yes, and off is
 * what an absent entry already means. */
function sanitizeAgentVision(v: unknown): Record<string, boolean> {
  if (typeof v !== "object" || v === null) return {};
  const out: Record<string, boolean> = {};
  for (const [k, raw] of Object.entries(v as Record<string, unknown>)) {
    if (raw === true) out[k] = true;
  }
  return out;
}

/** May Ask put an image on this model's question? Three facts in order: the
 * wire has to carry one at all, then the model's own flag, then this install's
 * answer for a model the registry cannot speak for. An override lifts
 * `"unknown"` and nothing else: `false` is a measured no, and a switch that
 * could overrule it would be a switch that lies. Pure, so the drawing's `Ask`
 * can ask the question inside its own selector. */
export function imagesAllowed(
  agentVision: Record<string, boolean>,
  providerId: ProviderId,
  model: string,
): boolean {
  if (!carriesImages(providerId)) return false;
  const flag = visionOf(model, providerId);
  return flag === true || (flag === "unknown" && agentVision[baseModelId(model)] === true);
}

/** Does the Models pane offer this model the one vision switch? Only where
 * nothing knows the answer: a model flagged either way has nothing to ask, and
 * a wire that carries no image has nothing to offer (DESIGN rule 2's matrix,
 * where a capability that does not exist is absent rather than disabled). */
export function visionUnknown(providerId: ProviderId, model: string): boolean {
  return carriesImages(providerId) && visionOf(model, providerId) === "unknown";
}

/** persisted base URL overrides, one per provider; anything but a non-empty
 * string is dropped, and a dropped entry means the preset default */
function sanitizeBaseUrls(v: unknown): Record<string, string> {
  if (typeof v !== "object" || v === null) return {};
  const out: Record<string, string> = {};
  for (const [k, raw] of Object.entries(v as Record<string, unknown>)) {
    if (typeof raw === "string" && raw.trim() !== "") out[k] = raw.trim();
  }
  return out;
}

/** map entries whose palette no longer exists fall back to the default
 * palette, keeping the per-connection intent; same outcome as deleting the
 * custom theme in-app (removeCustomTheme). Malformed shapes drop. */
function sanitizeConnThemes(raw: unknown, known: Set<string>): Record<string, ConnThemeChoice> {
  if (typeof raw !== "object" || raw === null) return {};
  const out: Record<string, ConnThemeChoice> = {};
  for (const [profileId, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v !== "object" || v === null) continue;
    const { paletteId, match } = v as Record<string, unknown>;
    if (typeof paletteId !== "string") continue;
    out[profileId] = {
      paletteId: known.has(paletteId) ? paletteId : DEFAULT_PALETTE,
      match: match === true,
    };
  }
  return out;
}

function resolveDark(mode: Mode): boolean {
  return mode === "system" ? systemDark() : mode === "dark";
}

export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      fnInComplete: false,
      toggleFnInComplete: () => set((s) => ({ fnInComplete: !s.fnInComplete })),

      fontSize: 13,
      setFontSize: (n) => set({ fontSize: Math.max(10, Math.min(20, Math.round(n))) }),
      gridFontSize: 12,
      setGridFontSize: (n) => set({ gridFontSize: Math.max(10, Math.min(18, Math.round(n))) }),
      gridDensity: "normal",
      setGridDensity: (gridDensity) => set({ gridDensity }),
      wrapLines: false,
      toggleWrapLines: () => set((s) => ({ wrapLines: !s.wrapLines })),
      statementTimeoutSecs: 300,
      setStatementTimeoutSecs: (n) =>
        // 0 = no timeout; else clamp 1s..2h
        set({ statementTimeoutSecs: n <= 0 ? 0 : Math.max(1, Math.min(7200, Math.round(n))) }),

      agentProvider: null,
      agentModel: null,
      agentByConn: {},
      setAgentModel: (provider, model) => set({ agentProvider: provider, agentModel: model }),
      setAgentConnModel: (profileId, provider, model) =>
        set((s) => ({ agentByConn: { ...s.agentByConn, [profileId]: { provider, model } } })),
      dropAgentConn: (profileId) =>
        set((s) => {
          const next = { ...s.agentByConn };
          delete next[profileId];
          return { agentByConn: next };
        }),
      agentWrites: {},
      // off is the absent entry, so switching a connection off leaves nothing
      // behind that a later merge could read as a permission
      setAgentWrites: (profileId, on) =>
        set((s) => {
          const next = { ...s.agentWrites };
          if (on) next[profileId] = true;
          else delete next[profileId];
          return { agentWrites: next };
        }),
      agentVision: {},
      // keyed the way the registry matches: llama-server reports gguf paths,
      // and a switch flipped on a path must answer for the file name the model
      // rows are written against
      setAgentVision: (modelId, on) =>
        set((s) => {
          const next = { ...s.agentVision };
          if (on) next[baseModelId(modelId)] = true;
          else delete next[baseModelId(modelId)];
          return { agentVision: next };
        }),
      agentBaseUrls: {},
      setAgentBaseUrl: (providerId, url) =>
        set((s) => {
          const next = { ...s.agentBaseUrls };
          const trimmed = url?.trim() ?? "";
          if (trimmed) next[providerId] = trimmed;
          else delete next[providerId];
          return { agentBaseUrls: next };
        }),

      formatPreset: "standard",
      setFormatPreset: (formatPreset) => set({ formatPreset }),
      formatKeywordCase: "upper",
      setFormatKeywordCase: (formatKeywordCase) => set({ formatKeywordCase }),

      uiZoom: 100,
      setUiZoom: (n) => set({ uiZoom: clampZoom(n) }),

      settingsOpen: false,
      settingsSection: null,
      setSettingsOpen: (settingsOpen, section) =>
        set({ settingsOpen, settingsSection: settingsOpen ? section ?? null : null }),

      glassAlpha: 0.55,
      setGlass: (a) => set({ glassAlpha: Math.max(0, Math.min(1, a)) }),

      mode: "dark",
      paletteId: DEFAULT_PALETTE,
      matchConnection: false,
      /** the ACTIVE connection's avatar color (runtime only, pushed by the
       * connections store): the Match Connection seed */
      connAccent: null,
      customThemes: [],
      resolved: "dark",

      setMode: (mode) => set({ mode, resolved: resolveDark(mode) ? "dark" : "light" }),
      // picking a palette turns Match Connection off: mutual exclusion by
      // structure, the picker card and palettes are one radio group (per
      // scope: the pick routes through scopedChoice)
      setPalette: (paletteId) => set((s) => scopedChoice(s, { paletteId, match: false })),
      setMatchConnection: (on) =>
        set((s) => scopedChoice(s, { paletteId: themeChoice(s).paletteId, match: on })),
      setConnAccent: (connAccent) => set({ connAccent }),
      themeEverywhere: true,
      connThemes: {},
      activeConnId: null,
      // turning the toggle ON promotes whatever is on screen to the app
      // theme; the map stays dormant so turning it back OFF restores every
      // assignment
      setThemeEverywhere: (on) =>
        set((s) => {
          if (!on) return { themeEverywhere: false };
          const c = themeChoice(s);
          return { themeEverywhere: true, paletteId: c.paletteId, matchConnection: c.match };
        }),
      setActiveConnId: (activeConnId) => set({ activeConnId }),
      dropConnTheme: (profileId) =>
        set((s) => {
          if (!(profileId in s.connThemes)) return {};
          const { [profileId]: _gone, ...connThemes } = s.connThemes;
          return { connThemes };
        }),
      addCustomTheme: (p) =>
        set((s) => ({
          customThemes: [...s.customThemes.filter((c) => c.id !== p.id), p],
          // authoring a theme IS choosing it; leaving Match Connection on
          // made Save appear to do nothing (the radio invariant, as in
          // setPalette above)
          ...scopedChoice(s, { paletteId: p.id, match: false }),
        })),
      removeCustomTheme: (id) =>
        set((s) => ({
          customThemes: s.customThemes.filter((c) => c.id !== id),
          paletteId: s.paletteId === id ? DEFAULT_PALETTE : s.paletteId,
          // connections holding the deleted theme fall back to the default
          // palette (their per-connection intent survives, the theme doesn't)
          connThemes: Object.fromEntries(
            Object.entries(s.connThemes).map(([k, v]) => [
              k,
              v.paletteId === id ? { ...v, paletteId: DEFAULT_PALETTE } : v,
            ]),
          ),
        })),
    }),
    {
      name: "qwry.settings",
      merge: sanitizeSettings,
      partialize: (s) => ({
        fnInComplete: s.fnInComplete,
        fontSize: s.fontSize,
        gridFontSize: s.gridFontSize,
        gridDensity: s.gridDensity,
        wrapLines: s.wrapLines,
        statementTimeoutSecs: s.statementTimeoutSecs,
        agentProvider: s.agentProvider,
        agentModel: s.agentModel,
        agentByConn: s.agentByConn,
        agentWrites: s.agentWrites,
        agentVision: s.agentVision,
        agentBaseUrls: s.agentBaseUrls,
        formatPreset: s.formatPreset,
        formatKeywordCase: s.formatKeywordCase,
        uiZoom: s.uiZoom,
        glassAlpha: s.glassAlpha,
        mode: s.mode,
        paletteId: s.paletteId,
        matchConnection: s.matchConnection,
        themeEverywhere: s.themeEverywhere,
        connThemes: s.connThemes,
        customThemes: s.customThemes,
      }),
    },
  ),
);

/** all selectable palettes: curated first, then the user's */
export function allPalettes(): Palette[] {
  return [...PALETTES, ...useSettings.getState().customThemes];
}

function currentPalette(): Palette {
  const s = useSettings.getState();
  const choice = themeChoice(s);
  // Match Connection: derive from the active connection's color; with no
  // live connection (home, disconnected) fall back to the chosen palette
  if (choice.match && s.connAccent) {
    const derived = connectionPalette(s.connAccent);
    if (derived) return derived;
  }
  return allPalettes().find((p) => p.id === choice.paletteId) ?? PALETTES[0];
}

/* UI zoom (⌘+/⌘−/⌘0) scales the CHROME: the px-based --text-* tokens are
 * re-emitted as inline overrides scaled by uiZoom (bases read from the loaded
 * stylesheet once, so token retunes in tokens.css stay authoritative), plus
 * root font-size % (any rem-based sizes inherit) and a --zoom factor for CSS
 * that wants to opt other px sizes in. DELIBERATELY EXCLUDED: the editor
 * (--editor-fs) and the results grid (--grid-fs, row/header geometry): both
 * have their own font-size settings, and the grid's virtualizer/hit-test math
 * is anchored to px constants. Zoom is chrome-level. */
const ZOOM_TOKENS = ["--text-2xs", "--text-xs", "--text-sm", "--text-md", "--text-lg"] as const;
const ZOOM_FALLBACK: Record<(typeof ZOOM_TOKENS)[number], number> = {
  "--text-2xs": 10,
  "--text-xs": 11,
  "--text-sm": 12,
  "--text-md": 13,
  "--text-lg": 15,
};
let zoomBase: Record<string, number> | null = null;

function applyZoom(pct: number) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (!zoomBase) {
    zoomBase = {};
    const cs = getComputedStyle(root);
    for (const t of ZOOM_TOKENS) {
      const v = parseFloat(cs.getPropertyValue(t));
      zoomBase[t] = Number.isFinite(v) && v > 0 ? v : ZOOM_FALLBACK[t];
    }
  }
  const f = pct / 100;
  root.style.setProperty("--zoom", String(f));
  if (pct === 100) {
    // clear overrides at 100% so the stylesheet's tokens rule again
    root.style.fontSize = "";
    for (const t of ZOOM_TOKENS) root.style.removeProperty(t);
    return;
  }
  root.style.fontSize = `${pct}%`;
  for (const t of ZOOM_TOKENS)
    root.style.setProperty(t, `${Math.round(zoomBase[t] * f * 10) / 10}px`);
}

/** recompute + apply CSS vars from the current palette & mode */
function apply() {
  const { mode, glassAlpha } = useSettings.getState();
  setGlassAlpha(glassAlpha);
  // the mode toggle governs every theme: custom themes synthesise the
  // matching dark/light variant from their authored colours
  const dark = resolveDark(mode);
  applyTheme(currentPalette(), dark);
  useSettings.setState({ resolved: dark ? "dark" : "light" });
}

// apply immediately at import (before first paint) to avoid a flash
apply();
// zoom waits a microtask: this module evaluates BEFORE main.tsx's tokens.css
// import in dev, and the token bases must be read from the loaded stylesheet.
// Microtasks still run before first paint: no unzoomed flash.
if (useSettings.getState().uiZoom !== 100) {
  queueMicrotask(() => applyZoom(useSettings.getState().uiZoom));
}

if (typeof window !== "undefined") {
  window
    .matchMedia?.("(prefers-color-scheme: light)")
    .addEventListener?.("change", () => {
      if (useSettings.getState().mode === "system") apply();
    });
  // re-apply whenever the mode, palette or custom set changes
  let prev = useSettings.getState();
  useSettings.subscribe((s) => {
    const themeChanged =
      s.mode !== prev.mode ||
      s.paletteId !== prev.paletteId ||
      s.customThemes !== prev.customThemes ||
      s.glassAlpha !== prev.glassAlpha ||
      s.matchConnection !== prev.matchConnection ||
      s.themeEverywhere !== prev.themeEverywhere ||
      s.connThemes !== prev.connThemes ||
      // workspace switches restyle only when per-connection themes are live
      (!s.themeEverywhere && s.activeConnId !== prev.activeConnId) ||
      (themeChoice(s).match && s.connAccent !== prev.connAccent);
    const zoomChanged = s.uiZoom !== prev.uiZoom;
    prev = s;
    if (themeChanged) apply();
    if (zoomChanged) applyZoom(s.uiZoom);
  });
}

/** ⌘+/⌘− step, ⌘0 reset; shared by the menu items and the window shortcuts */
export function zoomBy(dir: 1 | -1) {
  const s = useSettings.getState();
  s.setUiZoom(s.uiZoom + dir * ZOOM_STEP);
}
export function zoomReset() {
  useSettings.getState().setUiZoom(100);
}
