import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FIXTURES_DIR } from "./artifact-store.ts";
import type { SegmentHandle, Worker, WorkerCycleInput, WorkerCycleResult } from "./worker.ts";

const NORMALIZED_INDEX_ENGINE = `import { normalizeText, queryTerms } from "../domain/normalize.ts";
import type { DocumentStore } from "../storage/document-store.ts";

interface IndexedDocument {
	id: string;
	title: string;
	body: string;
	haystack: string;
}

/**
 * Pre-normalized haystacks, reconciled incrementally after any mutation:
 * only documents whose title or body changed are re-normalized, so a
 * mutation costs O(n) cheap comparisons instead of O(n) normalizations.
 * Correctness relies on DocumentService calling invalidate() after every write.
 */
export class SearchEngine {
	private readonly store: DocumentStore;
	private readonly cache = new Map<string, IndexedDocument>();
	private index: IndexedDocument[] | null = null;
	private indexedVersion = -1;

	constructor(store: DocumentStore) {
		this.store = store;
	}

	invalidate(): void {
		this.index = null;
	}

	private current(): IndexedDocument[] {
		if (this.index === null || this.indexedVersion !== this.store.version) {
			const seen = new Set<string>();
			this.index = this.store.all().map((document) => {
				seen.add(document.id);
				const cached = this.cache.get(document.id);
				if (cached && cached.title === document.title && cached.body === document.body) return cached;
				const entry: IndexedDocument = { id: document.id, title: document.title, body: document.body, haystack: normalizeText(\`\${document.title} \${document.body}\`) };
				this.cache.set(document.id, entry);
				return entry;
			});
			for (const id of this.cache.keys()) if (!seen.has(id)) this.cache.delete(id);
			this.indexedVersion = this.store.version;
		}
		return this.index;
	}

	search(query: string, limit: number): string[] {
		const terms = queryTerms(query);
		if (terms.length === 0 || limit <= 0) {
			return [];
		}
		const ids: string[] = [];
		for (const document of this.current()) {
			if (terms.every((term) => document.haystack.includes(term))) {
				ids.push(document.id);
				if (ids.length >= limit) {
					break;
				}
			}
		}
		return ids;
	}
}
`;

/**
 * Deterministic worker for tests and offline runs. It exercises the same
 * broker boundary as the Pi worker and follows a fixed script:
 *   cycle 1: apply the labeled stale-cache fault, observe the failure, propose a regression
 *   cycle 2: apply a correct pre-normalized index
 *   later:   report that it has no further hypotheses
 */
export class ScriptedWorker implements Worker {
	readonly mode = "scripted" as const;
	private segment = 0;

	async openSegment(ordinal: number): Promise<SegmentHandle> {
		this.segment = ordinal;
		return { sessionPath: null, sessionId: `scripted-segment-${ordinal}` };
	}

	async runCycle(input: WorkerCycleInput): Promise<WorkerCycleResult> {
		const { broker, cycle } = input;
		const usage = { inputTokens: input.packet.tokens, outputTokens: 200, uncertain: true };
		const step = this.stepFor(input.packet.text, cycle);
		if (step === "stale-cache") {
			const overlay = readFileSync(join(FIXTURES_DIR, "stale-cache", "overlay", "search", "search-engine.ts"), "utf8");
			broker.workspaceEdit("src/search/search-engine.ts", { content: overlay });
			const smoke = await broker.verifyCandidate("smoke");
			const correctness = smoke.status === "passed" ? await broker.verifyCandidate("correctness") : null;
			let claim = `smoke ${smoke.status}; correctness ${correctness?.status ?? "not run"}`;
			if (correctness?.status === "failed") {
				const proposal = await broker.proposeRegression({
					scenarioId: "learned-update-then-repeat-search",
					invariantId: "INV-UPDATE-VISIBILITY",
					description: "Repeated identical query after an update must reflect the new body, even when a query cache is present.",
					sequence: [
						{ op: "insert", id: "doc-a", title: "Cache Notes", body: "original body" },
						{ op: "search", q: "original", limit: 10 },
						{ op: "update", id: "doc-a", body: "revised body" },
						{ op: "search", q: "original", limit: 10 },
						{ op: "search", q: "revised", limit: 10 },
						{ op: "delete", id: "doc-a" },
						{ op: "search", q: "revised", limit: 10 },
					],
				});
				claim += `; regression proposal ${proposal.accepted ? "accepted" : `rejected (${proposal.reason})`}`;
			}
			return { hypothesis: "cache full query results keyed by query+limit", whatChanged: "replaced SearchEngine with a query-result cache (no invalidation)", claim, usage, seededFixture: "stale-cache", aborted: false, compactions: 0 };
		}
		if (step === "normalized-index") {
			broker.workspaceEdit("src/search/search-engine.ts", { content: NORMALIZED_INDEX_ENGINE });
			const smoke = await broker.verifyCandidate("smoke");
			const correctness = smoke.status === "passed" ? await broker.verifyCandidate("correctness") : null;
			return {
				hypothesis: "pre-normalize document text once per document change instead of per query or per mutation",
				whatChanged: "SearchEngine keeps an incrementally reconciled normalized index; invalidate() marks it stale and only changed documents are re-normalized",
				claim: `smoke ${smoke.status}; correctness ${correctness?.status ?? "not run"}`,
				usage,
				seededFixture: null,
				aborted: false,
				compactions: 0,
			};
		}
		return { hypothesis: "none", whatChanged: "nothing", claim: "no further hypotheses in script", usage, seededFixture: null, aborted: false, compactions: 0 };
	}

	private stepFor(packet: string, cycle: number): "stale-cache" | "normalized-index" | "exhausted" {
		const triedStale = packet.includes("seeded fault-injection fixture: stale-cache") || packet.includes("SEEDED FAULT-INJECTION FIXTURE: stale-cache");
		const triedIndex = packet.includes("incrementally reconciled normalized index");
		if (!triedStale && cycle <= 2) return "stale-cache";
		if (!triedIndex) return "normalized-index";
		return "exhausted";
	}

	async closeSegment(): Promise<void> {}

	async abort(): Promise<void> {}
}
