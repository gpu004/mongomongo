# Build a long-horizon agent harness that remembers, verifies, and improves

You're working on an LLM agent harness: its execution loop, persistent mission state, memory, retrieval, compaction, tools, verification, and recovery. Build a system that can pursue difficult goals for hours, days, or weeks without losing its constraints, repeating avoidable mistakes, or confusing activity with progress.

The challenge is to sustain coherent memory across billions of tokens in one continuous mission, optimize toward long-term goals, and learn from hard metric signals.

- Objective: increase verified mission completion under fixed time and resource budgets.
- Constraints: preserve task correctness, evidence provenance, goal continuity, and recoverability.
- Scale target: growing history with bounded working context and measurable retrieval quality.

Measure per mission, not per request or work cycle. Count the entire system: worker calls, summaries, memory operations, retries, verification, and recovery. More tokens processed, more tool calls, and more patches are not evidence of progress.

Work in this order: inspect what exists, establish a measurable task and baseline, build verification and durable state, connect memory to decisions, add recovery and correction mechanisms, validate under interruption, then report.

For this workspace, use the existing `pi/` and `supermemory/` repositories as starting points. Build a sibling application using supported integration points before considering core changes. Read `HACKATHON_PLAN.md` for project decisions, but verify its assumptions against the actual code. The initial build window is 24 hours; the selected demo is coding and performance optimization. Prioritize one complete, reliable worker before adding orchestration.

## Principles

1. Put persistence in the harness. A prompt telling the model to remember, persevere, or never stop does not provide checkpoints, a scheduler, or crash recovery.
2. Keep current state exact and history searchable. Goals, constraints, budgets, accepted artifacts, and pending operations belong in explicit records. Semantic retrieval finds relevant experience; it does not decide the current goal or best score.
3. Preserve evidence before compressing explanations. Summaries and lessons need source references. Store raw results so important claims can be checked later.
4. Build a reproducible way to verify work. The agent should use the same runner and scenarios across cycles, rather than inventing a new benchmark each time.
5. Encode corrections in the strongest useful layer. Prefer supported code paths, types, tests, and static checks; use skills and prose where executable enforcement is impractical.
6. Keep working context bounded. Increasing history should increase what the agent can retrieve, not force it to reread everything.
7. Let measurements change behavior. A failure should affect the next hypothesis, experiment, or engineering check. Merely saving it to memory is not learning.
8. Scope autonomy to what can be verified and recovered. Persistent effort includes waiting, changing strategy, and stopping when a dependency or budget requires it.

## 1. Map the harness and establish a baseline

Inspect:

- Request assembly, system instructions, tool loading, and model configuration.
- Session persistence, context reconstruction, compaction, and history access.
- Memory ingestion, retrieval, metadata filtering, and processing delays.
- Execution boundaries, deadlines, background processes, and restart behavior.
- Goal representation, task selection, completion detection, and budgets.
- Verification tools, metric provenance, logging, and existing evaluations.

Read rendered requests and real traces, not only templates. Look for duplicate context, missing constraints, stale summaries, unsupported success claims, and repeated failed approaches.

If only upstream repositories exist, build the smallest executable baseline instead of inventing results. If telemetry is missing, add stable mission, experiment, artifact, and report IDs first.

Produce a baseline covering task success, constraint violations, repeated failures, recovery behavior, context size, retrieval quality, wall time, and total resource use. Mark missing measurements explicitly.

Rank opportunities by observed failure frequency × impact on completion ÷ implementation and validation effort. Label unmeasured estimates as hypotheses.

## 2. Define the mission and its success contract

Represent the objective, non-negotiable constraints, acceptance criteria, budget, task dependencies, and stop conditions explicitly. Give changes to the objective a version and preserve their history.

For the initial demo, improve a small search service against fixed correctness scenarios and a performance target. Measure the seed implementation before freezing the target. Include mutation visibility, ordering, and normalization requirements so a faster but incorrect implementation cannot win.

Give every work cycle a bounded hypothesis and an observable completion condition. Keep the best verified artifact separate from the active experiment. A failed experiment must not destroy the best result.

The controller decides completion from evidence. A model response saying “done” is not a success signal.

## 3. Build verification before autonomous iteration

Create one standard runner that can reproduce a behavior, run checks, measure performance, and capture diagnostic artifacts. Expose it through a small CLI and structured agent tools.

