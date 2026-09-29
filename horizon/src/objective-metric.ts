import type { ReportMetrics } from "../verification/reports.ts";

export type MetricDirection = "minimize" | "maximize";

/** The single number an objective optimizes, read from performance reports. */
export interface ObjectiveMetric {
  /** `ReportMetrics` key holding the aggregate compared across artifacts. */
  key: string;
  /** `ReportMetrics` key holding the per-repetition series paired across artifacts. */
  repetitionsKey: string;
  /** Short name used in verdicts and packets, e.g. `p95`. */
  label: string;
  unit: string;
  direction: MetricDirection;
  /** `LessonRow.invariantId` of measured performance lessons about this metric. */
  lessonMetric: string;
  /** A request-driven metric is only valid when requests were measured and none failed. */
  requestDriven: boolean;
}

export const P95_METRIC: ObjectiveMetric = {
  key: "p95LatencyMs",
  repetitionsKey: "repetitionP95Ms",
  label: "p95",
  unit: "ms",
  direction: "minimize",
  lessonMetric: "PERF-P95",
  requestDriven: true,
};

export function metricValue(metrics: ReportMetrics, metric: ObjectiveMetric): number | undefined {
  const value = metrics[metric.key];
  return typeof value === "number" ? value : undefined;
}

export function metricSeries(
  metrics: ReportMetrics,
  metric: ObjectiveMetric,
): number[] | undefined {
  const value = metrics[metric.repetitionsKey];
  return Array.isArray(value) ? value : undefined;
}

/** Strictly better in the metric's direction. */
export function isBetter(value: number, reference: number, metric: ObjectiveMetric): boolean {
  return metric.direction === "minimize" ? value < reference : value > reference;
}

/** `reference` moved by `fraction` in the improving direction: the bound a candidate must reach. */
export function improvedBound(
  reference: number,
  fraction: number,
  metric: ObjectiveMetric,
): number {
  return metric.direction === "minimize" ? reference * (1 - fraction) : reference * (1 + fraction);
}

/** Whether `value` reaches `bound` (inclusive) in the metric's direction. */
export function reaches(value: number, bound: number, metric: ObjectiveMetric): boolean {
  return metric.direction === "minimize" ? value <= bound : value >= bound;
}

/** `p95 12ms`, `bundle 4096B`; `n/a` for an unmeasured value. */
export function formatMetric(value: number | null | undefined, metric: ObjectiveMetric): string {
  return `${metric.label} ${value ?? "n/a"}${metric.unit}`;
}

/** Word used in verdicts for the improving direction: `below` or `above`. */
export function improvingWord(metric: ObjectiveMetric): string {
  return metric.direction === "minimize" ? "below" : "above";
}
