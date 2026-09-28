import { join } from "node:path";
import { canonicalJson } from "../../verification/reports.ts";
import { computeEvaluatorHash, runSuite } from "../../verification/runner.ts";
import { loadScenarios } from "../../verification/scenarios/index.ts";
import { checkImportBoundaries } from "../../verification/structural.ts";
import { SEED_DIR } from "../artifact-store.ts";
import type { MissionSpec } from "../mission-spec.ts";
import { P95_METRIC } from "../objective-metric.ts";
import { ScriptedWorker } from "../scripted-worker.ts";

const RESOURCES_DIR = new URL("../../resources/", import.meta.url).pathname;
const VERIFICATION_DIR = new URL("../../verification/", import.meta.url).pathname;

/** The first objective: reduce GET /search p95 on a fixed read-heavy workload without breaking the search contract. */
export const SEARCH_P95: MissionSpec = {
  id: "search-p95",
  description: "p95 latency of GET /search on the demo document-search service",
  metric: P95_METRIC,
  tasks: {
    baseline: {
      taskId: "baseline",
      hypothesis: "measure the seed",
      completionCriteria: "seed passes correctness and has a valid performance report",
      nextAction: "run fixed suites on the seed artifact",
    },
    optimize: {
      taskId: "optimize-search",
      hypothesis: "reduce read-path p95",
      completionCriteria: "best artifact p95 <= baseline * (1 - target)",
      nextAction: "profile the seed read path and propose one bounded change",
    },
    holdout: {
      taskId: "holdout",
      hypothesis: "best artifact generalizes",
      completionCriteria: "holdout suite passes on the chosen artifact",
      nextAction: "run holdout on the best artifact",
    },
  },
  evaluator: {
    id: "search-http",
    hash: () => computeEvaluatorHash(),
    run(request, suite) {
      const { config } = request;
      if (!config.workload || !config.holdoutWorkload)
        throw new Error("search-p95 requires workload and holdoutWorkload");
      return runSuite(
        {
          missionId: request.missionId,
          experimentId: request.experimentId,
          artifactHash: request.artifactHash,
          evaluatorHash: request.evaluatorHash,
          environmentHash: request.environmentHash,
          snapshotDir: request.snapshotDir,
          isolation: config.isolation,
          containerImage: config.containerImage,
          startupTimeoutMs: config.startupTimeoutMs,
          requestTimeoutMs: config.requestTimeoutMs,
          memoryLimitBytes: config.memoryLimitBytes,
          workload: config.workload,
          holdoutWorkload: config.holdoutWorkload,
          evidence: request.evidence,
          ...(request.learnedScenariosDir !== undefined
            ? { learnedScenariosDir: request.learnedScenariosDir }
            : {}),
          ...(request.learnedSuiteVersion !== undefined
            ? { learnedSuiteVersion: request.learnedSuiteVersion }
            : {}),
          ...(request.containerRegistry !== undefined
            ? { containerRegistry: request.containerRegistry }
            : {}),
        },
        suite,
      );
    },
  },
  seedDir: SEED_DIR,
  scenariosDir: join(VERIFICATION_DIR, "scenarios"),
  scenarios: () => loadScenarios(join(VERIFICATION_DIR, "scenarios")),
  featuresPath: join(RESOURCES_DIR, "features.json"),
  skillsDir: join(RESOURCES_DIR, "skills"),
  skillPath: join(RESOURCES_DIR, "skills/verify-search/SKILL.md"),
  workerPrompt: `The artifact is a small TypeScript document-search service; the mission reduces GET /search p95 latency.
- Correctness comes before speed. The frozen contract (NFC normalization, lowercase, whitespace-split terms, every term a substring of title+" "+body, insertion order, limit after ordering, mutations visible immediately) must hold.
- Mutations must go through the DocumentService entry point; the HTTP layer must not touch storage directly.`,
  constraints:
    "edits only under src/; mutations via DocumentService; contract invariants are fixed; the verifier is the only source of truth.",
  correctionHint:
    "read the failing assertion evidence, then restore invalidation before optimizing again",
  regressions: { negativeFixture: "stale-cache" },
  repetitions: (config) => config.workload?.repetitions ?? 0,
  validateConfig(c) {
    if (c.targetImprovement !== undefined)
      return ["search-p95 names its target targetP95Reduction, not targetImprovement"];
    const t = c.targetP95Reduction;
    if (typeof t !== "number" || !Number.isFinite(t) || t <= 0 || t >= 1)
      return ["targetP95Reduction must be in (0,1)"];
    if (!c.workload || !c.holdoutWorkload) return ["workload and holdoutWorkload required"];
    if (c.workload.repetitions < 2) return ["workload.repetitions must be >= 2"];
    if (canonicalJson(c.workload) === canonicalJson(c.holdoutWorkload))
      return ["holdoutWorkload must differ from workload"];
    return [];
  },
  structuralViolations: (dir) =>
    checkImportBoundaries(join(dir, "src")).map((v) => `${v.file}:${v.line} ${v.rule} ${v.detail}`),
  scriptedWorker: () => new ScriptedWorker(),
};
