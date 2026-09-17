# LESSONS.md: classes of mistakes this app actually made

Every lesson below cost a real bug round in qwry. They are law for future work
here and portable to any app. When a proposed change violates one, even one
from the maintainer, say so and cite it; the pushback is wanted.

## Data integrity

1. **Serialize/deserialize are born as a pair.** The TSV copier shipped months
   before its parser existed; paste naive-split quoted fields and split quoted
   newlines into extra rows. Any format you emit, you parse: build both
   together and property-test `parse(write(x)) === x` with hostile inputs
   (quotes, tabs, newlines, CRLF, nulls, empties).
2. **Know the platform's silently-lossy conversions.** `JSON.parse→stringify`
   rounds ints past 2⁵³ through float64; single-line inputs strip `\n` from
   `.value`; textareas normalize `\r\n`. Validate ≠ transform: parse to check,
   stage the original bytes. List the runtime's lossy paths before touching
   user data.
3. **Capture context before every await.** Three separate bugs read "the
   active tab/table" after an async gap: wrong tab's draft cleared, one
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
   legal INSERT after an `ALTER` added a default, with no escape hatch. Stale
   cache refusing legal work means the app is lying. Resolve live truth first,
   or make the refusal advisory.

## UI

6. **Deliberate conventions can be wrong.** "Touched-but-empty commits `''`"
   was documented, commented, and audit-approved, yet violated the human
   model (clearing a field means reset). Audits verify code against intent;
   only real-world use verifies intent against humans. Treat user bug reports
   about "weird behavior" as intent bugs until proven otherwise.
7. **In virtualized UIs, state owns focus and position, never the DOM.**
   `autoFocus` re-fired on remount and WKWebView scroll-yanked to origin; Tab
   died at the mount boundary; an open editor teleported when its cell left
   the window. Focus/position derive from your own indices; `preventScroll`
   on every programmatic focus; one scroll authority per gesture; pending-refs
   survive remounts. A style a MOTION VALUE owns is the same law: the canvas
   grid's two gesture frames wrote `transform` on the drag layer and a box on
   the placeholder by hand, and the next React commit re-applied their resting
   values - at one width of three, where a commit happened to follow, so it
   read as a layout bug. Write the value where it lives (the motion value, the
   ref, the store) or drive the handler that does; an imperative style write
   survives only on a property neither React nor motion lists.
8. **Sticky chrome shrinks the viewport; alpha hides from probes.** Keyboard
   nav parked the focused row under the sticky header (`scrollPaddingEnd`
   unset); the gutter bug was a 12%-alpha token over scrolling content:
   invisible to every layout probe, provable only in pixels. Every
   scroll-into-view must know the chrome's height; alpha tokens get opaque
   backing when they occlude; geometry bugs demand screenshot-level repro.
9. **Every action gets truthful feedback.** Copies were silent app-wide; info
   notes rendered error-red; "copy cancelled" flashed while the clipboard was
   being replaced anyway. Silence, wrong tone, and false messages all read as
   broken. Feedback must exist, match its register, and be true.
10. **An input may swallow only the keys it owns.** FindBar's blanket
    `stopPropagation` orphaned every window chord (⌘I, ⌘G, ⌘W…) whenever
    focus sat in it; five more surfaces had the same pattern. Stop
    unmodified typing keys only; ⌘/⌃ chords belong to the window handler
    and must bubble. (Capture-phase globals are not the fix: ⌘F scoping
    depends on inner surfaces claiming first.)

## Process

11. **Polish is consistency systems, not good individual decisions.** Tokens,
    copy registers (WRITING.md), the z-ladder, one easing, one term per concept.
    Each drift is invisible alone and corrosive together. Multi-session work
    WILL drift unless conventions are written law: DECISIONS.md worked;
    strings had no law until WRITING.md and it showed.
12. **One review is not review.** A second pass with a different lens found an
    S1 the first pass missed on the same diff. Independence and a changed
    lens beat added effort on one pass. Reviewers that can execute (repro
    harnesses, property tests) beat reviewers that read. House style: every
    behavioral wave gets an adversarial review; big waves get two with
    different lenses.
