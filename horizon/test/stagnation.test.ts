import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { FIXTURES_DIR } from "../src/artifact-store.ts";
import { normalizeHypothesis } from "../src/controller.ts";
import { validateMissionConfig } from "../src/mission-contract.ts";
import type { Worker, WorkerCycleInput } from "../src/worker.ts";
import { controllerFor, EXAMPLE_CONFIG, tempRunsRoot } from "./helpers.ts";

const STALE = readFileSync(
  join(FIXTURES_DIR, "stale-cache", "overlay", "search", "search-engine.ts"),
  "utf8",
);

/** Retries the same failing mechanism every cycle; profiles first only when told to. */
class StuckWorker implements Worker {
  readonly mode = "scripted" as const;
  readonly packets: string[] = [];
  private readonly profileFromCycle: number;
  constructor(profileFromCycle: number) {
    this.profileFromCycle = profileFromCycle;
  }
  async openSegment() {
    return { sessionPath: null, sessionId: "stuck" };
  }
  async runCycle(input: WorkerCycleInput) {
    this.packets.push(input.packet.text);
    if (input.cycle >= this.profileFromCycle)
      await input.broker.profileCandidate("search-read-heavy");
    input.broker.workspaceEdit("src/search/search-engine.ts", { content: STALE });
    return {
      hypothesis: input.cycle % 2 === 0 ? "Cache query results!" : "cache   query results",
      whatChanged: "query cache without invalidation",
      claim: "unverified",
      usage: { inputTokens: 10, outputTokens: 10, uncertain: false },
      seededFixture: null,
      aborted: false,
      compactions: 0,
    };
  }
  async closeSegment() {}
  async abort() {}
}

test("normalizeHypothesis collapses case, whitespace and punctuation", () => {
  assert.equal(normalizeHypothesis("Cache   Query-Results!"), "cache query results");
});

test("stagnationLimit must be a positive number", () => {
  const base = JSON.parse(readFileSync(EXAMPLE_CONFIG, "utf8")) as Record<string, unknown>;
  assert.throws(
    () => validateMissionConfig({ ...base, stagnationLimit: 0 }),
    /stagnationLimit >= 1/,
  );
  const { stagnationLimit: _omitted, ...missing } = base;
  assert.throws(() => validateMissionConfig(missing), /stagnationLimit >= 1/);
});

test("after stagnationLimit experiments without improvement the controller requires profiling or a new mechanism", async () => {
  const runs = tempRunsRoot();
  const worker = new StuckWorker(4);
  const controller = controllerFor(
    "stagnation",
    runs,
    { worker, maxCycles: 4 },
    { stagnationLimit: 2 },
  );
  await controller.initialize();
  await controller.run();
  const experiments = (await controller.ledger.listExperiments("stagnation")).filter(
    (e) => e.taskId === "optimize-search",
  );
  assert.equal(experiments.length, 4);
  const [first, second, third, fourth] = experiments as [
    (typeof experiments)[0],
    (typeof experiments)[0],
    (typeof experiments)[0],
    (typeof experiments)[0],
  ];

  // Below the limit: no stagnation directive; both experiments go through verification.
  for (const e of [first, second]) {
    assert.equal(await controller.ledger.findEvent(`${e.experimentId}:stagnation`), undefined);
    assert.match(e.verdict ?? "", /^correctness failed/);
  }
  assert.doesNotMatch(worker.packets[0]!, /Stagnation:/);
  assert.doesNotMatch(worker.packets[1]!, /Stagnation:/);

  // At the limit: the packet carries the directive and the repeated, unprofiled mechanism is rejected without verification.
  const detected = await controller.ledger.findEvent(`${third.experimentId}:stagnation`);
  assert.ok(detected, "stagnation.detected recorded for the third experiment");
  assert.deepEqual(detected.payload, {
    count: 2,
    limit: 2,
    triedHypotheses: ["cache query results"],
  });
  assert.match(worker.packets[2]!, /Stagnation: 2 completed experiments/);
  assert.match(worker.packets[2]!, /cache query results/);
  assert.equal(third.status, "rejected");
  assert.match(third.verdict ?? "", /^stagnation: repeated an already-tried mechanism/);
  assert.equal(third.candidateArtifactHash, null);
  assert.equal(
    (await controller.ledger.listVerifications("stagnation")).filter(
      (v) => v.experimentId === third.experimentId,
    ).length,
    0,
    "no verifier run for the stagnation-rejected experiment",
  );
  const episode = await controller.ledger.getEpisode(`ep-${third.experimentId}-v1`);
  assert.ok(episode);
  assert.match(episode.summary, /profile the current best artifact before editing/);

  // Still stagnated, but the worker profiled first: the same mechanism is allowed through to the verifier.
  assert.ok(await controller.ledger.findEvent(`${fourth.experimentId}:stagnation`));
  assert.match(fourth.verdict ?? "", /^correctness failed/);
  assert.ok(
    (await controller.ledger.listVerifications("stagnation")).some(
      (v) => v.experimentId === fourth.experimentId && v.suite === "performance",
    ),
    "profiling ran the performance suite under the fourth experiment",
  );
  await controller.close();
});
