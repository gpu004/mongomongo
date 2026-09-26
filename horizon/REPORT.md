# Horizon: report against LONG_HORIZON_AGENT_PROMPT.md

Everything below distinguishes **measured** (a command was run and its output is quoted or reproducible from the runs directory) from **assumed** (reasoned from code, not measured). Numbers are from one machine (subprocess isolation unless stated) and are noisy; treat sub-10% p95 differences as inconclusive.

## 1. Harness map and baseline

Inspected repositories: `pi/` (Pi coding agent SDK) and `supermemory/` (memory API client), plus this repository. Horizon (`horizon/`) is built on their public integration points only:

| Concern | Where it lives | How Horizon uses it | Measured? |
| --- | --- | --- | --- |
| Request assembly / system prompt / tools | `pi` SDK `createAgentSession`; Horizon `src/pi-worker.ts`, `src/context-packet.ts`, `src/tool-broker.ts` | Built-in tools disabled; broker tools only; packet injected as the segment's user turn | Packet size measured (`packet.built` events). Live model turns **not run** (no LLM key). |
| Session persistence / compaction / history | Pi JSONL sessions under `runs/<mission>/sessions/`; Horizon segments in the ledger | Segment rotation checkpoints canonical state first, then opens a new Pi session with a pointer to the previous one | Rotation measured in tests and the comparison run. Pi compaction **assumed** from SDK code. |
| Memory ingestion / retrieval / delays | `src/memory-adapter.ts`, `src/memory-outbox.ts` | Outbox with stable `customId`; "accepted" vs "document ready" vs "memory ready" distinguished; local adapter when `SUPERMEMORY_API_KEY` absent | Local adapter measured up to 100k episodes; hosted Supermemory measured with `scripts/supermemory-probe.ts` (12 and 20 episodes, §5.8). |
| Execution boundary / restart | `verification/runner.ts` (subprocess or Docker), `src/recovery.ts`, `src/ledger.ts` (SQLite WAL, `synchronous=FULL`) | Every controller launch reconciles intent/outcome before acting | Measured: 6 recovery tests, comparison crash schedule, Docker run. |
| Goals / tasks / completion / budgets | `src/mission-contract.ts`, `src/controller.ts` | Contract hash frozen at `mission create`; drift refused on resume; controller decides completion from verified reports only | Measured. |
| Verification / metric provenance | `verification/` (reference model, scenarios, workloads, runner, report validation, structural checks) | Evaluator hash covers the whole `verification/` tree; candidate is never asked for a score | Measured. |

Seed baseline (mission.example.json workload, subprocess): p95 ≈ 1.63–1.83 ms across runs on this VM; Docker: 2.57 ms. Wall time for one complete scripted mission (baseline, 2–3 experiments, holdout): 9–12 s. Token counts are **estimated** (`usageUncertain` flag) because the scripted worker has no provider usage report.

Baseline measurements the prompt asks for that are **not** available: cost in currency, live-model token usage (no `ANTHROPIC_API_KEY`), hosted-memory behaviour beyond 20 episodes.

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
| 8 | Wall-clock budget accrued at every checkpoint (`accrueWall`) | A crash no longer resets the time budget | `fault-injection.test.ts`: `spentWallMs > 0` after a crash at `snapshot_ready` | none | Test | revert |
| 9 | Failed-report reuse for identical artifacts (smoke/correctness/structural) | Re-proposing a known-bad artifact costs no verifier run | `compare --repeats 3`: every durable-only repeat of stale-cache reused the committed report | Reuse only when artifact, evaluator and environment hashes all match | Test | revert |
| 10 | Timing policy: ambiguous → one bounded best/candidate remeasure → accept/reject/inconclusive; baseline repetition-spread warning | Fewer false accepts near the noise floor | `policies.test.ts`; compare warned in 7/9 runs that margin 0.05 < measured spread (3–16%) | One extra perf run per ambiguous candidate | Tests | revert |
| 11 | Claim audit + oversized-output bound | Worker prose cannot silently disagree with the verifier or flood packets | `claim.audited` events; 200 kB worker prose truncated to ≤800 chars with full text in evidence | Regex coverage of claims | Tests | revert |
| 12 | Feature-map reference validation in `features check` | Map/scenario drift detected | Found 8 real drift issues (3 scenario invariant IDs not in the map); fixed in the scenario JSON | none | Test | revert |
| 13 | Retrieval: FTS5 ledger index, IDF re-rank, local merge of anything the remote search missed | Correct answers while indexing lags and when remote recall misses | Memory bench 100k episodes 200/200; hosted probe 32/32 during indexing | Local search cost (p95 167 ms at 100k) | Bench + tests | revert |
| 14 | Hosted search fix: `containerTags: [tag]` | Hosted search returned **0 results** with singular `containerTag` + `includeFullDocs` | First hosted probe: 0 remote hits; after fix 17/20 answers served remotely | none | Probe | revert |
| 15 | Skill eval (`horizon skill-eval`) | Grades worker behaviour on fixed fixtures, not prose | Scripted worker 9/10 (does not read failing evidence) | Fixtures are few | Test | n/a |
| 16 | Incremental index reconciliation in the scripted worker's correct candidate (`src/scripted-worker.ts`) | Removes the full-rebuild latency spike that dominated p95 under a 5% mutation ratio | Before: 3/3 diagnostic missions on this VM missed the target (2.72→2.51 ms, 2.71→3.07 ms, 2.50→2.52 ms) and `recovery.test.ts` failed 3/6; after: 2.58→0.89 ms, 3/3 paired repetitions, all tests pass | none (candidate code only; the evaluator is unchanged) | Diagnostic missions + full suite | Revert the constant |

