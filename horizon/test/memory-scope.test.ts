import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Ledger, type EpisodeRow } from "../src/ledger.ts";
import {
  type EpisodePayload,
  LocalMemoryAdapter,
  episodeMetadata,
  renderEpisode,
} from "../src/memory-adapter.ts";
import { MemoryOutbox, retrieveEpisodes } from "../src/memory-outbox.ts";
import { FileEvidenceStore } from "../src/mission-paths.ts";

const MISSION = "mem-mission";
const TAG = `horizon-${MISSION}`;
const SCOPE = { missionId: MISSION, containerTag: TAG, contractVersion: 1 };

function payload(episodeId: string, overrides: Partial<EpisodePayload> = {}): EpisodePayload {
  return {
    episodeId,
    missionId: MISSION,
    contractVersion: 1,
    version: 1,
    supersedes: null,
    experimentId: `exp-${episodeId}`,
    taskId: "optimize-search",
    hypothesis: "cache normalized documents",
    featureIds: ["search-matching"],
    invariantIds: ["INV-UPDATE-VISIBILITY"],
    parentArtifactHash: "a".repeat(64),
    artifactHash: "b".repeat(64),
    whatChanged: "added normalization cache",
    correctness: "failed update-removes-old-match",
    performance: "not measured",
    outcome: "rejected",
    uncertainty: "none",
    reportIds: [],
    evidenceIds: [],
    nextAction: "invalidate cache on mutation",
    interpretation: "verified",
    seededFixture: null,
    ...overrides,
  };
}

function row(p: EpisodePayload, evidenceIds: string[] = []): EpisodeRow {
  return {
    episodeId: p.episodeId,
    missionId: p.missionId,
    experimentId: p.experimentId,
    version: p.version,
    supersedes: p.supersedes,
    featureIds: p.featureIds,
    invariantIds: p.invariantIds,
    artifactHash: p.artifactHash,
    parentArtifactHash: p.parentArtifactHash,
    interpretation: p.interpretation,
    evidenceIds,
    summary: renderEpisode(p),
    createdAt: new Date().toISOString(),
  };
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "horizon-mem-"));
  const ledger = new Ledger(join(dir, "state.sqlite"));
  const evidence = new FileEvidenceStore(join(dir, "evidence"));
  const adapter = new LocalMemoryAdapter();
  const payloads = new Map<string, EpisodePayload>();
  const outbox = new MemoryOutbox(
    ledger,
    adapter,
    TAG,
    (id) => payloads.get(id),
    () => {},
  );
  return { ledger, evidence, adapter, payloads, outbox };
}

test("retrieval only injects episodes from this mission's scope with local evidence", async () => {
  const { ledger, evidence, adapter, payloads, outbox } = fixture();
  const ours = payload("ep-1", { evidenceIds: [evidence.write("timing", { p95: 1 })] });
  payloads.set(ours.episodeId, ours);
  ledger.insertEpisode(row(ours, ours.evidenceIds));
  outbox.enqueue(ours);
  await outbox.drain();
  await outbox.drain();

  // Same containerTag but foreign mission metadata, as a misconfigured remote could return.
  adapter.injectForeign(TAG, "ep-foreign", "cache normalized documents from another mission", {
    ...episodeMetadata(payload("ep-foreign")),
    missionId: "other-mission",
  });
  // Other contract version.
  adapter.injectForeign(
    TAG,
    "ep-old",
    renderEpisode(payload("ep-old")),
    episodeMetadata(payload("ep-old", { contractVersion: 0 })),
  );
  // No local episode record → evidence unavailable.
  adapter.injectForeign(
    TAG,
    "ep-ghost",
    renderEpisode(payload("ep-ghost")),
    episodeMetadata(payload("ep-ghost")),
  );
  // Different containerTag is never even returned.
  adapter.injectForeign(
    "horizon-other",
    "ep-other-tag",
    renderEpisode(payload("ep-other-tag")),
    episodeMetadata(payload("ep-other-tag")),
  );

  const selection = await retrieveEpisodes(
    adapter,
    ledger,
    evidence,
    SCOPE,
    "cache normalized documents",
  );
  assert.deepEqual(
    selection.injected.map((i) => i.episodeId),
    ["ep-1"],
  );
  assert.equal(selection.degraded, false);
  const reasons = Object.fromEntries(selection.filteredOut.map((f) => [f.episodeId, f.reason]));
  assert.match(reasons["ep-foreign"]!, /wrong mission scope/);
  assert.match(reasons["ep-old"]!, /contract version 0/);
  assert.match(reasons["ep-ghost"]!, /no local episode record/);
  assert.equal("ep-other-tag" in reasons, false);
  ledger.close();
});

