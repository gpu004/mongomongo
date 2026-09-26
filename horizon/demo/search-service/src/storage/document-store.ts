import type { DocumentRecord } from "../domain/contracts.ts";

/**
 * Owns documents and the mutation version. Every successful mutation bumps
 * `version`, which downstream caches must key on to stay correct.
 */
export class DocumentStore {
	private readonly documents = new Map<string, DocumentRecord>();
	private nextSequence = 1;
	private mutationVersion = 0;

	get version(): number {
		return this.mutationVersion;
	}

	get size(): number {
		return this.documents.size;
	}

	get(id: string): DocumentRecord | undefined {
		return this.documents.get(id);
	}

	insert(id: string, title: string, body: string): DocumentRecord {
		if (this.documents.has(id)) {
			throw new Error(`document ${id} already exists`);
		}
		const record: DocumentRecord = { id, title, body, sequence: this.nextSequence++ };
		this.documents.set(id, record);
		this.mutationVersion++;
		return record;
	}

	update(id: string, fields: { title?: string; body?: string }): DocumentRecord {
		const existing = this.documents.get(id);
		if (!existing) {
			throw new Error(`document ${id} not found`);
		}
		const updated: DocumentRecord = {
			id,
			title: fields.title ?? existing.title,
			body: fields.body ?? existing.body,
			sequence: existing.sequence,
		};
		this.documents.set(id, updated);
		this.mutationVersion++;
		return updated;
	}

	delete(id: string): boolean {
		const removed = this.documents.delete(id);
		if (removed) {
			this.mutationVersion++;
		}
		return removed;
	}

	/** Documents in insertion order. */
	all(): DocumentRecord[] {
		return [...this.documents.values()].sort((a, b) => a.sequence - b.sequence);
	}
}
