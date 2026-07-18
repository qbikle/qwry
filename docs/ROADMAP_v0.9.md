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
4. Adversarial code-review agents over the wave diff; confirmed findings fixed
   before PR.
5. Docs updated in the same wave: this file ticked, ROADMAP.md session note,
   DECISIONS.md for any ADR, ARCHITECTURE.md if design shifted.

---

## v0.7.0-bedrock — correctness ledger burn + driver spine

### Bundle A1 — edit path correctness (edit.rs + its frontend consumers)
- [ ] Transaction-safe edits: apply_edits/delete_rows on a session already inside the
      user's transaction must NOT send BEGIN…COMMIT (silently commits their open
      work — GAPS 1a, edit.rs:394). Use SAVEPOINT/RELEASE inside an open tx; never
      COMMIT the user's tx. Requires tx-state knowledge (Bundle A2 provides).
- [ ] ctid-located edits: guard row movement (UPDATE/VACUUM FULL moves rows) — add
      old-value WHERE predicates alongside ctid (GAPS 1a, edit.rs:169).
- [ ] Edit casts: quote + schema-qualify type names (`::mystatus` breaks on
      mixed-case/schema-qualified/custom types — GAPS 1a, edit.rs:335,350,481).
- [ ] GENERATED ALWAYS / identity-ALWAYS columns: read `attgenerated`/`attidentity`,
      mark read-only with reason (GAPS 1a, edit.rs:187-245).
- [ ] Dotted schema/table names: carry schema+name as separate fields through
      EditabilityMap end-to-end; kill the `split_once('.')` reassembly (GAPS 1d,
      edit.rs:88-93,125). Touches types.ts + edits.ts/editHints.ts consumers.
- [ ] matview/complex-view read-only reason: stop suggesting ctid (dead end — GAPS
      1c, edit.rs:213); say what's actually possible.
- [ ] `fetch_cell` backend command replacing the hand-rolled truncated-cell fetch SQL
      (GAPS 1a residue: quoted/aliased idents, no `.catch`).

### Bundle A2 — driver spine (session lifecycle)
- [ ] Transaction-state tracking: authoritative in the driver (statement-head lexing
      via the splitter + error outcome → idle / in-tx / failed-tx), surfaced as an
      event. Feed the existing tx chip truth instead of the frontend sniff. Document
      limits (SQL procedures with COMMIT inside).
