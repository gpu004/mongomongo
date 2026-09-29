import { sha256 } from "../verification/reports.ts";
import type { LessonRow, LessonState } from "./ledger.ts";
import { formatMetric, type ObjectiveMetric, P95_METRIC } from "./objective-metric.ts";

export type PerformanceLessonKind = "performance_negative" | "performance_positive";

/** Metric identifier recorded in `LessonRow.invariantId` for lessons about p95 rather than a correctness invariant. */
export const PERFORMANCE_METRIC = P95_METRIC.lessonMetric;

/**
 * One measured outcome of trying a mechanism; every number points back to a committed report.
 * `candidateP95Ms`/`comparedP95Ms` hold the mission metric's value; the names are the persisted
 * format from the first (p95) objective.
 */
export interface PerformanceObservation {
  experimentId: string;
  episodeId: string;
  candidateP95Ms: number | null;
  comparedP95Ms: number | null;
  /** (candidate - compared) / compared; negative is smaller. Null when either side is unmeasured. */
  deltaFraction: number | null;
  reportIds: string[];
  evidenceIds: string[];
  /** Whether the worker profiled before editing in that cycle. */
  profiled: boolean;
  reason: string;
  at: string;
}

export interface PerformanceLesson {
  kind: PerformanceLessonKind;
  lessonId: string;
  /** Normalized hypothesis; reworded repeats of one mechanism share a lesson. */
  mechanism: string;
  hypothesis: string;
  featureIds: string[];
  observations: PerformanceObservation[];
  /** `ObjectiveMetric.lessonMetric` the observations measure; PERF-P95 when absent. */
  metric?: string;
}

/** Mission-scoped: the lesson table is keyed by `lessonId` alone on every backend, so two missions trying one mechanism must not share a row. */
export function performanceLessonId(
  missionId: string,
  kind: PerformanceLessonKind,
  mechanism: string,
): string {
  const prefix = kind === "performance_negative" ? "perf-neg" : "perf-pos";
  return `${prefix}-${sha256(`${missionId}\n${mechanism}`).slice(0, 12)}`;
}

export function isPerformanceLesson(row: LessonRow, metric: ObjectiveMetric = P95_METRIC): boolean {
  return row.invariantId === metric.lessonMetric;
}

export function decodePerformanceLesson(
  row: LessonRow,
  metric: ObjectiveMetric = P95_METRIC,
): PerformanceLesson | undefined {
  if (!isPerformanceLesson(row, metric) || !row.proposal) return undefined;
  const parsed = JSON.parse(row.proposal) as PerformanceLesson;
  return { ...parsed, lessonId: row.lessonId };
}

/** Negative lessons harden from observed to reproduced on the second rejection; positive lessons are validated by acceptance. */
export function performanceLessonState(lesson: PerformanceLesson): LessonState {
  if (lesson.kind === "performance_positive") return "validated";
  return lesson.observations.length >= 2 ? "reproduced" : "observed";
}

export function encodePerformanceLesson(missionId: string, lesson: PerformanceLesson): LessonRow {
  const state = performanceLessonState(lesson);
  const latest = lesson.observations.at(-1);
  const evidenceId = latest?.evidenceIds[0] ?? null;
  return {
    lessonId: lesson.lessonId,
    missionId,
    sourceEpisodeIds: [...new Set(lesson.observations.map((o) => o.episodeId))],
    invariantId: lesson.metric ?? PERFORMANCE_METRIC,
    state,
    proposal: JSON.stringify(lesson),
    positiveEvidenceId: lesson.kind === "performance_positive" ? evidenceId : null,
    negativeEvidenceId: lesson.kind === "performance_negative" ? evidenceId : null,
    materializedScenarioId: null,
    transitions: lesson.observations.map((o, i) => ({
      state:
        lesson.kind === "performance_positive" ? "validated" : i === 0 ? "observed" : "reproduced",
      at: o.at,
      evidenceId: o.evidenceIds[0] ?? null,
    })),
  };
}

export function deltaFraction(
  candidateP95Ms: number | null | undefined,
  comparedP95Ms: number | null | undefined,
): number | null {
  if (
    candidateP95Ms === null ||
    candidateP95Ms === undefined ||
    comparedP95Ms === null ||
    comparedP95Ms === undefined ||
    comparedP95Ms <= 0
  )
    return null;
  return (candidateP95Ms - comparedP95Ms) / comparedP95Ms;
}

/**
 * A performance lesson requires two comparable measurements. A failed performance
 * suite (resource limit, correctness under load, missing metric) is not a metric verdict
 * and must not count toward the mechanism's rejection tally.
 */
export function isMeasuredP95Comparison(
  candidateP95Ms: number | null | undefined,
  comparedP95Ms: number | null | undefined,
): boolean {
  return deltaFraction(candidateP95Ms, comparedP95Ms) !== null;
}

/** Appends an observation to the lesson for `mechanism`, creating the lesson on first sight. */
export function recordPerformanceObservation(
  existing: PerformanceLesson | undefined,
  input: {
    missionId: string;
    kind: PerformanceLessonKind;
    mechanism: string;
    hypothesis: string;
    featureIds: string[];
    observation: PerformanceObservation;
    /** Lesson metric id; omitted for PERF-P95 so p95 lessons keep their persisted shape. */
    metric?: string;
  },
): PerformanceLesson {
  const base: PerformanceLesson = existing ?? {
    kind: input.kind,
    lessonId: performanceLessonId(input.missionId, input.kind, input.mechanism),
    mechanism: input.mechanism,
    hypothesis: input.hypothesis,
    featureIds: [],
    observations: [],
    ...(input.metric && input.metric !== PERFORMANCE_METRIC ? { metric: input.metric } : {}),
  };
  if (base.observations.some((o) => o.experimentId === input.observation.experimentId)) return base;
  return {
    ...base,
    featureIds: [...new Set([...base.featureIds, ...input.featureIds])],
    observations: [...base.observations, input.observation],
  };
}

