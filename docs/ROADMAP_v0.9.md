# ROADMAP v0.7 → v0.9 — "the launch push"

> Started 2026-07-18. Post-v0.6.0 (PR #4 merged). Mission unchanged: surpass
> TablePlus/Postico/Beekeeper/DataGrip — no finish line. Two invariants: never slow
> at any scale; never lies about or corrupts data.
>
> **Process per wave:** branch `v0.n.x-{build-name}` off main → implement in bundles
> (parallel agents, file-disjoint) → gates (tsc, cargo check/clippy, unit tests,
> staging suite for driver changes) → adversarial audit round → iterative commits →
> PR → merge → next wave. Items cite GAPS.md; **verify each against current code
> before implementing — some were fixed in v0.6 without a GAPS tick.**

## Quality gates (every wave, non-negotiable)

1. `bunx tsc --noEmit` clean.
2. `cd src-tauri && cargo check` + `cargo clippy` clean; `cargo test` (unit).
3. Driver/edit-path changes: staging suite green —
   `QWRY_TEST_HOST=$STAGING_DB_HOST … cargo test --test staging_smoke -- --ignored`.
   NEVER against prod.
   **Two staging DBs**: `crawler_data_production` (112GB, real data — read-only /
   big-table perf tests, pre-existing scratch tests) and `squad` (small, CREATE ok —
   ALL new DDL-creating fixtures: schemas/types/matviews/triggers, write-heavy
   round-trips, synthetic keyset benchmarks; env `QWRY_TEST_DB2=squad`). squad rule:
   fixtures live ONLY in a `qwry_test` schema, never public (it's a real staging app
   db) — drop at teardown. squad also serves as the second connection profile for
   multi-connection UI testing (workspaces, pins, db switcher).
4. Adversarial code-review agents over the wave diff; confirmed findings fixed
   before PR.
5. Docs updated in the same wave: this file ticked, ROADMAP.md session note,
   DECISIONS.md for any ADR, ARCHITECTURE.md if design shifted.

---

## v0.7.0-bedrock — correctness ledger burn + driver spine

### Bundle A1 — edit path correctness (edit.rs + its frontend consumers)
- [x] Transaction-safe edits: apply_edits/delete_rows on a session already inside the
      user's transaction must NOT send BEGIN…COMMIT (silently commits their open
      work — GAPS 1a, edit.rs:394). Use SAVEPOINT/RELEASE inside an open tx; never
      COMMIT the user's tx. Requires tx-state knowledge (Bundle A2 provides).
- [x] ctid-located edits: guard row movement (UPDATE/VACUUM FULL moves rows) — add
      old-value WHERE predicates alongside ctid (GAPS 1a, edit.rs:169).
- [x] Edit casts: quote + schema-qualify type names (`::mystatus` breaks on
      mixed-case/schema-qualified/custom types — GAPS 1a, edit.rs:335,350,481).
- [x] GENERATED ALWAYS / identity-ALWAYS columns: read `attgenerated`/`attidentity`,
      mark read-only with reason (GAPS 1a, edit.rs:187-245).
- [x] Dotted schema/table names: carry schema+name as separate fields through
      EditabilityMap end-to-end; kill the `split_once('.')` reassembly (GAPS 1d,
      edit.rs:88-93,125). Touches types.ts + edits.ts/editHints.ts consumers.
- [x] matview/complex-view read-only reason: stop suggesting ctid (dead end — GAPS
      1c, edit.rs:213); say what's actually possible.
- [x] `fetch_cell` backend command replacing the hand-rolled truncated-cell fetch SQL
      (GAPS 1a residue: quoted/aliased idents, no `.catch`).

### Bundle A2 — driver spine (session lifecycle)
- [x] Transaction-state tracking: authoritative in the driver (statement-head lexing
      via the splitter + error outcome → idle / in-tx / failed-tx), surfaced as an
      event. Feed the existing tx chip truth instead of the frontend sniff. Document
      limits (SQL procedures with COMMIT inside).
