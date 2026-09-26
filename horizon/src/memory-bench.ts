import { mkdtempSync, rmSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPacket, DEFAULT_PACKET_BUDGET, estimateTokens } from "./context-packet.ts";
import { Ledger } from "./ledger.ts";
import { type EpisodePayload, LocalMemoryAdapter, renderEpisode } from "./memory-adapter.ts";
import { MemoryOutbox, retrieveEpisodes, type RetrievalSelection } from "./memory-outbox.ts";
import { FileEvidenceStore } from "./mission-paths.ts";

/**
 * Synthetic mission-history benchmark for the memory path the controller uses:
 * ledger episodes -> outbox -> memory adapter -> scoped retrieval -> packet.
 * History contains revised verdicts (supersession), cross-episode dependencies,
 * same-scope distractors from another mission, episodes whose evidence is
 * gone, an unindexed tail (indexing lag) and questions with no answer.
 * Answers must cite the episode they came from.
 */
export interface MemoryBenchOptions {
	episodes: number;
	seed?: number;
	/** Most recent episodes left unindexed remotely at question time. */
	unindexedTail?: number;
	questions?: { outcome: number; dependency: number; noAnswer: number; degraded: number };
	keepDir?: string;
}

export interface MemoryBenchResult {
	episodes: number;
	experiments: number;
	revisions: number;
	foreignDistractors: number;
	unindexedTail: number;
	archivedTokens: number;
	storageBytes: number;
	ingestMs: number;
	ingestEpisodesPerSec: number;
	deliveryMs: number;
	outcome: { asked: number; correct: number; stale: number; foreign: number; missed: number; targetUnindexed: number; correctWhileUnindexed: number };
	dependency: { asked: number; correct: number; missed: number };
	noAnswer: { asked: number; abstained: number; falseAnswers: number };
	degraded: { asked: number; correct: number; p50Ms: number; p95Ms: number };
	retrievalP50Ms: number;
	retrievalP95Ms: number;
	maxPacketTokens: number;
	filteredOut: Record<string, number>;
	rssBytes: number;
}

function rng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const WORDS = "index cache normalize tokenizer shard buffer allocation latency throughput hashmap trie posting bitmap arena lazy rebuild invalidate mutation version snapshot profile hotpath branch inline vectorize prefix suffix substring scan batch warmup compaction segment rotation checkpoint ledger outbox retrieval evidence verifier contract invariant workload holdout margin repetition".split(" ");

function expId(n: number): string {
	return `exp-${String(n).padStart(7, "0")}`;
}

function percentile(values: number[], p: number): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
}

