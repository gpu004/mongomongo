import Supermemory from "supermemory";

/** Bounded experiment episode as stored remotely. Raw evidence stays local. */
export interface EpisodePayload {
	episodeId: string;
	missionId: string;
	contractVersion: number;
	version: number;
	supersedes: string | null;
	experimentId: string;
	taskId: string;
	hypothesis: string;
	featureIds: string[];
	invariantIds: string[];
	parentArtifactHash: string;
	artifactHash: string;
	whatChanged: string;
	correctness: string;
	performance: string;
	outcome: string;
	uncertainty: string;
	reportIds: string[];
	evidenceIds: string[];
	nextAction: string;
	interpretation: "verified" | "model_interpretation";
	/** Fault-injection fixtures are always labeled; never presented as natural discoveries. */
	seededFixture: string | null;
}

export interface MemoryHit {
	documentId: string;
	customId: string | null;
	score: number;
	content: string;
	metadata: Record<string, unknown>;
}

export type RemoteStatus = "queued" | "processing" | "done" | "failed" | "unknown";

/** Everything the controller needs from a memory service. Swappable so tests never touch the network. */
export interface MemoryAdapter {
	readonly kind: "supermemory" | "local";
	add(containerTag: string, customId: string, content: string, metadata: Record<string, string | number | boolean>): Promise<{ remoteId: string }>;
	status(remoteId: string): Promise<RemoteStatus>;
	search(containerTag: string, query: string, limit: number): Promise<MemoryHit[]>;
}

export function renderEpisode(p: EpisodePayload): string {
	return [
		`Mission ${p.missionId} (contract v${p.contractVersion}); episode ${p.episodeId} v${p.version}${p.supersedes ? ` supersedes ${p.supersedes}` : ""}`,
		`Task ${p.taskId}; hypothesis: ${p.hypothesis}`,
		`Features: ${p.featureIds.join(", ") || "-"}; invariants: ${p.invariantIds.join(", ") || "-"}`,
		`Parent artifact ${p.parentArtifactHash.slice(0, 12)} -> candidate ${p.artifactHash.slice(0, 12)}`,
		p.seededFixture ? `SEEDED FAULT-INJECTION FIXTURE: ${p.seededFixture}` : null,
		`What changed: ${p.whatChanged}`,
		`Correctness: ${p.correctness}`,
		`Performance: ${p.performance}`,
		`Outcome: ${p.outcome}`,
		`Uncertain: ${p.uncertainty}`,
		`Reports: ${p.reportIds.join(", ") || "-"}; evidence: ${p.evidenceIds.slice(0, 8).join(", ") || "-"}`,
		`Suggested next action: ${p.nextAction}`,
		`Interpretation: ${p.interpretation}`,
	]
		.filter((line): line is string => line !== null)
		.join("\n");
}

export function episodeMetadata(p: EpisodePayload): Record<string, string | number | boolean> {
	return {
		missionId: p.missionId,
		episodeId: p.episodeId,
		experimentId: p.experimentId,
		version: p.version,
		supersedes: p.supersedes ?? "",
		artifactHash: p.artifactHash,
		parentArtifactHash: p.parentArtifactHash,
		contractVersion: p.contractVersion,
		interpretation: p.interpretation,
		outcome: p.outcome.slice(0, 64),
		seededFixture: p.seededFixture ?? "",
	};
}

/** Hosted Supermemory SDK, pinned version. Scoped by containerTag; stable customId for retries. */
export class SupermemoryAdapter implements MemoryAdapter {
	readonly kind = "supermemory" as const;
	private readonly client: Supermemory;

	constructor(apiKey: string, timeoutMs = 15000) {
		this.client = new Supermemory({ apiKey, timeout: timeoutMs, maxRetries: 0 });
	}

	async add(containerTag: string, customId: string, content: string, metadata: Record<string, string | number | boolean>): Promise<{ remoteId: string }> {
		const response = await this.client.add({ content, containerTag, customId, metadata });
		return { remoteId: response.id };
	}

	async status(remoteId: string): Promise<RemoteStatus> {
		const doc = await this.client.documents.get(remoteId);
		switch (doc.status) {
			case "done":
				return "done";
			case "failed":
				return "failed";
			case "queued":
				return "queued";
			case "unknown":
				return "unknown";
			default:
				return "processing";
		}
	}

	async search(containerTag: string, query: string, limit: number): Promise<MemoryHit[]> {
		const response = await this.client.search.documents({ q: query, containerTag, limit, includeFullDocs: true });
		return response.results.map((r) => ({
			documentId: r.documentId,
			customId: typeof r.metadata?.episodeId === "string" ? r.metadata.episodeId : null,
			score: r.score,
			content: r.content ?? r.chunks.map((c) => c.content).join("\n"),
			metadata: r.metadata ?? {},
		}));
	}
}

/**
 * Deterministic in-process adapter for tests and for running without
 * credentials. Retrieval is a token-overlap ranking: good enough to exercise
 * scope filtering, supersession, and budget logic without a network.
 */
export class LocalMemoryAdapter implements MemoryAdapter {
	readonly kind = "local" as const;
	private readonly docs = new Map<string, { containerTag: string; customId: string; content: string; metadata: Record<string, unknown>; status: RemoteStatus }>();
	private counter = 0;
	/** Test hook: when true, every call fails like an outage. */
	unavailable = false;
	/** Test hook: documents stay "queued" until `settle()` is called. */
	deferReadiness = false;

	async add(containerTag: string, customId: string, content: string, metadata: Record<string, string | number | boolean>): Promise<{ remoteId: string }> {
		if (this.unavailable) throw new Error("memory service unavailable");
		for (const [id, doc] of this.docs) {
			if (doc.customId === customId && doc.containerTag === containerTag) {
				this.docs.set(id, { ...doc, content, metadata });
				return { remoteId: id };
			}
		}
		const remoteId = `local-doc-${++this.counter}`;
		this.docs.set(remoteId, { containerTag, customId, content, metadata, status: this.deferReadiness ? "queued" : "done" });
		return { remoteId };
	}

	settle(): void {
		for (const [id, doc] of this.docs) this.docs.set(id, { ...doc, status: "done" });
	}

	async status(remoteId: string): Promise<RemoteStatus> {
		if (this.unavailable) throw new Error("memory service unavailable");
		return this.docs.get(remoteId)?.status ?? "unknown";
	}

	async search(containerTag: string, query: string, limit: number): Promise<MemoryHit[]> {
		if (this.unavailable) throw new Error("memory service unavailable");
		const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
		const hits: MemoryHit[] = [];
		for (const [documentId, doc] of this.docs) {
			if (doc.containerTag !== containerTag || doc.status !== "done") continue;
			const text = doc.content.toLowerCase();
			const score = terms.filter((t) => text.includes(t)).length / Math.max(1, terms.length);
			if (score > 0) hits.push({ documentId, customId: doc.customId, score, content: doc.content, metadata: doc.metadata });
		}
		return hits.sort((a, b) => b.score - a.score).slice(0, limit);
	}

	/** Test hook: inject a document from another mission scope, as a misconfigured remote could return. */
	injectForeign(containerTag: string, customId: string, content: string, metadata: Record<string, unknown>): void {
		this.docs.set(`foreign-${++this.counter}`, { containerTag, customId, content, metadata, status: "done" });
	}
}
