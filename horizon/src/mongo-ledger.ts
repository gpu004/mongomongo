import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { type ClientSession, type Collection, type Db, type Document, type Filter, MongoClient, MongoError, MongoServerError, type UpdateFilter } from "mongodb";
import { canonicalJson, reportHash, sha256, type VerificationReport } from "../verification/reports.ts";
import type {
	ArtifactRow,
	CheckpointRow,
	EpisodeRow,
	EventRow,
	ExperimentRow,
	LessonRow,
	MissionRow,
	OperationRow,
	OperationState,
	OutboxRow,
	OutboxState,
	SegmentRow,
	TaskRow,
	VerificationRow,
} from "./ledger.ts";
import {
	type ExperimentPatch,
	type Lease,
	LeaseHeldError,
	LeaseLostError,
	type LearnedScenarioRow,
	type LedgerStore,
	LedgerUnavailableError,
	type MissionPatch,
	type NewCheckpoint,
	type NewExperiment,
	type NewMission,
	type NewOperation,
	type OutboxPatch,
	rankWindow,
	windowTermWeights,
} from "./ledger-store.ts";

export const SCHEMA_VERSION = 1;
export const DEFAULT_DB = "horizon_dev";
/** Episodes considered by local ranking: the newest N plus every episode whose memory delivery is not ready. */
export const EPISODE_WINDOW = 500;

export const COLLECTIONS = ["missions", "tasks", "experiments", "artifacts", "verifications", "episodes", "lessons", "learnedScenarios", "checkpoints", "segments", "events", "outbox", "operations"] as const;
type CollectionName = (typeof COLLECTIONS)[number];

interface IndexSpec {
	name: string;
	key: Record<string, 1 | -1>;
	unique?: boolean;
}

/** Required indexes; `doctor` checks each exists. */
export const INDEXES: Record<CollectionName, IndexSpec[]> = {
	missions: [],
	tasks: [{ name: "mission_ordinal", key: { missionId: 1, ordinal: 1 } }],
	experiments: [
		{ name: "mission_created", key: { missionId: 1, createdAt: 1, experimentId: 1 } },
		{ name: "mission_status", key: { missionId: 1, status: 1 } },
	],
	artifacts: [{ name: "mission_hash", key: { missionId: 1, hash: 1 }, unique: true }],
	verifications: [
		{ name: "verification_identity", key: { missionId: 1, experimentId: 1, artifactHash: 1, suite: 1, evaluatorHash: 1, workloadHash: 1, environmentHash: 1 }, unique: true },
		{ name: "mission_artifact_suite", key: { missionId: 1, artifactHash: 1, suite: 1 } },
		{ name: "mission_ord", key: { missionId: 1, ord: 1 } },
	],
	episodes: [
		{ name: "mission_created", key: { missionId: 1, createdAt: -1 } },
		{ name: "mission_supersedes", key: { missionId: 1, supersedes: 1, version: -1 } },
	],
	lessons: [{ name: "mission_ord", key: { missionId: 1, ord: 1 } }],
	learnedScenarios: [{ name: "mission_suite", key: { missionId: 1, suiteVersion: 1 } }],
	checkpoints: [{ name: "mission_seq", key: { missionId: 1, seq: 1 }, unique: true }],
	segments: [{ name: "mission_ordinal", key: { missionId: 1, ordinal: 1 }, unique: true }],
	events: [
		{ name: "mission_event_key", key: { missionId: 1, eventKey: 1 }, unique: true },
		{ name: "mission_seq", key: { missionId: 1, seq: 1 }, unique: true },
	],
	outbox: [
		{ name: "mission_due", key: { missionId: 1, state: 1, nextAttemptAt: 1 } },
		{ name: "mission_episode", key: { missionId: 1, episodeId: 1, ord: -1 } },
		{ name: "mission_ord", key: { missionId: 1, ord: 1 } },
	],
	operations: [{ name: "mission_state", key: { missionId: 1, state: 1, createdAt: 1 } }],
};

interface Stored {
	_id: string;
	schemaVersion: number;
	missionId: string;
	ord?: number;
}

interface MissionDoc extends Partial<Omit<MissionRow, "missionId">> {
	_id: string;
	schemaVersion?: number;
	counters?: { event?: number; checkpoint?: number; ord?: number };
	lease?: { owner: string | null; token: number; expiresAt: Date; acquiredAt?: Date };
}

type Doc<T> = Omit<T, "missionId"> & Stored;
interface EventDoc extends Stored { seq: number; eventKey: string; at: string; type: string; entityId: string; payloadJson: string }
interface OutboxDoc extends Stored, Omit<OutboxRow, never> { payloadJson: string }

/** Replace credentials in a connection string so it can be logged. */
export function redactUri(uri: string): string {
	return uri.replace(/\/\/[^@/]+@/, "//***@");
}

function so(session: ClientSession | undefined): { session?: ClientSession } {
	return session ? { session } : {};
}

