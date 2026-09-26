import {
  MongoClient,
  MongoServerError,
  type ClientSession,
  type Collection,
  type Db,
  type Document,
  type Filter,
  type IndexDescription,
} from "mongodb";
import {
  canonicalJson,
  reportHash,
  sha256,
  type VerificationReport,
} from "../verification/reports.ts";
import type {
  AsyncLedger,
  ExperimentPatch,
  LearnedScenarioRow,
  MissionPatch,
  NewCheckpointRow,
  NewExperimentRow,
  NewMissionRow,
  OutboxPatch,
} from "./ledger-contract.ts";
import {
  LeaseError,
  type ArtifactRow,
  type CheckpointRow,
  type ContainerRow,
  type ContainerState,
  type EpisodeRow,
  type EventRow,
  type ExperimentRow,
  type LeaseRow,
  type LessonRow,
  type MissionRow,
  type OutboxRow,
  type OutboxState,
  RELEASED_AT,
  type SegmentRow,
  type TaskRow,
  type VerificationRow,
} from "./ledger.ts";
import type { MongoEnv } from "./mongo-env.ts";

export const SCHEMA_VERSION = 1;

/** Episodes considered by the backend-neutral search; older history is only reachable through Supermemory. */
export const RECENT_EPISODE_WINDOW = 500;

export const COLLECTIONS = {
  missions: "missions",
  tasks: "tasks",
  experiments: "experiments",
  artifacts: "artifacts",
  verifications: "verifications",
  episodes: "episodes",
  lessons: "lessons",
  learnedScenarios: "learnedScenarios",
  containers: "containers",
  checkpoints: "checkpoints",
  segments: "segments",
  events: "events",
  outbox: "outbox",
  leases: "leases",
  counters: "counters",
} as const;

/** Indexes every Atlas ledger database must carry; `doctor` reports any that are missing. */
export const REQUIRED_INDEXES: Record<string, IndexDescription[]> = {
  [COLLECTIONS.tasks]: [{ key: { missionId: 1, ordinal: 1 }, name: "mission_ordinal" }],
  [COLLECTIONS.experiments]: [
    { key: { missionId: 1, createdAt: 1, _id: 1 }, name: "mission_history" },
  ],
  [COLLECTIONS.verifications]: [
    {
      key: {
        experimentId: 1,
        artifactHash: 1,
        suite: 1,
        evaluatorHash: 1,
        workloadHash: 1,
        environmentHash: 1,
      },
      name: "verification_identity",
      unique: true,
    },
    { key: { missionId: 1, artifactHash: 1, suite: 1 }, name: "verification_artifact" },
  ],
  [COLLECTIONS.episodes]: [
    { key: { missionId: 1, createdAt: -1 }, name: "episode_mission" },
    { key: { supersedes: 1 }, name: "episode_supersedes" },
  ],
  [COLLECTIONS.lessons]: [{ key: { missionId: 1, createdAt: 1 }, name: "lesson_mission" }],
  [COLLECTIONS.learnedScenarios]: [
    { key: { missionId: 1, suiteVersion: 1 }, name: "scenario_mission" },
  ],
  [COLLECTIONS.containers]: [
    { key: { missionId: 1, state: 1, createdAt: 1 }, name: "container_mission_state" },
  ],
  [COLLECTIONS.checkpoints]: [
    { key: { missionId: 1, seq: 1 }, name: "checkpoint_mission_seq", unique: true },
  ],
  [COLLECTIONS.segments]: [{ key: { missionId: 1, ordinal: 1 }, name: "segment_mission" }],
  [COLLECTIONS.events]: [
    { key: { missionId: 1, seq: 1 }, name: "event_mission_seq", unique: true },
  ],
  [COLLECTIONS.outbox]: [
    { key: { missionId: 1, state: 1, nextAttemptAt: 1 }, name: "outbox_due" },
    { key: { missionId: 1, episodeId: 1, createdAt: -1 }, name: "outbox_episode" },
  ],
};

export interface MongoLedgerOptions {
  /** Server selection timeout; keeps `doctor` and tests from hanging on a bad URI. */
  timeoutMs?: number;
}

type StringDoc = Document & { _id: string };
type Doc<T> = T & { _id: string; missionId: string; schemaVersion: number };

function now(): string {
  return new Date().toISOString();
}

function isDuplicateKey(error: unknown): boolean {
  return error instanceof MongoServerError && error.code === 11000;
}

