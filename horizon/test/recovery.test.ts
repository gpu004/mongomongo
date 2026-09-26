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
  await first.initialize();
  await assert.rejects(first.run(), SimulatedCrash);
  await first.close();

  // A stray file left by the interrupted edit must not survive recovery.
  const paths = missionPaths("rec-edit", runs);
  writeFileSync(join(paths.candidate, "src", "stray.ts"), "export const x = 1;\n");

  const second = controllerFor("rec-edit", runs, { maxCycles: 1 });
  const row = await second.run();
  const experiments = (await second.ledger.listExperiments("rec-edit")).filter(
    (e) => e.taskId === "optimize-search",
  );
  await second.close();

  assert.equal(experiments[0]?.status, "interrupted");
  assert.equal(experiments.length, 2);
  assert.ok(["rejected", "accepted", "inconclusive"].includes(experiments[1]!.status));
  assert.equal(existsSync(join(paths.candidate, "src", "stray.ts")), false);
  assert.equal(row.spentExperiments, 2);
});

test("crash after snapshot: the same immutable snapshot is evaluated, not re-edited", async () => {
  const runs = tempRunsRoot();
  const first = controllerFor("rec-snap", runs, { crashAt: "snapshot_ready", maxCycles: 1 });
  await first.initialize();
  await assert.rejects(first.run(), SimulatedCrash);
  const before = (await first.ledger.listExperiments("rec-snap")).find(
    (e) => e.taskId === "optimize-search",
  )!;
  await first.close();
  assert.equal(before.status, "snapshot_ready");

  const second = controllerFor("rec-snap", runs, { maxCycles: 1 });
  await second.run();
  const after = (await second.ledger.getExperiment(before.experimentId))!;
  const artifactsDir = missionPaths("rec-snap", runs).artifacts;
  await second.close();

  assert.equal(after.candidateArtifactHash, before.candidateArtifactHash);
  assert.equal(after.status, "rejected");
  assert.match(after.verdict ?? "", /correctness failed/);
  assert.equal(
    readdirSync(artifactsDir).filter((n) => !n.startsWith(".")).length,
    2,
    "seed + one candidate; no duplicate snapshot",
  );
});

test("crash between report publication and ledger commit: finalized report is committed, not rerun", async () => {
  const runs = tempRunsRoot();
  // The scripted worker verifies smoke+correctness itself in cycle 2; the controller then runs learned, where we crash.
  const first = controllerFor("rec-report", runs, {
    crashAt: "report-written:optimize:learned",
    maxCycles: 2,
  });
  await first.initialize();
  await assert.rejects(first.run(), SimulatedCrash);
  const exp = (await first.ledger.listExperiments("rec-report"))
    .filter((e) => e.taskId === "optimize-search")
    .at(-1)!;
  const reportsBefore = (await first.ledger.listVerifications("rec-report"))
    .filter((v) => v.experimentId === exp.experimentId)
    .map((v) => v.suite);
  await first.close();
  assert.equal(exp.status, "evaluating");
  assert.deepEqual(
    reportsBefore.sort(),
    ["correctness", "smoke"],
    "learned report was written to disk but never committed",
  );

  const paths = missionPaths("rec-report", runs);
  const onDisk = readdirSync(join(paths.reports, exp.experimentId));
  assert.ok(onDisk.some((n) => n.startsWith("learned-")));
  assert.ok(!onDisk.some((n) => n.startsWith(".tmp")), "no partial files");

  const second = controllerFor("rec-report", runs, { maxCycles: 1 });
  await second.run();
  const verifications = (await second.ledger.listVerifications("rec-report")).filter(
    (v) => v.experimentId === exp.experimentId,
  );
  const after = (await second.ledger.getExperiment(exp.experimentId))!;
  const events = await second.ledger.eventsSince(0, 10000);
  await second.close();

  assert.equal(
    verifications.filter((v) => v.suite === "learned").length,
    1,
    "exactly one committed learned report",
  );
  assert.equal(
    readdirSync(join(paths.reports, exp.experimentId)).filter((n) => n.startsWith("learned-"))
      .length,
    1,
    "learned suite was not rerun",
  );
  assert.ok(["accepted", "rejected"].includes(after.status));
  const recovered = events.find(
    (e) =>
      e.type === "controller.recovered" &&
      JSON.stringify(e.payload).includes("finish_report_commit"),
  );
  assert.ok(recovered, "recovery recorded the finalized-report commit");
});

