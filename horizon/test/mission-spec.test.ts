import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  bundleBytes,
  computeBundleEvaluatorHash,
  runBundleCases,
  runBundleSuite,
} from "../verification/bundle-size/evaluator.ts";
import { computeEvaluatorHash, hashDirectory } from "../verification/runner.ts";
import { ArtifactStore, SEED_DIR } from "../src/artifact-store.ts";
import { MissionController, SimulatedCrash } from "../src/controller.ts";
import { loadFeatureMap, validateFeatureMap } from "../src/feature-map.ts";
import { LocalMemoryAdapter } from "../src/memory-adapter.ts";
import {
  contractHash,
  loadMissionConfig,
  type MissionConfig,
  validateMissionConfig,
} from "../src/mission-contract.ts";
import { FileEvidenceStore, missionPaths } from "../src/mission-paths.ts";
import { taskSeeds } from "../src/mission-spec.ts";
import { improvedBound, isBetter, reaches, type ObjectiveMetric } from "../src/objective-metric.ts";
import { BUNDLE_SIZE, TEXT_KIT_SEED_DIR } from "../src/objectives/bundle-size.ts";
import { findMissionSpec, missionSpecFor, missionSpecIds } from "../src/objectives/index.ts";
import { SEARCH_P95 } from "../src/objectives/search-p95.ts";
import { systemPrompt } from "../src/pi-worker.ts";
import { assertSandboxAvailable } from "../src/sandbox.ts";
import { ScriptedWorker } from "../src/scripted-worker.ts";
import { EXAMPLE_CONFIG, tempRunsRoot, testConfig } from "./helpers.ts";

const BUNDLE_CONFIG = new URL("../mission.bundle-size.example.json", import.meta.url).pathname;

function bundleConfig(missionId: string, overrides: Partial<MissionConfig> = {}): MissionConfig {
  const base = loadMissionConfig(BUNDLE_CONFIG);
  return {
    ...base,
    missionId,
    memory: { ...base.memory, containerTag: `horizon-${missionId}` },
    ledger: { backend: "sqlite" },
    ...overrides,
  };
}

function bundleController(
  config: MissionConfig,
  runs: string,
  options: ConstructorParameters<typeof MissionController>[2] = {},
): MissionController {
  return new MissionController(config, missionPaths(config.missionId, runs), {
    memory: new LocalMemoryAdapter(),
    ...options,
  });
}

test("a mission without missionSpec resolves to search-p95 and keeps its task graph, evaluator and prompt", () => {
  const legacy = loadMissionConfig(EXAMPLE_CONFIG);
  assert.equal(legacy.missionSpec, undefined);
  assert.equal(missionSpecFor(legacy), SEARCH_P95);
  assert.deepEqual(missionSpecIds().sort(), ["bundle-size", "search-p95"]);
  assert.deepEqual(
    taskSeeds(SEARCH_P95.tasks).map((t) => [t.taskId, t.ordinal, t.dependsOn]),
    [
      ["baseline", 1, []],
      ["optimize-search", 2, ["baseline"]],
      ["holdout", 3, ["optimize-search"]],
    ],
  );
  assert.equal(SEARCH_P95.evaluator.hash(), computeEvaluatorHash());
  assert.equal(SEARCH_P95.seedDir, SEED_DIR);
  assert.equal(SEARCH_P95.metric.key, "p95LatencyMs");
  assert.equal(SEARCH_P95.metric.lessonMetric, "PERF-P95");
  assert.ok(SEARCH_P95.scriptedWorker() instanceof ScriptedWorker);
  const prompt = systemPrompt();
  assert.match(prompt, /NFC normalization/);
  assert.match(prompt, /DocumentService/);
  assert.match(prompt, /cannot change verification/);

  const controller = new MissionController(
    testConfig("spec-legacy"),
    missionPaths("spec-legacy", tempRunsRoot()),
    { memory: new LocalMemoryAdapter() },
  );
  assert.equal(controller.spec, SEARCH_P95);
  assert.equal(controller.evaluatorHash, computeEvaluatorHash());
});