function strip<T>(doc: Document | null): T | undefined {
  if (!doc) return undefined;
  const { _id, schemaVersion, createdOrdinal, ...rest } = doc;
  void _id;
  void schemaVersion;
  void createdOrdinal;
  return rest as T;
}

/**
 * MongoDB/Atlas `AsyncLedger`. One instance is scoped to one mission (the
 * SQLite ledger is one file per mission, so events, checkpoints and outbox
 * rows carry `missionId` here to keep the same shape). Sequence numbers come
 * from `counters` inside the same transaction as the row they number.
 */
export class MongoLedger implements AsyncLedger {
  readonly backend = "mongodb" as const;
  readonly missionId: string;
  readonly db: Db;
  private readonly client: MongoClient;
  private readonly ownsClient: boolean;
  private readonly session: ClientSession | undefined;
  private readonly ctx: { lease: LeaseRow | undefined };

  constructor(
    client: MongoClient,
    dbName: string,
    missionId: string,
    internals?: {
      ownsClient?: boolean;
      session?: ClientSession;
      ctx?: { lease: LeaseRow | undefined };
    },
  ) {
    this.client = client;
    this.db = client.db(dbName);
    this.missionId = missionId;
    this.ownsClient = internals?.ownsClient ?? false;
    this.session = internals?.session;
    this.ctx = internals?.ctx ?? { lease: undefined };
  }

  static async connect(
    env: MongoEnv,
    missionId: string,
    options: MongoLedgerOptions = {},
  ): Promise<MongoLedger> {
    const client = new MongoClient(env.uri, {
      serverSelectionTimeoutMS: options.timeoutMs ?? 5000,
      appName: "horizon",
    });
    await client.connect();
    const ledger = new MongoLedger(client, env.db, missionId, { ownsClient: true });
    await ledger.ensureIndexes();
    return ledger;
  }

  async ensureIndexes(): Promise<void> {
    for (const [name, indexes] of Object.entries(REQUIRED_INDEXES))
      await this.db.collection(name).createIndexes(indexes);
  }

  /** Names of required indexes that do not exist yet, per collection. */
  async missingIndexes(): Promise<string[]> {
    const missing: string[] = [];
    for (const [name, indexes] of Object.entries(REQUIRED_INDEXES)) {
      const existing = new Set(
        (
          await this.db
            .collection(name)
            .listIndexes()
            .toArray()
            .catch(() => [])
        ).map((i: Document) => String(i.name)),
      );
      for (const index of indexes)
        if (!existing.has(String(index.name))) missing.push(`${name}.${String(index.name)}`);
    }
    return missing;
  }

  async close(): Promise<void> {
    if (this.ownsClient) await this.client.close();
  }

  async transaction<T>(fn: (tx: AsyncLedger) => Promise<T>): Promise<T> {
    if (this.session) return fn(this);
    return this.client.withSession(async (session) => {
      let result!: T;
      await session.withTransaction(async () => {
        result = await fn(
          new MongoLedger(this.client, this.db.databaseName, this.missionId, {
            session,
            ctx: this.ctx,
          }),
        );
      });
      return result;
    });
  }

  private col(name: string): Collection<StringDoc> {
    return this.db.collection<StringDoc>(name);
  }

  private get opts() {
    return this.session ? { session: this.session } : {};
  }

  private scoped(filter: Filter<StringDoc>): Filter<StringDoc> {
    return { ...filter, missionId: this.missionId };
  }

  private async atomically<T>(fn: (tx: MongoLedger) => Promise<T>): Promise<T> {
    if (this.session) return fn(this);
    return this.transaction((tx) => fn(tx as MongoLedger));
  }

  /** Insert-if-absent by `_id`; a duplicate is harmless like SQLite `INSERT OR IGNORE`. */
  private async insertIgnore(name: string, filter: Document, doc: Document): Promise<boolean> {
    try {
      const result = await this.col(name).updateOne(
        filter,
        { $setOnInsert: { ...doc, schemaVersion: SCHEMA_VERSION } },
        { upsert: true, ...this.opts },
      );
      return result.upsertedCount > 0;
    } catch (error) {
      if (isDuplicateKey(error) && !this.session) return false;
      throw error;
    }
  }

  private async nextSeq(counter: string): Promise<number> {
    const doc = await this.col(COLLECTIONS.counters).findOneAndUpdate(
      { _id: `${this.missionId}:${counter}` },
      { $inc: { value: 1 } },
      { upsert: true, returnDocument: "after", ...this.opts },
    );
    return Number(doc?.value ?? 0);
  }