function now(): string {
	return new Date().toISOString();
}

/** Driver errors that mean the cluster cannot be reached (as opposed to a rejected write). */
export function isConnectivityError(error: unknown): boolean {
	if (!(error instanceof MongoError)) return false;
	const name = error.name;
	return (
		name === "MongoNetworkError" ||
		name === "MongoNetworkTimeoutError" ||
		name === "MongoServerSelectionError" ||
		name === "MongoTopologyClosedError" ||
		name === "MongoNotConnectedError" ||
		error.hasErrorLabel("RetryableWriteError") && !(error instanceof MongoServerError)
	);
}

function strip<T>(doc: Stored & Record<string, unknown>, missionId: string): T {
	const { _id, schemaVersion, ord, ...rest } = doc;
	void _id;
	void schemaVersion;
	void ord;
	return { ...rest, missionId } as T;
}

export interface MongoLedgerOptions {
	uri: string;
	dbName: string;
	missionId: string;
	serverSelectionTimeoutMS?: number;
}

/**
 * MongoDB (Atlas) mission ledger. One store instance is bound to one mission;
 * every document carries `missionId` and every query is mission-scoped.
 * Once a lease is held, every write commits in a transaction that first bumps
 * the mission document under the lease's fencing token, so a controller whose
 * lease was taken over cannot write.
 */
export class MongoLedgerStore implements LedgerStore {
	readonly backend = "mongodb" as const;
	readonly location: string;
	readonly missionId: string;
	private readonly client: MongoClient;
	private readonly db: Db;
	private readonly txContext = new AsyncLocalStorage<ClientSession>();
	private lease: Lease | null = null;
	private leaseTtlMs = 0;

	private constructor(client: MongoClient, dbName: string, missionId: string, location: string) {
		this.client = client;
		this.db = client.db(dbName);
		this.missionId = missionId;
		this.location = location;
	}

	static async connect(options: MongoLedgerOptions): Promise<MongoLedgerStore> {
		const client = new MongoClient(options.uri, { serverSelectionTimeoutMS: options.serverSelectionTimeoutMS ?? 10_000, retryWrites: true, appName: "horizon" });
		try {
			await client.connect();
			const store = new MongoLedgerStore(client, options.dbName, options.missionId, `${redactUri(options.uri)}/${options.dbName}`);
			await store.ensureIndexes();
			return store;
		} catch (error) {
			await client.close().catch(() => {});
			if (isConnectivityError(error)) throw new LedgerUnavailableError(`MongoDB unreachable at ${redactUri(options.uri)}: ${redactMessage(error, options.uri)}`, { cause: error });
			throw error;
		}
	}

	async ensureIndexes(): Promise<void> {
		for (const name of COLLECTIONS) {
			const specs = INDEXES[name];
			if (specs.length === 0) continue;
			await this.db.collection(name).createIndexes(specs.map((s) => ({ name: s.name, key: s.key, ...(s.unique ? { unique: true } : {}) })));
		}
	}

	private col<T extends Document>(name: CollectionName): Collection<T> {
		return this.db.collection<T>(name);
	}

	private id(key: string): string {
		return `${this.missionId}:${key}`;
	}

	private get session(): ClientSession | undefined {
		return this.txContext.getStore();
	}

	/** Maps connectivity failures at the outermost boundary; inside a transaction the driver's retry labels must survive. */
	private async guard<T>(fn: () => Promise<T>): Promise<T> {
		try {
			return await fn();
		} catch (error) {
			if (!this.session && isConnectivityError(error)) throw new LedgerUnavailableError(`MongoDB ledger unavailable: ${redactMessage(error)}`, { cause: error });
			throw error;
		}
	}

	private async read<T>(fn: (session: ClientSession | undefined) => Promise<T>): Promise<T> {
		return this.guard(() => fn(this.session));
	}

	/** A write: joins the open transaction, or runs in its own fenced transaction while a lease is held. */
	private async write<T>(fn: (session: ClientSession | undefined) => Promise<T>): Promise<T> {
		const session = this.session;
		if (session) return fn(session);
		if (!this.lease) return this.guard(() => fn(undefined));
		return this.transaction(() => fn(this.session));
	}

	private async fence(session: ClientSession): Promise<void> {
		if (!this.lease) return;
		const result = await this.col<MissionDoc>("missions").updateOne(
			{ _id: this.missionId, "lease.owner": this.lease.owner, "lease.token": this.lease.token },
			{ $set: { "lease.fencedAt": new Date() } } as UpdateFilter<MissionDoc>,
			so(session),
		);
		if (result.matchedCount === 0) throw new LeaseLostError(`mission ${this.missionId}: lease token ${this.lease.token} is no longer current; write rejected`);
	}

