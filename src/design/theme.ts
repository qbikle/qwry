// Theme engine. A palette is just a few seeds (accent + character hue); this
// derives the FULL token set for dark and light from a shared neutral ramp
// tinted toward the palette, and applies them as CSS vars at runtime. Surfaces
// are subtly tinted; syntax stays a fixed legible set per mode.

/** gutter glass opacity (0..1) — Settings slider; applied on next theme apply */
let glassAlpha = 0.55;
export function setGlassAlpha(a: number) {
  glassAlpha = Math.max(0, Math.min(1, a));
  // below ~half wash the wallpaper dominates the glass and theme fg can't be
  // trusted on it — titlebar content switches to self-surfaced chips/halo
  // (v2.css rules scoped on this attribute; DESIGN.md rule 3 glass clause)
  document.documentElement.toggleAttribute("data-glassy", glassAlpha < 0.5);
}

export type Mode = "system" | "dark" | "light";

export interface Palette {
  id: string;
  name: string;
  custom?: boolean;

  // hue kind (curated): accent + character hue + tint → derived ramp
  accent?: string;
  hue?: number;
  /** surface tint strength 0–1 (1 = full character, 0 = neutral gray). default 1 */
  tint?: number;

  // anchors kind (custom): explicit colours, everything else derived
  bg?: string;
  fg?: string;
  primary?: string;
  secondary?: string;
}

// curated set — full hue spread; Blastoise is the default (closest to v0.1)
export const PALETTES: Palette[] = [
  { id: "blastoise", name: "Blastoise", accent: "#4a90e2", hue: 215 },
  { id: "charizard", name: "Charizard", accent: "#ff7a3c", hue: 20 },
  { id: "venusaur", name: "Venusaur", accent: "#54b96a", hue: 140 },
  { id: "pikachu", name: "Pikachu", accent: "#f7ca3e", hue: 46 },
  { id: "gengar", name: "Gengar", accent: "#9b6cff", hue: 270 },
  { id: "articuno", name: "Articuno", accent: "#3fc1d9", hue: 190 },
  { id: "sylveon", name: "Sylveon", accent: "#f291ba", hue: 330 },
  { id: "umbreon", name: "Umbreon", accent: "#e8b73e", hue: 250 },
];

export const DEFAULT_PALETTE = "blastoise";

/* ---- colour math (no deps) ---- */

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

function hexToHsl(hex: string): { h: number; s: number; l: number } {
  const m = hex.replace("#", "");
  const r = parseInt(m.slice(0, 2), 16) / 255;
  const g = parseInt(m.slice(2, 4), 16) / 255;
  const b = parseInt(m.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  const l = (max + min) / 2;
  const d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: s * 100, l: l * 100 };
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  s /= 100;
  l /= 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0,
    g = 0,
    b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [
    Math.round((r + m) * 255),
    Math.round((g + m) * 255),
    Math.round((b + m) * 255),
  ];
}

