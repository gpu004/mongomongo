import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { MongoClient } from "mongodb";
import { SimulatedCrash } from "../src/controller.ts";
import { Ledger } from "../src/ledger.ts";
import {
  LeaseHeldError,
  LeaseLostError,
  LedgerUnavailableError,
  type LedgerStore,
  SqliteLedgerStore,
} from "../src/ledger-store.ts";
import { MongoLedgerStore } from "../src/mongo-ledger.ts";
import { missionPaths } from "../src/mission-paths.ts";
import { openMissionStore } from "../src/open-ledger.ts";
import { controllerFor, testConfig } from "./helpers.ts";

const MONGO_URI = process.env.MONGODB_TEST_URI;
const skipMongo = MONGO_URI
  ? false
  : "MONGODB_TEST_URI not set (needs a replica set for transactions)";
const DB = `horizon_test_${process.pid}_${Date.now()}`;

after(async () => {
  if (!MONGO_URI) return;
  const client = await MongoClient.connect(MONGO_URI);
  await client.db(DB).dropDatabase();
  await client.close();
});

function mongoStore(missionId: string): Promise<MongoLedgerStore> {
  return MongoLedgerStore.connect({ uri: MONGO_URI!, dbName: DB, missionId });
}

function sqliteStore(): LedgerStore {
  return new SqliteLedgerStore(
    new Ledger(join(mkdtempSync(join(tmpdir(), "horizon-store-")), "state.sqlite")),
  );
}

const MISSION = {
  contractVersion: 1,
  contractHash: "c".repeat(64),
  evaluatorHash: "e".repeat(64),
  environmentHash: "n".repeat(64),
  status: "ready" as const,
  seedArtifactHash: null,
  baselineP95Ms: null,
  bestArtifactHash: null,
  bestP95Ms: null,
  activeTaskId: null,
  nextWakeAt: null,
};