  private async currentSeq(counter: string): Promise<number> {
    const doc = await this.col(COLLECTIONS.counters).findOne(
      { _id: `${this.missionId}:${counter}` },
      this.opts,
    );
    return Number(doc?.value ?? 0);
  }

  /**
   * Writes made while holding a lease are fenced: if the lease document no
   * longer carries this owner's fencing token, the write is rejected. The
   * check is a conditional write so that, inside a transaction, a concurrent
   * takeover of the lease document conflicts with the mutation.
   */
  private async assertLease(): Promise<void> {
    const lease = this.ctx.lease;
    if (!lease) return;
    const result = await this.col(COLLECTIONS.leases).updateOne(
      { _id: lease.missionId, owner: lease.owner, fencingToken: lease.fencingToken },
      { $inc: { fencedWrites: 1 } },
      this.opts,
    );
    if (result.matchedCount === 0)
      throw new LeaseError(
        `mission ${lease.missionId} lease lost by ${lease.owner}`,
        await this.getLease(lease.missionId),
      );
  }

  /**
   * Runs a mutation in the same transaction as the lease check. The check is
   * itself a conditional write on the lease document, so a takeover that lands
   * between check and mutation conflicts with the transaction instead of
   * letting the stale owner's write through.
   */
  private async fenced<T>(fn: (tx: MongoLedger) => Promise<T>): Promise<T> {
    if (!this.ctx.lease || this.session) {
      await this.assertLease();
      return fn(this);
    }
    return this.transaction(async (tx) => {
      const ledger = tx as MongoLedger;
      await ledger.assertLease();
      return fn(ledger);
    });
  }

  async claimLease(
    missionId: string,
    owner: string,
    ttlMs: number,
    at = new Date(),
  ): Promise<LeaseRow> {
    const leases = this.col(COLLECTIONS.leases);
    const expiresAt = new Date(at.getTime() + ttlMs).toISOString();
    try {
      const doc = await leases.findOneAndUpdate(
        {
          _id: missionId,
          $or: [{ owner }, { expiresAt: { $lte: at.toISOString() } }],
        },
        { $set: { owner, expiresAt, schemaVersion: SCHEMA_VERSION }, $inc: { fencingToken: 1 } },
        { upsert: true, returnDocument: "after", ...this.opts },
      );
      if (!doc) throw new Error(`lease claim for ${missionId} returned no document`);
      const lease = toLease(doc);
      this.ctx.lease = lease;
      return lease;
    } catch (error) {
      if (!isDuplicateKey(error)) throw error;
      const holder = await this.getLease(missionId);
      throw new LeaseError(`mission ${missionId} lease held by ${holder?.owner}`, holder);
    }
  }

  async renewLease(lease: LeaseRow, ttlMs: number, at = new Date()): Promise<LeaseRow> {
    const expiresAt = new Date(at.getTime() + ttlMs).toISOString();
    const result = await this.col(COLLECTIONS.leases).updateOne(
      { _id: lease.missionId, owner: lease.owner, fencingToken: lease.fencingToken },
      { $set: { expiresAt } },
      this.opts,
    );
    if (result.matchedCount === 0)
      throw new LeaseError(
        `mission ${lease.missionId} lease lost by ${lease.owner}`,
        await this.getLease(lease.missionId),
      );
    const renewed = { ...lease, expiresAt };
    if (this.ctx.lease?.fencingToken === lease.fencingToken) this.ctx.lease = renewed;
    return renewed;
  }

  async releaseLease(lease: LeaseRow): Promise<void> {
    await this.col(COLLECTIONS.leases).updateOne(
      { _id: lease.missionId, owner: lease.owner, fencingToken: lease.fencingToken },
      { $set: { owner: "", expiresAt: RELEASED_AT } },
      this.opts,
    );
    if (this.ctx.lease?.fencingToken === lease.fencingToken) this.ctx.lease = undefined;
  }

  async getLease(missionId: string): Promise<LeaseRow | undefined> {
    const doc = await this.col(COLLECTIONS.leases).findOne(
      { _id: missionId, owner: { $ne: "" } },
      this.opts,
    );
    return doc ? toLease(doc) : undefined;
  }

