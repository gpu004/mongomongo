import type { FileEvidenceStore } from "./mission-paths.ts";
import type { EpisodeRow, OutboxRow } from "./ledger.ts";
import { asStore, type LedgerLike, type LedgerStore, queryTerms } from "./ledger-store.ts";
import {
  type EpisodePayload,
  episodeMetadata,
  type MemoryAdapter,
  type MemoryHit,
  renderEpisode,
} from "./memory-adapter.ts";

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
  private readonly ledger: LedgerStore;
  private readonly adapter: MemoryAdapter;
  private readonly containerTag: string;
  private readonly payloads: (
    episodeId: string,
  ) => EpisodePayload | undefined | Promise<EpisodePayload | undefined>;
  private readonly onOperation: () => void | Promise<void>;

  constructor(
    ledger: LedgerLike,
    adapter: MemoryAdapter,
    containerTag: string,
    payloads: (
      episodeId: string,
    ) => EpisodePayload | undefined | Promise<EpisodePayload | undefined>,
    onOperation: () => void | Promise<void>,
  ) {
    this.ledger = asStore(ledger);
    this.adapter = adapter;
    this.containerTag = containerTag;
    this.payloads = payloads;
    this.onOperation = onOperation;
  }

  enqueue(payload: EpisodePayload): Promise<string> {
    return this.ledger.enqueueOutbox(payload.episodeId, payload);
  }

  async drain(nowMs = Date.now()): Promise<OutboxDrainResult> {
    const result: OutboxDrainResult = {
      attempted: 0,
      submitted: 0,
      ready: 0,
      failed: 0,
      degraded: false,
    };
    for (const row of await this.ledger.listOutbox([
      "pending",
      "failed",
      "submitted",
      "document_ready",
    ])) {
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
        await this.backoff(row, error instanceof Error ? error.message : String(error), nowMs);
      }
    }
    return result;
  }

  private async submit(row: OutboxRow): Promise<void> {
    const payload = await this.payloads(row.episodeId);
    if (!payload) {
      await this.ledger.updateOutbox(row.idempotencyKey, {
        state: "failed",
        lastError: "episode payload missing locally",
        retries: MAX_RETRIES,
      });
      return;
    }
    await this.onOperation();
    const { remoteId } = await this.adapter.add(
      this.containerTag,
      payload.episodeId,
      renderEpisode(payload),
      episodeMetadata(payload),
    );
    await this.ledger.updateOutbox(row.idempotencyKey, {
      state: "submitted",
      remoteDocumentId: remoteId,
      lastError: null,
      nextAttemptAt: new Date().toISOString(),
    });
    await this.ledger.appendEvent(
      `outbox:${row.idempotencyKey}:submitted`,
      "memory.submitted",
      row.episodeId,
      { remoteId },
    );
  }

  private async checkReady(row: OutboxRow): Promise<boolean> {
    if (!row.remoteDocumentId) return false;
    await this.onOperation();
    const status = await this.adapter.status(row.remoteDocumentId);
    if (status === "done") {
      await this.ledger.updateOutbox(row.idempotencyKey, {
        state: "memory_ready",
        lastError: null,
      });
      await this.ledger.appendEvent(
        `outbox:${row.idempotencyKey}:ready`,
        "memory.ready",
        row.episodeId,
        { remoteId: row.remoteDocumentId },
      );
      return true;
    }
    if (status === "failed") {
      await this.ledger.updateOutbox(row.idempotencyKey, {
        state: "failed",
        lastError: "remote processing failed",
        retries: row.retries + 1,
        nextAttemptAt: new Date(Date.now() + BASE_DELAY_MS).toISOString(),
      });
      return false;
    }
    await this.ledger.updateOutbox(row.idempotencyKey, {
      state: "document_ready",
      nextAttemptAt: new Date(Date.now() + BASE_DELAY_MS).toISOString(),
    });
    return false;
  }

  private async backoff(row: OutboxRow, message: string, nowMs: number): Promise<void> {
    const retries = row.retries + 1;
    const delay = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.min(retries, 10));
    await this.ledger.updateOutbox(row.idempotencyKey, {
      state: row.state === "pending" ? "failed" : row.state,
      retries,
      lastError: message,
      nextAttemptAt: new Date(nowMs + delay).toISOString(),
    });
  }
}

export interface RetrievalSelection {
  injected: {
    episodeId: string;
    text: string;
    source: "remote" | "local_cache" | "local_pending";
  }[];
  filteredOut: { episodeId: string | null; reason: string }[];
  degraded: boolean;
}

/**
 * Retrieval policy: ask for a small candidate set, then post-filter by mission
 * scope, evidence availability, artifact applicability and supersession before
 * anything enters a packet. Episodes whose delivery is not yet ready remotely
 * are searched locally and merged, so indexing lag never hides recent results.
 * Falls back to the local index when the remote is unavailable and records the
 * degradation. Cost is proportional to the candidate set, not mission history.
 */