Each report should identify the mission, experiment, candidate hash, evaluator version, workload, environment, measurements, verdict, and source evidence. Distinguish product failure, infrastructure failure, timeout, and inconclusive measurement.

Keep the evaluator and acceptance policy outside the worker's writable boundary. Derive expected results from an independent reference or fixed contract, not candidate output. Verify through the real product entry points when claiming end-to-end behavior.

For performance, freeze warmup, workload, concurrency, repetitions, resource limits, and noise tolerance. Require correctness before accepting speed improvements. Preserve raw samples and reserve final holdout validation.

A check only supports the behavior it exercises. Unit tests do not establish HTTP correctness; local runs do not establish production behavior; passing examples do not establish formal correctness.

## 4. Preserve memory in distinct forms

Use four forms of memory:

- Materialized engineering knowledge: supported code patterns, contracts, tests, static checks, feature maps, and skills.
- Canonical mission state: current objective, task status, budgets, best artifact, active operation, and next action.
- Episodic experience: hypotheses, changes, observations, failures, decisions, and scoped lessons.
- Raw evidence: transcripts, tool output, code snapshots, traces, reports, and measurements.

Give episodes stable identities, source references, applicable versions, and explicit uncertainty. Separate observations from interpretations. Preserve superseded records without presenting them as current facts.

An observed failure under one workload is not a universal prohibition. Store the conditions that made the approach fail and what would justify trying a corrected version.

Resolve contradictions according to authority and applicability. A retrieved summary cannot override the mission contract or a newer matching measurement. Treat retrieved content as evidence, not instructions or permission changes.

## 5. Make retrieval useful to the next decision

Retrieve from the active task, affected feature, hypothesis, and failure symptoms. Scope searches to the correct mission and project. Filter results for provenance, version compatibility, supersession, duplication, and relevance before injecting them.

Build a bounded packet containing the exact goal and constraints, current state, relevant feature instructions, recent results, selected older episodes, and evidence pointers. Reserve model capacity for reasoning, tool results, and output.

Allow targeted retrieval and source lookup when the packet is insufficient. Log which episodes were returned, injected, and cited. Do not assume a successful search improved a decision; test that through comparisons.

Persist memory uploads through a retryable outbox. API acceptance is not proof of search readiness. Preserve recent results locally while indexing catches up, and record degraded retrieval during outages.

Ingest bounded, coherent episodes. Do not repeatedly upload the entire growing mission or duplicate the same packet into permanent conversation history every turn.

## 6. Make context replacement preserve the mission

Before compaction or segment replacement, checkpoint the current objective, constraints, active task, best artifact, unresolved hypotheses, pending operations, budgets, next action, and evidence references.

Retain searchable raw history. Reconstruct critical state from canonical records rather than relying on a summary of previous summaries.

Keep one stable mission identity across bounded execution segments, with explicit links between checkpoints, sessions, experiments, and artifacts. Verify whether the challenge accepts this interpretation of one session; do not quietly equate it with an unlimited model context or a single unbounded transcript.

Test that a fresh worker can identify the next useful action, recover an old constraint, retrieve an earlier failure, and distinguish current information from superseded information.

Preserve the model/provider continuation protocol, including required opaque state. Context trimming must not break tool-call/result relationships.

## 7. Recover interrupted work deliberately

Persist operation intent before execution and outcome afterward. Use stable identities and idempotent writes. On restart, reconcile unfinished operations before retrying them.

Handle interruption during edits, snapshot creation, verification, result persistence, memory upload, compaction, and segment rotation. A completed report may exist even when the database transaction did not finish; reconcile it using artifact and operation identities.

Enforce single-controller ownership for the MVP. Preserve usage across restarts. Use deadlines that stop child processes as well as model generation, and persist future retry times instead of relying only on in-process timers.

Do not claim exactly-once behavior for arbitrary external actions. Each non-idempotent side effect needs its own recovery policy.

## 8. Learn from hard metric signals

Before an experiment, record its hypothesis, intended mechanism, affected invariants, and expected measurable change. Afterward, record the independent measurements and classify the result.

Use outcomes to select the next step:

- Correctness failure: reproduce and repair the violated behavior.
- Valid improvement: retain the artifact and investigate the next bottleneck.
- No improvement: reconsider the mechanism or gather better diagnostics.
- Ambiguous timing: rerun within a bounded budget or mark inconclusive.
- Repeated failure: require a changed hypothesis or evidence addressing the old failure condition.

