import type { ReportMetrics } from "../verification/reports.ts";

export interface TimingPolicy {
  acceptanceMargin: number;
  requiredImprovedRepetitions: number;
}

/**
 * accept/reject are final. ambiguous means the p95 cleared the margin but too
 * few paired repetitions agreed; the controller re-measures once. inconclusive
 * means the re-measurement still did not separate signal from noise.
 */
export type TimingKind = "accept" | "reject" | "ambiguous" | "inconclusive";

export interface TimingDecision {
  kind: TimingKind;
  reason: string;
}

export function pairedImprovements(candidate: number[], best: number[]): number {
  return candidate.filter((value, index) => best[index] !== undefined && value < best[index]!)
    .length;
}

/** Relative spread (max-min)/median of per-repetition p95s; 0 when fewer than two repetitions. */
export function repetitionSpread(reps: number[] | undefined): number {
  if (!reps || reps.length < 2) return 0;
  const sorted = [...reps].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  return median > 0 ? (sorted.at(-1)! - sorted[0]!) / median : 0;
}

export type NoiseFloorDecision =
  | { kind: "frozen"; acceptanceMargin: number; raised: boolean }
  | { kind: "repair"; reason: string };

/**
 * HACKATHON_PLAN §14: the margin frozen for the mission must exceed the noise
 * observed during baseline setup. When the spread stays under the configured
 * margin, the configured margin is frozen as-is; when it exceeds it but is
 * still below `maxRepetitionSpread`, the margin is raised to the spread rounded
 * up to 0.1%; beyond that ceiling no margin can distinguish a useful change and
 * the workload or environment must be repaired before optimization.
 */
export function freezeAcceptanceMargin(
  configuredMargin: number,
  spread: number,
  maxRepetitionSpread: number,
): NoiseFloorDecision {
  if (spread >= maxRepetitionSpread)
    return {
      kind: "repair",
      reason: `baseline repetition spread ${(spread * 100).toFixed(1)}% reaches the ${(maxRepetitionSpread * 100).toFixed(1)}% ceiling; repair the workload or environment before optimizing`,
    };
  if (spread <= configuredMargin)
    return { kind: "frozen", acceptanceMargin: configuredMargin, raised: false };
  const raised = Math.ceil(Math.round(spread * 1e6) / 1000) / 1000;
  return { kind: "frozen", acceptanceMargin: raised, raised: true };
}

export function firstComparison(
  candidate: ReportMetrics,
  bestP95: number | null,
  bestReps: number[] | undefined,
  policy: TimingPolicy,
): TimingDecision {
  const p95 = candidate.p95LatencyMs;
  if (p95 === undefined || bestP95 === null) return { kind: "reject", reason: "no comparable p95" };
  const required = bestP95 * (1 - policy.acceptanceMargin);
  if (p95 > required)
    return {
      kind: "reject",
      reason: `p95 ${p95}ms not below ${required.toFixed(2)}ms (best ${bestP95}ms minus margin)`,
    };
  const candidateReps = candidate.repetitionP95Ms ?? [];
  if (!bestReps || bestReps.length === 0)
    return {
      kind: "accept",
      reason: `p95 ${p95}ms vs best ${bestP95}ms; no paired repetitions recorded for best`,
    };
  const improved = pairedImprovements(candidateReps, bestReps);
  if (improved < policy.requiredImprovedRepetitions) {
    return {
      kind: "ambiguous",
      reason: `p95 ${p95}ms cleared the margin but only ${improved}/${candidateReps.length} paired repetitions improved; ${policy.requiredImprovedRepetitions} required`,
    };
  }
  return {
    kind: "accept",
    reason: `p95 ${p95}ms vs best ${bestP95}ms; ${improved}/${candidateReps.length} paired repetitions improved`,
  };
}

/**
 * Decision after one back-to-back re-measurement of best and candidate. The
 * margin must hold again against the freshly measured best, and the paired
 * repetitions pooled over both measurements must meet twice the single-run
 * requirement, so a second chance does not lower the bar.
 */
export function rerunComparison(
  first: ReportMetrics,
  firstBestReps: number[],
  rerunCandidate: ReportMetrics,
  rerunBest: ReportMetrics,
  policy: TimingPolicy,
): TimingDecision {
  const p95 = rerunCandidate.p95LatencyMs;
  const bestP95 = rerunBest.p95LatencyMs;
  if (p95 === undefined || bestP95 === undefined)
    return { kind: "inconclusive", reason: "timing rerun produced no comparable p95" };
  if (p95 >= bestP95)
    return {
      kind: "reject",
      reason: `timing rerun: p95 ${p95}ms not below best ${bestP95}ms measured back-to-back`,
    };
  const pooled =
    pairedImprovements(first.repetitionP95Ms ?? [], firstBestReps) +
    pairedImprovements(rerunCandidate.repetitionP95Ms ?? [], rerunBest.repetitionP95Ms ?? []);
  const total =
    (first.repetitionP95Ms?.length ?? 0) + (rerunCandidate.repetitionP95Ms?.length ?? 0);
  const needed = policy.requiredImprovedRepetitions * 2;
  const required = bestP95 * (1 - policy.acceptanceMargin);
  if (p95 <= required && pooled >= needed)
    return {
      kind: "accept",
      reason: `accepted after timing rerun: p95 ${p95}ms vs best ${bestP95}ms back-to-back; ${pooled}/${total} pooled paired repetitions improved (${needed} required)`,
    };
  return {
    kind: "inconclusive",
    reason: `timing ambiguous after one rerun: p95 ${p95}ms vs best ${bestP95}ms (required <= ${required.toFixed(2)}ms); ${pooled}/${total} pooled paired repetitions improved (${needed} required)`,
  };
}
