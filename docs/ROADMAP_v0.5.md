# v0.3 -> v0.5 — Roadmap to a releasable qwry

> Session protocol (same as the main ROADMAP): pick the next unchecked item in the current milestone. Build → verify per the milestone Gate → tick → append a dated session note. One milestone ≈ one session; finishing early, pull from the next. Read `docs/ARCHITECTURE.md` first; fit the existing structure, don't fork it.

> **2026-07-02 — Mission upgraded + density audit folded in.** Goal is no longer "releasable v0.5" as an endpoint but **surpass TablePlus/Postico/Beekeeper/DataGrip/pgAdmin** — v0.5 is a waypoint, not a finish line. A 13-agent audit (9 code surfaces + 4 competitor/workflow lenses) produced `docs/GAPS.md` — the ranked census this roadmap now draws from (raw reports: `docs/audit-2026-07/`). Two invariants outrank everything: (1) never feels slow at any scale; (2) never lies about or corrupts data. Key consequences for this plan: **v0.35 is now the Correctness Milestone** (GAPS §1 ledger replaces its old bug table); v0.4 perf absorbs GAPS §2; run-statement-under-cursor and selection-stats are **promoted to P0**; the surpass/leapfrog list (GAPS §4) seeds Beyond-v0.5.

## North star

**"Releasable v0.5"** = qwry stops feeling like a strong prototype and starts feeling like a finished Mac app you'd hand a colleague. The three differentiators (schema-aware intellisense, edit-from-arbitrary-SQL, first-class jsonb) already win; v0.5 closes the **table-stakes gaps** every competitor has (find, sort/filter, export, DDL, context menus), makes it **provably fast** (perf budgets enforced, not vibed), and **kills the bug class** that makes it feel half-built. The through-line: **polish · completeness · speed** — finish what exists before adding anything new, and never ship a feature that violates a perf budget.

---

## Cross-cutting tracks (run alongside milestones)

These four tracks are not a milestone — they bleed into every one below. Each milestone Gate must leave its slice of these tracks green. Tick items here as they land in whichever milestone carries them.

### Performance / anti-sluggish (each item = the symptom + the fix)

Budgets are law: **cold start <500ms · keystroke→completion <16ms · grid scroll 60fps · drag-select 60fps**. Measure before/after, don't trust feel (see Gate in v0.4).

- [ ] **Cells re-render on every arrow/drag** → `React.memo` the cell, keyed on `(value, selected, focused, dirty, flash, width, truncated)` so only changed cells repaint. *(Grid.tsx — biggest win for least code.)*
- [ ] **Drag-select fires `setFocus` per cell crossed (O(cells))** → rAF-throttle the dragOver handler + pointer-capture; coalesce to one store write per frame.
- [ ] **`import()` runs per keystroke / inside keydown** → hoist the completion-source dynamic import and the ⌘S/⌘R/⌘⇧D shortcut imports to static module-top imports (engine.ts:251; shortcut handlers). Kills latency + the import race.
- [ ] **Over-broad store subscriptions repaint on every streamed batch / keystroke** → narrow selectors + projections: Inspector subscribes to the focused cell not `statements`; TabBar to tab ids/names not full tabs; lint stops dispatching editor txns during streaming.
- [ ] **Filter-value input re-runs a full streaming SELECT per char** (`manish` = 6 queries) → debounce, or apply-on-Enter/blur (browser.ts:186).
- [ ] **Browser infinite-scroll re-streams from row 0 each page (O(n²))** → keyset pagination (`WHERE pk > :last ORDER BY pk` append) with a PK tiebreaker; also fixes dup/missing rows under non-unique sort (browser.ts:196).
- [ ] **`FUNCS` introspection pulls ~2–4k pg_catalog fns on every connect/⌘R/DDL-sniff** → scope introspection to user schemas; keep catalog builtins as a separate static list for completion only. Speeds every schema fetch.
- [ ] **`applyTheme` does ~40 `setProperty` calls on `:root`** → build one `cssText` string and write once (avoids repeated style recalc per mode/palette change).
- [ ] **Set-NULL over a rect fires N `setEdit` calls = N full re-renders** → one batched `setEdit`-many store write (Grid.tsx:321).
- [ ] **Tab strip uses smooth `scrollIntoView`** (violates never-animate-scroll) → `inline:'nearest'`, no `behavior`.
- [ ] **`panelIn` springs replay on home↔work layout swap** → don't re-animate the big results card on layout transitions.
- [ ] **No `prefers-reduced-motion` path** → guard all springs; reduced-motion users get instant.
- [ ] *(L, stretch)* **String-per-cell allocation on large decode** (millions of allocs for 50k×N, execute.rs:113) → borrow / columnar batching on the PG text wire path. Only if the budget gate flags decode as the bottleneck.

