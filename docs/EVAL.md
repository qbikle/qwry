# EVAL.md: agent quality is a number

The agent is the first part of qwry whose correctness cannot be typechecked.
This file makes it measurable and makes regressions fail the build. It ports
the qwry-agent-lab harness (`~/projects/qwry-agent-lab`) into the repo.

## 1. What is measured

**Execution accuracy**: the agent's final SQL and a hand-verified gold SQL
both run against the bench database; result sets are compared as multisets
of normalised rows. SQL text is never compared (many correct queries per
question). Verdicts: `PASS`, `WRONG` (ran, different rows), `EXEC-FAIL`
(never produced runnable SQL). Alongside, per question: model turns, tool
calls by name, wall-clock, tokens (input / cached / output), prefilter
recall (did the candidate set contain every table the gold SQL uses),
whether the risk classifier fired.

## 2. Benches (`eval/bench/`)

| file | DB | n | purpose |
|---|---|---|---|
| `pagila.json` | Pagila (public) | 33 | CI bench; tiers 1–5; `value` probes (uppercase names, `'Sci-Fi'`) |
| `pagila-hard.json` | Pagila | 5+ | analyst-spec questions: cohorts, windows, funnels |
| `pagila-insight.json` | Pagila | 8 | the presentation bench (section 3.x): insight-style questions, no gold |
| `staging.json` | maintainer's staging (creds local only) | 23 | real 203-table schema with legacy twins; not run in CI; results live outside the repo |
| `staging-hard.json` | staging | 5 | the dirty-data cohort trap and friends; results live outside the repo |

Gold rules: every gold query verified to run (`--gold-check`); every `LIMIT`
question checked for ties at the boundary; questions pin what strict compare
needs (exact columns, rounding, casts to date, labels); no PII in questions.
Named groups: `judgment` (questions where agents historically added unasked
filters), `dirty` (questions that need probing), `legacy` (questions whose
naive table choice is a v1 twin), `insight` (questions with no single right
row set, scored on presentation instead).

`pagila-insight.json` is the one bench with `gold_sql: null` throughout: "what
stands out in rentals by month?" has no gold row set, and pinning one would
score the analyst's judgment as arithmetic. Those questions land as `RAN`
(the SQL ran) rather than `PASS`, which is not a failure; what is measured on
them is section 3.x.

