# Horizon

Local long-horizon optimization harness: a Pi worker improves the seed search service
(`demo/search-service`) toward a p95 target while an independent verifier, a durable SQLite
ledger (SQLite or MongoDB Atlas), and a scoped memory layer keep the mission honest and resumable. See
`../HACKATHON_PLAN.md` for the design.

## Requirements

- Node >= 24 (uses `node:sqlite` and type-stripped `.ts` execution)
- Docker (optional) for `"isolation": "container"`; `subprocess` mode needs nothing extra. Container names are recorded in the ledger before `docker run`, so `resume` removes any candidate container orphaned by a controller crash
- MongoDB (optional) for `"ledger": { "backend": "mongodb" }`: Atlas, or any replica set for transactions
- `SUPERMEMORY_API_KEY` (optional); without it the local memory adapter is used
- An LLM API key for the Pi worker (`"worker": "pi"`); the `scripted` worker needs none

## Setup and checks

```sh
npm install
npm run check          # tsc --noEmit
npm run lint           # oxlint .
npm run format:check   # oxfmt --check . (npm run format rewrites in place)
npm test               # recovery, fault injection, policies, report validation, memory scope, lesson policy, context budget
node scripts/smoke-runner.ts   # seed passes; stale-cache fails correctness; bypass fixture is rejected
```

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

The baseline measures repetition spread and freezes the acceptance margin used for every later
verdict: the configured `acceptanceMargin` when it already covers the spread, otherwise the spread
itself (rounded up to 0.1%). Spread at or above `maxRepetitionSpread` (default `targetP95Reduction`)
blocks the mission before optimization so the workload or environment can be repaired. The frozen
value is stored on the mission row and in the `target.assessed` event.

Mission state lives under `runs/<mission>/`: `state.sqlite` (WAL ledger), `artifacts/<hash>/`
(immutable snapshots), `reports/`, `evidence/`, `learned-scenarios/`, `exports/`.

## Ledger backends (SQLite or MongoDB Atlas)

Each mission selects exactly one canonical ledger with `"ledger": { "backend": "sqlite" | "mongodb" }`
(omitted means SQLite). There is no dual-write and no fallback: a MongoDB mission that cannot reach
its database stops scheduling work, keeps local evidence, and reports the ledger as unavailable
instead of switching to SQLite.

- `sqlite` keeps everything under `runs/<mission>/state.sqlite`; used for local missions and fast tests.
- `mongodb` stores missions, tasks, experiments, artifacts, verifications, episodes, lessons,
  learned scenarios, checkpoints, segments, events, outbox and operation intents in mission-scoped
  collections with a schema version, unique indexes and ordered events. Related transitions
  (verdict, best artifact, budget, checkpoint, event, outbox) commit in one transaction; sandbox
  launches, filesystem writes and remote calls stay outside transaction callbacks. A controller
  holds a renewable mission lease; every write is fenced by the lease token so a stale owner's
  writes are rejected after takeover. Artifact bytes, reports and evidence stay on disk and are
  referenced by hash.

Connection settings come from the environment, never from mission JSON (see `.env.example`):
`MONGODB_URI` (controller-only database user, TLS, controller IP in the Atlas access list) and
`MONGODB_DB` (default `horizon_dev`; `ledger.database` in the mission overrides it).

```sh
cp .env.example .env    # fill in MONGODB_URI; .env is git-ignored
set -a; . ./.env; set +a
npm run horizon -- doctor --config mission.atlas.example.json   # connect, topology, indexes, write/read, commit/rollback; credentials redacted
npm run horizon -- mission create --config mission.atlas.example.json
npm run horizon -- run --mission search-p95-atlas
```

Transactions require a replica set. For local integration tests run one in Docker:

```sh
docker run -d --name horizon-mongo -p 127.0.0.1:27017:27017 mongo:8.0 --replSet rs0 --bind_ip_all
docker exec horizon-mongo mongosh --quiet --eval 'rs.initiate()'
MONGODB_TEST_URI='mongodb://127.0.0.1:27017/?replicaSet=rs0&directConnection=true' npm test
```

Without `MONGODB_TEST_URI` the MongoDB tests are skipped; the SQLite contract tests always run.

## Sandbox

Workspace commands from the worker and candidate services under verification run through a
`Sandbox` selected by `"isolation"`:

- `subprocess` (host): bounded child processes with a reduced environment. Cooperative only; not a
  filesystem or network boundary.
- `container` (Docker): the image must be pinned by digest (`name@sha256:...`) and present locally
  (`--pull never`). Containers run as a non-root user with all capabilities dropped,
  `no-new-privileges`, a read-only root, bounded `/tmp`, and CPU/memory/pid/time/output limits.
  Workspace commands get `--network none` and only the candidate workspace mounted; candidate
  services get a read-only snapshot on a per-mission `--internal` network the verifier reaches
  directly, with no external egress. Evaluator files, hidden fixtures, host home, credentials and
  the Docker socket are never mounted. Containers are labeled by mission and operation, killed on
  timeout or cancellation, and orphans are removed during recovery. This is a development
  isolation boundary, not a hardened service for arbitrary hostile code.

When container isolation is configured and Docker or the pinned image is unavailable the mission
fails explicitly; it never falls back to host execution. Workspace paths are resolved to real
paths and symlink escapes are rejected.

## Recovery

Before each external step (verification run, workspace exec) the controller records an operation
intent with a stable ID. On restart it acquires the lease, loads the latest checkpoint, removes
orphaned sandboxes, reconciles unfinished operations against report files (a report is reused only
when its hash and identities match), applies missing transitions idempotently, and resumes with the
original budget totals. If Supermemory is unavailable the outbox is retained, retrieval uses the
scoped local index, and the degraded state is reported.

## Layout

- `demo/search-service/` seed service (frozen contract in `src/domain/contracts.ts`)
- `verification/` independent reference model, fixed scenarios, workloads, runner, report schema, fixtures
- `src/` ledger, artifact store, recovery, controller, tool broker, Pi/scripted workers, memory, lesson policy, CLI
- `resources/` versioned feature map and verification skill
- `test/` deterministic tests

## Configuration comparison and report

`node src/cli.ts compare --config mission.example.json [--repeats N]` runs the three memory configurations (durable only, +retrieval, +validated correction) from the same seed under one crash schedule and writes `comparison.{json,md}`. Findings and limitations against `LONG_HORIZON_AGENT_PROMPT.md` are in `REPORT.md`.
