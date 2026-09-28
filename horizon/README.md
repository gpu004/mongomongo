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
- `MONGODB_URI` / `MONGODB_DB` (optional) for the MongoDB ledger; see `.env.example`. When set,
  missions use MongoDB unless the mission config pins `"ledger": { "backend": "sqlite" }`;
  `"backend": "mongodb"` refuses to start without `MONGODB_URI`. Every controller run claims a
  fenced lease (monotonic fencing token, heartbeat-renewed) so a stale controller's writes are
  rejected instead of corrupting the mission. `doctor` probes connectivity, a disposable write/read, a transaction, and the required
  indexes, then removes its probe data without printing credentials
- An LLM API key for the Pi worker (`"worker": "pi"`): `<PROVIDER>_API_KEY` for the configured `model.provider` (`ANTHROPIC_API_KEY`, or `GOOGLE_API_KEY`/`GEMINI_API_KEY` for `google`); the `scripted` worker needs none

Pi and Supermemory are consumed as the npm packages pinned in `package.json`
(`@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, `supermemory`); the repo carries no
vendored copy of either project.

## Setup and checks

```sh
npm install
npm run check          # tsc --noEmit
npm run lint           # oxlint --max-warnings 0 . + scripts/lint-comments.ts (no section dividers, diff narration, or unjustified suppressions)
npm run format:check   # oxfmt --check . (npm run format rewrites in place)
npm test               # recovery, fault injection, policies, report validation, memory scope, lesson policy, context budget, ledger contract
MONGODB_URI=... npm test   # additionally runs the ledger contract and controller runtime tests against MongoDB in throwaway databases
npm test               # recovery, fault injection, policies, report validation, memory scope, lesson policy, context budget, sandbox
                       # test/sandbox-escape.test.ts runs the adversarial escape-probe fixture against Docker when the
                       # pinned image is present (skipped otherwise; HORIZON_REQUIRE_DOCKER=1 makes the skip a failure)
node scripts/smoke-runner.ts   # seed passes; stale-cache fails correctness; bypass fixture is rejected
```

`.github/workflows/ci.yml` runs this set on every pull request and push to `main` with no
provider or service credentials: one job with the sqlite ledger and subprocess isolation, and a
second job that pulls the digest-pinned `containerImage` from `mission.example.json` and starts a
MongoDB service so the sandbox-escape tests run under `HORIZON_REQUIRE_DOCKER=1` and the ledger
contract covers both adapters.

`stagnationLimit` (mission config): once that many optimize-task experiments have concluded since the last accepted one, the worker's packet carries a stagnation directive listing the mechanisms already tried, and a cycle that repeats one of them without first calling `profile_candidate` is rejected without running the verifier.

## Reproduction

```sh
npm run horizon -- doctor
npm run horizon -- mission create --config mission.example.json
npm run horizon -- run --mission search-p95-demo
npm run horizon -- resume --mission search-p95-demo      # after an interruption or pause
npm run horizon -- stop --mission search-p95-demo        # ask the running controller to stop after in-flight work (Ctrl-C/SIGTERM does the same)
npm run horizon -- pause --mission search-p95-demo       # like stop, but `run` stays paused until `resume`
npm run horizon -- amend --config mission.example.json    # raise budgets / change model, worker, rotation, stagnation, memory
npm run horizon -- rebaseline --mission search-p95-demo  # after the evaluator (or an invalidating runtime change) drifted
npm run horizon -- doctor --mission search-p95-demo      # contract / evaluator / environment drift notes for a frozen mission
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

Mission state lives under `runs/<mission>/`: `state.sqlite` (WAL ledger; MongoDB when selected), `artifacts/<hash>/`
(immutable snapshots), `reports/`, `evidence/`, `learned-scenarios/`, `exports/`. `manifest.json` holds the
config the CLI resumes from plus the identities frozen in the ledger; it is rewritten whenever they change.

### Amending a long mission

The contract hash covers the frozen objective only: target, workloads, acceptance settings, isolation and
image, timeouts. Budgets, `model`, `worker`, `segmentRotationCycles`, `stagnationLimit`, `performanceRejectionLimit` and `memory` are
operating parameters, and the ledger backend is a deployment pin. `amend --config` replaces the operating
parameters of an existing mission (same `missionId`): every leaf change is recorded as `mission.amended`
(`{path, from, to}`), each raised budget limit also as `budget.extended`, the manifest is rewritten, and a
mission stopped on `budget_exhausted` becomes resumable. Changing any objective field or the ledger backend
is refused; start a new mission instead.

On resume the ledger's frozen identities are compared with the current process. A different host runtime
(Node patch or minor, or any Node change under container isolation) is accepted: the mission continues,
the environment hash is refrozen and `environment.drifted` records the old and new fingerprints. Drift that
changes what the frozen reports measured is refused: isolation mode or image, platform or architecture, or a
Node major change under subprocess isolation (the candidate runs on the host). A changed evaluator is always
refused. Both point to `rebaseline --mission`, which adopts the current evaluator and runtime, re-measures
the seed (new baseline and acceptance margin), re-measures the previous best against it (kept only if it
still clears the margin, otherwise the seed becomes the best), resets the holdout, and records
`evaluator.rebaselined`. Earlier reports stay in the ledger as history under their own hashes and are
never reused: every committed rebaseline is a numbered epoch (`mission:<id>:rebaselined:<n>`), and the
baseline, target, holdout and re-measurement experiments and events of epoch `n` carry a `-r<n>` suffix
(the original run keeps the plain names), so even revisiting an earlier evaluator or runtime measures
afresh. A stored report is additionally only reused when it cites the current hashes. A rebaseline that
fails or is interrupted after `evaluator.rebaselined` is committed is retried within the same epoch on the
next `rebaseline` (it is only a no-op once the baseline and the previous best are measured under it).

## Objectives (MissionSpec)

A mission's objective is a `MissionSpec` plugin (`src/mission-spec.ts`) selected by the optional
`missionSpec` field of the mission config; a config without it (every mission created before the field
existed, `mission.example.json`) is `search-p95`, so its contract hash is unchanged. `missionSpec` is part
of the frozen objective: `amend` refuses to change it. Two objectives ship:

| `missionSpec`          | seed                   | metric                                                           | tasks                                        | example                            |
| ---------------------- | ---------------------- | ---------------------------------------------------------------- | -------------------------------------------- | ---------------------------------- |
| `search-p95` (default) | `demo/search-service/` | `p95LatencyMs`, minimize, 3 request-driven repetitions           | `baseline` -> `optimize-search` -> `holdout` | `mission.example.json`             |
| `bundle-size`          | `demo/text-kit/`       | `bundleBytes` (bytes under `src/`), minimize, 1 exact repetition | `baseline` -> `shrink-bundle` -> `holdout`   | `mission.bundle-size.example.json` |

The controller, context packet, lesson policy, progress/export, live gate, compare, `verify`/`profile`,
`features check` and `doctor` only reach the objective through the spec: its task graph, metric (key,
per-repetition series key, unit, direction, lesson metric), evaluator (`id`, `hash()`, `run(request,
suite)`), seed directory, scenarios and feature map, verification skill, the objective paragraph of the Pi
system prompt, the pinned constraint line and correction hint, whether learned regressions are accepted
(and against which negative fixture), config validation, and the deterministic scripted worker. Frozen
ledger columns keep their original names (`baselineP95Ms`, `bestP95Ms`) and hold the spec's metric in its
unit; persisted p95 lessons are read unchanged, and lessons of other metrics carry `metric`.

To author another objective:

1. Add a seed artifact directory whose editable code lives under `src/` (the worker can only edit there).
2. Write an evaluator under `verification/<objective>/` that returns `VerificationReport`s for the suites
   the controller runs (`structural`, `smoke`, `correctness`, `performance`, `holdout`; `learned` only
   when it accepts regressions). It must check the snapshot hash against the artifact and its own hash
   against the frozen one, record evidence ids, and put the metric in `metrics[metric.key]` and the
   per-repetition values in `metrics[metric.repetitionsKey]`. Its hash must cover its code, reference and
   every fixed and held-out scenario, so an edit to any of them is evaluator drift (resume refuses, and
   `rebaseline` re-measures the seed and best under the new hash).
3. Add fixed scenarios and held-out scenarios, each naming the invariants it protects, and
   `resources/<objective>/features.json` mapping features to invariants and scenarios, plus a verification
   skill for the Pi worker. `features check --config <mission.json>` validates the map.
4. Define the `MissionSpec` in `src/objectives/<objective>.ts` (metric with `direction`, `requestDriven`
   and a `lessonMetric` id; `baseline`/`optimize`/`holdout` tasks; `validateConfig` naming the target field
   — `targetImprovement` for new objectives — and rejecting fields that do not apply; `repetitions`), and
   register it in `src/objectives/index.ts`.
5. Provide a scripted worker that drives the objective offline through the tool broker, and a test that
   runs `initialize()` -> `run()` to `succeeded` with a rejected and an accepted candidate and a passed
   holdout (see `test/mission-spec.test.ts`).

## Layout

- `demo/search-service/` seed service (frozen contract in `src/domain/contracts.ts`); `demo/text-kit/` bundle-size seed
- `verification/` independent reference model, fixed scenarios, workloads, runner, report schema, fixtures; `verification/bundle-size/` bundle evaluator, reference and scenarios
- `src/objectives/` MissionSpec registry and the `search-p95` and `bundle-size` objectives
- `src/` ledger, artifact store, recovery, controller, tool broker, Pi/scripted workers, memory, lesson policy, CLI
- `resources/` versioned feature map and verification skill; `resources/bundle-size/` for the bundle objective
- `test/` deterministic tests

## Live Pi mission (plan.md §5 acceptance gate)

`mission.live.example.json` is the example config with `"worker": "pi"` and the low-cost `google/gemini-3.1-flash-lite` model (mission `search-p95-live`, rotation every 2 cycles, bounded token budget). With `GOOGLE_API_KEY` in the environment:

```sh
node scripts/live-mission.ts --config mission.live.example.json [--runs-root DIR] [--crash-at snapshot_ready]
```

runs the demo sequence — `mission create`, `run` interrupted at the crash point, `resume` to completion, `export`, `live-gate` — and exits with the gate's code. The gate reads only the ledger (never worker prose) and requires: every `optimize-search` experiment authored by the `pi` worker, provider-reported token usage, a measured baseline, at least one non-seeded model candidate with passed smoke+correctness+performance reports, a launch recovered from a checkpoint, an episode retrieved from an earlier segment after a rotation, a passed holdout, and mission status `succeeded`. Commit or link `runs/<mission>/exports/{summary,live-gate}.{json,md}` as the evidence. Running the script against `mission.example.json` (scripted worker) is expected to exit 2 with `worker_is_pi`, `usage_reported` and `model_candidate_verified` failing.

## Configuration comparison and report

`node src/cli.ts compare --config mission.example.json [--repeats N]` runs the three memory configurations (durable only, +retrieval, +validated correction) from the same seed under one crash schedule and writes `comparison.{json,md}`. It honours `worker` and memory settings from the config: `"worker": "pi"` runs the Pi worker (and fails up front without the provider API key), and a `SUPERMEMORY_API_KEY` selects the hosted adapter for the memory-enabled configurations. Findings and limitations against `LONG_HORIZON_AGENT_PROMPT.md` are in `REPORT.md`.

## Scripted soak

`node scripts/soak.ts --config mission.example.json --out runs/soak-evidence --experiments 1000 --hours 4` runs successive scripted missions until either limit is reached. Use `--missions N` to cap the mission count, `--fault-every N` to inject a crash in every Nth mission, and `--max-runs N` to bound retries per mission. With no limits, it runs ten missions. Each mission exercises a crash and resume where scheduled, two worker experiments, and segment rotation. The runner uses local SQLite and memory rather than hosted services. It writes a sample after each single-cycle run with packet tokens, retrieval and recovery duration, ledger, session and artifact sizes; it appends to `samples.jsonl` immediately and, on completion, writes `samples.json` and `report.json` under the output directory. These runs measure repeated short missions, not one uninterrupted long mission or Pi session growth.

The runner enables retention by default; a config can override `retention.keepRecentCandidates`, `retention.keepRecentSegments`, and `retention.compactEventsAfter`. The controller retains the seed, accepted artifacts, active recovery inputs, and the last K distinct candidates; archives older closed Pi sessions as verified gzip files in `evidence/` before deleting the originals; and compresses older ledger events into indexed snapshots. Event pagination, idempotency, and live-gate evidence still include archived events. `workerInputTokens` in soak samples comes from mission budget usage; `packetTokens` estimates only the context packet, not the full model request. The scripted worker marks usage uncertain. The pinned Pi SDK exposes provider-reported response usage (including cache reads and writes), but no provider tokenizer for preflight packet construction, so packet sizing still uses a character estimate. The 10,000-episode memory benchmark in `REPORT.md` is synthetic local retrieval; hosted Supermemory has only been probed at 12 and 20 episodes.
