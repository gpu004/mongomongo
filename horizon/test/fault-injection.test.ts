import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { FIXTURES_DIR } from "../src/artifact-store.ts";
import { SimulatedCrash } from "../src/controller.ts";
import { Ledger } from "../src/ledger.ts";
import { LocalMemoryAdapter } from "../src/memory-adapter.ts";
import { missionPaths } from "../src/mission-paths.ts";
import { ScriptedWorker } from "../src/scripted-worker.ts";
import type { Worker, WorkerCycleInput } from "../src/worker.ts";
import { controllerFor, tempRunsRoot } from "./helpers.ts";

const STALE = readFileSync(join(FIXTURES_DIR, "stale-cache", "overlay", "search", "search-engine.ts"), "utf8");

/** Writes the same known-bad content every cycle, overclaims, and floods its prose. */
class RepeatingWorker implements Worker {
	readonly mode = "scripted" as const;
	async openSegment() {
		return { sessionPath: null, sessionId: "repeat" };
	}
	async runCycle(input: WorkerCycleInput) {
		input.broker.workspaceEdit("src/search/search-engine.ts", { content: STALE });
		return { hypothesis: "cache query results", whatChanged: `cache ${"x".repeat(200_000)}`, claim: "All tests pass; correctness passed.", usage: { inputTokens: 10, outputTokens: 10, uncertain: false }, seededFixture: null, aborted: false, compactions: 0 };
	}
	async closeSegment() {}
	async abort() {}
}

test("repeated identical failing artifact reuses the committed failure; overclaims and oversized prose are contained", async () => {
	const runs = tempRunsRoot();
	const controller = controllerFor("fi-repeat", runs, { worker: new RepeatingWorker(), maxCycles: 2 });
	controller.initialize();
	await controller.run();
	const experiments = controller.ledger.listExperiments("fi-repeat").filter((e) => e.taskId === "optimize-search");
	assert.equal(experiments.length, 2);
	assert.equal(experiments[0]!.candidateArtifactHash, experiments[1]!.candidateArtifactHash);
	assert.deepEqual(experiments.map((e) => e.status), ["rejected", "rejected"]);
	assert.equal(experiments[0]!.failureSignature, experiments[1]!.failureSignature);

	const verifications = controller.ledger.listVerifications("fi-repeat");
	const firstCorrectness = verifications.find((v) => v.experimentId === experiments[0]!.experimentId && v.suite === "correctness")!;
	assert.ok(controller.ledger.findEvent(`reuse:${experiments[1]!.experimentId}:correctness:${firstCorrectness.reportId}`), "second experiment reused the committed correctness failure");
	assert.equal(verifications.filter((v) => v.suite === "correctness" && v.artifactHash === experiments[0]!.candidateArtifactHash).length, 1, "correctness ran once for the identical artifact");

	const audit = controller.ledger.findEvent(`${experiments[0]!.experimentId}:claim-audit`)!.payload as { supported: boolean; issues: string[] };
	assert.equal(audit.supported, false);
	assert.ok(audit.issues.some((i) => /claims correctness passed; verifier reported failed/.test(i) || /generic success claim/.test(i)), audit.issues.join("; "));

	const snapshot = controller.ledger.findEvent(`${experiments[0]!.experimentId}:snapshot`)!.payload as { whatChanged: string };
	assert.ok(snapshot.whatChanged.length < 1000);
	assert.match(snapshot.whatChanged, /truncated; full text in ev-worker-output-/);
	const episode = controller.ledger.listEpisodes("fi-repeat").find((e) => e.experimentId === experiments[0]!.experimentId)!;
	assert.match(episode.summary, /claim disagrees with verifier/);
	assert.ok(episode.summary.length < 4000);
	controller.close();
});

test("wall-clock budget survives a crash: elapsed time is persisted at checkpoints, not only at finish", async () => {
	const runs = tempRunsRoot();
	const first = controllerFor("fi-wall", runs, { crashAt: "snapshot_ready", maxCycles: 1 });
	first.initialize();
	await assert.rejects(first.run(), SimulatedCrash);
	first.close();
	const ledger = new Ledger(missionPaths("fi-wall", runs).db);
	const spent = ledger.getMission("fi-wall")!.spentWallMs;
	ledger.close();
	assert.ok(spent > 0, `spentWallMs ${spent}`);

	const second = controllerFor("fi-wall", runs, { maxCycles: 1 });
	const row = await second.run();
	second.close();
	assert.ok(row.spentWallMs >= spent);
});

test("memory outage during a run degrades to the local index and deliveries retry after recovery", async () => {
	const runs = tempRunsRoot();
	const memory = new LocalMemoryAdapter();
	memory.unavailable = true;
	const controller = controllerFor("fi-outage", runs, { memory, maxCycles: 2 });
	controller.initialize();
	await controller.run();
	const pending = controller.ledger.listOutbox(["pending", "failed"]);
	assert.ok(pending.length > 0, "episodes queued while memory is down");
	const experiments = controller.ledger.listExperiments("fi-outage").filter((e) => e.taskId === "optimize-search");
	const packet = controller.ledger.findEvent(`${experiments[1]!.experimentId}:packet`)!.payload as { degraded: boolean; injected: string[] };
	assert.equal(packet.degraded, true);
	assert.ok(packet.injected.length > 0, "local index still supplied history");
	// Let the recorded backoff elapse instead of sleeping for it.
	for (const row of pending) controller.ledger.updateOutbox(row.idempotencyKey, { nextAttemptAt: new Date(0).toISOString() });
	controller.close();

	memory.unavailable = false;
	const resumed = controllerFor("fi-outage", runs, { memory, maxCycles: 1 });
	await resumed.run();
	assert.equal(resumed.ledger.listOutbox(["pending", "failed"]).length, 0);
	resumed.close();
});

test("a fresh worker after restart continues from durable state instead of repeating the failed approach", async () => {
	const runs = tempRunsRoot();
	const first = controllerFor("fi-fresh", runs, { worker: new ScriptedWorker(), maxCycles: 1 });
	first.initialize();
	await first.run();
	const [exp1] = first.ledger.listExperiments("fi-fresh").filter((e) => e.taskId === "optimize-search");
	first.close();
	assert.equal(exp1!.status, "rejected");

	const second = controllerFor("fi-fresh", runs, { worker: new ScriptedWorker(), maxCycles: 1 });
	await second.run();
	const experiments = second.ledger.listExperiments("fi-fresh").filter((e) => e.taskId === "optimize-search");
	second.close();
	assert.equal(experiments.length, 2);
	assert.notEqual(experiments[1]!.candidateArtifactHash, exp1!.candidateArtifactHash);
	assert.notEqual(experiments[1]!.hypothesis, exp1!.hypothesis);
});
