import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { testConfig } from "./helpers.ts";

test("scripted soak resumes an injected crash without resending the experiment and rotates segments", () => {
  const root = mkdtempSync(join(tmpdir(), "horizon-soak-test-"));
  const config = join(root, "config.json");
  const out = join(root, "results");
  writeFileSync(config, JSON.stringify({ ...testConfig("soak-template"), acceptanceMargin: 0.05 }));
  const run = spawnSync(
    process.execPath,
    [
      new URL("../scripts/soak.ts", import.meta.url).pathname,
      "--config",
      config,
      "--out",
      out,
      "--missions",
      "5",
      "--experiments",
      "2",
      "--max-runs",
      "6",
    ],
    { encoding: "utf8", timeout: 60_000 },
  );
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const report = JSON.parse(readFileSync(join(out, "report.json"), "utf8")) as {
    missions: number;
    experiments: number;
    injectedFaults: number;
    replayedFaults: number;
  };
  const samples = JSON.parse(readFileSync(join(out, "samples.json"), "utf8")) as {
    exitCode: number;
    spentExperiments: number;
    segments: number;
    packetTokens: number[];
    retrievalMs: number[];
    recoveryMs: number | null;
    ledgerBytes: number;
    artifactBytes: number;
  }[];
  assert.equal(report.injectedFaults, 1);
  assert.equal(report.missions, 1);
  assert.equal(report.experiments, 2);
  assert.equal(report.replayedFaults, 1);
  assert.equal(samples[0]?.exitCode, 3);
  assert.equal(samples[0]?.spentExperiments, 1);
  assert.equal(samples.at(-1)?.spentExperiments, 2);
  assert.ok(samples.some((sample) => sample.segments >= 2));
  assert.ok(samples.some((sample) => sample.packetTokens.length > 0));
  assert.ok(samples.every((sample) => sample.packetTokens.length <= 1));
  assert.ok(
    samples.some((sample) => sample.retrievalMs.length > 0) &&
      samples.every((sample) => sample.retrievalMs.every((ms) => Number.isFinite(ms) && ms >= 0)),
  );
  assert.ok(samples.every((sample) => sample.recoveryMs !== null && sample.recoveryMs >= 0));
  assert.ok(samples.every((sample) => sample.ledgerBytes > 0 && sample.artifactBytes > 0));
});