	async transaction<T>(fn: () => Promise<T>): Promise<T> {
		if (this.session) return fn();
		return this.guard(async () => {
			const session = this.client.startSession();
			try {
				let result: T | undefined;
				await session.withTransaction(
					async () => {
						result = await this.txContext.run(session, async () => {
							await this.fence(session);
							return fn();
						});
					},
					{ readConcern: { level: "snapshot" }, writeConcern: { w: "majority" }, readPreference: "primary" },
				);
				return result as T;
			} finally {
				await session.endSession();
			}
		});
	}

	// ---- lease --------------------------------------------------------------

	async acquireLease(owner: string, ttlMs: number): Promise<Lease> {
		const at = new Date();
		try {
			const doc = await this.guard(() =>
				this.col<MissionDoc>("missions").findOneAndUpdate(
					{ _id: this.missionId, $or: [{ lease: { $exists: false } }, { "lease.owner": null }, { "lease.expiresAt": { $lte: at } }, { "lease.owner": owner }] } as Filter<MissionDoc>,
					{ $set: { "lease.owner": owner, "lease.expiresAt": new Date(at.getTime() + ttlMs), "lease.acquiredAt": at }, $inc: { "lease.token": 1 } } as UpdateFilter<MissionDoc>,
					{ upsert: true, returnDocument: "after" },
				),
			);
			if (!doc?.lease) throw new Error("lease acquisition returned no document");
			this.lease = { owner, token: doc.lease.token };
			this.leaseTtlMs = ttlMs;
			return this.lease;
		} catch (error) {
			if (error instanceof MongoServerError && error.code === 11000) {
				const current = await this.col<MissionDoc>("missions").findOne({ _id: this.missionId });
				throw new LeaseHeldError(`mission ${this.missionId} is leased by ${current?.lease?.owner ?? "another controller"} until ${current?.lease?.expiresAt?.toISOString() ?? "?"}`);
			}
			throw error;
		}
	}

	async renewLease(): Promise<boolean> {
		if (!this.lease) return false;
		const lease = this.lease;
		const result = await this.guard(() =>
			this.col<MissionDoc>("missions").updateOne({ _id: this.missionId, "lease.owner": lease.owner, "lease.token": lease.token }, { $set: { "lease.expiresAt": new Date(Date.now() + this.leaseTtlMs) } } as UpdateFilter<MissionDoc>),
		);
		return result.matchedCount > 0;
	}

	async releaseLease(): Promise<void> {
		if (!this.lease) return;
		const lease = this.lease;
		this.lease = null;
		await this.guard(() =>
			this.col<MissionDoc>("missions").updateOne({ _id: this.missionId, "lease.owner": lease.owner, "lease.token": lease.token }, { $set: { "lease.owner": null, "lease.expiresAt": new Date(0) } } as UpdateFilter<MissionDoc>),
		);
	}

	async close(): Promise<void> {
		await this.releaseLease().catch(() => {});
		await this.client.close();
	}

	private async nextCounter(name: "event" | "checkpoint" | "ord", session: ClientSession | undefined): Promise<number> {
		const doc = await this.col<MissionDoc>("missions").findOneAndUpdate({ _id: this.missionId }, { $inc: { [`counters.${name}`]: 1 } } as UpdateFilter<MissionDoc>, { upsert: true, returnDocument: "after", ...so(session) });
		return doc?.counters?.[name] ?? 1;
	}

	// ---- events -------------------------------------------------------------

	appendEvent(eventKey: string, type: string, entityId: string, payload: unknown): Promise<number> {
		return this.write(async (session) => {
			const events = this.col<EventDoc>("events");
			const existing = await events.findOne({ missionId: this.missionId, eventKey }, so(session));
			if (existing) return existing.seq;
			const seq = await this.nextCounter("event", session);
			await events.insertOne({ _id: this.id(`event:${seq}`), schemaVersion: SCHEMA_VERSION, missionId: this.missionId, seq, eventKey, at: now(), type, entityId, payloadJson: canonicalJson(payload) }, so(session));
			return seq;
		});
	}

	private toEvent(d: EventDoc): EventRow {
		return { seq: d.seq, eventKey: d.eventKey, at: d.at, type: d.type, entityId: d.entityId, payload: JSON.parse(d.payloadJson) };
	}

	eventsSince(seq: number, limit = 1000): Promise<EventRow[]> {
		return this.read(async (session) => (await this.col<EventDoc>("events").find({ missionId: this.missionId, seq: { $gt: seq } }, so(session)).sort({ seq: 1 }).limit(limit).toArray()).map((d) => this.toEvent(d)));
	}

	findEvent(eventKey: string): Promise<EventRow | undefined> {
		return this.read(async (session) => {
			const d = await this.col<EventDoc>("events").findOne({ missionId: this.missionId, eventKey }, so(session));
			return d ? this.toEvent(d) : undefined;
		});
	}

	lastEventSeq(): Promise<number> {
		return this.read(async (session) => (await this.col<MissionDoc>("missions").findOne({ _id: this.missionId }, so(session)))?.counters?.event ?? 0);
	}

