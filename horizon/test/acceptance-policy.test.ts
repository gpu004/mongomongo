import assert from "node:assert/strict";
import test from "node:test";
import { decideAcceptance, relativeSpread } from "../src/controller.ts";

const policy = { acceptanceMargin: 0.05, requiredImprovedRepetitions: 2 };
const best = { p95: 2.0, repetitionP95Ms: [2.0, 2.1, 1.9] };

test("a clear improvement on the median and on enough paired repetitions is accepted", () => {
	const d = decideAcceptance({ p95: 1.2, repetitionP95Ms: [1.2, 1.3, 1.1] }, best, policy);
	assert.equal(d.verdict, "accepted");
});

test("a clear regression beyond the margin band is rejected", () => {
	const d = decideAcceptance({ p95: 2.4, repetitionP95Ms: [2.4, 2.5, 2.3] }, best, policy);
	assert.equal(d.verdict, "rejected");
});

test("a p95 inside the +/- margin band is ambiguous timing, not a failed hypothesis", () => {
	for (const p95 of [1.91, 2.0, 2.09]) {
		const d = decideAcceptance({ p95, repetitionP95Ms: [p95, p95, p95] }, best, policy);
		assert.equal(d.verdict, "inconclusive", `p95 ${p95}`);
		assert.match(d.reason, /^ambiguous timing/);
	}
});

test("a better median with too few paired repetition wins is ambiguous timing", () => {
	const d = decideAcceptance({ p95: 1.8, repetitionP95Ms: [1.8, 2.2, 2.0] }, best, policy);
	assert.equal(d.verdict, "inconclusive");
	assert.match(d.reason, /only 1\/3/);
});

test("without a comparable best there is no verdict either way", () => {
	assert.equal(decideAcceptance({ p95: 1.0, repetitionP95Ms: [1.0] }, { p95: null, repetitionP95Ms: [] }, policy).verdict, "inconclusive");
	assert.equal(decideAcceptance({ p95: undefined, repetitionP95Ms: [] }, best, policy).verdict, "inconclusive");
});

test("relative spread is (max - min) / median and zero for fewer than two samples", () => {
	assert.equal(relativeSpread([]), 0);
	assert.equal(relativeSpread([2]), 0);
	assert.ok(Math.abs(relativeSpread([1.8, 2.0, 2.2]) - 0.2) < 1e-9);
});
