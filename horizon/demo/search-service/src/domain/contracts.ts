/**
 * Frozen product contract for the document search service.
 *
 * Matching rules (contract version 1):
 * - Text is normalized with Unicode NFC and lowercased with `toLowerCase()` (locale-independent).
 * - A query is split on whitespace into terms; empty terms are dropped.
 * - An empty query (no terms) returns no results.
 * - Every term must occur as a substring of normalized `title + " " + body`.
 * - Results are returned in insertion order (by sequence), then truncated to `limit`.
 * - Updates keep the original insertion sequence.
 */

export const CONTRACT_VERSION = 1;

export interface DocumentRecord {
  id: string;
  title: string;
  body: string;
  sequence: number;
}

export interface InsertRequest {
  id: string;
  title: string;
  body: string;
}

export interface UpdateRequest {
  title?: string;
  body?: string;
}

export interface SearchRequest {
  q: string;
  limit?: number;
}

export interface SearchResponse {
  ids: string[];
}

export interface HealthResponse {
  ok: true;
  documents: number;
}

export interface ErrorResponse {
  error: string;
}

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 1000;
