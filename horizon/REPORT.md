# Horizon: report against LONG_HORIZON_AGENT_PROMPT.md

Everything below distinguishes **measured** (a command was run and its output is quoted or reproducible from the runs directory) from **assumed** (reasoned from code, not measured). Numbers are from one machine (subprocess isolation unless stated) and are noisy; treat sub-10% p95 differences as inconclusive.

## 1. Harness map and baseline

Inspected repositories: `pi/` (Pi coding agent SDK) and `supermemory/` (memory API client), plus this repository. Horizon (`horizon/`) is built on their public integration points only:

| Concern | Where it lives | How Horizon uses it | Measured? |
| --- | --- | --- | --- |
| Request assembly / system prompt / tools | `pi` SDK `createAgentSession`; Horizon `src/pi-worker.ts`, `src/context-packet.ts`, `src/tool-broker.ts` | Built-in tools disabled; broker tools only; packet injected as the segment's user turn | Packet size measured (`packet.built` events). Live model turns **not run** (no LLM key). |
| Session persistence / compaction / history | Pi JSONL sessions under `runs/<mission>/sessions/`; Horizon segments in the ledger | Segment rotation checkpoints canonical state first, then opens a new Pi session with a pointer to the previous one | Rotation measured in tests and the comparison run. Pi compaction **assumed** from SDK code. |
| Memory ingestion / retrieval / delays | `src/memory-adapter.ts`, `src/memory-outbox.ts` | Outbox with stable `customId`; "accepted" vs "document ready" vs "memory ready" distinguished; local adapter when `SUPERMEMORY_API_KEY` absent | Local adapter measured. Hosted Supermemory indexing lag **not measured** (no key). |
| Execution boundary / restart | `verification/runner.ts` (subprocess or Docker), `src/recovery.ts`, `src/ledger.ts` (SQLite WAL, `synchronous=FULL`) | Every controller launch reconciles intent/outcome before acting | Measured: 6 recovery tests, comparison crash schedule, Docker run. |
| Goals / tasks / completion / budgets | `src/mission-contract.ts`, `src/controller.ts` | Contract hash frozen at `mission create`; drift refused on resume; controller decides completion from verified reports only | Measured. |
| Verification / metric provenance | `verification/` (reference model, scenarios, workloads, runner, report validation, structural checks) | Evaluator hash covers the whole `verification/` tree; candidate is never asked for a score | Measured. |

Seed baseline (mission.example.json workload, subprocess): p95 ≈ 1.63–1.83 ms across runs on this VM; Docker: 2.57 ms. Wall time for one complete scripted mission (baseline, 2–3 experiments, holdout): 9–12 s. Token counts are **estimated** (`usageUncertain` flag) because the scripted worker has no provider usage report.

Baseline measurements the prompt asks for that are **not** available: cost in currency, hosted-memory indexing lag, retrieval precision against a labelled set larger than the 4-fixture memory-scope test.

## 2. Architecture and ownership

- **Canonical mission state**: SQLite ledger (`runs/<mission>/ledger.sqlite`), written only by the controller holding `controller.lock`. Missions, tasks, experiments, artifacts, verifications, episodes, lessons, learned scenarios, checkpoints, segments, events, outbox.
- **Materialized engineering knowledge**: `resources/features.json` + `resources/skills/*/SKILL.md` (versioned, read-only to the worker) and learned scenarios (additive, versioned, appended to the `learned` suite only after fixture validation).
- **Episodic experience**: episodes rendered from ledger rows (`renderEpisode`), uploaded via the outbox to the memory adapter under `containerTag = horizon-<mission>`. Superseded episodes are kept but filtered from retrieval.
- **Raw evidence**: `runs/<mission>/evidence/` and `reports/` on disk; only IDs travel into memory.
- **Artifacts**: content-addressed snapshots in `runs/<mission>/artifacts/<hash>/`, immutable, read-only mounted into the sandbox.
- **Permissions**: the worker can edit `candidate/src/**` and call broker tools; the evaluator, acceptance policy, contract and feature map are outside its writable boundary. The structural suite fails candidates that import around `DocumentService`.

## 3. Ranked implementation list (what was done, in priority order)

