# WRITING.md — the text register system (UX writing law)

Every user-facing string belongs to exactly one register. Registers have fixed
rules. A string that follows its register reads polished; strings that drift
between registers read amateur even when each is individually fine. This file
is law, same as tokens.css — check every new string against it.

The register table maps onto Apple HIG's two capitalization styles: HIG
title-style = the Title Case control registers (menus, buttons, titles, tabs);
HIG sentence-style = the prose registers (descriptions, tooltips, alerts,
status). The same feature name legitimately appears in both casings — register
is orthogonal to identity (`Open as Record` the menu item, "Open as record"
the cheatsheet description). Deliberate HIG deviations — the lowercase status
register, data-state markers (`NULL`, `∅ empty`, `auto`), in-place mono
shortcut hints — are a documented system, not drift; HIG has no register for
data chrome, and consistency within the app outranks literal compliance.

## Registers

| Register | Casing | Punctuation | Examples |
|---|---|---|---|
| Menu items, buttons, tabs, chips | **Title Case** | no terminal period | `Copy Qualified Name`, `Close Others`, `Set Empty String` |
| Window/dialog/section titles | Title Case | none | `Value Distribution`, `Keyboard Shortcuts` |
| Tooltips (fragment) | Sentence case | no period | `Double-click to edit` |
| Tooltips/alerts (full sentence) | Sentence case | period | `Staged changes are not written to the database and will be lost.` |
| Status/feedback lines | Sentence case, lowercase-lead ok for terse notes | no period | `copy cancelled`, `12 rows · 3.1 ms` |
| Errors | Sentence case | no period unless multi-sentence | `couldn't establish a session. Check the connection` |
| Placeholders | Sentence case or literal value | no period | `Filter tables…`, `nextval('t_id_seq')` |
| Empty states | Sentence case | no period | `No columns match` |

## Rules

1. **Title Case for controls, sentence case for prose. Never mixed.** Title
   Case: capitalize first/last word and every word except articles (a, an,
   the), conjunctions (and, or), and prepositions ≤4 letters (of, in, with,
   as, to, for). Acronyms/proper nouns keep their form: SQL, JSON, CSV, URL,
   DDL, NULL, DEFAULT, Postgres.
2. **The ellipsis is a contract.** `…` (the character, never `...`) on a
   control means "opens further UI that needs input before acting". No `…`
   means it acts immediately. Both directions are binding.
3. **No parentheticals in labels.** `Copy (no password)` is a code comment in
   a label costume. Name the object: `Copy URL` / `Copy URL with Password`.
   Qualifiers live in tooltips or hints, never parens.
4. **Verb + explicit object, ≤4 words.** Alert buttons answer the title's
   question with a verb (`Discard Edits`), never Yes/No. SQL literals and
   syntax (`''`, `%`) belong in hints/tooltips, not labels.
5. **One term per concept, app-wide** — see the terminology table. Synonyms
   read as different features.
6. **Typography register**: real `…` and `⌘⇧⌥⌃` glyphs (never `Cmd+`),
   `·` for metadata separators, typographic quotes in prose (straight quotes
   only inside SQL/code). "and" over `&` everywhere except space-tight compact
   labels (chip/group-header width limits, e.g. `PK & Time`); placeholders and
   dialog text are prose — always "and".
7. **No em dashes in UI strings.** Interface text splits the thought instead:
   two sentences, a comma, or `·` for status fragments. `couldn't establish a
   session — check the connection` becomes `couldn't establish a session.
   Check the connection`. The em dash reads editorial, not interface — Apple
   UI strings never carry it. Docs, comments, and commits keep it (rule
   applies only to user-visible strings, like everything here). Amended
   2026-07-22: earlier revisions of THIS rule sanctioned `—` for asides; that
   was wrong for the UI register.

## Shortcut glyph register (rendering law — pairs with DESIGN.md rule 7)

Shortcut symbols are characters of the UI font, not icons and not mono.
All rendering routes through `<Kbd>` (src/design/Kbd.tsx); hand-typed chords
in JSX are a lint error.

1. **Font**: `--font-ui` (SF Pro), same optical size as the label or one step
   below — never `--font-mono`, never smaller-and-faded. (Identifiers in the
   hint slot STAY mono — they are data. A hint may carry both registers side
   by side.)
2. **Modifier order**: ⌃ ⌥ ⇧ ⌘ — always. `⇧⌘F`, never `⌘⇧F`, never `⌘+Shift+F`.
   Key letter last, uppercase, no separators.
3. **Canonical codepoints**: ⌘ ⇧ ⌥ ⌃, return ↩ (U+21A9, never ↵/⏎), enter ⌅,
   delete ⌫, forward-delete ⌦, tab ⇥, arrows ↑↓←→, page ⇞⇟. House deviations,
   deliberate: `esc` stays the lowercase word (⎋ is obscure), Space stays the
   word `Space`.
4. **Contrast**: tier 2 (`--fg-muted`) — shortcuts are secondary information,
   never faint (faint = disabled register).
5. **Costume by surface**: menus and buttons get bare glyphs; teaching
   surfaces (cheatsheet, empty states) get one keycap per key.

## Terminology (canonical → banned synonyms)

| Canonical | Banned in UI | Notes |
|---|---|---|
| connection | profile, conn | `profile` stays a code-only term |
| query tab / table tab | editor tab, browser tab | |
| saved query | bookmark, snippet | |
| row, column, cell | record, field | `Open as Record` is the ONE exception (transposed view's proper name: Record View) |
| stage (edit) → commit (⌘S) | save, apply, write | `Save` is for files/saved queries only |
| discard | revert, drop | discarding staged edits/drafts |
| revert | undo | ONLY for the post-commit inverse-SQL feature (Undo commit) — keep `Undo` there |
| duplicate | clone, copy (for rows/tabs) | `Copy` = clipboard only |
| production | prod | `PROD` allowed only in the chip/strip (established ceremony) |
| origin | source (for connection provenance) | |
| Add Row | new row, insert row | the band + its shortcuts |
| refresh | reload, re-run (in UI) | |

## What this is not

Not a style straitjacket for docs/comments/commits — those are engineer-facing
and follow normal prose. This file governs ONLY strings a user sees in the app.

## Identifiers inside chrome (the data/chrome boundary)

User data (column names, table names, CTE names, file names) never sits bare
inside a Title Case label — it reads as a typo in the sentence. Three
sanctioned forms:

1. **Context supplies the object** (preferred): the menu/dialog already belongs
   to the thing — `Sort Ascending`, `Hide Column`, not `Sort quantity Ascending`.
2. **The mono hint slot**: when the name aids confirmation, it rides
   right-aligned in mono (`Copy Name   quantity`).
3. **Inline only to disambiguate siblings**: `Open Referenced orders →` next to
   `Open Referenced users →` keeps names — dropping them would merge the items.
   Whole-label identifiers (submenu rows that ARE the identifier) are data
   items, fine as-is.

General form: every string is chrome or data; when data appears inside chrome
it wears data's clothes (mono, hint slot, quotes) or doesn't appear.