- [ ] Out-of-band cancel escalation: CancelToken → `pg_cancel_backend(pid)` via a
      fresh short-lived connection → offer `pg_terminate_backend` (GAPS §3 driver;
      TablePlus's decade-old weakness). Cancel must never share the busy session's
      fate.
- [ ] sslmode=prefer silent plaintext downgrade: surface outcome (lock indicator /
      downgrade warning — GAPS 1c, mod.rs:100-119).
- [ ] Keychain failure ≠ empty password: stop `unwrap_or_default()` masking (GAPS 1c,
      commands.rs:94); report "keychain unavailable" distinctly.
- [ ] session-closed event carries a reason (GAPS §3 driver).

### Bundle B — persistence spine (appdb)
- [ ] `PRAGMA user_version` numbered migrations; kill the `let _ = ALTER` swallow-all
      pattern (GAPS 1d, appdb.rs:80).
- [ ] One corrupt profile row must not hide ALL connections: skip-and-log per row
      (GAPS 1d, appdb.rs:97 + App.tsx:91 no catch).
- [ ] History: failed/cancelled queries enter history with an error flag (GAPS 1c,
      results.ts:277); timestamps rendered; cap + prune unbounded growth; cap
      per-row SQL size (8MB INSERT stored verbatim today).
- [ ] Single-instance plugin (two instances clobber tabs — GAPS 1b).

### Bundle C — frontend correctness sweep
- [ ] connect() re-entrancy: double-click spawns duplicate primaries, loser leaks;
      same class ensureTabSession race (GAPS 1d, connections.ts:111,157).
- [ ] Session hygiene: markDisconnected paths call ipc.disconnect for dropped
      sessions; deleting a connected profile disconnects primary + tunnel (GAPS 1c,
      connections.ts:196,94).
- [ ] Disconnect/Reconnect/recent-click with open transactions: scan txTabs, confirm
      first (GAPS 1b, connectionMenu.ts:23, Dashboard.tsx:49).
- [ ] Save&Connect failure strands user on blank form / loses profile from view
      (GAPS 1c, connections.ts:89 + Home.tsx:12).
- [ ] Danger no-WHERE scan: port to the real splitter in statements.ts (naive `;`
      split false-positives on dollar-quotes, misses CTE-wrapped DML — GAPS 1c,
      danger.ts:26).
- [ ] Verify (may be fixed in v0.6): stale selection after re-run/filter; right-click
      retargets selection (GAPS 1c, Grid.tsx:161,251,322,363,429).
- [ ] Overlay stack: global shortcuts must respect modal depth (⌘W behind CloseGuard
      silently drops pending close — App.tsx:104); palette z vs DangerModal; Esc
      during IME composition (escStack.ts:18). (GAPS 1d.)
- [ ] Corrupt stored theme bricks UI at startup: validate on rehydrate (GAPS 1d,
      theme.ts + settings.ts:101).
- [ ] Draft row: DEFAULT / NULL / `''` all expressible via touched-state (GAPS 1a,
      browser.ts:244).
- [ ] Editability 'unavailable' → show the reason somewhere; double-click shouldn't
      silently no-op (GAPS 1c, Grid.tsx:590).

### Gate
- [ ] All quality gates green; staging suite extended to cover: SAVEPOINT inside user
      tx, ctid guarded edit/delete, tx-state events, oob cancel.
- [ ] Adversarial audit round over the full wave diff; confirmed findings fixed.

---

## v0.7.1-tempo — perf register burn

- [ ] Editor O(doc) per keystroke ×3: updateListener toString() + subscribe compares
      + whole-statement re-tokenize (GAPS §2.3, SqlEditor.tsx:133,152, context.ts:74).
- [ ] Keyset pagination for browse: infinite scroll re-runs from row 0 with unbounded
      LIMIT growth (O(n²)) and dups/drops rows without a unique sort (GAPS §2.6 +
      1c, browser.ts:196-204). PK (or ctid) tiebreaker, true keyset WHERE.
- [ ] Inspector: memoize JSON parse/pretty of the full cell; stop re-parsing per
      streamed batch; raw-mode parse per keystroke (GAPS §2.7, Inspector.tsx:49,146,287).
- [ ] JsonTree: child cap + virtualization for 50k-element arrays; registerRef dep
      array; search debounce (GAPS §2.8, JsonTree.tsx:317,333,90).
- [ ] SchemaTree: virtualize; kill per-row SVG×2 + tooltip string churn on filter
      keystroke (GAPS §2.9, SchemaTree.tsx:93).
- [ ] FUNCS introspection: stop pulling ~3k pg_catalog fns per connect/⌘R; cache;
      fix DDL-sniff regex false positives (GAPS §2.13, schema.ts:80).
- [ ] ⌘A+⌘C on 50k rows: chunked/async TSV build, no >100MB sync string
      (GAPS §2.14, Grid.tsx:245).
- [ ] noAutocorrect MutationObserver: stop selector work per virtualized row mount
      during scroll (GAPS §2.15, noAutocorrect.ts:29).
- [ ] history LIKE full-scan per palette keystroke (GAPS §2.16, appdb.rs:192).
- [ ] Smaller sweep (GAPS §2.17): setSelectionValue O(N²), column-resize measure per
      mousemove, springs replay + reduced-motion.

### Gate
- [ ] Quality gates green; measured before/after numbers for keyset pagination and
      editor keystroke cost recorded in the wave note.
- [ ] Adversarial audit round; confirmed findings fixed.

---

## v0.8.0-spelunk — data navigation power

- [ ] Record view: transposed single-row inspector w/ prev/next (Postico's
      most-loved; GAPS §3 grid).
- [ ] Row diff: select 2 rows → highlight differing columns (leapfrog #10).
- [ ] FK-cell picker: searchable referenced-row picker when editing an FK column
      (Postico parity; GAPS §4).
- [ ] Distinct-value histogram in header menu ("paid 78% · pending 12%") (leapfrog #6).
- [ ] Multi-column sort: shift-click tiebreakers + NULLS control (GAPS §3 browser).
- [ ] Filter power: NOT IN / NOT LIKE / BETWEEN / regex / jsonb `@>` / IS TRUE;
      type-aware value editors (bool/enum/date); raw-WHERE escape hatch; "show the
      SQL I built" (GAPS §3 browser).
- [ ] Structure tab depth: constraints, indexes, triggers, comments, sizes, per-table
      stats (dead tuples, last vacuum, seq vs idx scans) (GAPS §3 + pgAdmin steal).
- [ ] Jump-to-row + exact-count-on-demand footer (estimate → click → real count).
- [ ] Sidebar depth: functions/sequences/enums/extensions nodes; matview/foreign/
      partitioned glyphs; partitions nested under parent; comments in tooltips;
      pinned tables (GAPS §3 sidebar).

### Gate
- [ ] Quality gates green; staging verification for every server-touching feature.
- [ ] Adversarial audit round; confirmed findings fixed.

---

## v0.8.1-timeline — never lose work, applied to data

- [ ] Inverse-SQL undo after commit: capture OLD values in the commit tx, persist
      revert script, toast offers Undo (leapfrog #3 — no client has it). Undo
      re-enters the verified-batch pipeline (a stale undo rolls back honestly).
- [ ] Buffer time-machine: step the editor back through executed versions of THIS
      tab (leapfrog #11).
- [ ] History panel upgrade: dedupe/grouping, timestamps visible, per-connection
      filter chips (GAPS §3 persistence).
- [ ] .sql file open/save/drop onto window (GAPS §3 editor).
- [ ] In-editor history stepping ⌥↑/⌥↓ (psql muscle memory) (GAPS §3 editor).
- [ ] CSV/TSV import wizard: file → column mapping → typed batches → dry-run
      validation → commit with per-row error report. Never silently drops rows.

### Gate
- [ ] Quality gates green; staging tests for inverse-undo round-trip and CSV import
      (including bad-row report).
- [ ] Adversarial audit round; confirmed findings fixed.

---

## v0.9.0-flightcheck — launch polish

- [ ] Focus discipline: restore focus on every overlay close; modal focus trap +
      role=dialog (GAPS §3 shell).
- [ ] CloseGuard/DangerModal keyboard conventions: ⌘⌫ destructive confirm, plain
      Enter = safe action (Mac convention — GAPS §3 shell).
- [ ] Empty states with CTAs (no dead ends; ⌘K hints) (GAPS §3 shell).
- [ ] UI zoom ⌘+/⌘−/⌘0 (GAPS §3 shell).
- [ ] Window title shows connection · db (GAPS §3 shell).
- [ ] Reduced-motion + springs replay audit (GAPS §2.17 residue).
- [ ] Final design loop: one pass over every surface against tokens.css; kill the
      last raw sizes.
- [ ] README + screenshots + first-run experience.
- [ ] Version bump + dmg build + full staging regression + final audit sweep.

### Gate
- [ ] Perf budgets measured and green: cold start <500ms, keystroke→completion
      <16ms, 50k-row grid scroll 60fps.
- [ ] Final adversarial audit round; then hand to user for the release punch list.

---

*Session log lives in ROADMAP.md as always. Tick items here; append dated wave
notes below as each wave actually ships.*

## Wave notes

(none yet)
