---
name: taste-gate
description: Pixel-evidence gate for a chrome-touching wave. Renders the Ask pane at floor, default and max in both themes, runs DESIGN.md rules 11–14 as a per-frame checklist, and reports FINDINGS with a pass or block verdict.
---

# Taste gate

Law lives in `docs/DESIGN.md` (rules 1–14; 11–14 are restraint), `docs/WRITING.md` and
`docs/AGENT-UX.md`. This skill is only the procedure, so every session and every workflow
agent runs the same gate. Run it before any wave that touches the Ask pane is called done;
a wave's reviewer runs it too (LESSONS 12: two passes, different lenses). The verdict is
signed by a Fable-class reviewer: restraint is judgment, not rule-matching. A Sonnet agent
may run step 1 and the counting half of step 2, never sign step 3.

## 1. Produce the frames

The fixture harness is a vite route that renders `AskPanel` with a canned thread per state;
`scripts/ask-frames.ts` drives headless Chrome over it. Contract:

- `bun scripts/ask-frames.ts --out <dir>` writes `<dir>/<state>-<width>-<theme>.png` for
  state ∈ `answer` `empty` `busy` `picker` `failure` `disconnected` `small`, width ∈ `320`
  `392` `560`, theme ∈ `dark` `light`: 42 frames, 2× device scale. `--states`, `--widths`,
  `--themes` narrow the matrix (comma lists); the route path and fixture data are documented
  at the top of the script. The `answer` fixture is a LIVE-shaped answer: a nine-row grid, a
  sixty-character question, three tool chips, three assumption chips (one five-word label),
  three follow-ups. `disconnected` and `small` are the composer's two exceptions (no session;
  the one pill that wears a badge).
- `--scroll top` re-runs the matrix with the scroller parked at the question echo and the
  thinking strip, files suffixed `-top`; the default frame shows the answer's end (footer,
  composer) because a 640px card cannot hold the whole live answer.
- A running `bunx vite --port 1420` is optional: the script starts and stops its own vite on
  a free port when 1420 does not answer. Never run the server or the script in the
  foreground for more than ~90 s (the workflow harness kills a silent agent at 3 min):
  `nohup bun scripts/ask-frames.ts … > <log> 2>&1 &`, then `sleep 45; tail -5 <log>` per
  call. Probes use `localhost`, never `127.0.0.1`: this vite config binds `::1` only.
- Frames land in `~/projects/qwry-agent-lab/docs/research/<wave>-frames/` for the
  maintainer's re-check (W2 used `w2-pixels/`). Open the locked sketch beside them:
  `http://127.0.0.1:5462/ask-sketch-v2.html` (`t` toggles its theme).
- The dev build (`bun run tauri dev`) is the final eyeball, never the evidence: synthetic
  input loses events across Spaces and menu tracking loops (ROADMAP_log W2 gotchas).

## 2. Checklist

Answer every question per frame, yes or no, and cite the frame file for every no. Read the
frame with the sketch at the same width beside it.

Rules 11–14 (DESIGN.md):
- **11 · every string earns its pixels.** List every visible string. For each: its register
  (WRITING table) and what is lost if it is deleted. A string with no loss is a finding. Does
  any chrome explain a standard interaction (↩, ⇧↩, ⌘., Esc) or state what is always true
  (read-only, "shows its SQL")? Does anything, anywhere, explain a tier?
- **12 · a strip states one thing.** Count the header: title + at most one qualifier + at most
  two icon buttons. Count the composer control row: pill + send, nothing else. Is every
  control that configures an action beside that action? Does provenance appear more than
  once in a zone (header avatar AND footer avatar is a finding)?
- **13 · floor first.** Lay 320, 392 and 560 side by side: is the chrome pixel-identical
  (same rows, same order, same control count)? At 320, does anything clip, wrap or
  ellipsize other than the collapsed SQL preview, grid cells and the thinking strip's left
  fade? Does the wider frame show any control the floor does not?
- **14 · data once.** Does the same fact render in two slots? Does the prose contain a
  number the grid shows, a SQL fragment the SQL row shows, or an assumption a chip shows?
  Is the prose one or two sentences?

Also, per frame:
- Both themes read: tiers hold (rule 3), chips and badges legible on both, nothing tuned for
  one theme only.
- Sketch and frame agree at this width: same anatomy, same register, same control count.
- Status register: one decimal and a space before every unit (`1861.9 ms`, `20.4 s`); no
  raw floats, no `12.3s`.
- Chips wrap and never overflow their pill; the footer is one line at 320; the grid header
  is uncut at 320; the picker's pill shows a name (a badge only for `small`); the busy frame
  shows a spinner chip and a Stop face; the empty frame shows three starters and nothing
  else; the failure frame keeps the anatomy (echo, strip, failure block, footer).
- Chords only through `<Kbd>`; no em dash in any string (`bun scripts/design-lint.ts` is
  `0 finding(s)`).

## 3. Report

```
TASTE GATE · <wave> · <date>
frames: <n>/30 reviewed (<dir>)
FINDINGS
S1 · rule <n> · <frame>.png · <what is wrong, one sentence> · <the fix, one sentence>
S2 · …
S3 · …
verdict: pass | block
```

Severity: **S1** = a rule 11–14 violation, a clip or wrap at the floor, chrome that differs
between widths, a string outside its register, a false or missing feedback (LESSONS 9).
**S2** = a rule 1–10 violation, a sketch mismatch that does not break 11–14, a theme that
reads worse than the other. **S3** = a nit with a named fix.

Any S1 blocks. A block means a fixer round and a re-run of this gate on fresh frames, never
"awaiting taste pass". `pass` needs zero S1 and every S2 either fixed or ledgered in the
wave's ROADMAP_log note with a reason. Every finding cites a frame file; a finding with no
frame is a hypothesis and goes to the note, not the report.