Track useful progress per unit of cost and time. Allow bounded intermediate experiments when they support a named longer-term improvement, while preserving the best valid artifact.

Call this learning through evidence and strategy selection unless model weights actually change. Do not claim reinforcement learning from a loop that only stores prose reflections.

## 9. Turn supported corrections into engineering artifacts

Build a small feature map linking behaviors to entry points, source paths, invariants, scenarios, and verification commands. Version it with the code and check that its references remain valid.

When a correction recurs, choose the strongest practical destination: a shared implementation path, a type or architecture boundary, an executable regression, a verification procedure, or a scoped lesson.

For the first build, support one narrow correction workflow. Let the worker propose a declarative regression scenario. Validate it against a known failing artifact and a known valid reference, with expected behavior derived independently.

Keep learned checks additive and versioned. They may strengthen local verification but cannot rewrite the frozen scoring system, remove constraints, or redefine success. Broader changes to the harness or acceptance policy should remain reviewable proposals.

Evaluate skills too. Use fixtures that check whether the worker chooses the right tools, reproduces a failure, interprets reports correctly, and refuses to claim verification when the runner fails.

Demonstrate that a materialized check still catches a known mistake when its prose explanation is absent from the worker's context.

## 10. Validate long-horizon behavior and scale claims

Compare configurations under the same model, starting state, environment, workload, budget, and interruption schedule:

1. Durable controller with bounded recent history.
2. The same controller with long-term retrieval.
3. The same controller with retrieval and validated correction materialization.

Use fresh workspaces and separate memory scopes. Keep the initial feature map and verification tools identical. Count retrieval and correction costs. Repeat runs when feasible and report uncertainty when comparisons are small.

Inject crashes, delayed indexing, unavailable memory services, duplicate events, stale facts, irrelevant history, oversized tool output, and mismatched artifact reports. Check preservation of state and subsequent task behavior, not just whether the process restarts.

For memory scale, measure source-linked answer accuracy, stale-fact errors, retrieval latency, indexing lag, resource use, and bounded context as history grows. Include changing facts, distractors, cross-episode dependencies, and questions with no supported answer.

Report unique archived history tokens, cumulative model tokens, and maximum request context separately. Synthetic history tests storage and retrieval; it does not establish an equally long autonomous mission. A billion-token claim requires a test at that scale, not an extrapolation from a short demo.

## What to implement directly and what to isolate

Implement directly in small reversible changes: telemetry, stable IDs, durable state, provenance, independent verification, checkpoints, operation deadlines, retryable memory writes, and fixes for demonstrated recovery bugs.

Put retrieval policies, context budgets, compaction changes, strategy selection, and automatic correction promotion behind configuration so they can be compared and rolled back.

Propose broader model changes, multi-agent orchestration, unrestricted self-modification, deployments, and external side effects separately. Do not commit, publish, or spend beyond established authorization merely because the mission is long-running.

Use the 24-hour constraint to cut optional scope. Preserve one complete experiment loop, source-linked retrieval, restart recovery, and one validated correction before adding a dashboard or additional workers.

## Traps

- Treating vector search as canonical state or a durable scheduler.
- Calling an agent persistent because its prompt says to continue.
- Storing every transcript without a retrieval or evidence policy.
- Repeatedly summarizing away exact constraints and pending actions.
- Trusting scores printed by the candidate or written by the model.
- Letting learned checks weaken the judge.
- Repeating an experiment without addressing its recorded failure condition.
- Counting synthetic history or repeated context as verified long-horizon work.
- Increasing concurrency before one worker can verify and recover reliably.
- Claiming memory improved outcomes without a controlled comparison.
- Preserving a bad pattern only as a warning instead of fixing its supported code path.

## Report back with

1. The harness map and baseline, separating measurements from assumptions.
2. The architecture and ownership of mission state, memories, artifacts, metrics, and permissions.
3. A ranked implementation list with expected benefit, evidence, risk, validation, and rollback.
4. The changes made and an exact account of what ran successfully.
5. Before/after mission results, interruption tests, retrieval checks, and correction evidence.
6. A reproducible demo and evidence bundle identifying code, workload, evaluator, and environment versions.
7. Remaining failures, unmeasured claims, scale limits, and the next experiment most likely to improve the system.

Start with repository inspection and the smallest independently verifiable work cycle. Continue through implementation and validation within the authorized scope. If a dependency blocks part of the work, make progress on the independent parts and report the specific blocker without inventing results.