	// ---- mission ------------------------------------------------------------

	createMission(row: NewMission): Promise<void> {
		return this.write(async (session) => {
			const { missionId, ...fields } = row;
			if (missionId !== this.missionId) throw new Error(`store is bound to mission ${this.missionId}, not ${missionId}`);
			const existing = await this.col<MissionDoc>("missions").findOne({ _id: this.missionId }, so(session));
			if (existing?.status) throw new Error(`mission ${missionId} already exists`);
			await this.col<MissionDoc>("missions").updateOne(
				{ _id: this.missionId },
				{ $set: { ...fields, schemaVersion: SCHEMA_VERSION, spentExperiments: 0, spentInputTokens: 0, spentOutputTokens: 0, spentMemoryOperations: 0, spentWallMs: 0, usageUncertain: 0, learnedSuiteVersion: 0, createdAt: now() } },
				{ upsert: true, ...so(session) },
			);
		});
	}

	getMission(missionId: string): Promise<MissionRow | undefined> {
		return this.read(async (session) => {
			if (missionId !== this.missionId) return undefined;
			const d = await this.col<MissionDoc>("missions").findOne({ _id: missionId }, so(session));
			if (!d?.status) return undefined;
			const { _id, schemaVersion, counters, lease, ...rest } = d;
			void _id; void schemaVersion; void counters; void lease;
			return { missionId, ...rest } as MissionRow;
		});
	}

	updateMission(missionId: string, patch: MissionPatch): Promise<void> {
		return this.write(async (session) => {
			const set = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
			if (Object.keys(set).length === 0) return;
			await this.col<MissionDoc>("missions").updateOne({ _id: missionId }, { $set: set }, so(session));
		});
	}

	// ---- tasks --------------------------------------------------------------

	upsertTask(task: TaskRow): Promise<void> {
		return this.write(async (session) => {
			const { missionId, status, hypothesis, nextAction, ...rest } = task;
			void missionId;
			await this.col<Doc<TaskRow>>("tasks").updateOne(
				{ _id: this.id(task.taskId) },
				{ $set: { status, hypothesis, nextAction }, $setOnInsert: { ...rest, missionId: this.missionId, schemaVersion: SCHEMA_VERSION } },
				{ upsert: true, ...so(session) },
			);
		});
	}

	listTasks(missionId: string): Promise<TaskRow[]> {
		return this.read(async (session) => (await this.col<Doc<TaskRow>>("tasks").find({ missionId }, so(session)).sort({ ordinal: 1 }).toArray()).map((d) => strip<TaskRow>(d, missionId)));
	}

	// ---- experiments --------------------------------------------------------

	insertExperiment(e: NewExperiment): Promise<void> {
		return this.write(async (session) => {
			const { missionId, ...rest } = e;
			void missionId;
			await this.col<Doc<ExperimentRow>>("experiments").insertOne(
				{ ...rest, _id: this.id(e.experimentId), schemaVersion: SCHEMA_VERSION, missionId: this.missionId, candidateArtifactHash: null, verdict: null, failureSignature: null, reportIds: [], createdAt: now(), finishedAt: null },
				so(session),
			);
		});
	}

	updateExperiment(experimentId: string, patch: ExperimentPatch): Promise<void> {
		return this.write(async (session) => {
			const set = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
			if (Object.keys(set).length === 0) return;
			await this.col<Doc<ExperimentRow>>("experiments").updateOne({ _id: this.id(experimentId) }, { $set: set }, so(session));
		});
	}

	getExperiment(experimentId: string): Promise<ExperimentRow | undefined> {
		return this.read(async (session) => {
			const d = await this.col<Doc<ExperimentRow>>("experiments").findOne({ _id: this.id(experimentId) }, so(session));
			return d ? strip<ExperimentRow>(d, this.missionId) : undefined;
		});
	}

	listExperiments(missionId: string): Promise<ExperimentRow[]> {
		return this.read(async (session) => (await this.col<Doc<ExperimentRow>>("experiments").find({ missionId }, so(session)).sort({ createdAt: 1, experimentId: 1 }).toArray()).map((d) => strip<ExperimentRow>(d, missionId)));
	}

	// ---- artifacts / verification ------------------------------------------

	insertArtifact(a: ArtifactRow): Promise<void> {
		return this.write(async (session) => {
			await this.col<Doc<ArtifactRow> & { missionId: string }>("artifacts").updateOne(
				{ _id: this.id(a.hash) },
				{ $setOnInsert: { ...a, missionId: this.missionId, schemaVersion: SCHEMA_VERSION } },
				{ upsert: true, ...so(session) },
			);
		});
	}