Not done, kept as separate proposals: multi-worker orchestration, model changes, unrestricted self-modification, deployments.

## 4. Changes made and exactly what ran

Code: everything under `horizon/` (see PR https://github.com/gpu004/mongomongo/pull/2). Commands run successfully on Node v24.21.0:

```
npm run check                      # tsc --noEmit: clean
npm test                           # 43 tests, 43 pass (test helpers force the local memory adapter so a key in env never routes tests to the hosted service)
node scripts/smoke-runner.ts       # seed pass/pass/pass; stale-cache smoke pass, correctness fail, perf fail; bypass structural fail
node src/cli.ts mission create --config mission.example.json && node src/cli.ts run --mission search-p95-demo   # succeeded
(Docker) mission search-p95-docker status=succeeded, observed container
node src/cli.ts compare --config mission.example.json --runs-root /tmp/hz-cmp   # §5
node src/cli.ts compare --config mission.example.json --repeats 3   # §5.5
node src/cli.ts features check                                      # 0 violations, 0 feature-map issues (after fix)
node src/cli.ts skill-eval                                          # 9/10
node src/cli.ts memory-bench --episodes 1000,10000,100000           # §5.7
node scripts/supermemory-probe.ts --episodes 12|20                  # §5.8 (hosted, SUPERMEMORY_API_KEY)
```

Not run: Pi worker against a live model (no valid provider API key was available — the plan.md §5 live-mission gate is therefore still open). The gate itself is now mechanised: `mission.live.example.json` selects `"worker": "pi"`, `scripts/live-mission.ts` runs create → interrupted run → resume → export → `live-gate`, and `horizon live-gate` verifies the run from the ledger (Pi-authored experiments, provider-reported usage, measured baseline, independently verified model candidate, checkpoint recovery, cross-segment retrieval after rotation, holdout, `succeeded`). Every scripted run in this repo fails that gate by construction (`worker_is_pi`, `usage_reported`, `model_candidate_verified`), so no scripted artifact can be mistaken for live evidence. Also not run: any workload larger than 5000 documents or 3 repetitions.

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

Re-run after change 16 (same seed `b6502a00934a`, evaluator `7cae47a2f268`, same schedule, one run each):

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

### 5.5 Configuration comparison, `--repeats 3` (evaluator `6bad2f6d649a`, same crash schedule)

| configuration | runs reaching 30% target | experiments per run | repeated stale-cache failures | wasted "identical to parent" cycles | max packet tokens | memory ops |
| --- | --- | --- | --- | --- | --- | --- |
| durable-only | 1/3 | 3, 8, 8 | 1, 1, 1 (correctness report reused, not rerun) | 0, 4, 5 (budget exhausted) | 1556 | 0 |
| durable+retrieval | 0/3 | 3, 3, 3 | 0 | 0 | 2240 | 7 |
| durable+retrieval+correction | 2/3 | 2, 3, 2 | 0 | 0 | 2244 | 6–7 |

Reading: the memory effect is consistent — without retrieval the worker repeats the rejected idea every run and, after rotation, burns the remaining budget on no-op cycles; with retrieval it never repeats and stops cleanly. Target attainment is **not** a memory effect: every miss is the same correct candidate measuring 1.29–1.81 ms against a ~1.25 ms target, and the new spread check reported baseline repetition spread 3–16% versus a 5% margin. Three runs is suggestive, not significant.

### 5.6 Fault injection (`test/fault-injection.test.ts`, `test/policies.test.ts`)
Identical failing artifact twice → second correctness report reused, same failure signature; overclaiming worker → `claim.audited supported=false`, disagreement recorded in the episode; 200 kB worker prose → bounded, full text in evidence; crash → wall time persisted; memory outage for a whole run → packets `degraded`, local index still supplies history, outbox delivers after recovery; delayed indexing → pending episodes merged (and a foreign hit with the same ID cannot hide them); supersession resolved to the newest version before it is indexed; fresh worker after restart does not repeat the rejected approach.

### 5.7 Memory scale (synthetic history, `horizon memory-bench`; 25% of experiments revised, 5% twice; foreign distractors; ~5% of the tail unindexed)

| episodes | archived tokens | storage | outcome correct | stale / foreign | correct while unindexed | dependency | no-answer abstained | outage correct | retrieval p50/p95 | max packet tokens |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1,000 | 0.15M | 7.7 MB | 200/200 | 0 / 0 | 52/52 | 100/100 | 100/100 | 50/50 | 0.6 / 2.2 ms | 926 |
| 10,000 | 1.5M | 43 MB | 200/200 | 0 / 0 | 57/57 | 100/100 | 100/100 | 50/50 | 2.4 / 15.6 ms | 898 |
| 100,000 | 15.3M | 358 MB | 200/200 | 0 / 0 | 49/49 | 100/100 | 100/100 | 50/50 | 18 / 167 ms | 920 |

Max request context stays flat (~0.9k tokens of retrieved history) while archived history grows 100×. This benchmark found one real bug before it was fixed: a foreign-mission remote hit sharing an episode ID suppressed the in-scope pending episode (2 wrong answers at 1k). 15M archived tokens is the largest scale tested; **no billion-token claim**.

### 5.8 Hosted Supermemory (`scripts/supermemory-probe.ts`, fresh container per run)

| run | episodes | indexing lag p50 / p95 / max | correct before indexing | correct with unindexed v2 supersessions | correct after indexing | foreign injected | retrieval p50/p95 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 12 | 5.9 / 9.7 / 9.7 s | 12/12 (7 remote, 5 local pending) | 12/12 | 12/12 (all remote) | 0 | 362 / 755 ms |
| 2 | 20 | 5.3 / 157 / 157 s | 20/20 (11 remote, 9 local pending) | 20/20 | 20/20 (17 remote, 3 local) | 0 | 349 / 622 ms |

An earlier run before the `containerTags` fix got **0 remote hits** and 6/12 correct after supersession, which is why both fixes (13, 14 in §3) exist. Add latency ≈ 1 s per document (serial). Indexing lag has a long tail (157 s and 201 s outliers seen), so treating acceptance ≠ readiness and merging local pending episodes is necessary, not theoretical.

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

- **Unmeasured**: live LLM worker behaviour (the whole "model repeats mistakes" story is exercised only through the scripted worker; no `ANTHROPIC_API_KEY`); hosted Supermemory beyond 20 episodes; `compare` against the hosted adapter (it uses the local adapter); token cost (estimated only). Largest tested history: 100k episodes / 15.3M archived tokens (synthetic, local). No billion-token or multi-hour claim is made.
- **Skill eval**: the scripted worker does not read the failing assertion evidence before moving on (9/10); a live worker should be graded with `horizon skill-eval --config <pi mission>`.
- **Addressed weakness**: the 30% p95 target was previously near the noise floor because the scripted candidate's full index rebuild landed in the top 5% of samples (one of three comparison runs missed it with a correct, faster candidate). That is fixed in the candidate (change 16); the residual risk is shared-hardware noise, which the baseline spread warning (change 10) exposes: lengthen `measuredRequests`/`repetitions` when it fires.
- **Isolation**: `subprocess` mode is cooperative; only `container` mode enforces limits, and it was run manually, not in tests.
- **Learning**: this is evidence-based strategy selection with materialized checks, not reinforcement learning; no weights change.
- **Next experiment**: run `horizon compare --repeats 5` with the Pi worker on a real model and a seeded distractor set (irrelevant and stale episodes injected into the memory scope) to measure stale-fact errors and retrieval precision per mission — the harness records `filteredOut` reasons and injected IDs per packet already, so only the distractor generator and a credential are missing.
