import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { SimulatedCrash } from "../src/controller.ts";
import { missionPaths } from "../src/mission-paths.ts";
import { controllerFor, tempRunsRoot } from "./helpers.ts";

test("crash during candidate edits: experiment is marked interrupted, workspace restored, mission continues", async () => {
	const runs = tempRunsRoot();
	const first = controllerFor("rec-edit", runs, { crashAt: "editing", maxCycles: 1 });
	first.initialize();
	await assert.rejects(first.run(), SimulatedCrash);
	first.close();

	// A stray file left by the interrupted edit must not survive recovery.
	const paths = missionPaths("rec-edit", runs);
	writeFileSync(join(paths.candidate, "src", "stray.ts"), "export const x = 1;\n");

	const second = controllerFor("rec-edit", runs, { maxCycles: 1 });
	const row = await second.run();
	const experiments = second.ledger.listExperiments("rec-edit").filter((e) => e.taskId === "optimize-search");
	second.close();

	assert.equal(experiments[0]?.status, "interrupted");
	assert.equal(experiments.length, 2);
	assert.ok(["rejected", "accepted", "inconclusive"].includes(experiments[1]!.status));
	assert.equal(existsSync(join(paths.candidate, "src", "stray.ts")), false);
	assert.equal(row.spentExperiments, 2);
});

test("crash after snapshot: the same immutable snapshot is evaluated, not re-edited", async () => {
	const runs = tempRunsRoot();
	const first = controllerFor("rec-snap", runs, { crashAt: "snapshot_ready", maxCycles: 1 });
	first.initialize();
	await assert.rejects(first.run(), SimulatedCrash);
	const before = first.ledger.listExperiments("rec-snap").find((e) => e.taskId === "optimize-search")!;
	first.close();
	assert.equal(before.status, "snapshot_ready");

	const second = controllerFor("rec-snap", runs, { maxCycles: 1 });
	await second.run();
	const after = second.ledger.getExperiment(before.experimentId)!;
	const artifactsDir = missionPaths("rec-snap", runs).artifacts;
	second.close();

	assert.equal(after.candidateArtifactHash, before.candidateArtifactHash);
	assert.equal(after.status, "rejected");
	assert.match(after.verdict ?? "", /correctness failed/);
	assert.equal(readdirSync(artifactsDir).filter((n) => !n.startsWith(".")).length, 2, "seed + one candidate; no duplicate snapshot");
});

test("crash between report publication and ledger commit: finalized report is committed, not rerun", async () => {
	const runs = tempRunsRoot();
	// The scripted worker verifies smoke+correctness itself in cycle 2; the controller then runs learned, where we crash.
	const first = controllerFor("rec-report", runs, { crashAt: "report-written:optimize:learned", maxCycles: 2 });
	first.initialize();
	await assert.rejects(first.run(), SimulatedCrash);
	const exp = first.ledger.listExperiments("rec-report").filter((e) => e.taskId === "optimize-search").at(-1)!;
	const reportsBefore = first.ledger.listVerifications("rec-report").filter((v) => v.experimentId === exp.experimentId).map((v) => v.suite);
	first.close();
	assert.equal(exp.status, "evaluating");
	assert.deepEqual(reportsBefore.sort(), ["correctness", "smoke"], "learned report was written to disk but never committed");

	const paths = missionPaths("rec-report", runs);
	const onDisk = readdirSync(join(paths.reports, exp.experimentId));
	assert.ok(onDisk.some((n) => n.startsWith("learned-")));
	assert.ok(!onDisk.some((n) => n.startsWith(".tmp")), "no partial files");

	const second = controllerFor("rec-report", runs, { maxCycles: 1 });
	await second.run();
	const verifications = second.ledger.listVerifications("rec-report").filter((v) => v.experimentId === exp.experimentId);
	const after = second.ledger.getExperiment(exp.experimentId)!;
	const events = second.ledger.eventsSince(0, 10000);
	second.close();

	assert.equal(verifications.filter((v) => v.suite === "learned").length, 1, "exactly one committed learned report");
	assert.equal(readdirSync(join(paths.reports, exp.experimentId)).filter((n) => n.startsWith("learned-")).length, 1, "learned suite was not rerun");
	assert.ok(["accepted", "rejected"].includes(after.status));
	const recovered = events.find((e) => e.type === "controller.recovered" && JSON.stringify(e.payload).includes("finish_report_commit"));
	assert.ok(recovered, "recovery recorded the finalized-report commit");
});

test("checkpoints exist for every durable transition and the latest one reflects finished state", async () => {
	const runs = tempRunsRoot();
	const controller = controllerFor("rec-ckpt", runs);
	controller.initialize();
	const row = await controller.run();
	const latest = controller.ledger.latestCheckpoint("rec-ckpt")!;
	const count = controller.ledger.countCheckpoints("rec-ckpt");
	const segments = controller.ledger.listSegments("rec-ckpt");
	controller.close();

	assert.equal(row.status, "succeeded");
	assert.ok(count >= 6);
	assert.equal(latest.missionStatus, "succeeded");
	assert.equal(latest.activeExperimentId, null);
	assert.ok(segments.every((s) => s.committed));
});

test("re-running a finished mission is idempotent and the controller lock is held for the run", async () => {
	const runs = tempRunsRoot();
	const controller = controllerFor("rec-idem", runs);
	controller.initialize();
	await controller.run();
	const experimentsBefore = controller.ledger.listExperiments("rec-idem").length;
	controller.close();

	const again = controllerFor("rec-idem", runs);
	const lockPath = join(runs, "rec-idem", "controller.lock");
	again.ledger.acquireLock();
	assert.equal(readFileSync(lockPath, "utf8"), String(process.pid));
	again.ledger.releaseLock();
	assert.equal(existsSync(lockPath), false);
	const row = await again.run();
	assert.equal(row.status, "succeeded");
	assert.equal(again.ledger.listExperiments("rec-idem").length, experimentsBefore);
	again.close();
});

test("drift in frozen identities is refused on resume", async () => {
	const runs = tempRunsRoot();
	const controller = controllerFor("rec-drift", runs);
	controller.initialize();
	controller.close();
	const drifted = controllerFor("rec-drift", runs, {}, { targetP95Reduction: 0.5 });
	await assert.rejects(drifted.run(), /contract hash drift/);
	drifted.close();
});
