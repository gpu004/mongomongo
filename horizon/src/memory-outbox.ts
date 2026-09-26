import type { FileEvidenceStore } from "./mission-paths.ts";
import type { EpisodeRow, Ledger, OutboxRow } from "./ledger.ts";
import { type EpisodePayload, episodeMetadata, type MemoryAdapter, type MemoryHit, renderEpisode } from "./memory-adapter.ts";

export interface OutboxDrainResult {
	attempted: number;
	submitted: number;
	ready: number;
	failed: number;
	degraded: boolean;
}

const BASE_DELAY_MS = 2000;
const MAX_DELAY_MS = 5 * 60 * 1000;
const MAX_RETRIES = 8;

/**
 * Delivers episodes to the memory service without ever blocking a checkpoint.
 * Enqueue is a ledger write; `drain` runs opportunistically and records each
 * state transition (pending -> submitted -> document_ready/memory_ready).
 * API acceptance is not readiness: a document counts as ready only when the
 * remote status says so, and the same customId is reused on every retry.
 */
export class MemoryOutbox {
	private readonly ledger: Ledger;
	private readonly adapter: MemoryAdapter;
	private readonly containerTag: string;
	private readonly payloads: (episodeId: string) => EpisodePayload | undefined;
	private readonly onOperation: () => void;

	constructor(ledger: Ledger, adapter: MemoryAdapter, containerTag: string, payloads: (episodeId: string) => EpisodePayload | undefined, onOperation: () => void) {
		this.ledger = ledger;
		this.adapter = adapter;
		this.containerTag = containerTag;
		this.payloads = payloads;
		this.onOperation = onOperation;
	}

	enqueue(payload: EpisodePayload): string {
		return this.ledger.enqueueOutbox(payload.episodeId, payload);
	}

	async drain(nowMs = Date.now()): Promise<OutboxDrainResult> {
		const result: OutboxDrainResult = { attempted: 0, submitted: 0, ready: 0, failed: 0, degraded: false };
		for (const row of this.ledger.listOutbox(["pending", "failed", "submitted", "document_ready"])) {
			if (Date.parse(row.nextAttemptAt) > nowMs) continue;
			if (row.state === "failed" && row.retries >= MAX_RETRIES) continue;
			result.attempted += 1;
			try {
				if (row.state === "pending" || row.state === "failed") {
					await this.submit(row);
					result.submitted += 1;
				} else {
					const ready = await this.checkReady(row);
					if (ready) result.ready += 1;
				}
			} catch (error) {
				result.failed += 1;
				result.degraded = true;
				this.backoff(row, error instanceof Error ? error.message : String(error), nowMs);
			}
		}
		return result;
	}

	private async submit(row: OutboxRow): Promise<void> {
		const payload = this.payloads(row.episodeId);
		if (!payload) {
			this.ledger.updateOutbox(row.idempotencyKey, { state: "failed", lastError: "episode payload missing locally", retries: MAX_RETRIES });
			return;
		}
		this.onOperation();
		const { remoteId } = await this.adapter.add(this.containerTag, payload.episodeId, renderEpisode(payload), episodeMetadata(payload));
		this.ledger.updateOutbox(row.idempotencyKey, { state: "submitted", remoteDocumentId: remoteId, lastError: null, nextAttemptAt: new Date().toISOString() });
		this.ledger.appendEvent(`outbox:${row.idempotencyKey}:submitted`, "memory.submitted", row.episodeId, { remoteId });
	}

	private async checkReady(row: OutboxRow): Promise<boolean> {
		if (!row.remoteDocumentId) return false;
		this.onOperation();
		const status = await this.adapter.status(row.remoteDocumentId);
		if (status === "done") {
			this.ledger.updateOutbox(row.idempotencyKey, { state: "memory_ready", lastError: null });
			this.ledger.appendEvent(`outbox:${row.idempotencyKey}:ready`, "memory.ready", row.episodeId, { remoteId: row.remoteDocumentId });
			return true;
		}
		if (status === "failed") {
			this.ledger.updateOutbox(row.idempotencyKey, { state: "failed", lastError: "remote processing failed", retries: row.retries + 1, nextAttemptAt: new Date(Date.now() + BASE_DELAY_MS).toISOString() });
			return false;
		}
		this.ledger.updateOutbox(row.idempotencyKey, { state: "document_ready", nextAttemptAt: new Date(Date.now() + BASE_DELAY_MS).toISOString() });
		return false;
	}

