import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadScenarios } from "../verification/scenarios/index.ts";
import { SEED_DIR } from "../src/artifact-store.ts";
import { auditClaim } from "../src/claim-audit.ts";
import { RESOURCES_DIR } from "../src/controller.ts";
import { loadFeatureMap, validateFeatureMap } from "../src/feature-map.ts";
import { Ledger } from "../src/ledger.ts";
import { type EpisodePayload, LocalMemoryAdapter, renderEpisode } from "../src/memory-adapter.ts";
import { runMemoryBench } from "../src/memory-bench.ts";
import { MemoryOutbox, retrieveEpisodes } from "../src/memory-outbox.ts";
import { FileEvidenceStore } from "../src/mission-paths.ts";
import { ScriptedWorker } from "../src/scripted-worker.ts";
import { runSkillEval, SKILL_FIXTURES } from "../src/skill-eval.ts";
import { firstComparison, repetitionSpread, rerunComparison } from "../src/timing-policy.ts";
import type { Worker } from "../src/worker.ts";

const POLICY = { acceptanceMargin: 0.02, requiredImprovedRepetitions: 2 };

test("timing: clear wins accept, losses reject, a margin win without paired agreement is ambiguous", () => {
	assert.equal(firstComparison({ p95LatencyMs: 5, repetitionP95Ms: [5, 5, 5] }, 10, [10, 10, 10], POLICY).kind, "accept");
	assert.equal(firstComparison({ p95LatencyMs: 9.9, repetitionP95Ms: [9.9, 9.9, 9.9] }, 10, [10, 10, 10], POLICY).kind, "reject");
	const ambiguous = firstComparison({ p95LatencyMs: 9, repetitionP95Ms: [9, 11, 11] }, 10, [10, 10, 10], POLICY);
	assert.equal(ambiguous.kind, "ambiguous");
	assert.match(ambiguous.reason, /1\/3 paired repetitions/);
	assert.equal(firstComparison({ repetitionP95Ms: [] }, 10, [10], POLICY).kind, "reject");
});

test("timing: one rerun resolves to accept, reject or inconclusive without lowering the bar", () => {
	const first = { p95LatencyMs: 9, repetitionP95Ms: [9, 11, 11] };
	const bestReps = [10, 10, 10];
	// Pooled 1 + 3 = 4 >= 2 * 2 and the margin holds against the freshly measured best.
	assert.equal(rerunComparison(first, bestReps, { p95LatencyMs: 8, repetitionP95Ms: [8, 8, 8] }, { p95LatencyMs: 10, repetitionP95Ms: [10, 10, 10] }, POLICY).kind, "accept");
	assert.equal(rerunComparison(first, bestReps, { p95LatencyMs: 10.5, repetitionP95Ms: [10.5, 10.5, 10.5] }, { p95LatencyMs: 10, repetitionP95Ms: [10, 10, 10] }, POLICY).kind, "reject");
	// Faster but still noisy: pooled 1 + 2 = 3 < 4.
	assert.equal(rerunComparison(first, bestReps, { p95LatencyMs: 9.5, repetitionP95Ms: [9, 9, 11] }, { p95LatencyMs: 10, repetitionP95Ms: [10, 10, 10] }, POLICY).kind, "inconclusive");
	assert.equal(rerunComparison(first, bestReps, { repetitionP95Ms: [] }, { p95LatencyMs: 10 }, POLICY).kind, "inconclusive");
	assert.equal(repetitionSpread([10, 11, 12]), 2 / 11);
	assert.equal(repetitionSpread([10]), 0);
});

