import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Operation } from "../verification/reference-model.ts";
import type { VerificationReport } from "../verification/reports.ts";
import { type Scenario, validateScenarioShape } from "../verification/scenarios/index.ts";

export interface RegressionProposal {
  scenarioId: string;
  invariantId: string;
  description: string;
  sequence: Operation[];
}

export const KNOWN_INVARIANTS = new Set([
  "INV-NORMALIZATION",
  "INV-EMPTY-QUERY",
  "INV-SUBSTRING-MATCH",
  "INV-MULTI-TERM",
  "INV-RESULT-ORDER",
  "INV-LIMIT",
  "INV-INSERT-VISIBILITY",
  "INV-UPDATE-VISIBILITY",
  "INV-DELETE-VISIBILITY",
  "INV-HEALTH",
  "STRUCT-IMPORT-BOUNDARY",
]);

export type ProposalValidation = { ok: true; scenario: Scenario } | { ok: false; reason: string };

/**
 * Narrow declarative format: an operation sequence plus an invariant ID. The
 * worker never supplies expected results; the host derives them from the
 * independent reference model, so a proposal cannot encode the candidate's
 * current output as "correct".
 */
export function validateProposalShape(
  proposal: RegressionProposal,
  existingIds: Set<string>,
): ProposalValidation {
  if (!KNOWN_INVARIANTS.has(proposal.invariantId))
    return { ok: false, reason: `unknown invariant ${proposal.invariantId}` };
  if (existingIds.has(proposal.scenarioId))
    return {
      ok: false,
      reason: `scenarioId ${proposal.scenarioId} already exists (learned suite is append-only)`,
    };
  if (!proposal.sequence.some((step) => step.op === "search" || step.op === "health"))
    return { ok: false, reason: "sequence must observe something (search or health)" };
  const scenario: Scenario = {
    schemaVersion: 1,
    scenarioId: proposal.scenarioId,
    description: proposal.description,
    suite: "correctness",
    invariantIds: [proposal.invariantId],
    sequence: proposal.sequence,
  };
  const problem = validateScenarioShape(scenario);
  if (problem) return { ok: false, reason: problem };
  return { ok: true, scenario };
}

export interface FixtureRun {
  /** Run the learned suite containing exactly this scenario against an artifact. */
  runLearned(
    snapshotDir: string,
    artifactHash: string,
    scenarioDir: string,
  ): Promise<VerificationReport>;
}

export interface ValidationEvidence {
  accepted: boolean;
  reason: string;
  negativeReport: VerificationReport;
  positiveReport: VerificationReport;
}

/**
 * Lesson step 4-6: the proposed check must fail on the known-bad fixture and
 * pass on the known-good seed. A check that passes the negative fixture is
 * useless; one that rejects valid reference behavior would move the goalposts.
 * Infra errors on either side are not evidence and reject the proposal.
 */
export async function validateAgainstFixtures(
  scenario: Scenario,
  runner: FixtureRun,
  negative: { snapshotDir: string; artifactHash: string },
  positive: { snapshotDir: string; artifactHash: string },
): Promise<ValidationEvidence> {
  const dir = mkdtempSync(join(tmpdir(), "horizon-proposal-"));
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${scenario.scenarioId}.json`), JSON.stringify(scenario, null, 2));
    const negativeReport = await runner.runLearned(
      negative.snapshotDir,
      negative.artifactHash,
      dir,
    );
    const positiveReport = await runner.runLearned(
      positive.snapshotDir,
      positive.artifactHash,
      dir,
    );
    if (negativeReport.status === "infra_error" || positiveReport.status === "infra_error") {
      return {
        accepted: false,
        reason: "infrastructure error while validating; not product evidence",
        negativeReport,
        positiveReport,
      };
    }
    if (positiveReport.status !== "passed") {
      return {
        accepted: false,
        reason: "proposal rejects valid reference behavior on the seed",
        negativeReport,
        positiveReport,
      };
    }
    if (negativeReport.status !== "failed") {
      return {
        accepted: false,
        reason: "proposal does not catch the known-bad fixture",
        negativeReport,
        positiveReport,
      };
    }
    return {
      accepted: true,
      reason: "fails negative fixture, passes positive fixture",
      negativeReport,
      positiveReport,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