| # | Change | Expected benefit | Evidence it mattered | Risk | Validation | Rollback |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Independent verifier + frozen identities (`verification/`) | Removes trust in candidate output | `report-validation.test.ts` (14 rejections), `scripts/smoke-runner.ts` matrix: stale-cache and bypass fixtures fail, seed passes | Evaluator bugs become mission bugs | Fixture matrix | Not applicable (foundation) |
| 2 | Durable ledger + recovery + single controller lock | Restart without losing intent | `recovery.test.ts` 6/6; comparison schedule crash at `snapshot_ready` recovers by reusing the snapshot | Extra fsync cost | Tests | Delete `runs/` |
| 3 | Bounded context packet (8k, pinned never truncated) | Constant working context as history grows | `context-budget.test.ts`; max packet tokens 1555–2232 across all configurations | Trimming may drop useful recent text | Tests + `packet.built` events | Raise budget |
| 4 | Scoped retrieval via outbox + local fallback | Older segments stay reachable when recent history is bounded | Comparison: `durable-only` repeated the stale-cache failure once (3 experiments); `durable+retrieval` did not (2 experiments) | Retrieval cost (6–7 memory ops) | `memory-scope.test.ts` | `memory.enabled=false` |
| 5 | Validated correction materialization (`src/lesson-policy.ts`) | A learned check catches the known mistake without prose | `lesson-policy.test.ts`; learned scenario `learned-update-then-repeat-search` fails the stale-cache fixture and passes the seed | A bad check could block valid work; mitigated by fixture validation and additivity | Tests | Set `materializeCorrections=false`; scenarios are versioned |
| 6 | Docker isolation | Real resource limits | Docker mission succeeded with `Isolation: observed container` | Docker availability | Manual run | `isolation=subprocess` (reported as weaker) |
| 7 | Comparison harness (`horizon compare`) | Measures configurations per mission, not per request | This report §5 | Sample size | Repeats flag | none |
| 8 | Incremental index reconciliation in the scripted worker's correct candidate (`src/scripted-worker.ts`) | Removes the full-rebuild latency spike that dominated p95 under a 5% mutation ratio | Before: 3/3 diagnostic missions on this VM missed the target (2.72→2.51 ms, 2.71→3.07 ms, 2.50→2.52 ms) and `recovery.test.ts` failed 3/6; after: 2.58→0.89 ms, 3/3 paired repetitions, all tests pass | none (candidate code only; the evaluator is unchanged) | Diagnostic missions + full suite | Revert the constant |
| 9 | Ambiguous-timing verdict (`decideAcceptance`) | A candidate inside the ±margin band of the best is `inconclusive`, not `rejected`, so noise is not recorded as a failed hypothesis | `acceptance-policy.test.ts`; `compare` reports an `inconclusive` column | Fewer hard rejections for genuinely neutral changes | Tests | Restore the two-way verdict |
| 10 | Baseline noise floor recorded before the target is frozen | The `mission.baseline` event carries `repetitionP95Ms`, `noiseFloor` ((max−min)/median) and `targetWithinNoise`; the controller warns when the target is inside the spread | Measured 16.4% spread on this VM for the example workload | none | `relativeSpread` test | none |

Not done, kept as separate proposals: multi-worker orchestration, model changes, unrestricted self-modification, deployments.

## 4. Changes made and exactly what ran