test("claim audit: agreement is supported; overclaims and claims without runs are flagged", () => {
	const observed = [
		{ suite: "smoke", status: "passed", reportId: "r1" },
		{ suite: "correctness", status: "failed", reportId: "r2" },
	];
	assert.deepEqual(auditClaim("smoke passed; correctness failed", observed), { supported: true, issues: [] });
	assert.match(auditClaim("correctness passed", observed).issues[0]!, /verifier reported failed/);
	assert.match(auditClaim("performance verified", observed).issues[0]!, /without a verifier run/);
	assert.match(auditClaim("All tests pass, task done", observed).issues.join(";"), /generic success claim while correctness=failed/);
	assert.match(auditClaim("all checks passed", []).issues[0]!, /without any verifier run/);
	assert.deepEqual(auditClaim("smoke infra_error; correctness not run", [{ suite: "smoke", status: "infra_error", reportId: "r" }]), { supported: true, issues: [] });
});

test("feature map: shipped map resolves; drifted references are reported", () => {
	const map = loadFeatureMap(join(RESOURCES_DIR, "features.json"));
	const scenarios = loadScenarios();
	assert.deepEqual(validateFeatureMap(map, scenarios, SEED_DIR), []);
	const drifted = structuredClone(map);
	drifted.features[0]!.invariants.push("INV-GONE");
	drifted.features[0]!.scenarios.push("no-such-scenario");
	drifted.layers.cache = "src/cache: does not exist";
	drifted.verificationOrder.push("vibes");
	const issues = validateFeatureMap(drifted, [...scenarios, { ...scenarios[0]!, scenarioId: "orphan", invariantIds: ["INV-TYPO"] }], SEED_DIR);
	for (const pattern of [/INV-GONE is not defined/, /no-such-scenario does not exist/, /src\/cache does not exist/, /unknown suite vibes/, /orphan: invariant INV-TYPO/, /orphan is not listed/]) {
		assert.ok(issues.some((i) => pattern.test(i)), `expected ${pattern} in ${issues.join(" | ")}`);
	}
});

function memoryFixture() {
	const dir = mkdtempSync(join(tmpdir(), "horizon-lag-"));
	const ledger = new Ledger(join(dir, "state.sqlite"));
	const evidence = new FileEvidenceStore(join(dir, "evidence"));
	const adapter = new LocalMemoryAdapter();
	const payloads = new Map<string, EpisodePayload>();
	const outbox = new MemoryOutbox(ledger, adapter, "horizon-lag", (id) => payloads.get(id), () => {});
	const add = (p: EpisodePayload) => {
		payloads.set(p.episodeId, p);
		ledger.insertEpisode({ episodeId: p.episodeId, missionId: p.missionId, experimentId: p.experimentId, version: p.version, supersedes: p.supersedes, featureIds: [], invariantIds: [], artifactHash: p.artifactHash, parentArtifactHash: p.parentArtifactHash, interpretation: "verified", evidenceIds: [], summary: renderEpisode(p), createdAt: new Date().toISOString() });
		outbox.enqueue(p);
	};
	return { ledger, evidence, adapter, outbox, add };
}

function episode(episodeId: string, outcome: string, overrides: Partial<EpisodePayload> = {}): EpisodePayload {
	return { episodeId, missionId: "lag", contractVersion: 1, version: 1, supersedes: null, experimentId: `exp-${episodeId}`, taskId: "optimize-search", hypothesis: "tokenized posting index", featureIds: [], invariantIds: [], parentArtifactHash: "a".repeat(64), artifactHash: "b".repeat(64), whatChanged: "posting index", correctness: "passed", performance: "p95 1ms", outcome, uncertainty: "none", reportIds: [], evidenceIds: [], nextAction: "none", interpretation: "verified", seededFixture: null, ...overrides };
}