test("superseded episodes and episodes whose evidence is gone are filtered out", async () => {
  const { ledger, evidence, adapter, payloads, outbox } = fixture();
  const v1 = payload("ep-v1");
  const v2 = payload("ep-v2", { version: 2, supersedes: "ep-v1" });
  const missing = payload("ep-missing", { evidenceIds: ["ev-timing-0123456789abcdef"] });
  for (const p of [v1, v2, missing]) {
    payloads.set(p.episodeId, p);
    ledger.insertEpisode(row(p, p.evidenceIds));
    outbox.enqueue(p);
  }
  await outbox.drain();
  const selection = await retrieveEpisodes(
    adapter,
    ledger,
    evidence,
    SCOPE,
    "cache normalized documents",
  );
  assert.deepEqual(
    selection.injected.map((i) => i.episodeId),
    ["ep-v2"],
  );
  const reasons = Object.fromEntries(selection.filteredOut.map((f) => [f.episodeId, f.reason]));
  assert.match(reasons["ep-v1"]!, /superseded/);
  assert.match(reasons["ep-missing"]!, /evidence missing/);
  ledger.close();
});

test("outbox: acceptance is not readiness; retries reuse the same customId; outage falls back to local cache", async () => {
  const { ledger, evidence, adapter, payloads, outbox } = fixture();
  const p = payload("ep-retry");
  payloads.set(p.episodeId, p);
  ledger.insertEpisode(row(p));
  const key = outbox.enqueue(p);
  assert.equal(outbox.enqueue(p), key, "re-enqueue of the same payload is idempotent");
  assert.equal(ledger.listOutbox().length, 1);

  adapter.unavailable = true;
  let result = await outbox.drain();
  assert.equal(result.failed, 1);
  assert.equal(ledger.listOutbox(["failed"])[0]?.retries, 1);
  assert.match(ledger.listOutbox(["failed"])[0]?.lastError ?? "", /unavailable/);

  // Degraded retrieval uses the local ledger cache and says so.
  const degraded = await retrieveEpisodes(
    adapter,
    ledger,
    evidence,
    SCOPE,
    "cache normalized documents",
  );
  assert.equal(degraded.degraded, true);
  assert.deepEqual(
    degraded.injected.map((i) => [i.episodeId, i.source]),
    [["ep-retry", "local_cache"]],
  );

  adapter.unavailable = false;
  adapter.deferReadiness = true;
  const future = Date.now() + 60 * 60 * 1000;
  result = await outbox.drain(future);
  assert.equal(result.submitted, 1);
  assert.equal(
    ledger.listOutbox(["submitted"]).length,
    1,
    "API acceptance leaves the row submitted, not ready",
  );

  result = await outbox.drain(future);
  assert.equal(result.ready, 0);
  assert.equal(ledger.listOutbox(["document_ready"]).length, 1);
  assert.equal((await adapter.search(TAG, "cache", 5)).length, 0, "not searchable until processed");

  adapter.settle();
  result = await outbox.drain(future + 60 * 60 * 1000);
  assert.equal(result.ready, 1);
  assert.equal(ledger.listOutbox(["memory_ready"]).length, 1);
  const hits = await adapter.search(TAG, "cache", 5);
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.customId, "ep-retry");
  ledger.close();
});

test("rendered episodes carry no raw evidence, only IDs, and label seeded fixtures", () => {
  const p = payload("ep-render", {
    evidenceIds: ["ev-timing-0123456789abcdef"],
    seededFixture: "stale-cache",
  });
  const text = renderEpisode(p);
  assert.match(text, /ev-timing-0123456789abcdef/);
  assert.match(text, /stale-cache/i);
  assert.doesNotMatch(text, /"samples"|latencies/);
  assert.equal(episodeMetadata(p).seededFixture, "stale-cache");
});
