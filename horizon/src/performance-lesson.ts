import { sha256 } from "../verification/reports.ts";
import type { LessonRow, LessonState } from "./ledger.ts";

export type PerformanceLessonKind = "performance_negative" | "performance_positive";

/** Metric identifier recorded in `LessonRow.invariantId` for lessons about p95 rather than a correctness invariant. */
export const PERFORMANCE_METRIC = "PERF-P95";

/** One measured outcome of trying a mechanism; every number points back to a committed report. */
export interface PerformanceObservation {
  experimentId: string;
  episodeId: string;
  candidateP95Ms: number | null;
  comparedP95Ms: number | null;
  /** (candidate - compared) / compared; negative is faster. Null when either side is unmeasured. */
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
}

export function performanceLessonId(kind: PerformanceLessonKind, mechanism: string): string {
  const prefix = kind === "performance_negative" ? "perf-neg" : "perf-pos";
  return `${prefix}-${sha256(mechanism).slice(0, 12)}`;
}

export function isPerformanceLesson(row: LessonRow): boolean {
  return row.invariantId === PERFORMANCE_METRIC;
}

export function decodePerformanceLesson(row: LessonRow): PerformanceLesson | undefined {
  if (!isPerformanceLesson(row) || !row.proposal) return undefined;
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
    invariantId: PERFORMANCE_METRIC,
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
 * A PERF-P95 lesson requires two comparable measurements. A failed performance
 * suite (resource limit, correctness under load, missing p95) is not a p95 verdict
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
    kind: PerformanceLessonKind;
    mechanism: string;
    hypothesis: string;
    featureIds: string[];
    observation: PerformanceObservation;
  },
): PerformanceLesson {
  const base: PerformanceLesson = existing ?? {
    kind: input.kind,
    lessonId: performanceLessonId(input.kind, input.mechanism),
    mechanism: input.mechanism,
    hypothesis: input.hypothesis,
    featureIds: [],
    observations: [],
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
  preferredMechanisms: { lessonId: string; mechanism: string; deltaFraction: number | null }[];
  /** Features touched by accepted mechanisms; retrieval is weighted toward episodes sharing them. */
  focusFeatureIds: string[];
  limit: number;
}

function bestDelta(lesson: PerformanceLesson): number | null {
  const deltas = lesson.observations
    .map((o) => o.deltaFraction)
    .filter((d): d is number => d !== null);
  return deltas.length > 0 ? Math.min(...deltas) : null;
}

function worstDelta(lesson: PerformanceLesson): number {
  const deltas = lesson.observations
    .map((o) => o.deltaFraction)
    .filter((d): d is number => d !== null);
  return deltas.length > 0 ? Math.max(...deltas) : 0;
}

/** Ranks lessons for a packet: positives by largest improvement, negatives by rejections then worst regression. */
export function rankPerformanceLessons(lessons: PerformanceLesson[]): PerformanceLesson[] {
  return [...lessons].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "performance_positive" ? -1 : 1;
    if (a.kind === "performance_positive") return (bestDelta(a) ?? 0) - (bestDelta(b) ?? 0);
    return b.observations.length - a.observations.length || worstDelta(b) - worstDelta(a);
  });
}

export function decidePerformancePolicy(
  lessons: PerformanceLesson[],
  limit: number,
): PerformancePolicy {
  const ranked = rankPerformanceLessons(lessons);
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
      .map((l) => ({ lessonId: l.lessonId, mechanism: l.mechanism, deltaFraction: bestDelta(l) })),
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
): string {
  if (lessons.length === 0) return "(none)";
  const blocked = new Set(policy.blockedMechanisms.map((b) => b.lessonId));
  return rankPerformanceLessons(lessons)
    .map((lesson, i) => {
      const label = lesson.kind === "performance_positive" ? "POSITIVE" : "NEGATIVE";
      const obs = lesson.observations
        .map(
          (o) =>
            `    ${o.experimentId}: p95 ${o.candidateP95Ms ?? "n/a"}ms vs ${o.comparedP95Ms ?? "n/a"}ms (${percent(o.deltaFraction)})${o.profiled ? ", profiled" : ""}; evidence ${o.evidenceIds.slice(0, 3).join(", ") || "-"}; reports ${o.reportIds.slice(0, 3).join(", ") || "-"}`,
        )
        .join("\n");
      const verdict =
        lesson.kind === "performance_positive"
          ? `accepted; best delta ${percent(bestDelta(lesson))}`
          : `rejected ${lesson.observations.length}x on measurement${blocked.has(lesson.lessonId) ? `; BLOCKED (limit ${policy.limit}): profile first or choose a different mechanism` : ""}`;
      return `${i + 1}. [${label}] ${lesson.lessonId} mechanism "${lesson.hypothesis}" (${verdict}); features ${lesson.featureIds.join(", ") || "-"}\n${obs}`;
    })
    .join("\n");
}