test("the objective selector is part of the frozen contract and each spec validates its own target fields", () => {
  const legacy = loadMissionConfig(EXAMPLE_CONFIG);
  assert.equal(
    contractHash(legacy),
    contractHash(JSON.parse(readFileSync(EXAMPLE_CONFIG, "utf8")) as MissionConfig),
  );
  assert.notEqual(contractHash({ ...legacy, missionSpec: "search-p95" }), contractHash(legacy));

  const raw = JSON.parse(readFileSync(BUNDLE_CONFIG, "utf8")) as Record<string, unknown>;
  assert.equal(validateMissionConfig(raw).missionSpec, "bundle-size");
  assert.throws(
    () => validateMissionConfig({ ...raw, missionSpec: "fixture-runtime" }),
    /unknown missionSpec fixture-runtime; known: search-p95, bundle-size/,
  );
  assert.throws(
    () => validateMissionConfig({ ...raw, targetP95Reduction: 0.4 }),
    /bundle-size names its target targetImprovement/,
  );
  assert.throws(
    () => validateMissionConfig({ ...raw, workload: legacy.workload }),
    /bundle-size has no request workload/,
  );
  assert.throws(
    () => validateMissionConfig({ ...raw, requiredImprovedRepetitions: 2 }),
    /requiredImprovedRepetitions exceeds repetitions/,
  );
  const { workload: _w, ...noWorkload } = JSON.parse(
    readFileSync(EXAMPLE_CONFIG, "utf8"),
  ) as Record<string, unknown>;
  assert.throws(() => validateMissionConfig(noWorkload), /workload/);
  assert.throws(
    () =>
      validateMissionConfig({
        ...(JSON.parse(readFileSync(EXAMPLE_CONFIG, "utf8")) as Record<string, unknown>),
        targetImprovement: 0.3,
      }),
    /targetP95Reduction/,
  );
});

test("metric direction decides improvement, target bound and reach", () => {
  const minimize = BUNDLE_SIZE.metric;
  const maximize: ObjectiveMetric = { ...minimize, key: "throughput", direction: "maximize" };
  assert.equal(isBetter(90, 100, minimize), true);
  assert.equal(isBetter(90, 100, maximize), false);
  assert.equal(improvedBound(100, 0.4, minimize), 60);
  assert.equal(improvedBound(100, 0.4, maximize), 140);
  assert.equal(reaches(60, 60, minimize), true);
  assert.equal(reaches(61, 60, minimize), false);
  assert.equal(reaches(140, 140, maximize), true);
  assert.equal(reaches(139, 140, maximize), false);
});

test("bundle-size resources resolve: feature map, scenarios, seed and structural check", () => {
  const spec = findMissionSpec("bundle-size")!;
  assert.equal(spec, BUNDLE_SIZE);
  assert.deepEqual(
    validateFeatureMap(loadFeatureMap(spec.featuresPath), spec.scenarios(), spec.seedDir),
    [],
  );
  assert.deepEqual(spec.structuralViolations(spec.seedDir), []);
  assert.equal(spec.regressions, null);
  assert.match(systemPrompt(spec.workerPrompt), /bundleBytes/);
  assert.doesNotMatch(systemPrompt(spec.workerPrompt), /DocumentService/);
});

