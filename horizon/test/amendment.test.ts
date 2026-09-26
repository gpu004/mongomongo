import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { computeEvaluatorHash, environmentFingerprint } from "../verification/runner.ts";
import {
  type ControllerOptions,
  MissionController,
  type MissionManifest,
  SimulatedCrash,
} from "../src/controller.ts";
import { LocalMemoryAdapter } from "../src/memory-adapter.ts";
import {
  contractHash,
  diffParameters,
  legacyContractHash,
  objectiveOf,
  OPERATING_FIELDS,
  planAmendment,
} from "../src/mission-contract.ts";
import { missionPaths, writeJsonAtomic } from "../src/mission-paths.ts";
import { classifyEnvironmentDrift } from "../src/recovery.ts";
import { controllerFor, tempRunsRoot, testConfig } from "./helpers.ts";

const HOST = { node: process.version, platform: process.platform, arch: process.arch };

function readManifest(missionId: string, runs: string): MissionManifest {
  return JSON.parse(
    readFileSync(missionPaths(missionId, runs).manifest, "utf8"),
  ) as MissionManifest;
}

/** A controller built the way the CLI builds one: from the persisted manifest's config. */
function resumeFromManifest(
  missionId: string,
  runs: string,
  options: ControllerOptions = {},
): MissionController {
  return new MissionController(
    readManifest(missionId, runs).config,
    missionPaths(missionId, runs),
    {
      memory: new LocalMemoryAdapter(),
      host: HOST,
      ...options,
    },
  );
}

test("contract hash covers the frozen objective only; operating parameters and the ledger pin never change it", () => {
  const base = testConfig("amend-hash");
  const hash = contractHash(base);
  assert.equal(
    contractHash({
      ...base,
      budget: { ...base.budget, maxExperiments: base.budget.maxExperiments * 10 },
      model: { ...base.model, id: "some-other-model" },
      worker: base.worker === "pi" ? "scripted" : "pi",
      segmentRotationCycles: base.segmentRotationCycles + 1,
      stagnationLimit: base.stagnationLimit + 1,
      memory: { ...base.memory, enabled: !base.memory.enabled },
      retention: { keepRecentCandidates: 1, keepRecentSegments: 1, compactEventsAfter: 1 },
      ledger: { backend: "mongodb" },
    }),
    hash,
  );
  assert.notEqual(contractHash({ ...base, targetP95Reduction: base.targetP95Reduction / 2 }), hash);
  for (const field of OPERATING_FIELDS) assert.equal(field in objectiveOf(base), false);
  assert.equal("ledger" in objectiveOf(base), false);
  assert.equal("objective" in objectiveOf(base), true);
});

test("planAmendment lists leaf-level operating changes, flags raised budgets, and refuses objective or backend moves", () => {
  const base = testConfig("amend-plan");
  const next = testConfig("amend-plan", {
    budget: { ...base.budget, maxExperiments: base.budget.maxExperiments + 5, maxWallMs: 1 },
    model: { ...base.model, id: "other-model" },
  });
  const plan = planAmendment(base, next);
  assert.deepEqual(
    plan.changes.map((c) => c.path),
    ["budget.maxExperiments", "budget.maxWallMs", "model.id"],
  );
  assert.deepEqual(plan.budgetExtensions, [
    {
      path: "budget.maxExperiments",
      from: base.budget.maxExperiments,
      to: base.budget.maxExperiments + 5,
    },
  ]);
  assert.deepEqual(planAmendment(base, base).changes, []);
  assert.deepEqual(diffParameters({ a: { b: 1, c: [1] } }, { a: { b: 2, c: [1] } }), [
    { path: "a.b", from: 1, to: 2 },
  ]);
  assert.throws(
    () => planAmendment(base, { ...base, targetP95Reduction: 0.5 }),
    /frozen objective \(targetP95Reduction\)/,
  );
  assert.throws(
    () => planAmendment(base, { ...base, ledger: { backend: "mongodb" } }),
    /ledger backend from sqlite to mongodb/,
  );
});

