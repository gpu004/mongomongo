import { AsyncLocalStorage } from "node:async_hooks";
import type { VerificationReport } from "../verification/reports.ts";
import {
	type ArtifactRow,
	type CheckpointRow,
	type EpisodeRow,
	type EventRow,
	type ExperimentRow,
	Ledger,
	type LessonRow,
	type MissionRow,
	type OperationRow,
	type OperationState,
	type OutboxRow,
	type OutboxState,
	type SegmentRow,
	type TaskRow,
	type VerificationRow,
} from "./ledger.ts";

export type LedgerBackend = "sqlite" | "mongodb";

export interface LearnedScenarioRow {
	scenarioId: string;
	lessonId: string;
	suiteVersion: number;
	path: string;
}

export type NewMission = Omit<MissionRow, "createdAt" | "spentExperiments" | "spentInputTokens" | "spentOutputTokens" | "spentMemoryOperations" | "spentWallMs" | "usageUncertain" | "learnedSuiteVersion">;
export type NewExperiment = Omit<ExperimentRow, "createdAt" | "finishedAt" | "reportIds" | "verdict" | "failureSignature" | "candidateArtifactHash">;
export type ExperimentPatch = Partial<Pick<ExperimentRow, "status" | "verdict" | "candidateArtifactHash" | "failureSignature" | "reportIds" | "finishedAt" | "attempt" | "hypothesis">>;
export type MissionPatch = Partial<Omit<MissionRow, "missionId" | "createdAt">>;
export type NewCheckpoint = Omit<CheckpointRow, "checkpointId" | "seq" | "createdAt" | "lastEventSeq">;
export type OutboxPatch = Partial<Pick<OutboxRow, "state" | "remoteDocumentId" | "retries" | "nextAttemptAt" | "lastError">>;
export type NewOperation = Pick<OperationRow, "operationId" | "missionId" | "kind" | "experimentId" | "sandboxId" | "detail">;

export interface Lease {
	owner: string;
	token: number;
}

/** The canonical store is unreachable; the controller must stop scheduling work rather than fall back. */
export class LedgerUnavailableError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "LedgerUnavailableError";
	}
}

/** Another live controller owns the mission lease. */
export class LeaseHeldError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "LeaseHeldError";
	}
}

/** This controller's lease was taken over; its writes are rejected by the fencing token. */
export class LeaseLostError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "LeaseLostError";
	}
}

/**
 * Backend-neutral mission ledger. Exactly one backend is selected per mission;
 * there is no dual-write and no fallback between backends. Writes inside
 * `transaction` commit or roll back together. Filesystem work, sandbox launches
 * and remote API calls must stay outside transaction callbacks.
 */
export interface LedgerStore {
	readonly backend: LedgerBackend;
	/** Human-readable location without credentials. */
	readonly location: string;

	acquireLease(owner: string, ttlMs: number): Promise<Lease>;
	renewLease(): Promise<boolean>;
	releaseLease(): Promise<void>;
	close(): Promise<void>;
	transaction<T>(fn: () => Promise<T>): Promise<T>;

	appendEvent(eventKey: string, type: string, entityId: string, payload: unknown): Promise<number>;
	eventsSince(seq: number, limit?: number): Promise<EventRow[]>;
	findEvent(eventKey: string): Promise<EventRow | undefined>;
	lastEventSeq(): Promise<number>;

	createMission(row: NewMission): Promise<void>;
	getMission(missionId: string): Promise<MissionRow | undefined>;
	updateMission(missionId: string, patch: MissionPatch): Promise<void>;

	upsertTask(task: TaskRow): Promise<void>;
	listTasks(missionId: string): Promise<TaskRow[]>;

	insertExperiment(e: NewExperiment): Promise<void>;
	updateExperiment(experimentId: string, patch: ExperimentPatch): Promise<void>;
	getExperiment(experimentId: string): Promise<ExperimentRow | undefined>;
	listExperiments(missionId: string): Promise<ExperimentRow[]>;

	insertArtifact(a: ArtifactRow): Promise<void>;
	getArtifact(hash: string): Promise<ArtifactRow | undefined>;
	insertVerification(report: VerificationReport, path: string): Promise<void>;
	findVerification(experimentId: string, artifactHash: string, suite: string): Promise<VerificationRow | undefined>;
	listVerifications(missionId: string): Promise<VerificationRow[]>;

	insertEpisode(e: EpisodeRow): Promise<void>;
	isIndexed(episodeId: string): Promise<boolean>;
	isSuperseded(episodeId: string): Promise<boolean>;
	currentVersionOf(episodeId: string): Promise<EpisodeRow | undefined>;
	searchEpisodes(missionId: string, query: string, limit: number, options?: { unindexedOnly?: boolean }): Promise<EpisodeRow[]>;
	termWeights(terms: string[]): Promise<Map<string, number>>;
	getEpisode(episodeId: string): Promise<EpisodeRow | undefined>;
	listEpisodes(missionId: string): Promise<EpisodeRow[]>;