### Bug polish (each = the bug + where + fix)

- [ ] **Copy-as-INSERT hardcodes `your_table`** (Grid.tsx:256) → thread the real table name (already available) into `formatCells`. Top quick-win — every INSERT is currently wrong.
- [ ] **In-place cell editor jumps to (0,0) when the cell is scrolled out of the virtual window** (Grid.tsx:618) → clamp / anchor-fallback to the visible edge.
- [ ] **`structuredValue` treats plain text starting with `{`/`[` as JSON** → a text cell like `[draft]` stages `JSON.stringify` output and corrupts on commit (format.ts:65) → gate the heuristic on `type_name` (jsonb/json/array only).
- [ ] **Semantic no-op JSON/array edits never clear dirty → phantom UPDATE** (whitespace/key-order differs, edits.ts:129) → normalize-compare on stage; if semantically equal to the DB text, clear the edit.
- [ ] **Array detection is off until the editability map loads → array cell edited as scalar** (Inspector.tsx:149) → re-derive the editor mode when the map resolves.
- [ ] **Inspector truncated full-value fetch uses hand-rolled SQL** that breaks on dotted/quoted idents, no `.catch` → "Loading…" forever (Inspector.tsx:86) → reuse the backend full-value command + add `.catch`.
- [ ] **`apply_edits`/`delete` report `committed:true` on a 0- or 2-row match (no ROLLBACK)** inside the BEGIN/COMMIT (edit.rs:399) → `ROLLBACK` and report failure when `matched != 1`.
- [ ] **Index-out-of-bounds panic risk on empty introspection `statements[0]`** (edit.rs:130/574; violates no-unwrap rule) → use `.first()` + error.
- [ ] **"Clear history (all)" only clears the active profile** (Palette.tsx:157 / appdb.rs:292) → relabel, or add a true cross-profile clear.
- [x] **ThemePicker can't be closed with Esc; menus have no Esc** → done (Step 1): one global topmost-overlay Esc stack (`app/overlay/escStack.ts`), folded into the shared overlay primitive.
- [ ] **User column named `ctid` (type `tid`) misclassified as a row locator** (edit.rs:170) → require it to actually be a system column, not name+type match.
- [ ] **`openRecent` throws on a deleted profile (unhandled rejection)** (Dashboard.tsx:46) → guard / disable the row.
- [ ] **Real NULL, the literal text `'NULL'`, and `''` render identically** (Grid.tsx:607) → distinct dim NULL chip + an empty-string marker; defined once in the value-rendering pass (see Find/value contract). *Trust/correctness, not cosmetics.*
- [ ] **Editor remounts on theme change, dropping undo + cursor** (SqlEditor.tsx:191) → reconfigure the theme via a CodeMirror `Compartment` instead of remounting.
- [ ] **Dead code: `ProfileList.tsx` / `ProfileForm.tsx`** are stale divergent duplicates of the live rail (missing-glyph `blank()`) → delete; they confuse maintainers.
- [ ] **Stale schema snapshot survives disconnect/delete** → completion + tree serve a deleted profile's schema (schema.ts has no clear path) → clear `useSchema` on disconnect/profile-delete.
- [ ] **Failed queries are never recorded in history** (only the success path logs, results.ts:277) → add a catch-path write + an `error` flag ("where did my query go" after a typo).
- [ ] **History grows unbounded** → bloats `qwry.sqlite`, slows LIKE scans → cap last N per profile (auto-retention).

### Context-menu system (design once, apply everywhere)

**Prerequisite (build first, in v0.3):** a single owned **overlay primitive** — z-index layer + Escape + outside-click + viewport-clamp (flip near right/bottom edge) — shared by *every* popup (context menus, CellEditor, ThemePicker, DangerModal, FnSearch, sort popover, palette). The current per-popup hand-rolling is the root cause of the off-screen CellEditor, the no-Esc ThemePicker, and the clamp bugs. On top of it, a reusable **`ContextMenu` + `Submenu`** primitive (nested support — user explicitly wants `Copy ▸ formats`) that replaces all 3 current flat hand-rolled menus.