test("a budget-exhausted mission resumes after an audited budget extension; contract and manifest stay consistent", async () => {
  const runs = tempRunsRoot();
  const id = "amend-budget";
  const small = { ...testConfig(id).budget, maxExperiments: 1 };
  const first = controllerFor(id, runs, {}, { budget: small });
  await first.initialize();
  const exhausted = await first.run();
  assert.equal(exhausted.status, "budget_exhausted");
  assert.equal(exhausted.spentExperiments, 1);
  await first.close();

  const before = readManifest(id, runs);
  const amender = resumeFromManifest(id, runs);
  await assert.rejects(
    amender.amend(testConfig(id, { budget: small, targetP95Reduction: 0.5 })),
    /frozen objective/,
  );
  const plan = await amender.amend(testConfig(id, { budget: { ...small, maxExperiments: 3 } }));
  assert.deepEqual(plan.changes, [{ path: "budget.maxExperiments", from: 1, to: 3 }]);
  assert.deepEqual(plan.budgetExtensions, plan.changes);
  const events = await amender.ledger.eventsSince(0, 10_000);
  const amended = events.filter((e) => e.type === "mission.amended");
  const extended = events.filter((e) => e.type === "budget.extended");
  assert.equal(amended.length, 1);
  assert.equal(extended.length, 1);
  assert.deepEqual(
    (extended[0]!.payload as { path: string; from: number; to: number }).path,
    "budget.maxExperiments",
  );
  assert.equal((await amender.mission()).status, "ready");
  assert.equal((await amender.mission()).contractHash, before.contractHash);
  await amender.close();

  const after = readManifest(id, runs);
  assert.equal(after.contractHash, before.contractHash);
  assert.equal(after.evaluatorHash, before.evaluatorHash);
  assert.equal(after.config.budget.maxExperiments, 3);
  assert.equal(after.config.targetP95Reduction, before.config.targetP95Reduction);
  assert.equal(contractHash(after.config), after.contractHash);
  assert.deepEqual(after.config.ledger, { backend: "sqlite" });

  const resumed = resumeFromManifest(id, runs);
  const row = await resumed.run();
  assert.equal(row.contractHash, before.contractHash);
  assert.ok(row.spentExperiments > 1, `resumed past the old budget (${row.spentExperiments})`);
  assert.ok(["succeeded", "budget_exhausted", "blocked"].includes(row.status));
  await resumed.close();
});

test("changing the model is an amendment, not a new mission: resume continues on the same ledger", async () => {
  const runs = tempRunsRoot();
  const id = "amend-model";
  const first = controllerFor(id, runs, { maxCycles: 1 });
  await first.initialize();
  await first.run();
  const experimentsBefore = (await first.ledger.listExperiments(id)).length;
  await first.close();

  const amender = resumeFromManifest(id, runs);
  const base = testConfig(id);
  const plan = await amender.amend(
    testConfig(id, {
      model: { ...base.model, id: "next-model" },
      stagnationLimit: base.stagnationLimit + 1,
    }),
  );
  assert.deepEqual(
    plan.changes.map((c) => c.path),
    ["model.id", "stagnationLimit"],
  );
  assert.deepEqual(plan.budgetExtensions, []);
  const events = await amender.ledger.eventsSince(0, 10_000);
  assert.equal(events.filter((e) => e.type === "budget.extended").length, 0);
  await amender.close();

  const manifest = readManifest(id, runs);
  assert.equal(manifest.config.model.id, "next-model");
  const resumed = resumeFromManifest(id, runs, { maxCycles: 1 });
  assert.equal(resumed.config.model.id, "next-model");
  assert.equal(resumed.contractHash, manifest.contractHash);
  const row = await resumed.run();
  assert.ok((await resumed.ledger.listExperiments(id)).length > experimentsBefore);
  assert.equal(row.contractHash, manifest.contractHash);
  await resumed.close();
});

