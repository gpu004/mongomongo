import { readFileSync } from "node:fs";
import { canonicalJson, sha256 } from "../verification/reports.ts";
import type { WorkloadSpec } from "../verification/workloads/index.ts";

/**
 * Everything frozen before optimization starts. The hash of this object is the
 * mission's contract identity; changing any field means a new comparison run.
 */
export interface MissionConfig {
  schemaVersion: 1;
  missionId: string;
  contractVersion: number;
  objective: string;
  /** Relative p95 reduction required against the original seed baseline, e.g. 0.3. */
  targetP95Reduction: number;
  /** Fractional improvement over the current best required to accept, floor 0.05. */
  acceptanceMargin: number;
  /**
   * Baseline repetition spread at or above which the mission is blocked before optimization
   * instead of raising the frozen margin. Defaults to `targetP95Reduction`: noise as large as
   * the target cannot distinguish a useful change.
   */
  maxRepetitionSpread?: number;
  /** Of the paired repetitions, how many must improve (e.g. 4 of 5). */
  requiredImprovedRepetitions: number;
  workload: WorkloadSpec;
  holdoutWorkload: WorkloadSpec;
  isolation: "container" | "subprocess";
  containerImage: string;
  memoryLimitBytes: number;
  startupTimeoutMs: number;
  requestTimeoutMs: number;
  budget: {
    maxWallMs: number;
    maxExperiments: number;
    maxInputTokens: number;
    maxOutputTokens: number;
    maxMemoryOperations: number;
    cycleTimeoutMs: number;
  };
  /** Rotate the Pi segment after this many completed cycles. */
  segmentRotationCycles: number;
  /** Consecutive experiments without valid improvement before a new mechanism/profile is required. */
  stagnationLimit: number;
  model: { provider: string; id: string };
  /** "scripted" runs the deterministic worker adapter; "pi" runs a live Pi session. */
  worker: "scripted" | "pi";
  memory: {
    enabled: boolean;
    /** Mission-specific containerTag; cross-mission memory is disabled in the MVP. */
    containerTag: string;
    materializeCorrections: boolean;
  };
  /**
   * Canonical mission store; exactly one backend per mission, frozen in the
   * contract. Omitted means local SQLite. The MongoDB connection string comes
   * from MONGODB_URI and is never part of the config.
   */
  ledger?: { backend: "sqlite" | "mongodb"; database?: string };
}

export function loadMissionConfig(path: string): MissionConfig {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  return validateMissionConfig(parsed);
}

export function validateMissionConfig(value: unknown): MissionConfig {
  if (typeof value !== "object" || value === null)
    throw new Error("mission config must be an object");
  const c = value as Partial<MissionConfig>;
  const fail = (msg: string): never => {
    throw new Error(`invalid mission config: ${msg}`);
  };
  if (c.schemaVersion !== 1) fail("schemaVersion must be 1");
  if (typeof c.missionId !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(c.missionId))
    fail("missionId must be a lowercase slug");
  if (typeof c.contractVersion !== "number") fail("contractVersion required");
  if (typeof c.objective !== "string") fail("objective required");
  if (
    typeof c.targetP95Reduction !== "number" ||
    c.targetP95Reduction <= 0 ||
    c.targetP95Reduction >= 1
  )
    fail("targetP95Reduction must be in (0,1)");
  if (typeof c.acceptanceMargin !== "number" || c.acceptanceMargin < 0.05)
    fail("acceptanceMargin floor is 0.05");
  if (
    c.maxRepetitionSpread !== undefined &&
    (typeof c.maxRepetitionSpread !== "number" ||
      c.maxRepetitionSpread <= 0 ||
      c.maxRepetitionSpread > 1)
  )
    fail("maxRepetitionSpread must be in (0,1]");
  if (typeof c.requiredImprovedRepetitions !== "number")
    fail("requiredImprovedRepetitions required");
  if (!c.workload || !c.holdoutWorkload) fail("workload and holdoutWorkload required");
  if (c.workload!.repetitions < 2) fail("workload.repetitions must be >= 2");
  if (c.requiredImprovedRepetitions! > c.workload!.repetitions)
    fail("requiredImprovedRepetitions exceeds repetitions");
  if (canonicalJson(c.workload) === canonicalJson(c.holdoutWorkload))
    fail("holdoutWorkload must differ from workload");
  if (c.isolation !== "container" && c.isolation !== "subprocess")
    fail("isolation must be container|subprocess");
  if (typeof c.containerImage !== "string")
    fail("containerImage required (may be empty for subprocess)");
  if (typeof c.memoryLimitBytes !== "number" || c.memoryLimitBytes <= 0)
    fail("memoryLimitBytes required");
  if (typeof c.startupTimeoutMs !== "number" || typeof c.requestTimeoutMs !== "number")
    fail("timeouts required");
  if (
    !c.budget ||
    typeof c.budget.maxWallMs !== "number" ||
    typeof c.budget.maxExperiments !== "number"
  )
    fail("budget incomplete");
  if (typeof c.segmentRotationCycles !== "number" || c.segmentRotationCycles < 1)
    fail("segmentRotationCycles >= 1");
  if (typeof c.stagnationLimit !== "number") fail("stagnationLimit required");
  if (!c.model || typeof c.model.provider !== "string" || typeof c.model.id !== "string")
    fail("model required");
  if (c.worker !== "scripted" && c.worker !== "pi") fail("worker must be scripted|pi");
  if (
    !c.memory ||
    typeof c.memory.enabled !== "boolean" ||
    typeof c.memory.containerTag !== "string"
  )
    fail("memory config incomplete");
  if (c.memory!.containerTag !== `horizon-${c.missionId}`)
    fail("memory.containerTag must be horizon-<missionId> (mission-scoped)");
  if (c.ledger !== undefined) {
    if (c.ledger.backend !== "sqlite" && c.ledger.backend !== "mongodb")
      fail("ledger.backend must be sqlite|mongodb");
    if (
      c.ledger.database !== undefined &&
      (typeof c.ledger.database !== "string" || !/^[A-Za-z0-9_-]{1,63}$/.test(c.ledger.database))
    )
      fail("ledger.database must be a plain database name");
    if (c.ledger.backend === "sqlite" && c.ledger.database !== undefined)
      fail("ledger.database applies to mongodb only");
  }
  return c as MissionConfig;
}

export function contractHash(config: MissionConfig): string {
  return sha256(canonicalJson(config));
}