  async appendEvent(eventKey: string, type: string, entityId: string, payload: unknown) {
    return this.atomically(async (tx) => {
      await tx.assertLease();
      const existing = await tx.findEvent(eventKey);
      if (existing) return existing.seq;
      const seq = await tx.nextSeq("event");
      await tx.col(COLLECTIONS.events).insertOne(
        {
          _id: eventKey,
          missionId: tx.missionId,
          schemaVersion: SCHEMA_VERSION,
          seq,
          eventKey,
          at: now(),
          type,
          entityId,
          payload: canonicalJson(payload),
        },
        tx.opts,
      );
      return seq;
    });
  }

  async eventsSince(seq: number, limit = 1000): Promise<EventRow[]> {
    const docs = await this.col(COLLECTIONS.events)
      .find(this.scoped({ seq: { $gt: seq } }), { sort: { seq: 1 }, limit, ...this.opts })
      .toArray();
    return docs.map(toEvent);
  }

  async findEvent(eventKey: string): Promise<EventRow | undefined> {
    const doc = await this.col(COLLECTIONS.events).findOne(
      this.scoped({ _id: eventKey }),
      this.opts,
    );
    return doc ? toEvent(doc) : undefined;
  }

  async lastEventSeq(): Promise<number> {
    return this.currentSeq("event");
  }

  async createMission(row: NewMissionRow): Promise<void> {
    return this.fenced(async (tx) => {
      const doc: Doc<MissionRow> = {
        _id: row.missionId,
        schemaVersion: SCHEMA_VERSION,
        ...row,
        spentExperiments: 0,
        spentInputTokens: 0,
        spentOutputTokens: 0,
        spentMemoryOperations: 0,
        spentWallMs: 0,
        usageUncertain: 0,
        learnedSuiteVersion: 0,
        createdAt: now(),
      };
      await tx.col(COLLECTIONS.missions).insertOne(doc, tx.opts);
    });
  }

  async getMission(missionId: string): Promise<MissionRow | undefined> {
    return strip<MissionRow>(
      await this.col(COLLECTIONS.missions).findOne({ _id: missionId }, this.opts),
    );
  }

  async updateMission(missionId: string, patch: MissionPatch): Promise<void> {
    const $set = definedEntries(patch);
    if (Object.keys($set).length === 0) return;
    return this.fenced(async (tx) => {
      await tx.col(COLLECTIONS.missions).updateOne({ _id: missionId }, { $set }, tx.opts);
    });
  }

  async upsertTask(task: TaskRow): Promise<void> {
    return this.fenced(async (tx) => {
      const { taskId, status, hypothesis, nextAction, ...rest } = task;
      await tx.col(COLLECTIONS.tasks).updateOne(
        { _id: taskId },
        {
          $set: { status, hypothesis, nextAction },
          $setOnInsert: { ...rest, taskId, schemaVersion: SCHEMA_VERSION },
        },
        { upsert: true, ...tx.opts },
      );
    });
  }

  async listTasks(missionId: string): Promise<TaskRow[]> {
    const docs = await this.col(COLLECTIONS.tasks)
      .find({ missionId }, { sort: { ordinal: 1 }, ...this.opts })
      .toArray();
    return docs.map((d) => strip<TaskRow>(d)!);
  }

  async insertExperiment(e: NewExperimentRow): Promise<void> {
    return this.fenced(async (tx) => {
      const doc: Doc<ExperimentRow> = {
        _id: e.experimentId,
        schemaVersion: SCHEMA_VERSION,
        ...e,
        candidateArtifactHash: null,
        verdict: null,
        failureSignature: null,
        reportIds: [],
        createdAt: now(),
        finishedAt: null,
      };
      await tx.col(COLLECTIONS.experiments).insertOne(doc, tx.opts);
    });
  }

  async updateExperiment(experimentId: string, patch: ExperimentPatch): Promise<void> {
    const $set = definedEntries(patch);
    if (Object.keys($set).length === 0) return;
    return this.fenced(async (tx) => {
      await tx.col(COLLECTIONS.experiments).updateOne({ _id: experimentId }, { $set }, tx.opts);
    });
  }

  async getExperiment(experimentId: string): Promise<ExperimentRow | undefined> {
    return strip<ExperimentRow>(
      await this.col(COLLECTIONS.experiments).findOne({ _id: experimentId }, this.opts),
    );
  }

  async listExperiments(missionId: string): Promise<ExperimentRow[]> {
    const docs = await this.col(COLLECTIONS.experiments)
      .find({ missionId }, { sort: { createdAt: 1, _id: 1 }, ...this.opts })
      .toArray();
    return docs.map((d) => strip<ExperimentRow>(d)!);
  }

