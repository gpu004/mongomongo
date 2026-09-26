import type { VerificationReport } from "../verification/reports.ts";
import type {
  AsyncLedger,
  ExperimentPatch,
  MissionPatch,
  NewCheckpointRow,
  NewExperimentRow,
  NewMissionRow,
  OutboxPatch,
} from "./ledger-contract.ts";
import {
  Ledger,
  LeaseError,
  type ArtifactRow,
  type ContainerState,
  type EpisodeRow,
  type LeaseRow,
  type LessonRow,
  type OutboxState,
  type TaskRow,
} from "./ledger.ts";

/**
 * `AsyncLedger` over the synchronous SQLite `Ledger`. SQLite is single-writer,
 * so the transaction handle is the same object: nested calls inside
 * `transaction()` run inside the open BEGIN IMMEDIATE block.
 */
export class SqliteLedger implements AsyncLedger {
  readonly backend = "sqlite" as const;
  readonly inner: Ledger;
  private lease: LeaseRow | undefined;

  constructor(pathOrLedger: string | Ledger) {
    this.inner = typeof pathOrLedger === "string" ? new Ledger(pathOrLedger) : pathOrLedger;
  }

  async close(): Promise<void> {
    this.inner.close();
  }

  /** Writes made while holding a lease are rejected once another owner has claimed it. */
  private guard(): void {
    const lease = this.lease;
    if (!lease) return;
    const current = this.inner.getLease(lease.missionId);
    if (!current || current.owner !== lease.owner || current.fencingToken !== lease.fencingToken)
      throw new LeaseError(`mission ${lease.missionId} lease lost by ${lease.owner}`, current);
  }

  async transaction<T>(fn: (tx: AsyncLedger) => Promise<T>): Promise<T> {
    this.inner.db.exec("BEGIN IMMEDIATE");
    try {
      const result = await fn(this);
      this.inner.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.inner.db.exec("ROLLBACK");
      throw error;
    }
  }

  async claimLease(missionId: string, owner: string, ttlMs: number, at?: Date): Promise<LeaseRow> {
    const lease = this.inner.claimLease(missionId, owner, ttlMs, at);
    this.lease = lease;
    return lease;
  }
  async renewLease(lease: LeaseRow, ttlMs: number, at?: Date): Promise<LeaseRow> {
    const renewed = this.inner.renewLease(lease, ttlMs, at);
    if (this.lease?.fencingToken === lease.fencingToken) this.lease = renewed;
    return renewed;
  }
  async releaseLease(lease: LeaseRow): Promise<void> {
    this.inner.releaseLease(lease);
    if (this.lease?.fencingToken === lease.fencingToken) this.lease = undefined;
  }
  async getLease(missionId: string) {
    return this.inner.getLease(missionId);
  }

  async appendEvent(eventKey: string, type: string, entityId: string, payload: unknown) {
    this.guard();
    return this.inner.appendEvent(eventKey, type, entityId, payload);
  }
  async eventsSince(seq: number, limit?: number) {
    return this.inner.eventsSince(seq, limit);
  }
  async findEvent(eventKey: string) {
    return this.inner.findEvent(eventKey);
  }
  async lastEventSeq() {
    return this.inner.lastEventSeq();
  }

  async createMission(row: NewMissionRow) {
    this.guard();
    this.inner.createMission(row);
  }
  async getMission(missionId: string) {
    return this.inner.getMission(missionId);
  }
  async updateMission(missionId: string, patch: MissionPatch) {
    this.guard();
    this.inner.updateMission(missionId, patch);
  }

  async upsertTask(task: TaskRow) {
    this.guard();
    this.inner.upsertTask(task);
  }
  async listTasks(missionId: string) {
    return this.inner.listTasks(missionId);
  }

  async insertExperiment(e: NewExperimentRow) {
    this.guard();
    this.inner.insertExperiment(e);
  }
  async updateExperiment(experimentId: string, patch: ExperimentPatch) {
    this.guard();
    this.inner.updateExperiment(experimentId, patch);
  }
  async getExperiment(experimentId: string) {
    return this.inner.getExperiment(experimentId);
  }
  async listExperiments(missionId: string) {
    return this.inner.listExperiments(missionId);
  }

