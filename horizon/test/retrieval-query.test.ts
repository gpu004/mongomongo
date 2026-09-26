import assert from "node:assert/strict";
import { test } from "node:test";
import { composeRetrievalQuery } from "../src/memory-outbox.ts";
import type { Worker, WorkerCycleInput } from "../src/worker.ts";
import { controllerFor, tempRunsRoot } from "./helpers.ts";

test("retrieval query is composed from task, hypothesis, features, invariants and last failure", () => {
  const query = composeRetrievalQuery({
    taskId: "optimize-search",
    hypothesis: "Cache normalized query tokens per request",
    featureIds: ["query-normalization", "result-cache"],
    invariantIds: ["INV-CACHE-INVALIDATION", "INV-NORMALIZE-CASE"],
    lastVerdict: "rejected",
    lastFailureSignature: "correctness:stale-cache-after-update",
  });
  for (const term of [
    "optimize",
    "search",
    "cache",
    "normalized",
    "tokens",
    "query",
    "normalization",
    "inv",
    "invalidation",
    "rejected",
    "stale",
    "correctness",
  ]) {
    assert.ok(query.split(" ").includes(term), `query "${query}" should contain "${term}"`);
  }
  assert.equal(new Set(query.split(" ")).size, query.split(" ").length);
  assert.equal(query, query.toLowerCase());
  assert.ok(!query.split(" ").includes("a"));
});

test("retrieval query changes with mission state and is bounded", () => {
  const base = {
    taskId: "optimize-search",
    hypothesis: "reduce read-path p95",
    featureIds: [],
    invariantIds: [],
    lastVerdict: null,
    lastFailureSignature: null,
  };
  const first = composeRetrievalQuery(base);
  assert.equal(first, "optimize search reduce read path p95");
  const afterFailure = composeRetrievalQuery({
    ...base,
    invariantIds: ["INV-TOKENIZE"],
    lastVerdict: "rejected",
  });
  assert.notEqual(afterFailure, first);
  assert.match(afterFailure, /inv tokenize rejected/);

  const long = composeRetrievalQuery(
    {
      ...base,
      featureIds: Array.from({ length: 50 }, (_, i) => `feature-${i}`),
    },
    10,
  );
  assert.equal(long.split(" ").length, 10);
});

/** Emits a distinct hypothesis every cycle so the controller's query must track it. */
class HypothesisWorker implements Worker {
  readonly mode = "scripted" as const;
  private cycle = 0;
  async openSegment(ordinal: number) {
    return {
      sessionPath: `sessions/seg-${ordinal}`,
      sessionId: `seg-${ordinal}`,
    };
  }
  async runCycle(_input: WorkerCycleInput) {
    this.cycle += 1;
    return {
      hypothesis: `hypothesis marker${this.cycle} about tokenizer`,
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

test("controller composes the packet retrieval query from the previous cycle's state", async () => {
  const runs = tempRunsRoot();
  const controller = controllerFor("retrieval-query", runs, {
    worker: new HypothesisWorker(),
    maxCycles: 3,
  });
  controller.initialize();
  await controller.run();
  const queries = controller.ledger
    .eventsSince(0, 10_000)
    .filter((e) => e.type === "packet.built")
    .map((e) => (e.payload as { query: string }).query);
  const firstVerdict = controller.ledger
    .listExperiments("retrieval-query")
    .filter((e) => e.taskId === "optimize-search")[0]!.verdict;
  controller.close();

  assert.ok(queries.length >= 2, `expected >=2 packets, got ${queries.length}`);
  assert.match(queries[0]!, /optimize search reduce read path p95/);
  assert.match(queries[1]!, /marker1/);
  assert.match(queries[1]!, /tokenizer/);
  assert.ok(firstVerdict, "first experiment has a verdict");
  const verdictTerm = firstVerdict
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter(Boolean)[0]!;
  assert.ok(
    queries[1]!.split(" ").includes(verdictTerm),
    `second query carries the last verdict "${firstVerdict}": ${queries[1]}`,
  );
  assert.equal(new Set(queries).size, queries.length, "queries differ across cycles");
});