13. **A status reports the number the user saw work, never an internal
    counter.** A turn-cap failure read `stopped after 1 turns`: qwry's own
    per-invocation counter, ticked once for a single `claude -p` call that
    itself spent its whole budget describing and peeking before its own cap
    ended it. The user watched tools run for a while and was told it stopped
    after one. Read the count from whatever system did the counting (the
    child's own `num_turns` off its result line), word the copy in that
    system's units and grammar (singular at 1: `stopped after 12 turns`),
    and size the wrapper's own budget so a wide question does not spend it
    before the model gets to answer. A wrapper's invocation tally is an
    implementation detail, not a status. Then fix EVERY slot that prints the
    number, not the one in the bug report: the same wave's first fix reworded
    the failure heading and left the footer two lines under it reading `1
    turn`, so one fact stood in two slots with two different numbers (DESIGN
    rule 14), and a successful run's footer went on miscounting because no
    one had complained about that one yet. Read the count once, at the seam
    where it arrives, and hand that value to every slot.
14. **A forgotten handle is a fact every store must hear, not a detail the
    next caller re-derives.** The connection dot tracks the PRIMARY session,
    so five separate paths could drop a TAB session's id (a lone tab death,
    a per-profile wipe, an invalidation, a tab close, heal's own reaping)
    while the dot stayed green and told nobody. The stamp naming that dead
    id (`executedSessionId`) sat untouched through all five, and ten call
    sites handed it to the backend raw. The maintainer's report was the
    proof: browsing a table, the strip read `no such session` under a green
    dot, and ⇧⌘R, which only re-tests connections, could not touch it,
    because nothing about that command spoke to a tab's stamp. The id a
    backend hands back is not yours to keep forever: it is on loan for as
    long as that session lives, and the instant your own store learns the
    session is gone, every place holding the id must hear it, not just the
    one path that happened to notice first. A commit-time-only re-resolve
    (`edits.ts`'s prior `liveSessionId`) fixed the write path and left every
    read behind it exposed: the half-measure this wave replaces with one
    resolver sitting on the only door a backend call goes through, so death
    clears the handle everywhere it is held and a heal re-stamps it, rather
    than waiting on a second reviewer to find the next site six months on.
15. **Take the feedback, not the mechanism.** The maintainer asked for
    `⌘R`/`⇧⌘R` to feel like a browser's reload and hard reload. Slack's own
    `⌘R` is the literal version of that ask: it throws the renderer away and
    rebuilds, which is cheap there because nothing on a chat screen costs
    anything to recreate. Copied straight, the same rebuild here would have
    cost a 40s result, staged edits, scroll position, the canvas layout, and
    rolled back a live transaction; Slack's mechanism carries an assumption
    (nothing on screen is expensive) that does not hold in an editor holding
    a database session. The sketch (`docs/refresh-sketch-e2.html`) built the
    request as two separate effects instead of one borrowed recipe: a sweep
    that plays once and says only "a hard refresh started," and, separately,
    each surface blanking to a same-geometry skeleton only when IT is truly
    mid-refetch, so a tab with staged edits or an open transaction sits
    through the whole gesture with nothing lost, because nothing on it ever
    started a fetch. Lesson 14's own bug is the same class read from the
    other side: `no such session` under a green dot was a mechanism (a
    primary-session probe) standing in where the actual feedback (this tab's
    own handle is dead) belonged, and the maintainer's strip is the evidence
    both times. A familiar interaction is worth naming for what it FEELS
    like, never for what it silently assumes is cheap to lose; re-derive the
    mechanism against what this app actually holds, and play the failure
    case in the sketch, before a line of product code, so the mechanism gets
    checked against the feeling instead of standing in for it unread.
16. **The app answers in the frame; the network answers in the hold.** E2
    shipped correct by every gate it had: `hardRefresh` awaited `requestHeal`
    then `afterHeal` before `surfacePass` fired a single fetch, and each
    surface's own skeleton waited again, on `frontReachMs`, for the sweep's
    front to reach it. On the maintainer's real bastion connection every
    loader landed a full round trip after the sweep, later than the sweep's
    own 720ms band, and his own words named it exactly: it feels like the
    app lags when I press the chord. Each of those waits was individually
    honest, a real round trip, a real front to cross, and stacked they built
    a UI that answered nothing until the network had. This is lesson 9 read
    from a new angle: feedback that is true but late reads as no feedback at
    all, because a user's hand and eyes work on the gesture's own frame, not
    on the database's. The fix is not a faster network; it is to say "the
    app heard you" synchronously, in the one store write the keypress itself
    causes, before any await stands between the chord and the pixel, and let
    the network's honest slowness show only in how long an already-shown
    loader holds, never in when it starts. The bug had a second half: the
    harness that built and gated E2 answered its own `session_probe` in
    0ms, so the wave that wrote `frontReachMs` and its grace period never
    saw the lag it was building, because nothing in its own test rig ever
    took as long as the real world does. A harness that answers faster than
    reality is not a faithful stand-in for reality; give it the latency the
    world has, or it will pass a wave straight into the bug the world was
    always going to find.
