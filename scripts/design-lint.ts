// design-lint — enforcement for docs/DESIGN.md (rule 10) and the WRITING.md
// glyph/em-dash registers. Warning mode by default (prints the census);
// --enforce exits 1 on any violation. Escape hatches: `/* optical */` on a
// CSS line, `// em-ok` on a TSX line, and the allowlists below — every
// escape is a reviewable design decision, not silence.
//
// Run: bun scripts/design-lint.ts [--enforce]

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..", "src");
const ENFORCE = process.argv.includes("--enforce");

// DESIGN.md rule 5 — the icon trio (+ documented exceptions)
const ICON_SIZES = new Set([12, 14, 16]);
const ICON_EXCEPTIONS = new Set([22, 40, 44, 64]); // avatars/logos
// grid data-register type glyphs (11px) are exempted per-file:
const ICON_EXEMPT_FILES = new Set(["grid/typeIcon.tsx"]);

// DESIGN.md rule 4 — 4px grid; 1–2px hairlines/micro-gaps legal
const gridOk = (px: number) => px <= 2 || px % 4 === 0;

type Finding = { rule: string; file: string; line: number; text: string };
const findings: Finding[] = [];
const add = (rule: string, file: string, line: number, text: string) =>
  findings.push({ rule, file, line, text: text.trim().slice(0, 90) });

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else yield p;
  }
}

const SPACING_PROP = /^\s*(padding|margin|gap|row-gap|column-gap)(-[a-z]+)?\s*:/;
const PX_VALUE = /(\d+(?:\.\d+)?)px/g;
const OPACITY = /^\s*opacity\s*:\s*([\d.]+)\s*[;}]/;
const TRANSITION = /^\s*(transition|animation)(-duration)?\s*:/;
const DUR_LITERAL = /\b\d+(\.\d+)?m?s\b/;
// wrong modifier order: ⌘ before any modifier, ⇧ before ⌥/⌃, ⌥ before ⌃
const BAD_ORDER = /⌘[⌃⌥⇧]|⇧[⌃⌥]|⌥⌃/;
const BAD_RETURN = /[↵⏎]/;
const ICON_SIZE = /\bsize=\{(\d+)\}/g;

for (const path of walk(SRC)) {
  const rel = path.slice(SRC.length + 1);
  const isCss = path.endsWith(".css");
  const isTsx = path.endsWith(".tsx") || path.endsWith(".ts");
  if (!isCss && !isTsx) continue;
  const lines = readFileSync(path, "utf8").split("\n");

  // block-comment tracker (/* … */ spans lines; JSX comments are {/* … */})
  let inBlock = false;
  lines.forEach((line, i) => {
    const n = i + 1;
    const wasInBlock = inBlock;
    if (inBlock) {
      if (line.includes("*/")) inBlock = false;
    } else {
      const open = line.lastIndexOf("/*");
      if (open !== -1 && line.indexOf("*/", open) === -1) inBlock = true;
    }

    if (isCss) {
      if (line.includes("/* optical */")) return;
      // rule 4: spacing on the 4px grid
      if (SPACING_PROP.test(line)) {
        for (const m of line.matchAll(PX_VALUE)) {
          const px = parseFloat(m[1]);
          if (!gridOk(px)) add("grid", rel, n, line);
        }
      }
      // rule 3: raw opacity tiers (0/1 reveal patterns and tokens are legal)
      const op = line.match(OPACITY);
      if (op) {
        const v = parseFloat(op[1]);
        if (v !== 0 && v !== 1) add("opacity", rel, n, line);
      }
      if (/opacity\s*:\s*var\(/.test(line)) {
        // token form — legal, and the regex above can't match it anyway
      }
      // rule 6: transition literals bypass the duration tokens
      if (TRANSITION.test(line) && DUR_LITERAL.test(line) && !line.includes("var(--dur")) {
        add("motion", rel, n, line);
      }
    }

    if (isTsx) {
      if (line.includes("lint-ok")) return;
      const code = line.trim();
      const isComment =
        wasInBlock ||
        code.startsWith("//") ||
        code.startsWith("*") ||
        code.startsWith("/*") ||
        code.startsWith("{/*") ||
        (line.includes("/*") && line.indexOf("/*") < line.indexOf("—") && line.includes("—"));
      // glyph register: order + codepoints (comments too — they teach the next reader)
      if (BAD_ORDER.test(line)) add("glyph-order", rel, n, line);
      if (BAD_RETURN.test(line)) add("glyph-codepoint", rel, n, line);
      // WRITING.md rule 7: no em dashes in UI strings (comments exempt).
      // Any non-comment dash is flagged — JSX text continuation lines carry
      // no quote/angle marker (a real miss shipped that way), and TS code
      // can't legally contain — outside strings, so the only false positive
      // is a trailing // comment, excluded by position
      if (!isComment && line.includes("—") && !line.includes("em-ok")) {
        const idx = line.indexOf("—");
        const cmt = line.indexOf("//");
        if (cmt === -1 || cmt > idx) add("em-dash", rel, n, line);
      }
      // rule 5: icon trio
      if (!ICON_EXEMPT_FILES.has(rel)) {
        for (const m of line.matchAll(ICON_SIZE)) {
          const s = parseInt(m[1], 10);
          if (!ICON_SIZES.has(s) && !ICON_EXCEPTIONS.has(s)) add("icon-size", rel, n, line);
        }
      }
    }
  });
}

const byRule = new Map<string, Finding[]>();
for (const f of findings) {
  const list = byRule.get(f.rule) ?? [];
  list.push(f);
  byRule.set(f.rule, list);
}

console.log(`design-lint — ${findings.length} finding(s)${ENFORCE ? " (enforcing)" : " (census mode)"}\n`);
for (const [rule, list] of [...byRule.entries()].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`  ${rule}: ${list.length}`);
  const show = process.argv.includes("--all") ? list : list.slice(0, 5);
  for (const f of show) console.log(`    ${f.file}:${f.line}  ${f.text}`);
  if (show.length < list.length) console.log(`    … ${list.length - show.length} more (--all to list)`);
  console.log("");
}

if (ENFORCE && findings.length > 0) process.exit(1);