  async insertArtifact(a: ArtifactRow): Promise<void> {
    return this.fenced(async (tx) => {
      await tx.insertIgnore(COLLECTIONS.artifacts, { _id: a.hash }, a);
    });
  }

  async getArtifact(hash: string): Promise<ArtifactRow | undefined> {
    return strip<ArtifactRow>(
      await this.col(COLLECTIONS.artifacts).findOne({ _id: hash }, this.opts),
    );
  }

  async insertVerification(report: VerificationReport, path: string): Promise<void> {
    return this.fenced(async (tx) => {
      const row: VerificationRow = {
        reportId: report.reportId,
        reportHash: reportHash(report),
        missionId: report.missionId,
        experimentId: report.experimentId,
        artifactHash: report.artifactHash,
        suite: report.suite,
        status: report.status,
        evaluatorHash: report.evaluatorHash,
        workloadHash: report.workloadHash,
        environmentHash: report.environmentHash,
        p95LatencyMs: report.metrics.p95LatencyMs ?? null,
        path,
      };
      await tx.insertIgnore(
        COLLECTIONS.verifications,
        {
          experimentId: row.experimentId,
          artifactHash: row.artifactHash,
          suite: row.suite,
          evaluatorHash: row.evaluatorHash,
          workloadHash: row.workloadHash,
          environmentHash: row.environmentHash,
        },
        { _id: row.reportId, ...row, createdOrdinal: await tx.nextSeq("verification") },
      );
    });
  }

  async findVerification(experimentId: string, artifactHash: string, suite: string) {
    return strip<VerificationRow>(
      await this.col(COLLECTIONS.verifications).findOne(
        { experimentId, artifactHash, suite },
        this.opts,
      ),
    );
  }

  async listVerifications(missionId: string): Promise<VerificationRow[]> {
    const docs = await this.col(COLLECTIONS.verifications)
      .find({ missionId }, { sort: { createdOrdinal: 1 }, ...this.opts })
      .toArray();
    return docs.map((d) => strip<VerificationRow>(d)!);
  }

  async insertEpisode(e: EpisodeRow): Promise<void> {
    return this.fenced(async (tx) => {
      await tx.insertIgnore(COLLECTIONS.episodes, { _id: e.episodeId }, e);
    });
  }

  async isIndexed(episodeId: string): Promise<boolean> {
    return (
      (await this.col(COLLECTIONS.outbox).findOne(
        this.scoped({ episodeId, state: "memory_ready" }),
        { projection: { _id: 1 }, ...this.opts },
      )) !== null
    );
  }

  async isSuperseded(episodeId: string): Promise<boolean> {
    return (
      (await this.col(COLLECTIONS.episodes).findOne(
        { supersedes: episodeId },
        { projection: { _id: 1 }, ...this.opts },
      )) !== null
    );
  }

  async currentVersionOf(episodeId: string): Promise<EpisodeRow | undefined> {
    let current = await this.getEpisode(episodeId);
    for (let hops = 0; current && hops < 64; hops += 1) {
      const next = await this.col(COLLECTIONS.episodes).findOne(
        { supersedes: current.episodeId },
        { sort: { version: -1 }, ...this.opts },
      );
      if (!next) return current;
      current = strip<EpisodeRow>(next);
    }
    return current;
  }

  /**
   * Backend-neutral search: rank a bounded window of this mission's most
   * recent episodes locally by IDF-weighted term overlap. Unlike SQLite FTS5
   * this does not cover the full history; Supermemory covers the rest.
   */
  async searchEpisodes(
    missionId: string,
    query: string,
    limit: number,
    options: { unindexedOnly?: boolean } = {},
  ): Promise<EpisodeRow[]> {
    const terms = [...new Set(tokenize(query))];
    if (terms.length === 0 || limit <= 0) return [];
    const window = await this.recentEpisodes(missionId);
    const excluded = options.unindexedOnly
      ? new Set(
          (
            await this.col(COLLECTIONS.outbox)
              .find(this.scoped({ state: "memory_ready" }), {
                projection: { episodeId: 1 },
                ...this.opts,
              })
              .toArray()
          ).map((d) => String(d.episodeId)),
        )
      : new Set<string>();
    const weights = weightsOver(window, terms);
    const selective = selectiveTerms(window, terms);
    const scored: { episode: EpisodeRow; score: number }[] = [];
    for (const episode of window) {
      if (excluded.has(episode.episodeId)) continue;
      const tokens = new Set(tokenize(episode.summary));
      let score = 0;
      for (const t of selective) if (tokens.has(t)) score += weights.get(t) ?? 0;
      if (score > 0) scored.push({ episode, score });
    }
    scored.sort(
      (a, b) => b.score - a.score || a.episode.episodeId.localeCompare(b.episode.episodeId),
    );
    return scored.slice(0, limit).map((s) => s.episode);
  }

