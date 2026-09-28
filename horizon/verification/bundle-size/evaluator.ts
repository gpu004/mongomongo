import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
  assertSandboxAvailable,
  dockerRunArgs,
  killContainer,
  SandboxUnavailableError,
} from "../../src/sandbox.ts";
import type { ContainerRegistry, IsolationMode } from "../candidate-process.ts";
import {
  canonicalJson,
  sha256,
  type AssertionResult,
  type ReportMetrics,
  type Suite,
  type VerificationReport,
} from "../reports.ts";
import { hashDirectory, type EvidenceSink } from "../runner.ts";
import { type CaseOutcome, referenceOutcome } from "./reference.ts";

export const BUNDLE_VERIFICATION_DIR = new URL("./", import.meta.url).pathname;

/** Names of the metrics a bundle-size performance report carries. */
export const BUNDLE_METRIC_KEY = "bundleBytes";
export const BUNDLE_REPETITIONS_KEY = "repetitionBundleBytes";

export interface BundleCase {
  fn: string;
  args: unknown[];
}

export interface BundleScenario {
  schemaVersion: 1;
  scenarioId: string;
  description: string;
  suite: "smoke" | "correctness" | "holdout";
  invariantIds: string[];
  cases: BundleCase[];
}

export interface BundleRunConfig {
  missionId: string;
  experimentId: string;
  artifactHash: string;
  evaluatorHash: string;
  environmentHash: string;
  snapshotDir: string;
  isolation: IsolationMode;
  containerImage: string;
  /** Wall-clock limit of one scenario process, startup included. */
  timeoutMs: number;
  memoryLimitBytes: number;
  learnedSuiteVersion?: number;
  evidence: EvidenceSink;
  containerRegistry?: ContainerRegistry;
  /** Scenario directory overrides (tests). */
  scenariosDir?: string;
  holdoutDir?: string;
}

export function loadBundleScenarios(dir: string): BundleScenario[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => JSON.parse(readFileSync(join(dir, name), "utf8")) as BundleScenario);
}

/** Hash of every file that decides a bundle-size verdict. */
/**
 * Identity of the bundle evaluator: its code, the reference, the report
 * schema and every fixed and held-out scenario under `root`.
 */
export function computeBundleEvaluatorHash(root = BUNDLE_VERIFICATION_DIR): string {
  const files: [string, string][] = [
    ["bundle-size/evaluator.ts", join(root, "evaluator.ts")],
    ["bundle-size/reference.ts", join(root, "reference.ts")],
    ["reports.ts", join(BUNDLE_VERIFICATION_DIR, "../reports.ts")],
  ];
  for (const dir of ["scenarios", "holdout"])
    for (const name of readdirSync(join(root, dir)).sort())
      if (name.endsWith(".json")) files.push([`bundle-size/${dir}/${name}`, join(root, dir, name)]);
  return sha256(
    files.map(([label, path]) => `${label}\n${readFileSync(path, "utf8")}`).join("\n---\n"),
  );
}

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .sort()
    .flatMap((entry) => {
      const full = join(dir, entry);
      return statSync(full).isDirectory() ? walk(full) : [full];
    });
}

/** The shipped bundle: every file under `src/`, in path order. */
export function bundleBytes(snapshotDir: string): { bytes: number; files: number } {
  const files = walk(join(snapshotDir, "src"));
  return { bytes: files.reduce((n, f) => n + statSync(f).size, 0), files: files.length };
}