export interface PerformancePolicy {
  /** Mechanisms rejected at least `limit` times on measurement alone; repeating one without profiling is refused. */
  blockedMechanisms: {
    lessonId: string;
    mechanism: string;
    rejections: number;
    evidenceIds: string[];
  }[];
  /** Accepted mechanisms, best measured delta first. */
  preferredMechanisms: {
    lessonId: string;
    mechanism: string;
    deltaFraction: number | null;
  }[];
  /** Features touched by accepted mechanisms; retrieval is weighted toward episodes sharing them. */
  focusFeatureIds: string[];
  limit: number;
}

/** Deltas oriented so that smaller is better in the metric's direction. */
function orientedDeltas(lesson: PerformanceLesson, metric: ObjectiveMetric): number[] {
  const sign = metric.direction === "minimize" ? 1 : -1;
  return lesson.observations
    .map((o) => o.deltaFraction)
    .filter((d): d is number => d !== null)
    .map((d) => d * sign);
}

function bestDelta(lesson: PerformanceLesson, metric: ObjectiveMetric): number | null {
  const deltas = orientedDeltas(lesson, metric);
  if (deltas.length === 0) return null;
  const best = Math.min(...deltas);
  return metric.direction === "minimize" ? best : -best;
}

function bestOriented(lesson: PerformanceLesson, metric: ObjectiveMetric): number {
  const deltas = orientedDeltas(lesson, metric);
  return deltas.length > 0 ? Math.min(...deltas) : 0;
}

function worstOriented(lesson: PerformanceLesson, metric: ObjectiveMetric): number {
  const deltas = orientedDeltas(lesson, metric);
  return deltas.length > 0 ? Math.max(...deltas) : 0;
}

/** Ranks lessons for a packet: positives by largest improvement, negatives by rejections then worst regression. */
export function rankPerformanceLessons(
  lessons: PerformanceLesson[],
  metric: ObjectiveMetric = P95_METRIC,
): PerformanceLesson[] {
  return [...lessons].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "performance_positive" ? -1 : 1;
    if (a.kind === "performance_positive") return bestOriented(a, metric) - bestOriented(b, metric);
    return (
      b.observations.length - a.observations.length ||
      worstOriented(b, metric) - worstOriented(a, metric)
    );
  });
}

export function decidePerformancePolicy(
  lessons: PerformanceLesson[],
  limit: number,
  metric: ObjectiveMetric = P95_METRIC,
): PerformancePolicy {
  const ranked = rankPerformanceLessons(lessons, metric);
  return {
    blockedMechanisms: ranked
      .filter((l) => l.kind === "performance_negative" && l.observations.length >= limit)
      .map((l) => ({
        lessonId: l.lessonId,
        mechanism: l.mechanism,
        rejections: l.observations.length,
        evidenceIds: [...new Set(l.observations.flatMap((o) => o.evidenceIds))].slice(0, 8),
      })),
    preferredMechanisms: ranked
      .filter((l) => l.kind === "performance_positive")
      .map((l) => ({
        lessonId: l.lessonId,
        mechanism: l.mechanism,
        deltaFraction: bestDelta(l, metric),
      })),
    focusFeatureIds: [
      ...new Set(
        ranked.filter((l) => l.kind === "performance_positive").flatMap((l) => l.featureIds),
      ),
    ],
    limit,
  };
}

function percent(delta: number | null): string {
  return delta === null ? "n/a" : `${delta >= 0 ? "+" : ""}${(delta * 100).toFixed(1)}%`;
}

/** Structured, ranked packet section; one lesson per block, evidence IDs attached to every measured delta. */
export function renderPerformanceLessons(
  lessons: PerformanceLesson[],
  policy: PerformancePolicy,
  metric: ObjectiveMetric = P95_METRIC,
): string {
  if (lessons.length === 0) return "(none)";
  const blocked = new Set(policy.blockedMechanisms.map((b) => b.lessonId));
  return rankPerformanceLessons(lessons, metric)
    .map((lesson, i) => {
      const label = lesson.kind === "performance_positive" ? "POSITIVE" : "NEGATIVE";
      const obs = lesson.observations
        .map(
          (o) =>
            `    ${o.experimentId}: ${formatMetric(o.candidateP95Ms, metric)} vs ${o.comparedP95Ms ?? "n/a"}${metric.unit} (${percent(o.deltaFraction)})${o.profiled ? ", profiled" : ""}; evidence ${o.evidenceIds.slice(0, 3).join(", ") || "-"}; reports ${o.reportIds.slice(0, 3).join(", ") || "-"}`,
        )
        .join("\n");
      const verdict =
        lesson.kind === "performance_positive"
          ? `accepted; best delta ${percent(bestDelta(lesson, metric))}`
          : `rejected ${lesson.observations.length}x on measurement${blocked.has(lesson.lessonId) ? `; BLOCKED (limit ${policy.limit}): profile first or choose a different mechanism` : ""}`;
      return `${i + 1}. [${label}] ${lesson.lessonId} mechanism "${lesson.hypothesis}" (${verdict}); features ${lesson.featureIds.join(", ") || "-"}\n${obs}`;
    })
    .join("\n");
}
