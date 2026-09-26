import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { SEED_DIR } from "../src/artifact-store.ts";
import { buildPacket, DEFAULT_PACKET_BUDGET } from "../src/context-packet.ts";
import { LocalMemoryAdapter } from "../src/memory-adapter.ts";
import { retrieveCrossMissionEpisodes } from "../src/memory-outbox.ts";
import { validateMissionConfig } from "../src/mission-contract.ts";
import {
  decidePerformancePolicy,
  decodePerformanceLesson,
  encodePerformanceLesson,
  isMeasuredP95Comparison,
  type PerformanceLesson,
  type PerformanceObservation,
  performanceLessonId,
  rankPerformanceLessons,
  recordPerformanceObservation,
  renderPerformanceLessons,
} from "../src/performance-lesson.ts";
import type { Worker, WorkerCycleInput } from "../src/worker.ts";
import { controllerFor, EXAMPLE_CONFIG, tempRunsRoot } from "./helpers.ts";

const SEED_ENGINE = readFileSync(`${SEED_DIR}src/search/search-engine.ts`, "utf8");
/** Correct but measurably slower: a fixed busy-wait on every query so the verdict is a measured p95 rejection, never a correctness one. */
const SLOW_ENGINE = SEED_ENGINE.replace(
  "const ids: string[] = [];",
  "const until = performance.now() + 4; while (performance.now() < until) {}\n    const ids: string[] = [];",
);
assert.notEqual(SLOW_ENGINE, SEED_ENGINE);
/** Correct and no slower, but retains ~256MB once the corpus is large (only the performance workload is): fails `resource:peak-memory`, not p95. */
const HUNGRY_ENGINE = SEED_ENGINE.replace(
  "const ids: string[] = [];",
  "if (this.ballast === null && this.store.all().length > 1000) this.ballast = new Uint8Array(256 * 1024 * 1024).fill(1);\n    const ids: string[] = [];",
).replace(
  "private readonly store: DocumentStore;",
  "private readonly store: DocumentStore;\n  private ballast: Uint8Array | null = null;",
);
assert.notEqual(HUNGRY_ENGINE, SEED_ENGINE);

/** Re-proposes one mechanism every cycle, reworded; profiles first only from `profileFromCycle`. */
class SlowWorker implements Worker {
  readonly mode = "scripted" as const;
  readonly packets: string[] = [];
  private readonly profileFromCycle: number;
  private readonly engine: string;
  constructor(profileFromCycle: number, engine = SLOW_ENGINE) {
    this.profileFromCycle = profileFromCycle;
    this.engine = engine;
  }
  async openSegment() {
    return { sessionPath: null, sessionId: "slow" };
  }
  async runCycle(input: WorkerCycleInput) {
    this.packets.push(input.packet.text);
    if (input.cycle >= this.profileFromCycle)
      await input.broker.profileCandidate("search-read-heavy");
    input.broker.workspaceEdit("src/search/search-engine.ts", { content: this.engine });
    return {
      hypothesis: input.cycle % 2 === 0 ? "Batch the scan!" : "batch   the scan",
      whatChanged: "scan in fixed batches",
      claim: "should be faster",
      usage: { inputTokens: 10, outputTokens: 10, uncertain: false },
      seededFixture: null,
      aborted: false,
      compactions: 0,
    };
  }
  async closeSegment() {}
  async abort() {}
}

function payloadOf(event: { payload: unknown } | undefined): Record<string, unknown> {
  assert.ok(event, "event recorded");
  return event.payload as Record<string, unknown>;
}