	private backoff(row: OutboxRow, message: string, nowMs: number): void {
		const retries = row.retries + 1;
		const delay = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.min(retries, 10));
		this.ledger.updateOutbox(row.idempotencyKey, { state: row.state === "pending" ? "failed" : row.state, retries, lastError: message, nextAttemptAt: new Date(nowMs + delay).toISOString() });
	}
}

export interface RetrievalSelection {
	injected: { episodeId: string; text: string; source: "remote" | "local_cache" }[];
	filteredOut: { episodeId: string | null; reason: string }[];
	degraded: boolean;
}

/**
 * Retrieval policy: ask for a small candidate set, then post-filter by mission
 * scope, evidence availability, artifact applicability and supersession before
 * anything enters a packet. Falls back to the local recent-results cache when
 * the remote is unavailable and records the degradation.
 */
export async function retrieveEpisodes(
	adapter: MemoryAdapter,
	ledger: Ledger,
	evidence: FileEvidenceStore,
	scope: { missionId: string; containerTag: string; contractVersion: number },
	query: string,
	candidateLimit = 10,
	select = 5,
	onOperation: () => void = () => {},
): Promise<RetrievalSelection> {
	const selection: RetrievalSelection = { injected: [], filteredOut: [], degraded: false };
	const local = new Map(ledger.listEpisodes(scope.missionId).map((e) => [e.episodeId, e]));
	const superseded = new Set([...local.values()].map((e) => e.supersedes).filter((s): s is string => s !== null));

	let hits: MemoryHit[] = [];
	try {
		onOperation();
		hits = await adapter.search(scope.containerTag, query, candidateLimit);
	} catch {
		selection.degraded = true;
		hits = localFallback(local, query, candidateLimit);
	}

	for (const hit of hits) {
		if (selection.injected.length >= select) break;
		const meta = hit.metadata;
		const episodeId = typeof meta.episodeId === "string" ? meta.episodeId : hit.customId;
		if (meta.missionId !== scope.missionId) {
			selection.filteredOut.push({ episodeId, reason: "wrong mission scope" });
			continue;
		}
		if (typeof meta.contractVersion === "number" && meta.contractVersion !== scope.contractVersion) {
			selection.filteredOut.push({ episodeId, reason: `contract version ${meta.contractVersion} not applicable` });
			continue;
		}
		if (!episodeId || !local.has(episodeId)) {
			selection.filteredOut.push({ episodeId, reason: "no local episode record (evidence unavailable)" });
			continue;
		}
		if (superseded.has(episodeId)) {
			selection.filteredOut.push({ episodeId, reason: "superseded by a newer version" });
			continue;
		}
		const row = local.get(episodeId)!;
		const missingEvidence = row.evidenceIds.filter((id) => !evidence.has(id));
		if (row.evidenceIds.length > 0 && missingEvidence.length === row.evidenceIds.length) {
			selection.filteredOut.push({ episodeId, reason: "all cited evidence missing locally" });
			continue;
		}
		selection.injected.push({ episodeId, text: hit.content, source: selection.degraded ? "local_cache" : "remote" });
	}
	// Verified failures/measurements before broad model interpretations.
	selection.injected.sort((a, b) => rank(local.get(a.episodeId)) - rank(local.get(b.episodeId)));
	return selection;
}

function rank(row: EpisodeRow | undefined): number {
	return row?.interpretation === "verified" ? 0 : 1;
}

function localFallback(local: Map<string, EpisodeRow>, query: string, limit: number): MemoryHit[] {
	const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
	return [...local.values()]
		.map((row) => {
			const text = row.summary.toLowerCase();
			const score = terms.filter((t) => text.includes(t)).length / Math.max(1, terms.length);
			return { row, score };
		})
		.filter((x) => x.score > 0)
		.sort((a, b) => b.score - a.score)
		.slice(0, limit)
		.map(({ row, score }) => ({
			documentId: `local:${row.episodeId}`,
			customId: row.episodeId,
			score,
			content: row.summary,
			metadata: { missionId: row.missionId, episodeId: row.episodeId, artifactHash: row.artifactHash },
		}));
}