test("a Node patch upgrade is recorded as environment drift and the mission resumes; the manifest follows the ledger", async () => {
  const runs = tempRunsRoot();
  const id = "amend-node";
  const [major, minor, patch] = process.version.replace(/^v/, "").split(".").map(Number);
  const oldNode = `v${major}.${minor}.${(patch ?? 0) + 1}`;
  const first = controllerFor(id, runs, { host: { ...HOST, node: oldNode } });
  await first.initialize();
  await first.close();
  const frozen = readManifest(id, runs);
  assert.equal(frozen.environment.node, oldNode);

  const log: string[] = [];
  const logged = resumeFromManifest(id, runs, { maxCycles: 1, log: (line) => log.push(line) });
  assert.notEqual(logged.environmentHash, frozen.environmentHash);
  const row = await logged.run();
  assert.equal(row.environmentHash, logged.environmentHash);
  assert.ok(
    log.some((l) => l.includes("environment_drift_accepted")),
    log.join("\n"),
  );
  const drifted = (await logged.ledger.eventsSince(0, 10_000)).find(
    (e) => e.type === "environment.drifted",
  );
  assert.ok(drifted);
  const payload = drifted.payload as { from: string; to: string; changed: string[] };
  assert.equal(payload.from, frozen.environmentHash);
  assert.equal(payload.to, logged.environmentHash);
  assert.deepEqual(payload.changed, ["node"]);
  await logged.close();

  const after = readManifest(id, runs);
  assert.equal(after.environmentHash, logged.environmentHash);
  assert.equal(after.environment.node, process.version);
  assert.equal(after.contractHash, frozen.contractHash);
});

test("environment drift that changes what the frozen reports measured is refused and points to rebaseline", async () => {
  const runs = tempRunsRoot();
  const id = "amend-arch";
  const first = controllerFor(id, runs, { host: { ...HOST, arch: "s390x" } });
  await first.initialize();
  await first.close();
  const resumed = resumeFromManifest(id, runs);
  await assert.rejects(
    resumed.run(),
    /host platform changed[\s\S]*horizon rebaseline --mission amend-arch/,
  );
  await resumed.close();

  const subprocess = environmentFingerprint("subprocess", "");
  assert.equal(classifyEnvironmentDrift(subprocess, subprocess), undefined);
  assert.equal(
    classifyEnvironmentDrift({ ...subprocess, node: "v1.0.0" }, subprocess)?.severity,
    "invalidating",
  );
  const container = environmentFingerprint("container", "img@sha256:abc");
  assert.equal(
    classifyEnvironmentDrift({ ...container, node: "v1.0.0" }, container)?.severity,
    "warning",
  );
  assert.equal(
    classifyEnvironmentDrift({ ...container, containerImage: "img@sha256:def" }, container)
      ?.severity,
    "invalidating",
  );
  assert.equal(classifyEnvironmentDrift(undefined, subprocess)?.severity, "warning");
});

