import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { type EpisodeRow, type Ledger, SqliteLedger } from "../src/ledger.ts";
import { LeaseLostError, MongoLedger, type MongoSettings } from "../src/mongo-ledger.ts";
import { type MongoFixture, startMongo } from "./mongo-fixture.ts";

const MISSION = "contract";

function episode(id: string, summary: string, extra: Partial<EpisodeRow> = {}): EpisodeRow {
  return {
    episodeId: id,
    missionId: MISSION,
    experimentId: `exp-${id}`,
    version: 1,
    supersedes: null,
    featureIds: [],
    invariantIds: [],
    artifactHash: "a".repeat(64),
    parentArtifactHash: "b".repeat(64),
    interpretation: "verified",
    evidenceIds: [],
    summary,
    createdAt: new Date().toISOString(),
    ...extra,
  };
}

async function seedMission(ledger: Ledger): Promise<void> {
  await ledger.createMission({
    missionId: MISSION,
    contractVersion: 1,
    contractHash: "c".repeat(64),
    evaluatorHash: "e".repeat(64),
    environmentHash: "f".repeat(64),
    status: "ready",
    seedArtifactHash: null,
    baselineP95Ms: null,
    bestArtifactHash: null,
    bestP95Ms: null,
    activeTaskId: null,
    nextWakeAt: null,
  });
}

type Open = () => Promise<Ledger>;

