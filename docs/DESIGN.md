# DESIGN.md — the pixel law

Third law file. WRITING.md governs words, LESSONS.md governs bug classes,
this file governs pixels. It is binding the same way: every change to visible
chrome is checked against it, reviews cite it by rule number, and pushback on
requests that violate it (including the user's) is wanted.

The founding audit (2026-07-22) found ~80 hand-authored control rule-sets for
9 conceptual species, a pressed state on 2 of them, 163 off-scale spacing
literals, 8 chrome icon sizes, and 5 dialects of "quick transition". None of
those were failures of taste — they were proof the numbers were never written
down. These are the numbers.

Enforcement is `scripts/design-lint.ts` (rule 10). A rule enforced by a
component or a lint never needs a reviewer; prefer that shape whenever a rule
can be encoded.

## Rule 1 — Control taxonomy

Every interactive control belongs to exactly one species. The species are:

| species | base | notes |
|---|---|---|
| Action button | `.btnish` / `.btn` (tokens.css) | `.primary` filled accent, `.danger` filled danger — ONE idea of each |
| Icon button | `.iconbtn` (tokens.css) | ghost by default; `.iconbtn-lg` 28px box; `.bordered` for standalone toolbars |
| Segmented control | recipe (no base class yet) | panel-inset bordered track, 2px gap, hover bg-hover, active = accent-soft; view-tab variants may keep neutral bg-active active (annotated). Extracting `.seg` is ledgered |
| Chip / pill toggle | recipe (no base class yet) | radius-pill, border, active = accent-soft; `.chipish` extraction ledgered |
| Dashed ghost (add/create) | existing dashed pattern | bg none, dashed border-strong → hover accent |
| Link button | `.linkish` | accent text + hover accent-soft fill — NEVER feedback-free |
| Soft-danger button | recipe | danger-soft fill + danger text, for cancel/delete inside busy toolbars where filled `.danger` would shout (qb-cancel, tp-del-btn); full state matrix mandatory |
| Stepper (joined pair) | segmented-pair recipe | shared border, hairline divider, radius split, ghost-until-hover (CopySplit, rv-step) |
| Menu row | ContextMenu / cmdk styles | highlight = accent fill, `.hot` |
| List row / card | per-surface | hover = bg-hover minimum |

A new control joins a species or gets a new row in this table in the same PR.
Re-authoring a species locally (13 copies of the action button, 23 of the
icon button) is the founding sin this file exists to prevent.

**Selected-state naming:** `.active` = persistent selection; `.hot` =
transient keyboard/pointer highlight. `.on`, `.sel`, `.open` are banned
spellings (cmdk's `[data-selected]` is a documented library exception).

## Rule 2 — The state matrix is a contract

Every interactive control ships all five states: rest, hover, active
(pressed), focus-visible, disabled. The base classes provide them; a bespoke
control must write them. Pressed = `scale(0.97)` or a bg step — something the
hand feels. Disabled = `opacity: var(--o-disabled)` (one value app-wide, no
more .4/.45/.5/.55). `outline: none` is legal only when the same block
defines a replacement focus treatment.

## Rule 3 — Contrast tiers are semantic

| tier | token | meaning |
|---|---|---|
| 1 | `--fg` | content: values, labels, active controls |
| 2 | `--fg-muted` | secondary: hints, shortcut glyphs, metadata, captions |
| 3 | `--fg-faint` | decoration and disabled ONLY |

Load-bearing enabled information never sits at tier 3 — faint tells the user
"this doesn't matter". Raw `opacity` never fakes a tier (it mutates child
icons and backgrounds too); legal opacity values are 0 and 1 (reveal
patterns) and `var(--o-disabled)`. Anything else is `/* optical */`.

## Rule 4 — The 4px grid

Spacing (padding, margin, gap) comes from `--sp-*` or a named token
REFERENCED, not retyped — a token you don't reference is a magic number with
a name. Allowed literals: multiples of 4, plus 1–2px for hairlines and micro
gaps. A deliberate off-grid value carries `/* optical */` on its line; the
annotation is a design decision, reviewable like any other.

## Rule 5 — Icons live on the trio

`--icon-sm: 12` (dense lists, tree, menus) · `--icon-md: 14` (toolbars,
buttons) · `--icon-lg: 16` (headers, empty states). One size per surface —
a list that mixes sizes is broken by definition. Documented exceptions:
avatars/logos (22/40/44/64) and the grid's 11px type glyphs (data register).
Baseline nudges (`translate: 0 1px` and friends) live INSIDE a component's
own definition, never at use-sites; each one carries `/* optical */`.

## Rule 6 — Motion speaks one language

CSS: `--dur-quick` (120ms — hover, color, border), `--dur-slow` (240ms —
panels, reveals), eased by `--ease-std`; `--ease-spring` for overshoot
moments. JS choreography: `springs.ts` presets only. A transition literal
that bypasses the tokens is a dialect; dialects are the reason surfaces feel
unrelated while looking related.

## Rule 7 — Shortcut glyphs

Full register in WRITING.md (it is text law). Summary: UI font never mono,
modifier order ⌃⌥⇧⌘, canonical codepoints (↩ not ↵), tier-2 contrast, bare
glyphs in menus/buttons, keycaps only on teaching surfaces. All rendering
routes through `<Kbd>` (src/design/Kbd.tsx) so the wrong form is untypeable.

## Rule 8 — Affordance announces three times

At rest it looks pressable, on hover it responds, on press it acknowledges.
The inverse binds too: non-interactive elements never wear control costumes
(boxed pills that aren't buttons). Reveal-on-hover controls are legal but the
surface must work without discovering them (menu/keyboard route exists).

## Rule 9 — The pixel lens

Any wave touching visible chrome ships screenshot evidence from the running
app (or the WKWebView harness) — geometry and beauty are verified in pixels,
not inferred from CSS. This extends LESSONS #8 from bugs to aesthetics:
consolidating or renaming chrome IS a visual change and ships under the same
rule.

## Rule 10 — The lint gate

`bun scripts/design-lint.ts` scans src/ for: off-grid spacing literals, raw
opacity tiers, transition-duration literals, icon sizes off the trio, wrong
modifier order, wrong-codepoint glyphs (↵ ⏎), and em dashes in UI strings
(WRITING.md). `/* optical */` (CSS) and `// em-ok` / config allowlists are
the only escape hatches. Warning mode during migration; `--enforce` after —
then it gates every wave like tsc does.