  async insertArtifact(a: ArtifactRow) {
    this.guard();
    this.inner.insertArtifact(a);
  }
  async getArtifact(hash: string) {
    return this.inner.getArtifact(hash);
  }
  async insertVerification(report: VerificationReport, path: string) {
    this.guard();
    this.inner.insertVerification(report, path);
  }
  async findVerification(experimentId: string, artifactHash: string, suite: string) {
    return this.inner.findVerification(experimentId, artifactHash, suite);
  }
  async listVerifications(missionId: string) {
    return this.inner.listVerifications(missionId);
  }

  async insertEpisode(e: EpisodeRow) {
    this.guard();
    this.inner.insertEpisode(e);
  }
  async isIndexed(episodeId: string) {
    return this.inner.isIndexed(episodeId);
  }
  async isSuperseded(episodeId: string) {
    return this.inner.isSuperseded(episodeId);
  }
  async currentVersionOf(episodeId: string) {
    return this.inner.currentVersionOf(episodeId);
  }
  async searchEpisodes(
    missionId: string,
    query: string,
    limit: number,
    options?: { unindexedOnly?: boolean },
  ) {
    return this.inner.searchEpisodes(missionId, query, limit, options);
  }
  async termWeights(terms: string[]) {
    return this.inner.termWeights(terms);
  }
  async getEpisode(episodeId: string) {
    return this.inner.getEpisode(episodeId);
  }
  async listEpisodes(missionId: string) {
    return this.inner.listEpisodes(missionId);
  }
  async upsertLesson(l: LessonRow) {
    this.guard();
    this.inner.upsertLesson(l);
  }
  async listLessons(missionId: string) {
    return this.inner.listLessons(missionId);
  }
  async insertLearnedScenario(
    scenarioId: string,
    missionId: string,
    lessonId: string,
    suiteVersion: number,
    path: string,
  ) {
    this.guard();
    this.inner.insertLearnedScenario(scenarioId, missionId, lessonId, suiteVersion, path);
  }
  async listLearnedScenarios(missionId: string) {
    return this.inner.listLearnedScenarios(missionId);
  }

  async registerContainer(containerName: string, missionId: string, experimentId: string) {
    this.guard();
    this.inner.registerContainer(containerName, missionId, experimentId);
  }
  async releaseContainer(containerName: string, state: ContainerState = "released") {
    this.guard();
    this.inner.releaseContainer(containerName, state);
  }
  async listLiveContainers(missionId: string) {
    return this.inner.listLiveContainers(missionId);
  }
  async listContainers(missionId: string) {
    return this.inner.listContainers(missionId);
  }

  async writeCheckpoint(c: NewCheckpointRow) {
    this.guard();
    return this.inner.writeCheckpoint(c);
  }
  async latestCheckpoint(missionId: string) {
    return this.inner.latestCheckpoint(missionId);
  }
  async countCheckpoints(missionId: string) {
    return this.inner.countCheckpoints(missionId);
  }
  async openSegment(
    missionId: string,
    ordinal: number,
    sessionPath: string | null,
    sessionId: string | null,
  ) {
    this.guard();
    this.inner.openSegment(missionId, ordinal, sessionPath, sessionId);
  }
  async commitSegment(missionId: string, ordinal: number, checkpointId: string) {
    this.guard();
    this.inner.commitSegment(missionId, ordinal, checkpointId);
  }
  async closeSegment(missionId: string, ordinal: number, archiveHash: string | null) {
    this.guard();
    this.inner.closeSegment(missionId, ordinal, archiveHash);
  }
  async activeSegment(missionId: string) {
    return this.inner.activeSegment(missionId);
  }
  async listSegments(missionId: string) {
    return this.inner.listSegments(missionId);
  }
  async discardUncommittedSegments(missionId: string) {
    this.guard();
    return this.inner.discardUncommittedSegments(missionId);
  }
  async enqueueOutbox(episodeId: string, payload: unknown) {
    this.guard();
    return this.inner.enqueueOutbox(episodeId, payload);
  }
  async outboxPayloadForEpisode(episodeId: string) {
    return this.inner.outboxPayloadForEpisode(episodeId);
  }
  async outboxPayload(key: string) {
    return this.inner.outboxPayload(key);
  }
  async updateOutbox(key: string, patch: OutboxPatch) {
    this.guard();
    this.inner.updateOutbox(key, patch);
  }
  async listOutbox(states?: OutboxState[]) {
    return this.inner.listOutbox(states);
  }
}