> **✅ Overlay primitive DONE (Step 1, 2026-06-26)** — `app/overlay/{escStack,Overlay}.tsx`: portal-to-body, topmost-only key stack (Esc + `onKey`), `Modal` + `AnchoredOverlay` (viewport-clamp + edge-flip via `offsetWidth`). 7 popups migrated. Step-2 followups still open: fold FnSearch + the 3 CSS-anchored dropdowns (DbSwitcher / inspector-copy / sort) + ExplainView into the stack; no re-clamp on resize; optionally auto-close transient menus when a modal opens.

Then enumerate every surface (UI is cheap; sequence any backend-gated item *after* its backend lands — see `get_ddl` in v0.4):

- [ ] **Cell** — Copy cell value · Copy ▸ (TSV/CSV/JSON/Markdown/INSERT-with-real-name) · Set NULL · Set DEFAULT · Filter by this value · Hide rows with this value · Open in inspector · Follow FK → referenced row *(FK-gated, v0.45)*.
- [ ] **Row** — Duplicate row (minus PK) · Copy row as ▸ (INSERT/JSON) · Delete row(s) · See details (inspector).
- [ ] **Column header** — Sort ▸ (Asc/Desc/Clear) · Hide column · Pin/Freeze *(v0.45)* · Copy column name · Copy as IN-list · Filter by… · distinct-value picker.
- [ ] **Gutter / row-number column** — Select row · Delete · Duplicate · Copy row.
- [ ] **Editor tab** — Close · Close Others · Close To Right · Close All · Rename · Duplicate · Pin · Copy SQL.
- [ ] **Sidebar schema tree (table/view/matview)** — Browse · Copy name / qualified name · Copy SELECT · Copy DDL *(get_ddl)* · Open browse-SQL in editor · Refresh · Truncate *(DangerModal)* · Drop *(DangerModal)* · Export *(v0.4)*. *Highest-traffic surface — has zero menu today.*
- [ ] **Sidebar structure rows (column / FK / index)** — Copy column name · Copy type · Copy DDL *(get_ddl)* · Navigate to FK target.
- [x] **Connection (rail + dashboard card)** — done (Step 4, shared `connectionMenu.ts`): Connect/Open/Disconnect/Reconnect · Edit · Duplicate · Delete (DangerModal). Still pending: Copy URI ▸ (own step) · Set color.
- [x] **Saved query** — done (Step 4): Open · Rename · Duplicate · Copy SQL · Delete (DangerModal).

### Find system (Cmd+F everywhere, consistent UX)

One mental model: ⌘F opens a find bar scoped to the **focused surface**; Esc closes; ⏎/⇧⏎ next/prev; match count shown.

- [x] **Editor find/replace** — done (Step 5, 2026-07-02): `search({top:true})` + `searchKeymap` + `openSearchPanel` via context menu; panel restyled to tokens. Bonus: ⌘D select-next-occurrence, ⌥G goto-line ride along.
- [x] **`highlightSelectionMatches`** — done (Step 5).
- [x] **Find-in-results** — done (Step 5): `stores/find.ts` + `grid/FindBar.tsx`, ⌘F routed by focused surface in App.tsx; ⏎/⇧⏎ + ⌘G/⇧⌘G step; current-hit scroll+amber; NULL never matches text; capped indicator "loaded X of Y rows"; 5k hit cap shown as "5,000+".
- [x] **Consistency pass** — done for the surfaces that exist: grid bar mirrors JsonTree chrome/keys; JsonTree's global ⌘F hijack fixed (scoped to inspector focus). Remaining text surfaces (raw-JSON CM field, DDL views when they land) extend later.

---

## Milestones

Five increments, each ~one session, themed. Ordered so the four small explicit asks (context menus, find, copy URI) land early, structural prerequisites (overlay primitive, `get_ddl` backend) land before what builds on them, and gold-plating sits last.

---

### v0.3 — Foundations: the menu/overlay/find substrate + the four small asks

One line: *Build the shared overlay + nested-menu primitive once, ship Cmd+F and Copy-URI, and stand up the rich context-menu epic on top of it.*

