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
| `staging.json` | maintainer's staging (creds local only) | 23 | real 202-table schema with legacy twins; not run in CI |
| `staging-hard.json` | staging | 5 | the dirty-data cohort trap and friends |

Gold rules: every gold query verified to run (`--gold-check`); every `LIMIT`
question checked for ties at the boundary; questions pin what strict compare
needs (exact columns, rounding, casts to date, labels); no PII in questions.
Named groups: `judgment` (questions where agents historically added unasked
filters), `dirty` (questions that need probing), `legacy` (questions whose
naive table choice is a v1 twin).

## 3. Harness (`scripts/agent-eval.ts`)

Runs the SAME `src/agent/loop.ts` the app runs, with `eval/tools.node.ts`
implementing `AgentTools` over `pg` (AGENT-SPEC §2.2). Flags mirror the lab:
`--bench`, `--model`, `--provider`, `--tier small|mid|large`, `--ids`,
`--jobs`, `--out`. Writes `eval/results/<label>.json` and a one-screen summary
(accuracy by tier and group, avg turns, tool calls, wall, recall). The lab's
live dashboard and single-question trace viewer port over as
`scripts/agent-eval-dashboard.ts` when a session wants them.

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

### 3.x Presentation score (planned, W5)

Execution accuracy says whether the rows are right; it says nothing about
whether the prose beside them can be read. W5 adds a second, independent score
on the insight-style questions (the "give me insights on <table>" family):
code heuristics over the rendered answer text (bullet count within 2–4 for a
multi-part insight, no sentence over ~30 words, at least one figure per
finding, no restatement of grid rows, no heading deeper than a lead-in), each
a 0/1 check, averaged. A judge-model rubric is a fallback only where the
heuristics and the maintainer's eye disagree on a 20-answer sample. The score
is reported beside accuracy per model and must never move accuracy down; a
prompt change that trades correctness for prettiness is refused.

## 4. Gates

- **PR gate** (CI, any change under `src/agent/**`, `src-tauri/src/agent.rs`,
  `eval/**`): Pagila bench with the cheapest hosted mid-tier model configured
  in CI secrets. Fails if accuracy drops more than 1 question below
  `eval/baseline.json` for that model + `PROMPT_VERSION`, or if any question
  hits the turn cap, or if prefilter recall drops below the baseline.
- **Release gate**: maintainer runs the staging benches locally; numbers go
  into the release notes and `eval/baseline.json`.
- **Baseline updates** are deliberate commits with the measured table in the
  message. A baseline never moves in the same PR as the change it measures.
- **Unmeasured is not green**: the gate fails when `eval/baseline.json` has no
  row for the run's bench + provider + model + `PROMPT_VERSION`. The rows
  recorded on 2026-09-05 are all `claude-code` (the maintainer's subscription);
  configuring `EVAL_API_KEY` for a hosted provider in CI therefore starts with
  one deliberate local run of that provider and a baseline commit.

Reference numbers (2026-09-03, `claude -p` path, so absolute tokens are not
comparable to API runs): Pagila one-shot Haiku 31–32/33, Sonnet 29–30/33;
staging hybrid Haiku 23/23, Sonnet 22/23 at 202 tables; hard Sonnet 5/5,
Haiku 3/5; LFM2.5-2.6B one-shot Pagila 22/33.

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
