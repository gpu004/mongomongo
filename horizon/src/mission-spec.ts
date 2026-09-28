import type { ContainerRegistry } from "../verification/candidate-process.ts";
import type { Suite, VerificationReport } from "../verification/reports.ts";
import type { EvidenceSink } from "../verification/runner.ts";
import type { FeatureScenario } from "./feature-map.ts";
import type { MissionConfig } from "./mission-contract.ts";
import type { ObjectiveMetric } from "./objective-metric.ts";
import type { Worker } from "./worker.ts";

/** One phase of the mission's task graph as seeded into the ledger. */
export interface ObjectiveTask {
  taskId: string;
  hypothesis: string;
  completionCriteria: string;
  nextAction: string;
}

/**
 * Every objective runs the same three phases in order: measure the seed,
 * optimize the metric toward the target, then confirm the best artifact on
 * held-out scenarios. The objective names and describes each phase.
 */
export interface ObjectiveTasks {
  baseline: ObjectiveTask;
  optimize: ObjectiveTask;
  holdout: ObjectiveTask;
}

export interface TaskSeed extends ObjectiveTask {
  ordinal: number;
  dependsOn: string[];
}

/** Everything an evaluator needs to judge one artifact; identities are checked before any candidate code runs. */
export interface EvaluationRequest {
  missionId: string;
  experimentId: string;
  artifactHash: string;
  evaluatorHash: string;
  environmentHash: string;
  snapshotDir: string;
  config: MissionConfig;
  evidence: EvidenceSink;
  learnedScenariosDir?: string;
  learnedSuiteVersion?: number;
  containerRegistry?: ContainerRegistry;
}

export interface ObjectiveEvaluator {
  /** Stable name recorded in mission events and doctor output. */
  id: string;
  /** Content hash of every file that can change a verdict; frozen per mission and drift-checked. */
  hash(): string;
  run(request: EvaluationRequest, suite: Suite): Promise<VerificationReport>;
}

/**
 * The objective plugin boundary. The controller owns budgets, ledger,
 * recovery, interruption and lesson bookkeeping; a spec supplies what is being
 * optimized and how an artifact is judged.
 */
export interface MissionSpec {
  /** Value of `missionSpec` in mission configuration. */
  id: string;
  description: string;
  metric: ObjectiveMetric;
  tasks: ObjectiveTasks;
  evaluator: ObjectiveEvaluator;
  /** Seed artifact directory imported as the mission's first artifact. */
  seedDir: string;
  /** Fixed scenarios (invariants) the evaluator checks; regression proposals must not reuse their ids. */
  scenariosDir: string;
  /** Every fixed and held-out scenario, for feature-map validation. */
  scenarios(): FeatureScenario[];
  /** Feature map (`resources/features.json` format) linking invariants to features. */
  featuresPath: string;
  /** Pi skills directory and the skill inlined into every packet. */
  skillsDir: string;
  skillPath: string;
  /** Objective paragraph of the worker system prompt; host-enforced rules are added by the worker. */
  workerPrompt: string;
  /** Pinned constraint line of every context packet. */
  constraints: string;
  /** Next action suggested after a candidate fails correctness. */
  correctionHint: string;
  /**
   * Whether workers may propose learned regressions. Proposals are validated
   * against the seed (must pass) and the spec's negative fixture (must fail).
   */
  regressions: { negativeFixture: string } | null;
  /** Repetitions per performance measurement; `requiredImprovedRepetitions` cannot exceed it. */
  repetitions(config: Partial<MissionConfig>): number;
  /** Objective-specific configuration problems (target field, workloads), first problem first. */
  validateConfig(config: Partial<MissionConfig>): string[];
  /** Pre-scenario structural check of an artifact directory (import boundaries); one line per violation. */
  structuralViolations(artifactDir: string): string[];
  /** Deterministic offline worker used by `worker: "scripted"` missions and acceptance tests. */
  scriptedWorker(): Worker;
}

export function taskSeeds(tasks: ObjectiveTasks): TaskSeed[] {
  return [
    { ...tasks.baseline, ordinal: 1, dependsOn: [] },
    { ...tasks.optimize, ordinal: 2, dependsOn: [tasks.baseline.taskId] },
    { ...tasks.holdout, ordinal: 3, dependsOn: [tasks.optimize.taskId] },
  ];
}
