import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { SimulatedCrash } from "../src/controller.ts";
import { Ledger } from "../src/ledger.ts";
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
  const experiments = second.ledger
    .listExperiments("rec-edit")
    .filter((e) => e.taskId === "optimize-search");
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
  const before = first.ledger
    .listExperiments("rec-snap")
    .find((e) => e.taskId === "optimize-search")!;
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
  first.initialize();
  await assert.rejects(first.run(), SimulatedCrash);
  const exp = first.ledger
    .listExperiments("rec-report")
    .filter((e) => e.taskId === "optimize-search")
    .at(-1)!;
  const reportsBefore = first.ledger
    .listVerifications("rec-report")
    .filter((v) => v.experimentId === exp.experimentId)
    .map((v) => v.suite);
  first.close();
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
  const verifications = second.ledger
    .listVerifications("rec-report")
    .filter((v) => v.experimentId === exp.experimentId);
  const after = second.ledger.getExperiment(exp.experimentId)!;
  const events = second.ledger.eventsSince(0, 10000);
  second.close();

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

test("ledger: containers registered within the same millisecond list in registration order", () => {
  const ledger = new Ledger(join(tempRunsRoot(), "state.sqlite"));
  // Lexical order is the reverse of registration order, so a name tie-break would misorder them.
  const names = ["horizon-cand-zzz", "horizon-cand-mmm", "horizon-cand-aaa"];
  ledger.transaction(() => {
    for (const name of names) ledger.registerContainer(name, "led-order", `exp-${name}`);
  });
  ledger.db.exec("UPDATE container SET created_at = '2026-01-01T00:00:00.000Z'");
  ledger.releaseContainer("horizon-cand-mmm");

  assert.deepEqual(
    ledger.listContainers("led-order").map((c) => c.containerName),
    names,
  );
  assert.deepEqual(
    ledger.listLiveContainers("led-order").map((c) => c.containerName),
    ["horizon-cand-zzz", "horizon-cand-aaa"],
  );
  ledger.close();
});

test("container names are durable before launch and orphans are removed on resume", async () => {
  const runs = tempRunsRoot();
  const first = controllerFor("rec-orphan", runs, { crashAt: "snapshot_ready", maxCycles: 1 });
  first.initialize();
  await assert.rejects(first.run(), SimulatedCrash);
  const experiment = first.ledger
    .listExperiments("rec-orphan")
    .find((e) => e.taskId === "optimize-search")!;

  // The registry writes the name before `docker run`; a stopped container is released.
  const registry = first.containerRegistry(experiment.experimentId);
  registry.register("horizon-cand-released0001");
  registry.release("horizon-cand-released0001");
  // A container whose controller died mid-verification never reaches release().
  registry.register("horizon-cand-orphan000001");
  const live = first.ledger.listLiveContainers("rec-orphan");
  assert.deepEqual(
    live.map((c) => [c.containerName, c.experimentId, c.state]),
    [["horizon-cand-orphan000001", experiment.experimentId, "launching"]],
  );
  assert.ok(first.ledger.findEvent("container:horizon-cand-orphan000001:launched"));
  first.close();

  const removed: string[] = [];
  const second = controllerFor("rec-orphan", runs, {
    maxCycles: 1,
    containerRuntime: { remove: (name) => (removed.push(name), true) },
  });
  await second.run();
  const containers = second.ledger.listContainers("rec-orphan");
  const event = second.ledger.findEvent("recovery:horizon-cand-orphan000001:orphan-removed");
  const recovered = second.ledger
    .eventsSince(0, 10_000)
    .filter((e) => e.type === "controller.recovered")
    .at(-1)!.payload as { actions: { kind: string; experimentId?: string }[] };
  const stillLive = second.ledger.listLiveContainers("rec-orphan").length;
  second.close();

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
