# Horizon

Local long-horizon optimization harness: a Pi worker improves the seed search service
(`demo/search-service`) toward a p95 target while an independent verifier, a durable SQLite
ledger, and a scoped memory layer keep the mission honest and resumable. See
`../HACKATHON_PLAN.md` for the design.

## Requirements

- Node >= 24 (uses `node:sqlite` and type-stripped `.ts` execution)
- Docker (optional) for `"isolation": "container"`; `subprocess` mode needs nothing extra
- `SUPERMEMORY_API_KEY` (optional); without it the local memory adapter is used
- An LLM API key for the Pi worker (`"worker": "pi"`); the `scripted` worker needs none

## Setup and checks

```sh
npm install
npm run check          # tsc --noEmit
npm test               # recovery, fault injection, policies, report validation, memory scope, lesson policy, context budget
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

npm run horizon -- verify --mission search-p95-demo --artifact <hash> --suite smoke|correctness|performance
npm run horizon -- profile --mission search-p95-demo --scenario search-read-heavy
npm run horizon -- features check --artifact <hash>
npm run horizon -- skill-eval                               # grade the worker on fixed verification-skill fixtures
npm run horizon -- memory-bench --episodes 1000,10000      # synthetic history benchmark of retrieval
node scripts/supermemory-probe.ts --episodes 12            # hosted memory: indexing lag, latency, scoped correctness
```

Mission state lives under `runs/<mission>/`: `state.sqlite` (WAL ledger), `artifacts/<hash>/`
(immutable snapshots), `reports/`, `evidence/`, `learned-scenarios/`, `exports/`.

## Layout

- `demo/search-service/` seed service (frozen contract in `src/domain/contracts.ts`)
- `verification/` independent reference model, fixed scenarios, workloads, runner, report schema, fixtures
- `src/` ledger, artifact store, recovery, controller, tool broker, Pi/scripted workers, memory, lesson policy, CLI
- `resources/` versioned feature map and verification skill
- `test/` deterministic tests

## Configuration comparison and report

`node src/cli.ts compare --config mission.example.json [--repeats N]` runs the three memory configurations (durable only, +retrieval, +validated correction) from the same seed under one crash schedule and writes `comparison.{json,md}`. Findings and limitations against `LONG_HORIZON_AGENT_PROMPT.md` are in `REPORT.md`.
