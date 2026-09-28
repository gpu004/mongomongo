import type { ReportMetrics } from "../verification/reports.ts";
import {
  formatMetric,
  improvedBound,
  improvingWord,
  isBetter,
  metricSeries,
  metricValue,
  type ObjectiveMetric,
  P95_METRIC,
  reaches,
} from "./objective-metric.ts";

export interface TimingPolicy {
  acceptanceMargin: number;
  requiredImprovedRepetitions: number;
  /** Metric compared and its direction; p95 latency when omitted. */
  metric?: ObjectiveMetric;
}

/**
 * accept/reject are final. ambiguous means the metric cleared the margin but too
 * few paired repetitions agreed; the controller re-measures once. inconclusive
 * means the re-measurement still did not separate signal from noise.
 */
export type TimingKind = "accept" | "reject" | "ambiguous" | "inconclusive";

export interface TimingDecision {
  kind: TimingKind;
  reason: string;
}

export function pairedImprovements(
  candidate: number[],
  best: number[],
  metric: ObjectiveMetric = P95_METRIC,
): number {
  return candidate.filter(
    (value, index) => best[index] !== undefined && isBetter(value, best[index]!, metric),
  ).length;
}

/** Relative spread (max-min)/median of per-repetition measurements; 0 when fewer than two repetitions. */
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
  const metric = policy.metric ?? P95_METRIC;
  const value = metricValue(candidate, metric);
  const show = (v: number | string) => `${v}${metric.unit}`;
  if (value === undefined || bestP95 === null)
    return { kind: "reject", reason: `no comparable ${metric.label}` };
  const required = improvedBound(bestP95, policy.acceptanceMargin, metric);
  if (!reaches(value, required, metric))
    return {
      kind: "reject",
      reason: `${formatMetric(value, metric)} not ${improvingWord(metric)} ${show(required.toFixed(2))} (best ${show(bestP95)} ${metric.direction === "minimize" ? "minus" : "plus"} margin)`,
    };
  const candidateReps = metricSeries(candidate, metric) ?? [];
  if (!bestReps || bestReps.length === 0)
    return {
      kind: "accept",
      reason: `${formatMetric(value, metric)} vs best ${show(bestP95)}; no paired repetitions recorded for best`,
    };
  const improved = pairedImprovements(candidateReps, bestReps, metric);
  if (improved < policy.requiredImprovedRepetitions) {
    return {
      kind: "ambiguous",
      reason: `${formatMetric(value, metric)} cleared the margin but only ${improved}/${candidateReps.length} paired repetitions improved; ${policy.requiredImprovedRepetitions} required`,
    };
  }
  return {
    kind: "accept",
    reason: `${formatMetric(value, metric)} vs best ${show(bestP95)}; ${improved}/${candidateReps.length} paired repetitions improved`,
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
  const metric = policy.metric ?? P95_METRIC;
  const show = (v: number | string) => `${v}${metric.unit}`;
  const value = metricValue(rerunCandidate, metric);
  const bestValue = metricValue(rerunBest, metric);
  if (value === undefined || bestValue === undefined)
    return {
      kind: "inconclusive",
      reason: `timing rerun produced no comparable ${metric.label}`,
    };
  if (!isBetter(value, bestValue, metric))
    return {
      kind: "reject",
      reason: `timing rerun: ${formatMetric(value, metric)} not ${improvingWord(metric)} best ${show(bestValue)} measured back-to-back`,
    };
  const firstReps = metricSeries(first, metric) ?? [];
  const rerunReps = metricSeries(rerunCandidate, metric) ?? [];
  const pooled =
    pairedImprovements(firstReps, firstBestReps, metric) +
    pairedImprovements(rerunReps, metricSeries(rerunBest, metric) ?? [], metric);
  const total = firstReps.length + rerunReps.length;
  const needed = policy.requiredImprovedRepetitions * 2;
  const required = improvedBound(bestValue, policy.acceptanceMargin, metric);
  if (reaches(value, required, metric) && pooled >= needed)
    return {
      kind: "accept",
      reason: `accepted after timing rerun: ${formatMetric(value, metric)} vs best ${show(bestValue)} back-to-back; ${pooled}/${total} pooled paired repetitions improved (${needed} required)`,
    };
  return {
    kind: "inconclusive",
    reason: `timing ambiguous after one rerun: ${formatMetric(value, metric)} vs best ${show(bestValue)} (required ${metric.direction === "minimize" ? "<=" : ">="} ${show(required.toFixed(2))}); ${pooled}/${total} pooled paired repetitions improved (${needed} required)`,
  };
}