	upsertLesson(l: LessonRow): Promise<void>;
	listLessons(missionId: string): Promise<LessonRow[]>;
	insertLearnedScenario(scenarioId: string, missionId: string, lessonId: string, suiteVersion: number, path: string): Promise<void>;
	listLearnedScenarios(missionId: string): Promise<LearnedScenarioRow[]>;

	writeCheckpoint(c: NewCheckpoint): Promise<CheckpointRow>;
	latestCheckpoint(missionId: string): Promise<CheckpointRow | undefined>;
	countCheckpoints(missionId: string): Promise<number>;

	openSegment(missionId: string, ordinal: number, sessionPath: string | null, sessionId: string | null): Promise<void>;
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

	beginOperation(op: NewOperation): Promise<void>;
	finishOperation(operationId: string, state: Exclude<OperationState, "started">, resultRef: string | null): Promise<void>;
	getOperation(operationId: string): Promise<OperationRow | undefined>;
	listOperations(missionId: string, states?: OperationState[]): Promise<OperationRow[]>;
}

/** Anything the memory path accepts: the async store, or a raw local SQLite ledger (benchmarks, probes). */
export type LedgerLike = LedgerStore | Ledger;

export function asStore(ledger: LedgerLike): LedgerStore {
	return ledger instanceof Ledger ? new SqliteLedgerStore(ledger) : ledger;
}

/**
 * SQLite adapter over the synchronous `Ledger`. The controller lock file is the
 * lease (single host); the fencing token is constant because a second
 * controller cannot open the lock while the first is alive.
 */
export class SqliteLedgerStore implements LedgerStore {
	readonly backend = "sqlite" as const;
	readonly ledger: Ledger;
	private readonly txContext = new AsyncLocalStorage<true>();
	private activeTx: Promise<unknown> | null = null;

	constructor(ledger: Ledger) {
		this.ledger = ledger;
	}

	get location(): string {
		return this.ledger.path;
	}

	/** Operations from outside an open transaction wait for it, so they never join or split it. */
	private async run<T>(fn: (l: Ledger) => T): Promise<T> {
		while (this.activeTx && !this.txContext.getStore()) await this.activeTx.catch(() => {});
		return fn(this.ledger);
	}

	async acquireLease(): Promise<Lease> {
		this.ledger.acquireLock();
		return { owner: String(process.pid), token: 1 };
	}

	async renewLease(): Promise<boolean> {
		return true;
	}

	async releaseLease(): Promise<void> {
		this.ledger.releaseLock();
	}

	async close(): Promise<void> {
		this.ledger.close();
	}

	async transaction<T>(fn: () => Promise<T>): Promise<T> {
		if (this.txContext.getStore()) return fn();
		while (this.activeTx) await this.activeTx.catch(() => {});
		const work = this.txContext.run(true, async () => {
			this.ledger.db.exec("BEGIN IMMEDIATE");
			try {
				const result = await fn();
				this.ledger.db.exec("COMMIT");
				return result;
			} catch (error) {
				this.ledger.db.exec("ROLLBACK");
				throw error;
			}
		});
		this.activeTx = work;
		try {
			return await work;
		} finally {
			this.activeTx = null;
		}
	}