Code: everything under `horizon/` (see PR https://github.com/gpu004/mongomongo/pull/2). Commands run successfully on Node v24.21.0:

```
npm run check                      # tsc --noEmit: clean
npm test                           # 37 tests, 37 pass (31 originally; +6 acceptance-policy tests)
node scripts/smoke-runner.ts       # seed pass/pass/pass; stale-cache smoke pass, correctness fail, perf fail; bypass structural fail
node src/cli.ts mission create --config mission.example.json && node src/cli.ts run --mission search-p95-demo   # succeeded
(Docker) mission search-p95-docker status=succeeded, observed container
node src/cli.ts compare --config mission.example.json --runs-root /tmp/hz-cmp   # §5
```

Not run: Pi worker against a live model; hosted Supermemory; any workload larger than 5000 documents or 3 repetitions.

## 5. Results

### Before/after (single mission, subprocess)
Original run: baseline p95 1.83 ms → accepted candidate 1.25 ms (3/3 paired repetitions improved, holdout passed). Docker: 2.57 ms → 1.68 ms.

After the incremental-index change (second VM, slower baseline): baseline 1.90 ms (repetition spread 16.4%) → accepted candidate 0.75 ms (−60%, 3/3 paired repetitions improved, holdout passed, 2 experiments, 11 s wall). The root cause of the earlier near-miss was measured, not assumed: with a 5% mutation ratio roughly every twentieth search followed a write and paid a full O(n) re-normalization, so the 95th percentile *was* the rebuild cost. Reconciling only changed documents removes that spike; the evaluator, workload and contract are unchanged.

### Configuration comparison (`horizon compare`, one run each, identical seed `b6502a00934a`, evaluator `7cae47a2f268`, schedule: crash at `snapshot_ready`, then resume; segment rotation every cycle so that "recent history" is genuinely bounded)

| configuration | status | target | experiments | rejected | repeated failures | crashes/recoveries | retrieved | max packet tokens | memory ops | materialized checks |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| durable-only | succeeded | reached | 3 | 2 | **1** | 1/2 | 0 | 1555 | 0 | 0 |
| durable+retrieval | succeeded | reached | 2 | 1 | 0 | 1/2 | 1 | 1886 | 6 | 0 |
| durable+retrieval+correction | blocked | missed | 3 | 1 | 0 | 1/2 | 3 | 2232 | 7 | 1 |

Reading: with bounded recent history alone, after the segment rotated the worker re-tried the already-rejected stale-cache idea (one wasted experiment). Retrieval brought the older episode back and avoided the repeat. The third configuration's "blocked" was a **timing miss, not a correctness or memory failure**: its accepted candidate measured 1.33 ms against a required 1.14 ms (only 2/3 repetitions improved) — the 30% target was close to the noise floor of this workload on this VM. The scripted worker is deterministic, so the experiment-count difference is real but small; the honest claim is "retrieval prevents the one scripted repeat", not a general effect size.

Re-run after changes 8–10 (same seed `b6502a00934a`, evaluator `7cae47a2f268`, same schedule, one run each):

| configuration | status | target | baseline p95 | best p95 | experiments | rejected | inconclusive | repeated failures | crashes/recoveries | retrieved | max packet tokens | memory ops | materialized checks |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| durable-only | succeeded | reached | 1.819ms | 0.732ms | 3 | 2 | 0 | **1** | 1/2 | 0 | 1555 | 0 | 0 |
| durable+retrieval | succeeded | reached | 2.009ms | 0.921ms | 2 | 1 | 0 | 0 | 1/2 | 1 | 1887 | 6 | 0 |
| durable+retrieval+correction | succeeded | reached | 1.924ms | 0.727ms | 2 | 1 | 0 | 0 | 1/2 | 1 | 1892 | 6 | 1 |

All three configurations now reach the target; the retrieval effect (one avoided repeat) is unchanged.

### Interruption tests (all pass, `test/recovery.test.ts`)
Crash during edits → experiment interrupted, workspace restored; crash after snapshot → same snapshot evaluated; crash between report file and ledger commit → report reconciled from disk, not rerun; checkpoints/segments committed; idempotent rerun under lock; frozen-identity drift refused.

### Retrieval checks (`test/memory-scope.test.ts`)
Cross-mission and cross-contract episodes filtered; superseded and evidence-less episodes filtered; outbox acceptance ≠ readiness; outage falls back to the local cache and the packet is marked degraded; rendered episodes carry IDs only.

### Correction evidence
Correctness failure → lesson (observed) → worker proposal → `validateAgainstFixtures`: fails stale-cache fixture, passes seed, neither infra error → materialized as versioned learned scenario, run in the `learned` suite on every later candidate.

## 6. Reproducible demo and evidence bundle

```
cd horizon && npm install
node src/cli.ts doctor
node src/cli.ts mission create --config mission.example.json
node src/cli.ts run --mission search-p95-demo --crash-at snapshot_ready   # exits 3
node src/cli.ts resume --mission search-p95-demo
node src/cli.ts export --mission search-p95-demo                          # exports/summary.{json,md}
node src/cli.ts compare --config mission.example.json --repeats 3         # comparison.{json,md}
```

Every report under `runs/<mission>/reports/` carries `missionId`, `experimentId`, `artifactHash`, `evaluatorHash`, `workloadHash`, `environmentHash`, `contractHash`, raw samples path and evidence IDs. `doctor` prints the evaluator and environment hashes for the current checkout.

## 7. Remaining failures, unmeasured claims, limits, next experiment

- **Unmeasured**: live LLM worker behaviour (the whole "model repeats mistakes" story is exercised only through the scripted worker); hosted Supermemory indexing lag and retrieval latency; any history longer than ~10 episodes; token cost (estimated only). No billion-token or multi-hour claim is made.
- **Addressed weakness**: the 30% p95 target was previously near the noise floor because the scripted candidate's full index rebuild landed in the top 5% of samples. That is fixed in the candidate, the baseline now records its own spread, and near-neutral timings are classified `inconclusive` instead of `rejected`. The residual risk is still shared-hardware noise: lengthen `measuredRequests`/`repetitions` when the baseline warning fires.
- **Isolation**: `subprocess` mode is cooperative; only `container` mode enforces limits, and it was run manually, not in tests.
- **Learning**: this is evidence-based strategy selection with materialized checks, not reinforcement learning; no weights change.
- **Next experiment**: run `horizon compare --repeats 5` with the Pi worker on a real model and a seeded distractor set (irrelevant and stale episodes injected into the memory scope) to measure stale-fact errors and retrieval precision per mission — the harness records `filteredOut` reasons and injected IDs per packet already, so only the distractor generator and a credential are missing.
