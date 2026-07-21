# LESSONS.md — classes of mistakes this app actually made

Every lesson below cost a real bug round in qwry. They are law for future work
here and portable to any app. When a proposed change (from anyone — including
the user) violates one, say so and cite it; the pushback is wanted.

## Data integrity

1. **Serialize/deserialize are born as a pair.** The TSV copier shipped months
   before its parser existed; paste naive-split quoted fields and split quoted
   newlines into extra rows. Any format you emit, you parse — build both
   together and property-test `parse(write(x)) === x` with hostile inputs
   (quotes, tabs, newlines, CRLF, nulls, empties).
2. **Know the platform's silently-lossy conversions.** `JSON.parse→stringify`
   rounds ints past 2⁵³ through float64; single-line inputs strip `\n` from
   `.value`; textareas normalize `\r\n`. Validate ≠ transform: parse to check,
   stage the original bytes. List the runtime's lossy paths before touching
   user data.
3. **Capture context before every await.** Three separate bugs read "the
   active tab/table" after an async gap — wrong tab's draft cleared, one
   refactor away from a wrong-table INSERT. Snapshot (tab, target, session,
   table) at function entry; after an await, `getState().active` answers a
   different question.
4. **Provenance is structural, not cosmetic.** One unscoped `tabs.find()`
   rendered staging rows under prod branding; prod writes ran with zero prod
   ceremony. In any multi-context app (connections, accounts, environments):
   every artifact carries its origin; the chrome speaks for the DATA's origin,
   not the navigation state; never write to A and repaint from B; scope every
   global lookup.
5. **Cached metadata may inform, never refuse.** A tab-frozen schema blocked a
   legal INSERT after an `ALTER` added a default — no escape hatch. Stale
   cache refusing legal work means the app is lying. Resolve live truth first,
   or make the refusal advisory.

## UI

6. **Deliberate conventions can be wrong.** "Touched-but-empty commits `''`"
   was documented, commented, and audit-approved — and violated the human
   model (clearing a field means reset). Audits verify code against intent;
   only dogfooding verifies intent against humans. Treat user bug reports
   about "weird behavior" as intent bugs until proven otherwise.
7. **In virtualized UIs, state owns focus and position — never the DOM.**
   `autoFocus` re-fired on remount and WKWebView scroll-yanked to origin; Tab
   died at the mount boundary; an open editor teleported when its cell left
   the window. Focus/position derive from your own indices; `preventScroll`
   on every programmatic focus; one scroll authority per gesture; pending-refs
   survive remounts.
8. **Sticky chrome shrinks the viewport; alpha hides from probes.** Keyboard
   nav parked the focused row under the sticky header (`scrollPaddingEnd`
   unset); the gutter bug was a 12%-alpha token over scrolling content —
   invisible to every layout probe, provable only in pixels. Every
   scroll-into-view must know the chrome's height; alpha tokens get opaque
   backing when they occlude; geometry bugs demand screenshot-level repro.
9. **Every action gets truthful feedback.** Copies were silent app-wide; info
   notes rendered error-red; "copy cancelled" flashed while the clipboard was
   being replaced anyway. Silence, wrong tone, and false messages all read as
   broken. Feedback must exist, match its register, and be true.

## Process

10. **Polish is consistency systems, not good individual decisions.** Tokens,
    copy registers (WRITING.md), the z-ladder, one easing, one term per concept.
    Each drift is invisible alone and corrosive together. Multi-session work
    WILL drift unless conventions are written law — DECISIONS.md worked;
    strings had no law until WRITING.md and it showed.
11. **One review is not review.** A second pass with a different lens found an
    S1 the first pass missed on the same diff. Independence and a changed
    lens beat added effort on one pass. Reviewers that can execute (repro
    harnesses, property tests) beat reviewers that read. House style: every
    behavioral wave gets an adversarial review; big waves get two with
    different lenses.
