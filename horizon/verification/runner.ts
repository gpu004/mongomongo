import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  CandidateStartupError,
  launchCandidate,
  type ContainerRegistry,
  type IsolationMode,
  type RunningCandidate,
} from "./candidate-process.ts";
import { type ExpectedOutcome, type Operation, ReferenceModel } from "./reference-model.ts";
import {
  canonicalJson,
  sha256,
  type AssertionResult,
  type ReportMetrics,
  type Suite,
  type VerificationReport,
} from "./reports.ts";
import { loadScenarios, type Scenario } from "./scenarios/index.ts";
import { checkImportBoundaries } from "./structural.ts";
import { generateWorkload, type Workload, type WorkloadSpec } from "./workloads/index.ts";

export interface EvidenceSink {
  /** Persist a JSON evidence blob and return its evidence ID. */
  write(kind: string, payload: unknown): string;
}

export interface RunnerConfig {
  missionId: string;
  experimentId: string;
  artifactHash: string;
  evaluatorHash: string;
  environmentHash: string;
  snapshotDir: string;
  isolation: IsolationMode;
  containerImage: string;
  startupTimeoutMs: number;
  requestTimeoutMs: number;
  memoryLimitBytes: number;
  workload: WorkloadSpec;
  holdoutWorkload: WorkloadSpec;
  /** Extra scenario directory for learned regressions (append-only). */
  learnedScenariosDir?: string;
  learnedSuiteVersion?: number;
  evidence: EvidenceSink;
  /** Scenario directory override (tests). */
  scenariosDir?: string;
  /** Records container names durably so resume can remove orphans (container mode). */
  containerRegistry?: ContainerRegistry;
}

const VERIFICATION_DIR = new URL("./", import.meta.url).pathname;

/** Hash of every file that decides a verdict. Frozen into the mission and re-checked before each run. */
export function computeEvaluatorHash(root = VERIFICATION_DIR): string {
  const files = [
    "runner.ts",
    "reference-model.ts",
    "reports.ts",
    "structural.ts",
    "candidate-process.ts",
    "workloads/index.ts",
    "scenarios/index.ts",
  ];
  for (const name of readdirSync(join(root, "scenarios")).sort()) {
    if (name.endsWith(".json")) files.push(`scenarios/${name}`);
  }
  const parts = files.map((file) => `${file}\n${readFileSync(join(root, file), "utf8")}`);
  return sha256(parts.join("\n---\n"));
}

export function computeEnvironmentHash(isolation: IsolationMode, containerImage: string): string {
  return sha256(
    canonicalJson({
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      isolation,
      containerImage: isolation === "container" ? containerImage : null,
    }),
  );
}

/** Content hash of a snapshot directory: sorted relative paths and file bytes. */
export function hashDirectory(dir: string): { hash: string; manifest: Record<string, string> } {
  const manifest: Record<string, string> = {};
  const walk = (current: string, prefix: string) => {
    for (const entry of readdirSync(current).sort()) {
      if (
        entry === "node_modules" ||
        entry === ".git" ||
        (prefix === "" && entry === ".manifest.json")
      )
        continue;
      const full = join(current, entry);
      const rel = prefix ? `${prefix}/${entry}` : entry;
      if (statSync(full).isDirectory()) walk(full, rel);
      else manifest[rel] = sha256(readFileSync(full));
    }
  };
  walk(dir, "");
  return { hash: sha256(canonicalJson(manifest)), manifest };
}