function hsl(h: number, s: number, l: number): string {
  const [r, g, b] = hslToRgb(h, s, l);
  return `#${[r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
}

function hsla(h: number, s: number, l: number, a: number): string {
  const [r, g, b] = hslToRgb(h, s, l);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

/** relative luminance (0 dark – 1 light) for choosing text-on-accent */
function luminance(h: number, s: number, l: number): number {
  const [r, g, b] = hslToRgb(h, s, l).map((n) => {
    const c = n / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/* ---- hex helpers for the anchor (custom-theme) engine ---- */

function hexToRgb(hex: string): [number, number, number] {
  const m = hex.replace("#", "");
  const full = m.length === 3 ? m.split("").map((c) => c + c).join("") : m;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)) as [number, number, number];
}
function rgbToHex([r, g, b]: number[]): string {
  return `#${[r, g, b].map((n) => Math.round(clamp(n, 0, 255)).toString(16).padStart(2, "0")).join("")}`;
}
/** blend a toward b by t (0–1) in sRGB */
function mix(a: string, b: string, t: number): string {
  const ra = hexToRgb(a);
  const rb = hexToRgb(b);
  return rgbToHex(ra.map((v, i) => v + (rb[i] - v) * t));
}
function withAlpha(hex: string, a: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}
function lumHex(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((n) => {
    const c = n / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const accentFg = (hex: string) => (lumHex(hex) > 0.5 ? "#16181d" : "#ffffff");

// curated (hue) accents: cap saturation, nudge lightness for contrast — but
// never FORCE saturation up (that turned white/gray accents pink).
function adjustAccent(accent: string, mode: "dark" | "light") {
  const { h, s, l } = hexToHsl(accent);
  const S = Math.min(s, 96);
  const L = mode === "dark" ? clamp(l, 52, 72) : clamp(l, 38, 54);
  return {
    h,
    s: S,
    l: L,
    hex: hsl(h, S, L),
    fg: luminance(h, S, L) > 0.5 ? "#16181d" : "#ffffff",
  };
}

export const CONN_MATCH_ID = "conn-match";

/** shortest wheel distance between two hues */
function hueDist(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/** steer a hue out of the danger band (reds, ~345–15°): the accent must
 * never wear the danger register's color — Run reading as Delete is a
 * data-safety failure, not a taste call. Exits to the nearer safe edge. */
function steerFromDanger(h: number): number {
  if (hueDist(h, 0) > 15) return h;
  return hueDist(h, 335) <= hueDist(h, 25) ? 335 : 25;
}

/** Match Connection: the active connection's avatar color seeds the accent
 * over a PURE NEUTRAL surface ramp (tint 0) — the app quietly wears the
 * connection's identity without surfaces shifting hue per connection */
export function connectionPalette(color: string): Palette | null {
  // profile.color comes from appdb and never crossed sanitizePalette's HEX6
  // moat — malformed hex once expanded to NaN CSS vars and bricked the UI,
  // so an invalid seed declines and the caller falls back to the palette
  if (!isHex(color)) return null;
  const { h, s: sat, l } = hexToHsl(color);
  const sh = steerFromDanger(h);
  return {
    id: CONN_MATCH_ID,
    name: "Match Connection",
    accent: hsl(sh, sat, l),
    hue: sh,
    tint: 0,
  };
}

/** a custom theme defined by explicit anchor colours */
export function isAnchors(p: Palette): boolean {
  return !!(p.bg && p.fg && p.primary);
}

const HEX6 = /^#[0-9a-fA-F]{6}$/;
const isHex = (v: unknown): v is string => typeof v === "string" && HEX6.test(v);

/** validate a persisted palette. Corrupt seeds (NaN hue, malformed hex) return
 * null so rehydrate falls back to the default palette — a single bad stored
 * theme used to expand to NaN CSS vars and brick the whole UI at startup. */
export function sanitizePalette(raw: unknown): Palette | null {
  if (typeof raw !== "object" || raw === null) return null;
  const p = raw as Record<string, unknown>;
  if (typeof p.id !== "string" || p.id === "" || typeof p.name !== "string") return null;
  const out: Palette = { id: p.id, name: p.name };
  if (p.custom === true) out.custom = true;
  if (p.bg !== undefined || p.fg !== undefined || p.primary !== undefined) {
    // anchors kind — the colour math only handles #rrggbb
    if (!isHex(p.bg) || !isHex(p.fg) || !isHex(p.primary)) return null;
    out.bg = p.bg;
    out.fg = p.fg;
    out.primary = p.primary;
    if (p.secondary !== undefined) {
      if (!isHex(p.secondary)) return null;
      out.secondary = p.secondary;
    }
    return out;
  }
  if (p.accent !== undefined) {
    if (!isHex(p.accent)) return null;
    out.accent = p.accent;
  }
  if (p.hue !== undefined) {
    if (typeof p.hue !== "number" || !Number.isFinite(p.hue)) return null;
    out.hue = clamp(p.hue, 0, 360);
  }
  if (p.tint !== undefined) {
    if (typeof p.tint !== "number" || !Number.isFinite(p.tint)) return null;
    out.tint = clamp(p.tint, 0, 1);
  }
  return out;
}

/** the anchor colours for a palette at a given mode (used when forking) */
export function anchorsOf(p: Palette, dark: boolean): {
  bg: string;
  fg: string;
  primary: string;
  secondary: string;
} {
  if (isAnchors(p)) {
    return { bg: p.bg!, fg: p.fg!, primary: p.primary!, secondary: p.secondary ?? p.primary! };
  }
  const v = buildVars(p, dark);
  return { bg: v["--bg-app"], fg: v["--fg"], primary: v["--accent"], secondary: v["--accent"] };
}

// A custom theme is authored once (any mode). For the requested mode we either
// use the authored colours (when they match) or synthesise the opposite:
// flip the surface lightness but keep the character hue/saturation + accents,
// adapting accent lightness for contrast on the flipped background.
function deriveAnchors(p: Palette, dark: boolean): Record<string, string> {
  const aBg = hexToHsl(p.bg!);
  const authoredDark = lumHex(p.bg!) < 0.4;
  const hue = aBg.h;
  const sat = aBg.s;

  let bg: string;
  let fg: string;
  if (dark === authoredDark) {
    bg = p.bg!;
    fg = p.fg!;
  } else if (dark) {
    bg = hsl(hue, Math.min(sat, 16), 8);
    fg = hsl(hue, Math.min(sat, 14), 92);
  } else {
    bg = hsl(hue, Math.min(sat * 1.6 + 6, 34), 96);
    fg = hsl(hue, Math.min(sat, 22), 15);
  }

  // accents: exact in the authored mode, contrast-adapted in the synthesised one
  const adapt = (hex: string) =>
    dark === authoredDark ? hex : adjustAccent(hex, dark ? "dark" : "light").hex;
  const primary = adapt(p.primary!);
  const secondary = adapt(p.secondary || p.primary!);

  const v: Record<string, string> = {};
  v["--bg-app"] = bg;
  v["--bg-sidebar"] = mix(bg, fg, 0.045);
  v["--bg-panel"] = mix(bg, fg, 0.075);
  v["--bg-raised"] = mix(bg, fg, 0.11);
  v["--bg-hover"] = mix(bg, fg, 0.16);
  v["--bg-active"] = mix(bg, fg, 0.22);
  v["--border"] = mix(bg, fg, 0.15);
  v["--border-strong"] = mix(bg, fg, 0.28);
  v["--fg"] = fg;
  v["--fg-muted"] = mix(fg, bg, 0.4);
  v["--fg-faint"] = mix(fg, bg, 0.62);
  // glass text (titlebar breadcrumb): NEUTRAL gray, untinted — it sits on the
  // wallpaper glass, not a themed surface, so the hue-tinted muted reads dirty
  v["--fg-glass"] = dark ? "hsl(0, 0%, 78%)" : "hsl(0, 0%, 27%)";
  v["--accent"] = primary;
  v["--accent-soft"] = withAlpha(primary, dark ? 0.18 : 0.14);
  v["--accent-fg"] = accentFg(primary);
  v["--accent-2"] = secondary;
  v["--glass-tint"] = withAlpha(bg, glassAlpha);
  v["--card-border"] = dark ? "rgba(255, 255, 255, 0.06)" : withAlpha(fg, 0.1);
  v["--card-highlight"] = dark ? "rgba(255, 255, 255, 0.05)" : "rgba(255, 255, 255, 0.6)";
  v["--avatar-ring"] = dark ? "rgba(255, 255, 255, 0.16)" : withAlpha(fg, 0.2);
  v["--shadow-panel"] = dark ? "0 6px 24px rgba(0, 0, 0, 0.42)" : "0 6px 22px rgba(20, 30, 55, 0.16)";
  v["--shadow-pop"] = dark ? "0 8px 24px rgba(0, 0, 0, 0.5)" : "0 8px 24px rgba(20, 30, 60, 0.18)";
  v["--cm-active-line"] = dark ? "rgba(255, 255, 255, 0.03)" : "rgba(0, 0, 0, 0.04)";
  v["--hl-bg"] = dark ? "#f5a623" : "#ffd866";
  v["--hl-fg"] = dark ? "#1a1a1a" : "#1c2128";
  v["--danger"] = dark ? "#ff5c69" : "#d92d3a";
  v["--danger-soft"] = dark ? "rgba(255, 92, 105, 0.14)" : "rgba(217, 45, 58, 0.1)";
  v["--ok"] = dark ? "#3ecf8e" : "#1a9d6b";
  v["--warn"] = dark ? "#f5a623" : "#b9770a";
  v["--warn-soft"] = dark ? "rgba(245, 166, 35, 0.12)" : "rgba(185, 119, 10, 0.13)";
  Object.assign(v, dark ? DARK_SYNTAX : LIGHT_SYNTAX);
  return v;
}

const DARK_SYNTAX = {
  "--syn-keyword": "#c792ea",
  "--syn-operator": "#89ddff",
  "--syn-number": "#f78c6c",
  "--syn-string": "#c3e88d",
  "--syn-comment": "#5e6673",
  "--syn-type": "#ffcb6b",
  "--syn-prop": "#82aaff",
  "--syn-var": "#e6e9ef",
  "--syn-punct": "#9aa3b2",
};
const LIGHT_SYNTAX = {
  "--syn-keyword": "#8a1fa6",
  "--syn-operator": "#0a7ea4",
  "--syn-number": "#b5430b",
  "--syn-string": "#2e7d32",
  "--syn-comment": "#97a0af",
  "--syn-type": "#976a00",
  "--syn-prop": "#1d4ed8",
  "--syn-var": "#1c2128",
  "--syn-punct": "#586173",
};

/** the full themeable token set for a palette + resolved mode */
export function buildVars(p: Palette, dark: boolean): Record<string, string> {
  if (isAnchors(p)) return deriveAnchors(p, dark);
  const H = p.hue ?? 0;
  const T = p.tint ?? 1; // surface tint strength (0 = neutral gray)
  const v: Record<string, string> = {};

  if (dark) {
    v["--bg-app"] = hsl(H, 14 * T, 8);
    v["--bg-sidebar"] = hsl(H, 14 * T, 11);
    v["--bg-panel"] = hsl(H, 13 * T, 13.5);
    v["--bg-raised"] = hsl(H, 12 * T, 18);
    v["--bg-hover"] = hsl(H, 12 * T, 22);
    v["--bg-active"] = hsl(H, 12 * T, 27);
    v["--border"] = hsl(H, 12 * T, 22);
    v["--border-strong"] = hsl(H, 12 * T, 32);
    v["--fg"] = hsl(H, 16 * T, 93);
    v["--fg-muted"] = hsl(H, 10 * T, 64);
    v["--fg-faint"] = hsl(H, 9 * T, 44);
    v["--fg-glass"] = "hsl(0, 0%, 78%)";
    v["--card-border"] = "rgba(255, 255, 255, 0.06)";
    v["--card-highlight"] = "rgba(255, 255, 255, 0.05)";
    v["--avatar-ring"] = "rgba(255, 255, 255, 0.16)";
    v["--shadow-panel"] = "0 6px 24px rgba(0, 0, 0, 0.34)";
    v["--shadow-pop"] = "0 8px 24px rgba(0, 0, 0, 0.45)";
    v["--cm-active-line"] = "rgba(255, 255, 255, 0.03)";
    v["--glass-tint"] = hsla(H, 16 * T, 8, glassAlpha);
    v["--hl-bg"] = "#f5a623";
    v["--hl-fg"] = "#1a1a1a";
    v["--danger"] = "#ff5c69";
    v["--danger-soft"] = "rgba(255, 92, 105, 0.14)";
    v["--ok"] = "#3ecf8e";
    v["--warn"] = "#f5a623";
    v["--warn-soft"] = "rgba(245, 166, 35, 0.12)";
    Object.assign(v, DARK_SYNTAX);
    const a = adjustAccent(p.accent ?? "#5b8cff","dark");
    v["--accent"] = a.hex;
    v["--accent-soft"] = hsla(a.h, a.s, a.l, 0.18);
    v["--accent-fg"] = a.fg;
  } else {
    v["--bg-app"] = hsl(H, 24 * T, 95);
    v["--bg-sidebar"] = hsl(H, 26 * T, 92);
    v["--bg-panel"] = hsl(H, 45 * T, 99.5);
    v["--bg-raised"] = hsl(H, 28 * T, 96);
    v["--bg-hover"] = hsl(H, 24 * T, 92);
    v["--bg-active"] = hsl(H, 22 * T, 87);
    v["--border"] = hsl(H, 22 * T, 89);
    v["--border-strong"] = hsl(H, 18 * T, 80);
    v["--fg"] = hsl(H, 22 * T, 14);
    v["--fg-muted"] = hsl(H, 12 * T, 38);
    v["--fg-faint"] = hsl(H, 12 * T, 60);
    v["--fg-glass"] = "hsl(0, 0%, 27%)";
    v["--card-border"] = hsla(H, 40 * T, 30, 0.1);
    v["--card-highlight"] = "rgba(255, 255, 255, 0.6)";
    v["--avatar-ring"] = hsla(H, 30 * T, 30, 0.2);
    v["--shadow-panel"] = "0 6px 22px rgba(20, 30, 55, 0.16)";
    v["--shadow-pop"] = "0 8px 24px rgba(20, 30, 60, 0.18)";
    v["--cm-active-line"] = "rgba(0, 0, 0, 0.04)";
    v["--glass-tint"] = hsla(H, 40 * T, 96, glassAlpha);
    v["--hl-bg"] = "#ffd866";
    v["--hl-fg"] = "#1c2128";
    v["--danger"] = "#d92d3a";
    v["--danger-soft"] = "rgba(217, 45, 58, 0.1)";
    v["--ok"] = "#1a9d6b";
    v["--warn"] = "#b9770a";
    v["--warn-soft"] = "rgba(185, 119, 10, 0.13)";
    Object.assign(v, LIGHT_SYNTAX);
    const a = adjustAccent(p.accent ?? "#5b8cff","light");
    v["--accent"] = a.hex;
    v["--accent-soft"] = hsla(a.h, a.s, a.l, 0.13);
    v["--accent-fg"] = a.fg;
  }
  return v;
}

/** swatch colours for the picker (accent + a surface sample), without applying */
export function swatch(p: Palette, dark: boolean) {
  if (isAnchors(p)) {
    const v = deriveAnchors(p, dark);
    return { accent: v["--accent"], bg: v["--bg-sidebar"] };
  }
  const T = p.tint ?? 1;
  const H = p.hue ?? 0;
  return {
    accent: adjustAccent(p.accent ?? "#5b8cff", dark ? "dark" : "light").hex,
    bg: dark ? hsl(H, 14 * T, 11) : hsl(H, 26 * T, 92),
  };
}

export function applyTheme(p: Palette, dark: boolean) {
  const vars = buildVars(p, dark);
  const root = document.documentElement;
  for (const [k, val] of Object.entries(vars)) root.style.setProperty(k, val);
  root.dataset.mode = dark ? "dark" : "light";
}