  async termWeights(terms: string[]): Promise<Map<string, number>> {
    return weightsOver(await this.recentEpisodes(this.missionId), terms);
  }

  private async recentEpisodes(missionId: string): Promise<EpisodeRow[]> {
    const docs = await this.col(COLLECTIONS.episodes)
      .find({ missionId }, { sort: { createdAt: -1 }, limit: RECENT_EPISODE_WINDOW, ...this.opts })
      .toArray();
    return docs.map((d) => strip<EpisodeRow>(d)!);
  }

  async getEpisode(episodeId: string): Promise<EpisodeRow | undefined> {
    return strip<EpisodeRow>(
      await this.col(COLLECTIONS.episodes).findOne({ _id: episodeId }, this.opts),
    );
  }

  async listEpisodes(missionId: string): Promise<EpisodeRow[]> {
    const docs = await this.col(COLLECTIONS.episodes)
      .find({ missionId }, { sort: { createdAt: 1 }, ...this.opts })
      .toArray();
    return docs.map((d) => strip<EpisodeRow>(d)!);
  }

  async upsertLesson(l: LessonRow): Promise<void> {
    return this.fenced(async (tx) => {
      const {
        lessonId,
        state,
        sourceEpisodeIds,
        proposal,
        positiveEvidenceId,
        negativeEvidenceId,
        materializedScenarioId,
        transitions,
        ...rest
      } = l;
      await tx.col(COLLECTIONS.lessons).updateOne(
        { _id: lessonId },
        {
          $set: {
            state,
            sourceEpisodeIds,
            proposal,
            positiveEvidenceId,
            negativeEvidenceId,
            materializedScenarioId,
            transitions,
          },
          $setOnInsert: { ...rest, lessonId, schemaVersion: SCHEMA_VERSION, createdAt: now() },
        },
        { upsert: true, ...tx.opts },
      );
    });
  }

  async listLessons(missionId: string): Promise<LessonRow[]> {
    const docs = await this.col(COLLECTIONS.lessons)
      .find({ missionId }, { sort: { createdAt: 1, _id: 1 }, ...this.opts })
      .toArray();
    return docs.map((d) => {
      const { createdAt, ...row } = strip<LessonRow & { createdAt: string }>(d)!;
      void createdAt;
      return row;
    });
  }

  async insertLearnedScenario(
    scenarioId: string,
    missionId: string,
    lessonId: string,
    suiteVersion: number,
    path: string,
  ): Promise<void> {
    return this.fenced(async (tx) => {
      await tx.col(COLLECTIONS.learnedScenarios).insertOne(
        {
          _id: scenarioId,
          missionId,
          schemaVersion: SCHEMA_VERSION,
          scenarioId,
          lessonId,
          suiteVersion,
          path,
        },
        tx.opts,
      );
    });
  }

  async listLearnedScenarios(missionId: string): Promise<LearnedScenarioRow[]> {
    const docs = await this.col(COLLECTIONS.learnedScenarios)
      .find({ missionId }, { sort: { suiteVersion: 1 }, ...this.opts })
      .toArray();
    return docs.map((d) => ({
      scenarioId: String(d.scenarioId),
      lessonId: String(d.lessonId),
      suiteVersion: Number(d.suiteVersion),
      path: String(d.path),
    }));
  }

  async registerContainer(
    containerName: string,
    missionId: string,
    experimentId: string,
  ): Promise<void> {
    return this.fenced(async (tx) => {
      await tx.insertIgnore(
        COLLECTIONS.containers,
        { _id: containerName },
        {
          _id: containerName,
          missionId,
          containerName,
          experimentId,
          state: "launching",
          createdAt: now(),
          releasedAt: null,
        },
      );
    });
  }

