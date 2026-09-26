import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import {
  canonicalJson,
  sha256,
  type Suite,
  validateReport,
  type VerificationReport,
} from "../verification/reports.ts";
import type { ContainerRegistry } from "../verification/candidate-process.ts";
import { computeEnvironmentHash, computeEvaluatorHash, runSuite } from "../verification/runner.ts";
import { loadScenarios, type Scenario } from "../verification/scenarios/index.ts";
import { ArtifactStore } from "./artifact-store.ts";
import { auditClaim } from "./claim-audit.ts";
import { buildPacket, type ContextPacket, DEFAULT_PACKET_BUDGET } from "./context-packet.ts";
import {
  type ExperimentRow,
  type LeaseRow,
  type LessonRow,
  type LessonState,
  type MissionRow,
  type MissionStatus,
} from "./ledger.ts";
import { openLedger } from "./ledger-backend.ts";
import { type AsyncLedger, LeaseError } from "./ledger-contract.ts";
import {
  type RegressionProposal,
  validateAgainstFixtures,
  validateProposalShape,
} from "./lesson-policy.ts";
import {
  type EpisodePayload,
  LocalMemoryAdapter,
  type MemoryAdapter,
  renderEpisode,
  SupermemoryAdapter,
} from "./memory-adapter.ts";
import { composeRetrievalQuery, MemoryOutbox, retrieveEpisodes } from "./memory-outbox.ts";
import { contractHash, type MissionConfig } from "./mission-contract.ts";
import {
  ensureMissionDirs,
  FileEvidenceStore,
  type MissionPaths,
  writeJsonAtomic,
} from "./mission-paths.ts";
import { type ContainerRuntime, recover, type RecoveryOutcome } from "./recovery.ts";
import { assertSandboxAvailable, cleanupOrphanContainers } from "./sandbox.ts";
import { ScriptedWorker } from "./scripted-worker.ts";
import { type BrokerHooks, type ExecSandbox, ToolBroker } from "./tool-broker.ts";
import {
  firstComparison,
  freezeAcceptanceMargin,
  repetitionSpread,
  rerunComparison,
  type TimingDecision,
  type TimingPolicy,
} from "./timing-policy.ts";
import { type Worker, type WorkerCycleResult, WorkerUnavailableError } from "./worker.ts";

export const RESOURCES_DIR = new URL("../resources/", import.meta.url).pathname;

export interface ControllerOptions {
  worker?: Worker;
  memory?: MemoryAdapter;
  log?: (line: string) => void;
  /** Test hook: throw at a named point to simulate a crash. */
  crashAt?: string;
  /** Stop after this many cycles regardless of budget (CLI --cycles). */
  maxCycles?: number;
  /** Test hook: container runtime used by resume to remove orphaned candidate containers. */
  containerRuntime?: ContainerRuntime;
  /** Test hook: how `run()` waits for a persisted `nextWakeAt` (default: real sleep). */
  sleep?: (ms: number) => Promise<void>;
  /** Test hook: opens the ledger instead of `openLedger(config, paths)` (backend selection). */
  ledger?: () => Promise<AsyncLedger>;
  /** Lease time-to-live; the heartbeat renews at a third of it. */
  leaseTtlMs?: number;
  /** Lease owner identity recorded in the ledger (default: host, pid and a random suffix). */
  leaseOwner?: string;
}

export const DEFAULT_LEASE_TTL_MS = 30_000;

export type Verdict = "accepted" | "rejected" | "inconclusive";

interface Story {
  hypothesis: string;
  whatChanged: string;
  claim: string;
  seededFixture: string | null;
  claimIssues?: string[];
}

/** Per-field character limits for worker prose kept in events, episodes and packets; full text goes to evidence. */
const WORKER_TEXT_LIMITS = { hypothesis: 400, whatChanged: 800, claim: 800 } as const;

