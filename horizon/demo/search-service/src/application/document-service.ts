import {
	DEFAULT_LIMIT,
	MAX_LIMIT,
	type DocumentRecord,
	type InsertRequest,
	type SearchRequest,
	type UpdateRequest,
} from "../domain/contracts.ts";
import { SearchEngine } from "../search/search-engine.ts";
import { DocumentStore } from "../storage/document-store.ts";

/**
 * Single mutation entry point. Every insert/update/delete goes through here so
 * storage, indexing, and invalidation stay in lockstep. Bypassing this class
 * to mutate the store directly is the architecture violation the structural
 * check (`horizon features check`) exists to catch.
 */
export class DocumentService {
	private readonly store: DocumentStore;
	private readonly engine: SearchEngine;

	constructor(store = new DocumentStore(), engine?: SearchEngine) {
		this.store = store;
		this.engine = engine ?? new SearchEngine(store);
	}

	get documentCount(): number {
		return this.store.size;
	}

	insert(request: InsertRequest): DocumentRecord {
		const record = this.store.insert(request.id, request.title, request.body);
		this.engine.invalidate();
		return record;
	}

	update(id: string, request: UpdateRequest): DocumentRecord {
		const record = this.store.update(id, request);
		this.engine.invalidate();
		return record;
	}

	delete(id: string): boolean {
		const removed = this.store.delete(id);
		if (removed) {
			this.engine.invalidate();
		}
		return removed;
	}

	get(id: string): DocumentRecord | undefined {
		return this.store.get(id);
	}

	search(request: SearchRequest): string[] {
		const limit = Math.min(Math.max(request.limit ?? DEFAULT_LIMIT, 0), MAX_LIMIT);
		return this.engine.search(request.q, limit);
	}
}