/** The same sequence must produce the same observable state on every backend. */
async function contract(store: LedgerStore, missionId: string): Promise<void> {
  await store.createMission({ missionId, ...MISSION });
  await assert.rejects(store.createMission({ missionId, ...MISSION }), /already exists|UNIQUE/);

  const seq = await store.appendEvent("k1", "mission_created", missionId, { a: 1 });
  assert.equal(
    await store.appendEvent("k1", "mission_created", missionId, { a: 1 }),
    seq,
    "duplicate event keys are idempotent",
  );
  const seq2 = await store.appendEvent("k2", "note", missionId, { b: 2 });
  assert.ok(seq2 > seq, "events are ordered");
  assert.deepEqual(
    (await store.eventsSince(seq)).map((e) => e.eventKey),
    ["k2"],
  );
  assert.equal(await store.lastEventSeq(), seq2);

  await store.insertExperiment({
    experimentId: "x1",
    missionId,
    taskId: "t",
    parentArtifactHash: "a".repeat(64),
    strategy: "s",
    hypothesis: "h",
    status: "planned",
    attempt: 1,
    segmentOrdinal: 0,
  });
  await store.updateExperiment("x1", {
    status: "accepted",
    verdict: "accepted",
    reportIds: ["r1"],
  });
  const x1 = await store.getExperiment("x1");
  assert.equal(x1?.status, "accepted");
  assert.deepEqual(x1?.reportIds, ["r1"]);

  await assert.rejects(
    store.transaction(async () => {
      await store.updateMission(missionId, { bestP95Ms: 1, spentExperiments: 1 });
      await store.appendEvent("k-rolled-back", "accepted", missionId, {});
      throw new Error("crash before commit");
    }),
    /crash before commit/,
  );
  assert.equal(
    (await store.getMission(missionId))?.bestP95Ms,
    null,
    "a failed transition leaves no partial state",
  );
  assert.equal(await store.findEvent("k-rolled-back"), undefined);

  await store.transaction(async () => {
    await store.updateMission(missionId, {
      bestP95Ms: 2,
      bestArtifactHash: "b".repeat(64),
      spentExperiments: 1,
    });
    await store.writeCheckpoint({
      missionId,
      missionStatus: "running",
      activeTaskId: "t",
      activeExperimentId: null,
      activeOperation: null,
      segmentOrdinal: 0,
      bestArtifactHash: "b".repeat(64),
    });
  });
  const mission = await store.getMission(missionId);
  assert.equal(mission?.bestP95Ms, 2);
  assert.equal(mission?.spentExperiments, 1);
  assert.equal((await store.latestCheckpoint(missionId))?.bestArtifactHash, "b".repeat(64));
  assert.equal(await store.countCheckpoints(missionId), 1);

  const base = {
    missionId,
    experimentId: "x1",
    version: 1,
    supersedes: null,
    featureIds: [],
    invariantIds: [],
    artifactHash: "b".repeat(64),
    parentArtifactHash: "a".repeat(64),
    interpretation: "verified" as const,
    evidenceIds: [],
    createdAt: new Date().toISOString(),
  };
  await store.insertEpisode({
    ...base,
    episodeId: "ep1",
    summary: "posting index cache rejected on timing noise",
  });
  await store.insertEpisode({ ...base, episodeId: "ep2", summary: "tokenizer rewrite accepted" });
  await store.insertEpisode({
    ...base,
    episodeId: "ep1b",
    version: 2,
    supersedes: "ep1",
    summary: "posting index cache accepted after re-measurement",
  });
  const hits = await store.searchEpisodes(missionId, "posting index cache", 5);
  assert.ok(hits.length >= 1 && hits.length <= 5, "retrieval is bounded");
  assert.ok(hits.some((h) => h.episodeId === "ep1b"));
  assert.ok(!hits.some((h) => h.episodeId === "ep2"), "unrelated episodes do not match");
  assert.equal(await store.isSuperseded("ep1"), true);
  assert.equal((await store.currentVersionOf("ep1"))?.episodeId, "ep1b");

  const key = await store.enqueueOutbox("ep1b", { episodeId: "ep1b" });
  assert.equal(
    await store.enqueueOutbox("ep1b", { episodeId: "ep1b" }),
    key,
    "outbox enqueue is idempotent",
  );
  assert.equal((await store.listOutbox(["pending"])).length, 1);
  await store.updateOutbox(key, { state: "memory_ready", remoteDocumentId: "doc-1" });
  assert.equal((await store.listOutbox(["pending"])).length, 0);

  await store.beginOperation({
    operationId: "op1",
    missionId,
    kind: "verify",
    experimentId: "x1",
    sandboxId: null,
    detail: "correctness",
  });
  await store.beginOperation({
    operationId: "op1",
    missionId,
    kind: "verify",
    experimentId: "x1",
    sandboxId: null,
    detail: "correctness",
  });
  assert.equal(
    (await store.listOperations(missionId, ["started"])).length,
    1,
    "operation intents are idempotent",
  );
  await store.finishOperation("op1", "completed", "reports/r1.json");
  assert.equal((await store.getOperation("op1"))?.state, "completed");
  assert.equal((await store.listOperations(missionId, ["started"])).length, 0);
}

test("ledger contract: sqlite store", async () => {
  const store = sqliteStore();
  await contract(store, "contract-sqlite");
  await store.close();
});

test("ledger contract: mongodb store", { skip: skipMongo }, async () => {
  const store = await mongoStore("contract-mongo");
  await contract(store, "contract-mongo");
  await store.close();
});