function observation(
  experimentId: string,
  candidateP95Ms: number,
  comparedP95Ms: number,
  overrides: Partial<PerformanceObservation> = {},
): PerformanceObservation {
  return {
    experimentId,
    episodeId: `ep-${experimentId}-v1`,
    candidateP95Ms,
    comparedP95Ms,
    deltaFraction: (candidateP95Ms - comparedP95Ms) / comparedP95Ms,
    reportIds: [`rep-${experimentId}`],
    evidenceIds: [`ev-${experimentId}`],
    profiled: false,
    reason: "measured",
    at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

test("performance lessons accumulate measured observations per mechanism and round-trip through LessonRow", () => {
  const first = recordPerformanceObservation(undefined, {
    kind: "performance_negative",
    mechanism: "batch the scan",
    hypothesis: "Batch the scan!",
    featureIds: ["search-matching"],
    observation: observation("exp-1", 12, 10),
  });
  assert.equal(first.lessonId, performanceLessonId("performance_negative", "batch the scan"));
  assert.equal(first.observations.length, 1);
  const repeated = recordPerformanceObservation(first, {
    kind: "performance_negative",
    mechanism: "batch the scan",
    hypothesis: "batch the scan",
    featureIds: ["search-mutation"],
    observation: observation("exp-1", 12, 10),
  });
  assert.equal(repeated, first, "the same experiment is never counted twice");
  const second = recordPerformanceObservation(first, {
    kind: "performance_negative",
    mechanism: "batch the scan",
    hypothesis: "batch the scan",
    featureIds: ["search-mutation"],
    observation: observation("exp-2", 13, 10),
  });
  assert.deepEqual(second.featureIds, ["search-matching", "search-mutation"]);

  const row = encodePerformanceLesson("m", second);
  assert.equal(row.invariantId, "PERF-P95");
  assert.equal(row.state, "reproduced");
  assert.equal(row.negativeEvidenceId, "ev-exp-2");
  assert.equal(row.positiveEvidenceId, null);
  assert.deepEqual(row.sourceEpisodeIds, ["ep-exp-1-v1", "ep-exp-2-v1"]);
  assert.deepEqual(
    row.transitions.map((t) => [t.state, t.evidenceId]),
    [
      ["observed", "ev-exp-1"],
      ["reproduced", "ev-exp-2"],
    ],
  );
  const decoded = decodePerformanceLesson(row);
  assert.deepEqual(decoded, second);
  assert.equal(encodePerformanceLesson("m", first).state, "observed");

  const positive = recordPerformanceObservation(undefined, {
    kind: "performance_positive",
    mechanism: "prenormalize documents",
    hypothesis: "Pre-normalize documents",
    featureIds: ["search-matching"],
    observation: observation("exp-3", 7, 10, { profiled: true }),
  });
  const positiveRow = encodePerformanceLesson("m", positive);
  assert.equal(positiveRow.state, "validated");
  assert.equal(positiveRow.positiveEvidenceId, "ev-exp-3");
  assert.equal(positiveRow.negativeEvidenceId, null);
  assert.equal(
    decodePerformanceLesson({ ...row, invariantId: "INV-UPDATE-VISIBILITY" }),
    undefined,
    "correctness lessons are left alone",
  );
});

test("policy blocks a mechanism only at the rejection limit, ranks positives by delta first, and renders evidence IDs", () => {
  const rejectedOnce = recordPerformanceObservation(undefined, {
    kind: "performance_negative",
    mechanism: "once",
    hypothesis: "once",
    featureIds: [],
    observation: observation("exp-a", 11, 10),
  });
  const rejectedTwice = recordPerformanceObservation(
    recordPerformanceObservation(undefined, {
      kind: "performance_negative",
      mechanism: "twice",
      hypothesis: "twice",
      featureIds: ["search-matching"],
      observation: observation("exp-b", 15, 10),
    }),
    {
      kind: "performance_negative",
      mechanism: "twice",
      hypothesis: "twice",
      featureIds: [],
      observation: observation("exp-c", 14, 10),
    },
  );
  const small = recordPerformanceObservation(undefined, {
    kind: "performance_positive",
    mechanism: "small win",
    hypothesis: "small win",
    featureIds: ["search-matching"],
    observation: observation("exp-d", 9, 10),
  });
  const big = recordPerformanceObservation(undefined, {
    kind: "performance_positive",
    mechanism: "big win",
    hypothesis: "big win",
    featureIds: ["search-mutation"],
    observation: observation("exp-e", 6, 10),
  });
  const lessons: PerformanceLesson[] = [rejectedOnce, small, rejectedTwice, big];
  assert.deepEqual(
    rankPerformanceLessons(lessons).map((l) => l.mechanism),
    ["big win", "small win", "twice", "once"],
  );
  const policy = decidePerformancePolicy(lessons, 2);
  assert.deepEqual(
    policy.blockedMechanisms.map((b) => [b.mechanism, b.rejections, b.evidenceIds]),
    [["twice", 2, ["ev-exp-b", "ev-exp-c"]]],
  );
  assert.deepEqual(
    policy.preferredMechanisms.map((p) => p.mechanism),
    ["big win", "small win"],
  );
  assert.deepEqual(policy.focusFeatureIds, ["search-mutation", "search-matching"]);
  assert.equal(decidePerformancePolicy(lessons, 3).blockedMechanisms.length, 0);

  const rendered = renderPerformanceLessons(lessons, policy);
  assert.match(
    rendered,
    /^1\. \[POSITIVE\] perf-pos-\w+ mechanism "big win" \(accepted; best delta -40\.0%\)/,
  );
  assert.match(
    rendered,
    /\[NEGATIVE\] perf-neg-\w+ mechanism "twice" \(rejected 2x on measurement; BLOCKED \(limit 2\)/,
  );
  assert.match(
    rendered,
    /exp-b: p95 15ms vs 10ms \(\+50\.0%\); evidence ev-exp-b; reports rep-exp-b/,
  );
  assert.doesNotMatch(rendered, /mechanism "once" \(rejected 1x on measurement; BLOCKED/);

  const packet = buildPacket(
    {
      pinned: "p",
      featureMap: "f",
      recent: "r",
      retrieved: [{ episodeId: "ep-x", text: "x".repeat(DEFAULT_PACKET_BUDGET.retrieved * 4) }],
      lessons: rendered,
      next: "n",
    },
    DEFAULT_PACKET_BUDGET,
  );
  assert.match(packet.text, /## Performance lessons \(ranked, measured, with evidence\)/);
  assert.ok(packet.sections.lessons > 0);
  assert.ok(packet.sections.lessons + packet.sections.retrieved <= DEFAULT_PACKET_BUDGET.retrieved);
  assert.deepEqual(
    packet.droppedEpisodeIds,
    ["ep-x"],
    "lessons take precedence inside the retrieval allowance",
  );
  assert.doesNotMatch(
    buildPacket({ pinned: "p", featureMap: "f", recent: "r", retrieved: [], next: "n" }).text,
    /Performance lessons/,
  );
});

test("a performance-only rejection becomes a durable lesson, and repeating the mechanism at the limit is refused without a profile", async () => {
  const runs = tempRunsRoot();
  const worker = new SlowWorker(4);
  const memory = new LocalMemoryAdapter();
  const codebaseTag = "horizon-codebase-demo";
  memory.injectForeign(
    codebaseTag,
    "ep-other-1-v1",
    "Mission other-mission; task optimize-search; hypothesis: reduce read-path p95 by pre-normalizing documents. Outcome: accepted",
    {
      missionId: "other-mission",
      episodeId: "ep-other-1-v1",
      contractVersion: 1,
      interpretation: "verified",
      seededFixture: "",
    },
  );
  memory.injectForeign(
    codebaseTag,
    "ep-other-2-v1",
    "Mission other-mission; task optimize-search; hypothesis: reduce read-path p95 by guessing. Outcome: accepted",
    {
      missionId: "other-mission",
      episodeId: "ep-other-2-v1",
      contractVersion: 1,
      interpretation: "model_interpretation",
      seededFixture: "",
    },
  );
  const controller = controllerFor(
    "perf-lessons",
    runs,
    { worker, memory, maxCycles: 4 },
    {
      stagnationLimit: 10,
      performanceRejectionLimit: 2,
      memory: {
        enabled: true,
        containerTag: "horizon-perf-lessons",
        materializeCorrections: true,
        crossMission: { readTags: [codebaseTag] },
      },
    },
  );
  await controller.initialize();
  await controller.run();
  const ledger = controller.ledger;
  const experiments = (await ledger.listExperiments("perf-lessons")).filter(
    (e) => e.taskId === "optimize-search",
  );
  assert.equal(experiments.length, 4);
  const [first, second, third, fourth] = experiments as [
    (typeof experiments)[0],
    (typeof experiments)[0],
    (typeof experiments)[0],
    (typeof experiments)[0],
  ];
  const lessonId = performanceLessonId("performance_negative", "batch the scan");

  // Cycle 1: correctness passes, the measured p95 does not; that alone creates a lesson with evidence.
  assert.equal(first.status, "rejected");
  assert.match(first.verdict ?? "", /^p95 .* not below/);
  const afterFirst = await ledger.findEvent(`${first.experimentId}:lesson:${lessonId}`);
  assert.ok(afterFirst, "lesson.performance event recorded for the first measured rejection");
  assert.equal(payloadOf(afterFirst).kind, "performance_negative");
  assert.equal(payloadOf(afterFirst).observations, 1);
  assert.ok(
    (payloadOf(afterFirst).deltaFraction as number) > 0,
    "candidate measured slower than best",
  );
  assert.ok((payloadOf(afterFirst).evidenceIds as string[]).length > 0);
  assert.doesNotMatch(worker.packets[0]!, /Performance lessons/);
  assert.doesNotMatch(worker.packets[0]!, /Performance policy:/);

  // Cross-mission tier: only the verified foreign episode is injected, labelled with its origin; the write tag is untouched.
  assert.match(
    worker.packets[0]!,
    /\[cross-mission prior from other-mission via horizon-codebase-demo/,
  );
  assert.doesNotMatch(worker.packets[0]!, /by guessing/);
  const firstPacket = await ledger.findEvent(`${first.experimentId}:packet`);
  assert.deepEqual((payloadOf(firstPacket).crossMission as { injected: unknown[] }).injected, [
    { episodeId: "ep-other-1-v1", missionId: "other-mission", containerTag: codebaseTag },
  ]);
  assert.ok(
    (payloadOf(firstPacket).filteredOut as { episodeId: string; reason: string }[]).some(
      (f) => f.episodeId === "ep-other-2-v1" && f.reason === "cross-mission: not verifier-backed",
    ),
  );
  assert.equal(
    (await memory.search(codebaseTag, "batch scan", 10)).length,
    0,
    "the mission never writes to the codebase tier",
  );
  assert.ok((await memory.search("horizon-perf-lessons", "batch scan", 10)).length > 0);

  // Cycle 2: same mechanism, reworded; the lesson hardens to reproduced and the packet showed the first observation.
  assert.equal(second.status, "rejected");
  assert.match(second.verdict ?? "", /^p95 .* not below/);
  assert.match(worker.packets[1]!, /## Performance lessons \(ranked, measured, with evidence\)/);
  assert.match(
    worker.packets[1]!,
    new RegExp(
      `\\[NEGATIVE\\] ${lessonId} mechanism "batch   the scan" \\(rejected 1x on measurement\\)`,
    ),
  );
  assert.doesNotMatch(worker.packets[1]!, /Performance policy:/);
  const lesson = (await ledger.listLessons("perf-lessons")).find((l) => l.lessonId === lessonId);
  assert.ok(lesson);
  assert.equal(lesson.state, "reproduced");
  assert.equal(lesson.invariantId, "PERF-P95");
  const decoded = decodePerformanceLesson(lesson)!;
  assert.equal(decoded.observations.length, 3, "cycles 1, 2 and 4 were measured");
  for (const o of decoded.observations) {
    assert.ok(
      o.candidateP95Ms! > o.comparedP95Ms!,
      "each observation records the measured regression",
    );
    assert.ok(o.evidenceIds.length > 0 && o.reportIds.length > 0);
  }
  assert.deepEqual(
    decoded.observations.map((o) => o.profiled),
    [false, false, true],
  );
  const verifications = await ledger.listVerifications("perf-lessons");
  for (const o of decoded.observations)
    assert.ok(
      verifications.some((v) => o.reportIds.includes(v.reportId) && v.suite === "performance"),
      "every cited report is a committed performance verification",
    );

  // Cycle 3: at the limit the packet carries the policy and the ranked lesson, and the unprofiled repeat is refused without verification.
  const decided = await ledger.findEvent(`${third.experimentId}:performance-policy`);
  assert.ok(decided, "policy.performance recorded before the third cycle");
  assert.deepEqual(
    (payloadOf(decided).blocked as { lessonId: string; rejections: number }[]).map((b) => [
      b.lessonId,
      b.rejections,
    ]),
    [[lessonId, 2]],
  );
  assert.match(
    worker.packets[2]!,
    /Performance policy: the following mechanisms were rejected on measurement at least 2 times/,
  );
  assert.match(worker.packets[2]!, /"batch the scan" \(2x, evidence /);
  assert.match(worker.packets[2]!, /rejected 2x on measurement; BLOCKED \(limit 2\)/);
  assert.equal(third.status, "rejected");
  assert.match(
    third.verdict ?? "",
    /^performance policy: mechanism "batch the scan" was rejected on measurement 2 time\(s\)/,
  );
  assert.equal(third.candidateArtifactHash, null);
  assert.equal(verifications.filter((v) => v.experimentId === third.experimentId).length, 0);
  const enforced = await ledger.findEvent(`${third.experimentId}:performance-policy:enforced`);
  assert.deepEqual(enforced?.payload, { lessonId, mechanism: "batch the scan", rejections: 2 });
  const episode = await ledger.getEpisode(`ep-${third.experimentId}-v1`);
  assert.match(episode!.summary, /profile the current best artifact before editing/);
  assert.equal(
    await ledger.findEvent(`${third.experimentId}:stagnation`),
    undefined,
    "not a stagnation verdict",
  );

  // Cycle 4: still blocked, but the worker profiled first, so the mechanism is measured again and the lesson grows.
  assert.ok(await ledger.findEvent(`${fourth.experimentId}:performance-policy`));
  assert.equal(
    await ledger.findEvent(`${fourth.experimentId}:performance-policy:enforced`),
    undefined,
  );
  assert.match(fourth.verdict ?? "", /^p95 .* not below/);
  assert.equal(
    payloadOf(await ledger.findEvent(`${fourth.experimentId}:lesson:${lessonId}`)).observations,
    3,
  );
  await controller.close();
});

test("a performance suite failed on the memory limit is not a PERF-P95 lesson and never blocks the mechanism", async () => {
  assert.equal(isMeasuredP95Comparison(null, 10), false, "no candidate p95");
  assert.equal(isMeasuredP95Comparison(12, null), false, "no best p95 to compare against");
  assert.equal(isMeasuredP95Comparison(12, 0), false);
  assert.equal(isMeasuredP95Comparison(12, 10), true);

  const runs = tempRunsRoot();
  const worker = new SlowWorker(99, HUNGRY_ENGINE);
  const controller = controllerFor(
    "perf-memory",
    runs,
    { worker, maxCycles: 3 },
    { stagnationLimit: 10, performanceRejectionLimit: 2, memoryLimitBytes: 200 * 1024 * 1024 },
  );
  await controller.initialize();
  await controller.run();
  const ledger = controller.ledger;
  const experiments = (await ledger.listExperiments("perf-memory")).filter(
    (e) => e.taskId === "optimize-search",
  );
  assert.equal(experiments.length, 3);
  for (const e of experiments) {
    assert.equal(e.status, "rejected");
    assert.match(e.verdict ?? "", /^performance failed: resource:peak-memory$/);
  }
  const verifications = await ledger.listVerifications("perf-memory");
  assert.equal(
    verifications.filter((v) => v.suite === "performance" && v.status === "failed").length,
    3,
    "every cycle was measured; the resource failure alone was the verdict",
  );
  assert.deepEqual(
    (await ledger.listLessons("perf-memory")).filter((l) => l.invariantId === "PERF-P95"),
    [],
  );
  assert.equal((await controller.performancePolicy()).blockedMechanisms.length, 0);
  for (const e of experiments)
    assert.equal(
      await ledger.findEvent(`${e.experimentId}:performance-policy:enforced`),
      undefined,
      "a resource failure never turns into a blocked mechanism",
    );
  for (const p of worker.packets) {
    assert.doesNotMatch(p, /Performance lessons/);
    assert.doesNotMatch(p, /Performance policy:/);
  }
  await controller.close();
});

test("cross-mission retrieval is read-only, post-filtered and degrades to nothing when the tier is unavailable", async () => {
  const memory = new LocalMemoryAdapter();
  const tag = "horizon-codebase-abc";
  const meta = (missionId: string, episodeId: string, extra: Record<string, unknown> = {}) => ({
    missionId,
    episodeId,
    contractVersion: 1,
    interpretation: "verified",
    seededFixture: "",
    ...extra,
  });
  memory.injectForeign(tag, "ep-a", "prenormalize documents accepted", meta("m-a", "ep-a"));
  memory.injectForeign(tag, "ep-own", "prenormalize documents own", meta("me", "ep-own"));
  memory.injectForeign(
    tag,
    "ep-v2",
    "prenormalize documents v2",
    meta("m-b", "ep-v2", { contractVersion: 2 }),
  );
  memory.injectForeign(
    tag,
    "ep-seed",
    "prenormalize documents seeded",
    meta("m-c", "ep-seed", { seededFixture: "stale-cache" }),
  );
  memory.injectForeign(tag, "ep-anon", "prenormalize documents anonymous", {
    episodeId: "ep-anon",
  });
  const { seededFixture: _dropped, ...noSeedStatus } = meta("m-d", "ep-noseed");
  memory.injectForeign(tag, "ep-noseed", "prenormalize documents legacy", noSeedStatus);
  memory.injectForeign(
    tag,
    "ep-nullseed",
    "prenormalize documents nullish",
    meta("m-e", "ep-nullseed", { seededFixture: null }),
  );
  const selection = await retrieveCrossMissionEpisodes(
    memory,
    { missionId: "me", readTags: [tag], contractVersion: 1 },
    "prenormalize documents",
    10,
    5,
  );
  assert.deepEqual(
    selection.injected.map((i) => [i.episodeId, i.source, i.provenance]),
    [["ep-a", "cross_mission", { missionId: "m-a", containerTag: tag }]],
  );
  assert.match(
    selection.injected[0]!.text,
    /^\[cross-mission prior from m-a via horizon-codebase-abc/,
  );
  assert.deepEqual(
    new Set(selection.filteredOut.map((f) => f.reason)),
    new Set([
      "cross-mission: own mission (served by mission tier)",
      "cross-mission: contract version 2 not applicable",
      "cross-mission: seeded fault-injection fixture",
      "cross-mission: no provenance",
      "cross-mission: seeded-fixture status unverifiable",
    ]),
  );
  assert.equal(selection.degraded, false);

  memory.unavailable = true;
  const degraded = await retrieveCrossMissionEpisodes(
    memory,
    { missionId: "me", readTags: [tag], contractVersion: 1 },
    "prenormalize documents",
  );
  assert.deepEqual(degraded, { injected: [], filteredOut: [], degraded: true });
});

test("mission contract: cross-mission tags are codebase-scoped and never the mission's own write tag", () => {
  const base = JSON.parse(readFileSync(EXAMPLE_CONFIG, "utf8")) as {
    memory: Record<string, unknown>;
  };
  const withTags = (readTags: unknown) =>
    validateMissionConfig({ ...base, memory: { ...base.memory, crossMission: { readTags } } });
  assert.deepEqual(withTags(["horizon-codebase-abc123"]).memory.crossMission, {
    readTags: ["horizon-codebase-abc123"],
  });
  assert.throws(() => withTags(["horizon-other-mission"]), /horizon-codebase-<hash>/);
  assert.throws(
    () => withTags([base.memory.containerTag]),
    /horizon-codebase-<hash>|own write tag/,
  );
  assert.throws(() => withTags("horizon-codebase-abc"), /horizon-codebase-<hash>/);
  assert.throws(
    () => validateMissionConfig({ ...base, performanceRejectionLimit: 0 }),
    /performanceRejectionLimit >= 1/,
  );
  assert.equal(
    validateMissionConfig({ ...base, performanceRejectionLimit: 3 }).performanceRejectionLimit,
    3,
  );
});
