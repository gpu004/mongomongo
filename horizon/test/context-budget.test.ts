import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_PACKET_BUDGET, PacketConfigurationError, buildPacket, estimateTokens } from "../src/context-packet.ts";

const words = (n: number, w = "word") => Array.from({ length: n }, (_, i) => `${w}${i}`).join(" ");

test("default budget sums to the planned 8k allocation", () => {
	const b = DEFAULT_PACKET_BUDGET;
	assert.equal(b.pinned + b.featureMap + b.recent + b.retrieved + b.next, b.total);
	assert.equal(b.total, 8000);
});

test("optional sections are trimmed to their allowance and the whole packet stays under the cap", () => {
	const packet = buildPacket({
		pinned: "mission state",
		featureMap: words(4000),
		recent: words(4000),
		retrieved: [],
		next: words(4000),
	});
	assert.ok(packet.sections.featureMap <= DEFAULT_PACKET_BUDGET.featureMap);
	assert.ok(packet.sections.recent <= DEFAULT_PACKET_BUDGET.recent);
	assert.ok(packet.sections.next <= DEFAULT_PACKET_BUDGET.next);
	assert.ok(packet.tokens <= DEFAULT_PACKET_BUDGET.total);
	assert.match(packet.text, /\[\.\.\.truncated\]/);
});

test("retrieved episodes are included whole, in order, until the retrieval allowance is spent", () => {
	const episode = (id: string, tokens: number) => ({ episodeId: id, text: "x".repeat(tokens * 4) });
	const packet = buildPacket({
		pinned: "state",
		featureMap: "features",
		recent: "recent",
		retrieved: [episode("ep-1", 1000), episode("ep-2", 1000), episode("ep-3", 1000), episode("ep-4", 100)],
		next: "next",
	});
	assert.deepEqual(packet.injectedEpisodeIds, ["ep-1", "ep-2", "ep-4"]);
	assert.deepEqual(packet.droppedEpisodeIds, ["ep-3"]);
	assert.ok(packet.sections.retrieved <= DEFAULT_PACKET_BUDGET.retrieved);
	assert.doesNotMatch(packet.text, /x{3999}x\n\[\.\.\.truncated\]/, "episodes are never partially included");
});

test("pinned constraints are never truncated: an oversized pinned section is a configuration error", () => {
	const pinned = words(3000);
	assert.ok(estimateTokens(pinned) > DEFAULT_PACKET_BUDGET.pinned);
	assert.throws(
		() => buildPacket({ pinned, featureMap: "", recent: "", retrieved: [], next: "" }),
		(error: unknown) => error instanceof PacketConfigurationError && /refusing to truncate/.test(error.message),
	);
});

test("a custom budget whose sections exceed the total is refused rather than silently overflowing", () => {
	const budget = { total: 100, pinned: 80, featureMap: 80, recent: 80, retrieved: 80, next: 80 };
	assert.throws(
		() => buildPacket({ pinned: words(60), featureMap: words(60), recent: words(60), retrieved: [], next: words(60) }, budget),
		PacketConfigurationError,
	);
});
