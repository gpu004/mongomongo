import { normalizeText, queryTerms } from "../domain/normalize.ts";
import type { DocumentStore } from "../storage/document-store.ts";

/**
 * Seed implementation: a correct linear scan that re-normalizes every document
 * on every query. Deliberately slow, deliberately simple to audit.
 */
export class SearchEngine {
  private readonly store: DocumentStore;

  constructor(store: DocumentStore) {
    this.store = store;
  }

  /** Called by DocumentService after every mutation. The seed has nothing to invalidate. */
  invalidate(): void {}

  search(query: string, limit: number): string[] {
    const terms = queryTerms(query);
    if (terms.length === 0 || limit <= 0) {
      return [];
    }
    const ids: string[] = [];
    for (const document of this.store.all()) {
      const haystack = normalizeText(`${document.title} ${document.body}`);
      if (terms.every((term) => haystack.includes(term))) {
        ids.push(document.id);
        if (ids.length >= limit) {
          break;
        }
      }
    }
    return ids;
  }
}