export async function runMemoryBench(options: MemoryBenchOptions): Promise<MemoryBenchResult> {
	const random = rng(options.seed ?? 42);
	const pick = <T>(items: T[]): T => items[Math.floor(random() * items.length)]!;
	const dir = options.keepDir ?? mkdtempSync(join(tmpdir(), "horizon-membench-"));
	const missionId = "bench";
	const containerTag = `horizon-${missionId}`;
	const ledger = new Ledger(join(dir, "mission.sqlite"));
	const evidence = new FileEvidenceStore(join(dir, "evidence"));
	const evidencePool = Array.from({ length: 20 }, (_, i) => evidence.write("bench", { i }));
	const adapter = new LocalMemoryAdapter();
	adapter.deferReadiness = true;
	const payloads = new Map<string, EpisodePayload>();
	const outbox = new MemoryOutbox(ledger, adapter, containerTag, (id) => payloads.get(id), () => {});

	// Timeline: each experiment gets v1; ~25% are later revised (v2), ~5% twice (v3).
	type Planned = { experiment: number; version: number };
	const timeline: Planned[] = [];
	const pendingRevisions: { at: number; item: Planned }[] = [];
	let experiments = 0;
	while (timeline.length < options.episodes) {
		const due = pendingRevisions.findIndex((r) => r.at <= timeline.length);
		if (due !== -1) {
			timeline.push(pendingRevisions.splice(due, 1)[0]!.item);
			continue;
		}
		const e = experiments++;
		timeline.push({ experiment: e, version: 1 });
		if (random() < 0.25) pendingRevisions.push({ at: timeline.length + 1 + Math.floor(random() * 400), item: { experiment: e, version: 2 } });
		if (random() < 0.05) pendingRevisions.push({ at: timeline.length + 401 + Math.floor(random() * 400), item: { experiment: e, version: 3 } });
	}

	const latest = new Map<number, { episodeId: string; value: string; values: string[] }>();
	const dependsOn = new Map<number, number>();
	const orphaned = new Set<string>();
	let archivedTokens = 0;
	let revisions = 0;
	const started = Date.now();
	const base = Date.parse("2026-01-01T00:00:00Z");
	const BATCH = 2000;
	for (let start = 0; start < timeline.length; start += BATCH) {
		const enqueued: Promise<string>[] = [];
		ledger.transaction(() => {
			for (let i = start; i < Math.min(timeline.length, start + BATCH); i += 1) {
				const { experiment, version } = timeline[i]!;
				const id = expId(experiment);
				const episodeId = `ep-${id}-v${version}`;
				const prior = latest.get(experiment);
				const value = `r${Math.floor(random() * 0xffffff).toString(16)}`;
				if (version === 1 && experiment > 10 && random() < 0.15) dependsOn.set(experiment, Math.floor(random() * experiment));
				const dep = dependsOn.get(experiment);
				const filler = Array.from({ length: 12 }, () => pick(WORDS)).join(" ");
				const missingEvidence = version === 1 && random() < 0.02;
				const evidenceIds = missingEvidence ? ["ev-bench-0000000000000000"] : [pick(evidencePool)];
				if (missingEvidence) orphaned.add(episodeId);
				if (version > 1) revisions += 1;
				const payload: EpisodePayload = {
					episodeId,
					missionId,
					contractVersion: 1,
					version,
					supersedes: version > 1 ? prior!.episodeId : null,
					experimentId: id,
					taskId: "optimize-search",
					hypothesis: filler,
					featureIds: ["F-MATCH"],
					invariantIds: [],
					parentArtifactHash: "0".repeat(12),
					artifactHash: experiment.toString(16).padStart(12, "0"),
					whatChanged: `${pick(WORDS)} ${pick(WORDS)}${dep !== undefined ? `; fixes regression introduced by ${expId(dep)}` : ""}`,
					correctness: "smoke=passed, correctness=passed",
					performance: `p95 ${(1 + random()).toFixed(3)}ms`,
					outcome: `verified outcome of ${id} is ${value}${version > 1 ? ` (revised after re-measurement)` : ""}`,
					uncertainty: "synthetic benchmark episode",
					reportIds: [`rep-${id}-${version}`],
					evidenceIds,
					nextAction: pick(WORDS),
					interpretation: "verified",
					seededFixture: null,
				};
				const summary = renderEpisode(payload);
				archivedTokens += estimateTokens(summary);
				payloads.set(episodeId, payload);
				ledger.insertEpisode({ episodeId, missionId, experimentId: id, version, supersedes: payload.supersedes, featureIds: payload.featureIds, invariantIds: [], artifactHash: payload.artifactHash, parentArtifactHash: payload.parentArtifactHash, interpretation: "verified", evidenceIds, summary, createdAt: new Date(base + i * 1000).toISOString() });
				enqueued.push(outbox.enqueue(payload));
				latest.set(experiment, { episodeId, value, values: [...(prior?.values ?? []), value] });
			}
		});
		await Promise.all(enqueued);
	}
	const ingestMs = Date.now() - started;

	// Same-scope distractors: another mission's episodes about the same experiment ids, as a misconfigured remote could return.
	let foreignDistractors = 0;
	for (let e = 0; e < experiments; e += 1) {
		if (random() >= 0.1) continue;
		foreignDistractors += 1;
		adapter.injectForeign(containerTag, `ep-${expId(e)}-v1`, `Mission other; episode ep-${expId(e)}-v1\nOutcome: verified outcome of ${expId(e)} is foreign${e}`, { missionId: "other-mission", episodeId: `ep-${expId(e)}-v1`, contractVersion: 1 });
	}

	const tail = Math.min(options.unindexedTail ?? 500, Math.floor(options.episodes / 10));
	const deliveryStarted = Date.now();
	await outbox.drain(Date.now() + 60_000);
	adapter.settle(timeline.length - tail);
	await outbox.drain(Date.now() + 60_000);
	const deliveryMs = Date.now() - deliveryStarted;
	const unindexed = new Set(ledger.listOutbox(["submitted", "document_ready", "pending", "failed"]).map((r) => r.episodeId));

	const scope = { missionId, containerTag, contractVersion: 1 };
	const latencies: number[] = [];
	const filteredOut: Record<string, number> = {};
	let maxPacketTokens = 0;
	const ask = async (query: string): Promise<RetrievalSelection> => {
		const t0 = performance.now();
		const selection = await retrieveEpisodes(adapter, ledger, evidence, scope, query, 10, 5);
		latencies.push(performance.now() - t0);
		for (const f of selection.filteredOut) {
			const reason = f.reason.startsWith("superseded") ? "superseded" : f.reason;
			filteredOut[reason] = (filteredOut[reason] ?? 0) + 1;
		}
		const packet = buildPacket({ pinned: "Mission bench (contract v1). Constraints: verifier is authoritative.", featureMap: "", recent: "", retrieved: selection.injected.map((r) => ({ episodeId: r.episodeId, text: r.text })), next: "" }, DEFAULT_PACKET_BUDGET);
		maxPacketTokens = Math.max(maxPacketTokens, packet.tokens);
		return selection;
	};
	const answerOutcome = (selection: RetrievalSelection, id: string): { value: string; episodeId: string } | null => {
		for (const r of selection.injected) {
			if (!r.text.includes(`episode ep-${id}-v`)) continue;
			const m = new RegExp(`verified outcome of ${id} is (\\S+)`).exec(r.text);
			if (m) return { value: m[1]!, episodeId: r.episodeId };
		}
		return null;
	};

	const q = options.questions ?? { outcome: 200, dependency: 100, noAnswer: 100, degraded: 50 };
	const answerable = [...latest.keys()].filter((e) => !orphaned.has(`ep-${expId(e)}-v1`) || latest.get(e)!.episodeId !== `ep-${expId(e)}-v1`);
	const outcome = { asked: 0, correct: 0, stale: 0, foreign: 0, missed: 0, targetUnindexed: 0, correctWhileUnindexed: 0 };
	for (let i = 0; i < q.outcome; i += 1) {
		// Bias half the questions toward recent experiments, where revisions and the unindexed tail live.
		const e = i % 2 === 0 ? pick(answerable) : answerable[Math.max(0, answerable.length - 1 - Math.floor(random() * Math.min(answerable.length, tail * 2)))]!;
		const truth = latest.get(e)!;
		const id = expId(e);
		const selection = await ask(`verified outcome of ${id}`);
		const answer = answerOutcome(selection, id);
		outcome.asked += 1;
		const isUnindexed = unindexed.has(truth.episodeId);
		if (isUnindexed) outcome.targetUnindexed += 1;
		if (!answer) outcome.missed += 1;
		else if (answer.value === truth.value && answer.episodeId === truth.episodeId) {
			outcome.correct += 1;
			if (isUnindexed) outcome.correctWhileUnindexed += 1;
		} else if (answer.value.startsWith("foreign")) outcome.foreign += 1;
		else if (truth.values.includes(answer.value)) outcome.stale += 1;
		else outcome.missed += 1;
	}

	const dependency = { asked: 0, correct: 0, missed: 0 };
	const withDeps = [...dependsOn.keys()].filter((e) => !orphaned.has(`ep-${expId(e)}-v1`));
	for (let i = 0; i < Math.min(q.dependency, withDeps.length); i += 1) {
		const e = pick(withDeps);
		const id = expId(e);
		dependency.asked += 1;
		const selection = await ask(`which experiment introduced the regression fixed by ${id}`);
		const source = selection.injected.find((r) => r.text.includes(`episode ep-${id}-v`));
		const m = source ? /fixes regression introduced by (exp-\d+)/.exec(source.text) : null;
		// Second hop through canonical state: the referenced experiment must exist locally.
		const referenced = m ? ledger.getEpisode(`ep-${m[1]}-v1`) : undefined;
		if (referenced && m![1] === expId(dependsOn.get(e)!)) dependency.correct += 1;
		else dependency.missed += 1;
	}

	const noAnswer = { asked: 0, abstained: 0, falseAnswers: 0 };
	for (let i = 0; i < q.noAnswer; i += 1) {
		const id = expId(experiments + 1 + Math.floor(random() * experiments + 1));
		noAnswer.asked += 1;
		if (answerOutcome(await ask(`verified outcome of ${id}`), id)) noAnswer.falseAnswers += 1;
		else noAnswer.abstained += 1;
	}
	const retrievalP50Ms = percentile(latencies, 0.5);
	const retrievalP95Ms = percentile(latencies, 0.95);

	adapter.unavailable = true;
	const degradedLatencies: number[] = [];
	const degraded = { asked: 0, correct: 0, p50Ms: 0, p95Ms: 0 };
	for (let i = 0; i < q.degraded; i += 1) {
		const e = pick(answerable);
		const truth = latest.get(e)!;
		const id = expId(e);
		const t0 = performance.now();
		const selection = await retrieveEpisodes(adapter, ledger, evidence, scope, `verified outcome of ${id}`, 10, 5);
		degradedLatencies.push(performance.now() - t0);
		degraded.asked += 1;
		const answer = answerOutcome(selection, id);
		if (answer && answer.value === truth.value && answer.episodeId === truth.episodeId && selection.degraded) degraded.correct += 1;
	}
	degraded.p50Ms = percentile(degradedLatencies, 0.5);
	degraded.p95Ms = percentile(degradedLatencies, 0.95);

	const dbPath = join(dir, "mission.sqlite");
	const storageBytes = [dbPath, `${dbPath}-wal`].filter(existsSync).reduce((n, p) => n + statSync(p).size, 0);
	ledger.close();
	const result: MemoryBenchResult = {
		episodes: timeline.length,
		experiments,
		revisions,
		foreignDistractors,
		unindexedTail: unindexed.size,
		archivedTokens,
		storageBytes,
		ingestMs,
		ingestEpisodesPerSec: Math.round(timeline.length / Math.max(0.001, ingestMs / 1000)),
		deliveryMs,
		outcome,
		dependency,
		noAnswer,
		degraded,
		retrievalP50Ms,
		retrievalP95Ms,
		maxPacketTokens,
		filteredOut,
		rssBytes: process.memoryUsage().rss,
	};
	if (!options.keepDir) rmSync(dir, { recursive: true, force: true });
	return result;
}

