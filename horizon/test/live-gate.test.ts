import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { SimulatedCrash } from "../src/controller.ts";
import { evaluateLiveGate, exportLiveGate, type GateCheck } from "../src/live-gate.ts";
import { missionPaths } from "../src/mission-paths.ts";
import { resolveProviderApiKey } from "../src/pi-worker.ts";
import { ScriptedWorker } from "../src/scripted-worker.ts";
import type { SegmentHandle, Worker, WorkerCycleInput, WorkerCycleResult } from "../src/worker.ts";
import { controllerFor, tempRunsRoot } from "./helpers.ts";

/** Stands in for a live Pi session: same edits as the scripted worker, but labelled "pi" with provider-reported usage. */
class FakePiWorker implements Worker {
  readonly mode = "pi" as const;
  private readonly inner = new ScriptedWorker();
  openSegment(ordinal: number, _previous: SegmentHandle | null): Promise<SegmentHandle> {
    return this.inner.openSegment(ordinal);
  }
  async runCycle(input: WorkerCycleInput): Promise<WorkerCycleResult> {
    const result = await this.inner.runCycle(input);
    return { ...result, usage: { ...result.usage, uncertain: false } };
  }
  closeSegment() {
    return this.inner.closeSegment();
  }
  abort() {
    return this.inner.abort();
  }
}

class NoopPiWorker implements Worker {
  readonly mode = "pi" as const;
  async openSegment(ordinal: number): Promise<SegmentHandle> {
    return { sessionPath: null, sessionId: `noop-${ordinal}` };
  }
  async runCycle(_input: WorkerCycleInput): Promise<WorkerCycleResult> {
    return {
      hypothesis: "leave the seed unchanged",
      whatChanged: "nothing",
      claim: "no improvement",
      usage: { inputTokens: 100, outputTokens: 10, uncertain: false },
      seededFixture: null,
      aborted: false,
      compactions: 0,
    };
  }
  async closeSegment(): Promise<void> {}
  async abort(): Promise<void> {}
}

function byId(checks: GateCheck[]): Record<GateCheck["id"], GateCheck> {
  return Object.fromEntries(checks.map((c) => [c.id, c])) as Record<GateCheck["id"], GateCheck>;
}

/** create -> run interrupted after the first snapshot -> resume to completion, rotating the segment every cycle. */
async function interruptedMission(missionId: string, worker: () => Worker) {
  const runs = tempRunsRoot();
  const overrides = { segmentRotationCycles: 1 } as const;
  const first = controllerFor(
    missionId,
    runs,
    { worker: worker(), crashAt: "snapshot_ready" },
    overrides,
  );
  await first.initialize();
  await assert.rejects(first.run(), SimulatedCrash);
  await first.close();
  const second = controllerFor(missionId, runs, { worker: worker() }, overrides);
  const row = await second.run();
  return { runs, controller: second, row };
}

test("live gate: a scripted mission satisfies every structural criterion but is not live evidence", async () => {
  const { runs, controller, row } = await interruptedMission(
    "gate-scripted",
    () => new ScriptedWorker(),
  );
  const result = await evaluateLiveGate(controller.ledger, controller.config);
  const paths = missionPaths("gate-scripted", runs);
  const out = exportLiveGate(result, paths);
  await controller.close();

  assert.equal(row.status, "succeeded");
  const c = byId(result.checks);
  assert.equal(result.passed, false);
  assert.equal(c.worker_is_pi.passed, false);
  assert.match(c.worker_is_pi.detail, /pi=0/);
  assert.equal(c.usage_reported.passed, false, "estimated usage is not a provider report");
  assert.equal(c.model_candidate_verified.passed, false);
  assert.equal(c.baseline_measured.passed, true);
  assert.equal(c.interrupt_and_resume.passed, true);
  assert.equal(
    c.episode_retrieved_after_rotation.passed,
    true,
    c.episode_retrieved_after_rotation.detail,
  );
  assert.equal(c.holdout_passed.passed, true);
  assert.equal(c.mission_succeeded.passed, true);

  assert.ok(existsSync(out.json) && existsSync(out.markdown));
  const exported = JSON.parse(readFileSync(out.json, "utf8")) as {
    passed: boolean;
    checks: GateCheck[];
  };
  assert.equal(exported.passed, false);
  assert.equal(exported.checks.length, result.checks.length);
  assert.match(readFileSync(out.markdown, "utf8"), /\[FAIL\] worker_is_pi/);
});