  async releaseContainer(containerName: string, state: ContainerState = "released"): Promise<void> {
    return this.fenced(async (tx) => {
      await tx
        .col(COLLECTIONS.containers)
        .updateOne(
          { _id: containerName, state: "launching" },
          { $set: { state, releasedAt: now() } },
          tx.opts,
        );
    });
  }

  async listLiveContainers(missionId: string): Promise<ContainerRow[]> {
    const docs = await this.col(COLLECTIONS.containers)
      .find({ missionId, state: "launching" }, { sort: { createdAt: 1, _id: 1 }, ...this.opts })
      .toArray();
    return docs.map(toContainer);
  }

  async listContainers(missionId: string): Promise<ContainerRow[]> {
    const docs = await this.col(COLLECTIONS.containers)
      .find({ missionId }, { sort: { createdAt: 1, _id: 1 }, ...this.opts })
      .toArray();
    return docs.map(toContainer);
  }

  async writeCheckpoint(c: NewCheckpointRow): Promise<CheckpointRow> {
    return this.atomically(async (tx) => {
      await tx.assertLease();
      const seq = await tx.nextSeq("checkpoint");
      const row: CheckpointRow = {
        ...c,
        checkpointId: `ckpt-${c.missionId}-${String(seq).padStart(6, "0")}`,
        seq,
        lastEventSeq: await tx.lastEventSeq(),
        createdAt: now(),
      };
      await tx
        .col(COLLECTIONS.checkpoints)
        .insertOne({ _id: row.checkpointId, schemaVersion: SCHEMA_VERSION, ...row }, tx.opts);
      return row;
    });
  }

  async latestCheckpoint(missionId: string): Promise<CheckpointRow | undefined> {
    return strip<CheckpointRow>(
      await this.col(COLLECTIONS.checkpoints).findOne(
        { missionId },
        { sort: { seq: -1 }, ...this.opts },
      ),
    );
  }

  async countCheckpoints(missionId: string): Promise<number> {
    return this.col(COLLECTIONS.checkpoints).countDocuments({ missionId }, this.opts);
  }

  async openSegment(
    missionId: string,
    ordinal: number,
    sessionPath: string | null,
    sessionId: string | null,
  ): Promise<void> {
    return this.fenced(async (tx) => {
      const row: SegmentRow = {
        missionId,
        ordinal,
        sessionPath,
        sessionId,
        checkpointId: null,
        startedAt: now(),
        closedAt: null,
        firstEventSeq: await tx.lastEventSeq(),
        lastEventSeq: null,
        archiveHash: null,
        committed: 0,
      };
      await tx
        .col(COLLECTIONS.segments)
        .replaceOne(
          { _id: segmentId(missionId, ordinal) },
          { schemaVersion: SCHEMA_VERSION, ...row },
          { upsert: true, ...tx.opts },
        );
    });
  }

  async commitSegment(missionId: string, ordinal: number, checkpointId: string): Promise<void> {
    return this.fenced(async (tx) => {
      await tx
        .col(COLLECTIONS.segments)
        .updateOne(
          { _id: segmentId(missionId, ordinal) },
          { $set: { committed: 1, checkpointId } },
          tx.opts,
        );
    });
  }

  async closeSegment(
    missionId: string,
    ordinal: number,
    archiveHash: string | null,
  ): Promise<void> {
    return this.fenced(async (tx) => {
      await tx
        .col(COLLECTIONS.segments)
        .updateOne(
          { _id: segmentId(missionId, ordinal) },
          { $set: { closedAt: now(), lastEventSeq: await tx.lastEventSeq(), archiveHash } },
          tx.opts,
        );
    });
  }

  async activeSegment(missionId: string): Promise<SegmentRow | undefined> {
    return strip<SegmentRow>(
      await this.col(COLLECTIONS.segments).findOne(
        { missionId, committed: 1, closedAt: null },
        { sort: { ordinal: -1 }, ...this.opts },
      ),
    );
  }

  async listSegments(missionId: string): Promise<SegmentRow[]> {
    const docs = await this.col(COLLECTIONS.segments)
      .find({ missionId }, { sort: { ordinal: 1 }, ...this.opts })
      .toArray();
    return docs.map((d) => strip<SegmentRow>(d)!);
  }

  async discardUncommittedSegments(missionId: string): Promise<number> {
    return this.fenced(async (tx) => {
      const result = await tx
        .col(COLLECTIONS.segments)
        .deleteMany({ missionId, committed: 0 }, tx.opts);
      return result.deletedCount;
    });
  }