export function renderMemoryBench(results: MemoryBenchResult[]): string {
	const f = (n: number) => n.toFixed(2);
	const rows = results.map((r) =>
		[
			r.episodes,
			r.archivedTokens,
			`${(r.storageBytes / 1e6).toFixed(1)}MB`,
			r.ingestEpisodesPerSec,
			`${r.outcome.correct}/${r.outcome.asked}`,
			r.outcome.stale,
			r.outcome.foreign,
			`${r.outcome.correctWhileUnindexed}/${r.outcome.targetUnindexed}`,
			`${r.dependency.correct}/${r.dependency.asked}`,
			`${r.noAnswer.abstained}/${r.noAnswer.asked}`,
			`${r.degraded.correct}/${r.degraded.asked}`,
			`${f(r.retrievalP50Ms)}/${f(r.retrievalP95Ms)}`,
			`${f(r.degraded.p50Ms)}/${f(r.degraded.p95Ms)}`,
			r.maxPacketTokens,
		].join(" | "),
	);
	return [
		"| episodes | archived tokens | storage | ingest ep/s | outcome correct | stale | foreign | correct while unindexed | dependency | no-answer abstained | degraded correct | retrieval p50/p95 ms | degraded p50/p95 ms | max packet tokens |",
		"| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
		...rows.map((r) => `| ${r} |`),
	].join("\n");
}
