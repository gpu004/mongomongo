import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { MissionController, SimulatedCrash } from "../src/controller.ts";
import { describeLedgerSelection, openLedger, selectLedgerBackend } from "../src/ledger-backend.ts";
import { LeaseError } from "../src/ledger-contract.ts";
import { evaluateLiveGate } from "../src/live-gate.ts";
import { LocalMemoryAdapter } from "../src/memory-adapter.ts";
import { loadMissionConfig, validateMissionConfig } from "../src/mission-contract.ts";
import { missionPaths } from "../src/mission-paths.ts";
import { readMongoEnv } from "../src/mongo-env.ts";
import { MongoLedger } from "../src/mongo-ledger.ts";
import { summarize } from "../src/progress.ts";
import { SqliteLedger } from "../src/sqlite-ledger.ts";
import { controllerFor, EXAMPLE_CONFIG, tempRunsRoot, testConfig } from "./helpers.ts";

const MONGO_URI = "mongodb://user:secret@example.invalid:27017/?replicaSet=rs0";

test("backend selection: sqlite by default, mongodb from MONGODB_URI, explicit config wins", () => {
  const sqliteOnly = selectLedgerBackend({ missionId: "m" }, {});
  assert.deepEqual(sqliteOnly, { backend: "sqlite", source: "default" });

  const fromEnv = selectLedgerBackend({ missionId: "m" }, { MONGODB_URI: MONGO_URI });
  assert.equal(fromEnv.backend, "mongodb");
  assert.equal(fromEnv.source, "env");
  assert.equal(fromEnv.backend === "mongodb" && fromEnv.env.db, "horizon_dev");

  const pinnedSqlite = selectLedgerBackend(
    { missionId: "m", ledger: { backend: "sqlite" } },
    { MONGODB_URI: MONGO_URI },
  );
  assert.deepEqual(pinnedSqlite, { backend: "sqlite", source: "config" });

  const pinnedMongo = selectLedgerBackend(
    { missionId: "m", ledger: { backend: "mongodb" } },
    { MONGODB_URI: MONGO_URI, MONGODB_DB: "horizon_x" },
  );
  assert.equal(pinnedMongo.source, "config");
  assert.equal(pinnedMongo.backend === "mongodb" && pinnedMongo.env.db, "horizon_x");

  assert.throws(
    () => selectLedgerBackend({ missionId: "m", ledger: { backend: "mongodb" } }, {}),
    /requires the mongodb ledger but MONGODB_URI is not set/,
  );

  const described = describeLedgerSelection(fromEnv);
  assert.match(described, /^mongodb mongodb:\/\/example\.invalid/);
  assert.doesNotMatch(described, /secret/);
  assert.throws(
    () =>
      validateMissionConfig({
        ...loadMissionConfig(EXAMPLE_CONFIG),
        ledger: { backend: "postgres" },
      }),
    /ledger.backend must be sqlite\|mongodb/,
  );
  assert.equal(
    validateMissionConfig({ ...loadMissionConfig(EXAMPLE_CONFIG), ledger: { backend: "sqlite" } })
      .ledger?.backend,
    "sqlite",
  );
});

test("openLedger returns a sqlite ledger without MONGODB_URI and a controller runs on it", async () => {
  const runs = tempRunsRoot();
  const paths = missionPaths("backend-sqlite", runs);
  const ledger = await openLedger({ missionId: "backend-sqlite" }, paths, {});
  assert.equal(ledger.backend, "sqlite");
  assert.ok(ledger instanceof SqliteLedger);
  await ledger.close();

  const controller = controllerFor("backend-sqlite", runs);
  await controller.initialize();
  assert.equal(controller.ledger.backend, "sqlite");
  const created = await controller.ledger.findEvent("mission:backend-sqlite:created");
  assert.equal((created?.payload as { ledgerBackend: string }).ledgerBackend, "sqlite");
  await controller.close();
});

test("a controller whose lease is taken over stops with LeaseError and the new owner's state is untouched", async () => {
  const runs = tempRunsRoot();
  const missionId = "backend-fence";
  const controller = controllerFor(missionId, runs, { leaseOwner: "victim", leaseTtlMs: 2_000 });
  await controller.initialize();
  const running = controller.run();
  await new Promise((r) => setTimeout(r, 300));

  // Another controller (a later clock, so the victim's lease looks expired) claims a newer fencing token.
  const other = new SqliteLedger(missionPaths(missionId, runs).db);
  const takeover = await other.claimLease(
    missionId,
    "usurper",
    60_000,
    new Date(Date.now() + 10 * 60_000),
  );
  assert.equal(takeover.fencingToken, 2);
  await other.updateMission(missionId, { status: "blocked" });

  await assert.rejects(running, LeaseError);
  const mission = await other.getMission(missionId);
  assert.equal(
    mission?.status,
    "blocked",
    "the fenced-out controller wrote nothing after takeover",
  );
  assert.equal((await other.getLease(missionId))?.owner, "usurper");
  await controller.close();
  await other.releaseLease(takeover);
  await other.close();
});

const mongoEnv = readMongoEnv();
const mongoTest = mongoEnv ? test : test.skip;
if (!mongoEnv) console.log("# MONGODB_URI unset: mongodb runtime path skipped");

mongoTest(
  "mongodb runtime: create, crash, resume, compare-style reads and live gate run against MongoLedger",
  async () => {
    const env = { uri: mongoEnv!.uri, db: `horizon_test_${randomUUID().slice(0, 8)}` };
    const missionId = "backend-mongo";
    const runs = tempRunsRoot();
    const paths = missionPaths(missionId, runs);
    const config = testConfig(missionId, { ledger: { backend: "mongodb" } });
    const open = (options: { crashAt?: string; maxCycles?: number } = {}) =>
      new MissionController(config, paths, {
        memory: new LocalMemoryAdapter(),
        ledger: () => MongoLedger.connect(env, missionId),
        ...options,
      });
    const teardown = await MongoLedger.connect(env, "teardown");
    try {
      const first = open({ crashAt: "snapshot_ready", maxCycles: 1 });
      await first.initialize();
      assert.equal(first.ledger.backend, "mongodb");
      await assert.rejects(first.run(), SimulatedCrash);
      const interrupted = (await first.ledger.listExperiments(missionId)).find(
        (e) => e.taskId === "optimize-search",
      )!;
      assert.equal(interrupted.status, "snapshot_ready");
      assert.equal(await first.ledger.getLease(missionId), undefined, "crash released the lease");
      await first.close();

      const second = open();
      const row = await second.run();
      assert.equal(row.status, "succeeded");
      const after = (await second.ledger.getExperiment(interrupted.experimentId))!;
      assert.equal(after.candidateArtifactHash, interrupted.candidateArtifactHash);
      assert.ok(["accepted", "rejected", "inconclusive"].includes(after.status));
      const events = await second.ledger.eventsSince(0, 10_000);
      assert.ok(events.some((e) => e.type === "controller.recovered"));
      assert.ok((await second.ledger.countCheckpoints(missionId)) >= 6);
      assert.ok((await second.ledger.listSegments(missionId)).every((s) => s.committed));

      const summary = await summarize(second.ledger, config);
      assert.equal(summary.mission?.status, "succeeded");
      const gate = await evaluateLiveGate(second.ledger, config);
      assert.equal(gate.missionId, missionId);
      assert.ok(gate.checks.length > 0);
      await second.close();
    } finally {
      await teardown.db.dropDatabase();
      await teardown.close();
    }
  },
);