The two staging benches run by hand and their artifacts never enter the repo:
the shell that starts a run holds the credentials, the artifact holds the
model's answers and predicted SQL over the maintainer's data, so `--out` and
`--progress` point both at a directory outside the tree (the W3 runs used the
session scratchpad's `w3-eval/`), and what comes back is the numbers, in
section 4's table and in `ROADMAP_log.md`. `eval/baseline.json` carries no
staging row yet (section 4).

## 3. Harness (`scripts/agent-eval.ts`)

Runs the SAME `src/agent/loop.ts` the app runs, with `eval/tools.node.ts`
implementing `AgentTools` over `pg` (AGENT-SPEC §2.2). Flags mirror the lab:
`--bench`, `--model`, `--provider`, `--tier small|mid|large`, `--ids`,
`--jobs`, `--out`. Writes `eval/results/<label>.json` and a one-screen summary
(accuracy by tier and group, avg turns, tool calls, wall, recall, and the
presentation mean where the bench has `insight` questions). The lab's
live dashboard and single-question trace viewer port over as
`scripts/agent-eval-dashboard.ts` when a session wants them.

**A2, 2026-09-06:** the eval passes no profile to the loop, so every bench
here measures the bare prompt — no run carries a hint, a definition, a
synonym or an earlier answer (AGENT-SPEC §4.2, §4.8) — and a knowledge
bench, one that seeds a profile before asking, is open (ROADMAP).

**How to run.** The bench database defaults to the lab Postgres,
`postgres://lab@127.0.0.1:5455/pagila`, never 5432 (on the maintainer's machine
that port is a production bastion tunnel); `--dsn` points it elsewhere. Four
flags decide a run: `--bench`, `--provider`, `--model`, `--jobs`. Output lands
in `eval/results/<label>.json` beside `progress-<label>.jsonl`, both gitignored;
`eval/baseline.json` is the committed part.

```sh
bun scripts/agent-eval.ts --bench eval/bench/pagila.json --gold-check
bun scripts/agent-eval.ts --bench eval/bench/pagila.json --provider claude-code \
  --model claude-haiku-4-5 --jobs 3 --label pagila-haiku-v1 --baseline eval/baseline.json
```

`--gold-check` needs no model: every gold query runs and any LIMIT that cuts
through a tie is named. `--baseline` scores the finished run against the row for
the same bench + model + provider + `PROMPT_VERSION`, exits non-zero on the
section 4 rules, and treats a combination with no row as unmeasured, not green.
`--ids` reruns one question, `--tier` one tier.

A staging DSN needs `?uselibpqcompat=true&sslmode=require`: under a bare
`sslmode=require`, `pg` 8.23 verifies the server certificate and refuses the
staging server's self-signed chain with `SELF_SIGNED_CERT_IN_CHAIN`, which cost
both W3 staging runs their first launch. The credentials stay local (sourced
inside the subshell that starts the run, never echoed), and the run's `--out`
and `--progress` go outside the repo (section 2).

### 3.x Presentation score

Execution accuracy says whether the rows are right; it says nothing about
whether the prose beside them can be read. The second score, on the
insight-style questions only, is five code heuristics over the SAME parse the
answer slot renders (`parseBlocks` in `src/agent/display.ts`), each 0/1,
averaged. `eval/presentation.ts` is the whole of it; nothing about it is a
model call.

| check | 1 when |
|---|---|
| `bullets_in_range` | the answer has 2 to 4 list items in all; a list-less answer scores 0 |
| `sentences_short` | no sentence in any block runs past 30 words |
| `figure_per_finding` | every list item carries at least one figure token, emphasis included, and there is at least one item |
| `no_grid_restatement` | no list item names two or more DISTINCT cell values of ONE grid row (1 when the answer had no run) |
| `one_lead_in_at_most` | at most one lead block, and never two in a row |

Two of the five want findings, three judge their quality, and the ladder they
make is the point: a shaped insight answer scores 1.0, a wall of prose 0.4, a
short honest direct answer 0.6 (a direct question is not an insight question
and is not asked one on this bench). `no_grid_restatement` is DESIGN rule 14
as a number: the grid already holds the rows, so a bullet that reads two cells
of one row back to the reader is a second slot for one fact. Cells shorter
than three characters are ignored, and digits are compared with the thousands
separators stripped, so `2,763` in prose meets `2763` in the cell. Two cells
means two DISTINCT values: a count carried twice across one row (orders = paid
orders, gross = net) is one figure in two columns, and a bullet that names it
once has named one fact. `figure_per_finding` reads emphasis one level down,
the way the renderer does, so a figure the model bolded still counts:
`AnswerText` re-tokenizes bold and draws the number inside it at tier 1.

**The mean is taken over the answers it may be taken over**: an insight
question whose SQL RAN, and no other. An `EXEC-FAIL` puts no grid on screen,
`no_grid_restatement` is 1 where there is no grid, and averaging that answer in
would let a prompt buy presentation by breaking the query, which is a gate that
can be bought. In the first v3 run the one question that timed out was the only
1.0 on the board, and it lifted the run's number from 0.771 over 7 to 0.800
over 8: 0.029 of the gate's own 0.05 of slack, paid for by a failed query. The
score still sits on that question's row in the results file and
`presentation_unscored` names it; what it may not enter is the number.

A judge-model rubric stays the fallback for where these five and the
maintainer's eye disagree on a 20-answer sample. It is not built.

**Measured, 2026-09-06** (lab Postgres, `claude-haiku-4-5` via `claude-code`,
`--jobs 3`; results in `eval/results/<label>.json`, gitignored, logs in the
session scratchpad). Every presentation number here is `presentationScore` at
the code that shipped this wave, recomputed from each run's `answer_full` and
`run_shape`: the artifacts keep both, so a number is never stranded in a
summary someone has to trust.

| run | bench | accuracy | presentation |
|---|---|---|---|
| prompt v2 | `pagila-insight.json` | 7/8 ran | **0.514** over 7 |
| prompt v3, first draft | `pagila-insight.json` | 7/8 ran | **0.771** over 7 |
| prompt v3, as shipped | `pagila-insight.json` | 8/8 ran | **0.850** over 8 |
| prompt v3, as shipped | `pagila.json` | **32/33** | not scored (no insight questions) |
| prompt v4, first draw | `pagila-insight.json` | 7/8 ran | **0.714** over 7 |
| prompt v4, second draw | `pagila-insight.json` | 8/8 ran | **0.875** over 8 |
| prompt v4, third draw (the baseline row) | `pagila-insight.json` | 8/8 ran | **0.850** over 8 |
| prompt v4 | `pagila.json` | **33/33** | not scored (no insight questions) |

```sh
bun scripts/agent-eval.ts --bench eval/bench/pagila-insight.json \
  --provider claude-code --model claude-haiku-4-5 --jobs 3 --label insight-haiku-v3c
bun scripts/agent-eval.ts --bench eval/bench/pagila.json \
  --provider claude-code --model claude-haiku-4-5 --jobs 3 --label pagila-haiku-v3c
```

What moved, check by check. v2 to v3's first draft, over each run's own seven
scored answers (a different question timed out in each): `bullets_in_range` 2/7
to 7/7, `figure_per_finding` 1/7 to 7/7, `one_lead_in_at_most` 5/7 to 7/7,
`sentences_short` 3/7 to 5/7, and `no_grid_restatement` the other way, 7/7 to
1/7. The shape arrived and rule 14
left with it, for a reason the prompt owned: v3's own GOOD example opened on
`611 of 2,763 orders were COD, 22% of the month and the year's highest share`,
three cells of one result row, and the model followed the example rather than
the rule beside it.

The shipped v3 moves that bullet into the BAD example, says what a bullet IS
(a comparison the grid cannot make for itself, ONE figure, no second finding
stacked on after a dash or a semicolon) and caps it at 25 words instead of "two
lines", which a model has no way to measure. Over eight answers, all of which
ran: `no_grid_restatement` 4/8, `sentences_short` 8/8, `figure_per_finding`
8/8, `bullets_in_range` 7/8, `one_lead_in_at_most` 7/8, mean **0.850**. The
two halves were measured apart: with the example fixed but a bullet still
capped at "two lines", the mean was 0.750 over 8 and `sentences_short` 3/8, so
the countable cap is what carried the rest. Both remaining misses are one
answer, `ins-05`, which stacks a second lead-in over five bullets. Rule 14 is arriving and has not landed: four answers still name
two cells of one row inside a comparison, and that is the next iteration's
finding.

Accuracy against the v1 baseline row for the same bench, model and provider
(33/33, recall 0.94, 2026-09-04): **32/33**, recall 0.94, 0 turn-cap hits,
lost: t1-07, on the shipped prompt and on its first draft alike. That is within
the section 4 tolerance of one question, and `t1-07` is the bench's oldest trap
(the customer name is stored uppercase and the model skipped `peek_values`),
not a shape the prompt change touches. `PROMPT_VERSION` is now `v3`; the W3
re-baseline (`d30e28a`, 2026-09-06) recorded its rows, one per bench and model
(section 4), and the W3 run of this same bench read 33/33, so the `t1-07` loss
above was sampling noise. Until that commit every gated run of v3 read as
unmeasured, which was correct. v3 was revised twice before any baseline row
existed for it, which is why the version did not move with it; a revision
after a row exists is a new version, and section 4's two recorded v3 losses
are the first candidates for one.

**v4** (W3b, 2026-09-06) is that new version: three sentences added to the
same rules list, nothing else moved (AGENT-SPEC §6). Measured on Haiku three
times the same day, because the first draw read as a loss: 7/8 ran and
**0.714** over 7 (`ins-05` EXEC-FAILed after 12 model turns and ~225 s, 19–21
`run_sql` calls where 8–11 were served; avg_turns 2.5 and avg_wall 57.7 s,
both double the bench's norm), then 8/8 ran and **0.875** over 8, then 8/8 ran
and **0.850** over 8 (avg_turns 1.1, avg_wall 32.8 s and 25.7 s, `ins-05` in
one turn both times). The baseline row is the third artifact, the median of
the three and the one whose shape matches the v3 run it replaces
(`bullets_in_range` 8/8, `figure_per_finding` 8/8, `no_grid_restatement` 2/8
against v3c's 4/8, the one check still open), so v4's level is v3's 0.850 and
section 4's bar holds on this row. The first draw stays in `eval/results/` as
what one sample of an eight-question bench reads: about 0.08 either side of
its level, wider than the gate's 0.05 slack, which is why a single insight run
under a row is re-sampled once before it counts as a regression. Sonnet moved
up over the same eight answers, 0.825 to **0.900**. On SQL, v4 recovers both
v3 losses at no cost to the other model: Sonnet `pagila.json` **33/33** and
Haiku `pagila-hard.json` **5/5**; section 4's table has every row.

## 4. Gates

- **PR gate** (CI, any change under `src/agent/**`, `src-tauri/src/agent.rs`,
  `eval/**`): Pagila bench with the cheapest hosted mid-tier model configured
  in CI secrets. Fails if accuracy drops more than 1 question below
  `eval/baseline.json` for that model + `PROMPT_VERSION`, or if any question
  hits the turn cap, or if prefilter recall drops below the baseline.
- **Release gate**: maintainer runs the staging benches locally; numbers go
  into the release notes (the table below and `ROADMAP_log.md`) and, by a
  deliberate baseline commit of their own, `eval/baseline.json`. The W3
  numbers below are release-notes numbers: no staging row has been committed
  yet, so `--baseline` still reads the staging benches as unmeasured
  (DECISIONS, Agent A1 W3).
- **Baseline updates** are deliberate commits with the measured table in the
  message. A baseline never moves in the same PR as the change it measures.
- **Unmeasured is not green**: the gate fails when `eval/baseline.json` has no
  row for the run's bench + provider + model + `PROMPT_VERSION`. The rows
  recorded on 2026-09-06 are all `claude-code` (the maintainer's subscription);
  configuring `EVAL_API_KEY` for a hosted provider in CI therefore starts with
  one deliberate local run of that provider and a baseline commit.
- **Presentation never goes down**: on a bench with `insight` questions, a
  baseline row may carry a `presentation` mean, and the run fails when its own
  mean is more than 0.05 below it. The slack is deliberate: on a bench of
  eight, one check flipping on one answer moves the mean by 0.025 and a whole
  answer collapsing from shaped to a wall moves it by 0.075, so two checks of
  noise pass the gate and one lost answer does not. The mean on both sides is
  over the insight answers whose SQL RAN (section 3.x), so a prompt can never
  raise presentation by failing more queries: that lands on accuracy, where it
  belongs. A baseline row without the field does not arm the rule, which is how
  every row recorded before W5 reads.
- **Writes add no prompt surface (A4, 2026-09-06)**: `PROMPT_VERSION` stays
  `v4`. A write-enabled connection appends a `WRITES:` block to the USER
  message (`writesMessage()` in `prompt.ts`, AGENT-SPEC §8.7, AGENT-UX §13),
  never to `SYSTEM_PROMPT`, which stays the byte-equal v4 string
  `prompt.test.ts` already pins; the eval drives no connection with edits on,
  so it sends no `WRITES:` block, and `loop.test.ts` pins the eval's message
  byte-identical to today's. No bench row in this file moves for a change no
  gated run ever sees.

- **A2 moves no prompt byte**: `PROMPT_VERSION` stays `v4` through the
  knowledge and history additions (AGENT-SPEC §4.2, §4.8); `prompt.test.ts`
  keeps its v1–v4 pins unchanged and `loop.test.ts`'s no-profile message pin
  is extended to assert the `KNOWLEDGE:` and `EARLIER ANSWERS ON THIS
  DATABASE:` blocks are absent, so every row in the table below still reads
  against the same bytes it always has.

**Reference numbers, 2026-09-06** (W3b; provider `claude-code`, `--jobs 3`,
`PROMPT_VERSION` v4, 0 turn-cap hits on every row except `pagila-insight.json`
+ claude-haiku-4-5, whose `ins-05` EXEC-FAILed twice and pushed `avg_turns` to
2.5; Pagila and insight artifacts under `eval/results/`; staging artifacts in
the session scratchpad's `w3b-eval/`, outside the repo. `v1 / ref.` and `v3`
are kept as history, transcribed from the W3 close's table below; `v3` is the
row `d30e28a` committed and `c6494b6` superseded):

| bench | model | v1 / ref. | v3 | v4, measured | recall | presentation |
|---|---|---|---|---|---|---|
| `pagila.json` | claude-haiku-4-5 | 33/33 | 33/33 | **33/33** | 0.94 | not scored |
| `pagila.json` | claude-sonnet-5 | 32/33 | 28/33 | **33/33** | 0.94 | not scored |
| `pagila-hard.json` | claude-haiku-4-5 | 5/5 | 3/5 | **5/5** | 1.00 | not scored |
| `pagila-hard.json` | claude-sonnet-5 | 5/5 | 5/5 | **5/5** | 1.00 | not scored |
| `pagila-insight.json` | claude-haiku-4-5 | no row | 8/8 ran, 0.850 | **8/8 ran** | n/a | **0.850** over 8 (three draws: 0.714 over 7 · 0.875 · 0.850; the row is the median artifact) |
| `pagila-insight.json` | claude-sonnet-5 | no row | 8/8 ran, 0.825 | **8/8 ran** | n/a | **0.900** over 8 |
| `staging.json` | claude-haiku-4-5 | ref. 23/23 | 23/23 | **23/23** | 1.00 | no insight questions |
| `staging.json` | claude-sonnet-5 | ref. 22/23 | 21/23 | **23/23** | 1.00 | no insight questions |
| `staging-hard.json` | claude-haiku-4-5 | ref. 3/5 | 3/5 | **4/5** | 1.00 | no insight questions |
| `staging-hard.json` | claude-sonnet-5 | ref. 5/5 | 5/5 | **5/5** | 1.00 | no insight questions |

Both v3 losses are recovered at v4, at no cost to the other model: Sonnet
`pagila.json` is **33/33** (`t3-08`, `t4-04`, `t5-01` lose the extra column;
`t1-07` and `t4-02` pass too, all four repeated 3/3 on a second draw) while
Haiku holds its own `pagila.json` 33/33 unchanged; Haiku `pagila-hard.json` is
**5/5** (`ph-05` pre-aggregates rental and payment in their own CTEs, `ph-03`
casts before dividing, both twice) while Sonnet holds its own 5/5 unchanged.
`t4-02`'s recall stays 0.00 on its row (the prefilter's candidate set misses a
table the gold SQL uses; the model still answers it right) at v1, v3 and v4
alike, capping both `pagila.json` rows at 0.94 for any prompt version —
prefilter work, not prompt work. Staging is new: no row existed at any prompt
version before this wave. `staging.json` is 23/23 on both models (Sonnet +2
over v3, +1 over the 09-03 reference: `s3-04`'s zero-filled calendar spine and
`s5-02`'s extra `total_amount` are both gone, each fixed by the rule written
for it). `staging-hard.json` is 5/5 on Sonnet (unchanged) and **4/5** on Haiku
(+1 over v3 and the 09-03 reference: `h-05` flips to a pass); `h-01` remains
lost (the predicted cohort test has no lower bound), matching the 09-03
reference, and no v4 rule addresses it, so it is not a v4 regression. Arming
`staging-hard.json` + claude-haiku-4-5 at 4/5 accepts 3 on a later run, the
same judgment call the pagila-hard Haiku row carried at v3.

One row needed three draws before it could be read: `pagila-insight.json` +
claude-haiku-4-5 first read 7/8 ran and **0.714** over 7 against the v3 row's
8/8 and **0.850** over 8, 0.136 down where the gate's slack is 0.05, with
`ins-05` EXEC-FAILing (12 model turns, ~225 s, 19–21 `run_sql` calls against
8–11 served by the tool server, the model's own final text claiming the
database was unresponsive while the lab Postgres answered a count immediately
afterward) and every count double the bench's norm; two more draws the same
hour read 8/8 and **0.875** and 8/8 and **0.850**, `ins-05` answered in one
turn both times. The row is the third artifact, the median; the first draw is
sampling on an eight-question bench and stays in the results as evidence, and
the rule it taught is above: one run under an insight row is re-sampled once
before it counts. The Sonnet row moved the other way over the same eight
answers, 0.825 to **0.900**; `no_grid_restatement` is the one check that has
not landed on either model (DESIGN rule 14).

Previous reference, 2026-09-06 (W3 close; `PROMPT_VERSION` v3, superseded by
v4 above): the same ten rows at `d30e28a` / `521e841`, before the v4 rules —
Sonnet `pagila.json` 28/33 (`t3-08`, `t4-04`, `t5-01` keep an extra column
beside the ones the question asked for, the column the prose wants a figure
from; `t1-07` is noise, `t4-02` failed at v1 too; Haiku passes all four on the
same bytes), Haiku `pagila-hard.json` 3/5 (`ph-05` joins rental and payment to
customer in one pass and multiplies the payment sum by the rental count in
both samples; `ph-03` passes the second sample, which read 4/5; a row is one
artifact), staging Sonnet `s3-04` (a zero-filled calendar spine, 12 rows for
3) and `s5-02` (`total_amount` kept beside `currency, order_id`), both passing
on a two-question re-sample so the one-below against the 09-03 reference read
as sampling noise, and staging-hard Haiku's `h-01` (the cohort's lower bound)
and `h-05` (`insta_users.follower_count` for `follows`), both read from the
predicted SQL and matching the 09-03 reference. Detail: `ROADMAP_log.md`, the
W3 note.

Previous reference (2026-09-03, the lab harness, `claude -p` path, so absolute
tokens are not comparable to API runs): Pagila one-shot Haiku 31–32/33, Sonnet
29–30/33; staging hybrid Haiku 23/23, Sonnet 22/23 at 202 tables; hard Sonnet
5/5, Haiku 3/5; LFM2.5-2.6B one-shot Pagila 22/33.

## 5. Bench database in CI

`docker run postgres:18` + `eval/db/pagila-schema.sql` + `pagila-data.sql`
(vendored, MIT). `ANALYZE` after load so `pg_stats` values exist (a column
without stats yields no `-- values:` line; the lab hit this live).

## 6. What the numbers are not

Pagila is in every model's training data: absolute scores are inflated;
deltas between variants are still meaningful. Staging is the honest bench and
stays local. Tokens reported through `claude -p` include Claude Code's own
prefix; compare turns, output tokens, and wall-clock across providers, and
input tokens only within one provider.
