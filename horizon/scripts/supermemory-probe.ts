/**
 * Hosted-memory probe: measures what the local adapter cannot — API acceptance
 * latency, indexing lag (accepted -> "done"), search latency, and whether
 * scoped retrieval stays correct against the real service while documents are
 * still indexing. Uses a fresh containerTag per run. Requires SUPERMEMORY_API_KEY.
 *
 *   node scripts/supermemory-probe.ts [--episodes 12] [--timeout-s 600] [--out DIR]
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Ledger } from "../src/ledger.ts";
import {
  type EpisodePayload,
  episodeMetadata,
  renderEpisode,
  SupermemoryAdapter,
} from "../src/memory-adapter.ts";
import { MemoryOutbox, retrieveEpisodes } from "../src/memory-outbox.ts";
import { FileEvidenceStore } from "../src/mission-paths.ts";

const { values } = parseArgs({
  options: {
    episodes: { type: "string" },
    "timeout-s": { type: "string" },
    out: { type: "string" },
  },
});
const apiKey = process.env.SUPERMEMORY_API_KEY;
if (!apiKey) {
  console.error("SUPERMEMORY_API_KEY is not set");
  process.exit(2);
}
const count = Number(values.episodes ?? 12);
const timeoutMs = Number(values["timeout-s"] ?? 600) * 1000;
const runId = `${Date.now().toString(36)}`;
const missionId = `probe-${runId}`;
const containerTag = `horizon-${missionId}`;
const scope = { missionId, containerTag, contractVersion: 1 };

const dir = mkdtempSync(join(tmpdir(), "horizon-smprobe-"));
const ledger = new Ledger(join(dir, "mission.sqlite"));
const evidence = new FileEvidenceStore(join(dir, "evidence"));
const evidenceId = evidence.write("probe", { runId });
const adapter = new SupermemoryAdapter(apiKey, 30_000);
const payloads = new Map<string, EpisodePayload>();
let operations = 0;
const outbox = new MemoryOutbox(
  ledger,
  adapter,
  containerTag,
  (id) => payloads.get(id),
  () => (operations += 1),
);

// Distinct, retrievable facts: each experiment has a unique code word in its outcome.
const CODES = [
  "amber",
  "basalt",
  "cobalt",
  "delta",
  "ember",
  "fjord",
  "granite",
  "harbor",
  "indigo",
  "juniper",
  "krypton",
  "lagoon",
  "marble",
  "nimbus",
  "onyx",
  "prairie",
  "quartz",
  "raven",
  "sierra",
  "tundra",
];
function payload(i: number, version = 1): EpisodePayload {
  const code = CODES[i % CODES.length]!;
  const id = `ep-${runId}-${i}-v${version}`;
  return {
    episodeId: id,
    missionId,
    contractVersion: 1,
    version,
    supersedes: version > 1 ? `ep-${runId}-${i}-v${version - 1}` : null,
    experimentId: `exp-${runId}-${i}`,
    taskId: "optimize-search",
    hypothesis: `${code} strategy for the search read path`,
    featureIds: ["search-matching"],
    invariantIds: [],
    parentArtifactHash: "a".repeat(64),
    artifactHash: `${i}`.padStart(64, "b"),
    whatChanged: `${code} change to the posting index`,
    correctness: "passed",
    performance: `p95 ${10 + i}ms`,
    outcome: `${code} verdict revision ${version}: ${version === 1 ? "rejected on timing noise" : "accepted after re-measurement"}`,
    uncertainty: "probe",
    reportIds: [],
    evidenceIds: [evidenceId],
    nextAction: "none",
    interpretation: "verified",
    seededFixture: null,
  };
}
function add(p: EpisodePayload): void {
  payloads.set(p.episodeId, p);
  ledger.insertEpisode({
    episodeId: p.episodeId,
    missionId,
    experimentId: p.experimentId,
    version: p.version,
    supersedes: p.supersedes,
    featureIds: p.featureIds,
    invariantIds: [],
    artifactHash: p.artifactHash,
    parentArtifactHash: p.parentArtifactHash,
    interpretation: "verified",
    evidenceIds: p.evidenceIds,
    summary: renderEpisode(p),
    createdAt: new Date().toISOString(),
  });
  outbox.enqueue(p);
}
const pct = (xs: number[], p: number) =>
  xs.length
    ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))]!
    : 0;

async function ask(
  i: number,
): Promise<{ correct: boolean; source: string | null; ms: number; foreignInjected: boolean }> {
  const code = CODES[i % CODES.length]!;
  const expected = payloads.has(`ep-${runId}-${i}-v2`)
    ? `ep-${runId}-${i}-v2`
    : `ep-${runId}-${i}-v1`;
  const started = performance.now();
  const selection = await retrieveEpisodes(
    adapter,
    ledger,
    evidence,
    scope,
    `${code} verdict`,
    10,
    5,
  );
  const ms = performance.now() - started;
  const top = selection.injected[0];
  return {
    correct: top?.episodeId === expected,
    source: top?.source ?? null,
    ms,
    foreignInjected: selection.injected.some((s) => !payloads.has(s.episodeId)),
  };
}

const n = Math.min(count, CODES.length);
const submittedAt = new Map<string, number>();
const readyAt = new Map<string, number>();
const addLatency: number[] = [];
for (let i = 0; i < n; i++) add(payload(i));
// A foreign-mission document in the same container: must never be injected.
await adapter.add(
  containerTag,
  `foreign-${runId}`,
  `Mission other; ${CODES[0]} verdict revision 9: foreign result`,
  { missionId: "other-mission", episodeId: `ep-${runId}-0-v1`, contractVersion: 1 },
);
operations += 1;

for (const row of ledger.listOutbox(["pending"])) {
  const t0 = performance.now();
  await outbox.drain(Date.now());
  addLatency.push(performance.now() - t0);
  submittedAt.set(row.episodeId, Date.now());
  if (ledger.listOutbox(["pending"]).length === 0) break;
}
for (const row of ledger.listOutbox(["submitted"]))
  if (!submittedAt.has(row.episodeId)) submittedAt.set(row.episodeId, Date.now());

// Immediately after acceptance: nothing is indexed yet, so answers must come from the local pending merge.
const beforeIndex = await Promise.all(Array.from({ length: n }, (_, i) => ask(i)));

const deadline = Date.now() + timeoutMs;
while (Date.now() < deadline) {
  await outbox.drain(Date.now() + 60_000);
  for (const row of ledger.listOutbox(["memory_ready"]))
    if (!readyAt.has(row.episodeId)) readyAt.set(row.episodeId, Date.now());
  if (readyAt.size >= n) break;
  await new Promise((r) => setTimeout(r, 3000));
}

// Supersede half the episodes after indexing; v2 is not yet indexed when first asked.
for (let i = 0; i < n; i += 2) add(payload(i, 2));
await outbox.drain(Date.now() + 60_000);
const afterSupersede = await Promise.all(Array.from({ length: n }, (_, i) => ask(i)));
const afterIndex: Awaited<ReturnType<typeof ask>>[] = [];
for (let i = 0; i < n; i++) afterIndex.push(await ask(i));

const lags = [...readyAt].map(([id, t]) => t - submittedAt.get(id)!);
const summarize = (xs: Awaited<ReturnType<typeof ask>>[]) => ({
  correct: xs.filter((x) => x.correct).length,
  asked: xs.length,
  foreignInjected: xs.filter((x) => x.foreignInjected).length,
  sources: xs.reduce<Record<string, number>>(
    (m, x) => ((m[x.source ?? "none"] = (m[x.source ?? "none"] ?? 0) + 1), m),
    {},
  ),
  p50Ms: Math.round(
    pct(
      xs.map((x) => x.ms),
      0.5,
    ),
  ),
  p95Ms: Math.round(
    pct(
      xs.map((x) => x.ms),
      0.95,
    ),
  ),
});
const result = {
  runId,
  containerTag,
  episodes: n,
  operations,
  submitDrainMs: { p50: Math.round(pct(addLatency, 0.5)), p95: Math.round(pct(addLatency, 0.95)) },
  indexing: {
    ready: readyAt.size,
    of: n,
    lagP50Ms: pct(lags, 0.5),
    lagP95Ms: pct(lags, 0.95),
    lagMaxMs: Math.max(0, ...lags),
    timedOut: readyAt.size < n,
  },
  beforeIndex: summarize(beforeIndex),
  afterSupersedeUnindexedV2: summarize(afterSupersede),
  afterIndex: summarize(afterIndex),
  outboxStates: ledger
    .listOutbox(["pending", "failed", "submitted", "document_ready", "memory_ready"])
    .reduce<Record<string, number>>((m, r) => ((m[r.state] = (m[r.state] ?? 0) + 1), m), {}),
  metadataSample: episodeMetadata(payload(0)),
};
console.log(JSON.stringify(result, null, 2));
if (values.out) {
  mkdirSync(resolve(values.out), { recursive: true });
  writeFileSync(
    join(resolve(values.out), "supermemory-probe.json"),
    JSON.stringify(result, null, 2),
  );
}
ledger.close();
