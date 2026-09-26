import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { VerificationReport } from "../verification/reports.ts";
import { MissionController, type ControllerOptions } from "../src/controller.ts";
import { loadMissionConfig, type MissionConfig } from "../src/mission-contract.ts";
import { LocalMemoryAdapter } from "../src/memory-adapter.ts";
import { missionPaths } from "../src/mission-paths.ts";

export const EXAMPLE_CONFIG = new URL("../mission.example.json", import.meta.url).pathname;

/** Small, fast mission config derived from the example; subprocess isolation so tests need no Docker. */
export function testConfig(
  missionId: string,
  overrides: Partial<MissionConfig> = {},
): MissionConfig {
  const base = loadMissionConfig(EXAMPLE_CONFIG);
  return {
    ...base,
    missionId,
    isolation: "subprocess",
    targetP95Reduction: 0.1,
    acceptanceMargin: 0.02,
    workload: {
      ...base.workload,
      corpusSize: 3000,
      warmupRequests: 30,
      measuredRequests: 150,
      repetitions: 3,
    },
    holdoutWorkload: {
      ...base.holdoutWorkload,
      corpusSize: 3000,
      warmupRequests: 30,
      measuredRequests: 150,
      repetitions: 3,
    },
    budget: { ...base.budget, maxExperiments: 4 },
    memory: { ...base.memory, containerTag: `horizon-${missionId}` },
    ...overrides,
  };
}

export function tempRunsRoot(): string {
  return mkdtempSync(join(tmpdir(), "horizon-test-"));
}

export function controllerFor(
  missionId: string,
  runsRoot: string,
  options: ControllerOptions = {},
  overrides: Partial<MissionConfig> = {},
): Promise<MissionController> {
  const config = testConfig(missionId, overrides);
  // Hermetic by default: a SUPERMEMORY_API_KEY in the environment must not route tests to the hosted service.
  return MissionController.open(config, missionPaths(missionId, runsRoot), {
    memory: new LocalMemoryAdapter(),
    ...options,
  });
}

export function readReport(path: string): VerificationReport {
  return JSON.parse(readFileSync(path, "utf8")) as VerificationReport;
}