test("bundle evaluator: seed passes every suite, bytes are exact, behavior and boundary violations fail", async () => {
  const store = new ArtifactStore(mkdtempSync(join(tmpdir(), "horizon-bundle-")));
  const evidence = new FileEvidenceStore(mkdtempSync(join(tmpdir(), "horizon-bundle-ev-")));
  const run = (dir: string, hash: string, suite: Parameters<typeof runBundleSuite>[1]) =>
    runBundleSuite(
      {
        missionId: "bundle-eval",
        experimentId: `eval-${suite}`,
        artifactHash: hash,
        evaluatorHash: computeBundleEvaluatorHash(),
        environmentHash: "env",
        snapshotDir: dir,
        isolation: "subprocess",
        containerImage: "",
        timeoutMs: 20_000,
        memoryLimitBytes: 256 * 1024 * 1024,
        evidence,
      },
      suite,
    );
  const seed = store.importSeed(TEXT_KIT_SEED_DIR);
  for (const suite of ["structural", "smoke", "correctness", "holdout"] as const)
    assert.equal((await run(seed.path, seed.hash, suite)).status, "passed", suite);
  const perf = await run(seed.path, seed.hash, "performance");
  assert.equal(perf.status, "passed");
  assert.equal(perf.metrics.bundleBytes, bundleBytes(seed.path).bytes);
  assert.deepEqual(perf.metrics.repetitionBundleBytes, [perf.metrics.bundleBytes]);

  const broken = mkdtempSync(join(tmpdir(), "horizon-bundle-broken-"));
  cpSync(TEXT_KIT_SEED_DIR, broken, { recursive: true });
  writeFileSync(
    join(broken, "src/slug.ts"),
    'export const slugify = (t: string): string => t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");\n',
  );
  const brokenHash = hashDirectory(broken).hash;
  const correctness = await run(broken, brokenHash, "correctness");
  assert.equal(correctness.status, "failed");
  assert.deepEqual(
    correctness.assertions.filter((a) => !a.passed).map((a) => a.invariantIds),
    [["TK-SLUG-DIACRITICS"]],
  );

  writeFileSync(
    join(broken, "src/index.ts"),
    'export { slugify } from "../../search-service/src/index.ts";\n',
  );
  const structural = await run(broken, hashDirectory(broken).hash, "structural");
  assert.equal(structural.status, "failed");
  assert.ok(BUNDLE_SIZE.structuralViolations(broken).length > 0);
});

const HORIZON_ROOT = join(import.meta.dirname, "..");

function horizonCopy(): string {
  const root = mkdtempSync(join(tmpdir(), "horizon-bundle-hash-"));
  for (const dir of ["src", "verification"])
    cpSync(join(HORIZON_ROOT, dir), join(root, dir), { recursive: true });
  return root;
}

function edit(file: string, from: string, to: string): void {
  const text = readFileSync(file, "utf8");
  assert.ok(text.includes(from), `${file} contains ${from}`);
  writeFileSync(file, text.replace(from, to));
}

test("bundle evaluator identity covers held-out scenarios", () => {
  const root = horizonCopy();
  assert.equal(computeBundleEvaluatorHash(root), computeBundleEvaluatorHash());
  edit(
    join(root, "verification/bundle-size/holdout/holdout-unicode-text.json"),
    "日本語",
    "nihongo",
  );
  assert.notEqual(computeBundleEvaluatorHash(root), computeBundleEvaluatorHash());
  assert.notEqual(BUNDLE_SIZE.evaluator.hash(), SEARCH_P95.evaluator.hash());
});

test("bundle evaluator identity covers the objective metric and its comparison semantics", () => {
  const edits: [string, string, string][] = [
    ["src/objectives/bundle-size.ts", 'direction: "minimize"', 'direction: "maximize"'],
    ["src/objectives/bundle-size.ts", "key: BUNDLE_METRIC_KEY", 'key: "bundleFiles"'],
    ["src/objective-metric.ts", "export function improvedBound", "export function improvedBound2"],
    ["src/timing-policy.ts", "export", "export /* changed */"],
  ];
  for (const [file, from, to] of edits) {
    const root = horizonCopy();
    edit(join(root, file), from, to);
    assert.notEqual(
      computeBundleEvaluatorHash(root),
      computeBundleEvaluatorHash(),
      `${file}: ${to}`,
    );
  }
  const unrelated = horizonCopy();
  edit(join(unrelated, "src/objectives/search-p95.ts"), "export", "export /* changed */");
  assert.equal(computeBundleEvaluatorHash(unrelated), computeBundleEvaluatorHash());
  assert.equal(SEARCH_P95.evaluator.hash(), computeEvaluatorHash());
});