- [x] Out-of-band cancel escalation: CancelToken → `pg_cancel_backend(pid)` via a
      fresh short-lived connection → offer `pg_terminate_backend` (GAPS §3 driver;
      TablePlus's decade-old weakness). Cancel must never share the busy session's
      fate.
- [x] sslmode=prefer silent plaintext downgrade: surface outcome (lock indicator /
      downgrade warning — GAPS 1c, mod.rs:100-119).
- [x] Keychain failure ≠ empty password: stop `unwrap_or_default()` masking (GAPS 1c,
      commands.rs:94); report "keychain unavailable" distinctly.
- [x] session-closed event carries a reason (GAPS §3 driver).

### Bundle B — persistence spine (appdb)
- [x] `PRAGMA user_version` numbered migrations; kill the `let _ = ALTER` swallow-all
      pattern (GAPS 1d, appdb.rs:80).
- [x] One corrupt profile row must not hide ALL connections: skip-and-log per row
      (GAPS 1d, appdb.rs:97 + App.tsx:91 no catch).
- [x] History: failed/cancelled queries enter history with an error flag (GAPS 1c,
      results.ts:277); timestamps rendered; cap + prune unbounded growth; cap
      per-row SQL size (8MB INSERT stored verbatim today).
- [x] Single-instance plugin (two instances clobber tabs — GAPS 1b).

### Bundle C — frontend correctness sweep
- [x] connect() re-entrancy: double-click spawns duplicate primaries, loser leaks;
      same class ensureTabSession race (GAPS 1d, connections.ts:111,157).
- [x] Session hygiene: markDisconnected paths call ipc.disconnect for dropped
      sessions; deleting a connected profile disconnects primary + tunnel (GAPS 1c,
      connections.ts:196,94).
- [x] Disconnect/Reconnect/recent-click with open transactions: scan txTabs, confirm
      first (GAPS 1b, connectionMenu.ts:23, Dashboard.tsx:49).
- [x] Save&Connect failure strands user on blank form / loses profile from view
      (GAPS 1c, connections.ts:89 + Home.tsx:12).
- [x] Danger no-WHERE scan: port to the real splitter in statements.ts (naive `;`
      split false-positives on dollar-quotes, misses CTE-wrapped DML — GAPS 1c,
      danger.ts:26).
- [x] Verify (may be fixed in v0.6): stale selection after re-run/filter; right-click
      retargets selection (GAPS 1c, Grid.tsx:161,251,322,363,429).
- [x] Overlay stack: global shortcuts must respect modal depth (⌘W behind CloseGuard
      silently drops pending close — App.tsx:104); palette z vs DangerModal; Esc
      during IME composition (escStack.ts:18). (GAPS 1d.)
- [x] Corrupt stored theme bricks UI at startup: validate on rehydrate (GAPS 1d,
      theme.ts + settings.ts:101).
- [x] Draft row: DEFAULT / NULL / `''` all expressible via touched-state (GAPS 1a,
      browser.ts:244).
- [x] Editability 'unavailable' → show the reason somewhere; double-click shouldn't
      silently no-op (GAPS 1c, Grid.tsx:590).

### Gate
- [x] All quality gates green (tsc ✓ vite ✓ clippy 0 ✓ unit 32/32 ✓ staging 16/16 ✓);
      staging suite 9→16: savepoint-in-user-tx (+aborted-tx refusal +user-savepoint
      survival), ctid guards, generated/identity, dotted names, oob cancel+terminate,
      tx-state events (+filler forms +failed-COMMIT), stale-hint rename guard.
- [x] Audit round: 5 adversarial reviewers → 31 confirmed findings, ALL fixed
      (2 pre-existing S1 corruption: plan_edits sig collision, stale-snapshot
      wrong-column write; 6 S2 incl. tx filler-token mis-fold + submenu z + connect
      epochs + tabs skip/replace-all data loss). Deferrals ledgered in GAPS.

---

## v0.7.1-tempo — perf register burn

- [x] Editor O(doc) per keystroke ×3: updateListener toString() + subscribe compares
      + whole-statement re-tokenize (GAPS §2.3, SqlEditor.tsx:133,152, context.ts:74).
- [x] Keyset pagination for browse: infinite scroll re-runs from row 0 with unbounded
      LIMIT growth (O(n²)) and dups/drops rows without a unique sort (GAPS §2.6 +
      1c, browser.ts:196-204). PK (or ctid) tiebreaker, true keyset WHERE.
- [x] Inspector: memoize JSON parse/pretty of the full cell; stop re-parsing per
      streamed batch; raw-mode parse per keystroke (GAPS §2.7, Inspector.tsx:49,146,287).
- [x] JsonTree: child cap + virtualization for 50k-element arrays; registerRef dep
      array; search debounce (GAPS §2.8, JsonTree.tsx:317,333,90).
- [x] SchemaTree: virtualize; kill per-row SVG×2 + tooltip string churn on filter
      keystroke (GAPS §2.9, SchemaTree.tsx:93).
- [x] FUNCS introspection: stop pulling ~3k pg_catalog fns per connect/⌘R; cache;
      fix DDL-sniff regex false positives (GAPS §2.13, schema.ts:80).
- [x] ⌘A+⌘C on 50k rows: chunked/async TSV build, no >100MB sync string
      (GAPS §2.14, Grid.tsx:245).
- [x] noAutocorrect MutationObserver: stop selector work per virtualized row mount
      during scroll (GAPS §2.15, noAutocorrect.ts:29).
- [x] history LIKE full-scan per palette keystroke (GAPS §2.16, appdb.rs:192).
- [x] Smaller sweep (GAPS §2.17): setSelectionValue O(N²), column-resize measure per
      mousemove, springs replay + reduced-motion.

### Gate
- [x] Quality gates green (tsc ✓ vite ✓ clippy 0 ✓ unit 34/34 ✓ staging 17/17 ✓).
      Measured: keyset page-5000 on 8.1M rows >300s (OFFSET timeout) → ~2ms, page-30
      13.1→0.57ms; editor worst-case keystroke 2.95MB ~24→4.2ms (stmtScope 20.2→0.42);
      FUNCS introspect 25.8→2.0ms + 338KB less transfer; history search constant-cost.
      Proofs: keyset 8/8 (dups+double-NULL+mixed-dir+ctid via app's real SQL gen);
      editor 6,600-edit differential + 2,664-position context equivalence.
- [x] Audit round: 4 adversarial reviewers → 20 confirmed findings, ALL fixed
      (S1: inheritance-parent ctid collision — TimescaleDB class; S2: key drift
      after snapshot refresh, stale-key seek after committed edit, ⌘F reveal
      mounting O(hitIndex) nodes, silent copy abandon, page-1 ORDER BY ctid
      O(n)/page → 1M-row size gate). Editor spans re-fuzzed 32,652 tx after the
      resume rework (mutation-tested harness); keyset proof harness now PERMANENT
      at scripts/keyset-proof.ts (10 cases, 109 assertions). Final gates: tsc ✓
      vite ✓ clippy 0 ✓ unit 34/34 ✓ staging 18/18 ✓.

---

## v0.8.0-spelunk — data navigation power

- [x] Record view: transposed single-row inspector w/ prev/next (Postico's
      most-loved; GAPS §3 grid).
- [x] Row diff: select 2 rows → highlight differing columns (leapfrog #10).
- [x] FK-cell picker: searchable referenced-row picker when editing an FK column
      (Postico parity; GAPS §4).
- [x] Distinct-value histogram in header menu ("paid 78% · pending 12%") (leapfrog #6).
- [x] Multi-column sort: shift-click tiebreakers + NULLS control (GAPS §3 browser).
- [x] Filter power: NOT IN / NOT LIKE / BETWEEN / regex / jsonb `@>` / IS TRUE;
      type-aware value editors (bool/enum/date); raw-WHERE escape hatch; "show the
      SQL I built" (GAPS §3 browser).
- [x] Structure tab depth: constraints, indexes, triggers, comments, sizes, per-table
      stats (dead tuples, last vacuum, seq vs idx scans) (GAPS §3 + pgAdmin steal).
- [x] Jump-to-row + exact-count-on-demand footer (estimate → click → real count).
- [x] Sidebar depth: functions/sequences/enums/extensions nodes; matview/foreign/
      partitioned glyphs; partitions nested under parent; comments in tooltips;
      pinned tables (GAPS §3 sidebar).

### Gate
- [x] Quality gates green: tsc ✓ vite ✓ clippy 0 ✓ unit 34/34 ✓ staging 20/20 ✓
      (+staging_introspect_v2, +staging_table_stats — matview-safe stats proven);
      keyset-proof.ts 20 cases / 220 assertions (NULLS-override ladders, mixed-dir
      chains, raw-WHERE composition, jump re-anchor gapless).
- [x] Audit round: 4 adversarial reviewers → ~25 confirmed findings, ALL fixed.
      Ladder math independently re-derived: all 8 (dir,placement,seek) combos MATCH,
      multi-key + jump re-anchor live-proven gapless — no S1/S2 in keyset. Fixes:
      anchor truncation (O(n²) fallback shape), NULLS gates on NOT NULL (planner
      cliff), RecordView hidden-column leak/dup, unique-index drop advice, live
      Columns cell, session-scope for histogram/picker, newline-safe raw-WHERE
      composition. Harness 20→28 cases w/ explicit no-fallback assertions.
      Final: tsc ✓ vite ✓ clippy 0 ✓ unit 34/34 ✓ staging 20/20 ✓ harness 28/185 ✓.

---

## v0.8.1-timeline — never lose work, applied to data

- [x] Inverse-SQL undo after commit: capture OLD values in the commit tx, persist
      revert script, toast offers Undo (leapfrog #3 — no client has it). Undo
      re-enters the verified-batch pipeline (a stale undo rolls back honestly).
- [x] Buffer time-machine: step the editor back through executed versions of THIS
      tab (leapfrog #11).
- [x] History panel upgrade: dedupe/grouping, timestamps visible, per-connection
      filter chips (GAPS §3 persistence).
- [x] .sql file open/save/drop onto window (GAPS §3 editor).
- [x] In-editor history stepping ⌥↑/⌥↓ (psql muscle memory) (GAPS §3 editor).
- [x] CSV/TSV import wizard: file → column mapping → typed batches → dry-run
      validation → commit with per-row error report. Never silently drops rows.

### Gate
- [x] Quality gates green: tsc ✓ vite ✓ clippy 0 ✓ unit 50/50 ✓ staging 22/22 smoke
      + 5/5 csv_import ✓ (inverse-undo round-trips, savepoint no-log, re-insert +
      rename gates, prod-locked undo, TOCTOU refusal, exact bad-row naming — all live).
- [x] Audit round: 4 adversarial reviewers → ~30 confirmed findings, ALL fixed
      (S1s: insert-revert had no existence/identity pin — user-tx rollback + undo
      duplicated rows; savepoint-mode commits logged as durable; ⌥-walk/restore lost
      never-run drafts across quit; import indeterminate-COMMIT claimed rollback;
      import session fallback could target the rail-active profile). Capture grammar
      itself survived independent EPQ analysis — no wrong-write constructible.

---

## v0.9.0-flightcheck — launch polish

- [x] Focus discipline: restore focus on every overlay close; modal focus trap +
      role=dialog (GAPS §3 shell).
- [x] CloseGuard/DangerModal keyboard conventions: ⌘⌫ destructive confirm, plain
      Enter = safe action (Mac convention — GAPS §3 shell).
- [x] Empty states with CTAs (no dead ends; ⌘K hints) (GAPS §3 shell).
- [x] UI zoom ⌘+/⌘−/⌘0 (GAPS §3 shell).
- [x] Window title shows connection · db (GAPS §3 shell).
- [x] Reduced-motion + springs replay audit (GAPS §2.17 residue): audit found
      NO data-driven remount replays (Grid's per tab:stmt key carries no
      entrance spring; chips/sidebar rows/dash cards are static); fixed the two
      presets-bypass stragglers — rail avatars' hand-rolled spring → railItemIn,
      ZenScreen quote tween + wave canvas now honor prefers-reduced-motion.
- [x] Final design loop: one pass over every surface against tokens.css; kill the
      last raw sizes.
- [x] README + screenshots + first-run experience.
- [x] Version bump + dmg build + full staging regression + final audit sweep.

### Gate
- [~] Perf budgets: keystroke path measured green (worst-case 4.2ms on 2.95MB —
      tempo benches); binary 18MB / dmg 7.8MB; cold start + 60fps need in-app
      eyes (autonomous window probe blocked by Accessibility permission) — on
      the user punch list. Full staging regression at 0.9.0: 22+5 ✓ + keyset
      harness 28/185 ✓. qwry_0.9.0_aarch64.dmg built.
- [x] Final adversarial audit: 1 S2 fixed (layered inline-editor Tab escape),
      cascade-focus + zoom-double-fire ledgered, README screenshot refs
      commented until captured, internal db name purged from tests. Verdict:
      "nothing in the diff threatens either invariant." Handed to user.

---

*Session log lives in ROADMAP.md as always. Tick items here; append dated wave
notes below as each wave actually ships.*

## Wave notes

(none yet)
