import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { computeEvaluatorHash, environmentFingerprint } from "../verification/runner.ts";
import {
  type ControllerOptions,
  MissionController,
  type MissionManifest,
} from "../src/controller.ts";
import { LocalMemoryAdapter } from "../src/memory-adapter.ts";
import {
  contractHash,
  diffParameters,
  objectiveOf,
  OPERATING_FIELDS,
  planAmendment,
} from "../src/mission-contract.ts";
import { missionPaths } from "../src/mission-paths.ts";
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
