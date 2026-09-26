import { createHash } from "node:crypto";

export type Suite = "smoke" | "correctness" | "performance" | "holdout" | "learned" | "structural";
export type ReportStatus = "passed" | "failed" | "infra_error" | "timeout";

export interface AssertionResult {
  id: string;
  passed: boolean;
  evidenceId: string;
  invariantIds?: string[];
  detail?: string;
}

export interface ReportMetrics {
  p95LatencyMs?: number;
  medianLatencyMs?: number;
  peakMemoryBytes?: number;
  measuredRequests?: number;
  failedRequests?: number;
  repetitionP95Ms?: number[];
}

export interface VerificationReport {
  schemaVersion: 1;
  reportId: string;
  missionId: string;
  experimentId: string;
  artifactHash: string;
  evaluatorHash: string;
  workloadHash: string;
  environmentHash: string;
  suite: Suite;
  status: ReportStatus;
  assertions: AssertionResult[];
  metrics: ReportMetrics;
  evidenceIds: string[];
  startedAt: string;
  finishedAt: string;
  /** Set by the runner when isolation is weaker than the design target. */
  isolation: "container" | "subprocess";
  learnedSuiteVersion?: number;
  infraMessage?: string;
}

export interface FrozenIdentities {
  artifactHash: string;
  evaluatorHash: string;
  workloadHash: string;
  environmentHash: string;
}

export function sha256(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function reportHash(report: VerificationReport): string {
  return sha256(canonicalJson(report));
}

export type ReportValidation = { ok: true } | { ok: false; reason: string };

/**
 * A report is only trusted when it came through the runner channel AND names
 * exactly the artifact/evaluator/workload/environment the controller expected.
 * Text that merely looks like a report (e.g. printed by a candidate) fails here.
 */
export function validateReport(
  report: unknown,
  expected: FrozenIdentities & { missionId: string; experimentId: string; suite: Suite },
): ReportValidation {
  if (typeof report !== "object" || report === null)
    return { ok: false, reason: "report is not an object" };
  const r = report as Partial<VerificationReport>;
  if (r.schemaVersion !== 1)
    return { ok: false, reason: `unsupported schemaVersion ${String(r.schemaVersion)}` };
  if (typeof r.reportId !== "string" || r.reportId.length === 0)
    return { ok: false, reason: "missing reportId" };
  if (r.missionId !== expected.missionId) return { ok: false, reason: "missionId mismatch" };
  if (r.experimentId !== expected.experimentId)
    return { ok: false, reason: "experimentId mismatch" };
  if (r.suite !== expected.suite)
    return { ok: false, reason: `suite mismatch: ${String(r.suite)}` };
  if (r.artifactHash !== expected.artifactHash)
    return { ok: false, reason: "artifactHash mismatch" };
  if (r.evaluatorHash !== expected.evaluatorHash)
    return { ok: false, reason: "evaluatorHash mismatch" };
  if (r.workloadHash !== expected.workloadHash)
    return { ok: false, reason: "workloadHash mismatch" };
  if (r.environmentHash !== expected.environmentHash)
    return { ok: false, reason: "environmentHash mismatch" };
  if (!["passed", "failed", "infra_error", "timeout"].includes(String(r.status))) {
    return { ok: false, reason: `invalid status ${String(r.status)}` };
  }
  if (!Array.isArray(r.assertions)) return { ok: false, reason: "assertions missing" };
  if (!Array.isArray(r.evidenceIds)) return { ok: false, reason: "evidenceIds missing" };
  if (r.status === "passed" && r.assertions.some((a) => !a.passed)) {
    return { ok: false, reason: "status passed but an assertion failed" };
  }
  if (r.suite === "performance" && r.status === "passed") {
    const m = r.metrics ?? {};
    if (typeof m.p95LatencyMs !== "number" || !Number.isFinite(m.p95LatencyMs)) {
      return { ok: false, reason: "performance report lacks p95LatencyMs" };
    }
    if (!m.measuredRequests || m.measuredRequests <= 0) {
      return { ok: false, reason: "performance report measured zero requests" };
    }
    if ((m.failedRequests ?? 0) > 0)
      return { ok: false, reason: "performance report has failed requests" };
  }
  return { ok: true };
}
