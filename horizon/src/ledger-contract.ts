import type { VerificationReport } from "../verification/reports.ts";
import type {
  ArtifactRow,
  CheckpointRow,
  ContainerRow,
  ContainerState,
  EpisodeRow,
  EventRow,
  ExperimentRow,
  LeaseRow,
  LessonRow,
  MissionRow,
  OutboxRow,
  OutboxState,
  SegmentRow,
  TaskRow,
  VerificationRow,
} from "./ledger.ts";

export type { LeaseRow };
export { LeaseError } from "./ledger.ts";

export interface LearnedScenarioRow {
  scenarioId: string;
  lessonId: string;
  suiteVersion: number;
  path: string;
}

/**
 * Backend-neutral, asynchronous mission ledger. `SqliteLedger` wraps the
 * synchronous `Ledger`; `MongoLedger` talks to an Atlas/MongoDB database. Both
 * are exercised by `test/ledger-contract.test.ts`.
 *
 * `transaction()` hands the callback a ledger bound to the transaction; every
 * call made through that handle commits or rolls back together. Callbacks may
 * be retried by the MongoDB driver, so they must only touch the ledger.
 */
export interface AsyncLedger {
  readonly backend: "sqlite" | "mongodb";
  close(): Promise<void>;
  transaction<T>(fn: (tx: AsyncLedger) => Promise<T>): Promise<T>;

  // lease
  claimLease(missionId: string, owner: string, ttlMs: number, at?: Date): Promise<LeaseRow>;
  renewLease(lease: LeaseRow, ttlMs: number, at?: Date): Promise<LeaseRow>;
  releaseLease(lease: LeaseRow): Promise<void>;
  getLease(missionId: string): Promise<LeaseRow | undefined>;

  // events
  appendEvent(eventKey: string, type: string, entityId: string, payload: unknown): Promise<number>;
  eventsSince(seq: number, limit?: number): Promise<EventRow[]>;
  findEvent(eventKey: string): Promise<EventRow | undefined>;
  lastEventSeq(): Promise<number>;

  // mission
  createMission(row: NewMissionRow): Promise<void>;
  getMission(missionId: string): Promise<MissionRow | undefined>;
  updateMission(missionId: string, patch: MissionPatch): Promise<void>;

  // tasks
  upsertTask(task: TaskRow): Promise<void>;
  listTasks(missionId: string): Promise<TaskRow[]>;

  // experiments
  insertExperiment(e: NewExperimentRow): Promise<void>;
  updateExperiment(experimentId: string, patch: ExperimentPatch): Promise<void>;
  getExperiment(experimentId: string): Promise<ExperimentRow | undefined>;
  listExperiments(missionId: string): Promise<ExperimentRow[]>;

  // artifacts / verification
  insertArtifact(a: ArtifactRow): Promise<void>;
  getArtifact(hash: string): Promise<ArtifactRow | undefined>;
  insertVerification(report: VerificationReport, path: string): Promise<void>;
  findVerification(
    experimentId: string,
    artifactHash: string,
    suite: string,
  ): Promise<VerificationRow | undefined>;
  listVerifications(missionId: string): Promise<VerificationRow[]>;

  // episodes / lessons
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

  // execution environments
  registerContainer(containerName: string, missionId: string, experimentId: string): Promise<void>;
  releaseContainer(containerName: string, state?: ContainerState): Promise<void>;
  listLiveContainers(missionId: string): Promise<ContainerRow[]>;
  listContainers(missionId: string): Promise<ContainerRow[]>;

  // checkpoints / segments / outbox
  writeCheckpoint(c: NewCheckpointRow): Promise<CheckpointRow>;
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
export type NewCheckpointRow = Omit<
  CheckpointRow,
  "checkpointId" | "seq" | "createdAt" | "lastEventSeq"
>;
export type OutboxPatch = Partial<
  Pick<OutboxRow, "state" | "remoteDocumentId" | "retries" | "nextAttemptAt" | "lastError">
>;
