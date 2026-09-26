import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  canonicalJson,
  reportHash,
  sha256,
  type VerificationReport,
} from "../verification/reports.ts";

export type MissionStatus =
  | "ready"
  | "running"
  | "waiting"
  | "blocked"
  | "succeeded"
  | "budget_exhausted"
  | "failed";
export type ExperimentStatus =
  | "planned"
  | "editing"
  | "snapshot_ready"
  | "evaluating"
  | "accepted"
  | "rejected"
  | "inconclusive"
  | "interrupted";
export type LessonState =
  | "observed"
  | "reproduced"
  | "proposed"
  | "validated"
  | "materialized"
  | "rejected"
  | "superseded";
export type OutboxState = "pending" | "submitted" | "document_ready" | "memory_ready" | "failed";

export interface MissionRow {
  missionId: string;
  contractVersion: number;
  contractHash: string;
  evaluatorHash: string;
  environmentHash: string;
  status: MissionStatus;
  seedArtifactHash: string | null;
  baselineP95Ms: number | null;
  /** Margin frozen after the baseline measured its noise; null until the baseline completes. */
  frozenAcceptanceMargin: number | null;
  bestArtifactHash: string | null;
  bestP95Ms: number | null;
  activeTaskId: string | null;
  spentExperiments: number;
  spentInputTokens: number;
  spentOutputTokens: number;
  spentMemoryOperations: number;
  spentWallMs: number;
  usageUncertain: number;
  learnedSuiteVersion: number;
  nextWakeAt: string | null;
  createdAt: string;
}

export interface TaskRow {
  taskId: string;
  missionId: string;
  ordinal: number;
  dependsOn: string[];
  status: "pending" | "active" | "done" | "skipped";
  hypothesis: string;
  completionCriteria: string;
  nextAction: string;
}

export interface ExperimentRow {
  experimentId: string;
  missionId: string;
  taskId: string;
  parentArtifactHash: string;
  candidateArtifactHash: string | null;
  strategy: string;
  hypothesis: string;
  status: ExperimentStatus;
  verdict: string | null;
  failureSignature: string | null;
  attempt: number;
  reportIds: string[];
  segmentOrdinal: number;
  createdAt: string;
  finishedAt: string | null;
}

export interface ArtifactRow {
  hash: string;
  path: string;
  parentHash: string | null;
  manifestHash: string;
  createdAt: string;
}

export interface VerificationRow {
  reportId: string;
  reportHash: string;
  missionId: string;
  experimentId: string;
  artifactHash: string;
  suite: string;
  status: string;
  evaluatorHash: string;
  workloadHash: string;
  environmentHash: string;
  p95LatencyMs: number | null;
  path: string;
}

export interface EpisodeRow {
  episodeId: string;
  missionId: string;
  experimentId: string;
  version: number;
  supersedes: string | null;
  featureIds: string[];
  invariantIds: string[];
  artifactHash: string;
  parentArtifactHash: string;
  interpretation: "verified" | "model_interpretation";
  evidenceIds: string[];
  summary: string;
  createdAt: string;
}

export interface LessonRow {
  lessonId: string;
  missionId: string;
  sourceEpisodeIds: string[];
  invariantId: string;
  state: LessonState;
  proposal: string;
  positiveEvidenceId: string | null;
  negativeEvidenceId: string | null;
  materializedScenarioId: string | null;
  transitions: { state: LessonState; at: string; evidenceId: string | null }[];
}

export interface CheckpointRow {
  checkpointId: string;
  seq: number;
  missionId: string;
  missionStatus: MissionStatus;
  activeTaskId: string | null;
  activeExperimentId: string | null;
  activeOperation: string | null;
  lastEventSeq: number;
  segmentOrdinal: number;
  bestArtifactHash: string | null;
  createdAt: string;
}

export interface OutboxRow {
  idempotencyKey: string;
  episodeId: string;
  payloadHash: string;
  remoteDocumentId: string | null;
  state: OutboxState;
  retries: number;
  nextAttemptAt: string;
  lastError: string | null;
  updatedAt: string;
}

export interface SegmentRow {
  missionId: string;
  ordinal: number;
  sessionPath: string | null;
  sessionId: string | null;
  checkpointId: string | null;
  startedAt: string;
  closedAt: string | null;
  firstEventSeq: number;
  lastEventSeq: number | null;
  archiveHash: string | null;
  committed: number;
}

export type ContainerState = "launching" | "released" | "orphan_removed";

/** Execution environment (Docker container) launched for an experiment; live rows are reconciled on resume. */
export interface ContainerRow {
  containerName: string;
  missionId: string;
  experimentId: string;
  state: ContainerState;
  createdAt: string;
  releasedAt: string | null;
}

