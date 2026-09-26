import assert from "node:assert/strict";
import { test } from "node:test";
import { validateReport, type VerificationReport } from "../verification/reports.ts";

function sample(overrides: Partial<VerificationReport> = {}): VerificationReport {
  return {
    schemaVersion: 1,
    reportId: "rep-1",
    missionId: "m1",
    experimentId: "exp-1",
    suite: "performance",
    status: "passed",
    artifactHash: "a".repeat(64),
    evaluatorHash: "e".repeat(64),
    workloadHash: "w".repeat(64),
    environmentHash: "n".repeat(64),
    isolation: "subprocess",
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:01.000Z",
    assertions: [{ id: "perf", passed: true, evidenceId: "ev-1", detail: "ok" }],
    metrics: {
      measuredRequests: 300,
      failedRequests: 0,
      p95LatencyMs: 2.5,
      repetitionP95Ms: [2.4, 2.5, 2.6],
    },
    evidenceIds: ["ev-1"],
    ...overrides,
  };
}

const expected = {
  missionId: "m1",
  experimentId: "exp-1",
  suite: "performance" as const,
  artifactHash: "a".repeat(64),
  evaluatorHash: "e".repeat(64),
  workloadHash: "w".repeat(64),
  environmentHash: "n".repeat(64),
};

test("a well-formed report with matching identities is accepted", () => {
  assert.equal(validateReport(sample(), expected).ok, true);
});

for (const field of [
  "artifactHash",
  "evaluatorHash",
  "workloadHash",
  "environmentHash",
  "missionId",
  "experimentId",
] as const) {
  test(`report with mismatched ${field} is rejected`, () => {
    const result = validateReport(
      sample({ [field]: "x".repeat(field.endsWith("Hash") ? 64 : 4) }),
      expected,
    );
    assert.equal(result.ok, false);
    assert.match(result.ok ? "" : result.reason, new RegExp(field, "i"));
  });
}

test("status passed with a failing assertion is rejected", () => {
  assert.equal(
    validateReport(
      sample({ assertions: [{ id: "x", passed: false, evidenceId: "ev-2" }] }),
      expected,
    ).ok,
    false,
  );
});

test("candidate-printed text that merely resembles a report is rejected", () => {
  assert.equal(
    validateReport({ reportId: "rep-fake", status: "passed", p95: 0.01 }, expected).ok,
    false,
  );
});

test("passed performance report with zero measured requests is rejected", () => {
  const result = validateReport(
    sample({
      metrics: { measuredRequests: 0, failedRequests: 0, p95LatencyMs: 1, repetitionP95Ms: [1] },
    }),
    expected,
  );
  assert.equal(result.ok, false);
});

test("passed performance report with failed requests is rejected", () => {
  const result = validateReport(
    sample({
      metrics: { measuredRequests: 300, failedRequests: 2, p95LatencyMs: 1, repetitionP95Ms: [1] },
    }),
    expected,
  );
  assert.equal(result.ok, false);
});

test("passed performance report without a p95 is rejected", () => {
  const result = validateReport(
    sample({ metrics: { measuredRequests: 300, failedRequests: 0 } }),
    expected,
  );
  assert.equal(result.ok, false);
});

test("wrong suite label is rejected", () => {
  assert.equal(validateReport(sample(), { ...expected, suite: "smoke" }).ok, false);
});

test("infra_error is a distinct status from failed", () => {
  const r = sample({
    status: "infra_error",
    infraMessage: "docker daemon unavailable",
    metrics: {},
    assertions: [],
  });
  const result = validateReport(r, expected);
  assert.equal(result.ok, true);
  assert.equal(r.status, "infra_error");
  assert.notEqual(r.status, "failed");
});