test("bundle scenario processes cannot read the cases, result marker or entry from the environment", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "horizon-bundle-env-"));
  mkdirSync(join(dir, "src"));
  writeFileSync(
    join(dir, "src/index.ts"),
    'export const visible = (): string[] => Object.keys(process.env).filter((k) => k.startsWith("HORIZON_"));\n',
  );
  const evidence = new FileEvidenceStore(mkdtempSync(join(tmpdir(), "horizon-bundle-env-ev-")));
  const probe = (isolation: "subprocess" | "container", containerImage: string) =>
    runBundleCases(
      {
        missionId: "bundle-env",
        experimentId: `env-${isolation}`,
        artifactHash: hashDirectory(dir).hash,
        evaluatorHash: computeBundleEvaluatorHash(),
        environmentHash: "env",
        snapshotDir: dir,
        isolation,
        containerImage,
        timeoutMs: 20_000,
        memoryLimitBytes: 256 * 1024 * 1024,
        evidence,
      },
      [
        { fn: "visible", args: [] },
        { fn: "visible", args: ["second"] },
      ],
    );
  const expected = [
    { ok: true, value: [] },
    { ok: true, value: [] },
  ];
  assert.deepEqual((await probe("subprocess", "")).outcomes, expected);

  const image = loadMissionConfig(BUNDLE_CONFIG).containerImage;
  try {
    assertSandboxAvailable(image);
  } catch (error) {
    if (process.env.HORIZON_REQUIRE_DOCKER === "1") throw error;
    t.diagnostic(`container probe skipped: ${String(error)}`);
    return;
  }
  assert.deepEqual((await probe("container", image)).outcomes, expected);
});

test("bundle-size mission runs baseline -> shrink-bundle -> holdout and reaches its target", async () => {
  const config = bundleConfig("bundle-lifecycle");
  const controller = bundleController(config, tempRunsRoot());
  await controller.initialize();
  assert.equal(controller.spec, BUNDLE_SIZE);
  assert.equal(controller.evaluatorHash, computeBundleEvaluatorHash());
  const tasks = await controller.ledger.listTasks(config.missionId);
  assert.deepEqual(
    tasks.map((t) => [t.taskId, t.dependsOn]),
    [
      ["baseline", []],
      ["shrink-bundle", ["baseline"]],
      ["holdout", ["shrink-bundle"]],
    ],
  );
  const row = await controller.run();
  assert.equal(row.status, "succeeded");
  const seedBytes = bundleBytes(TEXT_KIT_SEED_DIR).bytes;
  assert.equal(row.baselineP95Ms, seedBytes);
  assert.ok(
    row.bestP95Ms! <= improvedBound(seedBytes, config.targetImprovement!, BUNDLE_SIZE.metric),
  );

  const experiments = await controller.ledger.listExperiments(config.missionId);
  assert.deepEqual(
    experiments.map((e) => [e.taskId, e.status]),
    [
      ["baseline", "accepted"],
      ["shrink-bundle", "rejected"],
      ["shrink-bundle", "accepted"],
      ["shrink-bundle", "accepted"],
      ["holdout", "accepted"],
    ],
  );
  assert.match(experiments[1]!.verdict ?? "", /correctness failed: scenario:slug-diacritics/);
  assert.equal(experiments.at(-2)!.candidateArtifactHash, row.bestArtifactHash);
  assert.deepEqual(
    (await controller.ledger.listTasks(config.missionId)).map((t) => t.status),
    ["done", "done", "done"],
  );
  const holdout = (await controller.ledger.listVerifications(config.missionId)).filter(
    (v) => v.suite === "holdout",
  );
  assert.deepEqual(
    holdout.map((v) => [v.artifactHash, v.status]),
    [[row.bestArtifactHash, "passed"]],
  );
});

test("a crashed bundle-size mission resumes to the same verified outcome", async () => {
  const runs = tempRunsRoot();
  const config = bundleConfig("bundle-crash");
  const first = bundleController(config, runs, { crashAt: "snapshot_ready" });
  await first.initialize();
  await assert.rejects(first.run(), SimulatedCrash);
  const inFlight = (await first.ledger.listExperiments(config.missionId)).find(
    (e) => e.status === "snapshot_ready",
  );
  assert.equal(inFlight?.taskId, "shrink-bundle");
  await first.close();

  const second = bundleController(config, runs);
  const row = await second.run();
  assert.equal(row.status, "succeeded");
  assert.equal(row.baselineP95Ms, bundleBytes(TEXT_KIT_SEED_DIR).bytes);
  const experiments = await second.ledger.listExperiments(config.missionId);
  await second.close();
  const recovered = experiments.find((e) => e.experimentId === inFlight!.experimentId);
  assert.equal(recovered?.status, "rejected");
  assert.equal(recovered?.candidateArtifactHash, inFlight!.candidateArtifactHash);
});
