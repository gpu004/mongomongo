# Horizon

Local long-horizon optimization harness: a Pi worker improves the seed search service
(`demo/search-service`) toward a p95 target while an independent verifier, a durable SQLite
ledger, and a scoped memory layer keep the mission honest and resumable. See
`../HACKATHON_PLAN.md` for the design.

## Requirements

- Node >= 24 (uses `node:sqlite` and type-stripped `.ts` execution)
- Docker (optional) for `"isolation": "container"`; `subprocess` mode needs nothing extra.
  Container mode requires `containerImage` pinned by digest (`repo@sha256:...`) and present
  locally (`docker pull node@sha256:...`); the sandbox never pulls at run time and fails
  explicitly instead of falling back to the host. Container names are recorded in the ledger
  before `docker run` and every container is labelled with its mission, so `resume` removes any
  candidate or worker container orphaned by a controller crash
- `SUPERMEMORY_API_KEY` (optional); without it the local memory adapter is used
- An LLM API key for the Pi worker (`"worker": "pi"`): `<PROVIDER>_API_KEY` for the configured `model.provider` (`ANTHROPIC_API_KEY`, or `GOOGLE_API_KEY`/`GEMINI_API_KEY` for `google`); the `scripted` worker needs none

## Setup and checks

```sh
npm install
npm run check          # tsc --noEmit
npm run lint           # oxlint .
npm run format:check   # oxfmt --check . (npm run format rewrites in place)
npm test               # recovery, fault injection, policies, report validation, memory scope, lesson policy, context budget, sandbox
                       # test/sandbox-escape.test.ts runs the adversarial escape-probe fixture against Docker when the
                       # pinned image is present (skipped otherwise; HORIZON_REQUIRE_DOCKER=1 makes the skip a failure)
node scripts/smoke-runner.ts   # seed passes; stale-cache fails correctness; bypass fixture is rejected
```

`stagnationLimit` (mission config): once that many optimize-search experiments have concluded since the last accepted one, the worker's packet carries a stagnation directive listing the mechanisms already tried, and a cycle that repeats one of them without first calling `profile_candidate` is rejected without running the verifier.

## Reproduction

```sh
npm run horizon -- doctor
npm run horizon -- mission create --config mission.example.json
npm run horizon -- run --mission search-p95-demo
npm run horizon -- resume --mission search-p95-demo      # after an interruption
npm run horizon -- inspect --mission search-p95-demo
npm run horizon -- export --mission search-p95-demo       # runs/<mission>/exports/summary.{json,md}
npm run horizon -- live-gate --mission search-p95-demo    # plan.md live-mission criteria -> exports/live-gate.{json,md}; exit 0 only when all met

npm run horizon -- verify --mission search-p95-demo --artifact <hash> --suite smoke|correctness|performance
npm run horizon -- profile --mission search-p95-demo --scenario search-read-heavy
npm run horizon -- features check --artifact <hash>
npm run horizon -- skill-eval                               # grade the worker on fixed verification-skill fixtures
npm run horizon -- memory-bench --episodes 1000,10000      # synthetic history benchmark of retrieval
node scripts/supermemory-probe.ts --episodes 12            # hosted memory: indexing lag, latency, scoped correctness
```

The baseline measures repetition spread and freezes the acceptance margin used for every later
verdict: the configured `acceptanceMargin` when it already covers the spread, otherwise the spread
itself (rounded up to 0.1%). Spread at or above `maxRepetitionSpread` (default `targetP95Reduction`)
blocks the mission before optimization so the workload or environment can be repaired. The frozen
value is stored on the mission row and in the `target.assessed` event.

Mission state lives under `runs/<mission>/`: `state.sqlite` (WAL ledger), `artifacts/<hash>/`
(immutable snapshots), `reports/`, `evidence/`, `learned-scenarios/`, `exports/`.

## Layout

- `demo/search-service/` seed service (frozen contract in `src/domain/contracts.ts`)
- `verification/` independent reference model, fixed scenarios, workloads, runner, report schema, fixtures
- `src/` ledger, artifact store, recovery, controller, tool broker, Pi/scripted workers, memory, lesson policy, CLI
- `resources/` versioned feature map and verification skill
- `test/` deterministic tests

## Live Pi mission (plan.md §5 acceptance gate)

`mission.live.example.json` is the example config with `"worker": "pi"` and the low-cost `google/gemini-3.1-flash-lite` model (mission `search-p95-live`, rotation every 2 cycles, bounded token budget). With `GOOGLE_API_KEY` in the environment:

```sh
node scripts/live-mission.ts --config mission.live.example.json [--runs-root DIR] [--crash-at snapshot_ready]
```

runs the demo sequence — `mission create`, `run` interrupted at the crash point, `resume` to completion, `export`, `live-gate` — and exits with the gate's code. The gate reads only the ledger (never worker prose) and requires: every `optimize-search` experiment authored by the `pi` worker, provider-reported token usage, a measured baseline, at least one non-seeded model candidate with passed smoke+correctness+performance reports, a launch recovered from a checkpoint, an episode retrieved from an earlier segment after a rotation, a passed holdout, and mission status `succeeded`. Commit or link `runs/<mission>/exports/{summary,live-gate}.{json,md}` as the evidence. Running the script against `mission.example.json` (scripted worker) is expected to exit 2 with `worker_is_pi`, `usage_reported` and `model_candidate_verified` failing.

## Configuration comparison and report

`node src/cli.ts compare --config mission.example.json [--repeats N]` runs the three memory configurations (durable only, +retrieval, +validated correction) from the same seed under one crash schedule and writes `comparison.{json,md}`. Findings and limitations against `LONG_HORIZON_AGENT_PROMPT.md` are in `REPORT.md`.