test("evaluator drift is refused on resume until an explicit rebaseline re-measures the seed and best", async () => {
  const runs = tempRunsRoot();
  const id = "amend-eval";
  const first = controllerFor(id, runs, { maxCycles: 1 });
  await first.initialize();
  const ran = await first.run();
  const baselineBefore = ran.baselineP95Ms;
  assert.ok(baselineBefore !== null);
  // The mission was frozen under an evaluator that has since changed.
  const staleEvaluator = `stale-${computeEvaluatorHash()}`;
  await first.ledger.updateMission(id, { evaluatorHash: staleEvaluator });
  await first.close();

  const refused = resumeFromManifest(id, runs);
  await assert.rejects(
    refused.run(),
    /evaluator hash drift[\s\S]*horizon rebaseline --mission amend-eval/,
  );
  await refused.close();

  const rebaseliner = resumeFromManifest(id, runs);
  const outcome = await rebaseliner.rebaseline();
  assert.equal(outcome.evaluatorHash.from, staleEvaluator);
  assert.equal(outcome.evaluatorHash.to, computeEvaluatorHash());
  assert.ok(outcome.baselineP95Ms !== null);
  const mission = await rebaseliner.mission();
  assert.equal(mission.evaluatorHash, computeEvaluatorHash());
  assert.equal(mission.bestArtifactHash, outcome.bestArtifactHash);
  const events = await rebaseliner.ledger.eventsSince(0, 10_000);
  const rebaselined = events.find((e) => e.type === "evaluator.rebaselined");
  assert.ok(rebaselined);
  assert.equal(
    (rebaselined.payload as { previousBaselineP95Ms: number }).previousBaselineP95Ms,
    baselineBefore,
  );
  assert.equal(events.filter((e) => e.type === "mission.baseline").length >= 1, true);
  const tasks = await rebaseliner.ledger.listTasks(id);
  assert.equal(tasks.find((t) => t.taskId === "baseline")?.status, "done");
  assert.equal(tasks.find((t) => t.taskId === "holdout")?.status, "pending");
  assert.deepEqual(await rebaseliner.rebaseline(), outcome, "a completed rebaseline is a no-op");
  await rebaseliner.close();

  const manifest = readManifest(id, runs);
  assert.equal(manifest.evaluatorHash, computeEvaluatorHash());
  assert.equal(manifest.contractHash, mission.contractHash);

  const resumed = resumeFromManifest(id, runs);
  const row = await resumed.run();
  assert.equal(row.evaluatorHash, computeEvaluatorHash());
  assert.ok(["succeeded", "budget_exhausted", "blocked"].includes(row.status));
  await resumed.close();
});

test("rebaseline after an invalidating runtime change re-measures baseline, best and holdout under the new identity; old reports are never reused", async () => {
  const runs = tempRunsRoot();
  const id = "amend-rebase-identity";
  const first = controllerFor(id, runs, { host: HOST });
  await first.initialize();
  const done = await first.run();
  assert.equal(done.status, "succeeded");
  const oldEnvironment = done.environmentHash;
  const oldReports = await first.ledger.listVerifications(id);
  assert.ok(oldReports.every((v) => v.environmentHash === oldEnvironment));
  await first.close();

  const moved = { ...HOST, arch: HOST.arch === "arm64" ? "x64" : "arm64" };
  const refused = resumeFromManifest(id, runs, { host: moved });
  await assert.rejects(refused.run(), /environment drift invalidates[\s\S]*rebaseline/);
  await refused.close();

  const rebaseliner = resumeFromManifest(id, runs, { host: moved });
  const newEnvironment = rebaseliner.environmentHash;
  assert.notEqual(newEnvironment, oldEnvironment);
  const outcome = await rebaseliner.rebaseline();
  assert.equal(outcome.environmentHash.to, newEnvironment);
  assert.equal(outcome.previousBest, done.bestArtifactHash);
  const measured = await rebaseliner.mission();
  assert.equal(measured.environmentHash, newEnvironment);
  assert.ok(measured.baselineP95Ms !== null);
  const reports = await rebaseliner.ledger.listVerifications(id);
  const baselineEvent = await rebaseliner.ledger.findEvent(`baseline:${id}-r1`);
  const targetEvent = await rebaseliner.ledger.findEvent(`target:${id}:assessed-r1`);
  assert.ok(baselineEvent && targetEvent, "the rebaseline records its own baseline/target events");
  const cited = (baselineEvent.payload as { reportId: string }).reportId;
  const citedRow = reports.find((v) => v.reportId === cited);
  assert.equal(citedRow?.experimentId, `exp-baseline-${id}-r1`);
  assert.equal(citedRow?.environmentHash, newEnvironment);
  const original = await rebaseliner.ledger.findEvent(`baseline:${id}`);
  assert.ok(original);
  assert.notEqual(cited, (original.payload as { reportId: string }).reportId);
  const fresh = reports.filter((v) => v.environmentHash === newEnvironment);
  const seed = measured.seedArtifactHash!;
  assert.ok(
    fresh.some((v) => v.artifactHash === seed && v.suite === "performance"),
    "seed re-measured under the new identity",
  );
  if (outcome.previousBest && outcome.previousBest !== seed)
    assert.ok(
      fresh.some((v) => v.artifactHash === outcome.previousBest && v.suite === "performance"),
      "previous best re-measured under the new identity",
    );
  assert.equal(reports.length, oldReports.length + fresh.length, "old reports kept as history");
  const experiments = await rebaseliner.ledger.listExperiments(id);
  const baselines = experiments.filter((e) => e.taskId === "baseline").map((e) => e.experimentId);
  assert.deepEqual(baselines.sort(), [`exp-baseline-${id}`, `exp-baseline-${id}-r1`]);
  assert.equal(
    (await rebaseliner.ledger.listTasks(id)).find((t) => t.taskId === "holdout")?.status,
    "pending",
  );
  await rebaseliner.close();

  const resumed = resumeFromManifest(id, runs, { host: moved });
  const row = await resumed.run();
  assert.equal(row.status, "succeeded");
  const holdouts = (await resumed.ledger.listVerifications(id)).filter(
    (v) => v.suite === "holdout",
  );
  assert.ok(holdouts.some((v) => v.environmentHash === oldEnvironment));
  assert.ok(
    holdouts.some(
      (v) => v.environmentHash === newEnvironment && v.artifactHash === row.bestArtifactHash,
    ),
    "holdout re-run on the best artifact under the new identity",
  );
  await resumed.close();
  const manifest = readManifest(id, runs);
  assert.equal(manifest.environmentHash, newEnvironment);
  assert.equal(manifest.environment.arch, moved.arch);
});