test(
  "mongodb lease: a second controller is refused; after expiry the stale owner's writes are fenced",
  { skip: skipMongo },
  async () => {
    const a = await mongoStore("lease-mission");
    const b = await mongoStore("lease-mission");
    const leaseA = await a.acquireLease("controller-a", 400);
    await a.createMission({ missionId: "lease-mission", ...MISSION });
    await assert.rejects(b.acquireLease("controller-b", 60_000), LeaseHeldError);
    assert.equal(await a.renewLease(), true);

    await new Promise((r) => setTimeout(r, 600));
    const leaseB = await b.acquireLease("controller-b", 60_000);
    assert.ok(leaseB.token > leaseA.token, "takeover increments the fencing token");
    await assert.rejects(a.updateMission("lease-mission", { status: "running" }), LeaseLostError);
    await assert.rejects(
      a.transaction(async () => a.appendEvent("stale", "x", "lease-mission", {})),
      LeaseLostError,
    );
    assert.equal(await a.renewLease(), false);
    assert.equal(await b.findEvent("stale"), undefined, "no stale-owner write landed");
    await b.updateMission("lease-mission", { status: "running" });
    assert.equal((await b.getMission("lease-mission"))?.status, "running");
    await a.close();
    await b.close();
  },
);

test("atlas connection failure is a LedgerUnavailableError with credentials redacted", async () => {
  await assert.rejects(
    MongoLedgerStore.connect({
      uri: "mongodb://horizon:s3cr3t-pw@127.0.0.1:9/?serverSelectionTimeoutMS=500&connectTimeoutMS=500",
      dbName: "x",
      missionId: "m",
    }),
    (error: unknown) => {
      assert.ok(error instanceof LedgerUnavailableError);
      assert.doesNotMatch(error.message, /s3cr3t-pw/);
      return true;
    },
  );
});

test("a mongodb mission without MONGODB_URI refuses to start and does not fall back to SQLite", async () => {
  const runs = mkdtempSync(join(tmpdir(), "horizon-nofallback-"));
  const config = testConfig("no-fallback", { ledger: { backend: "mongodb" } });
  const paths = missionPaths("no-fallback", runs);
  await assert.rejects(openMissionStore(config, paths, {}), LedgerUnavailableError);
  assert.equal(existsSync(paths.db), false, "no SQLite ledger was created");
});

test(
  "mongodb mission: full run, then crash between report publication and commit reconciles without rerun",
  { skip: skipMongo },
  async () => {
    const runs = mkdtempSync(join(tmpdir(), "horizon-mongo-run-"));
    const first = controllerFor(
      "mongo-run",
      runs,
      {
        store: await mongoStore("mongo-run"),
        crashAt: "report-written:optimize:learned",
        maxCycles: 2,
      },
      { ledger: { backend: "mongodb", database: DB } },
    );
    await first.initialize();
    await assert.rejects(first.run(), SimulatedCrash);
    await first.close();
    const probe = await mongoStore("mongo-run");
    const before = await probe.listVerifications("mongo-run");
    await probe.close();

    const second = controllerFor(
      "mongo-run",
      runs,
      { store: await mongoStore("mongo-run") },
      { ledger: { backend: "mongodb", database: DB } },
    );
    await second.initialize();
    const outcome = await second.run();
    assert.equal(outcome.status, "succeeded");
    const verifications = await second.ledger.listVerifications("mongo-run");
    assert.ok(verifications.length > before.length);
    const keys = verifications.map((v) => `${v.experimentId}:${v.artifactHash}:${v.suite}`);
    assert.equal(
      new Set(keys).size,
      keys.length,
      "no duplicate verification for the same identity",
    );
    assert.deepEqual(
      await second.ledger.listOperations("mongo-run", ["started"]),
      [],
      "no unfinished operation intents remain",
    );
    assert.equal((await second.ledger.countCheckpoints("mongo-run")) > 0, true);
    await second.close();
  },
);

test(
  "mongodb mission: a second controller cannot run a leased mission",
  { skip: skipMongo },
  async () => {
    const runs = mkdtempSync(join(tmpdir(), "horizon-mongo-lease-"));
    const holder = await mongoStore("mongo-busy");
    await holder.acquireLease("other-host:1", 60_000);
    const controller = controllerFor(
      "mongo-busy",
      runs,
      { store: await mongoStore("mongo-busy") },
      { ledger: { backend: "mongodb", database: DB } },
    );
    await assert.rejects(
      controller.initialize().then(() => controller.run()),
      LeaseHeldError,
    );
    await controller.close();
    await holder.close();
  },
);
