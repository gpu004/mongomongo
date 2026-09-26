import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { missionPaths } from "../src/mission-paths.ts";
import type { SegmentHandle, Worker, WorkerCycleInput } from "../src/worker.ts";
import { controllerFor, tempRunsRoot } from "./helpers.ts";

/** Records the `previous` handle on every segment open. */
class RecordingWorker implements Worker {
  readonly mode = "scripted" as const;
  readonly opened: { ordinal: number; previous: SegmentHandle | null }[] = [];
  async openSegment(ordinal: number, previous: SegmentHandle | null) {
    this.opened.push({ ordinal, previous });
    return { sessionPath: `sessions/seg-${ordinal}`, sessionId: `seg-${ordinal}` };
  }
  async runCycle(_input: WorkerCycleInput) {
    return {
      hypothesis: "noop",
      whatChanged: "noop",
      claim: "no claim",
      usage: { inputTokens: 1, outputTokens: 1, uncertain: true },
      seededFixture: null,
      aborted: false,
      compactions: 0,
    };
  }
  async closeSegment() {}
  async abort() {}
}

test("segment rotation opens a fresh bounded context, not the previous session", async () => {
  const runs = tempRunsRoot();
  const worker = new RecordingWorker();
  const controller = controllerFor(
    "seg-rotate",
    runs,
    { worker, maxCycles: 3 },
    { segmentRotationCycles: 1 },
  );
  await controller.initialize();
  await controller.run();

  assert.ok(worker.opened.length >= 3, `expected >=3 segment opens, got ${worker.opened.length}`);
  const rotations = worker.opened.slice(1);
  assert.ok(
    rotations.every((o) => o.previous === null),
    `rotation must not carry the previous session: ${JSON.stringify(worker.opened)}`,
  );

  const segments = (await controller.ledger.listSegments("seg-rotate")).sort(
    (a, b) => a.ordinal - b.ordinal,
  );
  const sessionIds = new Set(segments.map((s) => s.sessionId));
  await controller.close();
  assert.equal(sessionIds.size, segments.length, "every segment recorded a distinct session id");
});

test("retention archives closed sessions and removes only unretained artifacts", async () => {
  const runs = tempRunsRoot();
  const missionId = "seg-retention";
  const paths = missionPaths(missionId, runs);
  class SessionWorker extends RecordingWorker {
    override async openSegment(ordinal: number, previous: SegmentHandle | null) {
      await super.openSegment(ordinal, previous);
      const sessionPath = join(paths.sessions, `seg-${ordinal}.jsonl`);
      writeFileSync(sessionPath, JSON.stringify({ ordinal }) + "\n");
      return { sessionPath, sessionId: `seg-${ordinal}` };
    }
  }
  const controller = controllerFor(
    missionId,
    runs,
    { worker: new SessionWorker(), maxCycles: 3 },
    {
      segmentRotationCycles: 1,
      retention: { keepRecentCandidates: 1, keepRecentSegments: 1, compactEventsAfter: 10 },
    },
  );
  await controller.initialize();
  const orphan = join(paths.artifacts, "f".repeat(64));
  mkdirSync(orphan);
  await controller.run();
  const segments = await controller.ledger.listSegments(missionId);
  assert.ok(segments.length >= 3);
  for (const segment of segments.slice(0, -1)) {
    assert.match(segment.archiveHash ?? "", /^[0-9a-f]{64}$/);
    assert.equal(existsSync(segment.sessionPath!), false);
    assert.equal(existsSync(join(paths.evidence, `${segment.archiveHash}.session.jsonl.gz`)), true);
  }
  assert.equal(existsSync(segments.at(-1)!.sessionPath!), true);
  assert.equal(existsSync(orphan), false);
  assert.ok(await controller.ledger.findEvent("segment:1:open"));
  await controller.close();
});
