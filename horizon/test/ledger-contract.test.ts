import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { VerificationReport } from "../verification/reports.ts";
import { LeaseError, type AsyncLedger } from "../src/ledger-contract.ts";
import type { EpisodeRow } from "../src/ledger.ts";
import { readMongoEnv } from "../src/mongo-env.ts";
import { MongoLedger, RECENT_EPISODE_WINDOW } from "../src/mongo-ledger.ts";
import { probeMongo } from "../src/mongo-probe.ts";
import { SqliteLedger } from "../src/sqlite-ledger.ts";

const MISSION = "contract-mission";

interface Backend {
  name: "sqlite" | "mongodb";
  /** Fresh, empty ledger. Two ledgers opened by the same backend share storage (two controllers, one mission). */
  open(): Promise<AsyncLedger>;
  teardown(): Promise<void>;
}

const sqliteBackend = (): Backend => {
  const dir = mkdtempSync(join(tmpdir(), "horizon-ledger-contract-"));
  return {
    name: "sqlite",
    open: async () => new SqliteLedger(join(dir, "state.sqlite")),
    teardown: async () => {},
  };
};

const mongoEnv = readMongoEnv();
const mongoBackend = (): Backend => {
  const env = { uri: mongoEnv!.uri, db: `horizon_test_${randomUUID().slice(0, 8)}` };
  return {
    name: "mongodb",
    open: () => MongoLedger.connect(env, MISSION),
    teardown: () => dropDatabase(env),
  };
};

async function dropDatabase(env: { uri: string; db: string }) {
  const ledger = await MongoLedger.connect(env, "teardown");
  try {
    await ledger.db.dropDatabase();
  } finally {
    await ledger.close();
  }
}

const backends: (() => Backend)[] = [sqliteBackend];
if (mongoEnv) backends.push(mongoBackend);
else console.log("# MONGODB_URI unset: ledger contract runs against sqlite only");

function mission(ledger: AsyncLedger, missionId = MISSION) {
  return ledger.createMission({
    missionId,
    contractVersion: 1,
    contractHash: "c".repeat(64),
    evaluatorHash: "e".repeat(64),
    environmentHash: "n".repeat(64),
    status: "ready",
    seedArtifactHash: "seed",
    baselineP95Ms: 10,
    bestArtifactHash: "seed",
    bestP95Ms: 10,
    activeTaskId: null,
    nextWakeAt: null,
    frozenAcceptanceMargin: null,
  });
}

function episode(id: string, summary: string, extra: Partial<EpisodeRow> = {}): EpisodeRow {
  return {
    episodeId: id,
    missionId: MISSION,
    experimentId: `exp-${id}`,
    version: 1,
    supersedes: null,
    featureIds: ["search"],
    invariantIds: [],
    artifactHash: "a".repeat(64),
    parentArtifactHash: "seed",
    interpretation: "verified",
    evidenceIds: [],
    summary,
    createdAt: new Date(2026, 0, 1, 0, 0, Number(id.replace(/\D/g, "")) || 0).toISOString(),
    ...extra,
  };
}

function report(reportId: string, experimentId: string, suite: "smoke" | "performance" = "smoke") {
  return {
    schemaVersion: 1,
    reportId,
    missionId: MISSION,
    experimentId,
    artifactHash: "a".repeat(64),
    evaluatorHash: "e".repeat(64),
    workloadHash: "w".repeat(64),
    environmentHash: "n".repeat(64),
    suite,
    status: "passed",
    assertions: [],
    metrics: { p95LatencyMs: 7.5 },
    evidenceIds: [],
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:01.000Z",
    isolation: "subprocess",
  } satisfies VerificationReport;
}