test("revisiting an earlier identity (A -> B -> A -> B) starts a fresh epoch instead of replaying B's old rebaseline", async () => {
  const runs = tempRunsRoot();
  const id = "amend-rebase-revisit";
  const a = HOST;
  const b = { ...HOST, arch: HOST.arch === "arm64" ? "x64" : "arm64" };
  const first = controllerFor(id, runs, { host: a });
  await first.initialize();
  assert.equal((await first.run()).status, "succeeded");
  await first.close();

  for (const host of [b, a, b]) {
    const c = resumeFromManifest(id, runs, { host });
    const outcome = await c.rebaseline();
    assert.equal(outcome.environmentHash.to, c.environmentHash);
    assert.ok(outcome.baselineP95Ms !== null);
    await c.close();
    const resumed = resumeFromManifest(id, runs, { host });
    assert.equal((await resumed.run()).status, "succeeded");
    await resumed.close();
  }
  const last = resumeFromManifest(id, runs, { host: b });
  const settled = await last.rebaseline();
  assert.deepEqual(await last.rebaseline(), settled, "settled: repeat is a no-op");
  const rebaselined = (await last.ledger.eventsSince(0, 10_000)).filter(
    (e) => e.type === "evaluator.rebaselined",
  );
  assert.deepEqual(
    rebaselined.map((e) => (e.payload as { epoch: number }).epoch),
    [1, 2, 3],
  );
  const third = rebaselined[2]!.payload as {
    previousBestArtifactHash: string | null;
    environmentHash: { from: string; to: string };
  };
  const second = rebaselined[1]!.payload as { environmentHash: { from: string; to: string } };
  assert.equal(
    third.environmentHash.from,
    second.environmentHash.to,
    "third transition starts from A",
  );
  assert.equal(
    third.environmentHash.to,
    (rebaselined[0]!.payload as { environmentHash: { to: string } }).environmentHash.to,
  );
  const baselines = (await last.ledger.listExperiments(id))
    .filter((e) => e.taskId === "baseline")
    .map((e) => e.experimentId)
    .sort();
  assert.deepEqual(baselines, [
    `exp-baseline-${id}`,
    `exp-baseline-${id}-r1`,
    `exp-baseline-${id}-r2`,
    `exp-baseline-${id}-r3`,
  ]);
  const r3 = (await last.ledger.listVerifications(id)).filter(
    (v) => v.experimentId === `exp-baseline-${id}-r3`,
  );
  assert.ok(r3.length > 0 && r3.every((v) => v.environmentHash === last.environmentHash));
  await last.close();
});