	getArtifact(hash: string): Promise<ArtifactRow | undefined> {
		return this.read(async (session) => {
			const d = await this.col<Doc<ArtifactRow>>("artifacts").findOne({ _id: this.id(hash) }, so(session));
			if (!d) return undefined;
			return { hash: d.hash, path: d.path, parentHash: d.parentHash, manifestHash: d.manifestHash, createdAt: d.createdAt };
		});
	}

	/** Idempotent on the verification identity (experiment, artifact, suite, evaluator, workload, environment). */
	insertVerification(report: VerificationReport, path: string): Promise<void> {
		return this.write(async (session) => {
			const identity = {
				missionId: this.missionId,
				experimentId: report.experimentId,
				artifactHash: report.artifactHash,
				suite: report.suite,
				evaluatorHash: report.evaluatorHash,
				workloadHash: report.workloadHash,
				environmentHash: report.environmentHash,
			};
			const existing = await this.col<Doc<VerificationRow>>("verifications").findOne({ $or: [identity, { _id: this.id(report.reportId) }] }, so(session));
			if (existing) return;
			const ord = await this.nextCounter("ord", session);
			await this.col<Doc<VerificationRow>>("verifications").insertOne(
				{ ...identity, _id: this.id(report.reportId), schemaVersion: SCHEMA_VERSION, ord, reportId: report.reportId, reportHash: reportHash(report), status: report.status, p95LatencyMs: report.metrics.p95LatencyMs ?? null, path },
				so(session),
			);
		});
	}

	findVerification(experimentId: string, artifactHash: string, suite: string): Promise<VerificationRow | undefined> {
		return this.read(async (session) => {
			const d = await this.col<Doc<VerificationRow>>("verifications").findOne({ missionId: this.missionId, experimentId, artifactHash, suite }, { ...so(session), sort: { ord: 1 } });
			return d ? strip<VerificationRow>(d, this.missionId) : undefined;
		});
	}

	listVerifications(missionId: string): Promise<VerificationRow[]> {
		return this.read(async (session) => (await this.col<Doc<VerificationRow>>("verifications").find({ missionId }, so(session)).sort({ ord: 1 }).toArray()).map((d) => strip<VerificationRow>(d, missionId)));
	}

	// ---- episodes / lessons -------------------------------------------------

	insertEpisode(e: EpisodeRow): Promise<void> {
		return this.write(async (session) => {
			const { missionId, ...rest } = e;
			await this.col<Doc<EpisodeRow>>("episodes").updateOne({ _id: this.id(e.episodeId) }, { $setOnInsert: { ...rest, missionId, schemaVersion: SCHEMA_VERSION } }, { upsert: true, ...so(session) });
		});
	}

	isIndexed(episodeId: string): Promise<boolean> {
		return this.read(async (session) => (await this.col<OutboxDoc>("outbox").findOne({ missionId: this.missionId, episodeId, state: "memory_ready" }, { ...so(session), projection: { _id: 1 } })) !== null);
	}

	isSuperseded(episodeId: string): Promise<boolean> {
		return this.read(async (session) => (await this.col<Doc<EpisodeRow>>("episodes").findOne({ missionId: this.missionId, supersedes: episodeId }, { ...so(session), projection: { _id: 1 } })) !== null);
	}

	async currentVersionOf(episodeId: string): Promise<EpisodeRow | undefined> {
		let current = await this.getEpisode(episodeId);
		for (let hops = 0; current && hops < 64; hops += 1) {
			const from: EpisodeRow = current;
			const next = await this.read((session) => this.col<Doc<EpisodeRow>>("episodes").findOne({ missionId: this.missionId, supersedes: from.episodeId }, { ...so(session), sort: { version: -1 } }));
			if (!next) return current;
			current = strip<EpisodeRow>(next, this.missionId);
		}
		return current;
	}

	/** Bounded candidate window: the newest episodes plus any whose memory delivery is not yet ready. */
	private async episodeWindow(unindexedOnly: boolean): Promise<EpisodeRow[]> {
		return this.read(async (session) => {
			const episodes = this.col<Doc<EpisodeRow>>("episodes");
			const outbox = this.col<OutboxDoc>("outbox");
			const recent = await episodes.find({ missionId: this.missionId }, so(session)).sort({ createdAt: -1 }).limit(EPISODE_WINDOW).toArray();
			const pendingIds = await outbox.distinct("episodeId", { missionId: this.missionId, state: { $ne: "memory_ready" } }, so(session));
			const have = new Set(recent.map((d) => d.episodeId));
			const missing = pendingIds.filter((id) => !have.has(id)).slice(0, EPISODE_WINDOW);
			const pending = missing.length > 0 ? await episodes.find({ missionId: this.missionId, episodeId: { $in: missing } }, so(session)).toArray() : [];
			let rows = [...recent, ...pending].map((d) => strip<EpisodeRow>(d, this.missionId));
			if (unindexedOnly) {
				const ready = new Set(await outbox.distinct("episodeId", { missionId: this.missionId, state: "memory_ready", episodeId: { $in: rows.map((r) => r.episodeId) } }, so(session)));
				rows = rows.filter((r) => !ready.has(r.episodeId));
			}
			return rows;
		});
	}

