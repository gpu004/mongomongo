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
import { computeEnvironmentHash, computeEvaluatorHash, runSuite } from "../verification/runner.ts";
import { loadScenarios, type Scenario } from "../verification/scenarios/index.ts";
import { ArtifactStore } from "./artifact-store.ts";
import { auditClaim } from "./claim-audit.ts";
import { buildPacket, type ContextPacket, DEFAULT_PACKET_BUDGET } from "./context-packet.ts";
import { openLedger } from "./ledger-factory.ts";
import {
  type CheckpointRow,
  type ExperimentRow,
  type Ledger,
  type LessonRow,
  type LessonState,
  type MissionRow,
  type MissionStatus,
  type TaskRow,
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
import { recover, type RecoveryOutcome } from "./recovery.ts";
import { ScriptedWorker } from "./scripted-worker.ts";
import { cleanupOrphanContainers } from "./sandbox.ts";
import { type BrokerHooks, ToolBroker } from "./tool-broker.ts";
import {
  firstComparison,
  repetitionSpread,
  rerunComparison,
  type TimingDecision,
} from "./timing-policy.ts";
import type { Worker, WorkerCycleResult } from "./worker.ts";

export const RESOURCES_DIR = new URL("../resources/", import.meta.url).pathname;

export interface ControllerOptions {
  /** Pre-opened ledger; `MissionController.open` selects one from the mission config when omitted. */
  ledger?: Ledger;
  worker?: Worker;
  memory?: MemoryAdapter;
  log?: (line: string) => void;
  /** Test hook: throw at a named point to simulate a crash. */
  crashAt?: string;
  /** Stop after this many cycles regardless of budget (CLI --cycles). */
  maxCycles?: number;
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
  readonly evaluatorHash: string;
  readonly environmentHash: string;
  readonly contractHash: string;
  private segmentOrdinal = 0;
  private cyclesInSegment = 0;
  private cycleDeadline = 0;
  /** Wall time since this mark has not yet been added to mission.spentWallMs. */
  private wallMark = Date.now();

  /** Opens the ledger selected by `config.ledger` (SQLite by default) and builds the controller. */
  static async open(
    config: MissionConfig,
    paths: MissionPaths,
    options: ControllerOptions = {},
  ): Promise<MissionController> {
    ensureMissionDirs(paths);
    const ledger = options.ledger ?? (await openLedger(config, paths));
    return new MissionController(config, paths, { ...options, ledger });
  }

  constructor(
    config: MissionConfig,
    paths: MissionPaths,
    options: ControllerOptions & { ledger: Ledger },
  ) {
    this.config = config;
    this.paths = paths;
    ensureMissionDirs(paths);
    this.ledger = options.ledger;
    this.artifacts = new ArtifactStore(paths.artifacts);
    this.evidence = new FileEvidenceStore(paths.evidence);
    this.log = options.log ?? (() => {});
    this.crashAt = options.crashAt;
    this.maxCycles = options.maxCycles ?? Number.POSITIVE_INFINITY;
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

  async close(): Promise<void> {
    await this.ledger.close();
  }

  // ---- mission lifecycle ----------------------------------------------------

  /** `horizon mission create`: freeze identities, import the seed, write the manifest. Idempotent. */
  async initialize(): Promise<MissionRow> {
    const existing = await this.ledger.getMission(this.config.missionId);
    if (existing) return existing;
    const seed = this.artifacts.importSeed();
    await this.ledger.transaction(async () => {
      await this.ledger.createMission({
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
      await this.ledger.insertArtifact({
        hash: seed.hash,
        path: seed.path,
        parentHash: null,
        manifestHash: sha256(canonicalJson(seed.manifest)),
        createdAt: new Date().toISOString(),
      });
      for (const task of TASKS)
        await this.ledger.upsertTask({
          ...task,
          missionId: this.config.missionId,
          status: "pending",
        });
      await this.ledger.appendEvent(
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

  async mission(): Promise<MissionRow> {
    const row = await this.ledger.getMission(this.config.missionId);
    if (!row)
      throw new Error(
        `mission ${this.config.missionId} not initialized; run 'horizon mission create'`,
      );
    return row;
  }

  /** `horizon run` / `horizon resume`: recover, then loop until done or out of budget. */
  async run(): Promise<MissionRow> {
    await this.ledger.acquireLock();
    try {
      if (this.config.isolation === "container") {
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
      );
      for (const action of recovery.actions) this.log(`recovery: ${action.kind} ${action.detail}`);
      this.segmentOrdinal = recovery.checkpoint?.segmentOrdinal ?? 0;
      await this.ledger.updateMission(this.config.missionId, { status: "running" });
      await this.drainOutbox();

      let cycles = 0;
      let active = recovery.activeExperiment;
      while (cycles < this.maxCycles) {
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
        }
      }
      await this.drainOutbox();
      return this.mission();
    } finally {
      await this.worker.closeSegment().catch(() => {});
      await this.ledger.releaseLock();
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

  private async nextTask(): Promise<TaskRow | undefined> {
    const tasks = await this.ledger.listTasks(this.config.missionId);
    const done = new Set(tasks.filter((t) => t.status === "done").map((t) => t.taskId));
    return tasks.find(
      (t) => t.status !== "done" && t.status !== "skipped" && t.dependsOn.every((d) => done.has(d)),
    );
  }

  private async finish(status: MissionStatus, detail = ""): Promise<void> {
    await this.ledger.transaction(async () => {
      await this.ledger.updateMission(this.config.missionId, { status });
      await this.ledger.appendEvent(
        `mission:${this.config.missionId}:finish:${Date.now()}`,
        "mission.finished",
        this.config.missionId,
        { status, detail },
      );
      await this.checkpoint(status, null, null, `finished:${status}`);
    });
    this.log(`mission ${status}${detail ? `: ${detail}` : ""}`);
  }

  // ---- baseline and holdout ---------------------------------------------------

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
    await this.ledger.transaction(async () => {
      await this.ledger.updateExperiment(experimentId, {
        status: "accepted",
        verdict: `baseline p95 ${perf.metrics.p95LatencyMs}ms`,
        finishedAt: new Date().toISOString(),
      });
      await this.ledger.updateMission(this.config.missionId, {
        baselineP95Ms: perf.metrics.p95LatencyMs ?? null,
        bestP95Ms: perf.metrics.p95LatencyMs ?? null,
        bestArtifactHash: seed,
      });
      await this.ledger.upsertTask({
        ...TASKS[0]!,
        missionId: this.config.missionId,
        status: "done",
      });
      await this.ledger.appendEvent(
        `baseline:${this.config.missionId}`,
        "mission.baseline",
        this.config.missionId,
        { p95: perf.metrics.p95LatencyMs, reportId: perf.reportId },
      );
      await this.ledger.appendEvent(
        `target:${this.config.missionId}:assessed`,
        "target.assessed",
        this.config.missionId,
        {
          repetitionSpread: noise,
          acceptanceMargin: this.config.acceptanceMargin,
          targetP95Reduction: this.config.targetP95Reduction,
          marginCoversNoise: this.config.acceptanceMargin >= noise,
        },
      );
      await this.checkpoint("running", "optimize-search", null, "baseline-complete");
    });
    this.log(
      `baseline p95 ${perf.metrics.p95LatencyMs}ms (target <= ${(perf.metrics.p95LatencyMs! * (1 - this.config.targetP95Reduction)).toFixed(2)}ms; repetition spread ${(noise * 100).toFixed(1)}%)`,
    );
    if (this.config.acceptanceMargin < noise)
      this.log(
        `  warning: acceptance margin ${this.config.acceptanceMargin} is below the measured repetition spread ${noise.toFixed(3)}; expect ambiguous timing verdicts`,
      );
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
    await this.ledger.transaction(async () => {
      await this.ledger.updateExperiment(experimentId, {
        status: passed ? "accepted" : report?.status === "failed" ? "rejected" : "inconclusive",
        verdict: `holdout ${report?.status ?? "missing"}`,
        finishedAt: new Date().toISOString(),
      });
      await this.ledger.upsertTask({
        ...TASKS[2]!,
        missionId: this.config.missionId,
        status: passed ? "done" : "pending",
      });
    });
    if (!passed)
      await this.finish("blocked", `holdout ${report?.status ?? "missing"} on best artifact`);
  }

  // ---- one experiment cycle ---------------------------------------------------

  private async runCycle(
    cycle: number,
    recovery: RecoveryOutcome,
  ): Promise<"continue" | "exhausted"> {
    const mission = await this.mission();
    const parent = mission.bestArtifactHash ?? mission.seedArtifactHash!;
    await this.ensureSegment();

    const experimentId = `exp-${String(mission.spentExperiments + 1).padStart(4, "0")}-${randomUUID().slice(0, 8)}`;
    await this.ledger.transaction(async () => {
      await this.ledger.insertExperiment({
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
      await this.ledger.updateMission(this.config.missionId, {
        activeTaskId: "optimize-search",
        spentExperiments: mission.spentExperiments + 1,
      });
      await this.ledger.appendEvent(`${experimentId}:planned`, "experiment.planned", experimentId, {
        parent,
      });
      await this.checkpoint("running", "optimize-search", experimentId, "planned");
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

    const packet = await this.buildPacket(mission, experimentId);
    this.cycleDeadline = Date.now() + this.config.budget.cycleTimeoutMs;
    const broker = new ToolBroker(
      this.paths.candidate,
      this.evidence,
      this.hooks(experimentId),
      () => this.cycleDeadline,
      this.config.isolation === "container"
        ? { image: this.config.containerImage, missionId: this.config.missionId }
        : undefined,
    );
    const recoveryNote = recovery.actions.find((a) => a.kind === "interrupted_edit")?.detail;
    const result = await this.worker.runCycle({
      cycle,
      packet,
      broker,
      deadlineAt: this.cycleDeadline,
      ...(cycle === 1 && recoveryNote ? { recoveryNote } : {}),
    });
    broker.terminateChildren();
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

    const snapshot = this.artifacts.snapshot(this.paths.candidate, parent);
    await this.ledger.transaction(async () => {
      if (!(await this.ledger.getArtifact(snapshot.hash)))
        await this.ledger.insertArtifact({
          hash: snapshot.hash,
          path: snapshot.path,
          parentHash: parent,
          manifestHash: sha256(canonicalJson(snapshot.manifest)),
          createdAt: new Date().toISOString(),
        });
      await this.ledger.updateExperiment(experimentId, {
        status: "snapshot_ready",
        candidateArtifactHash: snapshot.hash,
      });
      await this.ledger.appendEvent(
        `${experimentId}:snapshot`,
        "experiment.snapshot",
        experimentId,
        {
          hash: snapshot.hash,
          hypothesis: text.hypothesis,
          whatChanged: text.whatChanged,
          claim: text.claim,
          seededFixture: result.seededFixture,
          aborted: result.aborted,
          claimIssues: audit.issues,
        },
      );
      await this.checkpoint("running", "optimize-search", experimentId, "snapshot_ready");
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
      this.config,
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
    await this.ledger.transaction(async () => {
      await this.ledger.updateMission(this.config.missionId, {
        bestArtifactHash: hash,
        bestP95Ms: p95,
      });
      await this.ledger.appendEvent(
        `${experiment.experimentId}:accepted`,
        "artifact.accepted",
        hash,
        {
          p95,
          previous: mission.bestP95Ms,
          reportId: accepted.reportId,
        },
      );
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
        this.config,
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
    await this.ledger.transaction(async () => {
      await this.ledger.updateExperiment(experiment.experimentId, {
        status: verdict,
        verdict: reason,
        reportIds: reports.map((r) => r.reportId),
        failureSignature,
        finishedAt: new Date().toISOString(),
        hypothesis: story.hypothesis,
      });
      await this.ledger.insertEpisode({
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
      await this.outbox.enqueue(payload);
      await this.ledger.appendEvent(
        `${experiment.experimentId}:concluded`,
        "experiment.concluded",
        experiment.experimentId,
        { verdict, reason },
      );
      await this.ledger.updateMission(this.config.missionId, { activeTaskId: null });
      await this.checkpoint("running", "optimize-search", null, "concluded");
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
    await this.ledger.transaction(async () => {
      await this.ledger.insertVerification(report, path);
      await this.ledger.appendEvent(
        `report:${report.reportId}`,
        "verification.recorded",
        experimentId,
        {
          suite,
          status: report.status,
          hash,
          p95: report.metrics.p95LatencyMs ?? null,
          isolation: report.isolation,
        },
      );
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

  // ---- lessons ------------------------------------------------------------------

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
    ) => {
      const base = (await this.ledger.listLessons(this.config.missionId)).find(
        (l) => l.lessonId === lessonId,
      );
      await this.ledger.upsertLesson({
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
    await this.ledger.transaction(async () => {
      const version = (await this.mission()).learnedSuiteVersion + 1;
      await this.ledger.insertLearnedScenario(
        scenario.scenarioId,
        this.config.missionId,
        lessonId,
        version,
        path,
      );
      await this.ledger.updateMission(this.config.missionId, { learnedSuiteVersion: version });
      await transition("materialized", positiveEvidence, {
        materializedScenarioId: scenario.scenarioId,
      });
      await this.ledger.appendEvent(
        `lesson:${lessonId}:materialized`,
        "lesson.materialized",
        lessonId,
        {
          scenarioId: scenario.scenarioId,
          version,
        },
      );
    });
    this.log(`  lesson ${lessonId} materialized as learned scenario ${scenario.scenarioId}`);
    return { accepted: true, reason: validation.reason, lessonId };
  }

  // ---- packet, hooks, segments, budget, memory ---------------------------------------

  private async buildPacket(mission: MissionRow, experimentId: string): Promise<ContextPacket> {
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
    const optimizeTask = (await this.ledger.listTasks(this.config.missionId)).find(
      (t) => t.taskId === "optimize-search",
    );
    const pinned = [
      `Mission ${mission.missionId} (contract v${mission.contractVersion}, hash ${mission.contractHash.slice(0, 12)}). Objective: ${this.config.objective}`,
      `Baseline p95 ${mission.baselineP95Ms ?? "unmeasured"}ms; current best ${mission.bestP95Ms ?? "n/a"}ms (artifact ${(mission.bestArtifactHash ?? "").slice(0, 12)}); target <= ${mission.baselineP95Ms !== null ? (mission.baselineP95Ms * (1 - this.config.targetP95Reduction)).toFixed(2) : "?"}ms; acceptance margin ${this.config.acceptanceMargin}.`,
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
        next: `Last verdict: ${lastVerdict}\nNext action: ${optimizeTask?.nextAction ?? ""}\nFiltered from retrieval: ${retrieval.filteredOut.map((f) => `${f.episodeId ?? "?"} (${f.reason})`).join("; ") || "none"}`,
      },
      DEFAULT_PACKET_BUDGET,
    );
    await this.ledger.appendEvent(`${experimentId}:packet`, "packet.built", experimentId, {
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
        const report = await this.verifyArtifact(experimentId, snapshot.hash, suite);
        return {
          report,
          reportPath: join(this.paths.reports, experimentId, `${suite}-${report.reportId}.json`),
        };
      },
      profile: async (scenario) => {
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
        const recalled = [];
        for (const r of selection.injected) {
          const row = await this.ledger.getEpisode(r.episodeId);
          recalled.push({
            episodeId: r.episodeId,
            summary: r.text,
            evidenceIds: row?.evidenceIds ?? [],
            artifactHash: row?.artifactHash ?? "",
          });
        }
        return recalled;
      },
      proposeRegression: (proposal) => this.handleProposal(experimentId, proposal),
      onToolEvent: (name, params, summary) => {
        void this.ledger.appendEvent(
          `${experimentId}:tool:${randomUUID()}`,
          "tool.call",
          experimentId,
          {
            name,
            params,
            summary,
          },
        );
      },
    };
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
      // Resuming an existing committed segment after restart.
      await this.worker.openSegment(active.ordinal, previous);
      this.segmentOrdinal = active.ordinal;
      this.cyclesInSegment = 0;
      return;
    }
    const ordinal = (active?.ordinal ?? this.segmentOrdinal) + 1;
    // A new segment is a fresh bounded context; `previous` is only for resuming a committed segment.
    const handle = await this.worker.openSegment(ordinal, null);
    await this.ledger.transaction(async () => {
      if (active) await this.ledger.closeSegment(this.config.missionId, active.ordinal, null);
      await this.ledger.openSegment(
        this.config.missionId,
        ordinal,
        handle.sessionPath,
        handle.sessionId,
      );
      const checkpoint = await this.checkpoint(
        "running",
        "optimize-search",
        null,
        `segment-open:${ordinal}`,
      );
      await this.ledger.commitSegment(this.config.missionId, ordinal, checkpoint.checkpointId);
      await this.ledger.appendEvent(
        `segment:${ordinal}:open`,
        "segment.opened",
        this.config.missionId,
        {
          ordinal,
          rotatedFrom: active?.ordinal ?? null,
        },
      );
    });
    this.segmentOrdinal = ordinal;
    this.cyclesInSegment = 0;
    this.log(`segment ${ordinal} open${active ? ` (rotated from ${active.ordinal})` : ""}`);
  }

  private async checkpoint(
    status: MissionStatus,
    taskId: string | null,
    experimentId: string | null,
    operation: string,
  ): Promise<CheckpointRow> {
    await this.accrueWall();
    const mission = await this.mission();
    return await this.ledger.writeCheckpoint({
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

  private async accrueWall(): Promise<void> {
    const now = Date.now();
    const mission = await this.mission();
    await this.ledger.updateMission(this.config.missionId, {
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
