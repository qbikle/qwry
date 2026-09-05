# DESIGN.md: the pixel law

Third law file. WRITING.md governs words, LESSONS.md governs bug classes,
this file governs pixels. It is binding the same way: every change to visible
chrome is checked against it, reviews cite it by rule number, and pushback on
requests that violate it, even the maintainer's, is wanted.

The founding audit (2026-07-22) found ~80 hand-authored control rule-sets for
9 conceptual species, a pressed state on 2 of them, 163 off-scale spacing
literals, 8 chrome icon sizes, and 5 dialects of "quick transition". None of
those were failures of taste; they were proof the numbers were never written
down. These are the numbers.

Enforcement is `scripts/design-lint.ts` (rule 10). A rule enforced by a
component or a lint never needs a reviewer; prefer that shape whenever a rule
can be encoded.

## Rule 1: Control taxonomy

Every interactive control belongs to exactly one species. The species are:

| species | base | notes |
|---|---|---|
| Action button | `.btnish` / `.btn` (tokens.css) | `.primary` filled accent, `.danger` filled danger; ONE idea of each |
| Icon button | `.iconbtn` (tokens.css) | ghost by default; `.iconbtn-lg` 28px box; `.iconbtn-sm` 18px inline-in-text tier (never shrink the 22px box with negative margins inside a scroller: line box sizes by margin box, scrollable overflow by border box → phantom scrollbars); `.bordered` for standalone toolbars |
| Segmented control | recipe (no base class yet) | panel-inset bordered track, 2px gap, hover bg-hover, active = accent-soft; view-tab variants may keep neutral bg-active active (annotated). Extracting `.seg` is ledgered |
| Chip / pill toggle | recipe (no base class yet) | radius-pill, border, active = accent-soft; `.chipish` extraction ledgered |
| Dashed ghost (add/create) | existing dashed pattern | bg none, dashed border-strong → hover accent |
| Link button | `.linkish` | accent text + hover accent-soft fill; NEVER feedback-free |
| Soft-danger button | recipe; `.soft-danger` (threads.css) is its first class-based instance | danger-soft fill + danger text, for cancel/delete inside busy toolbars where filled `.danger` would shout (qb-cancel, tp-del-btn, `.soft-danger`); full state matrix mandatory |
| Stepper (joined pair) | segmented-pair recipe | shared border, hairline divider, radius split, ghost-until-hover (CopySplit, rv-step) |
| Menu row | ContextMenu / cmdk styles | highlight = accent fill, `.hot` |
| List row / card | per-surface (`.trow`, the Threads sheet's row) | hover = bg-hover minimum; `.hot` the transient highlight, `.active` the persistent selection |
| Switch | `.switch` (tokens.css), rendered via `<Switch>` | macOS toggle for feature/setting rows; hidden native checkbox is the truth (role=switch, :has-derived states, spring knob). Native checkboxes remain the species for selection within content (filter rows, lists, CM search panels) |

A new control joins a species or gets a new row in this table in the same PR.
Re-authoring a species locally (13 copies of the action button, 23 of the
icon button) is the founding sin this file exists to prevent.

**Selected-state naming:** `.active` = persistent selection; `.hot` =
transient keyboard/pointer highlight. `.on`, `.sel`, `.open` are banned
spellings (cmdk's `[data-selected]` is a documented library exception).

## Rule 2: The state matrix is a contract

Every interactive control ships all five states: rest, hover, active
(pressed), focus-visible, disabled. The base classes provide them; a bespoke
control must write them. Pressed = `scale(0.97)` or a bg step: something the
hand feels. Disabled = `opacity: var(--o-disabled)` (one value app-wide, no
more .4/.45/.5/.55). `outline: none` is legal only when the same block
defines a replacement focus treatment.

**Stable chrome**: state never resizes chrome. Strips (status bars, footers,
toolbars, headers) get a FIXED height sized to their tallest state; content
swaps inside the reserved space. Hover/state reveals occupy layout
(`visibility`/`opacity`, never `display`) when the revealed element is taller
or wider than its siblings. Inline text that changes with state reserves the
widest face (the Cancelling… stacked-grid precedent). Scope: this binds
WITHIN-mode state swaps (hover, progress, mid-interaction flips); a
transition BETWEEN modes (idle→running, view→edit) may reflow its own
inline controls; reserving the widest face across modes turns everyday
chrome into dead space (the fat-Run lesson). Preferred resolution when a
control should stay constant across modes: EQUALIZE the faces by copy
first (trim the long face), then reserve (the qb action slot precedent). An interaction that moves its
own container is a broken contract with the user's eyes.

## Rule 3: Contrast tiers are semantic

| tier | token | meaning |
|---|---|---|
| 1 | `--fg` | content: values, labels, active controls |
| 2 | `--fg-muted` | secondary: hints, shortcut glyphs, metadata, captions |
| 3 | `--fg-faint` | decoration and disabled ONLY |

Load-bearing enabled information never sits at tier 3; faint tells the user
"this doesn't matter". Raw `opacity` never fakes a tier (it mutates child
icons and backgrounds too); legal opacity values are 0 and 1 (reveal
patterns) and `var(--o-disabled)`. Anything else is `/* optical */`.

**Glass surfaces**: content sitting directly on the vibrancy glass (titlebar,
gutters) cannot trust the fg ramp: the backdrop is the user's wallpaper at a
user-set transparency. Such content carries its own surface: buttons/chips get
a translucent theme underlay (`color-mix(var(--bg-panel) ~72%, transparent)`,
tints layered above via gradient), text gets a same-theme halo shadow that
vanishes on matching backdrops. Contrast must survive ANY wallpaper.

## Rule 4: The 4px grid

Spacing (padding, margin, gap) comes from `--sp-*` or a named token
REFERENCED, not retyped; a token you don't reference is a magic number with
a name. Allowed literals: multiples of 4, plus 1–2px for hairlines and micro
gaps. A deliberate off-grid value carries `/* optical */` on its line; the
annotation is a design decision, reviewable like any other.

## Rule 5: Icons live on the trio

`--icon-sm: 12` (dense lists, tree, menus) · `--icon-md: 14` (toolbars,
buttons) · `--icon-lg: 16` (headers, empty states). One size per surface;
a list that mixes sizes is broken by definition. Documented exceptions:
avatars/logos (22/40/44/64), the 8px connection dot (the titlebar's and the
Ask footer's provenance mark: a mark, not an icon) and the grid's 11px type
glyphs (data register).
Baseline nudges (`translate: 0 1px` and friends) live INSIDE a component's
own definition, never at use-sites; each one carries `/* optical */`.

## Rule 6: Motion speaks one language

CSS: `--dur-quick` (120ms: hover, color, border), `--dur-slow` (240ms:
panels, reveals), eased by `--ease-std`; `--ease-spring` for overshoot
moments. JS choreography: `springs.ts` presets only. A transition literal
that bypasses the tokens is a dialect; dialects are the reason surfaces feel
unrelated while looking related.

## Rule 7: Shortcut glyphs

Full register in WRITING.md (it is text law). Summary: UI font never mono,
modifier order ⌃⌥⇧⌘, canonical codepoints (↩ not ↵), tier-2 contrast, bare
glyphs in menus/buttons, keycaps only on teaching surfaces. All rendering
routes through `<Kbd>` (src/design/Kbd.tsx) so the wrong form is untypeable.

## Rule 8: Affordance announces three times

At rest it looks pressable, on hover it responds, on press it acknowledges.
The inverse binds too: non-interactive elements never wear control costumes
(boxed pills that aren't buttons). Reveal-on-hover controls are legal but the
surface must work without discovering them (menu/keyboard route exists).

## Rule 9: The pixel lens

Any wave touching visible chrome ships screenshot evidence from the running
app (or the WKWebView harness): geometry and beauty are verified in pixels,
not inferred from CSS. This extends LESSONS #8 from bugs to aesthetics:
consolidating or renaming chrome IS a visual change and ships under the same
rule. For a resizable pane the evidence is frames at its floor, default and
max width of a LIVE state (a real answer with real long content, never a
placeholder or a failure block standing in for one), in both themes; one
width or one theme is not evidence (rule 13).

## Rule 10: The lint gate

`bun scripts/design-lint.ts` scans src/ for: off-grid spacing literals, raw
opacity tiers, transition-duration literals, icon sizes off the trio, wrong
modifier order, wrong-codepoint glyphs (↵ ⏎), and em dashes in UI strings
(WRITING.md). `/* optical */` (CSS) and `// em-ok` / config allowlists are
the only escape hatches. Warning mode during migration; `--enforce` after.
Then it gates every wave like tsc does.

## Rule 11: Every string earns its pixels

The test is deletion: read the surface with the string gone, and if nothing
is lost, the string was dead. Chrome never explains a standard interaction
(↩ sends, ⇧↩ newlines, ⌘. cancels, Esc closes, click opens) and never states
what is always true (read-only, "every answer shows its SQL", "answers come
with the SQL"). The norm is silent; only the exception speaks (`small` on a
model pill, `PROD` on the titlebar, `· not running` on a provider). Teaching
lives where teaching is asked for: tooltips, menus, the Keyboard Shortcuts
sheet, a first-run setup card. Precedent: the W2 Ask hint line, `↩ ask · ⇧↩
newline · read-only · every answer shows its SQL`, one full row of the pane
at every width, satisfying every rule the reviewers had; and the empty-state
slogan ("Answers come with the SQL…"), the same defect in prose costume. A
string that survives only because a rule permits it has not passed this one.

## Rule 12: A strip states one thing

A header answers "where am I": a title, at most one qualifier, and the zone's
own actions as at most two icon buttons. Controls that configure an action
sit beside that action (the model picker beside Send, never in the header); a
status that belongs to the window stays in the window's chrome (PROD is the
titlebar chip); provenance appears once per zone (the answer footer's connection dot,
not the header AND the footer). A strip holding two ideas is two strips, or
one idea too many, and the strip's fixed height (rule 2) is not a licence to
fill it. Precedent: the W2 Ask header, `icon · Ask · avatar · name · db ·
READ-ONLY · model pill · tier · Threads · New`: ten things in 40px, and the
badge clipped to `READ-ONL` at the floor because the strip had nothing left
to give. The Inspector's header, a text title and two icon buttons, was the
pattern in the same window all along.

## Rule 13: Floor first

Chrome is designed at the floor width and then given room, never the reverse.
The sketch shows floor, default and max side by side with real long content
(a nine-row grid, a sixty-character question, wrapping chips); the chrome is
identical across the three; nothing clips, wraps or ellipsizes at the floor
except content that owns its own overflow (grid cells, the collapsed SQL
preview, the thinking strip's left fade); growth feeds content (grid, text,
chips), never new chrome. A control the max width can show and the floor
cannot is a control that does not exist. Frames at the three widths of a live
state are the evidence (rule 9). Precedent: the W2 sketch, drawn once at 392:
at 320 the header badge clipped and the grid header cut a column name, under
380 the footer wrapped to two lines. Every one of those was visible the
moment a second width was drawn.

## Rule 14: Data once

A fact renders in exactly one slot. Results in the grid, the query in the SQL
row, interpretations in the assumption chips, timing in the status line,
provenance in the footer's connection dot; prose never repeats any of them. Answer prose
is one or two sentences of interpretation, what the numbers mean, not what
they are; the model's text is chrome here, because the anatomy already
carries the data. The rule binds chrome to chrome too: a name in the header
and again in the footer, a row count above the grid and again below it, are
two slots for one fact and one of them goes. Precedent: the W2 answer prose,
which restated the grid as a markdown table, the SQL in a fence and the
assumptions as a bullet list, rendered raw under a grid, a SQL row and chips
that already showed all three. The anatomy was right; the prose was the
duplicate, and the display strip that removes it is the fix.
