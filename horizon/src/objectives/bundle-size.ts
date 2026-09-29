import { join } from "node:path";
import {
  BUNDLE_METRIC_KEY,
  BUNDLE_REPETITIONS_KEY,
  BUNDLE_VERIFICATION_DIR,
  checkSelfContained,
  computeBundleEvaluatorHash,
  loadBundleScenarios,
  runBundleSuite,
} from "../../verification/bundle-size/evaluator.ts";
import type { MissionSpec } from "../mission-spec.ts";
import type { ObjectiveMetric } from "../objective-metric.ts";
import type { SegmentHandle, Worker, WorkerCycleInput, WorkerCycleResult } from "../worker.ts";

const RESOURCES_DIR = new URL("../../resources/bundle-size/", import.meta.url).pathname;

export const TEXT_KIT_SEED_DIR = new URL("../../demo/text-kit/", import.meta.url).pathname;

export const BUNDLE_METRIC: ObjectiveMetric = {
  key: BUNDLE_METRIC_KEY,
  repetitionsKey: BUNDLE_REPETITIONS_KEY,
  label: "bundleBytes",
  unit: "B",
  direction: "minimize",
  lessonMetric: "PERF-BUNDLE-BYTES",
  requestDriven: false,
};

const FOLD_WITHOUT_DECOMPOSITION = `export const slugify = (t: string): string =>
  t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
`;

const TRIMMED_CASE = `export function titleCase(text: string): string {
  let out = "";
  let start = true;
  for (const ch of text.toLowerCase()) {
    const space = /\\s/u.test(ch);
    out += !space && start ? ch.toUpperCase() : ch;
    start = space;
  }
  return out;
}
`;

const COMPACT_MODULES: Record<string, string> = {
  "src/slug.ts": `export const slugify = (t: string): string =>
  t.normalize("NFKD").replace(/\\p{M}+/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
`,
  "src/case.ts": `export const titleCase = (t: string): string =>
  t.toLowerCase().replace(/(^|\\s)(\\S)/gu, (_, s: string, c: string) => s + c.toUpperCase());
`,
  "src/words.ts": `export const wordCount = (t: string): number => (t.match(/[\\p{L}\\p{N}]+/gu) ?? []).length;
`,
  "src/truncate.ts": `export function truncate(t: string, max: number): string {
  if (!Number.isInteger(max) || max < 0) throw new RangeError("max must be a non-negative integer");
  const p = Array.from(t);
  return p.length <= max ? t : max === 0 ? "" : p.slice(0, max - 1).join("") + "\\u2026";
}
`,
  "src/index.ts": `export { titleCase } from "./case.ts";
export { slugify } from "./slug.ts";
export { truncate } from "./truncate.ts";
export { wordCount } from "./words.ts";
`,
};

type BundleStep = "fold-ascii" | "trim-case" | "compact" | "exhausted";

const STEPS: Record<
  Exclude<BundleStep, "exhausted">,
  { hypothesis: string; whatChanged: string }
> = {
  "fold-ascii": {
    hypothesis: "drop the accent table and decomposition from slugify",
    whatChanged: "slugify lowercases and dashes without folding accents",
  },
  "trim-case": {
    hypothesis: "shorten the title-case helper",
    whatChanged: "titleCase inlined its whitespace and uppercase helpers",
  },
  compact: {
    hypothesis:
      "replace hand-written loops and dead tables with the regex one-liners the contract describes",
    whatChanged:
      "every module rewritten as a regex one-liner; accent table and legacy stop words removed",
  },
};

/**
 * Deterministic offline worker for the bundle-size objective: one change that
 * breaks diacritic folding (rejected by correctness), one correct change that
 * improves on the seed but falls short of the target, then the compact rewrite
 * that reaches it.
 */
export class BundleScriptedWorker implements Worker {
  readonly mode = "scripted" as const;

  async openSegment(ordinal: number): Promise<SegmentHandle> {
    return { sessionPath: null, sessionId: `scripted-bundle-segment-${ordinal}` };
  }

  async runCycle(input: WorkerCycleInput): Promise<WorkerCycleResult> {
    const { broker } = input;
    const usage = { inputTokens: input.packet.tokens, outputTokens: 200, uncertain: true };
    const step = this.stepFor(input.packet.text);
    if (step === "exhausted")
      return {
        hypothesis: "none",
        whatChanged: "nothing",
        claim: "no further hypotheses in script",
        usage,
        seededFixture: null,
        aborted: false,
        compactions: 0,
      };
    if (step === "fold-ascii")
      broker.workspaceEdit("src/slug.ts", { content: FOLD_WITHOUT_DECOMPOSITION });
    else if (step === "trim-case") broker.workspaceEdit("src/case.ts", { content: TRIMMED_CASE });
    else
      for (const [path, content] of Object.entries(COMPACT_MODULES))
        broker.workspaceEdit(path, { content });
    const smoke = await broker.verifyCandidate("smoke");
    const correctness =
      smoke.status === "passed" ? await broker.verifyCandidate("correctness") : null;
    return {
      ...STEPS[step],
      claim: `smoke ${smoke.status}; correctness ${correctness?.status ?? "not run"}`,
      usage,
      seededFixture: null,
      aborted: false,
      compactions: 0,
    };
  }