export interface EventRow {
  seq: number;
  eventKey: string;
  at: string;
  type: string;
  entityId: string;
  payload: unknown;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS mission (
  mission_id TEXT PRIMARY KEY, contract_version INTEGER NOT NULL, contract_hash TEXT NOT NULL,
  evaluator_hash TEXT NOT NULL, environment_hash TEXT NOT NULL, status TEXT NOT NULL,
  seed_artifact_hash TEXT, baseline_p95_ms REAL, best_artifact_hash TEXT, best_p95_ms REAL, active_task_id TEXT,
  spent_experiments INTEGER NOT NULL DEFAULT 0, spent_input_tokens INTEGER NOT NULL DEFAULT 0,
  spent_output_tokens INTEGER NOT NULL DEFAULT 0, spent_memory_operations INTEGER NOT NULL DEFAULT 0,
  spent_wall_ms INTEGER NOT NULL DEFAULT 0, usage_uncertain INTEGER NOT NULL DEFAULT 0,
  learned_suite_version INTEGER NOT NULL DEFAULT 0, next_wake_at TEXT, created_at TEXT NOT NULL,
  frozen_acceptance_margin REAL
);
CREATE TABLE IF NOT EXISTS task (
  task_id TEXT PRIMARY KEY, mission_id TEXT NOT NULL, ordinal INTEGER NOT NULL, depends_on TEXT NOT NULL,
  status TEXT NOT NULL, hypothesis TEXT NOT NULL, completion_criteria TEXT NOT NULL, next_action TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS experiment (
  experiment_id TEXT PRIMARY KEY, mission_id TEXT NOT NULL, task_id TEXT NOT NULL, parent_artifact_hash TEXT NOT NULL,
  candidate_artifact_hash TEXT, strategy TEXT NOT NULL, hypothesis TEXT NOT NULL, status TEXT NOT NULL, verdict TEXT,
  failure_signature TEXT, attempt INTEGER NOT NULL DEFAULT 1, report_ids TEXT NOT NULL DEFAULT '[]',
  segment_ordinal INTEGER NOT NULL, created_at TEXT NOT NULL, finished_at TEXT
);
CREATE TABLE IF NOT EXISTS artifact (
  hash TEXT PRIMARY KEY, path TEXT NOT NULL, parent_hash TEXT, manifest_hash TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS verification (
  report_id TEXT PRIMARY KEY, report_hash TEXT NOT NULL, mission_id TEXT NOT NULL, experiment_id TEXT NOT NULL,
  artifact_hash TEXT NOT NULL, suite TEXT NOT NULL, status TEXT NOT NULL, evaluator_hash TEXT NOT NULL,
  workload_hash TEXT NOT NULL, environment_hash TEXT NOT NULL, p95_latency_ms REAL, path TEXT NOT NULL,
  UNIQUE(experiment_id, artifact_hash, suite, evaluator_hash, workload_hash, environment_hash)
);
CREATE TABLE IF NOT EXISTS episode (
  episode_id TEXT PRIMARY KEY, mission_id TEXT NOT NULL, experiment_id TEXT NOT NULL, version INTEGER NOT NULL,
  supersedes TEXT, feature_ids TEXT NOT NULL, invariant_ids TEXT NOT NULL, artifact_hash TEXT NOT NULL,
  parent_artifact_hash TEXT NOT NULL, interpretation TEXT NOT NULL, evidence_ids TEXT NOT NULL, summary TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS lesson (
  lesson_id TEXT PRIMARY KEY, mission_id TEXT NOT NULL, source_episode_ids TEXT NOT NULL, invariant_id TEXT NOT NULL,
  state TEXT NOT NULL, proposal TEXT NOT NULL, positive_evidence_id TEXT, negative_evidence_id TEXT,
  materialized_scenario_id TEXT, transitions TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS checkpoint (
  checkpoint_id TEXT PRIMARY KEY, seq INTEGER NOT NULL UNIQUE, mission_id TEXT NOT NULL, mission_status TEXT NOT NULL,
  active_task_id TEXT, active_experiment_id TEXT, active_operation TEXT, last_event_seq INTEGER NOT NULL,
  segment_ordinal INTEGER NOT NULL, best_artifact_hash TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS outbox (
  idempotency_key TEXT PRIMARY KEY, episode_id TEXT NOT NULL, payload_hash TEXT NOT NULL, payload TEXT NOT NULL, remote_document_id TEXT,
  state TEXT NOT NULL, retries INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT NOT NULL, last_error TEXT, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS segment (
  mission_id TEXT NOT NULL, ordinal INTEGER NOT NULL, session_path TEXT, session_id TEXT, checkpoint_id TEXT,
  started_at TEXT NOT NULL, closed_at TEXT, first_event_seq INTEGER NOT NULL, last_event_seq INTEGER, archive_hash TEXT,
  committed INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(mission_id, ordinal)
);
CREATE TABLE IF NOT EXISTS event (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, event_key TEXT NOT NULL UNIQUE, at TEXT NOT NULL, type TEXT NOT NULL,
  entity_id TEXT NOT NULL, payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS episode_mission ON episode(mission_id, created_at);
CREATE INDEX IF NOT EXISTS episode_supersedes ON episode(supersedes);
CREATE INDEX IF NOT EXISTS outbox_episode ON outbox(episode_id);
CREATE INDEX IF NOT EXISTS verification_artifact ON verification(mission_id, artifact_hash, suite);
CREATE VIRTUAL TABLE IF NOT EXISTS episode_fts USING fts5(episode_id UNINDEXED, mission_id UNINDEXED, summary);
CREATE VIRTUAL TABLE IF NOT EXISTS episode_fts_vocab USING fts5vocab(episode_fts, row);
CREATE TABLE IF NOT EXISTS learned_scenario (
  scenario_id TEXT PRIMARY KEY, mission_id TEXT NOT NULL, lesson_id TEXT NOT NULL, suite_version INTEGER NOT NULL, path TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS container (
  container_name TEXT PRIMARY KEY, mission_id TEXT NOT NULL, experiment_id TEXT NOT NULL, state TEXT NOT NULL,
  created_at TEXT NOT NULL, released_at TEXT
);
CREATE INDEX IF NOT EXISTS container_mission_state ON container(mission_id, state);
`;

function now(): string {
  return new Date().toISOString();
}

type Cell = string | number | null | undefined;
type Row = Record<string, Cell>;

/**
 * Canonical durable mission state. Every backend must provide atomic
 * multi-write transactions, idempotent inserts on the natural keys (event key,
 * report identity, episode id, outbox idempotency key) and a single-writer
 * controller lock. Backends: `SqliteLedger` (local file), `MongoLedger`
 * (Atlas or any replica set; see mongo-ledger.ts).
 */
export interface Ledger {
  readonly backend: "sqlite" | "mongodb";
  /** Human-readable location without credentials (file path or host/db). */
  readonly location: string;
  acquireLock(): Promise<void>;
  releaseLock(): Promise<void>;
  close(): Promise<void>;
  /** Runs `fn` atomically; must not be nested. Backends may retry `fn` on transient conflicts, so it should only issue ledger writes. */
  transaction<T>(fn: () => Promise<T> | T): Promise<T>;

  appendEvent(eventKey: string, type: string, entityId: string, payload: unknown): Promise<number>;
  eventsSince(seq: number, limit?: number): Promise<EventRow[]>;
  findEvent(eventKey: string): Promise<EventRow | undefined>;
  lastEventSeq(): Promise<number>;

  createMission(row: NewMissionRow): Promise<void>;
  getMission(missionId: string): Promise<MissionRow | undefined>;
  updateMission(missionId: string, patch: MissionPatch): Promise<void>;

  upsertTask(task: TaskRow): Promise<void>;
  listTasks(missionId: string): Promise<TaskRow[]>;

  insertExperiment(e: NewExperimentRow): Promise<void>;
  updateExperiment(experimentId: string, patch: ExperimentPatch): Promise<void>;
  getExperiment(experimentId: string): Promise<ExperimentRow | undefined>;
  listExperiments(missionId: string): Promise<ExperimentRow[]>;

  insertArtifact(a: ArtifactRow): Promise<void>;
  getArtifact(hash: string): Promise<ArtifactRow | undefined>;
  insertVerification(report: VerificationReport, path: string): Promise<void>;
  findVerification(
    experimentId: string,
    artifactHash: string,
    suite: string,
  ): Promise<VerificationRow | undefined>;
  listVerifications(missionId: string): Promise<VerificationRow[]>;

  insertEpisode(e: EpisodeRow): Promise<void>;
  isIndexed(episodeId: string): Promise<boolean>;
  isSuperseded(episodeId: string): Promise<boolean>;
  currentVersionOf(episodeId: string): Promise<EpisodeRow | undefined>;
  searchEpisodes(
    missionId: string,
    query: string,
    limit: number,
    options?: { unindexedOnly?: boolean },
  ): Promise<EpisodeRow[]>;
  termWeights(terms: string[]): Promise<Map<string, number>>;
  getEpisode(episodeId: string): Promise<EpisodeRow | undefined>;
  listEpisodes(missionId: string): Promise<EpisodeRow[]>;

  upsertLesson(l: LessonRow): Promise<void>;
  listLessons(missionId: string): Promise<LessonRow[]>;
  insertLearnedScenario(
    scenarioId: string,
    missionId: string,
    lessonId: string,
    suiteVersion: number,
    path: string,
  ): Promise<void>;
  listLearnedScenarios(missionId: string): Promise<LearnedScenarioRow[]>;

  writeCheckpoint(c: NewCheckpoint): Promise<CheckpointRow>;
  latestCheckpoint(missionId: string): Promise<CheckpointRow | undefined>;
  countCheckpoints(missionId: string): Promise<number>;

  openSegment(
    missionId: string,
    ordinal: number,
    sessionPath: string | null,
    sessionId: string | null,
  ): Promise<void>;
  commitSegment(missionId: string, ordinal: number, checkpointId: string): Promise<void>;
  closeSegment(missionId: string, ordinal: number, archiveHash: string | null): Promise<void>;
  activeSegment(missionId: string): Promise<SegmentRow | undefined>;
  listSegments(missionId: string): Promise<SegmentRow[]>;
  discardUncommittedSegments(missionId: string): Promise<number>;

  registerContainer(containerName: string, missionId: string, experimentId: string): Promise<void>;
  releaseContainer(containerName: string, state?: ContainerState): Promise<void>;
  listLiveContainers(missionId: string): Promise<ContainerRow[]>;
  listContainers(missionId: string): Promise<ContainerRow[]>;

  enqueueOutbox(episodeId: string, payload: unknown): Promise<string>;
  outboxPayloadForEpisode(episodeId: string): Promise<unknown>;
  outboxPayload(key: string): Promise<unknown>;
  updateOutbox(key: string, patch: OutboxPatch): Promise<void>;
  listOutbox(states?: OutboxState[]): Promise<OutboxRow[]>;
}

export type NewMissionRow = Omit<
  MissionRow,
  | "createdAt"
  | "spentExperiments"
  | "spentInputTokens"
  | "spentOutputTokens"
  | "spentMemoryOperations"
  | "spentWallMs"
  | "usageUncertain"
  | "learnedSuiteVersion"
  | "frozenAcceptanceMargin"
>;
export type MissionPatch = Partial<Omit<MissionRow, "missionId" | "createdAt">>;
export type NewExperimentRow = Omit<
  ExperimentRow,
  | "createdAt"
  | "finishedAt"
  | "reportIds"
  | "verdict"
  | "failureSignature"
  | "candidateArtifactHash"
>;
export type ExperimentPatch = Partial<
  Pick<
    ExperimentRow,
    | "status"
    | "verdict"
    | "candidateArtifactHash"
    | "failureSignature"
    | "reportIds"
    | "finishedAt"
    | "attempt"
    | "hypothesis"
  >
>;
export interface LearnedScenarioRow {
  scenarioId: string;
  lessonId: string;
  suiteVersion: number;
  path: string;
}
export type NewCheckpoint = Omit<
  CheckpointRow,
  "checkpointId" | "seq" | "createdAt" | "lastEventSeq"
>;
export type OutboxPatch = Partial<
  Pick<OutboxRow, "state" | "remoteDocumentId" | "retries" | "nextAttemptAt" | "lastError">
>;

/**
 * Single-writer SQLite mission ledger. WAL + synchronous=FULL. Every write that
 * must be atomic with another goes through `transaction()`. Events are
 * idempotent on `event_key`.
 */
export class SqliteLedger implements Ledger {
  readonly backend = "sqlite" as const;
  readonly db: DatabaseSync;
  readonly path: string;
  get location(): string {
    return this.path;
  }
  private lockFd: number | null = null;
  private lockPath: string;
  private inTransaction = false;

  constructor(path: string) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = FULL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA);
    this.migrate();
    this.backfillEpisodeIndex();
    this.lockPath = join(dirname(path), "controller.lock");
  }

  /**
   * Single-controller lock: fails if another live controller holds it, in this
   * process or another. Stale locks from dead pids are reclaimed.
   */
  async acquireLock(): Promise<void> {
    if (this.lockFd !== null) return;
    if (HELD_LOCKS.has(this.lockPath))
      throw new Error(`another controller in this process holds ${this.lockPath}`);
    if (existsSync(this.lockPath)) {
      const pid = Number(readFileSync(this.lockPath, "utf8").trim());
      if (Number.isInteger(pid) && pid !== process.pid && isAlive(pid)) {
        throw new Error(`another controller (pid ${pid}) holds ${this.lockPath}`);
      }
      unlinkSync(this.lockPath);
    }
    this.lockFd = openSync(this.lockPath, "wx");
    writeFileSync(this.lockFd, String(process.pid));
    HELD_LOCKS.add(this.lockPath);
  }

  async releaseLock(): Promise<void> {
    if (this.lockFd !== null) {
      closeSync(this.lockFd);
      this.lockFd = null;
      HELD_LOCKS.delete(this.lockPath);
      if (existsSync(this.lockPath)) unlinkSync(this.lockPath);
    }
  }

  async close(): Promise<void> {
    await this.releaseLock();
    this.db.close();
  }

  async transaction<T>(fn: () => Promise<T> | T): Promise<T> {
    if (this.inTransaction)
      throw new Error("ledger transactions cannot nest or run concurrently on one connection");
    this.inTransaction = true;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = await fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    } finally {
      this.inTransaction = false;
    }
  }

  // ---- events -------------------------------------------------------------

  /** Append an event; a duplicate key is harmless and returns the existing seq. */
  async appendEvent(
    eventKey: string,
    type: string,
    entityId: string,
    payload: unknown,
  ): Promise<number> {
    const existing = this.db.prepare("SELECT seq FROM event WHERE event_key = ?").get(eventKey) as
      | { seq: number }
      | undefined;
    if (existing) return existing.seq;
    const result = this.db
      .prepare("INSERT INTO event (event_key, at, type, entity_id, payload) VALUES (?, ?, ?, ?, ?)")
      .run(eventKey, now(), type, entityId, canonicalJson(payload));
    return Number(result.lastInsertRowid);
  }

  async eventsSince(seq: number, limit = 1000): Promise<EventRow[]> {
    const rows = this.db
      .prepare("SELECT * FROM event WHERE seq > ? ORDER BY seq LIMIT ?")
      .all(seq, limit) as Row[];
    return rows.map((r) => ({
      seq: Number(r.seq),
      eventKey: String(r.event_key),
      at: String(r.at),
      type: String(r.type),
      entityId: String(r.entity_id),
      payload: JSON.parse(String(r.payload)),
    }));
  }

  async findEvent(eventKey: string): Promise<EventRow | undefined> {
    const r = this.db.prepare("SELECT * FROM event WHERE event_key = ?").get(eventKey) as
      | Row
      | undefined;
    return r
      ? {
          seq: Number(r.seq),
          eventKey: String(r.event_key),
          at: String(r.at),
          type: String(r.type),
          entityId: String(r.entity_id),
          payload: JSON.parse(String(r.payload)),
        }
      : undefined;
  }

  async lastEventSeq(): Promise<number> {
    return this.lastEventSeqSync();
  }

  private lastEventSeqSync(): number {
    const row = this.db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM event").get() as {
      seq: number;
    };
    return Number(row.seq);
  }

  // ---- mission ------------------------------------------------------------

  async createMission(row: NewMissionRow): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO mission (mission_id, contract_version, contract_hash, evaluator_hash, environment_hash, status, seed_artifact_hash,
				 baseline_p95_ms, best_artifact_hash, best_p95_ms, active_task_id, next_wake_at, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.missionId,
        row.contractVersion,
        row.contractHash,
        row.evaluatorHash,
        row.environmentHash,
        row.status,
        row.seedArtifactHash,
        row.baselineP95Ms,
        row.bestArtifactHash,
        row.bestP95Ms,
        row.activeTaskId,
        row.nextWakeAt,
        now(),
      );
  }

  async getMission(missionId: string): Promise<MissionRow | undefined> {
    const r = this.db.prepare("SELECT * FROM mission WHERE mission_id = ?").get(missionId) as
      | Row
      | undefined;
    if (!r) return undefined;
    return {
      missionId: String(r.mission_id),
      contractVersion: Number(r.contract_version),
      contractHash: String(r.contract_hash),
      evaluatorHash: String(r.evaluator_hash),
      environmentHash: String(r.environment_hash),
      status: r.status as MissionStatus,
      seedArtifactHash: nullableString(r.seed_artifact_hash),
      baselineP95Ms: nullableNumber(r.baseline_p95_ms),
      frozenAcceptanceMargin: nullableNumber(r.frozen_acceptance_margin),
      bestArtifactHash: nullableString(r.best_artifact_hash),
      bestP95Ms: nullableNumber(r.best_p95_ms),
      activeTaskId: nullableString(r.active_task_id),
      spentExperiments: Number(r.spent_experiments),
      spentInputTokens: Number(r.spent_input_tokens),
      spentOutputTokens: Number(r.spent_output_tokens),
      spentMemoryOperations: Number(r.spent_memory_operations),
      spentWallMs: Number(r.spent_wall_ms),
      usageUncertain: Number(r.usage_uncertain),
      learnedSuiteVersion: Number(r.learned_suite_version),
      nextWakeAt: nullableString(r.next_wake_at),
      createdAt: String(r.created_at),
    };
  }

  async updateMission(
    missionId: string,
    patch: Partial<Omit<MissionRow, "missionId" | "createdAt">>,
  ): Promise<void> {
    const columns: Record<string, string> = {
      status: "status",
      seedArtifactHash: "seed_artifact_hash",
      baselineP95Ms: "baseline_p95_ms",
      frozenAcceptanceMargin: "frozen_acceptance_margin",
      bestArtifactHash: "best_artifact_hash",
      bestP95Ms: "best_p95_ms",
      activeTaskId: "active_task_id",
      spentExperiments: "spent_experiments",
      spentInputTokens: "spent_input_tokens",
      spentOutputTokens: "spent_output_tokens",
      spentMemoryOperations: "spent_memory_operations",
      spentWallMs: "spent_wall_ms",
      usageUncertain: "usage_uncertain",
      learnedSuiteVersion: "learned_suite_version",
      nextWakeAt: "next_wake_at",
      evaluatorHash: "evaluator_hash",
      environmentHash: "environment_hash",
      contractHash: "contract_hash",
      contractVersion: "contract_version",
    };
    const sets: string[] = [];
    const values: (string | number | null)[] = [];
    for (const [key, value] of Object.entries(patch)) {
      const column = columns[key];
      if (!column || value === undefined) continue;
      sets.push(`${column} = ?`);
      values.push(value as string | number | null);
    }
    if (sets.length === 0) return;
    values.push(missionId);
    this.db.prepare(`UPDATE mission SET ${sets.join(", ")} WHERE mission_id = ?`).run(...values);
  }

  // ---- tasks --------------------------------------------------------------

  async upsertTask(task: TaskRow): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO task (task_id, mission_id, ordinal, depends_on, status, hypothesis, completion_criteria, next_action)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(task_id) DO UPDATE SET status = excluded.status, hypothesis = excluded.hypothesis, next_action = excluded.next_action`,
      )
      .run(
        task.taskId,
        task.missionId,
        task.ordinal,
        JSON.stringify(task.dependsOn),
        task.status,
        task.hypothesis,
        task.completionCriteria,
        task.nextAction,
      );
  }

  async listTasks(missionId: string): Promise<TaskRow[]> {
    const rows = this.db
      .prepare("SELECT * FROM task WHERE mission_id = ? ORDER BY ordinal")
      .all(missionId) as Row[];
    return rows.map((r) => ({
      taskId: String(r.task_id),
      missionId: String(r.mission_id),
      ordinal: Number(r.ordinal),
      dependsOn: JSON.parse(String(r.depends_on)) as string[],
      status: r.status as TaskRow["status"],
      hypothesis: String(r.hypothesis),
      completionCriteria: String(r.completion_criteria),
      nextAction: String(r.next_action),
    }));
  }

  // ---- experiments --------------------------------------------------------

  async insertExperiment(
    e: Omit<
      ExperimentRow,
      | "createdAt"
      | "finishedAt"
      | "reportIds"
      | "verdict"
      | "failureSignature"
      | "candidateArtifactHash"
    >,
  ): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO experiment (experiment_id, mission_id, task_id, parent_artifact_hash, strategy, hypothesis, status, attempt, segment_ordinal, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        e.experimentId,
        e.missionId,
        e.taskId,
        e.parentArtifactHash,
        e.strategy,
        e.hypothesis,
        e.status,
        e.attempt,
        e.segmentOrdinal,
        now(),
      );
  }

  async updateExperiment(
    experimentId: string,
    patch: Partial<
      Pick<
        ExperimentRow,
        | "status"
        | "verdict"
        | "candidateArtifactHash"
        | "failureSignature"
        | "reportIds"
        | "finishedAt"
        | "attempt"
        | "hypothesis"
      >
    >,
  ): Promise<void> {
    const sets: string[] = [];
    const values: (string | number | null)[] = [];
    if (patch.hypothesis !== undefined) {
      sets.push("hypothesis = ?");
      values.push(patch.hypothesis);
    }
    if (patch.status !== undefined) {
      sets.push("status = ?");
      values.push(patch.status);
    }
    if (patch.verdict !== undefined) {
      sets.push("verdict = ?");
      values.push(patch.verdict);
    }
    if (patch.candidateArtifactHash !== undefined) {
      sets.push("candidate_artifact_hash = ?");
      values.push(patch.candidateArtifactHash);
    }
    if (patch.failureSignature !== undefined) {
      sets.push("failure_signature = ?");
      values.push(patch.failureSignature);
    }
    if (patch.reportIds !== undefined) {
      sets.push("report_ids = ?");
      values.push(JSON.stringify(patch.reportIds));
    }
    if (patch.finishedAt !== undefined) {
      sets.push("finished_at = ?");
      values.push(patch.finishedAt);
    }
    if (patch.attempt !== undefined) {
      sets.push("attempt = ?");
      values.push(patch.attempt);
    }
    if (sets.length === 0) return;
    values.push(experimentId);
    this.db
      .prepare(`UPDATE experiment SET ${sets.join(", ")} WHERE experiment_id = ?`)
      .run(...values);
  }

  async getExperiment(experimentId: string): Promise<ExperimentRow | undefined> {
    const r = this.db
      .prepare("SELECT * FROM experiment WHERE experiment_id = ?")
      .get(experimentId) as Row | undefined;
    return r ? toExperiment(r) : undefined;
  }

  async listExperiments(missionId: string): Promise<ExperimentRow[]> {
    return (
      this.db
        .prepare("SELECT * FROM experiment WHERE mission_id = ? ORDER BY created_at, experiment_id")
        .all(missionId) as Row[]
    ).map(toExperiment);
  }

  // ---- artifacts / verification ------------------------------------------

  async insertArtifact(a: ArtifactRow): Promise<void> {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO artifact (hash, path, parent_hash, manifest_hash, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(a.hash, a.path, a.parentHash, a.manifestHash, a.createdAt);
  }

  async getArtifact(hash: string): Promise<ArtifactRow | undefined> {
    const r = this.db.prepare("SELECT * FROM artifact WHERE hash = ?").get(hash) as Row | undefined;
    return r
      ? {
          hash: String(r.hash),
          path: String(r.path),
          parentHash: nullableString(r.parent_hash),
          manifestHash: String(r.manifest_hash),
          createdAt: String(r.created_at),
        }
      : undefined;
  }

  async insertVerification(report: VerificationReport, path: string): Promise<void> {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO verification (report_id, report_hash, mission_id, experiment_id, artifact_hash, suite, status, evaluator_hash, workload_hash, environment_hash, p95_latency_ms, path)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        report.reportId,
        reportHash(report),
        report.missionId,
        report.experimentId,
        report.artifactHash,
        report.suite,
        report.status,
        report.evaluatorHash,
        report.workloadHash,
        report.environmentHash,
        report.metrics.p95LatencyMs ?? null,
        path,
      );
  }

  async findVerification(
    experimentId: string,
    artifactHash: string,
    suite: string,
  ): Promise<VerificationRow | undefined> {
    const r = this.db
      .prepare(
        "SELECT * FROM verification WHERE experiment_id = ? AND artifact_hash = ? AND suite = ?",
      )
      .get(experimentId, artifactHash, suite) as Row | undefined;
    return r ? toVerification(r) : undefined;
  }

  async listVerifications(missionId: string): Promise<VerificationRow[]> {
    return (
      this.db
        .prepare("SELECT * FROM verification WHERE mission_id = ? ORDER BY rowid")
        .all(missionId) as Row[]
    ).map(toVerification);
  }

  // ---- episodes / lessons -------------------------------------------------

  async insertEpisode(e: EpisodeRow): Promise<void> {
    const inserted = this.db
      .prepare(
        `INSERT OR IGNORE INTO episode (episode_id, mission_id, experiment_id, version, supersedes, feature_ids, invariant_ids, artifact_hash, parent_artifact_hash, interpretation, evidence_ids, summary, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        e.episodeId,
        e.missionId,
        e.experimentId,
        e.version,
        e.supersedes,
        JSON.stringify(e.featureIds),
        JSON.stringify(e.invariantIds),
        e.artifactHash,
        e.parentArtifactHash,
        e.interpretation,
        JSON.stringify(e.evidenceIds),
        e.summary,
        e.createdAt,
      );
    if (Number(inserted.changes) > 0)
      this.db
        .prepare("INSERT INTO episode_fts (episode_id, mission_id, summary) VALUES (?, ?, ?)")
        .run(e.episodeId, e.missionId, e.summary);
  }

  /** Additive column migrations for ledgers created by earlier schema revisions. */
  private migrate(): void {
    const columns = new Set(
      (this.db.prepare("PRAGMA table_info(mission)").all() as { name: string }[]).map(
        (c) => c.name,
      ),
    );
    if (!columns.has("frozen_acceptance_margin"))
      this.db.exec("ALTER TABLE mission ADD COLUMN frozen_acceptance_margin REAL");
  }

  private backfillEpisodeIndex(): void {
    const episodes = Number(
      (this.db.prepare("SELECT COUNT(*) AS n FROM episode").get() as { n: number }).n,
    );
    const indexed = Number(
      (this.db.prepare("SELECT COUNT(*) AS n FROM episode_fts").get() as { n: number }).n,
    );
    if (episodes === indexed) return;
    this.db.exec(
      "DELETE FROM episode_fts; INSERT INTO episode_fts (episode_id, mission_id, summary) SELECT episode_id, mission_id, summary FROM episode;",
    );
  }

  /** True once the remote memory service reported this episode's document as ready. */
  async isIndexed(episodeId: string): Promise<boolean> {
    return (
      this.db
        .prepare("SELECT 1 FROM outbox WHERE episode_id = ? AND state = 'memory_ready' LIMIT 1")
        .get(episodeId) !== undefined
    );
  }

  async isSuperseded(episodeId: string): Promise<boolean> {
    return (
      this.db.prepare("SELECT 1 FROM episode WHERE supersedes = ? LIMIT 1").get(episodeId) !==
      undefined
    );
  }

  /** Follows the supersession chain from `episodeId` to its newest version. */
  async currentVersionOf(episodeId: string): Promise<EpisodeRow | undefined> {
    let current = await this.getEpisode(episodeId);
    for (let hops = 0; current && hops < 64; hops += 1) {
      const next = this.db
        .prepare("SELECT * FROM episode WHERE supersedes = ? ORDER BY version DESC LIMIT 1")
        .get(current.episodeId) as Row | undefined;
      if (!next) return current;
      current = toEpisode(next);
    }
    return current;
  }

  /**
   * Local full-text search over this mission's episode summaries. With
   * `unindexedOnly`, only episodes whose memory delivery is not yet ready.
   */
  async searchEpisodes(
    missionId: string,
    query: string,
    limit: number,
    options: { unindexedOnly?: boolean } = {},
  ): Promise<EpisodeRow[]> {
    const terms = this.selectiveTerms([
      ...new Set(
        query
          .toLowerCase()
          .split(/[^\p{L}\p{N}_]+/u)
          .filter(Boolean),
      ),
    ]);
    if (terms.length === 0 || limit <= 0) return [];
    const match = terms.map((t) => `"${t.replaceAll('"', '""')}"`).join(" OR ");
    const pending = options.unindexedOnly
      ? "AND NOT EXISTS (SELECT 1 FROM outbox o WHERE o.episode_id = e.episode_id AND o.state = 'memory_ready')"
      : "";
    const rows = this.db
      .prepare(
        `SELECT e.* FROM episode_fts f JOIN episode e ON e.episode_id = f.episode_id WHERE episode_fts MATCH ? AND f.mission_id = ? ${pending} ORDER BY bm25(episode_fts) LIMIT ?`,
      )
      .all(match, missionId, limit) as Row[];
    return rows.map(toEpisode);
  }

  /** Inverse document frequency of each term over this ledger's episodes. */
  async termWeights(terms: string[]): Promise<Map<string, number>> {
    const total = Number(
      (this.db.prepare("SELECT COUNT(*) AS n FROM episode").get() as { n: number }).n,
    );
    const counts = this.db.prepare("SELECT doc FROM episode_fts_vocab WHERE term = ?");
    return new Map(
      terms.map((t) => [
        t,
        Math.log(
          (total + 1) / (Number((counts.get(t) as { doc: number } | undefined)?.doc ?? 0) + 1),
        ) + 0.01,
      ]),
    );
  }

  /**
   * Drops query terms that occur in more than a fifth of all episodes when at
   * least one rarer term remains, so a search costs the rare terms' postings
   * rather than a scan of the whole history.
   */
  private selectiveTerms(terms: string[]): string[] {
    if (terms.length <= 1) return terms;
    const total = Number(
      (this.db.prepare("SELECT COUNT(*) AS n FROM episode").get() as { n: number }).n,
    );
    const counts = this.db.prepare("SELECT doc FROM episode_fts_vocab WHERE term = ?");
    const rare = terms.filter(
      (t) =>
        Number((counts.get(t) as { doc: number } | undefined)?.doc ?? 0) <= Math.max(50, total / 5),
    );
    return rare.length > 0 ? rare : terms;
  }

  async getEpisode(episodeId: string): Promise<EpisodeRow | undefined> {
    const r = this.db.prepare("SELECT * FROM episode WHERE episode_id = ?").get(episodeId) as
      | Row
      | undefined;
    return r ? toEpisode(r) : undefined;
  }

  async listEpisodes(missionId: string): Promise<EpisodeRow[]> {
    return (
      this.db
        .prepare("SELECT * FROM episode WHERE mission_id = ? ORDER BY created_at")
        .all(missionId) as Row[]
    ).map(toEpisode);
  }

  async upsertLesson(l: LessonRow): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO lesson (lesson_id, mission_id, source_episode_ids, invariant_id, state, proposal, positive_evidence_id, negative_evidence_id, materialized_scenario_id, transitions)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(lesson_id) DO UPDATE SET state = excluded.state, positive_evidence_id = excluded.positive_evidence_id,
				 negative_evidence_id = excluded.negative_evidence_id, materialized_scenario_id = excluded.materialized_scenario_id, transitions = excluded.transitions`,
      )
      .run(
        l.lessonId,
        l.missionId,
        JSON.stringify(l.sourceEpisodeIds),
        l.invariantId,
        l.state,
        l.proposal,
        l.positiveEvidenceId,
        l.negativeEvidenceId,
        l.materializedScenarioId,
        JSON.stringify(l.transitions),
      );
  }

  async listLessons(missionId: string): Promise<LessonRow[]> {
    const rows = this.db
      .prepare("SELECT * FROM lesson WHERE mission_id = ? ORDER BY rowid")
      .all(missionId) as Row[];
    return rows.map((r) => ({
      lessonId: String(r.lesson_id),
      missionId: String(r.mission_id),
      sourceEpisodeIds: JSON.parse(String(r.source_episode_ids)) as string[],
      invariantId: String(r.invariant_id),
      state: r.state as LessonState,
      proposal: String(r.proposal),
      positiveEvidenceId: nullableString(r.positive_evidence_id),
      negativeEvidenceId: nullableString(r.negative_evidence_id),
      materializedScenarioId: nullableString(r.materialized_scenario_id),
      transitions: JSON.parse(String(r.transitions)) as LessonRow["transitions"],
    }));
  }

  async insertLearnedScenario(
    scenarioId: string,
    missionId: string,
    lessonId: string,
    suiteVersion: number,
    path: string,
  ): Promise<void> {
    this.db
      .prepare(
        "INSERT INTO learned_scenario (scenario_id, mission_id, lesson_id, suite_version, path) VALUES (?, ?, ?, ?, ?)",
      )
      .run(scenarioId, missionId, lessonId, suiteVersion, path);
  }

  async listLearnedScenarios(
    missionId: string,
  ): Promise<{ scenarioId: string; lessonId: string; suiteVersion: number; path: string }[]> {
    const rows = this.db
      .prepare("SELECT * FROM learned_scenario WHERE mission_id = ? ORDER BY suite_version")
      .all(missionId) as Row[];
    return rows.map((r) => ({
      scenarioId: String(r.scenario_id),
      lessonId: String(r.lesson_id),
      suiteVersion: Number(r.suite_version),
      path: String(r.path),
    }));
  }

  // ---- checkpoints / segments / outbox -----------------------------------

  async writeCheckpoint(
    c: Omit<CheckpointRow, "checkpointId" | "seq" | "createdAt" | "lastEventSeq">,
  ): Promise<CheckpointRow> {
    const seqRow = this.db
      .prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM checkpoint")
      .get() as { seq: number };
    const seq = Number(seqRow.seq);
    const checkpointId = `ckpt-${c.missionId}-${String(seq).padStart(6, "0")}`;
    const lastEventSeq = this.lastEventSeqSync();
    const createdAt = now();
    this.db
      .prepare(
        `INSERT INTO checkpoint (checkpoint_id, seq, mission_id, mission_status, active_task_id, active_experiment_id, active_operation, last_event_seq, segment_ordinal, best_artifact_hash, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        checkpointId,
        seq,
        c.missionId,
        c.missionStatus,
        c.activeTaskId,
        c.activeExperimentId,
        c.activeOperation,
        lastEventSeq,
        c.segmentOrdinal,
        c.bestArtifactHash,
        createdAt,
      );
    return { ...c, checkpointId, seq, lastEventSeq, createdAt };
  }

  async latestCheckpoint(missionId: string): Promise<CheckpointRow | undefined> {
    const r = this.db
      .prepare("SELECT * FROM checkpoint WHERE mission_id = ? ORDER BY seq DESC LIMIT 1")
      .get(missionId) as Row | undefined;
    if (!r) return undefined;
    return {
      checkpointId: String(r.checkpoint_id),
      seq: Number(r.seq),
      missionId: String(r.mission_id),
      missionStatus: r.mission_status as MissionStatus,
      activeTaskId: nullableString(r.active_task_id),
      activeExperimentId: nullableString(r.active_experiment_id),
      activeOperation: nullableString(r.active_operation),
      lastEventSeq: Number(r.last_event_seq),
      segmentOrdinal: Number(r.segment_ordinal),
      bestArtifactHash: nullableString(r.best_artifact_hash),
      createdAt: String(r.created_at),
    };
  }

  async countCheckpoints(missionId: string): Promise<number> {
    return Number(
      (
        this.db
          .prepare("SELECT COUNT(*) AS n FROM checkpoint WHERE mission_id = ?")
          .get(missionId) as { n: number }
      ).n,
    );
  }

  async openSegment(
    missionId: string,
    ordinal: number,
    sessionPath: string | null,
    sessionId: string | null,
  ): Promise<void> {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO segment (mission_id, ordinal, session_path, session_id, checkpoint_id, started_at, first_event_seq, committed) VALUES (?, ?, ?, ?, NULL, ?, ?, 0)",
      )
      .run(missionId, ordinal, sessionPath, sessionId, now(), this.lastEventSeqSync());
  }

  async commitSegment(missionId: string, ordinal: number, checkpointId: string): Promise<void> {
    this.db
      .prepare(
        "UPDATE segment SET committed = 1, checkpoint_id = ? WHERE mission_id = ? AND ordinal = ?",
      )
      .run(checkpointId, missionId, ordinal);
  }

  async closeSegment(
    missionId: string,
    ordinal: number,
    archiveHash: string | null,
  ): Promise<void> {
    this.db
      .prepare(
        "UPDATE segment SET closed_at = ?, last_event_seq = ?, archive_hash = ? WHERE mission_id = ? AND ordinal = ?",
      )
      .run(now(), this.lastEventSeqSync(), archiveHash, missionId, ordinal);
  }

  async activeSegment(missionId: string): Promise<SegmentRow | undefined> {
    const r = this.db
      .prepare(
        "SELECT * FROM segment WHERE mission_id = ? AND committed = 1 AND closed_at IS NULL ORDER BY ordinal DESC LIMIT 1",
      )
      .get(missionId) as Row | undefined;
    return r ? toSegment(r) : undefined;
  }

  async listSegments(missionId: string): Promise<SegmentRow[]> {
    return (
      this.db
        .prepare("SELECT * FROM segment WHERE mission_id = ? ORDER BY ordinal")
        .all(missionId) as Row[]
    ).map(toSegment);
  }

  async discardUncommittedSegments(missionId: string): Promise<number> {
    return Number(
      this.db.prepare("DELETE FROM segment WHERE mission_id = ? AND committed = 0").run(missionId)
        .changes,
    );
  }

  // ---- execution environments -------------------------------------------

  /** Durable record written before `docker run`, so a crashed controller's container can be found on resume. */
  async registerContainer(
    containerName: string,
    missionId: string,
    experimentId: string,
  ): Promise<void> {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO container (container_name, mission_id, experiment_id, state, created_at) VALUES (?, ?, ?, 'launching', ?)",
      )
      .run(containerName, missionId, experimentId, now());
  }

  async releaseContainer(containerName: string, state: ContainerState = "released"): Promise<void> {
    this.db
      .prepare(
        "UPDATE container SET state = ?, released_at = ? WHERE container_name = ? AND state = 'launching'",
      )
      .run(state, now(), containerName);
  }

  /** Containers whose stop was never recorded: candidates for orphan cleanup. */
  async listLiveContainers(missionId: string): Promise<ContainerRow[]> {
    return (
      this.db
        .prepare(
          "SELECT * FROM container WHERE mission_id = ? AND state = 'launching' ORDER BY created_at, container_name",
        )
        .all(missionId) as Row[]
    ).map(toContainer);
  }

  async listContainers(missionId: string): Promise<ContainerRow[]> {
    return (
      this.db
        .prepare("SELECT * FROM container WHERE mission_id = ? ORDER BY created_at, container_name")
        .all(missionId) as Row[]
    ).map(toContainer);
  }

  async enqueueOutbox(episodeId: string, payload: unknown): Promise<string> {
    const payloadHash = sha256(canonicalJson(payload));
    const idempotencyKey = `${episodeId}:${payloadHash.slice(0, 16)}`;
    this.db
      .prepare(
        "INSERT OR IGNORE INTO outbox (idempotency_key, episode_id, payload_hash, payload, state, retries, next_attempt_at, updated_at) VALUES (?, ?, ?, ?, 'pending', 0, ?, ?)",
      )
      .run(idempotencyKey, episodeId, payloadHash, JSON.stringify(payload), now(), now());
    return idempotencyKey;
  }

  async outboxPayloadForEpisode(episodeId: string): Promise<unknown> {
    const r = this.db
      .prepare("SELECT payload FROM outbox WHERE episode_id = ? ORDER BY rowid DESC LIMIT 1")
      .get(episodeId) as { payload: string } | undefined;
    return r ? JSON.parse(r.payload) : undefined;
  }

  async outboxPayload(key: string): Promise<unknown> {
    const r = this.db.prepare("SELECT payload FROM outbox WHERE idempotency_key = ?").get(key) as
      | { payload: string }
      | undefined;
    return r ? JSON.parse(r.payload) : undefined;
  }

  async updateOutbox(
    key: string,
    patch: Partial<
      Pick<OutboxRow, "state" | "remoteDocumentId" | "retries" | "nextAttemptAt" | "lastError">
    >,
  ): Promise<void> {
    const sets = ["updated_at = ?"];
    const values: (string | number | null)[] = [now()];
    if (patch.state !== undefined) {
      sets.push("state = ?");
      values.push(patch.state);
    }
    if (patch.remoteDocumentId !== undefined) {
      sets.push("remote_document_id = ?");
      values.push(patch.remoteDocumentId);
    }
    if (patch.retries !== undefined) {
      sets.push("retries = ?");
      values.push(patch.retries);
    }
    if (patch.nextAttemptAt !== undefined) {
      sets.push("next_attempt_at = ?");
      values.push(patch.nextAttemptAt);
    }
    if (patch.lastError !== undefined) {
      sets.push("last_error = ?");
      values.push(patch.lastError);
    }
    values.push(key);
    this.db
      .prepare(`UPDATE outbox SET ${sets.join(", ")} WHERE idempotency_key = ?`)
      .run(...values);
  }

  async listOutbox(states?: OutboxState[]): Promise<OutboxRow[]> {
    const rows = (
      states
        ? this.db
            .prepare(
              `SELECT * FROM outbox WHERE state IN (${states.map(() => "?").join(",")}) ORDER BY next_attempt_at`,
            )
            .all(...states)
        : this.db.prepare("SELECT * FROM outbox ORDER BY rowid").all()
    ) as Row[];
    return rows.map((r) => ({
      idempotencyKey: String(r.idempotency_key),
      episodeId: String(r.episode_id),
      payloadHash: String(r.payload_hash),
      remoteDocumentId: nullableString(r.remote_document_id),
      state: r.state as OutboxState,
      retries: Number(r.retries),
      nextAttemptAt: String(r.next_attempt_at),
      lastError: nullableString(r.last_error),
      updatedAt: String(r.updated_at),
    }));
  }
}

/** Lock files held by ledgers in this process; the pid check alone cannot tell them apart. */
const HELD_LOCKS = new Set<string>();

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function nullableString(v: Cell): string | null {
  return v === null || v === undefined ? null : String(v);
}

function nullableNumber(v: Cell): number | null {
  return v === null || v === undefined ? null : Number(v);
}

function toContainer(r: Row): ContainerRow {
  return {
    containerName: String(r.container_name),
    missionId: String(r.mission_id),
    experimentId: String(r.experiment_id),
    state: String(r.state) as ContainerState,
    createdAt: String(r.created_at),
    releasedAt: r.released_at == null ? null : String(r.released_at),
  };
}

function toExperiment(r: Row): ExperimentRow {
  return {
    experimentId: String(r.experiment_id),
    missionId: String(r.mission_id),
    taskId: String(r.task_id),
    parentArtifactHash: String(r.parent_artifact_hash),
    candidateArtifactHash: nullableString(r.candidate_artifact_hash),
    strategy: String(r.strategy),
    hypothesis: String(r.hypothesis),
    status: r.status as ExperimentStatus,
    verdict: nullableString(r.verdict),
    failureSignature: nullableString(r.failure_signature),
    attempt: Number(r.attempt),
    reportIds: JSON.parse(String(r.report_ids)) as string[],
    segmentOrdinal: Number(r.segment_ordinal),
    createdAt: String(r.created_at),
    finishedAt: nullableString(r.finished_at),
  };
}

function toVerification(r: Row): VerificationRow {
  return {
    reportId: String(r.report_id),
    reportHash: String(r.report_hash),
    missionId: String(r.mission_id),
    experimentId: String(r.experiment_id),
    artifactHash: String(r.artifact_hash),
    suite: String(r.suite),
    status: String(r.status),
    evaluatorHash: String(r.evaluator_hash),
    workloadHash: String(r.workload_hash),
    environmentHash: String(r.environment_hash),
    p95LatencyMs: nullableNumber(r.p95_latency_ms),
    path: String(r.path),
  };
}

function toEpisode(r: Row): EpisodeRow {
  return {
    episodeId: String(r.episode_id),
    missionId: String(r.mission_id),
    experimentId: String(r.experiment_id),
    version: Number(r.version),
    supersedes: nullableString(r.supersedes),
    featureIds: JSON.parse(String(r.feature_ids)) as string[],
    invariantIds: JSON.parse(String(r.invariant_ids)) as string[],
    artifactHash: String(r.artifact_hash),
    parentArtifactHash: String(r.parent_artifact_hash),
    interpretation: r.interpretation as EpisodeRow["interpretation"],
    evidenceIds: JSON.parse(String(r.evidence_ids)) as string[],
    summary: String(r.summary),
    createdAt: String(r.created_at),
  };
}

function toSegment(r: Row): SegmentRow {
  return {
    missionId: String(r.mission_id),
    ordinal: Number(r.ordinal),
    sessionPath: nullableString(r.session_path),
    sessionId: nullableString(r.session_id),
    checkpointId: nullableString(r.checkpoint_id),
    startedAt: String(r.started_at),
    closedAt: nullableString(r.closed_at),
    firstEventSeq: Number(r.first_event_seq),
    lastEventSeq: nullableNumber(r.last_event_seq),
    archiveHash: nullableString(r.archive_hash),
    committed: Number(r.committed),
  };
}