/** Collapses case, whitespace and punctuation so reworded repeats of one mechanism compare equal. */
export function normalizeHypothesis(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export interface StagnationState {
  /** Concluded optimize-search experiments since the last accepted one. */
  count: number;
  /** Normalized hypotheses tried during that run. */
  triedHypotheses: string[];
  stagnated: boolean;
}

/** Deterministic behavior suites whose failed report for an artifact can be reused across experiments. */
const REUSABLE_FAILURE_SUITES = new Set<Suite>(["smoke", "correctness", "structural"]);

const TASKS = [
  {
    taskId: "baseline",
    ordinal: 1,
    dependsOn: [] as string[],
    hypothesis: "measure the seed",
    completionCriteria: "seed passes correctness and has a valid performance report",
    nextAction: "run fixed suites on the seed artifact",
  },
  {
    taskId: "optimize-search",
    ordinal: 2,
    dependsOn: ["baseline"],
    hypothesis: "reduce read-path p95",
    completionCriteria: "best artifact p95 <= baseline * (1 - target)",
    nextAction: "profile the seed read path and propose one bounded change",
  },
  {
    taskId: "holdout",
    ordinal: 3,
    dependsOn: ["optimize-search"],
    hypothesis: "best artifact generalizes",
    completionCriteria: "holdout suite passes on the chosen artifact",
    nextAction: "run holdout on the best artifact",
  },
];

/**
 * Owns the mission loop. Every state transition is a ledger write before the
 * next side effect, so a crash at any point resumes from durable state.
 */
export class MissionController {
  readonly config: MissionConfig;
  readonly paths: MissionPaths;
  readonly artifacts: ArtifactStore;
  readonly evidence: FileEvidenceStore;
  readonly memory: MemoryAdapter;
  readonly worker: Worker;
  private ledgerHandle: AsyncLedger | undefined;
  private opening: Promise<AsyncLedger> | undefined;
  private outboxHandle: MemoryOutbox | undefined;
  private readonly openLedger: () => Promise<AsyncLedger>;
  private readonly log: (line: string) => void;
  private readonly crashAt: string | undefined;
  private readonly maxCycles: number;
  private readonly containerRuntime: ContainerRuntime | undefined;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly leaseTtlMs: number;
  private readonly leaseOwner: string;
  private leaseRow: LeaseRow | undefined;
  private heartbeat: NodeJS.Timeout | undefined;
  private heartbeatError: unknown;
  /** Tool-call audit events are appended in order without blocking the broker; flushed before every transaction. */
  private toolEvents: Promise<void> = Promise.resolve();
  readonly evaluatorHash: string;
  readonly environmentHash: string;
  readonly contractHash: string;
  private segmentOrdinal = 0;
  private cyclesInSegment = 0;
  private cycleDeadline = 0;
  /** Wall time since this mark has not yet been added to mission.spentWallMs. */
  private wallMark = Date.now();

  constructor(config: MissionConfig, paths: MissionPaths, options: ControllerOptions = {}) {
    this.config = config;
    this.paths = paths;
    ensureMissionDirs(paths);
    this.openLedger = options.ledger ?? (() => openLedger(config, paths));
    this.leaseTtlMs = options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
    this.leaseOwner =
      options.leaseOwner ?? `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
    this.artifacts = new ArtifactStore(paths.artifacts);
    this.evidence = new FileEvidenceStore(paths.evidence);
    this.log = options.log ?? (() => {});
    this.crashAt = options.crashAt;
    this.maxCycles = options.maxCycles ?? Number.POSITIVE_INFINITY;
    this.containerRuntime = options.containerRuntime;
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.evaluatorHash = computeEvaluatorHash();
    this.environmentHash = computeEnvironmentHash(config.isolation, config.containerImage);
    this.contractHash = contractHash(config);
    this.memory =
      options.memory ??
      (config.memory.enabled && process.env.SUPERMEMORY_API_KEY
        ? new SupermemoryAdapter(process.env.SUPERMEMORY_API_KEY)
        : new LocalMemoryAdapter());
    this.worker = options.worker ?? new ScriptedWorker();
  }

  /** The mission ledger; opened on first use by `initialize()`, `run()` or `mission()`. */
  get ledger(): AsyncLedger {
    if (!this.ledgerHandle)
      throw new Error(`mission ${this.config.missionId} ledger not open; call open() first`);
    return this.ledgerHandle;
  }

  /** Selects and connects the ledger backend (SQLite file or MongoDB). Idempotent. */
  async open(): Promise<AsyncLedger> {
    if (this.ledgerHandle) return this.ledgerHandle;
    this.opening ??= this.openLedger().then((ledger) => {
      this.ledgerHandle = ledger;
      this.outboxHandle = new MemoryOutbox(
        ledger,
        this.memory,
        this.config.memory.containerTag,
        (id) => this.episodePayload(id),
        () => this.spendMemoryOperation(),
      );
      return ledger;
    });
    try {
      return await this.opening;
    } finally {
      this.opening = undefined;
    }
  }

  private get outbox(): MemoryOutbox {
    if (!this.outboxHandle) throw new Error("ledger not open");
    return this.outboxHandle;
  }

  /** Lease currently held by this controller's run, if any. */
  get lease(): LeaseRow | undefined {
    return this.leaseRow;
  }

  async close(): Promise<void> {
    this.stopHeartbeat();
    const ledger = this.ledgerHandle;
    this.ledgerHandle = undefined;
    this.outboxHandle = undefined;
    if (ledger) await ledger.close();
  }

  /** Runs `fn` in one ledger transaction after pending tool-call events are durable. */
  private async transaction<T>(fn: (tx: AsyncLedger) => Promise<T>): Promise<T> {
    await this.flushToolEvents();
    return this.ledger.transaction(fn);
  }

  private async flushToolEvents(): Promise<void> {
    await this.toolEvents;
  }

  /** `horizon mission create`: freeze identities, import the seed, write the manifest. Idempotent. */
  async initialize(): Promise<MissionRow> {
    const ledger = await this.open();
    const existing = await ledger.getMission(this.config.missionId);
    if (existing) return existing;
    const seed = this.artifacts.importSeed();
    await ledger.transaction(async (tx) => {
      await tx.createMission({
        missionId: this.config.missionId,
        contractVersion: this.config.contractVersion,
        contractHash: this.contractHash,
        evaluatorHash: this.evaluatorHash,
        environmentHash: this.environmentHash,
        status: "ready",
        seedArtifactHash: seed.hash,
        baselineP95Ms: null,
        frozenAcceptanceMargin: null,
        bestArtifactHash: seed.hash,
        bestP95Ms: null,
        activeTaskId: null,
        nextWakeAt: null,
      });
      await tx.insertArtifact({
        hash: seed.hash,
        path: seed.path,
        parentHash: null,
        manifestHash: sha256(canonicalJson(seed.manifest)),
        createdAt: new Date().toISOString(),
      });
      for (const task of TASKS)
        await tx.upsertTask({ ...task, missionId: this.config.missionId, status: "pending" });
      await tx.appendEvent(
        `mission:${this.config.missionId}:created`,
        "mission.created",
        this.config.missionId,
        {
          contractHash: this.contractHash,
          evaluatorHash: this.evaluatorHash,
          environmentHash: this.environmentHash,
          seed: seed.hash,
          ledgerBackend: ledger.backend,
        },
      );
    });
    writeJsonAtomic(this.paths.manifest, {
      missionId: this.config.missionId,
      contractHash: this.contractHash,
      evaluatorHash: this.evaluatorHash,
      environmentHash: this.environmentHash,
      seedArtifactHash: seed.hash,
      ledgerBackend: ledger.backend,
      config: { ...this.config, ledger: { backend: ledger.backend } },
    });
    this.artifacts.restoreWorkspace(seed.hash, this.paths.candidate);
    return this.mission();
  }

  /** Ledger-backed registry: container names are durable before `docker run` and closed after stop. */
  containerRegistry(experimentId: string): ContainerRegistry {
    const missionId = this.config.missionId;
    return {
      register: async (name) => {
        await this.transaction(async (tx) => {
          await tx.registerContainer(name, missionId, experimentId);
          await tx.appendEvent(`container:${name}:launched`, "container.launched", experimentId, {
            containerName: name,
          });
        });
      },
      release: (name) => this.ledger.releaseContainer(name),
    };
  }

  async mission(): Promise<MissionRow> {
    return this.missionOn(await this.open());
  }

  private async missionOn(ledger: AsyncLedger): Promise<MissionRow> {
    const row = await ledger.getMission(this.config.missionId);
    if (!row)
      throw new Error(
        `mission ${this.config.missionId} not initialized; run 'horizon mission create'`,
      );
    return row;
  }

  /**
   * Exactly one live writer per mission: claims the fenced lease (refusing while
   * another owner's lease is unexpired) and renews it on a heartbeat. Once a
   * newer fencing token exists every write from this controller is rejected by
   * the ledger, so a paused or partitioned controller cannot corrupt state.
   */
  private async claimLease(): Promise<void> {
    const ledger = this.ledger;
    this.leaseRow = await ledger.claimLease(
      this.config.missionId,
      this.leaseOwner,
      this.leaseTtlMs,
    );
    this.heartbeatError = undefined;
    this.log(
      `lease: ${this.leaseOwner} token ${this.leaseRow.fencingToken} (${ledger.backend} ledger)`,
    );
    const interval = Math.max(50, Math.floor(this.leaseTtlMs / 3));
    let renewing = false;
    this.heartbeat = setInterval(() => {
      if (renewing || !this.leaseRow) return;
      renewing = true;
      ledger
        .renewLease(this.leaseRow, this.leaseTtlMs)
        .then((renewed) => {
          if (this.leaseRow) this.leaseRow = renewed;
        })
        .catch((error: unknown) => {
          this.heartbeatError = error;
          this.log(
            `lease: renewal failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          if (error instanceof LeaseError) this.stopHeartbeat();
        })
        .finally(() => {
          renewing = false;
        });
    }, interval);
    this.heartbeat.unref();
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
  }

  private async releaseLease(): Promise<void> {
    this.stopHeartbeat();
    const lease = this.leaseRow;
    this.leaseRow = undefined;
    if (lease) await this.ledger.releaseLease(lease).catch(() => {});
  }

  /** Under container isolation every worker command runs in the sandbox, labelled with its experiment. */
  private execSandbox(experimentId: string): ExecSandbox | undefined {
    if (this.config.isolation !== "container") return undefined;
    return {
      image: this.config.containerImage,
      missionId: this.config.missionId,
      operationId: experimentId,
    };
  }

  /** `horizon run` / `horizon resume`: recover, then loop until done or out of budget. */
  async run(): Promise<MissionRow> {
    await this.open();
    await this.claimLease();
    try {
      if (this.config.isolation === "container") {
        // Fail before any work is scheduled; the sandbox is never silently replaced by the host.
        const sandbox = assertSandboxAvailable(this.config.containerImage);
        this.log(`sandbox: docker ${sandbox.serverVersion}, image ${sandbox.imageId.slice(0, 19)}`);
        const orphans = cleanupOrphanContainers(this.config.missionId);
        if (orphans.length > 0)
          this.log(`recovery: removed ${orphans.length} orphaned container(s) from a previous run`);
      }
      const recovery = await recover(
        this.ledger,
        this.artifacts,
        this.config.missionId,
        this.paths.reports,
        {
          evaluatorHash: this.evaluatorHash,
          environmentHash: this.environmentHash,
          contractHash: this.contractHash,
        },
        this.containerRuntime,
      );
      for (const action of recovery.actions) this.log(`recovery: ${action.kind} ${action.detail}`);
      this.segmentOrdinal = recovery.checkpoint?.segmentOrdinal ?? 0;
      await this.honourWakeTime();
      await this.ledger.updateMission(this.config.missionId, {
        status: "running",
        nextWakeAt: null,
      });
      await this.drainOutbox();

      let cycles = 0;
      let active = recovery.activeExperiment;
      while (cycles < this.maxCycles) {
        this.assertLeaseLive();
        const mission = await this.mission();
        const stop = this.stopReason(mission);
        if (stop) {
          await this.finish(stop);
          break;
        }
        const task = await this.nextTask();
        if (!task) {
          await this.finish("succeeded");
          break;
        }
        if (task.taskId === "baseline") {
          await this.runBaseline();
          continue;
        }
        if (task.taskId === "holdout") {
          await this.runHoldout();
          continue;
        }
        cycles += 1;
        if (active) {
          await this.evaluateExperiment(active, recovery);
          this.cyclesInSegment += 1;
          active = undefined;
        } else {
          const done = await this.runCycle(cycles, recovery);
          if (done === "exhausted") {
            await this.finish("blocked", "worker has no further hypotheses");
            break;
          }
          if (done === "blocked" || done === "waiting") break;
        }
      }
      await this.drainOutbox();
      await this.flushToolEvents();
      return await this.mission();
    } finally {
      await this.worker.closeSegment().catch(() => {});
      await this.flushToolEvents().catch(() => {});
      await this.releaseLease();
    }
  }

  /** A heartbeat that lost the lease means another controller owns the mission; stop before the next write. */
  private assertLeaseLive(): void {
    if (this.heartbeatError instanceof LeaseError) throw this.heartbeatError;
  }

  private stopReason(mission: MissionRow): MissionStatus | undefined {
    const b = this.config.budget;
    const wall = mission.spentWallMs + (Date.now() - this.wallMark);
    if (
      mission.spentExperiments >= b.maxExperiments ||
      wall >= b.maxWallMs ||
      mission.spentInputTokens >= b.maxInputTokens ||
      mission.spentOutputTokens >= b.maxOutputTokens
    )
      return "budget_exhausted";
    return undefined;
  }

  private async nextTask() {
    const tasks = await this.ledger.listTasks(this.config.missionId);
    const done = new Set(tasks.filter((t) => t.status === "done").map((t) => t.taskId));
    return tasks.find(
      (t) => t.status !== "done" && t.status !== "skipped" && t.dependsOn.every((d) => done.has(d)),
    );
  }

  /** A `waiting` mission persisted its retry time; sleep it off (unbilled) before touching the worker again. */
  private async honourWakeTime(): Promise<void> {
    const mission = await this.mission();
    if (mission.status !== "waiting" || !mission.nextWakeAt) return;
    const delay = Date.parse(mission.nextWakeAt) - Date.now();
    if (delay <= 0) return;
    this.log(`mission waiting until ${mission.nextWakeAt} (${Math.ceil(delay / 1000)}s)`);
    await this.sleep(delay);
    this.wallMark = Date.now();
  }

  /**
   * The worker itself is unavailable (not the candidate). A missing credential
   * blocks the mission; a rate limit parks it in `waiting` with `nextWakeAt` so
   * `resume` can honour the retry time. Any experiment opened for this cycle is
   * interrupted, exactly as after a crash.
   */
  private async parkOnWorkerFault(
    error: WorkerUnavailableError,
    experimentId: string | null,
  ): Promise<"blocked" | "waiting"> {
    if (experimentId)
      await this.transaction(async (tx) => {
        await tx.updateExperiment(experimentId, {
          status: "interrupted",
          verdict: `worker unavailable: ${error.message}`,
          finishedAt: new Date().toISOString(),
        });
        await tx.appendEvent(
          `${experimentId}:interrupted:worker`,
          "experiment.interrupted",
          experimentId,
          { previousStatus: "editing", reason: error.kind },
        );
      });
    if (error.kind !== "rate_limited") {
      await this.finish("blocked", error.message);
      return "blocked";
    }
    const nextWakeAt = new Date(Date.now() + (error.retryAfterMs ?? 0)).toISOString();
    await this.transaction(async (tx) => {
      await tx.updateMission(this.config.missionId, {
        status: "waiting",
        activeTaskId: null,
        nextWakeAt,
      });
      await tx.appendEvent(
        `mission:${this.config.missionId}:waiting:${Date.now()}`,
        "mission.waiting",
        this.config.missionId,
        { reason: error.message, nextWakeAt },
      );
      await this.checkpoint(tx, "waiting", "optimize-search", null, "waiting:provider");
    });
    this.log(`mission waiting: ${error.message}; resume at or after ${nextWakeAt}`);
    return "waiting";
  }

  private async finish(status: MissionStatus, detail = ""): Promise<void> {
    await this.transaction(async (tx) => {
      await tx.updateMission(this.config.missionId, { status, nextWakeAt: null });
      await tx.appendEvent(
        `mission:${this.config.missionId}:finish:${Date.now()}`,
        "mission.finished",
        this.config.missionId,
        { status, detail },
      );
      await this.checkpoint(tx, status, null, null, `finished:${status}`);
    });
    this.log(`mission ${status}${detail ? `: ${detail}` : ""}`);
  }

  private async runBaseline(): Promise<void> {
    const mission = await this.mission();
    const seed = mission.seedArtifactHash;
    if (!seed) throw new Error("mission has no seed artifact");
    const experimentId = `exp-baseline-${this.config.missionId}`;
    if (!(await this.ledger.getExperiment(experimentId))) {
      await this.ledger.insertExperiment({
        experimentId,
        missionId: this.config.missionId,
        taskId: "baseline",
        parentArtifactHash: seed,
        strategy: "baseline",
        hypothesis: "seed measurement",
        status: "snapshot_ready",
        attempt: 1,
        segmentOrdinal: this.segmentOrdinal,
      });
      await this.ledger.updateExperiment(experimentId, { candidateArtifactHash: seed });
    }
    await this.ledger.updateExperiment(experimentId, { status: "evaluating" });
    const reports = await this.runSuites(experimentId, seed, [
      "smoke",
      "correctness",
      "learned",
      "performance",
    ]);
    const perf = reports.find((r) => r.suite === "performance");
    const allPassed = reports.every((r) => r.status === "passed");
    if (!allPassed || !perf || perf.metrics.p95LatencyMs === undefined) {
      const infra = reports.find((r) => r.status === "infra_error" || r.status === "timeout");
      await this.ledger.updateExperiment(experimentId, {
        status: infra ? "inconclusive" : "rejected",
        verdict: infra
          ? `infra: ${infra.infraMessage ?? infra.status}`
          : "seed failed fixed suites",
        finishedAt: new Date().toISOString(),
      });
      await this.finish(
        "blocked",
        infra
          ? "baseline could not be measured (infrastructure)"
          : "seed does not satisfy the contract; fix the seed before optimizing",
      );
      throw new BaselineError("baseline not established");
    }
    const noise = repetitionSpread(perf.metrics.repetitionP95Ms);
    const floor = freezeAcceptanceMargin(
      this.config.acceptanceMargin,
      noise,
      this.config.maxRepetitionSpread ?? this.config.targetP95Reduction,
    );
    if (floor.kind === "repair") {
      await this.transaction(async (tx) => {
        await tx.updateExperiment(experimentId, {
          status: "inconclusive",
          verdict: `baseline p95 ${perf.metrics.p95LatencyMs}ms; ${floor.reason}`,
          finishedAt: new Date().toISOString(),
        });
        await tx.appendEvent(
          `target:${this.config.missionId}:noise-floor:${perf.reportId}`,
          "target.noise_floor_exceeded",
          this.config.missionId,
          {
            repetitionSpread: noise,
            acceptanceMargin: this.config.acceptanceMargin,
            maxRepetitionSpread: this.config.maxRepetitionSpread ?? this.config.targetP95Reduction,
            reportId: perf.reportId,
          },
        );
      });
      this.log(
        `baseline p95 ${perf.metrics.p95LatencyMs}ms; repetition spread ${(noise * 100).toFixed(1)}% too large to distinguish useful changes`,
      );
      await this.finish("blocked", floor.reason);
      throw new BaselineError("baseline noise exceeds the measurable range");
    }
    await this.transaction(async (tx) => {
      await tx.updateExperiment(experimentId, {
        status: "accepted",
        verdict: `baseline p95 ${perf.metrics.p95LatencyMs}ms`,
        finishedAt: new Date().toISOString(),
      });
      await tx.updateMission(this.config.missionId, {
        baselineP95Ms: perf.metrics.p95LatencyMs ?? null,
        frozenAcceptanceMargin: floor.acceptanceMargin,
        bestP95Ms: perf.metrics.p95LatencyMs ?? null,
        bestArtifactHash: seed,
      });
      await tx.upsertTask({ ...TASKS[0]!, missionId: this.config.missionId, status: "done" });
      await tx.appendEvent(
        `baseline:${this.config.missionId}`,
        "mission.baseline",
        this.config.missionId,
        { p95: perf.metrics.p95LatencyMs, reportId: perf.reportId },
      );
      await tx.appendEvent(
        `target:${this.config.missionId}:assessed`,
        "target.assessed",
        this.config.missionId,
        {
          repetitionSpread: noise,
          acceptanceMargin: this.config.acceptanceMargin,
          frozenAcceptanceMargin: floor.acceptanceMargin,
          marginRaised: floor.raised,
          targetP95Reduction: this.config.targetP95Reduction,
          marginCoversNoise: floor.acceptanceMargin >= noise,
        },
      );
      await this.checkpoint(tx, "running", "optimize-search", null, "baseline-complete");
    });
    this.log(
      `baseline p95 ${perf.metrics.p95LatencyMs}ms (target <= ${(perf.metrics.p95LatencyMs! * (1 - this.config.targetP95Reduction)).toFixed(2)}ms; repetition spread ${(noise * 100).toFixed(1)}%)`,
    );
    if (floor.raised)
      this.log(
        `  acceptance margin frozen at ${floor.acceptanceMargin} (configured ${this.config.acceptanceMargin} is below the measured repetition spread ${noise.toFixed(3)})`,
      );
    else this.log(`  acceptance margin frozen at ${floor.acceptanceMargin}`);
  }

  /** Margin frozen after the baseline measured its noise; the configured value before that. */
  private timingPolicy(mission: MissionRow): TimingPolicy {
    return {
      acceptanceMargin: mission.frozenAcceptanceMargin ?? this.config.acceptanceMargin,
      requiredImprovedRepetitions: this.config.requiredImprovedRepetitions,
    };
  }

  private async runHoldout(): Promise<void> {
    const mission = await this.mission();
    const best = mission.bestArtifactHash;
    if (!best) throw new Error("no best artifact");
    const experimentId = `exp-holdout-${this.config.missionId}-${best.slice(0, 12)}`;
    if (!(await this.ledger.getExperiment(experimentId))) {
      await this.ledger.insertExperiment({
        experimentId,
        missionId: this.config.missionId,
        taskId: "holdout",
        parentArtifactHash: best,
        strategy: "holdout",
        hypothesis: "best generalizes",
        status: "snapshot_ready",
        attempt: 1,
        segmentOrdinal: this.segmentOrdinal,
      });
      await this.ledger.updateExperiment(experimentId, { candidateArtifactHash: best });
    }
    await this.ledger.updateExperiment(experimentId, { status: "evaluating" });
    const [report] = await this.runSuites(experimentId, best, ["holdout"]);
    const passed = report?.status === "passed";
    await this.transaction(async (tx) => {
      await tx.updateExperiment(experimentId, {
        status: passed ? "accepted" : report?.status === "failed" ? "rejected" : "inconclusive",
        verdict: `holdout ${report?.status ?? "missing"}`,
        finishedAt: new Date().toISOString(),
      });
      await tx.upsertTask({
        ...TASKS[2]!,
        missionId: this.config.missionId,
        status: passed ? "done" : "pending",
      });
    });
    if (!passed)
      await this.finish("blocked", `holdout ${report?.status ?? "missing"} on best artifact`);
  }

  private async runCycle(
    cycle: number,
    recovery: RecoveryOutcome,
  ): Promise<"continue" | "exhausted" | "blocked" | "waiting"> {
    const mission = await this.mission();
    const parent = mission.bestArtifactHash ?? mission.seedArtifactHash!;
    try {
      await this.ensureSegment();
    } catch (error) {
      if (error instanceof WorkerUnavailableError) return this.parkOnWorkerFault(error, null);
      throw error;
    }

    const experimentId = `exp-${String(mission.spentExperiments + 1).padStart(4, "0")}-${randomUUID().slice(0, 8)}`;
    await this.transaction(async (tx) => {
      await tx.insertExperiment({
        experimentId,
        missionId: this.config.missionId,
        taskId: "optimize-search",
        parentArtifactHash: parent,
        strategy: this.worker.mode,
        hypothesis: "(pending worker)",
        status: "planned",
        attempt: 1,
        segmentOrdinal: this.segmentOrdinal,
      });
      await tx.updateMission(this.config.missionId, {
        activeTaskId: "optimize-search",
        spentExperiments: mission.spentExperiments + 1,
      });
      await tx.appendEvent(`${experimentId}:planned`, "experiment.planned", experimentId, {
        parent,
      });
      await this.checkpoint(tx, "running", "optimize-search", experimentId, "planned");
    });

    // Restore the workspace from the immutable parent so a crashed edit never leaks in.
    this.artifacts.restoreWorkspace(parent, this.paths.candidate);
    await this.ledger.updateExperiment(experimentId, { status: "editing" });
    await this.ledger.appendEvent(
      `${experimentId}:editing`,
      "experiment.editing",
      experimentId,
      {},
    );
    this.crash("editing");

    const stagnation = await this.stagnation();
    if (stagnation.stagnated) {
      await this.ledger.appendEvent(
        `${experimentId}:stagnation`,
        "stagnation.detected",
        experimentId,
        {
          count: stagnation.count,
          limit: this.config.stagnationLimit,
          triedHypotheses: stagnation.triedHypotheses,
        },
      );
      this.log(
        `  stagnation: ${stagnation.count} completed experiments without a valid improvement (limit ${this.config.stagnationLimit}); requiring a new mechanism or a profiling step`,
      );
    }
    const packet = await this.buildPacket(mission, experimentId, stagnation);
    this.cycleDeadline = Date.now() + this.config.budget.cycleTimeoutMs;
    const broker = new ToolBroker(
      this.paths.candidate,
      this.evidence,
      this.hooks(experimentId),
      () => this.cycleDeadline,
      this.execSandbox(experimentId),
    );
    const recoveryNote = recovery.actions.find((a) => a.kind === "interrupted_edit")?.detail;
    let result: WorkerCycleResult;
    try {
      result = await this.worker.runCycle({
        cycle,
        packet,
        broker,
        deadlineAt: this.cycleDeadline,
        ...(cycle === 1 && recoveryNote ? { recoveryNote } : {}),
      });
    } catch (error) {
      broker.terminateChildren();
      if (error instanceof WorkerUnavailableError)
        return this.parkOnWorkerFault(error, experimentId);
      throw error;
    }
    broker.terminateChildren();
    await this.flushToolEvents();
    await this.spendTokens(result.usage);
    const audit = auditClaim(result.claim, broker.verifications);
    const text = this.boundWorkerText(result);
    await this.ledger.appendEvent(`${experimentId}:claim-audit`, "claim.audited", experimentId, {
      claim: text.claim,
      observed: broker.verifications,
      ...audit,
    });
    if (!audit.supported) this.log(`  unsupported worker claim: ${audit.issues.join("; ")}`);
    if (result.hypothesis === "none" && result.whatChanged === "nothing") {
      await this.ledger.updateExperiment(experimentId, {
        status: "inconclusive",
        verdict: "worker exhausted",
        finishedAt: new Date().toISOString(),
      });
      return "exhausted";
    }
    if (
      stagnation.stagnated &&
      broker.profiles.length === 0 &&
      stagnation.triedHypotheses.includes(normalizeHypothesis(result.hypothesis))
    ) {
      await this.conclude(
        (await this.ledger.getExperiment(experimentId))!,
        "rejected",
        `stagnation: repeated an already-tried mechanism after ${stagnation.count} experiments without improvement and no profiling step`,
        [],
        {
          hypothesis: text.hypothesis,
          whatChanged: text.whatChanged,
          claim: text.claim,
          seededFixture: result.seededFixture,
          claimIssues: audit.issues,
        },
        mission,
      );
      return "continue";
    }

    const snapshot = this.artifacts.snapshot(this.paths.candidate, parent);
    await this.transaction(async (tx) => {
      if (!(await tx.getArtifact(snapshot.hash)))
        await tx.insertArtifact({
          hash: snapshot.hash,
          path: snapshot.path,
          parentHash: parent,
          manifestHash: sha256(canonicalJson(snapshot.manifest)),
          createdAt: new Date().toISOString(),
        });
      await tx.updateExperiment(experimentId, {
        status: "snapshot_ready",
        candidateArtifactHash: snapshot.hash,
      });
      await tx.appendEvent(`${experimentId}:snapshot`, "experiment.snapshot", experimentId, {
        hash: snapshot.hash,
        hypothesis: text.hypothesis,
        whatChanged: text.whatChanged,
        claim: text.claim,
        seededFixture: result.seededFixture,
        aborted: result.aborted,
        claimIssues: audit.issues,
      });
      await this.checkpoint(tx, "running", "optimize-search", experimentId, "snapshot_ready");
    });
    this.crash("snapshot_ready");
    const experiment = (await this.ledger.getExperiment(experimentId))!;
    await this.evaluateExperiment(experiment, recovery, {
      hypothesis: text.hypothesis,
      whatChanged: text.whatChanged,
      claim: text.claim,
      seededFixture: result.seededFixture,
      claimIssues: audit.issues,
    });
    this.cyclesInSegment += 1;
    return "continue";
  }

  private async evaluateExperiment(
    experiment: ExperimentRow,
    _recovery: RecoveryOutcome,
    narrative?: Story,
  ): Promise<Verdict> {
    const hash = experiment.candidateArtifactHash!;
    const mission = await this.mission();
    if (!this.artifacts.verify(hash)) throw new Error(`artifact ${hash} failed integrity check`);
    await this.ledger.updateExperiment(experiment.experimentId, { status: "evaluating" });
    await this.ledger.appendEvent(
      `${experiment.experimentId}:evaluating:${experiment.attempt}`,
      "experiment.evaluating",
      experiment.experimentId,
      { attempt: experiment.attempt },
    );

    const snapshotEvent = await this.ledger.findEvent(`${experiment.experimentId}:snapshot`);
    const story =
      narrative ??
      (snapshotEvent
        ? (snapshotEvent.payload as Story)
        : {
            hypothesis: experiment.hypothesis,
            whatChanged: "(recovered)",
            claim: "(recovered)",
            seededFixture: null,
          });

    if (hash === experiment.parentArtifactHash) {
      return this.conclude(
        experiment,
        "inconclusive",
        "candidate identical to parent",
        [],
        story,
        mission,
      );
    }
    // Correctness gates performance: a failing candidate is never timed.
    const gate = await this.runSuites(experiment.experimentId, hash, [
      "smoke",
      "correctness",
      "learned",
    ]);
    this.crash("after-gate");
    const infra = gate.find((r) => r.status === "infra_error" || r.status === "timeout");
    if (infra)
      return this.conclude(
        experiment,
        "inconclusive",
        `infrastructure: ${infra.infraMessage ?? infra.status} (not a product failure)`,
        gate,
        story,
        mission,
      );
    const failing = gate.filter((r) => r.status === "failed");
    if (failing.length > 0) {
      const signature = sha256(
        canonicalJson(
          failing.flatMap((r) => r.assertions.filter((a) => !a.passed).map((a) => a.id)),
        ),
      ).slice(0, 16);
      await this.observeLesson(experiment, failing);
      return this.conclude(
        experiment,
        "rejected",
        `correctness failed: ${failing.flatMap((r) => r.assertions.filter((a) => !a.passed).map((a) => a.id)).join(", ")}`,
        gate,
        story,
        mission,
        signature,
      );
    }
    const [perf] = await this.runSuites(experiment.experimentId, hash, ["performance"]);
    if (!perf || perf.status !== "passed") {
      const kind = perf?.status === "failed" ? "rejected" : "inconclusive";
      return this.conclude(
        experiment,
        kind,
        `performance ${perf?.status ?? "missing"}: ${
          perf?.infraMessage ??
          perf?.assertions
            .filter((a) => !a.passed)
            .map((a) => a.id)
            .join(", ") ??
          ""
        }`,
        [...gate, ...(perf ? [perf] : [])],
        story,
        mission,
      );
    }
    const reports = [...gate, perf];
    const bestReps = (await this.bestPerformanceReport(mission))?.metrics.repetitionP95Ms ?? [];
    let decision: TimingDecision = firstComparison(
      perf.metrics,
      mission.bestP95Ms,
      bestReps,
      this.timingPolicy(mission),
    );
    let accepted = perf;
    if (decision.kind === "ambiguous") {
      this.log(
        `  timing ambiguous (${decision.reason}); re-measuring best and candidate back-to-back`,
      );
      const rerun = await this.retime(experiment.experimentId, hash, mission, perf, bestReps);
      reports.push(...rerun.reports);
      decision = rerun.decision;
      if (rerun.candidate) accepted = rerun.candidate;
    }
    if (decision.kind !== "accept")
      return this.conclude(
        experiment,
        decision.kind === "reject" ? "rejected" : "inconclusive",
        decision.reason,
        reports,
        story,
        mission,
      );
    const p95 = accepted.metrics.p95LatencyMs ?? null;
    await this.transaction(async (tx) => {
      await tx.updateMission(this.config.missionId, { bestArtifactHash: hash, bestP95Ms: p95 });
      await tx.appendEvent(`${experiment.experimentId}:accepted`, "artifact.accepted", hash, {
        p95,
        previous: mission.bestP95Ms,
        reportId: accepted.reportId,
      });
    });
    const verdict = await this.conclude(
      experiment,
      "accepted",
      decision.reason,
      reports,
      story,
      await this.mission(),
    );
    const target =
      (mission.baselineP95Ms ?? Number.POSITIVE_INFINITY) * (1 - this.config.targetP95Reduction);
    if ((p95 ?? Number.POSITIVE_INFINITY) <= target) {
      await this.ledger.upsertTask({
        ...TASKS[1]!,
        missionId: this.config.missionId,
        status: "done",
      });
      this.log(`target reached: p95 ${p95}ms <= ${target.toFixed(2)}ms`);
    }
    return verdict;
  }

  /** One bounded re-measurement: best then candidate, back-to-back, under their own report identities. */
  private async retime(
    experimentId: string,
    hash: string,
    mission: MissionRow,
    first: VerificationReport,
    firstBestReps: number[],
  ): Promise<{
    reports: VerificationReport[];
    decision: TimingDecision;
    candidate?: VerificationReport;
  }> {
    const best = mission.bestArtifactHash;
    if (!best)
      return {
        reports: [],
        decision: {
          kind: "inconclusive",
          reason: "timing ambiguous and no best artifact to re-measure",
        },
      };
    const bestReport = await this.verifyArtifact(
      `${experimentId}-retime-best`,
      best,
      "performance",
    );
    const candidate = await this.verifyArtifact(`${experimentId}-retime`, hash, "performance");
    const reports = [bestReport, candidate];
    if (bestReport.status !== "passed" || candidate.status !== "passed") {
      return {
        reports,
        decision: {
          kind: "inconclusive",
          reason: `timing rerun could not be measured (best ${bestReport.status}, candidate ${candidate.status})`,
        },
      };
    }
    return {
      reports,
      decision: rerunComparison(
        first.metrics,
        firstBestReps,
        candidate.metrics,
        bestReport.metrics,
        this.timingPolicy(mission),
      ),
      candidate,
    };
  }

  private async bestPerformanceReport(
    mission: MissionRow,
  ): Promise<VerificationReport | undefined> {
    const row = (await this.ledger.listVerifications(this.config.missionId))
      .filter(
        (v) =>
          v.suite === "performance" &&
          v.status === "passed" &&
          v.artifactHash === mission.bestArtifactHash,
      )
      .at(-1);
    if (!row || !existsSync(row.path)) return undefined;
    return JSON.parse(readFileSync(row.path, "utf8")) as VerificationReport;
  }

  private async conclude(
    experiment: ExperimentRow,
    verdict: Verdict,
    reason: string,
    reports: VerificationReport[],
    story: Story,
    mission: MissionRow,
    failureSignature: string | null = null,
  ): Promise<Verdict> {
    const perf = reports.find((r) => r.suite === "performance");
    const episodeId = `ep-${experiment.experimentId}-v1`;
    const payload: EpisodePayload = {
      episodeId,
      missionId: this.config.missionId,
      contractVersion: this.config.contractVersion,
      version: 1,
      supersedes: null,
      experimentId: experiment.experimentId,
      taskId: experiment.taskId,
      hypothesis: story.hypothesis,
      featureIds: this.featuresFor(reports),
      invariantIds: [
        ...new Set(
          reports.flatMap((r) =>
            r.assertions.filter((a) => !a.passed).flatMap((a) => a.invariantIds ?? []),
          ),
        ),
      ],
      parentArtifactHash: experiment.parentArtifactHash,
      artifactHash: experiment.candidateArtifactHash ?? "",
      whatChanged: story.whatChanged,
      correctness:
        reports
          .filter((r) => r.suite !== "performance")
          .map((r) => `${r.suite}=${r.status}`)
          .join(", ") || "not run",
      performance: perf
        ? `p95 ${perf.metrics.p95LatencyMs ?? "n/a"}ms (${perf.status}); best before ${mission.bestP95Ms ?? "n/a"}ms; baseline ${mission.baselineP95Ms ?? "n/a"}ms`
        : "not run",
      outcome: `${verdict}: ${reason}`,
      uncertainty: `${story.seededFixture ? `seeded fault-injection fixture: ${story.seededFixture}; worker claim "${story.claim}" is not evidence` : `worker claim "${story.claim}" is model interpretation; verifier reports are the evidence`}${story.claimIssues && story.claimIssues.length > 0 ? `; claim disagrees with verifier: ${story.claimIssues.join("; ")}` : ""}`,
      reportIds: reports.map((r) => r.reportId),
      evidenceIds: reports.flatMap((r) => r.evidenceIds).slice(0, 24),
      nextAction: this.nextActionAfter(verdict, reason, mission),
      interpretation: "verified",
      seededFixture: story.seededFixture,
    };
    await this.transaction(async (tx) => {
      await tx.updateExperiment(experiment.experimentId, {
        status: verdict,
        verdict: reason,
        reportIds: reports.map((r) => r.reportId),
        failureSignature,
        finishedAt: new Date().toISOString(),
        hypothesis: story.hypothesis,
      });
      await tx.insertEpisode({
        episodeId,
        missionId: this.config.missionId,
        experimentId: experiment.experimentId,
        version: 1,
        supersedes: null,
        featureIds: payload.featureIds,
        invariantIds: payload.invariantIds,
        artifactHash: payload.artifactHash,
        parentArtifactHash: payload.parentArtifactHash,
        interpretation: "verified",
        evidenceIds: payload.evidenceIds,
        summary: renderEpisode(payload),
        createdAt: new Date().toISOString(),
      });
      await this.outbox.enqueue(payload, tx);
      await tx.appendEvent(
        `${experiment.experimentId}:concluded`,
        "experiment.concluded",
        experiment.experimentId,
        { verdict, reason },
      );
      await tx.updateMission(this.config.missionId, { activeTaskId: null });
      await this.checkpoint(tx, "running", "optimize-search", null, "concluded");
    });
    this.crash("concluded");
    this.log(
      `${experiment.experimentId} ${verdict}: ${reason}${story.seededFixture ? ` [seeded fixture ${story.seededFixture}]` : ""}`,
    );
    await this.drainOutbox();
    return verdict;
  }

  private nextActionAfter(verdict: Verdict, reason: string, mission: MissionRow): string {
    if (verdict === "accepted")
      return "profile the new best artifact and look for the next bottleneck";
    if (reason.startsWith("stagnation"))
      return "profile the current best artifact before editing, or try a mechanism not yet attempted";
    if (verdict === "inconclusive" && reason.includes("timing"))
      return "the timing difference was within measurement noise; look for a mechanism with a larger effect or profile to confirm the bottleneck";
    if (verdict === "inconclusive")
      return "retry the same change; the failure was infrastructure, not product";
    if (reason.startsWith("correctness"))
      return "read the failing assertion evidence, then restore invalidation before optimizing again";
    if (mission.bestP95Ms !== null)
      return "the change did not beat the current best by the margin; try a different mechanism";
    return "review evidence";
  }

  private featuresFor(reports: VerificationReport[]): string[] {
    const features = JSON.parse(readFileSync(join(RESOURCES_DIR, "features.json"), "utf8")) as {
      features: { id: string; invariants: string[] }[];
    };
    const touched = new Set(
      reports.flatMap((r) => r.assertions.flatMap((a) => a.invariantIds ?? [])),
    );
    return features.features
      .filter((f) => f.invariants.some((i) => touched.has(i)))
      .map((f) => f.id);
  }

  private async runSuites(
    experimentId: string,
    hash: string,
    suites: Suite[],
  ): Promise<VerificationReport[]> {
    const reports: VerificationReport[] = [];
    for (const suite of suites) {
      reports.push(await this.verifyArtifact(experimentId, hash, suite));
      if (reports.at(-1)!.status !== "passed") break;
    }
    return reports;
  }

  /** Runs one suite, validates identities, publishes the report atomically, records it. Reuses a committed report for the same identity. */
  async verifyArtifact(
    experimentId: string,
    hash: string,
    suite: Suite,
  ): Promise<VerificationReport> {
    const existing = await this.ledger.findVerification(experimentId, hash, suite);
    if (existing && existsSync(existing.path)) {
      const parsed = JSON.parse(readFileSync(existing.path, "utf8")) as VerificationReport;
      if (parsed.status === "passed" || parsed.status === "failed") return parsed;
    }
    const prior = REUSABLE_FAILURE_SUITES.has(suite)
      ? await this.priorFailure(hash, suite)
      : undefined;
    if (prior) {
      await this.ledger.appendEvent(
        `reuse:${experimentId}:${suite}:${prior.reportId}`,
        "verification.reused",
        experimentId,
        { suite, hash, reportId: prior.reportId, fromExperiment: prior.experimentId },
      );
      this.log(
        `  ${suite}: ${prior.status} (identical artifact ${hash.slice(0, 12)} already failed in ${prior.experimentId}; report ${prior.reportId} reused)`,
      );
      return prior;
    }
    const artifact = this.artifacts.pathFor(hash);
    if (!this.artifacts.verify(hash)) throw new Error(`artifact ${hash} does not verify`);
    const mission = await this.mission();
    const report = await runSuite(
      {
        missionId: this.config.missionId,
        experimentId,
        artifactHash: hash,
        evaluatorHash: this.evaluatorHash,
        environmentHash: this.environmentHash,
        snapshotDir: artifact,
        isolation: this.config.isolation,
        containerImage: this.config.containerImage,
        startupTimeoutMs: this.config.startupTimeoutMs,
        requestTimeoutMs: this.config.requestTimeoutMs,
        memoryLimitBytes: this.config.memoryLimitBytes,
        workload: this.config.workload,
        holdoutWorkload: this.config.holdoutWorkload,
        learnedScenariosDir: this.paths.learnedScenarios,
        learnedSuiteVersion: mission.learnedSuiteVersion,
        evidence: this.evidence,
        containerRegistry: this.containerRegistry(experimentId),
      },
      suite,
    );
    const check = validateReport(report, {
      missionId: this.config.missionId,
      experimentId,
      suite,
      artifactHash: hash,
      evaluatorHash: this.evaluatorHash,
      workloadHash: report.workloadHash,
      environmentHash: this.environmentHash,
    });
    if (!check.ok) throw new Error(`runner produced an invalid report: ${check.reason}`);
    const dir = join(this.paths.reports, experimentId);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${suite}-${report.reportId}.json`);
    writeJsonAtomic(path, report);
    if ((await this.ledger.getExperiment(experimentId))?.status === "evaluating")
      this.crash(
        `report-written:${experimentId.startsWith("exp-0") ? "optimize" : "fixed"}:${suite}`,
      );
    await this.transaction(async (tx) => {
      await tx.insertVerification(report, path);
      await tx.appendEvent(`report:${report.reportId}`, "verification.recorded", experimentId, {
        suite,
        status: report.status,
        hash,
        p95: report.metrics.p95LatencyMs ?? null,
        isolation: report.isolation,
      });
    });
    this.log(
      `  ${suite}: ${report.status}${report.metrics.p95LatencyMs !== undefined ? ` p95=${report.metrics.p95LatencyMs}ms` : ""}${report.infraMessage ? ` (${report.infraMessage})` : ""}`,
    );
    return report;
  }

  /** A committed failed report for the same content, suite, evaluator and environment from any experiment of this mission. */
  private async priorFailure(hash: string, suite: Suite): Promise<VerificationReport | undefined> {
    const row = (await this.ledger.listVerifications(this.config.missionId)).find(
      (v) =>
        v.artifactHash === hash &&
        v.suite === suite &&
        v.status === "failed" &&
        v.evaluatorHash === this.evaluatorHash &&
        v.environmentHash === this.environmentHash,
    );
    if (!row || !existsSync(row.path)) return undefined;
    return JSON.parse(readFileSync(row.path, "utf8")) as VerificationReport;
  }

  private async observeLesson(
    experiment: ExperimentRow,
    failing: VerificationReport[],
  ): Promise<void> {
    for (const report of failing) {
      for (const assertion of report.assertions.filter((a) => !a.passed)) {
        for (const invariantId of assertion.invariantIds ?? []) {
          const lessonId = `lesson-${invariantId.toLowerCase()}`;
          const current = (await this.ledger.listLessons(this.config.missionId)).find(
            (l) => l.lessonId === lessonId,
          );
          if (current && current.state !== "observed") continue;
          const episodeId = `ep-${experiment.experimentId}-v1`;
          const state: LessonState = current ? "reproduced" : "observed";
          await this.ledger.upsertLesson({
            lessonId,
            missionId: this.config.missionId,
            sourceEpisodeIds: [...new Set([...(current?.sourceEpisodeIds ?? []), episodeId])],
            invariantId,
            state,
            proposal: current?.proposal ?? "",
            positiveEvidenceId: null,
            negativeEvidenceId: assertion.evidenceId,
            materializedScenarioId: null,
            transitions: [
              ...(current?.transitions ?? []),
              { state, at: new Date().toISOString(), evidenceId: assertion.evidenceId },
            ],
          });
        }
      }
    }
  }

  private async handleProposal(
    experimentId: string,
    proposal: RegressionProposal,
  ): Promise<{ accepted: boolean; reason: string; lessonId?: string }> {
    const mission = await this.mission();
    const existingIds = new Set([
      ...loadScenarios().map((s) => s.scenarioId),
      ...(await this.ledger.listLearnedScenarios(this.config.missionId)).map((s) => s.scenarioId),
    ]);
    const shape = validateProposalShape(proposal, existingIds);
    const lessonId = `lesson-${proposal.invariantId.toLowerCase()}`;
    const current = (await this.ledger.listLessons(this.config.missionId)).find(
      (l) => l.lessonId === lessonId,
    );
    const transition = async (
      state: LessonState,
      evidenceId: string | null,
      patch: Partial<LessonRow> = {},
      ledger: AsyncLedger = this.ledger,
    ) => {
      const base = (await ledger.listLessons(this.config.missionId)).find(
        (l) => l.lessonId === lessonId,
      );
      await ledger.upsertLesson({
        lessonId,
        missionId: this.config.missionId,
        sourceEpisodeIds: base?.sourceEpisodeIds ?? [],
        invariantId: proposal.invariantId,
        state,
        proposal: JSON.stringify(proposal),
        positiveEvidenceId: base?.positiveEvidenceId ?? null,
        negativeEvidenceId: base?.negativeEvidenceId ?? null,
        materializedScenarioId: base?.materializedScenarioId ?? null,
        transitions: [
          ...(base?.transitions ?? []),
          { state, at: new Date().toISOString(), evidenceId },
        ],
        ...patch,
      });
    };
    if (!shape.ok) {
      await transition("rejected", null);
      return { accepted: false, reason: shape.reason, lessonId };
    }
    if (current?.state === "materialized")
      return {
        accepted: false,
        reason: "invariant already has a materialized regression",
        lessonId,
      };
    await transition("proposed", null);

    const seed = mission.seedArtifactHash!;
    const { artifact: negative } = this.artifacts.importFixture("stale-cache", seed);
    const runLearned = (snapshotDir: string, artifactHash: string, scenarioDir: string) =>
      runSuite(
        {
          missionId: this.config.missionId,
          experimentId: `lesson-${lessonId}-${experimentId}`,
          artifactHash,
          evaluatorHash: this.evaluatorHash,
          environmentHash: this.environmentHash,
          snapshotDir,
          isolation: this.config.isolation,
          containerImage: this.config.containerImage,
          startupTimeoutMs: this.config.startupTimeoutMs,
          requestTimeoutMs: this.config.requestTimeoutMs,
          memoryLimitBytes: this.config.memoryLimitBytes,
          workload: this.config.workload,
          holdoutWorkload: this.config.holdoutWorkload,
          learnedScenariosDir: scenarioDir,
          evidence: this.evidence,
          containerRegistry: this.containerRegistry(`lesson-${lessonId}-${experimentId}`),
        },
        "learned",
      );
    const validation = await validateAgainstFixtures(
      shape.scenario,
      { runLearned },
      { snapshotDir: negative.path, artifactHash: negative.hash },
      { snapshotDir: this.artifacts.pathFor(seed), artifactHash: seed },
    );
    const negativeEvidence = this.evidence.write("lesson-negative", validation.negativeReport);
    const positiveEvidence = this.evidence.write("lesson-positive", validation.positiveReport);
    if (!validation.accepted) {
      await transition("rejected", negativeEvidence, {
        negativeEvidenceId: negativeEvidence,
        positiveEvidenceId: positiveEvidence,
      });
      return { accepted: false, reason: validation.reason, lessonId };
    }
    await transition("validated", positiveEvidence, {
      negativeEvidenceId: negativeEvidence,
      positiveEvidenceId: positiveEvidence,
    });
    if (!this.config.memory.materializeCorrections)
      return { accepted: true, reason: `${validation.reason}; materialization disabled`, lessonId };

    const scenario: Scenario = {
      ...shape.scenario,
      origin: {
        lessonId,
        episodeId: `ep-${experimentId}-v1`,
        reportId: validation.negativeReport.reportId,
        materializedAt: new Date().toISOString(),
      },
    };
    mkdirSync(this.paths.learnedScenarios, { recursive: true });
    const path = join(this.paths.learnedScenarios, `${scenario.scenarioId}.json`);
    writeJsonAtomic(path, scenario);
    await this.transaction(async (tx) => {
      const version = (await this.missionOn(tx)).learnedSuiteVersion + 1;
      await tx.insertLearnedScenario(
        scenario.scenarioId,
        this.config.missionId,
        lessonId,
        version,
        path,
      );
      await tx.updateMission(this.config.missionId, { learnedSuiteVersion: version });
      await transition(
        "materialized",
        positiveEvidence,
        { materializedScenarioId: scenario.scenarioId },
        tx,
      );
      await tx.appendEvent(`lesson:${lessonId}:materialized`, "lesson.materialized", lessonId, {
        scenarioId: scenario.scenarioId,
        version,
      });
    });
    this.log(`  lesson ${lessonId} materialized as learned scenario ${scenario.scenarioId}`);
    return { accepted: true, reason: validation.reason, lessonId };
  }

  /** Consecutive concluded optimize-search experiments since the last accepted one; none of them improved the best. */
  async stagnation(): Promise<StagnationState> {
    const concluded = (await this.ledger.listExperiments(this.config.missionId)).filter(
      (e) =>
        e.taskId === "optimize-search" &&
        (e.status === "accepted" || e.status === "rejected" || e.status === "inconclusive"),
    );
    const run: ExperimentRow[] = [];
    for (let i = concluded.length - 1; i >= 0; i -= 1) {
      const e = concluded[i]!;
      if (e.status === "accepted") break;
      run.unshift(e);
    }
    return {
      count: run.length,
      triedHypotheses: [...new Set(run.map((e) => normalizeHypothesis(e.hypothesis)))],
      stagnated: run.length >= this.config.stagnationLimit,
    };
  }

  /** Cycle-start retrieval query composed from the active task, its hypothesis, and the last finished experiment's features, invariants and verdict. */
  private async retrievalQuery(
    experiments: ExperimentRow[],
    experimentId: string,
  ): Promise<string> {
    const task = (await this.ledger.listTasks(this.config.missionId)).find(
      (t) => t.taskId === "optimize-search",
    );
    const last = experiments
      .filter((e) => e.experimentId !== experimentId && e.verdict !== null)
      .at(-1);
    const episode = last ? await this.ledger.getEpisode(`ep-${last.experimentId}-v1`) : undefined;
    return composeRetrievalQuery({
      taskId: "optimize-search",
      hypothesis: last?.hypothesis ?? task?.hypothesis ?? null,
      featureIds: episode?.featureIds ?? [],
      invariantIds: episode?.invariantIds ?? [],
      lastVerdict: last?.verdict ?? null,
      lastFailureSignature: last?.failureSignature ?? null,
    });
  }

  private async buildPacket(
    mission: MissionRow,
    experimentId: string,
    stagnation: StagnationState,
  ): Promise<ContextPacket> {
    const experiments = (await this.ledger.listExperiments(this.config.missionId)).filter(
      (e) => e.taskId === "optimize-search",
    );
    // Bounded recent history: only this segment's experiments are replayed verbatim; older segments are reachable through retrieval.
    const recentRows = experiments
      .filter((e) => e.segmentOrdinal === this.segmentOrdinal)
      .slice(-3);
    const recentLines: string[] = [];
    for (const e of recentRows) {
      const episode = await this.ledger.getEpisode(`ep-${e.experimentId}-v1`);
      recentLines.push(
        episode ? episode.summary : `${e.experimentId}: ${e.status} ${e.verdict ?? ""}`,
      );
    }
    const recent = recentLines.join("\n\n");
    const features = readFileSync(join(RESOURCES_DIR, "features.json"), "utf8");
    const skill = readFileSync(join(RESOURCES_DIR, "skills/verify-search/SKILL.md"), "utf8");
    const query = await this.retrievalQuery(experiments, experimentId);
    const nextAction =
      (await this.ledger.listTasks(this.config.missionId)).find(
        (t) => t.taskId === "optimize-search",
      )?.nextAction ?? "";
    const retrieval = this.config.memory.enabled
      ? await retrieveEpisodes(
          this.memory,
          this.ledger,
          this.evidence,
          {
            missionId: this.config.missionId,
            containerTag: this.config.memory.containerTag,
            contractVersion: this.config.contractVersion,
          },
          query,
          10,
          5,
          () => this.spendMemoryOperation(),
        )
      : { injected: [], filteredOut: [], degraded: false };
    const lastVerdict = experiments.at(-1)?.verdict ?? "no experiments yet";
    const pinned = [
      `Mission ${mission.missionId} (contract v${mission.contractVersion}, hash ${mission.contractHash.slice(0, 12)}). Objective: ${this.config.objective}`,
      `Baseline p95 ${mission.baselineP95Ms ?? "unmeasured"}ms; current best ${mission.bestP95Ms ?? "n/a"}ms (artifact ${(mission.bestArtifactHash ?? "").slice(0, 12)}); target <= ${mission.baselineP95Ms !== null ? (mission.baselineP95Ms * (1 - this.config.targetP95Reduction)).toFixed(2) : "?"}ms; acceptance margin ${this.timingPolicy(mission).acceptanceMargin}.`,
      `Budget: experiments ${mission.spentExperiments}/${this.config.budget.maxExperiments}; tokens in ${mission.spentInputTokens}/${this.config.budget.maxInputTokens}, out ${mission.spentOutputTokens}/${this.config.budget.maxOutputTokens}; cycle limit ${this.config.budget.cycleTimeoutMs}ms.`,
      `Constraints: edits only under src/; mutations via DocumentService; contract invariants are fixed; the verifier is the only source of truth. Experiment ${experimentId}.`,
      retrieval.degraded
        ? "Memory service degraded: retrieved episodes come from the local cache."
        : null,
    ]
      .filter((l): l is string => l !== null)
      .join("\n");
    const packet = buildPacket(
      {
        pinned,
        featureMap: `${features}\n\n${skill}`,
        recent: recent || "No experiments yet.",
        retrieved: retrieval.injected.map((r) => ({ episodeId: r.episodeId, text: r.text })),
        next: `Last verdict: ${lastVerdict}\nNext action: ${nextAction}\n${
          stagnation.stagnated
            ? `Stagnation: ${stagnation.count} completed experiments without a valid improvement (limit ${this.config.stagnationLimit}). This cycle must call profile_candidate before editing or try a mechanism other than: ${stagnation.triedHypotheses.join(" | ")}. Repeating one of those without profiling is rejected without verification.\n`
            : ""
        }Filtered from retrieval: ${retrieval.filteredOut.map((f) => `${f.episodeId ?? "?"} (${f.reason})`).join("; ") || "none"}`,
      },
      DEFAULT_PACKET_BUDGET,
    );
    await this.ledger.appendEvent(`${experimentId}:packet`, "packet.built", experimentId, {
      query,
      tokens: packet.tokens,
      sections: packet.sections,
      injected: packet.injectedEpisodeIds,
      dropped: packet.droppedEpisodeIds,
      filteredOut: retrieval.filteredOut,
      degraded: retrieval.degraded,
    });
    return packet;
  }

  private hooks(experimentId: string): BrokerHooks {
    return {
      verify: async (suite) => {
        const snapshot = await this.snapshotCandidate();
        const report = await this.verifyArtifact(experimentId, snapshot.hash, suite);
        return {
          report,
          reportPath: join(this.paths.reports, experimentId, `${suite}-${report.reportId}.json`),
        };
      },
      profile: async (scenario) => {
        const snapshot = await this.snapshotCandidate();
        const report = await this.verifyArtifact(experimentId, snapshot.hash, "performance");
        const evidenceId = this.evidence.write("profile", {
          scenario,
          metrics: report.metrics,
          status: report.status,
          reportId: report.reportId,
        });
        return {
          evidenceId,
          summary: `${scenario}: ${report.status}; p95 ${report.metrics.p95LatencyMs ?? "n/a"}ms; per-repetition ${JSON.stringify(report.metrics.repetitionP95Ms ?? [])}`,
        };
      },
      recall: async (query, limit) => {
        const selection = await retrieveEpisodes(
          this.memory,
          this.ledger,
          this.evidence,
          {
            missionId: this.config.missionId,
            containerTag: this.config.memory.containerTag,
            contractVersion: this.config.contractVersion,
          },
          query,
          limit * 2,
          limit,
          () => this.spendMemoryOperation(),
        );
        const out = [];
        for (const r of selection.injected) {
          const row = await this.ledger.getEpisode(r.episodeId);
          out.push({
            episodeId: r.episodeId,
            summary: r.text,
            evidenceIds: row?.evidenceIds ?? [],
            artifactHash: row?.artifactHash ?? "",
          });
        }
        return out;
      },
      proposeRegression: (proposal) => this.handleProposal(experimentId, proposal),
      onToolEvent: (name, params, summary) => {
        const eventId = `${experimentId}:tool:${randomUUID()}`;
        this.toolEvents = this.toolEvents.then(async () => {
          await this.ledger.appendEvent(eventId, "tool.call", experimentId, {
            name,
            params,
            summary,
          });
        });
      },
    };
  }

  /** Snapshots the workspace as a child of the current best and records the artifact. */
  private async snapshotCandidate() {
    const best = (await this.mission()).bestArtifactHash;
    const snapshot = this.artifacts.snapshot(this.paths.candidate, best);
    if (!(await this.ledger.getArtifact(snapshot.hash)))
      await this.ledger.insertArtifact({
        hash: snapshot.hash,
        path: snapshot.path,
        parentHash: best,
        manifestHash: sha256(canonicalJson(snapshot.manifest)),
        createdAt: new Date().toISOString(),
      });
    return snapshot;
  }

  private async ensureSegment(): Promise<void> {
    const active = await this.ledger.activeSegment(this.config.missionId);
    const needsRotation =
      active !== undefined && this.cyclesInSegment >= this.config.segmentRotationCycles;
    if (
      active &&
      !needsRotation &&
      this.segmentOrdinal === active.ordinal &&
      this.cyclesInSegment > 0
    )
      return;
    const previous = active
      ? { sessionPath: active.sessionPath, sessionId: active.sessionId ?? "" }
      : null;
    if (active && !needsRotation) {
      await this.worker.openSegment(active.ordinal, previous);
      this.segmentOrdinal = active.ordinal;
      this.cyclesInSegment = 0;
      return;
    }
    const ordinal = (active?.ordinal ?? this.segmentOrdinal) + 1;
    // A new segment is a fresh bounded context; `previous` is only for resuming a committed segment.
    const handle = await this.worker.openSegment(ordinal, null);
    await this.transaction(async (tx) => {
      if (active) await tx.closeSegment(this.config.missionId, active.ordinal, null);
      await tx.openSegment(this.config.missionId, ordinal, handle.sessionPath, handle.sessionId);
      const checkpoint = await this.checkpoint(
        tx,
        "running",
        "optimize-search",
        null,
        `segment-open:${ordinal}`,
      );
      await tx.commitSegment(this.config.missionId, ordinal, checkpoint.checkpointId);
      await tx.appendEvent(`segment:${ordinal}:open`, "segment.opened", this.config.missionId, {
        ordinal,
        rotatedFrom: active?.ordinal ?? null,
      });
    });
    this.segmentOrdinal = ordinal;
    this.cyclesInSegment = 0;
    this.log(`segment ${ordinal} open${active ? ` (rotated from ${active.ordinal})` : ""}`);
  }

  private async checkpoint(
    tx: AsyncLedger,
    status: MissionStatus,
    taskId: string | null,
    experimentId: string | null,
    operation: string,
  ) {
    await this.accrueWall(tx);
    const mission = await this.missionOn(tx);
    return tx.writeCheckpoint({
      missionId: this.config.missionId,
      missionStatus: status,
      activeTaskId: taskId,
      activeExperimentId: experimentId,
      activeOperation: operation,
      segmentOrdinal: this.segmentOrdinal,
      bestArtifactHash: mission.bestArtifactHash,
    });
  }

  private boundWorkerText(result: WorkerCycleResult): {
    hypothesis: string;
    whatChanged: string;
    claim: string;
  } {
    const fields = {
      hypothesis: result.hypothesis,
      whatChanged: result.whatChanged,
      claim: result.claim,
    };
    const oversized = (Object.keys(fields) as (keyof typeof fields)[]).filter(
      (k) => fields[k].length > WORKER_TEXT_LIMITS[k],
    );
    if (oversized.length === 0) return fields;
    const evidenceId = this.evidence.write("worker-output", fields);
    this.log(
      `  worker output oversized (${oversized.join(", ")}); full text kept as ${evidenceId}`,
    );
    for (const k of oversized)
      fields[k] =
        `${fields[k].slice(0, WORKER_TEXT_LIMITS[k])} [truncated; full text in ${evidenceId}]`;
    return fields;
  }

  private async accrueWall(tx: AsyncLedger): Promise<void> {
    const now = Date.now();
    const mission = await this.missionOn(tx);
    await tx.updateMission(this.config.missionId, {
      spentWallMs: mission.spentWallMs + (now - this.wallMark),
    });
    this.wallMark = now;
  }

  private async spendTokens(usage: {
    inputTokens: number;
    outputTokens: number;
    uncertain: boolean;
  }): Promise<void> {
    const mission = await this.mission();
    await this.ledger.updateMission(this.config.missionId, {
      spentInputTokens: mission.spentInputTokens + usage.inputTokens,
      spentOutputTokens: mission.spentOutputTokens + usage.outputTokens,
      usageUncertain: usage.uncertain ? 1 : mission.usageUncertain,
    });
  }

  private async spendMemoryOperation(): Promise<void> {
    const mission = await this.mission();
    if (mission.spentMemoryOperations >= this.config.budget.maxMemoryOperations)
      throw new Error("memory operation budget exhausted");
    await this.ledger.updateMission(this.config.missionId, {
      spentMemoryOperations: mission.spentMemoryOperations + 1,
    });
  }

  private async episodePayload(episodeId: string): Promise<EpisodePayload | undefined> {
    return (await this.ledger.outboxPayloadForEpisode(episodeId)) as EpisodePayload | undefined;
  }

  async drainOutbox(): Promise<void> {
    if (!this.config.memory.enabled) return;
    try {
      const result = await this.outbox.drain();
      if (result.degraded)
        this.log(`memory delivery degraded (${result.failed} failed, will retry)`);
    } catch (error) {
      this.log(
        `memory delivery skipped: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private crash(point: string): void {
    if (this.crashAt === point) throw new SimulatedCrash(point);
  }
}

export class SimulatedCrash extends Error {
  constructor(point: string) {
    super(`simulated crash at ${point}`);
  }
}

export class BaselineError extends Error {}