for (const makeBackend of backends) {
  const label = makeBackend().name;

  test(`[${label}] rows round-trip and unique keys are enforced`, async () => {
    const backend = makeBackend();
    const ledger = await backend.open();
    try {
      await mission(ledger);
      assert.equal((await ledger.getMission(MISSION))?.status, "ready");
      await assert.rejects(mission(ledger), /duplicate|UNIQUE/i);

      await ledger.updateMission(MISSION, { status: "running", spentExperiments: 2 });
      await ledger.updateMission(MISSION, {});
      const row = await ledger.getMission(MISSION);
      assert.equal(row?.status, "running");
      assert.equal(row?.spentExperiments, 2);
      assert.equal(row?.spentWallMs, 0);

      const task = {
        taskId: "t1",
        missionId: MISSION,
        ordinal: 1,
        dependsOn: [],
        status: "pending" as const,
        hypothesis: "h",
        completionCriteria: "c",
        nextAction: "n",
      };
      await ledger.upsertTask(task);
      await ledger.upsertTask({ ...task, status: "active", completionCriteria: "ignored" });
      assert.deepEqual(await ledger.listTasks(MISSION), [{ ...task, status: "active" }]);

      await ledger.insertExperiment({
        experimentId: "exp-1",
        missionId: MISSION,
        taskId: "t1",
        parentArtifactHash: "seed",
        strategy: "s",
        hypothesis: "h",
        status: "planned",
        attempt: 1,
        segmentOrdinal: 1,
      });
      await assert.rejects(
        ledger.insertExperiment({
          experimentId: "exp-1",
          missionId: MISSION,
          taskId: "t1",
          parentArtifactHash: "seed",
          strategy: "s",
          hypothesis: "h",
          status: "planned",
          attempt: 1,
          segmentOrdinal: 1,
        }),
        /duplicate|UNIQUE/i,
      );
      await ledger.updateExperiment("exp-1", { status: "accepted", reportIds: ["r1"] });
      const exp = await ledger.getExperiment("exp-1");
      assert.equal(exp?.status, "accepted");
      assert.deepEqual(exp?.reportIds, ["r1"]);
      assert.equal(exp?.verdict, null);
      assert.equal((await ledger.listExperiments(MISSION)).length, 1);

      const artifact = {
        hash: "a".repeat(64),
        path: "/tmp/a",
        parentHash: null,
        manifestHash: "m",
        createdAt: "2026-01-01T00:00:00.000Z",
      };
      await ledger.insertArtifact(artifact);
      await ledger.insertArtifact({ ...artifact, path: "/tmp/other" });
      assert.deepEqual(await ledger.getArtifact(artifact.hash), artifact);

      await ledger.insertVerification(report("r1", "exp-1"), "/tmp/r1.json");
      await ledger.insertVerification(report("r1-dup", "exp-1"), "/tmp/r1-dup.json");
      await ledger.insertVerification(report("r2", "exp-1", "performance"), "/tmp/r2.json");
      const verifications = await ledger.listVerifications(MISSION);
      assert.deepEqual(
        verifications.map((v) => v.reportId),
        ["r1", "r2"],
        "same identity tuple is recorded once",
      );
      assert.equal(
        (await ledger.findVerification("exp-1", "a".repeat(64), "smoke"))?.reportId,
        "r1",
      );
      assert.equal(verifications[0]?.p95LatencyMs, 7.5);

      const lesson = {
        lessonId: "l1",
        missionId: MISSION,
        sourceEpisodeIds: ["ep-1"],
        invariantId: "inv",
        state: "observed" as const,
        proposal: "p",
        positiveEvidenceId: null,
        negativeEvidenceId: null,
        materializedScenarioId: null,
        transitions: [],
      };
      await ledger.upsertLesson(lesson);
      await ledger.upsertLesson({ ...lesson, state: "validated", positiveEvidenceId: "ev" });
      assert.deepEqual(await ledger.listLessons(MISSION), [
        { ...lesson, state: "validated", positiveEvidenceId: "ev" },
      ]);
      await ledger.insertLearnedScenario("sc-1", MISSION, "l1", 1, "/tmp/sc.json");
      assert.deepEqual(await ledger.listLearnedScenarios(MISSION), [
        { scenarioId: "sc-1", lessonId: "l1", suiteVersion: 1, path: "/tmp/sc.json" },
      ]);

      await ledger.registerContainer("horizon-c1", MISSION, "e1");
      await ledger.registerContainer("horizon-c1", MISSION, "e1");
      await ledger.registerContainer("horizon-c2", MISSION, "e1");
      assert.deepEqual(
        (await ledger.listLiveContainers(MISSION)).map((c) => c.containerName),
        ["horizon-c1", "horizon-c2"],
      );
      await ledger.releaseContainer("horizon-c1");
      await ledger.releaseContainer("horizon-c1", "orphan_removed");
      await ledger.releaseContainer("horizon-c2", "orphan_removed");
      assert.deepEqual(await ledger.listLiveContainers(MISSION), []);
      const containers = await ledger.listContainers(MISSION);
      assert.deepEqual(
        containers.map((c) => [c.containerName, c.experimentId, c.state, c.releasedAt !== null]),
        [
          ["horizon-c1", "e1", "released", true],
          ["horizon-c2", "e1", "orphan_removed", true],
        ],
      );
    } finally {
      await ledger.close();
      await backend.teardown();
    }
  });

  test(`[${label}] events, checkpoints and segments keep mission sequence numbers`, async () => {
    const backend = makeBackend();
    const ledger = await backend.open();
    try {
      await mission(ledger);
      assert.equal(await ledger.lastEventSeq(), 0);
      const first = await ledger.appendEvent("k1", "mission.created", MISSION, { a: 1 });
      const again = await ledger.appendEvent("k1", "mission.created", MISSION, { a: 999 });
      const second = await ledger.appendEvent("k2", "experiment.planned", "exp-1", null);
      assert.equal(first, 1);
      assert.equal(again, 1, "duplicate event key returns the existing seq");
      assert.equal(second, 2);
      assert.deepEqual((await ledger.findEvent("k1"))?.payload, { a: 1 });
      assert.deepEqual(
        (await ledger.eventsSince(0)).map((e) => [e.seq, e.eventKey]),
        [
          [1, "k1"],
          [2, "k2"],
        ],
      );
      assert.equal((await ledger.eventsSince(1, 1)).length, 1);
      assert.equal(await ledger.lastEventSeq(), 2);

      const ckpt = await ledger.writeCheckpoint({
        missionId: MISSION,
        missionStatus: "running",
        activeTaskId: "t1",
        activeExperimentId: null,
        activeOperation: null,
        segmentOrdinal: 1,
        bestArtifactHash: "seed",
      });
      assert.equal(ckpt.seq, 1);
      assert.equal(ckpt.lastEventSeq, 2);
      assert.equal(ckpt.checkpointId, `ckpt-${MISSION}-000001`);
      const ckpt2 = await ledger.writeCheckpoint({ ...ckpt, activeTaskId: null });
      assert.equal(ckpt2.seq, 2);
      assert.equal((await ledger.latestCheckpoint(MISSION))?.checkpointId, ckpt2.checkpointId);
      assert.equal(await ledger.countCheckpoints(MISSION), 2);

      await ledger.openSegment(MISSION, 1, "/tmp/s1", "sess-1");
      assert.equal(
        await ledger.activeSegment(MISSION),
        undefined,
        "uncommitted segment is not active",
      );
      await ledger.openSegment(MISSION, 2, null, null);
      assert.equal(await ledger.discardUncommittedSegments(MISSION), 2);
      await ledger.openSegment(MISSION, 1, "/tmp/s1", "sess-1");
      await ledger.commitSegment(MISSION, 1, ckpt2.checkpointId);
      const active = await ledger.activeSegment(MISSION);
      assert.equal(active?.ordinal, 1);
      assert.equal(active?.checkpointId, ckpt2.checkpointId);
      assert.equal(active?.firstEventSeq, 2);
      await ledger.appendEvent("k3", "segment.rotated", MISSION, {});
      await ledger.closeSegment(MISSION, 1, "arch");
      const [closed] = await ledger.listSegments(MISSION);
      assert.equal(closed?.lastEventSeq, 3);
      assert.equal(closed?.archiveHash, "arch");
      assert.equal(await ledger.activeSegment(MISSION), undefined);
    } finally {
      await ledger.close();
      await backend.teardown();
    }
  });

  test(`[${label}] episodes, outbox idempotency and backend-neutral search`, async () => {
    const backend = makeBackend();
    const ledger = await backend.open();
    try {
      await mission(ledger);
      await ledger.insertEpisode(episode("ep-1", "normalized cache invalidation kept p95 flat"));
      await ledger.insertEpisode(episode("ep-1", "duplicate insert is ignored"));
      await ledger.insertEpisode(episode("ep-2", "posting list intersection reduced p95"));
      await ledger.insertEpisode(
        episode("ep-3", "posting list intersection v2 reduced p95 further", {
          version: 2,
          supersedes: "ep-2",
        }),
      );
      assert.equal(
        (await ledger.getEpisode("ep-1"))?.summary,
        "normalized cache invalidation kept p95 flat",
      );
      assert.deepEqual(
        (await ledger.listEpisodes(MISSION)).map((e) => e.episodeId),
        ["ep-1", "ep-2", "ep-3"],
      );
      assert.equal(await ledger.isSuperseded("ep-2"), true);
      assert.equal(await ledger.isSuperseded("ep-3"), false);
      assert.equal((await ledger.currentVersionOf("ep-2"))?.episodeId, "ep-3");

      const key = await ledger.enqueueOutbox("ep-1", { summary: "x" });
      assert.equal(await ledger.enqueueOutbox("ep-1", { summary: "x" }), key);
      const key2 = await ledger.enqueueOutbox("ep-1", { summary: "y" });
      assert.notEqual(key2, key);
      assert.equal((await ledger.listOutbox()).length, 2);
      assert.deepEqual(await ledger.outboxPayload(key), { summary: "x" });
      assert.deepEqual(await ledger.outboxPayloadForEpisode("ep-1"), { summary: "y" });
      assert.equal(await ledger.isIndexed("ep-1"), false);
      await ledger.updateOutbox(key, { state: "memory_ready", remoteDocumentId: "doc-1" });
      await ledger.updateOutbox(key2, { state: "failed", retries: 1, lastError: "boom" });
      assert.equal(await ledger.isIndexed("ep-1"), true);
      const failed = await ledger.listOutbox(["failed"]);
      assert.equal(failed.length, 1);
      assert.equal(failed[0]?.retries, 1);
      assert.equal(failed[0]?.lastError, "boom");
      assert.equal((await ledger.listOutbox(["pending", "memory_ready"])).length, 1);

      const hits = await ledger.searchEpisodes(MISSION, "posting list intersection", 10);
      assert.deepEqual(hits.map((e) => e.episodeId).sort(), ["ep-2", "ep-3"]);
      const pending = await ledger.searchEpisodes(MISSION, "p95 cache posting", 10, {
        unindexedOnly: true,
      });
      assert.ok(!pending.some((e) => e.episodeId === "ep-1"), "memory_ready episodes are excluded");
      assert.deepEqual(await ledger.searchEpisodes(MISSION, "", 10), []);
      assert.deepEqual(await ledger.searchEpisodes(MISSION, "nothing-matches-here", 10), []);
      const weights = await ledger.termWeights(["p95", "unseen"]);
      assert.ok((weights.get("unseen") ?? 0) > (weights.get("p95") ?? 0), "rarer terms weigh more");
    } finally {
      await ledger.close();
      await backend.teardown();
    }
  });

  test(`[${label}] transactions commit acceptance changes together or not at all`, async () => {
    const backend = makeBackend();
    const ledger = await backend.open();
    try {
      await mission(ledger);
      await ledger.insertExperiment({
        experimentId: "exp-1",
        missionId: MISSION,
        taskId: "t1",
        parentArtifactHash: "seed",
        strategy: "s",
        hypothesis: "h",
        status: "evaluating",
        attempt: 1,
        segmentOrdinal: 1,
      });

      await assert.rejects(
        ledger.transaction(async (tx) => {
          await tx.updateExperiment("exp-1", { status: "accepted" });
          await tx.updateMission(MISSION, { spentExperiments: 1, bestArtifactHash: "cand" });
          await tx.appendEvent("accept-1", "experiment.accepted", "exp-1", {});
          throw new Error("simulated crash before commit");
        }),
        /simulated crash/,
      );
      assert.equal((await ledger.getExperiment("exp-1"))?.status, "evaluating");
      assert.equal((await ledger.getMission(MISSION))?.spentExperiments, 0);
      assert.equal(await ledger.findEvent("accept-1"), undefined);
      assert.equal(await ledger.lastEventSeq(), 0, "aborted sequence allocation is rolled back");

      const commit = async () =>
        ledger.transaction(async (tx) => {
          if (await tx.findEvent("accept-1")) return "duplicate";
          await tx.updateExperiment("exp-1", { status: "accepted" });
          await tx.updateMission(MISSION, { spentExperiments: 1, bestArtifactHash: "cand" });
          await tx.appendEvent("accept-1", "experiment.accepted", "exp-1", {});
          await tx.writeCheckpoint({
            missionId: MISSION,
            missionStatus: "running",
            activeTaskId: null,
            activeExperimentId: null,
            activeOperation: null,
            segmentOrdinal: 1,
            bestArtifactHash: "cand",
          });
          return "committed";
        });
      assert.equal(await commit(), "committed");
      assert.equal(await commit(), "duplicate", "replaying the same acceptance is a no-op");
      assert.equal((await ledger.getExperiment("exp-1"))?.status, "accepted");
      assert.equal((await ledger.getMission(MISSION))?.spentExperiments, 1);
      assert.equal(await ledger.lastEventSeq(), 1);
      assert.equal(await ledger.countCheckpoints(MISSION), 1);
    } finally {
      await ledger.close();
      await backend.teardown();
    }
  });

  test(`[${label}] competing controllers: one lease owner, monotonic fencing token, stale writes rejected`, async () => {
    const backend = makeBackend();
    const a = await backend.open();
    const b = await backend.open();
    try {
      await mission(a);
      const t0 = new Date("2026-01-01T00:00:00.000Z");
      const leaseA = await a.claimLease(MISSION, "controller-a", 60_000, t0);
      assert.equal(leaseA.fencingToken, 1);
      assert.equal(leaseA.expiresAt, "2026-01-01T00:01:00.000Z");

      await assert.rejects(
        b.claimLease(MISSION, "controller-b", 60_000, new Date(t0.getTime() + 1000)),
        (error: unknown) => error instanceof LeaseError && error.holder?.owner === "controller-a",
      );
      assert.equal((await b.getLease(MISSION))?.owner, "controller-a");

      const renewed = await a.renewLease(leaseA, 60_000, new Date(t0.getTime() + 30_000));
      assert.equal(renewed.expiresAt, "2026-01-01T00:01:30.000Z");
      await a.updateMission(MISSION, { status: "running" });

      const leaseB = await b.claimLease(
        MISSION,
        "controller-b",
        60_000,
        new Date(t0.getTime() + 91_000),
      );
      assert.equal(leaseB.fencingToken, 2, "takeover after expiry increments the fencing token");
      assert.equal(leaseB.owner, "controller-b");

      await assert.rejects(a.renewLease(renewed, 60_000), LeaseError);
      await assert.rejects(a.updateMission(MISSION, { status: "failed" }), LeaseError);
      await assert.rejects(a.appendEvent("stale", "x", MISSION, {}), LeaseError);
      await assert.rejects(
        a.transaction(async (tx) => {
          await tx.updateExperiment("none", { status: "accepted" });
        }),
        LeaseError,
      );
      assert.equal((await b.getMission(MISSION))?.status, "running", "stale owner changed nothing");
      assert.equal(await b.findEvent("stale"), undefined);

      await b.updateMission(MISSION, { status: "succeeded" });
      assert.equal((await a.getMission(MISSION))?.status, "succeeded");

      await a.releaseLease(renewed);
      assert.equal((await b.getLease(MISSION))?.owner, "controller-b", "stale release is ignored");
      await b.releaseLease(leaseB);
      assert.equal(await b.getLease(MISSION), undefined);

      const leaseA2 = await a.claimLease(MISSION, "controller-a", 60_000);
      assert.equal(leaseA2.fencingToken, 3, "tokens never reuse a value");
      const sameOwner = await a.claimLease(MISSION, "controller-a", 60_000);
      assert.equal(sameOwner.fencingToken, 4);
    } finally {
      await a.close();
      await b.close();
      await backend.teardown();
    }
  });
}

