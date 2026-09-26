import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ArtifactStore } from "../src/artifact-store.ts";
import {
  type RegressionProposal,
  validateAgainstFixtures,
  validateProposalShape,
} from "../src/lesson-policy.ts";
import { FileEvidenceStore } from "../src/mission-paths.ts";
import type { VerificationReport } from "../verification/reports.ts";
import { computeEnvironmentHash, computeEvaluatorHash, runSuite } from "../verification/runner.ts";
import { testConfig } from "./helpers.ts";

const updateProposal: RegressionProposal = {
  scenarioId: "learned-update-then-search",
  invariantId: "INV-UPDATE-VISIBILITY",
  description: "an updated document stops matching its old title",
  sequence: [
    { op: "insert", id: "u1", title: "Alpha report", body: "quarterly" },
    { op: "search", q: "alpha", limit: 10 },
    { op: "update", id: "u1", title: "Beta report" },
    { op: "search", q: "alpha", limit: 10 },
    { op: "search", q: "beta", limit: 10 },
  ],
};

test("proposal shape: unknown invariants, duplicate ids, unobservable sequences and bad ids are rejected", () => {
  const existing = new Set(["learned-update-then-search"]);
  assert.equal(
    validateProposalShape(updateProposal, existing).ok,
    false,
    "append-only: duplicate id",
  );
  assert.match(
    (
      validateProposalShape({ ...updateProposal, invariantId: "INV-MADE-UP" }, new Set()) as {
        reason: string;
      }
    ).reason,
    /unknown invariant/,
  );
  assert.match(
    (
      validateProposalShape(
        { ...updateProposal, sequence: [{ op: "insert", id: "x", title: "t", body: "b" }] },
        new Set(),
      ) as { reason: string }
    ).reason,
    /must observe/,
  );
  assert.match(
    (
      validateProposalShape({ ...updateProposal, scenarioId: "Bad Id" }, new Set()) as {
        reason: string;
      }
    ).reason,
    /kebab-case/,
  );
  const ok = validateProposalShape(updateProposal, new Set());
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.scenario.suite, "correctness");
    assert.deepEqual(ok.scenario.invariantIds, ["INV-UPDATE-VISIBILITY"]);
    // The worker never supplies expectations; the reference model derives them at run time.
    assert.equal("expected" in ok.scenario, false);
  }
});

test("fixture validation: the check must fail the stale-cache fixture and pass the seed; a useless check is rejected", async () => {
  const dir = mkdtempSync(join(tmpdir(), "horizon-lesson-"));
  const artifacts = new ArtifactStore(join(dir, "artifacts"));
  const evidence = new FileEvidenceStore(join(dir, "evidence"));
  const config = testConfig("lesson-mission");
  const seed = artifacts.importSeed();
  const { artifact: negative, fixture } = artifacts.importFixture("stale-cache", seed.hash);
  assert.equal(fixture.fixtureId, "stale-cache");
  assert.notEqual(negative.hash, seed.hash);

  const runLearned = (
    snapshotDir: string,
    artifactHash: string,
    scenarioDir: string,
  ): Promise<VerificationReport> =>
    runSuite(
      {
        missionId: config.missionId,
        experimentId: `lesson-test-${artifactHash.slice(0, 8)}`,
        artifactHash,
        evaluatorHash: computeEvaluatorHash(),
        environmentHash: computeEnvironmentHash("subprocess", config.containerImage),
        snapshotDir,
        isolation: "subprocess",
        containerImage: config.containerImage,
        startupTimeoutMs: config.startupTimeoutMs,
        requestTimeoutMs: config.requestTimeoutMs,
        memoryLimitBytes: config.memoryLimitBytes,
        workload: config.workload,
        holdoutWorkload: config.holdoutWorkload,
        learnedScenariosDir: scenarioDir,
        evidence,
      },
      "learned",
    );
  const neg = { snapshotDir: negative.path, artifactHash: negative.hash };
  const pos = { snapshotDir: seed.path, artifactHash: seed.hash };

  const good = validateProposalShape(updateProposal, new Set());
  assert.ok(good.ok);
  if (!good.ok) return;
  const accepted = await validateAgainstFixtures(good.scenario, { runLearned }, neg, pos);
  assert.equal(accepted.accepted, true, accepted.reason);
  assert.equal(accepted.negativeReport.status, "failed");
  assert.equal(accepted.positiveReport.status, "passed");
  assert.equal(accepted.negativeReport.artifactHash, negative.hash);
  assert.equal(accepted.positiveReport.artifactHash, seed.hash);

  // Read-only search sequence: passes on both, so it catches nothing and is rejected.
  const useless = validateProposalShape(
    {
      scenarioId: "learned-read-only",
      invariantId: "INV-SUBSTRING-MATCH",
      description: "plain search",
      sequence: [
        { op: "insert", id: "r1", title: "Gamma", body: "x" },
        { op: "search", q: "gam", limit: 5 },
      ],
    },
    new Set(),
  );
  assert.ok(useless.ok);
  if (!useless.ok) return;
  const rejected = await validateAgainstFixtures(useless.scenario, { runLearned }, neg, pos);
  assert.equal(rejected.accepted, false);
  assert.match(rejected.reason, /does not catch the known-bad fixture/);

  // Infra errors are never product evidence.
  const infra = await validateAgainstFixtures(
    good.scenario,
    {
      runLearned: async (snapshotDir, hash, scenarioDir) => ({
        ...(await runLearned(snapshotDir, hash, scenarioDir)),
        status: "infra_error" as const,
      }),
    },
    neg,
    pos,
  );
  assert.equal(infra.accepted, false);
  assert.match(infra.reason, /infrastructure error/);
  assert.equal(infra.negativeReport.status, "infra_error");
});