	async searchEpisodes(missionId: string, query: string, limit: number, options: { unindexedOnly?: boolean } = {}): Promise<EpisodeRow[]> {
		if (missionId !== this.missionId || limit <= 0) return [];
		return rankWindow(await this.episodeWindow(options.unindexedOnly ?? false), query, limit);
	}

	async termWeights(terms: string[]): Promise<Map<string, number>> {
		return windowTermWeights(await this.episodeWindow(false), terms);
	}

	getEpisode(episodeId: string): Promise<EpisodeRow | undefined> {
		return this.read(async (session) => {
			const d = await this.col<Doc<EpisodeRow>>("episodes").findOne({ _id: this.id(episodeId) }, so(session));
			return d ? strip<EpisodeRow>(d, this.missionId) : undefined;
		});
	}

	listEpisodes(missionId: string): Promise<EpisodeRow[]> {
		return this.read(async (session) => (await this.col<Doc<EpisodeRow>>("episodes").find({ missionId }, so(session)).sort({ createdAt: 1 }).toArray()).map((d) => strip<EpisodeRow>(d, missionId)));
	}

	upsertLesson(l: LessonRow): Promise<void> {
		return this.write(async (session) => {
			const lessons = this.col<Doc<LessonRow>>("lessons");
			const { state, positiveEvidenceId, negativeEvidenceId, materializedScenarioId, transitions, missionId, ...rest } = l;
			void missionId;
			const existing = await lessons.findOne({ _id: this.id(l.lessonId) }, { ...so(session), projection: { _id: 1 } });
			const set = { state, positiveEvidenceId, negativeEvidenceId, materializedScenarioId, transitions };
			if (existing) await lessons.updateOne({ _id: this.id(l.lessonId) }, { $set: set }, so(session));
			else await lessons.insertOne({ ...rest, ...set, _id: this.id(l.lessonId), missionId: this.missionId, schemaVersion: SCHEMA_VERSION, ord: await this.nextCounter("ord", session) }, so(session));
		});
	}

	listLessons(missionId: string): Promise<LessonRow[]> {
		return this.read(async (session) => (await this.col<Doc<LessonRow>>("lessons").find({ missionId }, so(session)).sort({ ord: 1 }).toArray()).map((d) => strip<LessonRow>(d, missionId)));
	}

	insertLearnedScenario(scenarioId: string, missionId: string, lessonId: string, suiteVersion: number, path: string): Promise<void> {
		return this.write(async (session) => {
			await this.col<Doc<LearnedScenarioRow>>("learnedScenarios").insertOne({ _id: this.id(scenarioId), schemaVersion: SCHEMA_VERSION, missionId, scenarioId, lessonId, suiteVersion, path }, so(session));
		});
	}

	listLearnedScenarios(missionId: string): Promise<LearnedScenarioRow[]> {
		return this.read(async (session) =>
			(await this.col<Doc<LearnedScenarioRow>>("learnedScenarios").find({ missionId }, so(session)).sort({ suiteVersion: 1 }).toArray()).map((d) => ({ scenarioId: d.scenarioId, lessonId: d.lessonId, suiteVersion: d.suiteVersion, path: d.path })),
		);
	}

	// ---- checkpoints / segments / outbox -----------------------------------

	writeCheckpoint(c: NewCheckpoint): Promise<CheckpointRow> {
		return this.write(async (session) => {
			const seq = await this.nextCounter("checkpoint", session);
			const checkpointId = `ckpt-${c.missionId}-${String(seq).padStart(6, "0")}`;
			const lastEventSeq = (await this.col<MissionDoc>("missions").findOne({ _id: this.missionId }, so(session)))?.counters?.event ?? 0;
			const row: CheckpointRow = { ...c, checkpointId, seq, lastEventSeq, createdAt: now() };
			const { missionId, ...rest } = row;
			await this.col<Doc<CheckpointRow>>("checkpoints").insertOne({ ...rest, _id: this.id(checkpointId), missionId, schemaVersion: SCHEMA_VERSION }, so(session));
			return row;
		});
	}

	latestCheckpoint(missionId: string): Promise<CheckpointRow | undefined> {
		return this.read(async (session) => {
			const d = await this.col<Doc<CheckpointRow>>("checkpoints").findOne({ missionId }, { ...so(session), sort: { seq: -1 } });
			return d ? strip<CheckpointRow>(d, missionId) : undefined;
		});
	}

	countCheckpoints(missionId: string): Promise<number> {
		return this.read((session) => this.col("checkpoints").countDocuments({ missionId }, so(session)));
	}