test(
  "[mongodb] doctor probe writes, transacts, indexes and cleans up",
  { skip: !mongoEnv },
  async () => {
    const env = { uri: mongoEnv!.uri, db: `horizon_test_${randomUUID().slice(0, 8)}` };
    const result = await probeMongo(env);
    assert.equal(result.error, null);
    assert.equal(result.roundTrip, "ok");
    assert.equal(result.transactions, "ok");
    assert.deepEqual(result.missingIndexes, []);
    assert.equal(result.cleanedUp, true);
    assert.equal(result.ok, true);
    assert.ok(!result.target.includes("@"), "target never carries credentials");
    const ledger = await MongoLedger.connect(env, "probe-cleanup");
    try {
      assert.equal(await ledger.db.collection("doctor_probe").countDocuments(), 0);
    } finally {
      await ledger.close();
      await dropDatabase(env);
    }
  },
);

test("[mongodb] search window is bounded", { skip: !mongoEnv }, async () => {
  const backend = mongoBackend();
  const ledger = await backend.open();
  try {
    await mission(ledger);
    const total = RECENT_EPISODE_WINDOW + 5;
    for (let i = 0; i < total; i += 1)
      await ledger.insertEpisode(
        episode(`ep-${i}`, i < 5 ? "ancient rare term" : "recent common term"),
      );
    const ancient = await ledger.searchEpisodes(MISSION, "ancient", 10);
    assert.equal(ancient.length, 0, "episodes older than the window are not searched locally");
    const recent = await ledger.searchEpisodes(MISSION, "recent", 3);
    assert.equal(recent.length, 3);
  } finally {
    await ledger.close();
    await backend.teardown();
  }
});
