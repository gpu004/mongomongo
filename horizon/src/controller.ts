import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
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
  Ledger,
  type LessonRow,
  type LessonState,
  type MissionRow,
  type MissionStatus,
} from "./ledger.ts";
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
import { MemoryOutbox, retrieveEpisodes } from "./memory-outbox.ts";
import { contractHash, type MissionConfig } from "./mission-contract.ts";
import {
  ensureMissionDirs,
  FileEvidenceStore,
  type MissionPaths,
  writeJsonAtomic,
} from "./mission-paths.ts";
import { type ContainerRuntime, recover, type RecoveryOutcome } from "./recovery.ts";
import { ScriptedWorker } from "./scripted-worker.ts";
import { type BrokerHooks, ToolBroker } from "./tool-broker.ts";
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
}

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
  readonly ledger: Ledger;
  readonly artifacts: ArtifactStore;
  readonly evidence: FileEvidenceStore;
  readonly memory: MemoryAdapter;
  readonly worker: Worker;
  private readonly outbox: MemoryOutbox;
  private readonly log: (line: string) => void;
  private readonly crashAt: string | undefined;
  private readonly maxCycles: number;
  private readonly containerRuntime: ContainerRuntime | undefined;
  private readonly sleep: (ms: number) => Promise<void>;
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
    this.ledger = new Ledger(paths.db);
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
    this.outbox = new MemoryOutbox(
      this.ledger,
      this.memory,
      config.memory.containerTag,
      (id) => this.episodePayload(id),
      () => this.spendMemoryOperation(),
    );
  }

  close(): void {
    this.ledger.close();
  }

  // ---- mission lifecycle ----------------------------------------------------

  /** `horizon mission create`: freeze identities, import the seed, write the manifest. Idempotent. */
  initialize(): MissionRow {
    const existing = this.ledger.getMission(this.config.missionId);
    if (existing) return existing;
    const seed = this.artifacts.importSeed();
    this.ledger.transaction(() => {
      this.ledger.createMission({
        missionId: this.config.missionId,
        contractVersion: this.config.contractVersion,
        contractHash: this.contractHash,
        evaluatorHash: this.evaluatorHash,
        environmentHash: this.environmentHash,
        status: "ready",
        seedArtifactHash: seed.hash,
        baselineP95Ms: null,
        bestArtifactHash: seed.hash,
        bestP95Ms: null,
        activeTaskId: null,
        nextWakeAt: null,
      });
      this.ledger.insertArtifact({
        hash: seed.hash,
        path: seed.path,
        parentHash: null,
        manifestHash: sha256(canonicalJson(seed.manifest)),
        createdAt: new Date().toISOString(),
      });
      for (const task of TASKS)
        this.ledger.upsertTask({ ...task, missionId: this.config.missionId, status: "pending" });
      this.ledger.appendEvent(
        `mission:${this.config.missionId}:created`,
        "mission.created",
        this.config.missionId,
        {
          contractHash: this.contractHash,
          evaluatorHash: this.evaluatorHash,
          environmentHash: this.environmentHash,
          seed: seed.hash,
        },
      );
    });
    writeJsonAtomic(this.paths.manifest, {
      missionId: this.config.missionId,
      contractHash: this.contractHash,
      evaluatorHash: this.evaluatorHash,
      environmentHash: this.environmentHash,
      seedArtifactHash: seed.hash,
      config: this.config,
    });
    this.artifacts.restoreWorkspace(seed.hash, this.paths.candidate);
    return this.mission();
  }

  /** Ledger-backed registry: container names are durable before `docker run` and closed after stop. */
  containerRegistry(experimentId: string): ContainerRegistry {
    const missionId = this.config.missionId;
    return {
      register: (name) => {
        this.ledger.transaction(() => {
          this.ledger.registerContainer(name, missionId, experimentId);
          this.ledger.appendEvent(
            `container:${name}:launched`,
            "container.launched",
            experimentId,
            {
              containerName: name,
            },
          );
        });
      },
      release: (name) => this.ledger.releaseContainer(name),
    };
  }

  mission(): MissionRow {
    const row = this.ledger.getMission(this.config.missionId);
    if (!row)
      throw new Error(
        `mission ${this.config.missionId} not initialized; run 'horizon mission create'`,
      );
    return row;
  }

  /** `horizon run` / `horizon resume`: recover, then loop until done or out of budget. */
  async run(): Promise<MissionRow> {
    this.ledger.acquireLock();
    try {
      const recovery = recover(
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
      this.ledger.updateMission(this.config.missionId, { status: "running", nextWakeAt: null });
      await this.drainOutbox();

      let cycles = 0;
      let active = recovery.activeExperiment;
      while (cycles < this.maxCycles) {
        const mission = this.mission();
        const stop = this.stopReason(mission);
        if (stop) {
          this.finish(stop);
          break;
        }
        const task = this.nextTask();
        if (!task) {
          this.finish("succeeded");
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
            this.finish("blocked", "worker has no further hypotheses");
            break;
          }
          if (done === "blocked" || done === "waiting") break;
        }
      }
      await this.drainOutbox();
      return this.mission();
    } finally {
      await this.worker.closeSegment().catch(() => {});
      this.ledger.releaseLock();
    }
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

  private nextTask() {
    const tasks = this.ledger.listTasks(this.config.missionId);
    const done = new Set(tasks.filter((t) => t.status === "done").map((t) => t.taskId));
    return tasks.find(
      (t) => t.status !== "done" && t.status !== "skipped" && t.dependsOn.every((d) => done.has(d)),
    );
  }

  /** A `waiting` mission persisted its retry time; sleep it off (unbilled) before touching the worker again. */
  private async honourWakeTime(): Promise<void> {
    const mission = this.mission();
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
  private parkOnWorkerFault(
    error: WorkerUnavailableError,
    experimentId: string | null,
  ): "blocked" | "waiting" {
    if (experimentId)
      this.ledger.transaction(() => {
        this.ledger.updateExperiment(experimentId, {
          status: "interrupted",
          verdict: `worker unavailable: ${error.message}`,
          finishedAt: new Date().toISOString(),
        });
        this.ledger.appendEvent(
          `${experimentId}:interrupted:worker`,
          "experiment.interrupted",
          experimentId,
          { previousStatus: "editing", reason: error.kind },
        );
      });
    if (error.kind !== "rate_limited") {
      this.finish("blocked", error.message);
      return "blocked";
    }
    const nextWakeAt = new Date(Date.now() + (error.retryAfterMs ?? 0)).toISOString();
    this.ledger.transaction(() => {
      this.ledger.updateMission(this.config.missionId, {
        status: "waiting",
        activeTaskId: null,
        nextWakeAt,
      });
      this.ledger.appendEvent(
        `mission:${this.config.missionId}:waiting:${Date.now()}`,
        "mission.waiting",
        this.config.missionId,
        { reason: error.message, nextWakeAt },
      );
      this.checkpoint("waiting", "optimize-search", null, "waiting:provider");
    });
    this.log(`mission waiting: ${error.message}; resume at or after ${nextWakeAt}`);
    return "waiting";
  }

  private finish(status: MissionStatus, detail = ""): void {
    this.ledger.transaction(() => {
      this.ledger.updateMission(this.config.missionId, { status, nextWakeAt: null });
      this.ledger.appendEvent(
        `mission:${this.config.missionId}:finish:${Date.now()}`,
        "mission.finished",
        this.config.missionId,
        { status, detail },
      );
      this.checkpoint(status, null, null, `finished:${status}`);
    });
    this.log(`mission ${status}${detail ? `: ${detail}` : ""}`);
  }

  // ---- baseline and holdout ---------------------------------------------------

  private async runBaseline(): Promise<void> {
    const mission = this.mission();
    const seed = mission.seedArtifactHash;
    if (!seed) throw new Error("mission has no seed artifact");
    const experimentId = `exp-baseline-${this.config.missionId}`;
    if (!this.ledger.getExperiment(experimentId)) {
      this.ledger.insertExperiment({
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
      this.ledger.updateExperiment(experimentId, { candidateArtifactHash: seed });
    }
    this.ledger.updateExperiment(experimentId, { status: "evaluating" });
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
      this.ledger.updateExperiment(experimentId, {
        status: infra ? "inconclusive" : "rejected",
        verdict: infra
          ? `infra: ${infra.infraMessage ?? infra.status}`
          : "seed failed fixed suites",
        finishedAt: new Date().toISOString(),
      });
      this.finish(
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
      this.ledger.transaction(() => {
        this.ledger.updateExperiment(experimentId, {
          status: "inconclusive",
          verdict: `baseline p95 ${perf.metrics.p95LatencyMs}ms; ${floor.reason}`,
          finishedAt: new Date().toISOString(),
        });
        this.ledger.appendEvent(
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
      this.finish("blocked", floor.reason);
      throw new BaselineError("baseline noise exceeds the measurable range");
    }
    this.ledger.transaction(() => {
      this.ledger.updateExperiment(experimentId, {
        status: "accepted",
        verdict: `baseline p95 ${perf.metrics.p95LatencyMs}ms`,
        finishedAt: new Date().toISOString(),
      });
      this.ledger.updateMission(this.config.missionId, {
        baselineP95Ms: perf.metrics.p95LatencyMs ?? null,
        frozenAcceptanceMargin: floor.acceptanceMargin,
        bestP95Ms: perf.metrics.p95LatencyMs ?? null,
        bestArtifactHash: seed,
      });
      this.ledger.upsertTask({ ...TASKS[0]!, missionId: this.config.missionId, status: "done" });
      this.ledger.appendEvent(
        `baseline:${this.config.missionId}`,
        "mission.baseline",
        this.config.missionId,
        { p95: perf.metrics.p95LatencyMs, reportId: perf.reportId },
      );
      this.ledger.appendEvent(
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
      this.checkpoint("running", "optimize-search", null, "baseline-complete");
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
    const mission = this.mission();
    const best = mission.bestArtifactHash;
    if (!best) throw new Error("no best artifact");
    const experimentId = `exp-holdout-${this.config.missionId}-${best.slice(0, 12)}`;
    if (!this.ledger.getExperiment(experimentId)) {
      this.ledger.insertExperiment({
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
      this.ledger.updateExperiment(experimentId, { candidateArtifactHash: best });
    }
    this.ledger.updateExperiment(experimentId, { status: "evaluating" });
    const [report] = await this.runSuites(experimentId, best, ["holdout"]);
    const passed = report?.status === "passed";
    this.ledger.transaction(() => {
      this.ledger.updateExperiment(experimentId, {
        status: passed ? "accepted" : report?.status === "failed" ? "rejected" : "inconclusive",
        verdict: `holdout ${report?.status ?? "missing"}`,
        finishedAt: new Date().toISOString(),
      });
      this.ledger.upsertTask({
        ...TASKS[2]!,
        missionId: this.config.missionId,
        status: passed ? "done" : "pending",
      });
    });
    if (!passed) this.finish("blocked", `holdout ${report?.status ?? "missing"} on best artifact`);
  }

  // ---- one experiment cycle ---------------------------------------------------

  private async runCycle(
    cycle: number,
    recovery: RecoveryOutcome,
  ): Promise<"continue" | "exhausted" | "blocked" | "waiting"> {
    const mission = this.mission();
    const parent = mission.bestArtifactHash ?? mission.seedArtifactHash!;
    try {
      await this.ensureSegment();
    } catch (error) {
      if (error instanceof WorkerUnavailableError) return this.parkOnWorkerFault(error, null);
      throw error;
    }

    const experimentId = `exp-${String(mission.spentExperiments + 1).padStart(4, "0")}-${randomUUID().slice(0, 8)}`;
    this.ledger.transaction(() => {
      this.ledger.insertExperiment({
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
      this.ledger.updateMission(this.config.missionId, {
        activeTaskId: "optimize-search",
        spentExperiments: mission.spentExperiments + 1,
      });
      this.ledger.appendEvent(`${experimentId}:planned`, "experiment.planned", experimentId, {
        parent,
      });
      this.checkpoint("running", "optimize-search", experimentId, "planned");
    });

    // Restore the workspace from the immutable parent so a crashed edit never leaks in.
    this.artifacts.restoreWorkspace(parent, this.paths.candidate);
    this.ledger.updateExperiment(experimentId, { status: "editing" });
    this.ledger.appendEvent(`${experimentId}:editing`, "experiment.editing", experimentId, {});
    this.crash("editing");

    const packet = await this.buildPacket(mission, experimentId);
    this.cycleDeadline = Date.now() + this.config.budget.cycleTimeoutMs;
    const broker = new ToolBroker(
      this.paths.candidate,
      this.evidence,
      this.hooks(experimentId),
      () => this.cycleDeadline,
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
    this.spendTokens(result.usage);
    const audit = auditClaim(result.claim, broker.verifications);
    const text = this.boundWorkerText(result);
    this.ledger.appendEvent(`${experimentId}:claim-audit`, "claim.audited", experimentId, {
      claim: text.claim,
      observed: broker.verifications,
      ...audit,
    });
    if (!audit.supported) this.log(`  unsupported worker claim: ${audit.issues.join("; ")}`);
    if (result.hypothesis === "none" && result.whatChanged === "nothing") {
      this.ledger.updateExperiment(experimentId, {
        status: "inconclusive",
        verdict: "worker exhausted",
        finishedAt: new Date().toISOString(),
      });
      return "exhausted";
    }

    const snapshot = this.artifacts.snapshot(this.paths.candidate, parent);
    this.ledger.transaction(() => {
      if (!this.ledger.getArtifact(snapshot.hash))
        this.ledger.insertArtifact({
          hash: snapshot.hash,
          path: snapshot.path,
          parentHash: parent,
          manifestHash: sha256(canonicalJson(snapshot.manifest)),
          createdAt: new Date().toISOString(),
        });
      this.ledger.updateExperiment(experimentId, {
        status: "snapshot_ready",
        candidateArtifactHash: snapshot.hash,
      });
      this.ledger.appendEvent(`${experimentId}:snapshot`, "experiment.snapshot", experimentId, {
        hash: snapshot.hash,
        hypothesis: text.hypothesis,
        whatChanged: text.whatChanged,
        claim: text.claim,
        seededFixture: result.seededFixture,
        aborted: result.aborted,
        claimIssues: audit.issues,
      });
      this.checkpoint("running", "optimize-search", experimentId, "snapshot_ready");
    });
    this.crash("snapshot_ready");
    const experiment = this.ledger.getExperiment(experimentId)!;
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
    const mission = this.mission();
    if (!this.artifacts.verify(hash)) throw new Error(`artifact ${hash} failed integrity check`);
    this.ledger.updateExperiment(experiment.experimentId, { status: "evaluating" });
    this.ledger.appendEvent(
      `${experiment.experimentId}:evaluating:${experiment.attempt}`,
      "experiment.evaluating",
      experiment.experimentId,
      { attempt: experiment.attempt },
    );

    const snapshotEvent = this.ledger.findEvent(`${experiment.experimentId}:snapshot`);
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
      this.observeLesson(experiment, failing);
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
    const bestReps = this.bestPerformanceReport(mission)?.metrics.repetitionP95Ms ?? [];
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
    this.ledger.transaction(() => {
      this.ledger.updateMission(this.config.missionId, { bestArtifactHash: hash, bestP95Ms: p95 });
      this.ledger.appendEvent(`${experiment.experimentId}:accepted`, "artifact.accepted", hash, {
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
      this.mission(),
    );
    const target =
      (mission.baselineP95Ms ?? Number.POSITIVE_INFINITY) * (1 - this.config.targetP95Reduction);
    if ((p95 ?? Number.POSITIVE_INFINITY) <= target) {
      this.ledger.upsertTask({ ...TASKS[1]!, missionId: this.config.missionId, status: "done" });
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

  private bestPerformanceReport(mission: MissionRow): VerificationReport | undefined {
    const row = this.ledger
      .listVerifications(this.config.missionId)
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
    this.ledger.transaction(() => {
      this.ledger.updateExperiment(experiment.experimentId, {
        status: verdict,
        verdict: reason,
        reportIds: reports.map((r) => r.reportId),
        failureSignature,
        finishedAt: new Date().toISOString(),
        hypothesis: story.hypothesis,
      });
      this.ledger.insertEpisode({
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
      this.outbox.enqueue(payload);
      this.ledger.appendEvent(
        `${experiment.experimentId}:concluded`,
        "experiment.concluded",
        experiment.experimentId,
        { verdict, reason },
      );
      this.ledger.updateMission(this.config.missionId, { activeTaskId: null });
      this.checkpoint("running", "optimize-search", null, "concluded");
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

  // ---- verification through the fixed runner ------------------------------------

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
    const existing = this.ledger.findVerification(experimentId, hash, suite);
    if (existing && existsSync(existing.path)) {
      const parsed = JSON.parse(readFileSync(existing.path, "utf8")) as VerificationReport;
      if (parsed.status === "passed" || parsed.status === "failed") return parsed;
    }
    const prior = REUSABLE_FAILURE_SUITES.has(suite) ? this.priorFailure(hash, suite) : undefined;
    if (prior) {
      this.ledger.appendEvent(
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
    const mission = this.mission();
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
    if (this.ledger.getExperiment(experimentId)?.status === "evaluating")
      this.crash(
        `report-written:${experimentId.startsWith("exp-0") ? "optimize" : "fixed"}:${suite}`,
      );
    this.ledger.transaction(() => {
      this.ledger.insertVerification(report, path);
      this.ledger.appendEvent(`report:${report.reportId}`, "verification.recorded", experimentId, {
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
  private priorFailure(hash: string, suite: Suite): VerificationReport | undefined {
    const row = this.ledger
      .listVerifications(this.config.missionId)
      .find(
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

  // ---- lessons ------------------------------------------------------------------

  private observeLesson(experiment: ExperimentRow, failing: VerificationReport[]): void {
    for (const report of failing) {
      for (const assertion of report.assertions.filter((a) => !a.passed)) {
        for (const invariantId of assertion.invariantIds ?? []) {
          const lessonId = `lesson-${invariantId.toLowerCase()}`;
          const current = this.ledger
            .listLessons(this.config.missionId)
            .find((l) => l.lessonId === lessonId);
          if (current && current.state !== "observed") continue;
          const episodeId = `ep-${experiment.experimentId}-v1`;
          const state: LessonState = current ? "reproduced" : "observed";
          this.ledger.upsertLesson({
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
    const mission = this.mission();
    const existingIds = new Set([
      ...loadScenarios().map((s) => s.scenarioId),
      ...this.ledger.listLearnedScenarios(this.config.missionId).map((s) => s.scenarioId),
    ]);
    const shape = validateProposalShape(proposal, existingIds);
    const lessonId = `lesson-${proposal.invariantId.toLowerCase()}`;
    const current = this.ledger
      .listLessons(this.config.missionId)
      .find((l) => l.lessonId === lessonId);
    const transition = (
      state: LessonState,
      evidenceId: string | null,
      patch: Partial<LessonRow> = {},
    ) => {
      const base = this.ledger
        .listLessons(this.config.missionId)
        .find((l) => l.lessonId === lessonId);
      this.ledger.upsertLesson({
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
      transition("rejected", null);
      return { accepted: false, reason: shape.reason, lessonId };
    }
    if (current?.state === "materialized")
      return {
        accepted: false,
        reason: "invariant already has a materialized regression",
        lessonId,
      };
    transition("proposed", null);

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
      transition("rejected", negativeEvidence, {
        negativeEvidenceId: negativeEvidence,
        positiveEvidenceId: positiveEvidence,
      });
      return { accepted: false, reason: validation.reason, lessonId };
    }
    transition("validated", positiveEvidence, {
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
    this.ledger.transaction(() => {
      const version = this.mission().learnedSuiteVersion + 1;
      this.ledger.insertLearnedScenario(
        scenario.scenarioId,
        this.config.missionId,
        lessonId,
        version,
        path,
      );
      this.ledger.updateMission(this.config.missionId, { learnedSuiteVersion: version });
      transition("materialized", positiveEvidence, { materializedScenarioId: scenario.scenarioId });
      this.ledger.appendEvent(`lesson:${lessonId}:materialized`, "lesson.materialized", lessonId, {
        scenarioId: scenario.scenarioId,
        version,
      });
    });
    this.log(`  lesson ${lessonId} materialized as learned scenario ${scenario.scenarioId}`);
    return { accepted: true, reason: validation.reason, lessonId };
  }

  // ---- packet, hooks, segments, budget, memory ---------------------------------------

  private async buildPacket(mission: MissionRow, experimentId: string): Promise<ContextPacket> {
    const experiments = this.ledger
      .listExperiments(this.config.missionId)
      .filter((e) => e.taskId === "optimize-search");
    // Bounded recent history: only this segment's experiments are replayed verbatim; older segments are reachable through retrieval.
    const recent = experiments
      .filter((e) => e.segmentOrdinal === this.segmentOrdinal)
      .slice(-3)
      .map((e) => {
        const episode = this.ledger.getEpisode(`ep-${e.experimentId}-v1`);
        return episode ? episode.summary : `${e.experimentId}: ${e.status} ${e.verdict ?? ""}`;
      })
      .join("\n\n");
    const features = readFileSync(join(RESOURCES_DIR, "features.json"), "utf8");
    const skill = readFileSync(join(RESOURCES_DIR, "skills/verify-search/SKILL.md"), "utf8");
    const query =
      experiments.length > 0
        ? "search engine cache invalidation normalization p95"
        : "baseline read path";
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
        next: `Last verdict: ${lastVerdict}\nNext action: ${this.ledger.listTasks(this.config.missionId).find((t) => t.taskId === "optimize-search")?.nextAction ?? ""}\nFiltered from retrieval: ${retrieval.filteredOut.map((f) => `${f.episodeId ?? "?"} (${f.reason})`).join("; ") || "none"}`,
      },
      DEFAULT_PACKET_BUDGET,
    );
    this.ledger.appendEvent(`${experimentId}:packet`, "packet.built", experimentId, {
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
        const snapshot = this.artifacts.snapshot(
          this.paths.candidate,
          this.mission().bestArtifactHash,
        );
        if (!this.ledger.getArtifact(snapshot.hash))
          this.ledger.insertArtifact({
            hash: snapshot.hash,
            path: snapshot.path,
            parentHash: this.mission().bestArtifactHash,
            manifestHash: sha256(canonicalJson(snapshot.manifest)),
            createdAt: new Date().toISOString(),
          });
        const report = await this.verifyArtifact(experimentId, snapshot.hash, suite);
        return {
          report,
          reportPath: join(this.paths.reports, experimentId, `${suite}-${report.reportId}.json`),
        };
      },
      profile: async (scenario) => {
        const snapshot = this.artifacts.snapshot(
          this.paths.candidate,
          this.mission().bestArtifactHash,
        );
        if (!this.ledger.getArtifact(snapshot.hash))
          this.ledger.insertArtifact({
            hash: snapshot.hash,
            path: snapshot.path,
            parentHash: this.mission().bestArtifactHash,
            manifestHash: sha256(canonicalJson(snapshot.manifest)),
            createdAt: new Date().toISOString(),
          });
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
        return selection.injected.map((r) => {
          const row = this.ledger.getEpisode(r.episodeId);
          return {
            episodeId: r.episodeId,
            summary: r.text,
            evidenceIds: row?.evidenceIds ?? [],
            artifactHash: row?.artifactHash ?? "",
          };
        });
      },
      proposeRegression: (proposal) => this.handleProposal(experimentId, proposal),
      onToolEvent: (name, params, summary) => {
        this.ledger.appendEvent(`${experimentId}:tool:${randomUUID()}`, "tool.call", experimentId, {
          name,
          params,
          summary,
        });
      },
    };
  }

  private async ensureSegment(): Promise<void> {
    const active = this.ledger.activeSegment(this.config.missionId);
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
      // Resuming an existing committed segment after restart.
      await this.worker.openSegment(active.ordinal, previous);
      this.segmentOrdinal = active.ordinal;
      this.cyclesInSegment = 0;
      return;
    }
    const ordinal = (active?.ordinal ?? this.segmentOrdinal) + 1;
    // A new segment is a fresh bounded context; `previous` is only for resuming a committed segment.
    const handle = await this.worker.openSegment(ordinal, null);
    this.ledger.transaction(() => {
      if (active) this.ledger.closeSegment(this.config.missionId, active.ordinal, null);
      this.ledger.openSegment(this.config.missionId, ordinal, handle.sessionPath, handle.sessionId);
      const checkpoint = this.checkpoint(
        "running",
        "optimize-search",
        null,
        `segment-open:${ordinal}`,
      );
      this.ledger.commitSegment(this.config.missionId, ordinal, checkpoint.checkpointId);
      this.ledger.appendEvent(`segment:${ordinal}:open`, "segment.opened", this.config.missionId, {
        ordinal,
        rotatedFrom: active?.ordinal ?? null,
      });
    });
    this.segmentOrdinal = ordinal;
    this.cyclesInSegment = 0;
    this.log(`segment ${ordinal} open${active ? ` (rotated from ${active.ordinal})` : ""}`);
  }

  private checkpoint(
    status: MissionStatus,
    taskId: string | null,
    experimentId: string | null,
    operation: string,
  ) {
    this.accrueWall();
    const mission = this.mission();
    return this.ledger.writeCheckpoint({
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

  private accrueWall(): void {
    const now = Date.now();
    const mission = this.mission();
    this.ledger.updateMission(this.config.missionId, {
      spentWallMs: mission.spentWallMs + (now - this.wallMark),
    });
    this.wallMark = now;
  }

  private spendTokens(usage: {
    inputTokens: number;
    outputTokens: number;
    uncertain: boolean;
  }): void {
    const mission = this.mission();
    this.ledger.updateMission(this.config.missionId, {
      spentInputTokens: mission.spentInputTokens + usage.inputTokens,
      spentOutputTokens: mission.spentOutputTokens + usage.outputTokens,
      usageUncertain: usage.uncertain ? 1 : mission.usageUncertain,
    });
  }

  private spendMemoryOperation(): void {
    const mission = this.mission();
    if (mission.spentMemoryOperations >= this.config.budget.maxMemoryOperations)
      throw new Error("memory operation budget exhausted");
    this.ledger.updateMission(this.config.missionId, {
      spentMemoryOperations: mission.spentMemoryOperations + 1,
    });
  }

  private episodePayload(episodeId: string): EpisodePayload | undefined {
    return this.ledger.outboxPayloadForEpisode(episodeId) as EpisodePayload | undefined;
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
