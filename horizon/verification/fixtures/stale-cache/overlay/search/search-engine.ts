import { normalizeText, queryTerms } from "../domain/normalize.ts";
import type { DocumentStore } from "../storage/document-store.ts";

/**
 * LABELED FAULT-INJECTION FIXTURE. Not a naturally occurring candidate.
 *
 * Faster than the seed because repeated queries hit a cache, but the cache is
 * keyed only by query text and `invalidate()` is a no-op, so results survive
 * updates and deletes. Violates INV-UPDATE-VISIBILITY and INV-DELETE-VISIBILITY.
 */
export class SearchEngine {
	private readonly store: DocumentStore;
	private readonly cache = new Map<string, string[]>();

	constructor(store: DocumentStore) {
		this.store = store;
	}

	invalidate(): void {}

	search(query: string, limit: number): string[] {
		const key = `${query}\u0000${limit}`;
		const cached = this.cache.get(key);
		if (cached) {
			return cached;
		}
		const terms = queryTerms(query);
		if (terms.length === 0 || limit <= 0) {
			return [];
		}
		const ids: string[] = [];
		for (const document of this.store.all()) {
			const haystack = normalizeText(`${document.title} ${document.body}`);
			if (terms.every((term) => haystack.includes(term))) {
				ids.push(document.id);
				if (ids.length >= limit) break;
			}
		}
		this.cache.set(key, ids);
		return ids;
	}
}
