import { readFileSync } from "node:fs";
import { canonicalJson, sha256 } from "../verification/reports.ts";
import type { WorkloadSpec } from "../verification/workloads/index.ts";
import { isDigestPinnedImage } from "./sandbox.ts";

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
  /** Sandbox image, pinned by digest (`repo@sha256:...`) when isolation is "container". */
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
  /** Measured-only rejections of one mechanism before it is blocked without a fresh profile. Defaults to 2. */
  performanceRejectionLimit?: number;
  model: { provider: string; id: string };
  /** "scripted" runs the deterministic worker adapter; "pi" runs a live Pi session. */
  worker: "scripted" | "pi";
  memory: {
    enabled: boolean;
    /** Mission-specific containerTag; the only tag this mission ever writes to. */
    containerTag: string;
    materializeCorrections: boolean;
    /**
     * Optional read-only tier shared across missions on one codebase, e.g. `horizon-codebase-<hash>`.
     * Retrieval from it is post-filtered and every injected item carries its origin mission.
     */
    crossMission?: { readTags: string[] };
  };
  /**
   * Ledger backend. "mongodb" requires `MONGODB_URI` and never falls back to SQLite;
   * when omitted the backend follows the environment (MongoDB if `MONGODB_URI` is set).
   */
  ledger?: { backend: "sqlite" | "mongodb" };
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
  const positiveFinite = (name: string, v: unknown): void => {
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0)
      fail(`${name} must be a finite number > 0`);
  };
  const positiveInteger = (name: string, v: unknown): void => {
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1)
      fail(`${name} must be an integer >= 1`);
  };
  if (c.schemaVersion !== 1) fail("schemaVersion must be 1");
  if (typeof c.missionId !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(c.missionId))
    fail("missionId must be a lowercase slug");
  positiveInteger("contractVersion", c.contractVersion);
  if (typeof c.objective !== "string") fail("objective required");
  if (
    typeof c.targetP95Reduction !== "number" ||
    !Number.isFinite(c.targetP95Reduction) ||
    c.targetP95Reduction <= 0 ||
    c.targetP95Reduction >= 1
  )
    fail("targetP95Reduction must be in (0,1)");
  if (
    typeof c.acceptanceMargin !== "number" ||
    !Number.isFinite(c.acceptanceMargin) ||
    c.acceptanceMargin < 0.05 ||
    c.acceptanceMargin >= 1
  )
    fail("acceptanceMargin must be in [0.05,1)");
  if (
    c.maxRepetitionSpread !== undefined &&
    (typeof c.maxRepetitionSpread !== "number" ||
      !Number.isFinite(c.maxRepetitionSpread) ||
      c.maxRepetitionSpread <= 0 ||
      c.maxRepetitionSpread > 1)
  )
    fail("maxRepetitionSpread must be in (0,1]");
  positiveInteger("requiredImprovedRepetitions", c.requiredImprovedRepetitions);
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
  if (c.isolation === "container" && !isDigestPinnedImage(c.containerImage!))
    fail("containerImage must be pinned by digest (repo@sha256:...) under container isolation");
  positiveInteger("memoryLimitBytes", c.memoryLimitBytes);
  positiveFinite("startupTimeoutMs", c.startupTimeoutMs);
  positiveFinite("requestTimeoutMs", c.requestTimeoutMs);
  if (typeof c.budget !== "object" || c.budget === null) fail("budget incomplete");
  const b = c.budget as Partial<MissionConfig["budget"]>;
  positiveFinite("budget.maxWallMs", b.maxWallMs);
  positiveInteger("budget.maxExperiments", b.maxExperiments);
  positiveInteger("budget.maxInputTokens", b.maxInputTokens);
  positiveInteger("budget.maxOutputTokens", b.maxOutputTokens);
  positiveInteger("budget.maxMemoryOperations", b.maxMemoryOperations);
  positiveFinite("budget.cycleTimeoutMs", b.cycleTimeoutMs);
  if (
    typeof c.segmentRotationCycles !== "number" ||
    !Number.isInteger(c.segmentRotationCycles) ||
    c.segmentRotationCycles < 1
  )
    fail("segmentRotationCycles >= 1 (integer)");
  if (
    typeof c.stagnationLimit !== "number" ||
    !Number.isInteger(c.stagnationLimit) ||
    c.stagnationLimit < 1
  )
    fail("stagnationLimit >= 1 (integer)");
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
  const cross = c.memory!.crossMission;
  if (cross !== undefined) {
    if (
      typeof cross !== "object" ||
      cross === null ||
      !Array.isArray(cross.readTags) ||
      cross.readTags.some(
        (t) => typeof t !== "string" || !/^horizon-codebase-[A-Za-z0-9._-]+$/.test(t),
      )
    )
      fail("memory.crossMission.readTags must be horizon-codebase-<hash> tags");
    if (cross.readTags.includes(c.memory!.containerTag))
      fail("memory.crossMission.readTags must not include the mission's own write tag");
  }
  if (
    c.performanceRejectionLimit !== undefined &&
    (typeof c.performanceRejectionLimit !== "number" ||
      !Number.isInteger(c.performanceRejectionLimit) ||
      c.performanceRejectionLimit < 1)
  )
    fail("performanceRejectionLimit >= 1 (integer)");
  if (
    c.ledger !== undefined &&
    (typeof c.ledger !== "object" ||
      c.ledger === null ||
      (c.ledger.backend !== "sqlite" && c.ledger.backend !== "mongodb"))
  )
    fail("ledger.backend must be sqlite|mongodb");
  return c as MissionConfig;
}

/** Where the ledger lives is deployment, not contract: pinning the backend never changes the hash. */
export function contractHash(config: MissionConfig): string {
  const { ledger: _ledger, ...contract } = config;
  return sha256(canonicalJson(contract));
}
