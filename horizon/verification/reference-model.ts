/**
 * Independent oracle for the search contract. Deliberately does NOT import
 * anything from demo/search-service: normalization, matching, ordering, and
 * mutation are re-implemented here from the written contract so the oracle
 * cannot inherit a candidate's bugs.
 *
 * Contract (version 1): NFC + toLowerCase; whitespace-split terms; empty query
 * returns nothing; every term must be a substring of `title + " " + body`;
 * insertion order; then limit. Updates keep the original sequence.
 */

export type Operation =
	| { op: "insert"; id: string; title: string; body: string }
	| { op: "update"; id: string; title?: string; body?: string }
	| { op: "delete"; id: string }
	| { op: "search"; q: string; limit?: number }
	| { op: "health" };

export type ExpectedOutcome =
	| { kind: "status"; status: number }
	| { kind: "search"; status: 200; ids: string[] }
	| { kind: "health"; status: 200; documents: number };

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 1000;

interface Doc {
	title: string;
	body: string;
	sequence: number;
}

export class ReferenceModel {
	private readonly docs = new Map<string, Doc>();
	private nextSequence = 1;

	apply(operation: Operation): ExpectedOutcome {
		switch (operation.op) {
			case "insert": {
				if (this.docs.has(operation.id)) return { kind: "status", status: 409 };
				this.docs.set(operation.id, { title: operation.title, body: operation.body, sequence: this.nextSequence++ });
				return { kind: "status", status: 201 };
			}
			case "update": {
				const existing = this.docs.get(operation.id);
				if (!existing) return { kind: "status", status: 404 };
				if (operation.title === undefined && operation.body === undefined) return { kind: "status", status: 400 };
				this.docs.set(operation.id, {
					title: operation.title ?? existing.title,
					body: operation.body ?? existing.body,
					sequence: existing.sequence,
				});
				return { kind: "status", status: 200 };
			}
			case "delete": {
				return { kind: "status", status: this.docs.delete(operation.id) ? 204 : 404 };
			}
			case "search": {
				return { kind: "search", status: 200, ids: this.search(operation.q, operation.limit) };
			}
			case "health": {
				return { kind: "health", status: 200, documents: this.docs.size };
			}
		}
	}

	search(q: string, limit?: number): string[] {
		const terms = q
			.normalize("NFC")
			.toLowerCase()
			.split(/\s+/u)
			.filter((t) => t.length > 0);
		if (terms.length === 0) return [];
		const effectiveLimit = Math.min(Math.max(limit ?? DEFAULT_LIMIT, 0), MAX_LIMIT);
		const ordered = [...this.docs.entries()].sort((a, b) => a[1].sequence - b[1].sequence);
		const ids: string[] = [];
		for (const [id, doc] of ordered) {
			if (ids.length >= effectiveLimit) break;
			const haystack = `${doc.title} ${doc.body}`.normalize("NFC").toLowerCase();
			let matches = true;
			for (const term of terms) {
				if (!haystack.includes(term)) {
					matches = false;
					break;
				}
			}
			if (matches) ids.push(id);
		}
		return ids;
	}
}

/** Run a sequence through a fresh model and return the expected outcome per step. */
export function expectedOutcomes(sequence: Operation[]): ExpectedOutcome[] {
	const model = new ReferenceModel();
	return sequence.map((operation) => model.apply(operation));
}