| Feature | What/why | Effort | Priority | User-asked? |
|---|---|---|---|---|
| Shared overlay primitive | One z-index/Esc/outside-click/viewport-clamp layer for ALL popups; fixes off-screen CellEditor + no-Esc ThemePicker + clamp bugs in one place | M | P0 | yes |
| Nested `ContextMenu`/`Submenu` primitive | Reusable, supports `Copy ▸ formats`; replaces 3 flat hand-rolled menus | M | P0 | yes |
| Cmd+F find/replace in SQL editor | `@codemirror/search` + searchKeymap + panel; single highest-value editor gap | S | P0 | yes |
| `highlightSelectionMatches` | Near-free once search lands | S | P1 | yes |
| Cmd+F find-in-results (loaded rows) | Match/highlight/jump over in-memory rows + "N of M loaded / capped" indicator | M | P0 | yes |
| Copy connection URI | URI builder + clipboard, redacted + with-password variants; surfaced via the new connection menu | S | P0 | yes |
| Paste connection string to create | Parse `postgres://…` into ConnectionEditor fields; natural pair to Copy URI | S | P1 | yes |
| Context menu: cell + row + gutter | Build on the new menu primitive; Copy/Filter/Set NULL/Set DEFAULT/Open-in-inspector/Duplicate/Delete (no backend needed) | S | P0 | yes |
| Context menu: connections | Connect/Disconnect/Reconnect/Edit/Duplicate/Copy URI/Set color/Delete (wire to existing actions + `clone_connection`) | S | P0 | yes |
| Context menu: editor tabs | Close Others/To Right/All, Rename, Duplicate, Pin, Copy SQL | S | P0 | yes |
| Context menu: saved queries | Open/Rename/Duplicate/Copy SQL/Delete via menu | S | P1 | yes |
| Bug: Copy-as-INSERT real table name | Thread table name into `formatCells` | S | P0 | yes |
| Bug: CellEditor off-screen misposition | Solved by the overlay clamp primitive | S | P0 | yes |
| Bug: ThemePicker/menus no Esc | Solved by the overlay Esc primitive | S | P0 | yes |

Gate: Right-click works on cell/row/gutter/tab/connection/saved-query with nested Copy submenus, clamps at every screen edge, closes on Esc + outside-click. ⌘F finds+replaces in the editor and finds+jumps in results (with a capped indicator). Copy-URI round-trips through Paste-to-create. Copy-as-INSERT emits the real table name. All on live staging.

---

### v0.35 — The Correctness Milestone (bug-polish + data-fidelity + value-rendering)

One line: *Burn down the correctness ledger — the silent-corruption and lost-work classes — and make every cell render the truth.*

> **2026-07-02:** The audit found the corruption/lost-work class is far bigger than the table below — **`docs/GAPS.md` §1 (correctness ledger) is now the authoritative work list for this milestone**; the table below is the pre-audit subset, kept for its ticks. Build order within the ledger: §1a (wrong writes) → §1b (lost work) → §1c (UI lies) → §1d (panics/hangs). The keystone is **statement-at-a-time execution in the driver** (`execute.rs` one `simple_query` per split statement) — it unlocks `matched != 1 → ROLLBACK`, honest multi-statement results, per-statement timing, tx-state tracking, and kills the earlier-statements-silently-rolled-back lie in one refactor. Highest-severity new entries: truncated-cell edit corruption, NULL→'' on blur, json/big-number re-serialization corruption, re-run/scroll wipes staged edits, ⌘Q loses work, cross-tab undo bleed, failed-load→persist wipes all tabs, AND/OR filter precedence.

