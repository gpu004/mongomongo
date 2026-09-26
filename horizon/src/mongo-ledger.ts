import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import {
  type ClientSession,
  type Collection,
  type Db,
  type Document,
  type Filter,
  MongoClient,
  ObjectId,
} from "mongodb";
import {
  canonicalJson,
  reportHash,
  sha256,
  type VerificationReport,
} from "../verification/reports.ts";
import type {
  ArtifactRow,
  CheckpointRow,
  EpisodeRow,
  EventRow,
  ExperimentRow,
  Ledger,
  LessonRow,
  MissionRow,
  OutboxRow,
  OutboxState,
  SegmentRow,
  TaskRow,
  VerificationRow,
} from "./ledger.ts";

/**
 * MongoDB (Atlas or a local replica set) implementation of the ledger.
 *
 * Every document carries `missionId`, so many missions share one database;
 * uniqueness that SQLite got from per-mission files is enforced here with
 * compound unique indexes. Per-mission monotonic sequences (events and
 * checkpoints) are allocated from a `counters` document inside the same
 * transaction as the write that uses them.
 *
 * The controller lock is a lease document with a fencing token. Holding the
 * lease is required for every write; each transaction (and each standalone
 * write, which runs as a one-statement transaction) bumps the lease's heartbeat
 * with a filter on the token, so a controller whose lease was taken over by a
 * newer one cannot commit: its lease update matches nothing and the transaction
 * aborts before anything else is written.
 */

export interface MongoSettings {
  uri: string;
  database: string;
  /** Lease duration; a controller that stops heartbeating for this long can be replaced. */
  leaseTtlMs: number;
  heartbeatMs: number;
}

export const MONGODB_URI_ENV = "MONGODB_URI";
export const MONGODB_DATABASE_ENV = "MONGODB_DB";

export function mongoSettingsFromEnv(
  env: NodeJS.ProcessEnv,
  database?: string,
  overrides: Partial<Pick<MongoSettings, "leaseTtlMs" | "heartbeatMs">> = {},
): MongoSettings {
  const uri = env[MONGODB_URI_ENV];
  if (!uri)
    throw new Error(
      `ledger.backend is mongodb but ${MONGODB_URI_ENV} is unset (see horizon/.env.example)`,
    );
  return {
    uri,
    database: database ?? env[MONGODB_DATABASE_ENV] ?? "horizon",
    leaseTtlMs: overrides.leaseTtlMs ?? 30_000,
    heartbeatMs: overrides.heartbeatMs ?? 10_000,
  };
}

/** Connection string with credentials removed, for logs and reports. */
export function redactMongoUri(uri: string): string {
  return uri.replace(/\/\/([^@/]*)@/, "//<credentials>@");
}

