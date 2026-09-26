import assert from "node:assert/strict";
import { test } from "node:test";
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
  const controller = await controllerFor(
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
