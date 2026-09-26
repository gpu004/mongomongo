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
		const response = await this.client.search.documents({ q: query, containerTags: [containerTag], limit, includeFullDocs: true });
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
 * credentials. Retrieval is a token-overlap ranking over an inverted index:
 * good enough to exercise scope filtering, supersession, and budget logic
 * without a network, and cheap enough for large synthetic histories.
 */
export class LocalMemoryAdapter implements MemoryAdapter {
	readonly kind = "local" as const;
	private readonly docs = new Map<string, { containerTag: string; customId: string; content: string; metadata: Record<string, unknown>; status: RemoteStatus }>();
	private readonly byCustomId = new Map<string, string>();
	private readonly postings = new Map<string, Set<string>>();
	private readonly pending = new Set<string>();
	private counter = 0;
	/** Test hook: when true, every call fails like an outage. */
	unavailable = false;
	/** Test hook: documents stay "queued" until `settle()` is called. */
	deferReadiness = false;

	async add(containerTag: string, customId: string, content: string, metadata: Record<string, string | number | boolean>): Promise<{ remoteId: string }> {
		if (this.unavailable) throw new Error("memory service unavailable");
		const key = `${containerTag}\u0000${customId}`;
		const existing = this.byCustomId.get(key);
		if (existing) {
			const doc = this.docs.get(existing)!;
			this.unindex(existing, doc.content);
			this.docs.set(existing, { ...doc, content, metadata });
			this.index(existing, content);
			return { remoteId: existing };
		}
		const remoteId = `local-doc-${++this.counter}`;
		this.put(remoteId, { containerTag, customId, content, metadata, status: this.deferReadiness ? "queued" : "done" });
		this.byCustomId.set(key, remoteId);
		return { remoteId };
	}

	/** Test hook: mark queued documents done; with `count`, only the oldest `count` of them. */
	settle(count = Number.POSITIVE_INFINITY): number {
		let settled = 0;
		for (const id of this.pending) {
			if (settled >= count) break;
			const doc = this.docs.get(id);
			if (doc) this.docs.set(id, { ...doc, status: "done" });
			this.pending.delete(id);
			settled += 1;
		}
		return settled;
	}

	async status(remoteId: string): Promise<RemoteStatus> {
		if (this.unavailable) throw new Error("memory service unavailable");
		return this.docs.get(remoteId)?.status ?? "unknown";
	}

	async search(containerTag: string, query: string, limit: number): Promise<MemoryHit[]> {
		if (this.unavailable) throw new Error("memory service unavailable");
		const all = [...new Set(tokens(query))];
		const rare = all.filter((t) => (this.postings.get(t)?.size ?? 0) <= Math.max(50, this.docs.size / 5));
		const terms = rare.length > 0 && all.length > 1 ? rare : all;
		const matched = new Map<string, number>();
		for (const term of terms) for (const id of this.postings.get(term) ?? []) matched.set(id, (matched.get(id) ?? 0) + 1);
		const hits: MemoryHit[] = [];
		for (const [documentId, count] of matched) {
			const doc = this.docs.get(documentId)!;
			if (doc.containerTag !== containerTag || doc.status !== "done") continue;
			hits.push({ documentId, customId: doc.customId, score: count / Math.max(1, terms.length), content: doc.content, metadata: doc.metadata });
		}
		return hits.sort((a, b) => b.score - a.score).slice(0, limit);
	}

	/** Test hook: inject a document from another mission scope, as a misconfigured remote could return. */
	injectForeign(containerTag: string, customId: string, content: string, metadata: Record<string, unknown>): void {
		this.put(`foreign-${++this.counter}`, { containerTag, customId, content, metadata, status: "done" });
	}

	get size(): number {
		return this.docs.size;
	}

	private put(id: string, doc: { containerTag: string; customId: string; content: string; metadata: Record<string, unknown>; status: RemoteStatus }): void {
		this.docs.set(id, doc);
		if (doc.status !== "done") this.pending.add(id);
		this.index(id, doc.content);
	}

	private index(id: string, content: string): void {
		for (const token of new Set(tokens(content))) {
			let set = this.postings.get(token);
			if (!set) this.postings.set(token, (set = new Set()));
			set.add(id);
		}
	}

	private unindex(id: string, content: string): void {
		for (const token of new Set(tokens(content))) this.postings.get(token)?.delete(id);
	}
}

function tokens(text: string): string[] {
	return text.toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter(Boolean);
}