	openSegment(missionId: string, ordinal: number, sessionPath: string | null, sessionId: string | null): Promise<void> {
		return this.write(async (session) => {
			const firstEventSeq = (await this.col<MissionDoc>("missions").findOne({ _id: this.missionId }, so(session)))?.counters?.event ?? 0;
			await this.col<Doc<SegmentRow>>("segments").replaceOne(
				{ _id: this.id(`segment:${ordinal}`) },
				{ schemaVersion: SCHEMA_VERSION, missionId, ordinal, sessionPath, sessionId, checkpointId: null, startedAt: now(), closedAt: null, firstEventSeq, lastEventSeq: null, archiveHash: null, committed: 0 },
				{ upsert: true, ...so(session) },
			);
		});
	}

	commitSegment(missionId: string, ordinal: number, checkpointId: string): Promise<void> {
		return this.write(async (session) => {
			await this.col<Doc<SegmentRow>>("segments").updateOne({ missionId, ordinal }, { $set: { committed: 1, checkpointId } }, so(session));
		});
	}

	closeSegment(missionId: string, ordinal: number, archiveHash: string | null): Promise<void> {
		return this.write(async (session) => {
			const lastEventSeq = (await this.col<MissionDoc>("missions").findOne({ _id: this.missionId }, so(session)))?.counters?.event ?? 0;
			await this.col<Doc<SegmentRow>>("segments").updateOne({ missionId, ordinal }, { $set: { closedAt: now(), lastEventSeq, archiveHash } }, so(session));
		});
	}

	activeSegment(missionId: string): Promise<SegmentRow | undefined> {
		return this.read(async (session) => {
			const d = await this.col<Doc<SegmentRow>>("segments").findOne({ missionId, committed: 1, closedAt: null }, { ...so(session), sort: { ordinal: -1 } });
			return d ? strip<SegmentRow>(d, missionId) : undefined;
		});
	}

	listSegments(missionId: string): Promise<SegmentRow[]> {
		return this.read(async (session) => (await this.col<Doc<SegmentRow>>("segments").find({ missionId }, so(session)).sort({ ordinal: 1 }).toArray()).map((d) => strip<SegmentRow>(d, missionId)));
	}

	discardUncommittedSegments(missionId: string): Promise<number> {
		return this.write(async (session) => (await this.col("segments").deleteMany({ missionId, committed: 0 }, so(session))).deletedCount);
	}

	enqueueOutbox(episodeId: string, payload: unknown): Promise<string> {
		return this.write(async (session) => {
			const payloadHash = sha256(canonicalJson(payload));
			const idempotencyKey = `${episodeId}:${payloadHash.slice(0, 16)}`;
			const outbox = this.col<OutboxDoc>("outbox");
			const existing = await outbox.findOne({ _id: this.id(idempotencyKey) }, { ...so(session), projection: { _id: 1 } });
			if (existing) return idempotencyKey;
			const at = now();
			await outbox.insertOne(
				{ _id: this.id(idempotencyKey), schemaVersion: SCHEMA_VERSION, missionId: this.missionId, ord: await this.nextCounter("ord", session), idempotencyKey, episodeId, payloadHash, payloadJson: JSON.stringify(payload), remoteDocumentId: null, state: "pending", retries: 0, nextAttemptAt: at, lastError: null, updatedAt: at },
				so(session),
			);
			return idempotencyKey;
		});
	}

	outboxPayloadForEpisode(episodeId: string): Promise<unknown> {
		return this.read(async (session) => {
			const d = await this.col<OutboxDoc>("outbox").findOne({ missionId: this.missionId, episodeId }, { ...so(session), sort: { ord: -1 } });
			return d ? JSON.parse(d.payloadJson) : undefined;
		});
	}

	outboxPayload(key: string): Promise<unknown> {
		return this.read(async (session) => {
			const d = await this.col<OutboxDoc>("outbox").findOne({ _id: this.id(key) }, so(session));
			return d ? JSON.parse(d.payloadJson) : undefined;
		});
	}

