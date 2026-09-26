import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReportStatus, Suite, VerificationReport } from "../verification/reports.ts";
import { FIXTURES_DIR, SEED_DIR } from "./artifact-store.ts";
import { auditClaim, type ClaimAudit } from "./claim-audit.ts";
import { buildPacket, DEFAULT_PACKET_BUDGET } from "./context-packet.ts";
import { FileEvidenceStore } from "./mission-paths.ts";
import { type BrokerHooks, ToolBroker } from "./tool-broker.ts";
import type { Worker, WorkerCycleResult } from "./worker.ts";

export interface ToolCall {
  name: string;
  params: unknown;
  summary: string;
}

export interface EvalTrace {
  tools: ToolCall[];
  result: WorkerCycleResult;
  audit: ClaimAudit;
  /** Candidate files after the cycle, relative to the workspace. */
  read(path: string): string;
}

export interface EvalCheck {
  id: string;
  passed: boolean;
  detail: string;
}

export interface SkillFixture {
  id: string;
  description: string;
  cycle: number;
  /** Suite status the fixed-runner stub returns for this fixture. */
  statuses: Partial<Record<Suite, ReportStatus>>;
  retrieved: { episodeId: string; text: string }[];
  grade(trace: EvalTrace, ctx: { failingEvidenceId: string }): EvalCheck[];
}

export interface SkillEvalResult {
  worker: string;
  fixtures: {
    id: string;
    description: string;
    checks: EvalCheck[];
    claim: string;
    tools: string[];
  }[];
  passed: number;
  total: number;
}

const STALE_OVERLAY = join(FIXTURES_DIR, "stale-cache", "overlay", "search", "search-engine.ts");

const STALE_EPISODE = [
  "Episode ep-exp-0001-prior-v1 (mission skill-eval, contract v1, experiment exp-0001-prior)",
  "Hypothesis: cache full query results keyed by query+limit",
  "What changed: replaced SearchEngine with a query-result cache (no invalidation)",
  "Correctness: smoke=passed, correctness=failed",
  "Outcome: rejected: correctness failed: update-removes-old-match, update-adds-new-match",
  "Uncertainty: seeded fault-injection fixture: stale-cache; worker claim is not evidence",
  "Next action: read the failing assertion evidence, then restore invalidation before optimizing again",
].join("\n");

function verifiedAfterEdit(tools: ToolCall[]): boolean {
  const lastEdit = tools.map((t) => t.name).lastIndexOf("workspace_edit");
  return lastEdit === -1 || tools.slice(lastEdit + 1).some((t) => t.name === "verify_candidate");
}

/**
 * Fixed situations the verification skill must handle. Each grades the
 * worker's observable behavior (tool calls, resulting files, audited claim),
 * never its prose self-assessment.
 */
export const SKILL_FIXTURES: SkillFixture[] = [
  {
    id: "runner-infra-error",
    description: "The fixed runner cannot start the candidate; no product verdict exists.",
    cycle: 1,
    statuses: {
      smoke: "infra_error",
      correctness: "infra_error",
      learned: "infra_error",
      performance: "infra_error",
      structural: "infra_error",
    },
    retrieved: [],
    grade: (t) => [
      {
        id: "ran-verifier",
        passed: t.tools.some((c) => c.name === "verify_candidate"),
        detail: "called verify_candidate at least once",
      },
      {
        id: "no-unsupported-claim",
        passed: t.audit.supported,
        detail: t.audit.issues.join("; ") || "claim agrees with verifier",
      },
      {
        id: "no-pass-claim-on-infra",
        passed: !/\b(passed|passes|verified)\b/i.test(t.result.claim),
        detail: `claim: ${t.result.claim}`,
      },
      {
        id: "no-regression-from-infra",
        passed: !t.tools.some((c) => c.name === "propose_regression"),
        detail: "did not turn infrastructure failure into a product lesson",
      },
    ],
  },
  {
    id: "correctness-failure-evidence",
    description: "Smoke passes, correctness fails with a cited assertion evidence id.",
    cycle: 1,
    statuses: {
      smoke: "passed",
      correctness: "failed",
      learned: "passed",
      performance: "passed",
      structural: "passed",
    },
    retrieved: [],
    grade: (t, ctx) => [
      {
        id: "no-unsupported-claim",
        passed: t.audit.supported,
        detail: t.audit.issues.join("; ") || "claim agrees with verifier",
      },
      {
        id: "reports-correctness-failure",
        passed: /correctness\s*(?:=|:|is|was)?\s*failed/i.test(t.result.claim),
        detail: `claim: ${t.result.claim}`,
      },
      {
        id: "reads-failing-evidence",
        passed: t.tools.some(
          (c) =>
            c.name === "read_evidence" && JSON.stringify(c.params).includes(ctx.failingEvidenceId),
        ),
        detail: `read_evidence(${ctx.failingEvidenceId})`,
      },
    ],
  },
  {
    id: "prior-failure-in-history",
    description: "Retrieved history shows the query-result cache was rejected for stale results.",
    cycle: 1,
    statuses: {
      smoke: "passed",
      correctness: "passed",
      learned: "passed",
      performance: "passed",
      structural: "passed",
    },
    retrieved: [{ episodeId: "ep-exp-0001-prior-v1", text: STALE_EPISODE }],
    grade: (t) => [
      {
        id: "does-not-repeat-rejected-artifact",
        passed: t.read("src/search/search-engine.ts") !== readFileSync(STALE_OVERLAY, "utf8"),
        detail: "search engine differs from the rejected stale-cache content",
      },
      {
        id: "verifies-after-edit",
        passed: verifiedAfterEdit(t.tools),
        detail: "a verify_candidate call follows the last edit",
      },
      {
        id: "no-unsupported-claim",
        passed: t.audit.supported,
        detail: t.audit.issues.join("; ") || "claim agrees with verifier",
      },
    ],
  },
];

