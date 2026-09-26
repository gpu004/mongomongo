import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Operation } from "../reference-model.ts";

export interface Scenario {
	schemaVersion: 1;
	scenarioId: string;
	description: string;
	suite: "smoke" | "correctness";
	invariantIds: string[];
	sequence: Operation[];
	/** Human-readable expected response for the last step, for the feature map. Verified by the reference model, not trusted. */
	example?: string;
	/** Present only on learned scenarios materialized from a correction. */
	origin?: { lessonId: string; episodeId: string; reportId: string; materializedAt: string };
}

export const SCENARIOS_DIR = new URL("./", import.meta.url).pathname;

export function loadScenarios(dir = SCENARIOS_DIR): Scenario[] {
	return readdirSync(dir)
		.filter((name) => name.endsWith(".json"))
		.sort()
		.map((name) => parseScenario(readFileSync(join(dir, name), "utf8"), name));
}

export function parseScenario(text: string, sourceName = "<inline>"): Scenario {
	const value: unknown = JSON.parse(text);
	const problem = validateScenarioShape(value);
	if (problem) throw new Error(`invalid scenario ${sourceName}: ${problem}`);
	return value as Scenario;
}

const OPS = new Set(["insert", "update", "delete", "search", "health"]);
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{2,79}$/u;

/** Returns undefined when valid, otherwise a reason. Used for both fixed and learned scenarios. */
export function validateScenarioShape(value: unknown): string | undefined {
	if (typeof value !== "object" || value === null) return "not an object";
	const s = value as Record<string, unknown>;
	if (s.schemaVersion !== 1) return "schemaVersion must be 1";
	if (typeof s.scenarioId !== "string" || !ID_PATTERN.test(s.scenarioId)) return "scenarioId must be kebab-case";
	if (typeof s.description !== "string" || s.description.length === 0) return "description required";
	if (s.suite !== "smoke" && s.suite !== "correctness") return "suite must be smoke|correctness";
	if (!Array.isArray(s.invariantIds) || s.invariantIds.some((i) => typeof i !== "string")) return "invariantIds must be strings";
	if (!Array.isArray(s.sequence) || s.sequence.length === 0 || s.sequence.length > 200) return "sequence must have 1..200 steps";
	for (const [index, step] of s.sequence.entries()) {
		if (typeof step !== "object" || step === null) return `step ${index} not an object`;
		const op = (step as Record<string, unknown>).op;
		if (typeof op !== "string" || !OPS.has(op)) return `step ${index} has unknown op`;
		const rec = step as Record<string, unknown>;
		for (const key of Object.keys(rec)) {
			if (!["op", "id", "title", "body", "q", "limit"].includes(key)) return `step ${index} has unexpected key ${key}`;
			const v = rec[key];
			if (key === "limit" ? typeof v !== "number" : typeof v !== "string") return `step ${index}.${key} has wrong type`;
			if (typeof v === "string" && v.length > 2000) return `step ${index}.${key} too long`;
		}
		if ((op === "insert" || op === "update" || op === "delete") && typeof rec.id !== "string") return `step ${index} missing id`;
		if (op === "insert" && (typeof rec.title !== "string" || typeof rec.body !== "string")) return `step ${index} insert needs title/body`;
		if (op === "search" && typeof rec.q !== "string") return `step ${index} search needs q`;
	}
	return undefined;
}