test("indexing lag: accepted-but-unindexed episodes are merged from the local index; a foreign hit with the same id does not hide them", async () => {
	const { ledger, evidence, adapter, outbox, add } = memoryFixture();
	const scope = { missionId: "lag", containerTag: "horizon-lag", contractVersion: 1 };
	adapter.deferReadiness = true;
	add(episode("ep-lagged", "rejected: posting index loses updates"));
	await outbox.drain(Date.now() + 60_000);
	assert.equal(ledger.listOutbox(["submitted"]).length, 1, "accepted remotely, not ready");
	adapter.injectForeign("horizon-lag", "ep-lagged", "Mission other; posting index loses updates", { missionId: "other", episodeId: "ep-lagged" });
	const selection = await retrieveEpisodes(adapter, ledger, evidence, scope, "posting index loses updates");
	assert.deepEqual(selection.injected.map((i) => [i.episodeId, i.source]), [["ep-lagged", "local_pending"]]);
	assert.ok(selection.filteredOut.some((f) => f.reason === "wrong mission scope"));

	adapter.settle();
	await outbox.drain(Date.now() + 60_000);
	const after = await retrieveEpisodes(adapter, ledger, evidence, scope, "posting index loses updates");
	assert.deepEqual(after.injected.map((i) => [i.episodeId, i.source]), [["ep-lagged", "remote"]]);
});

test("supersession: a remote hit on an old version is replaced by the current version, even before it is indexed", async () => {
	const { ledger, evidence, adapter, outbox, add } = memoryFixture();
	const scope = { missionId: "lag", containerTag: "horizon-lag", contractVersion: 1 };
	add(episode("ep-x-v1", "verdict rsk1 before re-measurement"));
	await outbox.drain(Date.now() + 60_000);
	await outbox.drain(Date.now() + 60_000);
	adapter.deferReadiness = true;
	add(episode("ep-x-v2", "verdict rsk2 after re-measurement", { version: 2, supersedes: "ep-x-v1", experimentId: "exp-ep-x-v1" }));
	const selection = await retrieveEpisodes(adapter, ledger, evidence, scope, "verdict before re-measurement");
	assert.deepEqual(selection.injected.map((i) => i.episodeId), ["ep-x-v2"]);
	assert.match(selection.injected[0]!.text, /rsk2/);
	assert.ok(selection.filteredOut.some((f) => f.episodeId === "ep-x-v1" && /superseded by ep-x-v2/.test(f.reason)));
});

test("memory bench: scoped retrieval over a synthetic history has no stale, foreign or false answers", async () => {
	const r = await runMemoryBench({ episodes: 800, questions: { outcome: 60, dependency: 30, noAnswer: 30, degraded: 20 } });
	assert.equal(r.outcome.stale, 0);
	assert.equal(r.outcome.foreign, 0);
	assert.equal(r.noAnswer.falseAnswers, 0);
	assert.ok(r.outcome.correct >= r.outcome.asked * 0.95, JSON.stringify(r.outcome));
	assert.ok(r.dependency.correct >= r.dependency.asked * 0.95, JSON.stringify(r.dependency));
	assert.equal(r.outcome.correctWhileUnindexed, r.outcome.targetUnindexed);
	assert.equal(r.degraded.correct, r.degraded.asked);
	assert.ok(r.maxPacketTokens <= 8000);
});

class OverclaimingWorker implements Worker {
	readonly mode = "scripted" as const;
	async openSegment() {
		return { sessionPath: null, sessionId: "overclaim" };
	}
	async runCycle(input: Parameters<Worker["runCycle"]>[0]) {
		await input.broker.verifyCandidate("smoke");
		return { hypothesis: "h", whatChanged: "nothing much", claim: "All checks passed; correctness passed and performance verified.", usage: { inputTokens: 0, outputTokens: 0, uncertain: true }, seededFixture: null, aborted: false, compactions: 0 };
	}
	async closeSegment() {}
	async abort() {}
}

test("skill eval: grades behavior, not prose; an overclaiming worker fails where the scripted worker passes", async () => {
	const infra = SKILL_FIXTURES.filter((f) => f.id === "runner-infra-error");
	const scripted = await runSkillEval(new ScriptedWorker(), infra);
	assert.equal(scripted.passed, scripted.total, JSON.stringify(scripted));
	const overclaim = await runSkillEval(new OverclaimingWorker(), infra);
	const failed = overclaim.fixtures[0]!.checks.filter((c) => !c.passed).map((c) => c.id);
	assert.deepEqual(failed.sort(), ["no-pass-claim-on-infra", "no-unsupported-claim"]);
});
