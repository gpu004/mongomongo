import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExperimentRow } from "../src/ledger.ts";
import { retainedArtifactHashes } from "../src/retention.ts";

type ArtifactExperiment = Pick<
  ExperimentRow,
  "experimentId" | "candidateArtifactHash" | "parentArtifactHash" | "status" | "createdAt"
>;

test("retention keeps accepted history, active recovery inputs and the latest distinct candidates", () => {
  const row = (
    id: string,
    candidate: string,
    status: ExperimentRow["status"],
    createdAt: string,
    parent = "seed",
  ): ArtifactExperiment => ({
    experimentId: id,
    candidateArtifactHash: candidate,
    parentArtifactHash: parent,
    status,
    createdAt,
  });
  const experiments = [
    row("1", "old-rejected", "rejected", "2026-01-01"),
    row("2", "accepted", "accepted", "2026-01-02"),
    row("3", "repeat", "rejected", "2026-01-03"),
    row("4", "repeat", "rejected", "2026-01-04"),
    row("5", "recover", "snapshot_ready", "2026-01-05", "recovery-parent"),
    row("6", "latest", "rejected", "2026-01-06"),
  ];

  assert.deepEqual(
    retainedArtifactHashes(
      { seedArtifactHash: "seed", bestArtifactHash: "accepted" },
      experiments,
      2,
    ),
    new Set(["seed", "accepted", "recovery-parent", "recover", "latest"]),
  );
  assert.deepEqual(
    retainedArtifactHashes({ seedArtifactHash: "seed", bestArtifactHash: null }, experiments, 3),
    new Set(["seed", "accepted", "recovery-parent", "recover", "latest", "repeat"]),
  );
  assert.throws(
    () => retainedArtifactHashes({ seedArtifactHash: "seed", bestArtifactHash: null }, [], 0),
    /positive integer/,
  );
});