test("live gate: passes only when a pi-labelled worker with reported usage authored the verified candidate", async () => {
  const { controller, row } = await interruptedMission("gate-pi", () => new FakePiWorker());
  const result = await evaluateLiveGate(controller.ledger, { ...controller.config, worker: "pi" });
  const experiments = await controller.ledger.listExperiments("gate-pi");
  await controller.close();

  assert.equal(row.status, "succeeded");
  assert.ok(
    experiments.filter((e) => e.taskId === "optimize-search").every((e) => e.strategy === "pi"),
  );
  const c = byId(result.checks);
  assert.equal(c.worker_is_pi.passed, true);
  assert.equal(c.usage_reported.passed, true);
  assert.equal(c.model_candidate_verified.passed, true, c.model_candidate_verified.detail);
  assert.equal(c.interrupt_and_resume.passed, true);
  assert.equal(
    c.episode_retrieved_after_rotation.passed,
    true,
    c.episode_retrieved_after_rotation.detail,
  );
  assert.equal(result.passed, true, JSON.stringify(result.checks, null, 2));
});

test("live gate: the manifest's worker setting is part of the verdict", async () => {
  const runs = tempRunsRoot();
  const controller = controllerFor("gate-config", runs, {
    worker: new FakePiWorker(),
    maxCycles: 1,
  });
  await controller.initialize();
  await controller.run();
  const asScripted = await evaluateLiveGate(controller.ledger, controller.config);
  const asPi = await evaluateLiveGate(controller.ledger, { ...controller.config, worker: "pi" });
  await controller.close();
  assert.equal(controller.config.worker, "scripted");
  assert.equal(byId(asScripted.checks).worker_is_pi.passed, false);
  assert.equal(byId(asPi.checks).worker_is_pi.passed, true);
  assert.equal(byId(asPi.checks).interrupt_and_resume.passed, false, "single uninterrupted launch");
});

test("live gate: an unchanged model candidate cannot inherit the baseline's passing reports", async () => {
  const runs = tempRunsRoot();
  const controller = controllerFor("gate-noop", runs, {
    worker: new NoopPiWorker(),
    maxCycles: 1,
  });
  await controller.initialize();
  await controller.run();
  const result = await evaluateLiveGate(controller.ledger, { ...controller.config, worker: "pi" });
  await controller.close();

  const checks = byId(result.checks);
  assert.equal(checks.worker_is_pi.passed, true);
  assert.equal(checks.usage_reported.passed, true);
  assert.equal(checks.baseline_measured.passed, true);
  assert.equal(checks.model_candidate_verified.passed, false);
});

test("provider API key resolution accepts the provider key or its known alias", () => {
  assert.deepEqual(resolveProviderApiKey("anthropic", {}), {
    apiKey: undefined,
    envKeys: ["ANTHROPIC_API_KEY"],
  });
  assert.equal(resolveProviderApiKey("anthropic", { ANTHROPIC_API_KEY: "a" }).apiKey, "a");
  assert.deepEqual(resolveProviderApiKey("google", { GEMINI_API_KEY: "g" }), {
    apiKey: "g",
    envKeys: ["GOOGLE_API_KEY", "GEMINI_API_KEY"],
  });
  assert.equal(
    resolveProviderApiKey("google", { GOOGLE_API_KEY: "x", GEMINI_API_KEY: "g" }).apiKey,
    "x",
  );
  assert.equal(resolveProviderApiKey("google-vertex", {}).envKeys[0], "GOOGLE_VERTEX_API_KEY");
});
