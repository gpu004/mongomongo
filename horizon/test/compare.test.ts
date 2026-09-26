import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  CONFIGURATIONS,
  compareConfigurations,
  defaultMemoryAdapter,
  renderComparison,
  type CompareResult,
} from "../src/compare.ts";
import { LocalMemoryAdapter } from "../src/memory-adapter.ts";
import type { MissionConfig } from "../src/mission-contract.ts";
import { missionPaths } from "../src/mission-paths.ts";
import { resolveProviderApiKey } from "../src/pi-worker.ts";
import { ScriptedWorker } from "../src/scripted-worker.ts";
import type { Worker } from "../src/worker.ts";
import { EXAMPLE_CONFIG, tempRunsRoot, testConfig } from "./helpers.ts";

const CLI = new URL("../src/cli.ts", import.meta.url).pathname;

function piConfig(missionId: string): MissionConfig {
  return testConfig(missionId, { worker: "pi" });
}

test("compare refuses a pi config without a worker factory instead of running scripted", async () => {
  const runsRoot = tempRunsRoot();
  await assert.rejects(
    compareConfigurations({
      runsRoot,
      base: piConfig("pi-no-factory"),
      interruptions: [{ crashAt: null, maxCycles: 1 }],
      repeats: 1,
    }),
    /requests worker "pi" but no workerFactory/,
  );
  for (const configuration of CONFIGURATIONS) {
    const id = `cmp-${configuration.replace(/[^a-z]+/g, "-")}-1`;
    assert.equal(existsSync(missionPaths(id, runsRoot).manifest), false);
  }
});

test("compare refuses a factory whose worker mode differs from the configured worker", async () => {
  await assert.rejects(
    compareConfigurations({
      runsRoot: tempRunsRoot(),
      base: piConfig("pi-wrong-factory"),
      interruptions: [{ crashAt: null, maxCycles: 1 }],
      repeats: 1,
      workerFactory: () => new ScriptedWorker(),
    }),
    /requests worker "pi" but factory returned "scripted"/,
  );
});

test("compare passes the derived config and paths to the worker factory and keeps the worker in each manifest", async () => {
  const runsRoot = tempRunsRoot();
  const seen: {
    configuration: string;
    missionId: string;
    worker: string;
    root: string;
  }[] = [];
  const result = await compareConfigurations({
    runsRoot,
    base: testConfig("scripted-factory"),
    interruptions: [{ crashAt: null, maxCycles: 1 }],
    repeats: 1,
    workerFactory: (configuration, config, paths): Worker => {
      seen.push({
        configuration,
        missionId: config.missionId,
        worker: config.worker,
        root: paths.root,
      });
      return new ScriptedWorker();
    },
    memoryFactory: () => new LocalMemoryAdapter(),
  });
  assert.deepEqual(
    seen.map((s) => s.configuration),
    [...CONFIGURATIONS],
  );
  for (const s of seen) {
    assert.equal(s.worker, "scripted");
    assert.equal(s.root, missionPaths(s.missionId, runsRoot).root);
    const manifest = JSON.parse(
      readFileSync(missionPaths(s.missionId, runsRoot).manifest, "utf8"),
    ) as { config: MissionConfig };
    assert.equal(manifest.config.worker, "scripted");
  }
  assert.equal(result.worker, "scripted");
  assert.equal(result.memoryAdapter, "local");
  const rendered = renderComparison(result);
  assert.match(rendered, /Scripted worker, local memory adapter/);
  assert.equal(readFileSync(join(runsRoot, "comparison.md"), "utf8"), rendered);
});

test("renderComparison names the pi worker and hosted adapter when they were used", () => {
  const result: CompareResult = {
    worker: "pi",
    memoryAdapter: "supermemory",
    schedule: [],
    seedHash: null,
    evaluatorHash: null,
    measurements: [],
  };
  assert.match(renderComparison(result), /Pi worker, hosted Supermemory adapter/);
});

test("defaultMemoryAdapter follows the controller's rule: hosted only when enabled and a key is present", () => {
  const saved = process.env.SUPERMEMORY_API_KEY;
  try {
    delete process.env.SUPERMEMORY_API_KEY;
    assert.equal(defaultMemoryAdapter(testConfig("m1")).kind, "local");
    process.env.SUPERMEMORY_API_KEY = "sm_test";
    assert.equal(defaultMemoryAdapter(testConfig("m2")).kind, "supermemory");
    assert.equal(
      defaultMemoryAdapter(
        testConfig("m3", {
          memory: { ...testConfig("m3").memory, enabled: false },
        }),
      ).kind,
      "local",
    );
  } finally {
    if (saved === undefined) delete process.env.SUPERMEMORY_API_KEY;
    else process.env.SUPERMEMORY_API_KEY = saved;
  }
});

test("cli compare with worker pi and no provider key fails before creating any mission", () => {
  const runsRoot = tempRunsRoot();
  const base = JSON.parse(readFileSync(EXAMPLE_CONFIG, "utf8")) as MissionConfig;
  const configPath = join(runsRoot, "pi-nokey.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      ...base,
      worker: "pi",
      missionId: "pi-nokey",
      memory: { ...base.memory, containerTag: "horizon-pi-nokey" },
    }),
  );
  const envKey = `${base.model.provider.toUpperCase().replace(/-/g, "_")}_API_KEY`;
  const env = { ...process.env };
  for (const key of resolveProviderApiKey(base.model.provider, env).envKeys) delete env[key];
  const proc = spawnSync(
    process.execPath,
    [CLI, "compare", "--config", configPath, "--runs-root", runsRoot],
    { env, encoding: "utf8" },
  );
  assert.equal(proc.status, 1, proc.stdout + proc.stderr);
  assert.match(proc.stderr, new RegExp(`worker "pi".*requires ${envKey}`));
  for (const configuration of CONFIGURATIONS) {
    const id = `cmp-${configuration.replace(/[^a-z]+/g, "-")}-1`;
    assert.equal(existsSync(missionPaths(id, runsRoot).manifest), false);
  }
  assert.equal(existsSync(join(runsRoot, "comparison.md")), false);
});
