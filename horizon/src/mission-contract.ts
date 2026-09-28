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
  retention?: {
    keepRecentCandidates: number;
    keepRecentSegments: number;
    compactEventsAfter: number;
  };
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
  if (c.retention !== undefined) {
    if (typeof c.retention !== "object" || c.retention === null)
      fail("retention must be an object");
    positiveInteger("retention.keepRecentCandidates", c.retention.keepRecentCandidates);
    positiveInteger("retention.keepRecentSegments", c.retention.keepRecentSegments);
    positiveInteger("retention.compactEventsAfter", c.retention.compactEventsAfter);
  }
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

/**
 * Operating parameters: knobs a long mission is expected to outlive. They are
 * amendable through an audited `mission.amended` transition and never feed the
 * contract hash. Everything else in the config is the frozen objective.
 */
export const OPERATING_FIELDS = [
  "budget",
  "segmentRotationCycles",
  "stagnationLimit",
  "performanceRejectionLimit",
  "model",
  "worker",
  "memory",
  "retention",
] as const satisfies readonly (keyof MissionConfig)[];

export type OperatingField = (typeof OPERATING_FIELDS)[number];
export type OperatingParameters = Pick<MissionConfig, OperatingField>;
export type MissionObjective = Omit<MissionConfig, OperatingField | "ledger">;

export function objectiveOf(config: MissionConfig): MissionObjective {
  const objective: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (key === "ledger" || (OPERATING_FIELDS as readonly string[]).includes(key)) continue;
    objective[key] = value;
  }
  return objective as unknown as MissionObjective;
}

export function operatingOf(config: MissionConfig): OperatingParameters {
  const operating: Partial<OperatingParameters> = {};
  for (const key of OPERATING_FIELDS) Object.assign(operating, { [key]: config[key] });
  return operating as OperatingParameters;
}

/** Hash of the frozen objective only; budgets, model, worker and the ledger backend never change it. */
export function contractHash(config: MissionConfig): string {
  return sha256(canonicalJson(objectiveOf(config)));
}

/** Hash frozen by missions created before operating parameters were split out: every field but `ledger`. */
export function legacyContractHash(config: MissionConfig): string {
  const { ledger: _ledger, ...contract } = config;
  return sha256(canonicalJson(contract));
}

export interface ParameterChange {
  /** Dotted path, e.g. `budget.maxExperiments` or `model.id`. */
  path: string;
  from: unknown;
  to: unknown;
}

/** Leaf-level differences between two values, as dotted paths. */
export function diffParameters(from: unknown, to: unknown, prefix = ""): ParameterChange[] {
  if (isPlainObject(from) && isPlainObject(to)) {
    const keys = [...new Set([...Object.keys(from), ...Object.keys(to)])].sort();
    return keys.flatMap((key) =>
      diffParameters(from[key], to[key], prefix ? `${prefix}.${key}` : key),
    );
  }
  if (canonicalJson(from) === canonicalJson(to)) return [];
  return [{ path: prefix, from, to }];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface Amendment {
  /** Operating-parameter changes, in dotted-path order. */
  changes: ParameterChange[];
  /** Budget fields whose limit was raised; each one is recorded as `budget.extended`. */
  budgetExtensions: ParameterChange[];
}

/**
 * Validates `next` as the replacement operating parameters for a mission frozen
 * from `current`. The objective must hash identically and the ledger backend is
 * a deployment pin that cannot move; every other difference is an amendment.
 */
export function planAmendment(current: MissionConfig, next: MissionConfig): Amendment {
  const objectiveDrift = diffParameters(objectiveOf(current), objectiveOf(next));
  if (objectiveDrift.length > 0)
    throw new Error(
      `amendment changes the frozen objective (${objectiveDrift.map((c) => c.path).join(", ")}); start a new mission with a new missionId instead`,
    );
  const currentBackend = current.ledger?.backend ?? null;
  const nextBackend = next.ledger?.backend ?? currentBackend;
  if (currentBackend !== null && nextBackend !== currentBackend)
    throw new Error(
      `amendment moves the ledger backend from ${currentBackend} to ${nextBackend}; the backend is pinned for the life of the mission`,
    );
  const changes = diffParameters(operatingOf(current), operatingOf(next));
  const budgetExtensions = changes.filter(
    (c) =>
      c.path.startsWith("budget.") &&
      typeof c.from === "number" &&
      typeof c.to === "number" &&
      c.to > c.from,
  );
  return { changes, budgetExtensions };
}