	appendEvent(eventKey: string, type: string, entityId: string, payload: unknown) { return this.run((l) => l.appendEvent(eventKey, type, entityId, payload)); }
	eventsSince(seq: number, limit?: number) { return this.run((l) => l.eventsSince(seq, limit)); }
	findEvent(eventKey: string) { return this.run((l) => l.findEvent(eventKey)); }
	lastEventSeq() { return this.run((l) => l.lastEventSeq()); }
	createMission(row: NewMission) { return this.run((l) => l.createMission(row)); }
	getMission(missionId: string) { return this.run((l) => l.getMission(missionId)); }
	updateMission(missionId: string, patch: MissionPatch) { return this.run((l) => l.updateMission(missionId, patch)); }
	upsertTask(task: TaskRow) { return this.run((l) => l.upsertTask(task)); }
	listTasks(missionId: string) { return this.run((l) => l.listTasks(missionId)); }
	insertExperiment(e: NewExperiment) { return this.run((l) => l.insertExperiment(e)); }
	updateExperiment(experimentId: string, patch: ExperimentPatch) { return this.run((l) => l.updateExperiment(experimentId, patch)); }
	getExperiment(experimentId: string) { return this.run((l) => l.getExperiment(experimentId)); }
	listExperiments(missionId: string) { return this.run((l) => l.listExperiments(missionId)); }
	insertArtifact(a: ArtifactRow) { return this.run((l) => l.insertArtifact(a)); }
	getArtifact(hash: string) { return this.run((l) => l.getArtifact(hash)); }
	insertVerification(report: VerificationReport, path: string) { return this.run((l) => l.insertVerification(report, path)); }
	findVerification(experimentId: string, artifactHash: string, suite: string) { return this.run((l) => l.findVerification(experimentId, artifactHash, suite)); }
	listVerifications(missionId: string) { return this.run((l) => l.listVerifications(missionId)); }
	insertEpisode(e: EpisodeRow) { return this.run((l) => l.insertEpisode(e)); }
	isIndexed(episodeId: string) { return this.run((l) => l.isIndexed(episodeId)); }
	isSuperseded(episodeId: string) { return this.run((l) => l.isSuperseded(episodeId)); }
	currentVersionOf(episodeId: string) { return this.run((l) => l.currentVersionOf(episodeId)); }
	searchEpisodes(missionId: string, query: string, limit: number, options?: { unindexedOnly?: boolean }) { return this.run((l) => l.searchEpisodes(missionId, query, limit, options)); }
	termWeights(terms: string[]) { return this.run((l) => l.termWeights(terms)); }
	getEpisode(episodeId: string) { return this.run((l) => l.getEpisode(episodeId)); }
	listEpisodes(missionId: string) { return this.run((l) => l.listEpisodes(missionId)); }
	upsertLesson(lesson: LessonRow) { return this.run((l) => l.upsertLesson(lesson)); }
	listLessons(missionId: string) { return this.run((l) => l.listLessons(missionId)); }
	insertLearnedScenario(scenarioId: string, missionId: string, lessonId: string, suiteVersion: number, path: string) { return this.run((l) => l.insertLearnedScenario(scenarioId, missionId, lessonId, suiteVersion, path)); }
	listLearnedScenarios(missionId: string) { return this.run((l) => l.listLearnedScenarios(missionId)); }
	writeCheckpoint(c: NewCheckpoint) { return this.run((l) => l.writeCheckpoint(c)); }
	latestCheckpoint(missionId: string) { return this.run((l) => l.latestCheckpoint(missionId)); }
	countCheckpoints(missionId: string) { return this.run((l) => l.countCheckpoints(missionId)); }
	openSegment(missionId: string, ordinal: number, sessionPath: string | null, sessionId: string | null) { return this.run((l) => l.openSegment(missionId, ordinal, sessionPath, sessionId)); }
	commitSegment(missionId: string, ordinal: number, checkpointId: string) { return this.run((l) => l.commitSegment(missionId, ordinal, checkpointId)); }
	closeSegment(missionId: string, ordinal: number, archiveHash: string | null) { return this.run((l) => l.closeSegment(missionId, ordinal, archiveHash)); }
	activeSegment(missionId: string) { return this.run((l) => l.activeSegment(missionId)); }
	listSegments(missionId: string) { return this.run((l) => l.listSegments(missionId)); }
	discardUncommittedSegments(missionId: string) { return this.run((l) => l.discardUncommittedSegments(missionId)); }
	enqueueOutbox(episodeId: string, payload: unknown) { return this.run((l) => l.enqueueOutbox(episodeId, payload)); }
	outboxPayloadForEpisode(episodeId: string) { return this.run((l) => l.outboxPayloadForEpisode(episodeId)); }
	outboxPayload(key: string) { return this.run((l) => l.outboxPayload(key)); }
	updateOutbox(key: string, patch: OutboxPatch) { return this.run((l) => l.updateOutbox(key, patch)); }
	listOutbox(states?: OutboxState[]) { return this.run((l) => l.listOutbox(states)); }
	beginOperation(op: NewOperation) { return this.run((l) => l.beginOperation(op)); }
	finishOperation(operationId: string, state: Exclude<OperationState, "started">, resultRef: string | null) { return this.run((l) => l.finishOperation(operationId, state, resultRef)); }
	getOperation(operationId: string) { return this.run((l) => l.getOperation(operationId)); }
	listOperations(missionId: string, states?: OperationState[]) { return this.run((l) => l.listOperations(missionId, states)); }
}

// ---- backend-neutral bounded retrieval ----------------------------------

export function queryTerms(text: string): string[] {
	return [...new Set(text.toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter(Boolean))];
}

/** IDF of each term over a candidate window, same formula as the SQLite FTS vocabulary weights. */
export function windowTermWeights(window: EpisodeRow[], terms: string[]): Map<string, number> {
	const docs = window.map((e) => new Set(queryTerms(e.summary)));
	return new Map(terms.map((t) => [t, Math.log((window.length + 1) / (docs.filter((d) => d.has(t)).length + 1)) + 0.01]));
}

/**
 * Ranks a bounded candidate window locally: IDF-weighted term overlap, newest
 * first on ties. Used where full-text search is not available (Atlas without
 * Atlas Search); coverage is the window, not the whole mission history.
 */
export function rankWindow(window: EpisodeRow[], query: string, limit: number): EpisodeRow[] {
	const terms = queryTerms(query);
	if (terms.length === 0 || limit <= 0) return [];
	const weights = windowTermWeights(window, terms);
	return window
		.map((row) => {
			const present = new Set(queryTerms(row.summary));
			return { row, score: terms.reduce((n, t) => n + (present.has(t) ? weights.get(t)! : 0), 0) };
		})
		.filter((s) => s.score > 0)
		.sort((a, b) => b.score - a.score || b.row.createdAt.localeCompare(a.row.createdAt))
		.slice(0, limit)
		.map((s) => s.row);
}
