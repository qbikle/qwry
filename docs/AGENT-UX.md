# AGENT-UX.md: what the user sees of the agent

Companion to AGENT-SPEC.md. DESIGN.md, WRITING.md, and LESSONS.md bind every
surface here; this file only adds the agent-specific rules and names the
species each element belongs to. When this file and a law file disagree, the
law file wins and this file gets fixed.

## 1. Where it lives

The **Ask panel** is a card in the shell, sibling of the inspector: it enters
by animating its width so the main card reflows in lockstep (the inspector
precedent), never by overlaying. Opened by a titlebar control, the palette
(`Ask`), and a chord (proposal: ⌘J; the keyboard map is the authority). It
belongs to the active connection: switching connections switches threads.
The components live in `src/ask/` (AskPanel and its parts, `ask.css`; UI
state in `src/stores/ask.ts`), and the width budget is law: opening Ask when
the main card would drop under 480px collapses the inspector, and opening the
inspector under the same budget closes Ask.

Empty state (no model configured): a setup card with the provider picker,
key field (saved to Keychain), and one sentence of what Ask does. Empty state
(model configured, no thread): the input plus three starter suggestions drawn
from the schema ("How many rows in each table?" is never one of them; use the
connection's real nouns).

## 2. Anatomy of an answer

Top to bottom, every answer block has the same skeleton; parts that do not
apply are omitted, never left as dead space (DESIGN rule 2 scope note):

1. **Question echo**: the user's text, tier-1 contrast.
2. **Thinking strip**: a FIXED-height row (rule 2, stable chrome). Tool calls
   appear as chips as they run: `describe order_v2` · `peek payment_status` ·
   `run`. This is the trace made visible; it is the only "loading" UI.
3. **Result**: the existing results grid (one grid species app-wide). Row
   count and timing in the status register.
4. **SQL**: collapsed by default; expand shows the query in the editor
   register with `Copy SQL` and `Open in Tab`.
5. **Assumption chips** (§3).
6. **Sanity line** (§4).
7. **Follow-ups**: three chips (§6).
8. **Footer**: `4 turns · 12.3s · haiku` in the status register; `How did it
   get this?` link opens the trace (§5).

Streaming text renders as it arrives with no per-character animation
(ARCHITECTURE ideology 6: never animate typing). Layout does not jump when
a section arrives: sections reserve nothing until they exist, and appear with
`--dur-slow` opacity, not height animation.

## 3. Assumption chips

Species: Chip / pill toggle (DESIGN rule 1). One chip per interpretation the
agent made that the question did not state: `Excluding Deleted Users`,
`Paid = payment_status 'paid'`, `2025 by created_at`. Title Case (control
register). Active = the assumption is in effect. Toggling re-runs the query
with the assumption flipped; the thinking strip shows only the `run` chip.
Chips are the product form of a measured fact: agents add filters unasked,
and a hidden filter is a wrong answer that looks right.

## 4. Sanity line

Status register, one line, `·`-separated fragments:
`checked payment_status values · dates 2022-01 → 2026-07 · 42,524 rows dated
before signup`. A fragment that describes a warning carries the warning
glyph and tier-1 contrast; the rest sits at tier 2. Clicking a fragment
shows the probe that produced it. Nothing here is decorative: if no probe
ran, the line is absent.

## 5. Trace

"How did it get this?" opens a drawer listing every step the loop took, in
the order the spec defines them: context (candidate tables, expandable to the
exact text sent), each model turn (raw text), each tool call with its result,
the verdict. Timing per step in the status register. This is a teaching
surface (WRITING: keycaps allowed) and a trust surface: everything the model
received is shown, nothing is summarised away.

## 6. Follow-ups and the suggestion → chat transition

Three follow-up chips under each answer, phrased as questions the user could
have typed. Clicking one morphs the chip into the next question echo (shared
layout spring, `springs.ts` preset) and starts the loop; the input stays
free. The same motion carries the starter suggestions of the empty state.
Chips never repeat a question already asked in the thread.

## 7. Failure

- SQL fails after the repair loop: show the error (error register), the last
  SQL in an editable field, and `Fix It` (runs the repair loop once more with
  any edits) beside `Open in Tab`. Never a dead end (LESSONS 9).
- Turn cap reached: state it plainly (`stopped after 12 turns`), offer `Fix
  It` and `Ask Differently`.
- Provider error (auth, rate limit, network): one sentence, what to do next
  (`check the key in Settings › Models`), and a retry. Rate limits show the
  wait when the provider gives one.
- Cancelled (⌘.): `cancelled` in the status register; partial text stays.

Errors explain and propose; they do not apologise (WRITING errors register).

## 8. Provider and model picker

In the Ask header: model name + tier badge (`small` · `mid` · `large`,
WRITING data-state register). Tier explains itself on hover and by keyboard
(the pill on focus, a popover row when the arrow keys make it hot): what this
tier can and cannot do, in one sentence each (from AGENT-SPEC §3). Per-connection
default is remembered. Keys are managed in Settings › Models; the picker
never shows a key.

## 9. Provenance and prod

The answer block carries the connection avatar and name; a prod connection
shows the existing read-only chip. The agent is read-only everywhere in v1,
and the UI says so where the user would expect a write to be possible
("Ask can read; edits happen in the grid").

## 10. Motion

`springs.ts` presets only. Thinking-strip chips enter with `spring.snappy`;
panel width with the inspector's spring; follow-up morph with the shared
layout preset. One language (DESIGN rule 6).

## 11. Register

Controls Title Case: `Ask`, `Fix It`, `Open in Tab`, `Copy SQL`, `Ask
Differently`, `How Did It Get This?` is a link → sentence case `How did it
get this?`. Status lowercase: `4 turns · 12.3s`, `cancelled`, `stopped after
12 turns`. No em dashes in any string.

## 12. Accessibility

Streamed answer text lives in a polite live region; chips are buttons with
`aria-pressed`; the trace drawer traps focus like the inspector; every chord
routes through `<Kbd>`.