| Feature | What/why | Effort | Priority | User-asked? |
|---|---|---|---|---|
| `structuredValue` text-vs-JSON gate | `[draft]` text no longer staged as JSON → no corruption | S | P0 | yes |
| No-op JSON/array edit clears dirty | Normalize-compare on stage; no phantom UPDATE | M | P1 | yes |
| Array detection after map loads | Re-derive editor mode when editability map resolves | S | P1 | yes |
| Inspector full-value fetch via backend + `.catch` | No more "Loading…" forever on dotted/quoted idents | S | P1 | yes |
| `matched != 1` → ROLLBACK | 0/2-row edits no longer commit as silent no-ops | S | P0 | yes |
| `.first()` on introspection statements | Kills index-OOB panic; no-unwrap rule | S | P0 | yes |
| NULL chip vs empty-marker vs text 'NULL' | Consolidated value-rendering pass: dim NULL chip, ∅ empty marker, right-align numerics, byte-count for bytea | M | P0 | yes |
| timestamptz display control | UTC ↔ local toggle (server-tz raw text only today) — folded into the same render pass | S | P1 | no |
| `ctid` misclassification fix | Require true system column, not name+type | S | P2 | yes |
| "Clear history (all)" relabel/global | Stop silently leaving other profiles' history | S | P1 | yes |
| `openRecent` deleted-profile guard | No unhandled rejection on the recent strip | S | P2 | yes |
| Record failed queries + history cap | Catch-path write w/ error flag; cap last N per profile | S | P1 | yes |
| Clear stale schema on disconnect/delete | Completion/tree stop serving a dead profile's schema | S | P1 | yes |
| Delete dead `ProfileList`/`ProfileForm` | Remove stale duplicates | S | P2 | yes |
| Editor theme via Compartment (no remount) | Auto dark-mode switch mid-edit keeps undo/cursor | M | P2 | yes |

Gate: A text cell `[draft]` commits verbatim. A whitespace-only JSON re-format does NOT produce an UPDATE. A 0-row edit reports failure (not committed). NULL/empty/'NULL' are visually distinct; numerics right-align; timestamptz toggles UTC/local. A typo'd query appears in history flagged red. Deleting a profile clears its schema + recent rows cleanly.

---

### v0.4 — Perf pass + the DB-client table-stakes (sort/filter/export + DDL backend)

One line: *Make it provably fast, and add the features every competitor has — sort, filter, export, DDL — with the `get_ddl` backend that unblocks the menu epic.*

| Feature | What/why | Effort | Priority | User-asked? |
|---|---|---|---|---|
| Memoize grid cell | Biggest perf win for least code | S | P0 | yes |
| Throttle/pointer-capture drag-select | Kills O(cells) drag jank | S | P0 | yes |
| Hoist per-keystroke `import()` | Keystroke→completion under budget | S | P0 | yes |
| Narrow store subscriptions | Inspector/TabBar/lint stop repainting on every batch/keystroke | M | P0 | yes |
| Debounce filter-value input | One query on Enter/blur, not per char | S | P0 | yes |
| Keyset pagination (browser scroll) | O(n) paging; fixes dup/missing rows | M | P0 | yes |
| Scope FUNCS introspection to user schemas | Faster connect/⌘R; less memory | M | P1 | yes |
| Batch applyTheme / setSelectionValue writes | One style write; one store write | S | P1 | yes |
| Tab-strip non-smooth scroll + reduced-motion + no spring replay | Honor never-animate-scroll | S | P1 | yes |
| `get_ddl` backend (`pg_get_*def`) | Unblocks Copy DDL / view source / structure-row copy / truncate-with-name | M | P0 | no |
| Export results/table to file (CSV/JSON/SQL) | Biggest non-menu gap; save dialog + writer / `COPY TO STDOUT` over the streaming engine | M | P0 | yes |
| Click-header-to-sort in query results | Client-side sort over loaded rows; every competitor has it | M | P0 | yes |
| Client-side filter of loaded rows | Per-column quick filter / "show only this" / "hide this" | M | P0 | yes |
| Column hide (not pin/reorder yet) | Cheap; pin/reorder deferred to v0.45 | S | P1 | no |
| Copy-with-headers / Copy cell / Copy column name / IN-list | TSV default emits no header today | S | P1 | yes |
| Load-more for arbitrary SELECTs >50k | "Fetch next" past the cap; pairs with find-in-results honesty | M | P1 | yes |
| Table size + row estimate (`reltuples`, `pg_total_relation_size`) | Zero-extra-round-trip introspect adds | S | P1 | no |
| Truncate / Drop table actions | Reuse DangerModal; via the sidebar menu (needs `get_ddl`-era backend) | S/M | P1 | no |
| **Run statement under cursor** *(promoted 2026-07-02 from v0.5 P2)* | ⌘↵ = statement at caret (visible range highlight), ⌘⇧↵ = run all; `statementRange()` exists. Top-3 daily action per every lens | M | P0 | no |
| **Selection stats in status bar** *(new from audit)* | n · sum · avg · min · max · nulls over the selected rect, type-aware; Excel-reflex TablePlus lacks | S | P0 | no |
| **App-shell re-render fix** *(new from audit — biggest shell perf item)* | App.tsx subscribes to activeTab object identity → whole tree reconciles per keystroke; inspector drag writes localStorage per mousemove. Scalar selectors + CSS-var drag | M | P0 | no |
| **ROW_CAP auto-cancel** *(new from audit)* | Past 50k the driver drains the ENTIRE result over the wire for minutes; auto-cancel on cap (last statement) / show "draining…" | M | P0 | no |
| Inspector/JsonTree perf pass *(new from audit)* | Memoize JSON parse; narrow subscriptions; virtualize/cap JsonTree children; debounce raw-mode validation | M | P1 | no |

