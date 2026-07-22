// The one shortcut-glyph renderer (WRITING.md glyph register, DESIGN.md rule
// 7). Takes a chord SPEC ("shift+cmd+f") and emits canonical glyphs in HIG
// modifier order — wrong order or wrong codepoint is untypeable by
// construction. Hand-typed chord strings in JSX are a design-lint error.
//
// Two costumes: bare (default — menus, buttons, inline hints) and caps
// (teaching surfaces only: cheatsheet, empty states — one keycap per key).

const MODIFIER_ORDER = ["ctrl", "alt", "shift", "cmd"] as const;
type Modifier = (typeof MODIFIER_ORDER)[number];

const MODIFIER_GLYPH: Record<Modifier, string> = {
  ctrl: "⌃",
  alt: "⌥",
  shift: "⇧",
  cmd: "⌘",
};

const MODIFIER_ALIAS: Record<string, Modifier> = {
  ctrl: "ctrl",
  control: "ctrl",
  alt: "alt",
  opt: "alt",
  option: "alt",
  shift: "shift",
  cmd: "cmd",
  meta: "cmd",
  command: "cmd",
};

// canonical codepoints — ↩ (U+21A9) is Return; ↵/⏎ are the impostors (lint-ok)
// the lint bans; this file documents them. esc/Space stay words: documented
// house deviations.
const KEY_GLYPH: Record<string, string> = {
  return: "↩",
  enter: "⌅",
  delete: "⌫",
  backspace: "⌫",
  fwddelete: "⌦",
  esc: "esc",
  escape: "esc",
  tab: "⇥",
  space: "Space",
  up: "↑",
  down: "↓",
  left: "←",
  right: "→",
  pageup: "⇞",
  pagedown: "⇟",
  home: "↖",
  end: "↘",
  plus: "+",
  minus: "-",
  comma: ",",
  period: ".",
  slash: "/",
};

/** "shift+cmd+f" → ["⇧", "⌘", "F"] — modifiers re-sorted to ⌃⌥⇧⌘ regardless
 *  of spec order, single chars uppercased, named keys mapped to canon */
export function chordGlyphs(chord: string): string[] {
  const mods: Modifier[] = [];
  const keys: string[] = [];
  for (const raw of chord.split("+")) {
    const part = raw.trim().toLowerCase();
    if (part === "") continue;
    const mod = MODIFIER_ALIAS[part];
    if (mod) {
      if (!mods.includes(mod)) mods.push(mod);
    } else {
      keys.push(KEY_GLYPH[part] ?? (part.length === 1 ? part.toUpperCase() : part));
    }
  }
  mods.sort((a, b) => MODIFIER_ORDER.indexOf(a) - MODIFIER_ORDER.indexOf(b));
  return [...mods.map((m) => MODIFIER_GLYPH[m]), ...keys];
}

export function Kbd({ chord, caps = false }: { chord: string; caps?: boolean }) {
  const glyphs = chordGlyphs(chord);
  if (caps) {
    return (
      <span className="kbd-caps">
        {glyphs.map((g, i) => (
          <kbd key={i} className="kbd-cap">
            {g}
          </kbd>
        ))}
      </span>
    );
  }
  // bare: glyphs run together (⇧⌘F); word keys need a joining space so
  // "⌘Space" and "⌥ esc" stay readable
  const text = glyphs.reduce(
    (acc, g) => acc + (acc !== "" && g.length > 1 ? " " : "") + g,
    "",
  );
  return <span className="kbd">{text}</span>;
}