export async function runSuite(config: RunnerConfig, suite: Suite): Promise<VerificationReport> {
  const startedAt = new Date().toISOString();
  const evidenceIds: string[] = [];
  const base: Omit<
    VerificationReport,
    "status" | "assertions" | "metrics" | "finishedAt" | "evidenceIds"
  > = {
    schemaVersion: 1,
    reportId: `rep-${randomUUID()}`,
    missionId: config.missionId,
    experimentId: config.experimentId,
    artifactHash: config.artifactHash,
    evaluatorHash: config.evaluatorHash,
    workloadHash: "",
    environmentHash: config.environmentHash,
    suite,
    startedAt,
    isolation: config.isolation,
    ...(config.learnedSuiteVersion !== undefined
      ? { learnedSuiteVersion: config.learnedSuiteVersion }
      : {}),
  };
  const finish = (
    status: VerificationReport["status"],
    assertions: AssertionResult[],
    metrics: ReportMetrics,
    workloadHash: string,
    infraMessage?: string,
  ): VerificationReport => ({
    ...base,
    workloadHash,
    status,
    assertions,
    metrics,
    evidenceIds,
    finishedAt: new Date().toISOString(),
    ...(infraMessage !== undefined ? { infraMessage } : {}),
  });

  // Identity checks come first: a report for the wrong artifact or evaluator is invalid, not "failed".
  const actualHash = hashDirectory(config.snapshotDir).hash;
  if (actualHash !== config.artifactHash) {
    return finish(
      "infra_error",
      [],
      {},
      "",
      `snapshot hash ${actualHash} does not match artifact ${config.artifactHash}`,
    );
  }
  const actualEvaluator = computeEvaluatorHash();
  if (actualEvaluator !== config.evaluatorHash) {
    return finish(
      "infra_error",
      [],
      {},
      "",
      `evaluator hash drifted: frozen ${config.evaluatorHash}, current ${actualEvaluator}`,
    );
  }

  // Structural checks run for every suite; a bypassed architecture path never reaches scenarios.
  const violations = checkImportBoundaries(join(config.snapshotDir, "src"));
  const structuralEvidence = config.evidence.write("structural", { violations });
  evidenceIds.push(structuralEvidence);
  const structuralAssertion: AssertionResult = {
    id: "structural:import-boundaries",
    passed: violations.length === 0,
    evidenceId: structuralEvidence,
    invariantIds: ["STRUCT-IMPORT-BOUNDARY"],
    ...(violations.length > 0
      ? { detail: violations.map((v) => `${v.file}:${v.line} ${v.detail}`).join("; ") }
      : {}),
  };
  if (suite === "structural" || violations.length > 0) {
    return finish(
      violations.length === 0 ? "passed" : "failed",
      [structuralAssertion],
      {},
      sha256("structural"),
    );
  }

  const scenarios = selectScenarios(config, suite);
  const workloadSpec = suite === "holdout" ? config.holdoutWorkload : config.workload;
  const workload =
    suite === "performance" || suite === "holdout" ? generateWorkload(workloadSpec) : undefined;
  const workloadHash = workload
    ? workload.hash
    : sha256(canonicalJson(scenarios.map((s) => s.scenarioId)));

  let candidate: RunningCandidate;
  try {
    candidate = await launchCandidate({
      snapshotDir: config.snapshotDir,
      isolation: config.isolation,
      containerImage: config.containerImage,
      missionId: config.missionId,
      startupTimeoutMs: config.startupTimeoutMs,
      memoryLimitBytes: config.memoryLimitBytes,
      containerRegistry: config.containerRegistry,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const evidenceId = config.evidence.write("startup-failure", { message });
    evidenceIds.push(evidenceId);
    const status =
      error instanceof CandidateStartupError && message.includes("did not report listening")
        ? "timeout"
        : "failed";
    return finish(
      status,
      [structuralAssertion, { id: "startup", passed: false, evidenceId, detail: message }],
      {},
      workloadHash,
    );
  }

  const assertions: AssertionResult[] = [structuralAssertion];
  const metrics: ReportMetrics = {};
  try {
    const client = new HttpDriver(candidate.baseUrl, config.requestTimeoutMs);
    if (suite === "performance") {
      if (!workload) throw new Error("unreachable");
      const perf = await runPerformance(client, candidate, config, workload, evidenceIds);
      assertions.push(...perf.assertions);
      Object.assign(metrics, perf.metrics);
      candidate = perf.candidate;
    } else {
      for (const scenario of scenarios) {
        // Each scenario runs against a fresh service so scenarios cannot mask each other.
        const fresh = await relaunch(candidate, config);
        candidate = fresh;
        const freshClient = new HttpDriver(fresh.baseUrl, config.requestTimeoutMs);
        assertions.push(await runScenario(freshClient, scenario, config.evidence, evidenceIds));
      }
      if (suite === "holdout" && workload) {
        const fresh = await relaunch(candidate, config);
        candidate = fresh;
        const freshClient = new HttpDriver(fresh.baseUrl, config.requestTimeoutMs);
        assertions.push(await runHoldoutTrace(freshClient, workload, config.evidence, evidenceIds));
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const evidenceId = config.evidence.write("runner-error", { message });
    evidenceIds.push(evidenceId);
    const exit = await candidate.stop();
    evidenceIds.push(config.evidence.write("process-exit", exit));
    return finish("infra_error", assertions, metrics, workloadHash, message);
  }
  const exit = await candidate.stop();
  evidenceIds.push(config.evidence.write("process-exit", exit));
  if (exit.peakMemoryBytes !== undefined && metrics.peakMemoryBytes === undefined)
    metrics.peakMemoryBytes = exit.peakMemoryBytes;
  if (metrics.peakMemoryBytes !== undefined && metrics.peakMemoryBytes > config.memoryLimitBytes) {
    assertions.push({
      id: "resource:peak-memory",
      passed: false,
      evidenceId: evidenceIds[evidenceIds.length - 1] ?? "",
      detail: `peak RSS ${metrics.peakMemoryBytes} > limit ${config.memoryLimitBytes}`,
    });
  }
  const status = assertions.every((a) => a.passed) ? "passed" : "failed";
  return finish(status, assertions, metrics, workloadHash);
}

async function relaunch(
  current: RunningCandidate,
  config: RunnerConfig,
): Promise<RunningCandidate> {
  await current.stop();
  return launchCandidate({
    snapshotDir: config.snapshotDir,
    isolation: config.isolation,
    containerImage: config.containerImage,
    missionId: config.missionId,
    startupTimeoutMs: config.startupTimeoutMs,
    memoryLimitBytes: config.memoryLimitBytes,
    containerRegistry: config.containerRegistry,
  });
}

function selectScenarios(config: RunnerConfig, suite: Suite): Scenario[] {
  const fixed = loadScenarios(config.scenariosDir ?? join(VERIFICATION_DIR, "scenarios"));
  if (suite === "smoke") return fixed.filter((s) => s.suite === "smoke");
  if (suite === "learned") {
    return config.learnedScenariosDir && existsSync(config.learnedScenariosDir)
      ? loadScenarios(config.learnedScenariosDir)
      : [];
  }
  if (suite === "correctness" || suite === "holdout") return fixed;
  return [];
}

export interface ObservedResponse {
  status: number;
  body: unknown;
  elapsedMs: number;
  error?: string;
}

export class HttpDriver {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(baseUrl: string, timeoutMs: number) {
    this.baseUrl = baseUrl;
    this.timeoutMs = timeoutMs;
  }

  async perform(operation: Operation): Promise<ObservedResponse> {
    const started = performance.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const [url, init] = this.request(operation);
      const response = await fetch(url, { ...init, signal: controller.signal });
      const text = await response.text();
      const elapsedMs = performance.now() - started;
      let body: unknown = null;
      if (text.length > 0) {
        try {
          body = JSON.parse(text);
        } catch {
          body = text;
        }
      }
      return { status: response.status, body, elapsedMs };
    } catch (error) {
      return {
        status: 0,
        body: null,
        elapsedMs: performance.now() - started,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  private request(operation: Operation): [string, RequestInit] {
    switch (operation.op) {
      case "health":
        return [`${this.baseUrl}/health`, { method: "GET" }];
      case "insert":
        return [
          `${this.baseUrl}/documents`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              id: operation.id,
              title: operation.title,
              body: operation.body,
            }),
          },
        ];
      case "update": {
        const payload: Record<string, string> = {};
        if (operation.title !== undefined) payload.title = operation.title;
        if (operation.body !== undefined) payload.body = operation.body;
        return [
          `${this.baseUrl}/documents/${encodeURIComponent(operation.id)}`,
          {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
          },
        ];
      }
      case "delete":
        return [
          `${this.baseUrl}/documents/${encodeURIComponent(operation.id)}`,
          { method: "DELETE" },
        ];
      case "search": {
        const params = new URLSearchParams({ q: operation.q });
        if (operation.limit !== undefined) params.set("limit", String(operation.limit));
        return [`${this.baseUrl}/search?${params.toString()}`, { method: "GET" }];
      }
    }
  }
}

export function compareOutcome(
  expected: ExpectedOutcome,
  observed: ObservedResponse,
): string | undefined {
  if (observed.error) return `request failed: ${observed.error}`;
  if (observed.status !== expected.status)
    return `expected status ${expected.status}, got ${observed.status}`;
  if (expected.kind === "search") {
    const ids = (observed.body as { ids?: unknown } | null)?.ids;
    if (!Array.isArray(ids)) return "search response missing ids array";
    if (JSON.stringify(ids) !== JSON.stringify(expected.ids))
      return `expected ids ${JSON.stringify(expected.ids)}, got ${JSON.stringify(ids)}`;
  }
  if (expected.kind === "health") {
    const body = observed.body as { ok?: unknown; documents?: unknown } | null;
    if (body?.ok !== true) return "health did not report ok:true";
    if (body.documents !== expected.documents)
      return `health documents ${String(body.documents)} != ${expected.documents}`;
  }
  return undefined;
}

async function runScenario(
  client: HttpDriver,
  scenario: Scenario,
  evidence: EvidenceSink,
  evidenceIds: string[],
): Promise<AssertionResult> {
  const model = new ReferenceModel();
  const trace: {
    step: number;
    operation: Operation;
    expected: ExpectedOutcome;
    observed: ObservedResponse;
    mismatch?: string;
  }[] = [];
  let firstMismatch: string | undefined;
  for (const [step, operation] of scenario.sequence.entries()) {
    const expected = model.apply(operation);
    const observed = await client.perform(operation);
    const mismatch = compareOutcome(expected, observed);
    trace.push({ step, operation, expected, observed, ...(mismatch ? { mismatch } : {}) });
    if (mismatch && firstMismatch === undefined)
      firstMismatch = `step ${step} (${operation.op}): ${mismatch}`;
  }
  const evidenceId = evidence.write("scenario", {
    scenarioId: scenario.scenarioId,
    invariantIds: scenario.invariantIds,
    trace,
  });
  evidenceIds.push(evidenceId);
  return {
    id: `scenario:${scenario.scenarioId}`,
    passed: firstMismatch === undefined,
    evidenceId,
    invariantIds: scenario.invariantIds,
    ...(firstMismatch ? { detail: firstMismatch } : {}),
  };
}

/** Holdout drives the unseen workload schedule and grades every response with the oracle. */
async function runHoldoutTrace(
  client: HttpDriver,
  workload: Workload,
  evidence: EvidenceSink,
  evidenceIds: string[],
): Promise<AssertionResult> {
  const model = new ReferenceModel();
  const mismatches: {
    step: number;
    operation: Operation;
    expected: ExpectedOutcome;
    observed: ObservedResponse;
    mismatch: string;
  }[] = [];
  let step = 0;
  for (const operation of [...workload.corpus, ...workload.schedule]) {
    const expected = model.apply(operation);
    const observed = await client.perform(operation);
    const mismatch = compareOutcome(expected, observed);
    if (mismatch && mismatches.length < 25)
      mismatches.push({ step, operation, expected, observed, mismatch });
    step++;
  }
  const evidenceId = evidence.write("holdout-trace", {
    workloadHash: workload.hash,
    steps: step,
    mismatches,
  });
  evidenceIds.push(evidenceId);
  return {
    id: "holdout:workload-trace",
    passed: mismatches.length === 0,
    evidenceId,
    invariantIds: ["INV-CONTRACT"],
    ...(mismatches[0] ? { detail: `step ${mismatches[0].step}: ${mismatches[0].mismatch}` } : {}),
  };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index] ?? Number.NaN;
}

async function runPerformance(
  client: HttpDriver,
  initial: RunningCandidate,
  config: RunnerConfig,
  workload: Workload,
  evidenceIds: string[],
): Promise<{ assertions: AssertionResult[]; metrics: ReportMetrics; candidate: RunningCandidate }> {
  let candidate = initial;
  let driver = client;
  const repetitionP95: number[] = [];
  const repetitionMedian: number[] = [];
  let measured = 0;
  let failed = 0;
  let peak = 0;
  const assertions: AssertionResult[] = [];
  for (let rep = 0; rep < workload.spec.repetitions; rep++) {
    if (rep > 0) {
      candidate = await relaunch(candidate, config);
      driver = new HttpDriver(candidate.baseUrl, config.requestTimeoutMs);
    }
    const model = new ReferenceModel();
    for (const insert of workload.corpus) {
      const observed = await driver.perform(insert);
      const mismatch = compareOutcome(model.apply(insert), observed);
      if (mismatch) failed++;
    }
    const samples: number[] = [];
    const mismatches: string[] = [];
    for (const [index, operation] of workload.schedule.entries()) {
      const expected = model.apply(operation);
      const observed = await driver.perform(operation);
      const mismatch = compareOutcome(expected, observed);
      if (index >= workload.spec.warmupRequests) {
        measured++;
        samples.push(observed.elapsedMs);
        if (mismatch) {
          failed++;
          if (mismatches.length < 10) mismatches.push(`step ${index}: ${mismatch}`);
        }
      }
    }
    const sorted = [...samples].sort((a, b) => a - b);
    const p95 = percentile(sorted, 0.95);
    const median = percentile(sorted, 0.5);
    repetitionP95.push(p95);
    repetitionMedian.push(median);
    const exitInfo = rep === workload.spec.repetitions - 1 ? undefined : await peekPeak(candidate);
    if (exitInfo !== undefined) peak = Math.max(peak, exitInfo);
    evidenceIds.push(
      config.evidence.write("timing-samples", {
        repetition: rep,
        workloadHash: workload.hash,
        samplesMs: samples,
        p95,
        median,
        mismatches,
      }),
    );
  }
  const sortedP95 = [...repetitionP95].sort((a, b) => a - b);
  const sortedMedian = [...repetitionMedian].sort((a, b) => a - b);
  const metrics: ReportMetrics = {
    p95LatencyMs: percentile(sortedP95, 0.5),
    medianLatencyMs: percentile(sortedMedian, 0.5),
    measuredRequests: measured,
    failedRequests: failed,
    repetitionP95Ms: repetitionP95,
    ...(peak > 0 ? { peakMemoryBytes: peak } : {}),
  };
  const expectedMeasured = workload.spec.measuredRequests * workload.spec.repetitions;
  assertions.push({
    id: "performance:request-count",
    passed: measured === expectedMeasured,
    evidenceId: evidenceIds[evidenceIds.length - 1] ?? "",
    ...(measured !== expectedMeasured
      ? { detail: `measured ${measured}, expected ${expectedMeasured}` }
      : {}),
  });
  assertions.push({
    id: "performance:responses-correct",
    passed: failed === 0,
    evidenceId: evidenceIds[evidenceIds.length - 1] ?? "",
    invariantIds: ["INV-CONTRACT"],
    ...(failed > 0
      ? { detail: `${failed} responses disagreed with the reference model during measurement` }
      : {}),
  });
  return { assertions, metrics, candidate };
}

async function peekPeak(candidate: RunningCandidate): Promise<number | undefined> {
  if (!candidate.pid || candidate.containerName) return undefined;
  try {
    const status = readFileSync(`/proc/${candidate.pid}/status`, "utf8");
    const match = /VmHWM:\s+(\d+)\s+kB/u.exec(status);
    return match ? Number(match[1]) * 1024 : undefined;
  } catch {
    return undefined;
  }
}