Gate: **Measured, not vibed.** Cold start <500ms, keystroke→completion <16ms, 50k-row scroll + drag-select 60fps, browse page 50 doesn't re-stream from row 0 — all recorded before/after in the session note. Click a header to sort; quick-filter a column; export a 50k result to CSV; copy a table's DDL from the sidebar menu; Truncate via DangerModal. Sidebar/structure context-menu DDL items are now live (no longer greyed).

---

### v0.45 — Editing power + grid completeness — ✅ SHIPPED 2026-07-02 (one batch)

One line: *Turn the grid into a real spreadsheet — undo, fill, type-aware editors, FK navigation — and finish the polish gaps.*

> Done in a single session-9 batch (see ROADMAP.md session log): undo/redo, fill-down ⌘D, paste-into-selection ⌘V, full keyboard grammar incl. type-to-edit + Enter-advance, bool/enum editors (pg_enum introspected), multiline textarea editor, Set DEFAULT end-to-end, revert-in-selection, FK forward + reverse navigation with pre-filtered browse tabs, Space row peek, duplicate row, filter-op power + raw-WHERE, EditPreview Copy SQL. Deferred: column pin/freeze, date pickers, JSON element add/remove, searchable filter column picker.

| Feature | What/why | Effort | Priority | User-asked? |
|---|---|---|---|---|
| Undo/redo of staged edits | Per-tab undo/redo stack over immutable pending snapshots; ⌘Z does nothing today | M | P0 | yes |
| Fill-down / paste-into-selection / mass update | `setSelectionValue` machinery exists (NULL/EMPTY only); "type once, fill selection" | M | P0 | no |
| Single-cell revert + keyboard NULL on focused cell | `clearEdit` exists in store, unwired; key to revert one dirty cell / NULL focused cell | S | P1 | no |
| Foreign-key value picker + jump-to-row | `FkInfo` exists but FK cols get a plain textbox; clickable FK nav — a loved "magic" feature | M | P0 | no |
| Type-aware cell editors (bool toggle, enum, date, numeric) | Needs `pg_enum` introspection (ARCHITECTURE claims it, introspect.rs lacks it — that's the real cost); bool toggle is the satisfying small win | M | P1 | no |
| Duplicate row | Insert existing row minus PK | S | P1 | no |
| Column pin/freeze + reorder | Frozen-column virtualization; keep id/name visible on wide tables | L | P1 | no |
| Full grid keyboard nav | PageUp/Down, Home/End, ⌘Home/End, Tab/Shift-Tab next cell, Enter-advances-after-edit — the core "grid is the app" ideology, only Arrows exist today | M | P0 | no |
| Cross-pane focus model + focus ring | Defined editor↔grid↔sidebar↔inspector keyboard traversal; fixes the ⌘I-eaten-by-CM class | M | P0 | no |
| Cell quick-look (Space / hover-expand) | Space-to-peek popover + tooltip for truncated cells | S | P1 | no |
| Row-height / wrap density toggle | Compact/comfortable + wrap (26px hardcoded today) | M | P2 | no |
| JSON array element add/remove + key add/delete | Rounds out the first-class jsonb claim | M | P2 | no |
| Generate INSERT/UPDATE SQL from staged edits | Copy-SQL on the EditPreview modal (`build_edit_statements` already returns text) | S | P1 | no |

Gate: ⌘Z undoes a fill-down over a rect; type once → fills the selection; bool cells toggle; click an FK cell → jumps to the referenced row; PageDown/Home/End/Tab navigate the grid; focus visibly moves between panes by keyboard without surfaces fighting; Space peeks a truncated cell; pinned id/name stay frozen while scrolling 50 columns.

---

### v0.5 — App-shell finish + reliability + safe-mode (release)

One line: *Make it feel like a native Mac app and a safe one against prod-shaped DBs, then cut the release.*

| Feature | What/why | Effort | Priority | User-asked? |
|---|---|---|---|---|
| ✅ Native macOS menu bar (App/Edit/View/Window/Help) | Zero menus registered today; About/Preferences/Quit + shortcut discoverability; the biggest "unfinished as a Mac app" gap | M | P0 | no |
| ✅ Settings / Preferences (⌘,) — 2026-07-03 (font/wrap/timeout/mode/theme; row-limit + NULL display deferred) | Row limit, font, timeout, confirm toggles, NULL display, restore-tabs — nowhere to put prefs today | M | P0 | no |
| ✅ Connection-time session setup — done pre-v0.5 + timeout now user-tunable | `SET statement_timeout`, `idle_in_transaction_session_timeout`, `TimeZone`, `application_name='qwry'`, TCP keepalives — only app_name set today; underpins reliability + timezone | S | P0 | yes |
| ✅ Enforced read-only / prod safe-mode — 2026-07-03 (server-side via connect options + per-tab chip unlock; staging-tested) | `SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY` on connect; `is_prod` is cosmetic today — highest-value safety for this user's prod-shaped DBs | M | P0 | no |
| Graceful dropped-connection + force-kill-session | statement_timeout + keepalive + a "force disconnect this tab session" escape hatch so a dead tunnel can't freeze the app or hang ⌘. | S | P0 | yes |
| ✅ Test-connection button — 2026-07-03 (latency + version + TLS, unsaved form values) | Validate without committing + latency/version report | S | P0 | no |
| Server / connection info | `version()`/encoding/search_path/SSL/server_version_num; fixes hardcoded `type_oid=0` so grid has type info pre-editability | S | P1 | no |
| ✅ Window size/position persistence — 2026-07-03 (window-state plugin) | tauri window-state plugin (hardcoded 1240×800 today) | S | P1 | no |
| 🟡 Persist active tab + table-browser tabs across restart — active QUERY tab restored 2026-07-03; table tabs still session-only | Always reopens tab 0; table tabs vanish (re-open = reconnect + introspect + re-browse, touches conn lifecycle) | S/M | P1 | yes |
| ✅ Dedicated searchable History panel — 2026-07-03 (⌘Y, all-connection search, open-in-tab) | Timestamps, re-run, copy SQL, filter (palette-only today) | M | P1 | no |
| Saved-query search box | Flat list unusable past ~20; client-side search (folders deferred) | S | P1 | no |
| ✅ SQL format / beautify — 2026-07-03 (⌘⇧F, selection-aware, single undo step) | `sql-formatter` PG dialect + keybind + menu; universal feature | M | P1 | no |
| ✅ Multi-cursor + Tab-indents + line-wrap — 2026-07-03 (⌥-click carets; wrap = Settings toggle; rectangular deferred) | Cheap `@codemirror/view` extensions; `indentWithTab` installed but unwired | S | P1 | no |
| ✅ Run statement under cursor — 2026-07-03 (⌘↵ statement/selection, ⌘⇧↵ run-all; TS splitter; offset-aware squiggle). Gutter run deferred | M | P2 | no |
| ✅ Persist column widths per column-shape — 2026-07-03 (localStorage LRU, instant apply) | S | P2 | no |
| ✅ Surface server NOTICE / RAISE NOTICE — 2026-07-03 (poll_message drain → pg-notice event → per-tab notice strip) | S | P2 | no |
| Palette: switch/close/duplicate existing tabs + more commands | Palette can't focus an existing tab; add format/export/disconnect/switch-db | S | P2 | no |
| App icon, `tauri build` dmg, README/version bump | Cut the release artifact | S | P0 | no |

Gate: Native menu bar with working About/Preferences(⌘,)/Quit and discoverable shortcuts; ⌘, opens Settings and prefs persist; connecting to a prod-flagged DB enforces read-only (a write errors before hitting the server); a mid-query tunnel drop surfaces an error and a force-kill within ~seconds (no spinner-forever); Test-connection reports latency + version; relaunch restores the active tab + window geometry; ⌘⇧F formats SQL; History panel re-runs a past query. Final signed `.dmg` builds and launches. **Bump to v0.5 — releasable.**

---

## Beyond v0.5 — the surpass backlog (2026-07-02)

The compounding list after release — see **`docs/GAPS.md` §4** for the full distillation. Leapfrogs no client has (build these before parity-polish): run-CTE-as-standalone · reverse-FK "referenced by" with counts · inverse-SQL undo after commit · pre-execution impact estimate (EXPLAIN row count before UPDATE/DELETE) · latency breakdown in status bar · distinct-value histograms with % · plan history + regression diff · smart paste (column → IN-list/VALUES) · copy-for-Slack · row diff · buffer time-machine · qwry as MCP server · safe ctid editing of PK-less tables · schema-aware filter-bar completion. Plus the parity steals itemized per competitor in GAPS §4 (out-of-band cancel, tx-state chip, record view, FK picker, local history, schema-aware lint, per-table stats, macros with placeholders, cross-connection result/DDL diff…).

## Deferred past v0.5

- **Other DB engines (MySQL/SQLite/…)** — qwry is PG-only by charter; the `DbDriver` trait leaves the door open, but breadth dilutes the v0.5 polish push.
- **CSV/JSON import wizard (mapping + type validation)** — heavy (L); export alone is the table-stakes half. Import is gold-plating for this push.
- **Column reorder + frozen-column virtualization beyond v0.45's hide/sort** — pin fights the two-axis TanStack virtualizer; don't let it eat the perf budget. (Hide/sort/quick-filter ship; pin is the v0.45 P1 stretch.)
- **Visual table/column structure editor (ALTER from UI), Rename/Add-column/Add-index** — only Truncate/Drop make v0.5; full DDL editing is a separate epic.
- **ER diagrams / charts / dashboards / geo-map viewer** — not keyboard-first; large builds beyond the v0.5 cap.
- **SSL verify-ca/verify-full + client certs** — useful for RDS/Supabase, but this user reaches prod via SSH tunnel, so read-only safe-mode is the higher-value safety play.
- **Connection groups/folders + favorites ordering** — only pays off past ~20 connections; the user has a handful. Menu + duplicate + copy-URI cover the real asks.
- **Optimistic-conflict / stale-row detection on commit** — heavyweight (needs OLD-value capture); the existing `matched != 1` guard already prevents the worst silent overwrite.
- **Parameterized queries, code folding, notebook multi-result panes, snippet-management UI, in-editor history stepping** — nice IDE features, below the "minimum real DB client" line.
- **pg_dump backup/restore, schema diff/migration gen, role/permission management, server activity monitor (pg_stat_activity kill)** — PG-depth admin; large; post-v0.5. (Force-kill-own-session ships in v0.5 as the reliability subset.)
- **AI NL-to-SQL, plugin system, multi-window/split panes, full grid accessibility (screen-reader)** — out of scope / conflicts with the no-telemetry, keyboard-first, single-window v0.5 charter.
- **Connection import/export, export/import saved queries, open & save `.sql` files, LISTEN/NOTIFY** — defensible adds but past the cap; revisit after release.

## Decisions locked (2026-06-26)

1. **Read-only safe-mode** → **read-only by DEFAULT for `is_prod`-flagged connections**, one-keystroke toggle to enable writes per session. `SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY` on connect; a write errors before hitting the server. (v0.5 P0.)
2. **Copy-URI password** → **redacted by default** (password elided); "Copy with password" lives behind a submenu/confirm in the connection menu. (v0.3.)
3. **Find-in-results vs 50k cap** → **honest loaded-rows find**: ⌘F searches the in-memory rows with an "N of M loaded — find sees loaded rows only / capped" indicator. No server-side ILIKE fallback in this push (revisit post-v0.5 if it annoys). (v0.3.)
4. **Truncate/Drop** → **both in scope (v0.4)**, behind DangerModal + the prod read-only guard. (Needs the `get_ddl`-era backend.)
5. **Restore table-browser tabs on launch** → **DEFAULT: keep table tabs session-only**, persist only query tabs (protects the <500ms cold-start budget — reopening a table tab would force reconnect + introspect + re-browse at startup). *Flag to revisit if the user misses it.*
6. **Statement timeout default** → **DEFAULT: 30s applied at connect**, user-overridable per-connection in Settings (v0.5). Backbone of "never freezes on a dead tunnel". *Confirm the number when Settings lands.*