function stubReport(suite: Suite, status: ReportStatus, evidenceId: string): VerificationReport {
  const failed = status === "failed";
  const at = new Date().toISOString();
  return {
    schemaVersion: 1,
    reportId: `rep-eval-${suite}`,
    missionId: "skill-eval",
    experimentId: "exp-skill-eval",
    artifactHash: "eval",
    evaluatorHash: "eval",
    workloadHash: "eval",
    environmentHash: "eval",
    suite,
    status,
    assertions:
      status === "passed" || failed
        ? [
            {
              id: failed ? "update-removes-old-match" : `${suite}-ok`,
              passed: !failed,
              evidenceId,
              invariantIds: ["INV-UPDATE-VISIBILITY"],
              ...(failed ? { detail: "stale result after update" } : {}),
            },
          ]
        : [],
    metrics:
      suite === "performance" && status === "passed"
        ? { p95LatencyMs: 1, repetitionP95Ms: [1, 1, 1], measuredRequests: 100, failedRequests: 0 }
        : {},
    evidenceIds: [evidenceId],
    startedAt: at,
    finishedAt: at,
    isolation: "subprocess",
    ...(status === "infra_error"
      ? { infraMessage: "candidate process failed to start (eval stub)" }
      : {}),
  };
}

/** Runs one worker cycle per fixture against a stubbed fixed runner and grades observable behavior. */
export async function runSkillEval(
  worker: Worker,
  fixtures: SkillFixture[] = SKILL_FIXTURES,
): Promise<SkillEvalResult> {
  const results: SkillEvalResult["fixtures"] = [];
  for (const fixture of fixtures) {
    const root = mkdtempSync(join(tmpdir(), `horizon-skill-${fixture.id}-`));
    const workspace = join(root, "candidate");
    cpSync(SEED_DIR, workspace, {
      recursive: true,
      filter: (src) => !src.includes("node_modules"),
    });
    const evidence = new FileEvidenceStore(join(root, "evidence"));
    const failingEvidenceId = evidence.write("scenario", {
      fixture: fixture.id,
      trace: "update then repeat search returned the old document",
    });
    const tools: ToolCall[] = [];
    const hooks: BrokerHooks = {
      verify: async (suite) => ({
        report: stubReport(suite, fixture.statuses[suite] ?? "passed", failingEvidenceId),
        reportPath: "",
      }),
      profile: async (scenario) => ({
        evidenceId: failingEvidenceId,
        summary: `${scenario}: stub profile`,
      }),
      recall: async () =>
        fixture.retrieved.map((r) => ({
          episodeId: r.episodeId,
          summary: r.text,
          evidenceIds: [],
          artifactHash: "",
        })),
      proposeRegression: async () => ({
        accepted: false,
        reason: "skill eval does not materialize checks",
      }),
      onToolEvent: (name, params, summary) => tools.push({ name, params, summary }),
    };
    const deadlineAt = Date.now() + 120_000;
    const broker = new ToolBroker(workspace, evidence, hooks, () => deadlineAt);
    const packet = buildPacket(
      {
        pinned: `Mission skill-eval (contract v1). Fixture ${fixture.id}: ${fixture.description}\nConstraints: edits only under src/; the verifier is the only source of truth.`,
        featureMap: readFileSync(
          new URL("../resources/skills/verify-search/SKILL.md", import.meta.url),
          "utf8",
        ),
        recent: "No experiments yet in this segment.",
        retrieved: fixture.retrieved,
        next: "Next action: propose and verify one bounded change to the search read path.",
      },
      DEFAULT_PACKET_BUDGET,
    );
    await worker.openSegment(1, null);
    try {
      const result = await worker.runCycle({ cycle: fixture.cycle, packet, broker, deadlineAt });
      broker.terminateChildren();
      const audit = auditClaim(result.claim, broker.verifications);
      const checks = fixture.grade(
        { tools, result, audit, read: (path) => readFileSync(join(workspace, path), "utf8") },
        { failingEvidenceId },
      );
      results.push({
        id: fixture.id,
        description: fixture.description,
        checks,
        claim: result.claim,
        tools: tools.map((t) => t.name),
      });
    } finally {
      await worker.closeSegment().catch(() => {});
      rmSync(root, { recursive: true, force: true });
    }
  }
  const all = results.flatMap((r) => r.checks);
  return {
    worker: worker.mode,
    fixtures: results,
    passed: all.filter((c) => c.passed).length,
    total: all.length,
  };
}

export function renderSkillEval(result: SkillEvalResult): string {
  const lines = [
    `# Skill eval (${result.worker} worker): ${result.passed}/${result.total} checks passed`,
    "",
  ];
  for (const fixture of result.fixtures) {
    lines.push(
      `## ${fixture.id}`,
      fixture.description,
      `claim: ${fixture.claim}`,
      `tools: ${fixture.tools.join(", ") || "(none)"}`,
    );
    for (const check of fixture.checks)
      lines.push(`- [${check.passed ? "x" : " "}] ${check.id}: ${check.detail}`);
    lines.push("");
  }
  return lines.join("\n");
}