test("an interrupted rebaseline is retried from the ledger instead of being mistaken for complete", async () => {
  const runs = tempRunsRoot();
  const id = "amend-rebase-retry";
  const first = controllerFor(id, runs, { host: HOST });
  await first.initialize();
  const done = await first.run();
  assert.equal(done.status, "succeeded");
  await first.close();

  const moved = { ...HOST, arch: HOST.arch === "arm64" ? "x64" : "arm64" };
  const crashing = resumeFromManifest(id, runs, {
    host: moved,
    crashAt: "report-written:fixed:performance",
  });
  await assert.rejects(crashing.rebaseline(), SimulatedCrash);
  const torn = await crashing.mission();
  assert.equal(torn.environmentHash, crashing.environmentHash);
  assert.equal(torn.baselineP95Ms, null);
  await crashing.close();

  const retry = resumeFromManifest(id, runs, { host: moved });
  const outcome = await retry.rebaseline();
  assert.ok(outcome.baselineP95Ms !== null, "retry measured the baseline");
  assert.equal(outcome.previousBest, done.bestArtifactHash);
  assert.equal(outcome.environmentHash.from, done.environmentHash);
  const mission = await retry.mission();
  assert.equal(mission.baselineP95Ms, outcome.baselineP95Ms);
  assert.equal(mission.bestArtifactHash, outcome.bestArtifactHash);
  const events = await retry.ledger.eventsSince(0, 10_000);
  assert.equal(events.filter((e) => e.type === "evaluator.rebaselined").length, 1);
  await retry.close();
});

test("a crash after the amendment commits but before the manifest is rewritten is reconciled from the ledger on restart", async () => {
  const runs = tempRunsRoot();
  const id = "amend-crash";
  const small = { ...testConfig(id).budget, maxExperiments: 1 };
  const first = controllerFor(id, runs, {}, { budget: small });
  await first.initialize();
  assert.equal((await first.run()).status, "budget_exhausted");
  await first.close();

  const crashing = resumeFromManifest(id, runs, { crashAt: "amendment_committed" });
  await assert.rejects(
    crashing.amend(testConfig(id, { budget: { ...small, maxExperiments: 3 } })),
    SimulatedCrash,
  );
  assert.equal((await crashing.mission()).status, "ready");
  await crashing.close();
  const torn = readManifest(id, runs);
  assert.equal(torn.config.budget.maxExperiments, 1, "manifest still carries the old config");
  assert.equal(torn.pendingAmendment?.config.budget.maxExperiments, 3);
  const reader = resumeFromManifest(id, runs);
  await reader.open();
  const payload = (await reader.ledger.findEvent(torn.pendingAmendment!.eventKey))!.payload as {
    operating: { budget: { maxExperiments: number } };
  };
  assert.equal(payload.operating.budget.maxExperiments, 3);
  await reader.close();

  const restarted = resumeFromManifest(id, runs);
  const row = await restarted.run();
  assert.equal(restarted.config.budget.maxExperiments, 3);
  assert.ok(row.spentExperiments > 1, `resumed with the amended budget (${row.spentExperiments})`);
  await restarted.close();
  const healed = readManifest(id, runs);
  assert.equal(healed.config.budget.maxExperiments, 3);
  assert.equal(healed.pendingAmendment, undefined);
});

test("a pending amendment whose event never reached the ledger is discarded on restart", async () => {
  const runs = tempRunsRoot();
  const id = "amend-torn";
  const first = controllerFor(id, runs);
  await first.initialize();
  await first.close();
  const manifest = readManifest(id, runs);
  writeJsonAtomic(missionPaths(id, runs).manifest, {
    ...manifest,
    pendingAmendment: {
      amendmentId: "deadbeef",
      eventKey: `mission:${id}:amended:deadbeef`,
      config: { ...manifest.config, budget: { ...manifest.config.budget, maxExperiments: 99 } },
    },
  });
  const restarted = resumeFromManifest(id, runs);
  await restarted.amend(manifest.config);
  assert.equal(restarted.config.budget.maxExperiments, manifest.config.budget.maxExperiments);
  await restarted.close();
  assert.equal(readManifest(id, runs).pendingAmendment, undefined);
});