  async enqueueOutbox(episodeId: string, payload: unknown): Promise<string> {
    return this.fenced(async (tx) => {
      const payloadHash = sha256(canonicalJson(payload));
      const idempotencyKey = `${episodeId}:${payloadHash.slice(0, 16)}`;
      const at = now();
      await tx.insertIgnore(
        COLLECTIONS.outbox,
        { _id: idempotencyKey },
        {
          missionId: tx.missionId,
          idempotencyKey,
          episodeId,
          payloadHash,
          payload: JSON.stringify(payload),
          remoteDocumentId: null,
          state: "pending",
          retries: 0,
          nextAttemptAt: at,
          lastError: null,
          updatedAt: at,
          createdAt: at,
          createdOrdinal: await tx.nextSeq("outbox"),
        },
      );
      return idempotencyKey;
    });
  }

  async outboxPayloadForEpisode(episodeId: string): Promise<unknown> {
    const doc = await this.col(COLLECTIONS.outbox).findOne(this.scoped({ episodeId }), {
      sort: { createdOrdinal: -1 },
      projection: { payload: 1 },
      ...this.opts,
    });
    return doc ? JSON.parse(String(doc.payload)) : undefined;
  }

  async outboxPayload(key: string): Promise<unknown> {
    const doc = await this.col(COLLECTIONS.outbox).findOne(
      { _id: key },
      { projection: { payload: 1 }, ...this.opts },
    );
    return doc ? JSON.parse(String(doc.payload)) : undefined;
  }

  async updateOutbox(key: string, patch: OutboxPatch): Promise<void> {
    return this.fenced(async (tx) => {
      await tx
        .col(COLLECTIONS.outbox)
        .updateOne({ _id: key }, { $set: { ...definedEntries(patch), updatedAt: now() } }, tx.opts);
    });
  }

  async listOutbox(states?: OutboxState[]): Promise<OutboxRow[]> {
    const docs = await this.col(COLLECTIONS.outbox)
      .find(this.scoped(states ? { state: { $in: states } } : {}), {
        sort: states ? { nextAttemptAt: 1, createdOrdinal: 1 } : { createdOrdinal: 1 },
        ...this.opts,
      })
      .toArray();
    return docs.map((d) => {
      const { payload, missionId, createdAt, ...row } = strip<
        OutboxRow & { payload: string; missionId: string; createdAt: string }
      >(d)!;
      void payload;
      void missionId;
      void createdAt;
      return row;
    });
  }
}

function segmentId(missionId: string, ordinal: number): string {
  return `${missionId}:${ordinal}`;
}

function definedEntries(patch: object): Document {
  return Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
}

function toLease(doc: Document): LeaseRow {
  return {
    missionId: String(doc._id),
    owner: String(doc.owner),
    fencingToken: Number(doc.fencingToken),
    expiresAt: String(doc.expiresAt),
  };
}

function toEvent(doc: Document): EventRow {
  return {
    seq: Number(doc.seq),
    eventKey: String(doc.eventKey),
    at: String(doc.at),
    type: String(doc.type),
    entityId: String(doc.entityId),
    payload: JSON.parse(String(doc.payload)),
  };
}

function toContainer(doc: Document): ContainerRow {
  return {
    containerName: String(doc.containerName),
    missionId: String(doc.missionId),
    experimentId: String(doc.experimentId),
    state: String(doc.state) as ContainerState,
    createdAt: String(doc.createdAt),
    releasedAt: doc.releasedAt == null ? null : String(doc.releasedAt),
  };
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter(Boolean);
}

function documentFrequencies(window: EpisodeRow[], terms: string[]): Map<string, number> {
  const counts = new Map(terms.map((t) => [t, 0]));
  for (const episode of window) {
    const tokens = new Set(tokenize(episode.summary));
    for (const t of terms) if (tokens.has(t)) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return counts;
}

function weightsOver(window: EpisodeRow[], terms: string[]): Map<string, number> {
  const df = documentFrequencies(window, terms);
  return new Map(
    terms.map((t) => [t, Math.log((window.length + 1) / ((df.get(t) ?? 0) + 1)) + 0.01]),
  );
}

function selectiveTerms(window: EpisodeRow[], terms: string[]): string[] {
  if (terms.length <= 1) return terms;
  const df = documentFrequencies(window, terms);
  const rare = terms.filter((t) => (df.get(t) ?? 0) <= Math.max(50, window.length / 5));
  return rare.length > 0 ? rare : terms;
}
