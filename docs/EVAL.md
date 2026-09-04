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