test("a mission frozen with the legacy full-config hash is migrated once, audited as contract.migrated", async () => {
  const runs = tempRunsRoot();
  const id = "amend-legacy";
  const first = controllerFor(id, runs);
  await first.initialize();
  const manifest = readManifest(id, runs);
  const legacy = legacyContractHash(manifest.config);
  assert.notEqual(legacy, manifest.contractHash);
  await first.ledger.updateMission(id, { contractHash: legacy });
  await first.close();
  const { environment: _environment, ...legacyManifest } = manifest;
  writeJsonAtomic(missionPaths(id, runs).manifest, { ...legacyManifest, contractHash: legacy });

  const stranger = resumeFromManifest(id, runs);
  await stranger.open();
  await stranger.ledger.updateMission(id, { contractHash: "0".repeat(64) });
  await assert.rejects(stranger.run(), /contract hash drift/);
  await stranger.ledger.updateMission(id, { contractHash: legacy });
  await stranger.close();

  const migrated = resumeFromManifest(id, runs);
  const row = await migrated.run();
  assert.equal(row.contractHash, contractHash(manifest.config));
  const events = await migrated.ledger.eventsSince(0, 10_000);
  const migration = events.filter((e) => e.type === "contract.migrated");
  assert.equal(migration.length, 1);
  assert.deepEqual((migration[0]!.payload as { from: string; to: string }).from, legacy);
  await migrated.close();
  const after = readManifest(id, runs);
  assert.equal(after.contractHash, row.contractHash);
  assert.equal(contractHash(after.config), after.contractHash);

  const again = resumeFromManifest(id, runs);
  await again.run();
  assert.equal(
    (await again.ledger.eventsSince(0, 10_000)).filter((e) => e.type === "contract.migrated")
      .length,
    1,
  );
  await again.close();
});

test("retention is an operating policy: amending it onto a frozen mission compacts events on the next resume", async () => {
  const runs = tempRunsRoot();
  const id = "amend-retention";
  const first = controllerFor(
    id,
    runs,
    {},
    { budget: { ...testConfig(id).budget, maxExperiments: 1 } },
  );
  await first.initialize();
  assert.equal((await first.run()).status, "budget_exhausted");
  const eventsBefore = (await first.ledger.eventsSince(0, 10_000)).length;
  assert.ok(eventsBefore > 5);
  await first.close();

  const before = readManifest(id, runs);
  assert.equal(before.config.retention, undefined);
  const amender = resumeFromManifest(id, runs);
  const retention = { keepRecentCandidates: 2, keepRecentSegments: 1, compactEventsAfter: 2 };
  const plan = await amender.amend(testConfig(id, { budget: before.config.budget, retention }));
  assert.deepEqual(plan.changes, [{ path: "retention", from: undefined, to: retention }]);
  assert.equal((await amender.mission()).contractHash, before.contractHash);
  await amender.close();
  const after = readManifest(id, runs);
  assert.deepEqual(after.config.retention, retention);
  assert.equal(after.contractHash, before.contractHash);

  const resumed = resumeFromManifest(id, runs);
  await resumed.run();
  assert.ok(
    await resumed.ledger.findEvent(`mission:${id}:created`),
    "compacted events stay findable",
  );
  const lastSeq = await resumed.ledger.lastEventSeq();
  await resumed.close();
  const db = new DatabaseSync(missionPaths(id, runs).db, { readOnly: true });
  try {
    const live = db.prepare("SELECT COUNT(*) AS n FROM event").get() as { n: number };
    const archived = db
      .prepare("SELECT COALESCE(MAX(through_seq), 0) AS seq FROM event_snapshot")
      .get() as { seq: number };
    assert.ok(archived.seq > 0, "events before the cutoff were moved into snapshots");
    assert.ok(live.n <= retention.compactEventsAfter + 1 && live.n < eventsBefore);
    assert.ok(lastSeq >= archived.seq);
  } finally {
    db.close();
  }
});