test("checkpoints exist for every durable transition and the latest one reflects finished state", async () => {
  const runs = tempRunsRoot();
  const controller = controllerFor("rec-ckpt", runs);
  await controller.initialize();
  const row = await controller.run();
  const latest = (await controller.ledger.latestCheckpoint("rec-ckpt"))!;
  const count = await controller.ledger.countCheckpoints("rec-ckpt");
  const segments = await controller.ledger.listSegments("rec-ckpt");
  await controller.close();

  assert.equal(row.status, "succeeded");
  assert.ok(count >= 6);
  assert.equal(latest.missionStatus, "succeeded");
  assert.equal(latest.activeExperimentId, null);
  assert.ok(segments.every((s) => s.committed));
});

test("re-running a finished mission is idempotent and the controller lock is held for the run", async () => {
  const runs = tempRunsRoot();
  const controller = controllerFor("rec-idem", runs);
  await controller.initialize();
  await controller.run();
  const experimentsBefore = (await controller.ledger.listExperiments("rec-idem")).length;
  await controller.close();

  const again = controllerFor("rec-idem", runs);
  const lockPath = join(runs, "rec-idem", "controller.lock");
  await again.ledger.acquireLease("test", 60_000);
  assert.equal(readFileSync(lockPath, "utf8"), String(process.pid));
  await again.ledger.releaseLease();
  assert.equal(existsSync(lockPath), false);
  const row = await again.run();
  assert.equal(row.status, "succeeded");
  assert.equal((await again.ledger.listExperiments("rec-idem")).length, experimentsBefore);
  await again.close();
});

test("drift in frozen identities is refused on resume", async () => {
  const runs = tempRunsRoot();
  const controller = controllerFor("rec-drift", runs);
  await controller.initialize();
  await controller.close();
  const drifted = controllerFor("rec-drift", runs, {}, { targetP95Reduction: 0.5 });
  await assert.rejects(drifted.run(), /contract hash drift/);
  await drifted.close();
});

test("container names are durable before launch and orphans are removed on resume", async () => {
  const runs = tempRunsRoot();
  const first = controllerFor("rec-orphan", runs, { crashAt: "snapshot_ready", maxCycles: 1 });
  await first.initialize();
  await assert.rejects(first.run(), SimulatedCrash);
  const experiment = (await first.ledger.listExperiments("rec-orphan")).find(
    (e) => e.taskId === "optimize-search",
  )!;

  // The registry writes the name before `docker run`; a stopped container is released.
  const registry = first.containerRegistry(experiment.experimentId);
  await registry.register("horizon-cand-released0001");
  await registry.release("horizon-cand-released0001");
  // A container whose controller died mid-verification never reaches release().
  await registry.register("horizon-cand-orphan000001");
  const live = await first.ledger.listLiveContainers("rec-orphan");
  assert.deepEqual(
    live.map((c) => [c.containerName, c.experimentId, c.state]),
    [["horizon-cand-orphan000001", experiment.experimentId, "launching"]],
  );
  assert.ok(await first.ledger.findEvent("container:horizon-cand-orphan000001:launched"));
  await first.close();

  const removed: string[] = [];
  const second = controllerFor("rec-orphan", runs, {
    maxCycles: 1,
    containerRuntime: { remove: (name) => (removed.push(name), true) },
  });
  await second.run();
  const containers = await second.ledger.listContainers("rec-orphan");
  const event = await second.ledger.findEvent("recovery:horizon-cand-orphan000001:orphan-removed");
  const recovered = (await second.ledger.eventsSince(0, 10_000))
    .filter((e) => e.type === "controller.recovered")
    .at(-1)!.payload as { actions: { kind: string; experimentId?: string }[] };
  const stillLive = (await second.ledger.listLiveContainers("rec-orphan")).length;
  await second.close();

  assert.deepEqual(removed, ["horizon-cand-orphan000001"]);
  assert.equal(stillLive, 0);
  assert.deepEqual(
    containers.map((c) => [c.containerName, c.state]),
    [
      ["horizon-cand-released0001", "released"],
      ["horizon-cand-orphan000001", "orphan_removed"],
    ],
  );
  assert.ok(containers.every((c) => c.releasedAt !== null));
  assert.deepEqual(event?.payload, { containerName: "horizon-cand-orphan000001", existed: true });
  assert.ok(
    recovered.actions.some(
      (a) => a.kind === "removed_orphaned_container" && a.experimentId === experiment.experimentId,
    ),
  );
});