const FORBIDDEN_TOKENS = /\b(process|globalThis|require|eval|Function)\b|\bimport\s*\(/u;
const SPECIFIERS = [
  /\b(?:import|export)\b[^;'"]*?\bfrom\s*['"]([^'"]+)['"]/gu,
  /\bimport\s*['"]([^'"]+)['"]/gu,
];

export interface BundleViolation {
  file: string;
  detail: string;
}

/**
 * STRUCT-SELF-CONTAINED: the bundle is only the candidate's own `src/`. A
 * smaller number obtained by importing a package or a runtime module, or by
 * reaching the host through dynamic code, is not a smaller bundle.
 */
export function checkSelfContained(snapshotDir: string): BundleViolation[] {
  const srcRoot = join(snapshotDir, "src");
  const violations: BundleViolation[] = [];
  if (!existsSync(join(srcRoot, "index.ts")))
    violations.push({ file: "src/index.ts", detail: "entry point missing" });
  for (const file of walk(srcRoot)) {
    const rel = relative(snapshotDir, file).split("\\").join("/");
    if (!rel.endsWith(".ts")) {
      violations.push({ file: rel, detail: "only .ts modules may ship" });
      continue;
    }
    const code = readFileSync(file, "utf8")
      .replace(/\/\*[\s\S]*?\*\//gu, "")
      .replace(/(^|[^:"'`\\])\/\/.*$/gmu, "$1");
    const token = FORBIDDEN_TOKENS.exec(code);
    if (token) violations.push({ file: rel, detail: `uses ${token[0]}` });
    for (const pattern of SPECIFIERS) {
      for (const match of code.matchAll(pattern)) {
        const specifier = match[1] ?? "";
        const target = join(rel, "..", specifier).split("\\").join("/");
        if (!specifier.startsWith(".") || !target.startsWith("src/"))
          violations.push({ file: rel, detail: `imports ${specifier} from outside src/` });
      }
    }
  }
  return violations;
}

/** Runs inside the scenario process; the candidate cannot see the cases before they are called. */
const HARNESS = `
const cases = JSON.parse(process.env.HORIZON_CASES);
const out = [];
let mod;
try { mod = await import(process.env.HORIZON_ENTRY); } catch (e) { mod = {}; }
for (const c of cases) {
  const fn = mod[c.fn];
  if (typeof fn !== "function") { out.push({ ok: false, error: "MissingExport" }); continue; }
  try { out.push({ ok: true, value: await fn(...c.args) }); }
  catch (e) { out.push({ ok: false, error: e && typeof e.name === "string" ? e.name : "Error" }); }
}
process.stdout.write("\\n" + process.env.HORIZON_MARKER + JSON.stringify(out) + "\\n");
`;

interface CaseRun {
  outcomes: CaseOutcome[] | null;
  detail: string;
}

function runCases(config: BundleRunConfig, cases: BundleCase[]): Promise<CaseRun> {
  const marker = `HORIZON-RESULT-${randomUUID()}:`;
  const env = {
    HORIZON_CASES: JSON.stringify(cases),
    HORIZON_MARKER: marker,
    NODE_ENV: "candidate",
  };
  const heap = `--max-old-space-size=${Math.floor(config.memoryLimitBytes / 1024 / 1024)}`;
  let command: string;
  let args: string[];
  let containerName: string | undefined;
  if (config.isolation === "container") {
    assertSandboxAvailable(config.containerImage);
    containerName = `horizon-cand-${randomUUID().slice(0, 12)}`;
    command = "docker";
    args = dockerRunArgs({
      missionId: config.missionId,
      operationId: config.experimentId,
      role: "candidate",
      name: containerName,
      image: config.containerImage,
      hostDir: config.snapshotDir,
      mountPath: "/candidate",
      memoryLimitBytes: config.memoryLimitBytes,
      network: "none",
      env: { ...env, HORIZON_ENTRY: "/candidate/src/index.ts" },
      command: ["node", heap, "--input-type=module", "-e", HARNESS],
    });
  } else {
    command = process.execPath;
    args = [heap, "--input-type=module", "-e", HARNESS];
    Object.assign(env, {
      PATH: process.env.PATH ?? "",
      HORIZON_ENTRY: join(config.snapshotDir, "src/index.ts"),
    });
  }
  return (async () => {
    if (containerName) await config.containerRegistry?.register(containerName);
    try {
      return await new Promise<CaseRun>((resolve) => {
        const child = spawn(command, args, {
          cwd: config.snapshotDir,
          env: config.isolation === "container" ? { PATH: process.env.PATH ?? "" } : env,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
        child.stderr.on(
          "data",
          (d: Buffer) => (stderr = (stderr + d.toString("utf8")).slice(-2000)),
        );
        const timer = setTimeout(() => {
          if (containerName) killContainer(containerName);
          child.kill("SIGKILL");
        }, config.timeoutMs);
        child.on("close", (code, signal) => {
          clearTimeout(timer);
          const line = stdout.split("\n").find((l) => l.startsWith(marker));
          if (!line) {
            resolve({
              outcomes: null,
              detail: `no result (exit ${code ?? signal}): ${stderr.trim().split("\n").at(-1) ?? ""}`,
            });
            return;
          }
          try {
            resolve({
              outcomes: JSON.parse(line.slice(marker.length)) as CaseOutcome[],
              detail: "",
            });
          } catch {
            resolve({ outcomes: null, detail: "unparseable result line" });
          }
        });
      });
    } finally {
      if (containerName) await config.containerRegistry?.release(containerName);
    }
  })();
}

async function runScenario(
  config: BundleRunConfig,
  scenario: BundleScenario,
  prefix: string,
  evidenceIds: string[],
): Promise<AssertionResult> {
  const run = await runCases(config, scenario.cases);
  const mismatches: { case: BundleCase; expected: CaseOutcome; observed: CaseOutcome | null }[] =
    [];
  scenario.cases.forEach((c, i) => {
    const expected = referenceOutcome(c.fn, c.args);
    const observed = run.outcomes?.[i] ?? null;
    if (canonicalJson(observed) !== canonicalJson(expected))
      mismatches.push({ case: c, expected, observed });
  });
  const evidenceId = config.evidence.write("bundle-scenario", {
    scenarioId: scenario.scenarioId,
    cases: scenario.cases.length,
    mismatches: mismatches.slice(0, 10),
    ...(run.detail ? { detail: run.detail } : {}),
  });
  evidenceIds.push(evidenceId);
  const first = mismatches[0];
  return {
    id: `${prefix}:${scenario.scenarioId}`,
    passed: mismatches.length === 0,
    evidenceId,
    invariantIds: scenario.invariantIds,
    ...(first
      ? {
          detail:
            run.detail ||
            `${mismatches.length}/${scenario.cases.length} cases differ; first ${first.case.fn}(${JSON.stringify(first.case.args)}) expected ${JSON.stringify(first.expected)} got ${JSON.stringify(first.observed)}`,
        }
      : {}),
  };
}

/**
 * The bundle-size evaluator. Correctness suites import the candidate's
 * `src/index.ts` in a fresh process per scenario and compare every call with
 * the reference; the performance suite measures the shipped bytes, which are
 * deterministic, so one repetition is exact.
 */
export async function runBundleSuite(
  config: BundleRunConfig,
  suite: Suite,
): Promise<VerificationReport> {
  const startedAt = new Date().toISOString();
  const evidenceIds: string[] = [];
  const finish = (
    status: VerificationReport["status"],
    assertions: AssertionResult[],
    metrics: ReportMetrics,
    workloadHash: string,
    infraMessage?: string,
  ): VerificationReport => ({
    schemaVersion: 1,
    reportId: `rep-${randomUUID()}`,
    missionId: config.missionId,
    experimentId: config.experimentId,
    artifactHash: config.artifactHash,
    evaluatorHash: config.evaluatorHash,
    workloadHash,
    environmentHash: config.environmentHash,
    suite,
    status,
    assertions,
    metrics,
    evidenceIds,
    startedAt,
    finishedAt: new Date().toISOString(),
    isolation: config.isolation,
    ...(config.learnedSuiteVersion !== undefined
      ? { learnedSuiteVersion: config.learnedSuiteVersion }
      : {}),
    ...(infraMessage !== undefined ? { infraMessage } : {}),
  });

  const actualHash = hashDirectory(config.snapshotDir).hash;
  if (actualHash !== config.artifactHash)
    return finish(
      "infra_error",
      [],
      {},
      "",
      `snapshot hash ${actualHash} does not match artifact ${config.artifactHash}`,
    );
  const actualEvaluator = computeBundleEvaluatorHash();
  if (actualEvaluator !== config.evaluatorHash)
    return finish(
      "infra_error",
      [],
      {},
      "",
      `evaluator hash drifted: frozen ${config.evaluatorHash}, current ${actualEvaluator}`,
    );

  const violations = checkSelfContained(config.snapshotDir);
  const structuralEvidence = config.evidence.write("structural", { violations });
  evidenceIds.push(structuralEvidence);
  const structural: AssertionResult = {
    id: "structural:self-contained",
    passed: violations.length === 0,
    evidenceId: structuralEvidence,
    invariantIds: ["STRUCT-SELF-CONTAINED"],
    ...(violations.length > 0
      ? { detail: violations.map((v) => `${v.file}: ${v.detail}`).join("; ") }
      : {}),
  };
  if (suite === "structural" || violations.length > 0)
    return finish(
      violations.length === 0 ? "passed" : "failed",
      [structural],
      {},
      sha256("structural"),
    );

  if (suite === "performance") {
    const measured = bundleBytes(config.snapshotDir);
    const evidenceId = config.evidence.write("bundle-size", measured);
    evidenceIds.push(evidenceId);
    return finish(
      "passed",
      [structural, { id: "measure:bundle-bytes", passed: true, evidenceId }],
      {
        [BUNDLE_METRIC_KEY]: measured.bytes,
        [BUNDLE_REPETITIONS_KEY]: [measured.bytes],
        bundleFiles: measured.files,
      },
      sha256("bundle-bytes:src/**"),
    );
  }

  const fixed = loadBundleScenarios(
    config.scenariosDir ?? join(BUNDLE_VERIFICATION_DIR, "scenarios"),
  );
  const scenarios =
    suite === "smoke"
      ? fixed.filter((s) => s.suite === "smoke")
      : suite === "correctness"
        ? fixed
        : suite === "holdout"
          ? [
              ...fixed,
              ...loadBundleScenarios(config.holdoutDir ?? join(BUNDLE_VERIFICATION_DIR, "holdout")),
            ]
          : [];
  const workloadHash = sha256(canonicalJson(scenarios.map((s) => s.scenarioId)));
  const assertions: AssertionResult[] = [structural];
  try {
    for (const scenario of scenarios)
      assertions.push(
        await runScenario(
          config,
          scenario,
          scenario.suite === "holdout" ? "holdout" : "scenario",
          evidenceIds,
        ),
      );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    evidenceIds.push(config.evidence.write("runner-error", { message }));
    return finish(
      "infra_error",
      assertions,
      {},
      workloadHash,
      error instanceof SandboxUnavailableError ? message : `runner error: ${message}`,
    );
  }
  return finish(
    assertions.every((a) => a.passed) ? "passed" : "failed",
    assertions,
    {},
    workloadHash,
  );
}