/** Doctor line: whether MongoDB is configured, reachable, and able to run transactions. */
export async function describeMongoSettings(env: NodeJS.ProcessEnv): Promise<string> {
  const uri = env[MONGODB_URI_ENV];
  if (!uri) return `not configured (${MONGODB_URI_ENV} unset; ledger.backend=sqlite only)`;
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5_000 });
  try {
    await client.connect();
    const hello = (await client.db("admin").command({ hello: 1 })) as {
      setName?: string;
      msg?: string;
    };
    const topology = hello.setName
      ? `replica set ${hello.setName}`
      : hello.msg === "isdbgrid"
        ? "sharded cluster"
        : "standalone (transactions unsupported)";
    // Disposable transaction probe: write, read back, and remove one record in the target database.
    const db = client.db(mongoSettingsFromEnv(env).database);
    const probe = db.collection<{ _id: string; at: Date }>("doctor_probe");
    const id = `probe-${randomUUID()}`;
    const session = client.startSession();
    try {
      await session.withTransaction(async () => {
        await probe.insertOne({ _id: id, at: new Date() }, { session });
        const found = await probe.findOne({ _id: id }, { session });
        if (!found) throw new Error("probe record not visible inside its transaction");
        await probe.deleteOne({ _id: id }, { session });
      });
    } finally {
      await session.endSession();
      await probe.deleteOne({ _id: id }).catch(() => {});
    }
    return `ok: ${redactMongoUri(uri)} database=${db.databaseName} (${topology}; transaction probe passed)`;
  } catch (error) {
    return `unreachable: ${redactMongoUri(uri)}: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    await client.close();
  }
}

export class LeaseLostError extends Error {
  constructor(missionId: string) {
    super(`controller lease for ${missionId} was taken over by another controller`);
    this.name = "LeaseLostError";
  }
}

interface LeaseDoc {
  _id: string;
  holder: string;
  token: string;
  expiresAt: Date;
  heartbeatAt: Date;
}

interface CounterDoc {
  _id: string;
  value: number;
}

type Doc = Document & { _id?: ObjectId | string };

function now(): string {
  return new Date().toISOString();
}

export function tokenize(text: string): string[] {
  return [
    ...new Set(
      text
        .toLowerCase()
        .split(/[^\p{L}\p{N}_]+/u)
        .filter(Boolean),
    ),
  ];
}

function isDuplicateKey(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: number }).code === 11000;
}

export class MongoLedger implements Ledger {
  readonly backend = "mongodb" as const;
  readonly missionId: string;
  readonly holder: string;
  private readonly client: MongoClient;
  private readonly db: Db;
  private readonly settings: MongoSettings;
  /** The session of the transaction whose callback is running in the current async context. */
  private readonly txContext = new AsyncLocalStorage<ClientSession>();
  /** Transactions on one ledger are serialized; a session cannot run operations in parallel. */
  private queue: Promise<unknown> = Promise.resolve();
  private activeTransactions = 0;
  private lease: { token: string } | null = null;
  private leaseLost = false;
  private heartbeat: NodeJS.Timeout | null = null;

  private constructor(client: MongoClient, settings: MongoSettings, missionId: string) {
    this.client = client;
    this.settings = settings;
    this.db = client.db(settings.database);
    this.missionId = missionId;
    this.holder = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  }

  static async connect(
    settings: MongoSettings,
    options: { missionId: string },
  ): Promise<MongoLedger> {
    const client = new MongoClient(settings.uri, {
      serverSelectionTimeoutMS: 10_000,
      retryWrites: true,
      writeConcern: { w: "majority", journal: true },
      readConcern: { level: "majority" },
    });
    await client.connect();
    const ledger = new MongoLedger(client, settings, options.missionId);
    await ledger.ensureIndexes();
    return ledger;
  }

  get location(): string {
    return `${redactMongoUri(this.settings.uri)}/${this.settings.database}`;
  }

  private col<T extends Document>(name: string): Collection<T> {
    return this.db.collection<T>(name);
  }

  private get opts(): { session?: ClientSession } {
    const session = this.txContext.getStore();
    return session ? { session } : {};
  }

  private async ensureIndexes(): Promise<void> {
    const unique = { unique: true } as const;
    await Promise.all([
      this.col("missions").createIndex({ missionId: 1 }, unique),
      this.col("tasks").createIndex({ missionId: 1, taskId: 1 }, unique),
      this.col("experiments").createIndex({ missionId: 1, experimentId: 1 }, unique),
      this.col("experiments").createIndex({ missionId: 1, createdAt: 1, experimentId: 1 }),
      this.col("artifacts").createIndex({ missionId: 1, hash: 1 }, unique),
      this.col("verifications").createIndex({ missionId: 1, reportId: 1 }, unique),
      this.col("verifications").createIndex(
        {
          missionId: 1,
          experimentId: 1,
          artifactHash: 1,
          suite: 1,
          evaluatorHash: 1,
          workloadHash: 1,
          environmentHash: 1,
        },
        unique,
      ),
      this.col("episodes").createIndex({ missionId: 1, episodeId: 1 }, unique),
      this.col("episodes").createIndex({ missionId: 1, createdAt: 1 }),
      this.col("episodes").createIndex({ missionId: 1, supersedes: 1, version: -1 }),
      this.col("episodes").createIndex({ missionId: 1, terms: 1 }),
      this.col("lessons").createIndex({ missionId: 1, lessonId: 1 }, unique),
      this.col("learned_scenarios").createIndex({ missionId: 1, scenarioId: 1 }, unique),
      this.col("checkpoints").createIndex({ missionId: 1, seq: -1 }, unique),
      this.col("outbox").createIndex({ missionId: 1, idempotencyKey: 1 }, unique),
      this.col("outbox").createIndex({ missionId: 1, episodeId: 1, state: 1 }),
      this.col("outbox").createIndex({ missionId: 1, state: 1, nextAttemptAt: 1 }),
      this.col("segments").createIndex({ missionId: 1, ordinal: 1 }, unique),
      this.col("events").createIndex({ missionId: 1, eventKey: 1 }, unique),
      this.col("events").createIndex({ missionId: 1, seq: 1 }, unique),
    ]);
  }

  // ---- lease --------------------------------------------------------------

  /** Current fencing token, or null when this ledger does not hold the lease. */
  get leaseToken(): string | null {
    return this.lease?.token ?? null;
  }

  async acquireLock(): Promise<void> {
    if (this.lease) return;
    const leases = this.col<LeaseDoc>("leases");
    const token = randomUUID();
    const at = new Date();
    const expiresAt = new Date(at.getTime() + this.settings.leaseTtlMs);
    const existing = await leases.findOne({ _id: this.missionId });
    if (!existing) {
      try {
        await leases.insertOne({
          _id: this.missionId,
          holder: this.holder,
          token,
          expiresAt,
          heartbeatAt: at,
        });
      } catch (error) {
        if (!isDuplicateKey(error)) throw error;
        throw new Error(`another controller holds the lease for ${this.missionId}`);
      }
    } else {
      // Take over only an expired lease, and only the exact version we observed.
      const result = await leases.updateOne(
        { _id: this.missionId, token: existing.token, expiresAt: { $lt: at } },
        { $set: { holder: this.holder, token, expiresAt, heartbeatAt: at } },
      );
      if (result.matchedCount === 0)
        throw new Error(
          `another controller (${existing.holder}) holds the lease for ${this.missionId} until ${existing.expiresAt.toISOString()}`,
        );
    }
    this.lease = { token };
    this.leaseLost = false;
    this.heartbeat = setInterval(() => {
      void this.renewLease().catch(() => {
        this.leaseLost = true;
      });
    }, this.settings.heartbeatMs);
    this.heartbeat.unref();
  }

  private async renewLease(): Promise<void> {
    // A running transaction renews through fence(); a concurrent plain update would only conflict with it.
    if (!this.lease || this.activeTransactions > 0) return;
    const at = new Date();
    const result = await this.col<LeaseDoc>("leases").updateOne(
      { _id: this.missionId, token: this.lease.token },
      { $set: { heartbeatAt: at, expiresAt: new Date(at.getTime() + this.settings.leaseTtlMs) } },
    );
    if (result.matchedCount === 0) this.leaseLost = true;
  }

  async releaseLock(): Promise<void> {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
    if (!this.lease) return;
    const token = this.lease.token;
    this.lease = null;
    await this.col<LeaseDoc>("leases").deleteOne({ _id: this.missionId, token });
  }

  async close(): Promise<void> {
    await this.releaseLock();
    await this.client.close();
  }

  // ---- transactions -------------------------------------------------------

  /**
   * Runs `fn` in a multi-document transaction. `fn` may be retried on
   * transient errors, so it must only issue ledger operations. When the lease
   * is held, the lease heartbeat is written inside the transaction with a
   * token filter, which fences out any controller that lost the lease.
   */
  /**
   * Runs `fn` inside one multi-document transaction. Only operations awaited from within the
   * callback's async context join the transaction; operations issued concurrently from elsewhere
   * (e.g. fire-and-forget tool events) run as their own fenced transaction once this one settles.
   */
  async transaction<T>(fn: () => Promise<T> | T): Promise<T> {
    if (this.txContext.getStore())
      throw new Error("ledger transactions cannot nest or run concurrently on one connection");
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((resolve) => (release = resolve));
    await previous;
    this.activeTransactions += 1;
    const session = this.client.startSession();
    try {
      let result!: T;
      await session.withTransaction(
        () =>
          this.txContext.run(session, async () => {
            await this.fence();
            result = await fn();
          }),
        {
          readConcern: { level: "snapshot" },
          writeConcern: { w: "majority", journal: true },
        },
      );
      return result;
    } finally {
      this.activeTransactions -= 1;
      await session.endSession();
      release();
    }
  }

  private async fence(): Promise<void> {
    if (!this.lease) return;
    if (this.leaseLost) throw new LeaseLostError(this.missionId);
    const at = new Date();
    const result = await this.col<LeaseDoc>("leases").updateOne(
      { _id: this.missionId, token: this.lease.token },
      { $set: { heartbeatAt: at, expiresAt: new Date(at.getTime() + this.settings.leaseTtlMs) } },
      this.opts,
    );
    if (result.matchedCount === 0) {
      this.leaseLost = true;
      throw new LeaseLostError(this.missionId);
    }
  }

  /** Standalone writes are fenced too: outside a transaction they run as a one-statement transaction. */
  private async write<T>(fn: () => Promise<T>): Promise<T> {
    if (this.txContext.getStore() || !this.lease) return fn();
    return this.transaction(fn);
  }

  private async nextSeq(name: string): Promise<number> {
    const doc = await this.col<CounterDoc>("counters").findOneAndUpdate(
      { _id: `${this.missionId}:${name}` },
      { $inc: { value: 1 } },
      { upsert: true, returnDocument: "after", ...this.opts },
    );
    return doc!.value;
  }

  // ---- events -------------------------------------------------------------

  async appendEvent(
    eventKey: string,
    type: string,
    entityId: string,
    payload: unknown,
  ): Promise<number> {
    return this.write(async () => {
      const events = this.col<Doc>("events");
      const existing = await events.findOne({ missionId: this.missionId, eventKey }, this.opts);
      if (existing) return Number(existing.seq);
      const seq = await this.nextSeq("event");
      await events.insertOne(
        {
          missionId: this.missionId,
          seq,
          eventKey,
          at: now(),
          type,
          entityId,
          payload: canonicalJson(payload),
        },
        this.opts,
      );
      return seq;
    });
  }

  async eventsSince(seq: number, limit = 1000): Promise<EventRow[]> {
    const rows = await this.col<Doc>("events")
      .find({ missionId: this.missionId, seq: { $gt: seq } }, this.opts)
      .sort({ seq: 1 })
      .limit(limit)
      .toArray();
    return rows.map(toEvent);
  }

  async findEvent(eventKey: string): Promise<EventRow | undefined> {
    const r = await this.col<Doc>("events").findOne(
      { missionId: this.missionId, eventKey },
      this.opts,
    );
    return r ? toEvent(r) : undefined;
  }

  async lastEventSeq(): Promise<number> {
    const r = await this.col<CounterDoc>("counters").findOne(
      { _id: `${this.missionId}:event` },
      this.opts,
    );
    return r?.value ?? 0;
  }

  // ---- mission ------------------------------------------------------------

  async createMission(
    row: Omit<
      MissionRow,
      | "createdAt"
      | "spentExperiments"
      | "spentInputTokens"
      | "spentOutputTokens"
      | "spentMemoryOperations"
      | "spentWallMs"
      | "usageUncertain"
      | "learnedSuiteVersion"
    >,
  ): Promise<void> {
    this.assertMission(row.missionId);
    const doc: MissionRow = {
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
    await this.write(() => this.col<Doc>("missions").insertOne({ ...doc }, this.opts));
  }

  async getMission(missionId: string): Promise<MissionRow | undefined> {
    const r = await this.col<Doc>("missions").findOne({ missionId }, this.opts);
    return r ? strip<MissionRow>(r) : undefined;
  }

  async updateMission(
    missionId: string,
    patch: Partial<Omit<MissionRow, "missionId" | "createdAt">>,
  ): Promise<void> {
    const $set = defined(patch);
    if (Object.keys($set).length === 0) return;
    await this.write(() => this.col<Doc>("missions").updateOne({ missionId }, { $set }, this.opts));
  }

  // ---- tasks --------------------------------------------------------------

  async upsertTask(task: TaskRow): Promise<void> {
    await this.write(() =>
      this.col<Doc>("tasks").updateOne(
        { missionId: task.missionId, taskId: task.taskId },
        {
          $set: { status: task.status, hypothesis: task.hypothesis, nextAction: task.nextAction },
          $setOnInsert: {
            ordinal: task.ordinal,
            dependsOn: task.dependsOn,
            completionCriteria: task.completionCriteria,
          },
        },
        { upsert: true, ...this.opts },
      ),
    );
  }

  async listTasks(missionId: string): Promise<TaskRow[]> {
    const rows = await this.col<Doc>("tasks")
      .find({ missionId }, this.opts)
      .sort({ ordinal: 1 })
      .toArray();
    return rows.map((r) => strip<TaskRow>(r));
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
    const doc: ExperimentRow = {
      ...e,
      candidateArtifactHash: null,
      verdict: null,
      failureSignature: null,
      reportIds: [],
      createdAt: now(),
      finishedAt: null,
    };
    await this.write(() => this.col<Doc>("experiments").insertOne({ ...doc }, this.opts));
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
    const $set = defined(patch);
    if (Object.keys($set).length === 0) return;
    await this.write(() =>
      this.col<Doc>("experiments").updateOne(
        { missionId: this.missionId, experimentId },
        { $set },
        this.opts,
      ),
    );
  }

  async getExperiment(experimentId: string): Promise<ExperimentRow | undefined> {
    const r = await this.col<Doc>("experiments").findOne(
      { missionId: this.missionId, experimentId },
      this.opts,
    );
    return r ? strip<ExperimentRow>(r) : undefined;
  }

  async listExperiments(missionId: string): Promise<ExperimentRow[]> {
    const rows = await this.col<Doc>("experiments")
      .find({ missionId }, this.opts)
      .sort({ createdAt: 1, experimentId: 1 })
      .toArray();
    return rows.map((r) => strip<ExperimentRow>(r));
  }

  // ---- artifacts / verification ------------------------------------------

  async insertArtifact(a: ArtifactRow): Promise<void> {
    await this.write(async () => {
      const artifacts = this.col<Doc>("artifacts");
      const existing = await artifacts.findOne(
        { missionId: this.missionId, hash: a.hash },
        this.opts,
      );
      if (existing) return;
      await artifacts.insertOne({ missionId: this.missionId, ...a }, this.opts);
    });
  }

  async getArtifact(hash: string): Promise<ArtifactRow | undefined> {
    const r = await this.col<Doc>("artifacts").findOne(
      { missionId: this.missionId, hash },
      this.opts,
    );
    if (!r) return undefined;
    const { missionId: _m, ...row } = strip<ArtifactRow & { missionId: string }>(r);
    return row;
  }

  async insertVerification(report: VerificationReport, path: string): Promise<void> {
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
    await this.write(async () => {
      const verifications = this.col<Doc>("verifications");
      const existing = await verifications.findOne(
        {
          missionId: row.missionId,
          $or: [
            { reportId: row.reportId },
            {
              experimentId: row.experimentId,
              artifactHash: row.artifactHash,
              suite: row.suite,
              evaluatorHash: row.evaluatorHash,
              workloadHash: row.workloadHash,
              environmentHash: row.environmentHash,
            },
          ],
        },
        this.opts,
      );
      if (existing) return;
      await verifications.insertOne({ ...row }, this.opts);
    });
  }

  async findVerification(
    experimentId: string,
    artifactHash: string,
    suite: string,
  ): Promise<VerificationRow | undefined> {
    const r = await this.col<Doc>("verifications").findOne(
      { missionId: this.missionId, experimentId, artifactHash, suite },
      this.opts,
    );
    return r ? strip<VerificationRow>(r) : undefined;
  }

  async listVerifications(missionId: string): Promise<VerificationRow[]> {
    const rows = await this.col<Doc>("verifications")
      .find({ missionId }, this.opts)
      .sort({ _id: 1 })
      .toArray();
    return rows.map((r) => strip<VerificationRow>(r));
  }

  // ---- episodes / lessons -------------------------------------------------

  async insertEpisode(e: EpisodeRow): Promise<void> {
    await this.write(async () => {
      const episodes = this.col<Doc>("episodes");
      const existing = await episodes.findOne(
        { missionId: e.missionId, episodeId: e.episodeId },
        this.opts,
      );
      if (existing) return;
      await episodes.insertOne({ ...e, terms: tokenize(e.summary) }, this.opts);
    });
  }

  async isIndexed(episodeId: string): Promise<boolean> {
    const r = await this.col<Doc>("outbox").findOne(
      { missionId: this.missionId, episodeId, state: "memory_ready" },
      { projection: { _id: 1 }, ...this.opts },
    );
    return r !== null;
  }

  async isSuperseded(episodeId: string): Promise<boolean> {
    const r = await this.col<Doc>("episodes").findOne(
      { missionId: this.missionId, supersedes: episodeId },
      { projection: { _id: 1 }, ...this.opts },
    );
    return r !== null;
  }

  async currentVersionOf(episodeId: string): Promise<EpisodeRow | undefined> {
    let current = await this.getEpisode(episodeId);
    for (let hops = 0; current && hops < 64; hops += 1) {
      const next = await this.col<Doc>("episodes").findOne(
        { missionId: this.missionId, supersedes: current.episodeId },
        { sort: { version: -1 }, ...this.opts },
      );
      if (!next) return current;
      current = toEpisode(next);
    }
    return current;
  }

  /**
   * Bounded keyword search: candidates are episodes sharing at least one
   * selective query term (multikey index on `terms`), fetched up to a small
   * multiple of `limit`, then ranked locally by summed inverse document
   * frequency of the matched terms.
   */
  async searchEpisodes(
    missionId: string,
    query: string,
    limit: number,
    options: { unindexedOnly?: boolean } = {},
  ): Promise<EpisodeRow[]> {
    if (limit <= 0) return [];
    const terms = await this.selectiveTerms(tokenize(query));
    if (terms.length === 0) return [];
    const weights = await this.termWeights(terms);
    const candidateLimit = Math.min(Math.max(limit * 8, 64), 2_000);
    const filter: Filter<Doc> = { missionId, terms: { $in: terms } };
    const rows = await this.col<Doc>("episodes")
      .find(filter, this.opts)
      .limit(candidateLimit)
      .toArray();
    let episodes = rows.map(toEpisode);
    if (options.unindexedOnly && episodes.length > 0) {
      const ready = await this.col<Doc>("outbox")
        .find(
          {
            missionId,
            state: "memory_ready",
            episodeId: { $in: episodes.map((e) => e.episodeId) },
          },
          { projection: { episodeId: 1 }, ...this.opts },
        )
        .toArray();
      const readyIds = new Set(ready.map((r) => String(r.episodeId)));
      episodes = episodes.filter((e) => !readyIds.has(e.episodeId));
    }
    const score = (e: EpisodeRow): number => {
      const present = new Set(tokenize(e.summary));
      let s = 0;
      for (const t of terms) if (present.has(t)) s += weights.get(t) ?? 0;
      return s;
    };
    return episodes
      .map((e) => ({ e, s: score(e) }))
      .sort((a, b) => b.s - a.s || a.e.createdAt.localeCompare(b.e.createdAt))
      .slice(0, limit)
      .map(({ e }) => e);
  }

  async termWeights(terms: string[]): Promise<Map<string, number>> {
    const episodes = this.col<Doc>("episodes");
    const total = await episodes.countDocuments({ missionId: this.missionId }, this.opts);
    const counts = await Promise.all(
      terms.map((t) => episodes.countDocuments({ missionId: this.missionId, terms: t }, this.opts)),
    );
    return new Map(terms.map((t, i) => [t, Math.log((total + 1) / ((counts[i] ?? 0) + 1)) + 0.01]));
  }

  private async selectiveTerms(terms: string[]): Promise<string[]> {
    if (terms.length <= 1) return terms;
    const episodes = this.col<Doc>("episodes");
    const total = await episodes.countDocuments({ missionId: this.missionId }, this.opts);
    const ceiling = Math.max(50, total / 5);
    const counts = await Promise.all(
      terms.map((t) =>
        episodes.countDocuments(
          { missionId: this.missionId, terms: t },
          { limit: Math.floor(ceiling) + 1, ...this.opts },
        ),
      ),
    );
    const rare = terms.filter((_, i) => (counts[i] ?? 0) <= ceiling);
    return rare.length > 0 ? rare : terms;
  }

  async getEpisode(episodeId: string): Promise<EpisodeRow | undefined> {
    const r = await this.col<Doc>("episodes").findOne(
      { missionId: this.missionId, episodeId },
      this.opts,
    );
    return r ? toEpisode(r) : undefined;
  }

  async listEpisodes(missionId: string): Promise<EpisodeRow[]> {
    const rows = await this.col<Doc>("episodes")
      .find({ missionId }, this.opts)
      .sort({ createdAt: 1 })
      .toArray();
    return rows.map(toEpisode);
  }

  async upsertLesson(l: LessonRow): Promise<void> {
    await this.write(() =>
      this.col<Doc>("lessons").updateOne(
        { missionId: l.missionId, lessonId: l.lessonId },
        {
          $set: {
            state: l.state,
            positiveEvidenceId: l.positiveEvidenceId,
            negativeEvidenceId: l.negativeEvidenceId,
            materializedScenarioId: l.materializedScenarioId,
            transitions: l.transitions,
          },
          $setOnInsert: {
            sourceEpisodeIds: l.sourceEpisodeIds,
            invariantId: l.invariantId,
            proposal: l.proposal,
          },
        },
        { upsert: true, ...this.opts },
      ),
    );
  }

  async listLessons(missionId: string): Promise<LessonRow[]> {
    const rows = await this.col<Doc>("lessons")
      .find({ missionId }, this.opts)
      .sort({ _id: 1 })
      .toArray();
    return rows.map((r) => strip<LessonRow>(r));
  }

  async insertLearnedScenario(
    scenarioId: string,
    missionId: string,
    lessonId: string,
    suiteVersion: number,
    path: string,
  ): Promise<void> {
    await this.write(() =>
      this.col<Doc>("learned_scenarios").insertOne(
        { scenarioId, missionId, lessonId, suiteVersion, path },
        this.opts,
      ),
    );
  }

  async listLearnedScenarios(
    missionId: string,
  ): Promise<{ scenarioId: string; lessonId: string; suiteVersion: number; path: string }[]> {
    const rows = await this.col<Doc>("learned_scenarios")
      .find({ missionId }, this.opts)
      .sort({ suiteVersion: 1, _id: 1 })
      .toArray();
    return rows.map((r) => ({
      scenarioId: String(r.scenarioId),
      lessonId: String(r.lessonId),
      suiteVersion: Number(r.suiteVersion),
      path: String(r.path),
    }));
  }

  // ---- checkpoints / segments / outbox -----------------------------------

  async writeCheckpoint(
    c: Omit<CheckpointRow, "checkpointId" | "seq" | "createdAt" | "lastEventSeq">,
  ): Promise<CheckpointRow> {
    return this.write(async () => {
      const seq = await this.nextSeq("checkpoint");
      const checkpointId = `ckpt-${c.missionId}-${String(seq).padStart(6, "0")}`;
      const lastEventSeq = await this.lastEventSeq();
      const row: CheckpointRow = { ...c, checkpointId, seq, lastEventSeq, createdAt: now() };
      await this.col<Doc>("checkpoints").insertOne({ ...row }, this.opts);
      return row;
    });
  }

  async latestCheckpoint(missionId: string): Promise<CheckpointRow | undefined> {
    const r = await this.col<Doc>("checkpoints").findOne(
      { missionId },
      { sort: { seq: -1 }, ...this.opts },
    );
    return r ? strip<CheckpointRow>(r) : undefined;
  }

  async countCheckpoints(missionId: string): Promise<number> {
    return this.col<Doc>("checkpoints").countDocuments({ missionId }, this.opts);
  }

  async openSegment(
    missionId: string,
    ordinal: number,
    sessionPath: string | null,
    sessionId: string | null,
  ): Promise<void> {
    await this.write(async () => {
      const row: SegmentRow = {
        missionId,
        ordinal,
        sessionPath,
        sessionId,
        checkpointId: null,
        startedAt: now(),
        closedAt: null,
        firstEventSeq: await this.lastEventSeq(),
        lastEventSeq: null,
        archiveHash: null,
        committed: 0,
      };
      await this.col<Doc>("segments").replaceOne(
        { missionId, ordinal },
        { ...row },
        { upsert: true, ...this.opts },
      );
    });
  }

  async commitSegment(missionId: string, ordinal: number, checkpointId: string): Promise<void> {
    await this.write(() =>
      this.col<Doc>("segments").updateOne(
        { missionId, ordinal },
        { $set: { committed: 1, checkpointId } },
        this.opts,
      ),
    );
  }

  async closeSegment(
    missionId: string,
    ordinal: number,
    archiveHash: string | null,
  ): Promise<void> {
    await this.write(async () => {
      const lastEventSeq = await this.lastEventSeq();
      await this.col<Doc>("segments").updateOne(
        { missionId, ordinal },
        { $set: { closedAt: now(), lastEventSeq, archiveHash } },
        this.opts,
      );
    });
  }

  async activeSegment(missionId: string): Promise<SegmentRow | undefined> {
    const r = await this.col<Doc>("segments").findOne(
      { missionId, committed: 1, closedAt: null },
      { sort: { ordinal: -1 }, ...this.opts },
    );
    return r ? strip<SegmentRow>(r) : undefined;
  }

  async listSegments(missionId: string): Promise<SegmentRow[]> {
    const rows = await this.col<Doc>("segments")
      .find({ missionId }, this.opts)
      .sort({ ordinal: 1 })
      .toArray();
    return rows.map((r) => strip<SegmentRow>(r));
  }

  async discardUncommittedSegments(missionId: string): Promise<number> {
    return this.write(async () => {
      const result = await this.col<Doc>("segments").deleteMany(
        { missionId, committed: 0 },
        this.opts,
      );
      return result.deletedCount;
    });
  }

  async enqueueOutbox(episodeId: string, payload: unknown): Promise<string> {
    const payloadHash = sha256(canonicalJson(payload));
    const idempotencyKey = `${episodeId}:${payloadHash.slice(0, 16)}`;
    await this.write(async () => {
      const outbox = this.col<Doc>("outbox");
      const existing = await outbox.findOne(
        { missionId: this.missionId, idempotencyKey },
        this.opts,
      );
      if (existing) return;
      const at = now();
      await outbox.insertOne(
        {
          missionId: this.missionId,
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
        },
        this.opts,
      );
    });
    return idempotencyKey;
  }

  async outboxPayloadForEpisode(episodeId: string): Promise<unknown> {
    const r = await this.col<Doc>("outbox").findOne(
      { missionId: this.missionId, episodeId },
      { sort: { _id: -1 }, projection: { payload: 1 }, ...this.opts },
    );
    return r ? JSON.parse(String(r.payload)) : undefined;
  }

  async outboxPayload(key: string): Promise<unknown> {
    const r = await this.col<Doc>("outbox").findOne(
      { missionId: this.missionId, idempotencyKey: key },
      { projection: { payload: 1 }, ...this.opts },
    );
    return r ? JSON.parse(String(r.payload)) : undefined;
  }

  async updateOutbox(
    key: string,
    patch: Partial<
      Pick<OutboxRow, "state" | "remoteDocumentId" | "retries" | "nextAttemptAt" | "lastError">
    >,
  ): Promise<void> {
    await this.write(() =>
      this.col<Doc>("outbox").updateOne(
        { missionId: this.missionId, idempotencyKey: key },
        { $set: { ...defined(patch), updatedAt: now() } },
        this.opts,
      ),
    );
  }

  async listOutbox(states?: OutboxState[]): Promise<OutboxRow[]> {
    const cursor = states
      ? this.col<Doc>("outbox")
          .find({ missionId: this.missionId, state: { $in: states } }, this.opts)
          .sort({ nextAttemptAt: 1, _id: 1 })
      : this.col<Doc>("outbox").find({ missionId: this.missionId }, this.opts).sort({ _id: 1 });
    const rows = await cursor.project({ payload: 0 }).toArray();
    return rows.map((r) => {
      const { missionId: _m, ...row } = strip<OutboxRow & { missionId: string }>(r);
      return row;
    });
  }

  private assertMission(missionId: string): void {
    if (missionId !== this.missionId)
      throw new Error(`ledger is bound to mission ${this.missionId}, got ${missionId}`);
  }
}

/** Drops Mongo's `_id`; documents are written from typed rows, so the remainder is the row. */
function strip<T>(doc: Doc): T {
  const { _id: _ignored, ...rest } = doc;
  return rest as T;
}

function defined<T extends object>(patch: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
}

function toEvent(r: Doc): EventRow {
  return {
    seq: Number(r.seq),
    eventKey: String(r.eventKey),
    at: String(r.at),
    type: String(r.type),
    entityId: String(r.entityId),
    payload: JSON.parse(String(r.payload)),
  };
}

function toEpisode(r: Doc): EpisodeRow {
  const { terms: _terms, ...rest } = strip<EpisodeRow & { terms: string[] }>(r);
  return rest;
}