/** Behaviors every backend must share; the controller and recovery rely on each of them. */
const CASES: [string, (open: Open) => Promise<void>][] = [
  [
    "mission rows round-trip and partial updates leave other columns intact",
    async (open) => {
      const ledger = await open();
      try {
        await seedMission(ledger);
        await ledger.updateMission(MISSION, { status: "running", spentExperiments: 3 });
        const row = (await ledger.getMission(MISSION))!;
        assert.equal(row.status, "running");
        assert.equal(row.spentExperiments, 3);
        assert.equal(row.contractHash, "c".repeat(64));
        assert.equal(row.learnedSuiteVersion, 0);
        assert.equal(await ledger.getMission("other"), undefined);
      } finally {
        await ledger.close();
      }
    },
  ],

  [
    "events are append-only, idempotent by key, and replayable in sequence order",
    async (open) => {
      const ledger = await open();
      try {
        const a = await ledger.appendEvent("k1", "t", "x", { n: 1 });
        const b = await ledger.appendEvent("k2", "t", "x", { n: 2 });
        const again = await ledger.appendEvent("k1", "t", "x", { n: 999 });
        assert.equal(again, a);
        assert.ok(b > a);
        assert.equal(await ledger.lastEventSeq(), b);
        const since = await ledger.eventsSince(a);
        assert.deepEqual(
          since.map((e) => [e.eventKey, e.payload]),
          [["k2", { n: 2 }]],
        );
        assert.deepEqual((await ledger.findEvent("k1"))?.payload, { n: 1 });
      } finally {
        await ledger.close();
      }
    },
  ],

  [
    "a failed transaction leaves nothing behind; a committed one is visible afterwards",
    async (open) => {
      const ledger = await open();
      try {
        await seedMission(ledger);
        await assert.rejects(
          ledger.transaction(async () => {
            await ledger.updateMission(MISSION, { status: "running" });
            await ledger.appendEvent("boom", "t", "x", {});
            throw new Error("boom");
          }),
          /boom/,
        );
        assert.equal((await ledger.getMission(MISSION))!.status, "ready");
        assert.equal(await ledger.findEvent("boom"), undefined);
        const ckpt = await ledger.transaction(async () => {
          await ledger.updateMission(MISSION, { status: "running" });
          await ledger.appendEvent("ok", "t", "x", {});
          return ledger.writeCheckpoint({
            missionId: MISSION,
            missionStatus: "running",
            activeTaskId: null,
            activeExperimentId: null,
            activeOperation: "planned",
            segmentOrdinal: 1,
            bestArtifactHash: null,
          });
        });
        assert.equal((await ledger.getMission(MISSION))!.status, "running");
        assert.equal(ckpt.lastEventSeq, await ledger.lastEventSeq());
        assert.equal((await ledger.latestCheckpoint(MISSION))?.checkpointId, ckpt.checkpointId);
        assert.equal(await ledger.countCheckpoints(MISSION), 1);
        await assert.rejects(
          ledger.transaction(() => ledger.transaction(async () => {})),
          /cannot nest/,
        );
      } finally {
        await ledger.close();
      }
    },
  ],

  [
    "experiments, verifications and artifacts: idempotent inserts, ordered lists, patch updates",
    async (open) => {
      const ledger = await open();
      try {
        for (const id of ["exp-0001", "exp-0002"]) {
          await ledger.insertExperiment({
            experimentId: id,
            missionId: MISSION,
            taskId: "optimize-search",
            parentArtifactHash: "p".repeat(64),
            strategy: "scripted",
            hypothesis: "h",
            status: "planned",
            attempt: 1,
            segmentOrdinal: 1,
          });
        }
        await ledger.updateExperiment("exp-0001", {
          status: "rejected",
          reportIds: ["r1"],
          failureSignature: "sig",
        });
        const list = await ledger.listExperiments(MISSION);
        assert.deepEqual(
          list.map((e) => e.experimentId),
          ["exp-0001", "exp-0002"],
        );
        assert.deepEqual(list[0]!.reportIds, ["r1"]);
        assert.equal(list[0]!.failureSignature, "sig");
        assert.equal(list[1]!.status, "planned");

        const artifact = {
          hash: "h".repeat(64),
          path: "/x",
          parentHash: null,
          manifestHash: "m".repeat(64),
          createdAt: new Date().toISOString(),
        };
        await ledger.insertArtifact(artifact);
        await ledger.insertArtifact({ ...artifact, path: "/ignored-duplicate" });
        assert.equal((await ledger.getArtifact(artifact.hash))?.path, "/x");
      } finally {
        await ledger.close();
      }
    },
  ],

  [
    "episode search is mission-scoped, ranks rarer terms higher, and can exclude indexed episodes",
    async (open) => {
      const ledger = await open();
      try {
        await ledger.insertEpisode(episode("ep-1", "rejected: posting index loses updates"));
        await ledger.insertEpisode(episode("ep-2", "accepted: posting index with lowercase cache"));
        await ledger.insertEpisode(episode("ep-3", "inconclusive: timing noise on warmup"));
        await ledger.insertEpisode(episode("ep-1", "duplicate insert must be ignored"));
        assert.equal(
          (await ledger.getEpisode("ep-1"))?.summary,
          "rejected: posting index loses updates",
        );

        const hits = await ledger.searchEpisodes(MISSION, "posting index loses", 10);
        assert.deepEqual(
          hits.map((h) => h.episodeId),
          ["ep-1", "ep-2"],
        );
        assert.deepEqual(await ledger.searchEpisodes("other-mission", "posting", 10), []);
        assert.deepEqual(await ledger.searchEpisodes(MISSION, "posting", 0), []);

        const key = await ledger.enqueueOutbox("ep-1", { episodeId: "ep-1" });
        await ledger.updateOutbox(key, { state: "memory_ready", remoteDocumentId: "doc" });
        assert.equal(await ledger.isIndexed("ep-1"), true);
        assert.equal(await ledger.isIndexed("ep-2"), false);
        const pending = await ledger.searchEpisodes(MISSION, "posting index", 10, {
          unindexedOnly: true,
        });
        assert.deepEqual(
          pending.map((h) => h.episodeId),
          ["ep-2"],
        );
        const weights = await ledger.termWeights(["posting", "warmup", "unseen"]);
        assert.ok(weights.get("warmup")! > weights.get("posting")!);
        assert.ok(weights.get("unseen")! > weights.get("warmup")!);
      } finally {
        await ledger.close();
      }
    },
  ],

  [
    "supersession chains resolve to the newest version",
    async (open) => {
      const ledger = await open();
      try {
        await ledger.insertEpisode(episode("v1", "first"));
        await ledger.insertEpisode(episode("v2", "second", { version: 2, supersedes: "v1" }));
        await ledger.insertEpisode(episode("v3", "third", { version: 3, supersedes: "v2" }));
        assert.equal((await ledger.currentVersionOf("v1"))?.episodeId, "v3");
        assert.equal(await ledger.isSuperseded("v1"), true);
        assert.equal(await ledger.isSuperseded("v3"), false);
      } finally {
        await ledger.close();
      }
    },
  ],

  [
    "outbox keys are idempotent per payload and listings follow next attempt time",
    async (open) => {
      const ledger = await open();
      try {
        const k1 = await ledger.enqueueOutbox("ep-1", { v: 1 });
        const k1again = await ledger.enqueueOutbox("ep-1", { v: 1 });
        const k2 = await ledger.enqueueOutbox("ep-1", { v: 2 });
        assert.equal(k1, k1again);
        assert.notEqual(k1, k2);
        assert.deepEqual(await ledger.outboxPayload(k1), { v: 1 });
        assert.deepEqual(await ledger.outboxPayloadForEpisode("ep-1"), { v: 2 });
        await ledger.updateOutbox(k1, {
          state: "failed",
          retries: 1,
          nextAttemptAt: "2999-01-01T00:00:00.000Z",
          lastError: "unavailable",
        });
        const rows = await ledger.listOutbox(["pending", "failed"]);
        assert.deepEqual(
          rows.map((r) => r.idempotencyKey),
          [k2, k1],
        );
        assert.equal((await ledger.listOutbox()).length, 2);
        assert.equal(rows[1]!.lastError, "unavailable");
      } finally {
        await ledger.close();
      }
    },
  ],

  [
    "segments: uncommitted ones are discarded on recovery, committed open ones are active",
    async (open) => {
      const ledger = await open();
      try {
        await ledger.openSegment(MISSION, 1, "/s1", "sess-1");
        await ledger.commitSegment(MISSION, 1, "ckpt-1");
        await ledger.openSegment(MISSION, 2, "/s2", "sess-2");
        assert.equal((await ledger.activeSegment(MISSION))?.ordinal, 1);
        assert.equal(await ledger.discardUncommittedSegments(MISSION), 1);
        assert.equal((await ledger.listSegments(MISSION)).length, 1);
        await ledger.closeSegment(MISSION, 1, null);
        assert.equal(await ledger.activeSegment(MISSION), undefined);
      } finally {
        await ledger.close();
      }
    },
  ],

  [
    "tasks and lessons upsert without clobbering immutable fields",
    async (open) => {
      const ledger = await open();
      try {
        const task = {
          taskId: "t1",
          missionId: MISSION,
          ordinal: 1,
          dependsOn: [],
          status: "pending" as const,
          hypothesis: "h",
          completionCriteria: "done",
          nextAction: "start",
        };
        await ledger.upsertTask(task);
        await ledger.upsertTask({
          ...task,
          status: "active",
          nextAction: "go",
          completionCriteria: "x",
        });
        const [row] = await ledger.listTasks(MISSION);
        assert.equal(row!.status, "active");
        assert.equal(row!.nextAction, "go");
        assert.equal(row!.completionCriteria, "done");

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
        await ledger.upsertLesson({ ...lesson, state: "validated", proposal: "changed" });
        const [l] = await ledger.listLessons(MISSION);
        assert.equal(l!.state, "validated");
        assert.equal(l!.proposal, "p");
        await ledger.insertLearnedScenario("sc-1", MISSION, "l1", 1, "/sc");
        assert.equal((await ledger.listLearnedScenarios(MISSION))[0]?.lessonId, "l1");
      } finally {
        await ledger.close();
      }
    },
  ],

  [
    "a second controller cannot take the lock while the first holds it",
    async (open) => {
      const first = await open();
      const second = await open();
      try {
        await first.acquireLock();
        await assert.rejects(second.acquireLock(), /holds/);
        await first.releaseLock();
        await second.acquireLock();
        await second.releaseLock();
      } finally {
        await first.close();
        await second.close();
      }
    },
  ],
];