  private stepFor(packet: string): BundleStep {
    for (const step of ["fold-ascii", "trim-case", "compact"] as const)
      if (!packet.includes(STEPS[step].whatChanged)) return step;
    return "exhausted";
  }

  async closeSegment(): Promise<void> {}

  async abort(): Promise<void> {}
}

/** Second objective: shrink the shipped bytes of a small text library without changing its behavior. */
export const BUNDLE_SIZE: MissionSpec = {
  id: "bundle-size",
  description: "total bytes under src/ of the text-kit library",
  metric: BUNDLE_METRIC,
  tasks: {
    baseline: {
      taskId: "baseline",
      hypothesis: "measure the seed bundle",
      completionCriteria: "seed passes correctness and has a valid bundle-size report",
      nextAction: "run fixed suites on the seed artifact",
    },
    optimize: {
      taskId: "shrink-bundle",
      hypothesis: "remove redundant code from the shipped modules",
      completionCriteria: "best artifact bundleBytes <= baseline * (1 - target)",
      nextAction: "read the largest module and propose one bounded reduction",
    },
    holdout: {
      taskId: "holdout",
      hypothesis: "the smaller bundle keeps its behavior on unseen inputs",
      completionCriteria: "holdout suite passes on the chosen artifact",
      nextAction: "run holdout on the best artifact",
    },
  },
  evaluator: {
    id: "bundle-size",
    hash: () => computeBundleEvaluatorHash(),
    run: (request, suite) =>
      runBundleSuite(
        {
          missionId: request.missionId,
          experimentId: request.experimentId,
          artifactHash: request.artifactHash,
          evaluatorHash: request.evaluatorHash,
          environmentHash: request.environmentHash,
          snapshotDir: request.snapshotDir,
          isolation: request.config.isolation,
          containerImage: request.config.containerImage,
          timeoutMs: request.config.startupTimeoutMs + request.config.requestTimeoutMs,
          memoryLimitBytes: request.config.memoryLimitBytes,
          evidence: request.evidence,
          ...(request.learnedSuiteVersion !== undefined
            ? { learnedSuiteVersion: request.learnedSuiteVersion }
            : {}),
          ...(request.containerRegistry !== undefined
            ? { containerRegistry: request.containerRegistry }
            : {}),
        },
        suite,
      ),
  },
  seedDir: TEXT_KIT_SEED_DIR,
  scenariosDir: join(BUNDLE_VERIFICATION_DIR, "scenarios"),
  scenarios: () => [
    ...loadBundleScenarios(join(BUNDLE_VERIFICATION_DIR, "scenarios")),
    ...loadBundleScenarios(join(BUNDLE_VERIFICATION_DIR, "holdout")),
  ],
  featuresPath: join(RESOURCES_DIR, "features.json"),
  skillsDir: join(RESOURCES_DIR, "skills"),
  skillPath: join(RESOURCES_DIR, "skills/verify-bundle/SKILL.md"),
  workerPrompt: `The artifact is text-kit, a small TypeScript text library shipped to browsers; the mission reduces bundleBytes, the total size of every file under src/.
- Behavior comes before size. slugify, titleCase, wordCount and truncate must keep their exact semantics (see the verify-bundle skill), including Unicode handling that the visible scenarios exercise only partly.
- The bundle is src/ only: relative imports inside src/, no packages, runtime modules, process/globalThis access or dynamic code.`,
  constraints:
    "edits only under src/; the four exported functions keep their semantics; imports stay inside src/; the verifier is the only source of truth.",
  correctionHint:
    "read the failing assertion evidence, then restore the reference behavior before shrinking again",
  regressions: null,
  repetitions: () => 1,
  validateConfig(c) {
    if (c.targetP95Reduction !== undefined)
      return ["bundle-size names its target targetImprovement, not targetP95Reduction"];
    const t = c.targetImprovement;
    if (typeof t !== "number" || !Number.isFinite(t) || t <= 0 || t >= 1)
      return ["targetImprovement must be in (0,1)"];
    if (c.workload !== undefined || c.holdoutWorkload !== undefined)
      return ["bundle-size has no request workload; remove workload and holdoutWorkload"];
    return [];
  },
  structuralViolations: (dir) =>
    checkSelfContained(dir).map((v) => `${v.file} STRUCT-SELF-CONTAINED ${v.detail}`),
  scriptedWorker: () => new BundleScriptedWorker(),
};