	updateOutbox(key: string, patch: OutboxPatch): Promise<void> {
		return this.write(async (session) => {
			const set = { ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)), updatedAt: now() };
			await this.col<OutboxDoc>("outbox").updateOne({ _id: this.id(key) }, { $set: set }, so(session));
		});
	}

	listOutbox(states?: OutboxState[]): Promise<OutboxRow[]> {
		return this.read(async (session) => {
			const cursor = states
				? this.col<OutboxDoc>("outbox").find({ missionId: this.missionId, state: { $in: states } }, so(session)).sort({ nextAttemptAt: 1, ord: 1 })
				: this.col<OutboxDoc>("outbox").find({ missionId: this.missionId }, so(session)).sort({ ord: 1 });
			return (await cursor.toArray()).map((d) => ({ idempotencyKey: d.idempotencyKey, episodeId: d.episodeId, payloadHash: d.payloadHash, remoteDocumentId: d.remoteDocumentId, state: d.state, retries: d.retries, nextAttemptAt: d.nextAttemptAt, lastError: d.lastError, updatedAt: d.updatedAt }));
		});
	}

	// ---- operations ---------------------------------------------------------

	beginOperation(op: NewOperation): Promise<void> {
		return this.write(async (session) => {
			const at = now();
			const { missionId, operationId, ...rest } = op;
			await this.col<Doc<OperationRow>>("operations").updateOne(
				{ _id: this.id(operationId) },
				{ $set: { ...rest, state: "started", resultRef: null, updatedAt: at }, $setOnInsert: { operationId, missionId, schemaVersion: SCHEMA_VERSION, createdAt: at } },
				{ upsert: true, ...so(session) },
			);
		});
	}

	finishOperation(operationId: string, state: Exclude<OperationState, "started">, resultRef: string | null): Promise<void> {
		return this.write(async (session) => {
			await this.col<Doc<OperationRow>>("operations").updateOne({ _id: this.id(operationId) }, { $set: { state, resultRef, updatedAt: now() } }, so(session));
		});
	}

	getOperation(operationId: string): Promise<OperationRow | undefined> {
		return this.read(async (session) => {
			const d = await this.col<Doc<OperationRow>>("operations").findOne({ _id: this.id(operationId) }, so(session));
			return d ? strip<OperationRow>(d, this.missionId) : undefined;
		});
	}

	listOperations(missionId: string, states?: OperationState[]): Promise<OperationRow[]> {
		return this.read(async (session) =>
			(await this.col<Doc<OperationRow>>("operations").find({ missionId, ...(states ? { state: { $in: states } } : {}) }, so(session)).sort({ createdAt: 1 }).toArray()).map((d) => strip<OperationRow>(d, missionId)),
		);
	}
}

function redactMessage(error: unknown, uri?: string): string {
	let message = error instanceof Error ? error.message : String(error);
	if (uri) {
		const creds = /\/\/([^@/]+)@/.exec(uri)?.[1];
		if (creds) message = message.replaceAll(creds, "***");
	}
	return message.replace(/\/\/[^@/\s]+@/g, "//***@");
}

export interface ProbeResult {
	ok: boolean;
	checks: { name: string; ok: boolean; detail: string }[];
}

/**
 * Doctor probe: connect, create/verify indexes, write and read a disposable
 * record, commit and abort a transaction, then remove the probe data.
 */
export async function probeMongo(uri: string, dbName: string): Promise<ProbeResult> {
	const checks: ProbeResult["checks"] = [];
	const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });
	const probeMission = `doctor-probe-${randomUUID()}`;
	let store: MongoLedgerStore | undefined;
	const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000, appName: "horizon-doctor" });
	try {
		await client.connect();
		const hello = await client.db(dbName).command({ hello: 1 });
		add("connect", true, `${redactUri(uri)}/${dbName}`);
		const txCapable = typeof hello.setName === "string" || hello.msg === "isdbgrid";
		add("topology", txCapable, txCapable ? (hello.setName ? `replica set ${String(hello.setName)}` : "sharded") : "standalone server: transactions unavailable");
		store = await MongoLedgerStore.connect({ uri, dbName, missionId: probeMission, serverSelectionTimeoutMS: 8000 });
		const missingIndexes: string[] = [];
		for (const name of COLLECTIONS) {
			const have = new Set((await client.db(dbName).collection(name).listIndexes().toArray()).map((i) => String(i.name)));
			for (const spec of INDEXES[name]) if (!have.has(spec.name)) missingIndexes.push(`${name}.${spec.name}`);
		}
		add("indexes", missingIndexes.length === 0, missingIndexes.length === 0 ? `${COLLECTIONS.length} collections indexed` : `missing ${missingIndexes.join(", ")}`);
		await store.appendEvent("probe:write", "probe", probeMission, { at: now() });
		add("write/read", (await store.findEvent("probe:write"))?.type === "probe", "disposable event round-trip");
		if (txCapable) {
			await store.transaction(async () => {
				await store!.appendEvent("probe:tx-commit", "probe", probeMission, {});
			});
			await store
				.transaction(async () => {
					await store!.appendEvent("probe:tx-abort", "probe", probeMission, {});
					throw new Error("abort");
				})
				.catch(() => {});
			const committed = (await store.findEvent("probe:tx-commit")) !== undefined;
			const aborted = (await store.findEvent("probe:tx-abort")) === undefined;
			add("transaction", committed && aborted, committed && aborted ? "commit visible, abort rolled back" : `commit=${committed} rollback=${aborted}`);
		}
	} catch (error) {
		add("connect", false, redactMessage(error, uri));
	} finally {
		for (const name of COLLECTIONS) await client.db(dbName).collection(name).deleteMany(name === "missions" ? { _id: probeMission as unknown as Document["_id"] } : { missionId: probeMission }).catch(() => {});
		await store?.close().catch(() => {});
		await client.close().catch(() => {});
	}
	return { ok: checks.every((c) => c.ok), checks };
}