describe("ledger contract: sqlite", () => {
  let dir: string;
  const open: Open = async () => new SqliteLedger(join(dir, "mission.sqlite"));
  for (const [name, fn] of CASES)
    test(name, async () => {
      dir = mkdtempSync(join(tmpdir(), "horizon-ledger-"));
      await fn(open);
    });
});

describe("ledger contract: mongodb", { concurrency: false }, () => {
  let fixture: MongoFixture | undefined;
  let counter = 0;
  const settings = (): MongoSettings => ({
    uri: fixture!.uri,
    database: `horizon_test_${process.pid}_${counter++}`,
    leaseTtlMs: 2_000,
    heartbeatMs: 60_000,
  });
  before(async () => {
    fixture = await startMongo();
    if (!fixture)
      console.log(
        "# skipping MongoDB ledger tests: set HORIZON_TEST_MONGODB_URI or make Docker available",
      );
  });
  after(async () => {
    await fixture?.stop();
  });

  test("runs the shared contract", async (t) => {
    if (!fixture) return t.skip("no MongoDB available");
    // Each contract case gets a fresh database so cases stay independent.
    const databases: string[] = [];
    let current: MongoSettings | undefined;
    const open: Open = async () => MongoLedger.connect(current!, { missionId: MISSION });
    for (const [name, fn] of CASES)
      await t.test(name, async () => {
        current = settings();
        databases.push(current.database);
        await fn(open);
      });
    const client = new (await import("mongodb")).MongoClient(fixture.uri);
    try {
      for (const db of new Set(databases)) await client.db(db).dropDatabase();
    } finally {
      await client.close();
    }
  });

  test("lease takeover fences out the stale controller's transactions", async (t) => {
    if (!fixture) return t.skip("no MongoDB available");
    const s = settings();
    const stale = await MongoLedger.connect(s, { missionId: MISSION });
    const fresh = await MongoLedger.connect(s, { missionId: MISSION });
    try {
      await seedMission(stale);
      await stale.acquireLock();
      await assert.rejects(fresh.acquireLock(), /holds the lease/);
      // Simulate a paused controller: its lease expires without a heartbeat.
      await new Promise((r) => setTimeout(r, s.leaseTtlMs + 200));
      await fresh.acquireLock();
      assert.notEqual(fresh.leaseToken, stale.leaseToken);

      await assert.rejects(
        stale.transaction(() => stale.updateMission(MISSION, { status: "failed" })),
        LeaseLostError,
      );
      await assert.rejects(stale.appendEvent("stale", "t", "x", {}), LeaseLostError);
      assert.equal((await fresh.getMission(MISSION))!.status, "ready");
      assert.equal(await fresh.findEvent("stale"), undefined);

      await fresh.transaction(() => fresh.updateMission(MISSION, { status: "running" }));
      assert.equal((await fresh.getMission(MISSION))!.status, "running");
    } finally {
      await stale.close();
      await fresh.close();
      const client = new (await import("mongodb")).MongoClient(fixture.uri);
      try {
        await client.db(s.database).dropDatabase();
      } finally {
        await client.close();
      }
    }
  });

  test("mission state is isolated per missionId within one database", async (t) => {
    if (!fixture) return t.skip("no MongoDB available");
    const s = settings();
    const a = await MongoLedger.connect(s, { missionId: "m-a" });
    const b = await MongoLedger.connect(s, { missionId: "m-b" });
    try {
      await a.appendEvent("segment:1:open", "segment.opened", "1", {});
      await b.appendEvent("segment:1:open", "segment.opened", "1", {});
      assert.equal(await a.lastEventSeq(), 1);
      assert.equal(await b.lastEventSeq(), 1);
      await a.insertEpisode({ ...episode("ep-1", "posting index"), missionId: "m-a" });
      assert.equal((await b.searchEpisodes("m-b", "posting", 5)).length, 0);
      assert.equal((await a.searchEpisodes("m-a", "posting", 5)).length, 1);
    } finally {
      await a.close();
      await b.close();
      const client = new (await import("mongodb")).MongoClient(fixture.uri);
      try {
        await client.db(s.database).dropDatabase();
      } finally {
        await client.close();
      }
    }
  });
});