export async function retrieveEpisodes(
  adapter: MemoryAdapter,
  ledgerLike: LedgerLike,
  evidence: FileEvidenceStore,
  scope: { missionId: string; containerTag: string; contractVersion: number },
  query: string,
  candidateLimit = 10,
  select = 5,
  onOperation: () => void | Promise<void> = () => {},
): Promise<RetrievalSelection> {
  const ledger = asStore(ledgerLike);
  const selection: RetrievalSelection = { injected: [], filteredOut: [], degraded: false };
  const interpretations = new Map<string, EpisodeRow["interpretation"]>();
  let hits: (MemoryHit & { pending?: boolean; localOnly?: boolean })[] = [];
  try {
    await onOperation();
    hits = await adapter.search(scope.containerTag, query, candidateLimit);
  } catch {
    selection.degraded = true;
    hits = (await ledger.searchEpisodes(scope.missionId, query, candidateLimit)).map((row) =>
      localHit(row, query),
    );
  }
  if (!selection.degraded) {
    const seen = new Set(
      hits.filter((h) => h.metadata.missionId === scope.missionId).map((h) => episodeIdOf(h)),
    );
    // The ledger is canonical: local matches the remote search missed (still indexing, or low remote recall) are merged in.
    const unindexed = new Set(
      (
        await ledger.searchEpisodes(scope.missionId, query, candidateLimit, { unindexedOnly: true })
      ).map((row) => row.episodeId),
    );
    const local = (await ledger.searchEpisodes(scope.missionId, query, candidateLimit))
      .concat(
        await ledger.searchEpisodes(scope.missionId, query, candidateLimit, {
          unindexedOnly: true,
        }),
      )
      .filter(
        (row, i, rows) =>
          !seen.has(row.episodeId) && rows.findIndex((r) => r.episodeId === row.episodeId) === i,
      )
      .map((row) => ({
        ...localHit(row, query),
        pending: unindexed.has(row.episodeId),
        localOnly: true,
      }));
    if (local.length > 0) {
      // Remote and local scores are not comparable; rank the merged set with one IDF-weighted scorer.
      const terms = queryTerms(query);
      const weights = await ledger.termWeights(terms);
      const total = terms.reduce((n, t) => n + weights.get(t)!, 0) || 1;
      const rescore = (h: MemoryHit) => {
        const present = new Set(queryTerms(h.content));
        return terms.reduce((n, t) => n + (present.has(t) ? weights.get(t)! : 0), 0) / total;
      };
      hits = [...hits, ...local]
        .map((h) => ({ ...h, score: rescore(h) }))
        .sort((a, b) => b.score - a.score);
    }
  }

  const considered = new Set<string>();
  for (const candidate of hits) {
    if (selection.injected.length >= select) break;
    let hit = candidate;
    const meta = hit.metadata;
    let episodeId = episodeIdOf(hit);
    if (meta.missionId !== scope.missionId) {
      selection.filteredOut.push({ episodeId, reason: "wrong mission scope" });
      continue;
    }
    if (
      typeof meta.contractVersion === "number" &&
      meta.contractVersion !== scope.contractVersion
    ) {
      selection.filteredOut.push({
        episodeId,
        reason: `contract version ${meta.contractVersion} not applicable`,
      });
      continue;
    }
    let row = episodeId ? await ledger.getEpisode(episodeId) : undefined;
    if (!episodeId || !row || row.missionId !== scope.missionId) {
      selection.filteredOut.push({
        episodeId,
        reason: "no local episode record (evidence unavailable)",
      });
      continue;
    }
    if (await ledger.isSuperseded(episodeId)) {
      const current = await ledger.currentVersionOf(episodeId);
      selection.filteredOut.push({
        episodeId,
        reason: `superseded by ${current?.episodeId ?? "a newer version"}`,
      });
      if (!current || current.missionId !== scope.missionId) continue;
      row = current;
      episodeId = current.episodeId;
      hit = {
        ...localHit(current, query),
        localOnly: true,
        pending: !(await ledger.isIndexed(current.episodeId)),
      };
    }
    if (considered.has(episodeId)) continue;
    considered.add(episodeId);
    const missingEvidence = row.evidenceIds.filter((id) => !evidence.has(id));
    if (row.evidenceIds.length > 0 && missingEvidence.length === row.evidenceIds.length) {
      selection.filteredOut.push({ episodeId, reason: "all cited evidence missing locally" });
      continue;
    }
    selection.injected.push({
      episodeId,
      text: hit.content,
      source:
        selection.degraded || (hit.localOnly && !hit.pending)
          ? "local_cache"
          : hit.pending
            ? "local_pending"
            : "remote",
    });
    interpretations.set(episodeId, row.interpretation);
  }
  // Verified failures/measurements before broad model interpretations.
  selection.injected.sort(
    (a, b) => rank(interpretations.get(a.episodeId)) - rank(interpretations.get(b.episodeId)),
  );
  return selection;
}

function episodeIdOf(hit: MemoryHit): string | null {
  return typeof hit.metadata.episodeId === "string" ? hit.metadata.episodeId : hit.customId;
}

function rank(interpretation: EpisodeRow["interpretation"] | undefined): number {
  return interpretation === "verified" ? 0 : 1;
}

function localHit(row: EpisodeRow, query: string): MemoryHit {
  const terms = queryTerms(query);
  const present = new Set(queryTerms(row.summary));
  const score = terms.filter((t) => present.has(t)).length / Math.max(1, terms.length);
  return {
    documentId: `local:${row.episodeId}`,
    customId: row.episodeId,
    score,
    content: row.summary,
    metadata: {
      missionId: row.missionId,
      episodeId: row.episodeId,
      artifactHash: row.artifactHash,
    },
  };
}
