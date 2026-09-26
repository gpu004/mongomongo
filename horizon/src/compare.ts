import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { MissionController, SimulatedCrash } from "./controller.ts";
import { LocalMemoryAdapter } from "./memory-adapter.ts";
import type { MissionConfig } from "./mission-contract.ts";
import { missionPaths, writeJsonAtomic } from "./mission-paths.ts";
import { ScriptedWorker } from "./scripted-worker.ts";
import type { Worker } from "./worker.ts";

/** The three configurations from the plan, differing only in memory features. */
export const CONFIGURATIONS = ["durable-only", "durable+retrieval", "durable+retrieval+correction"] as const;
export type Configuration = (typeof CONFIGURATIONS)[number];

export interface InterruptionStep {
	/** Crash point passed to the controller for this launch; null runs to completion (or maxCycles). */
	crashAt: string | null;
	maxCycles?: number;
}

export interface CompareOptions {
	runsRoot: string;
	base: MissionConfig;
	/** Same schedule applied to every configuration: each entry is one controller launch. */
	interruptions: InterruptionStep[];
	repeats: number;
	workerFactory?: (configuration: Configuration) => Worker;
	log?: (line: string) => void;
}

export interface MissionMeasurement {
	configuration: Configuration;
	missionId: string;
	status: string;
	targetReached: boolean;
	baselineP95Ms: number | null;
	bestP95Ms: number | null;
	experiments: number;
	rejected: number;
	repeatedFailures: number;
	crashes: number;
	recoveries: number;
	retrievalInjected: number;
	retrievalFilteredOut: number;
	maxPacketTokens: number;
	memoryOperations: number;
	inputTokens: number;
	outputTokens: number;
	usageUncertain: boolean;
	materializedChecks: number;
	wallMs: number;
}

export interface CompareResult {
	schedule: InterruptionStep[];
	seedHash: string | null;
	evaluatorHash: string | null;
	measurements: MissionMeasurement[];
}

function configure(base: MissionConfig, configuration: Configuration, missionId: string): MissionConfig {
	const enabled = configuration !== "durable-only";
	return {
		...base,
		missionId,
		worker: "scripted",
		memory: { ...base.memory, enabled, containerTag: `horizon-${missionId}`, materializeCorrections: configuration === "durable+retrieval+correction" },
	};
}

/**
 * Runs each configuration from the same seed, workload, evaluator and
 * interruption schedule in a fresh mission with its own memory scope, and
 * counts the whole system: experiments, retries, retrieval, memory operations,
 * tokens and wall time. Retrieval and correction costs are included.
 */
export async function compareConfigurations(options: CompareOptions): Promise<CompareResult> {
	const log = options.log ?? (() => {});
	const measurements: MissionMeasurement[] = [];
	let seedHash: string | null = null;
	let evaluatorHash: string | null = null;
	for (let repeat = 0; repeat < options.repeats; repeat += 1) {
		for (const configuration of CONFIGURATIONS) {
			const missionId = `cmp-${configuration.replace(/[^a-z]+/g, "-")}-${repeat + 1}`;
			const config = configure(options.base, configuration, missionId);
			const paths = missionPaths(missionId, options.runsRoot);
			const memory = new LocalMemoryAdapter();
			const worker = options.workerFactory?.(configuration) ?? new ScriptedWorker();
			const started = Date.now();
			let crashes = 0;
			log(`== ${missionId}`);
			for (const step of options.interruptions) {
				const controller = new MissionController(config, paths, { worker, memory, log: (l) => log(`   ${l}`), ...(step.crashAt ? { crashAt: step.crashAt } : {}), ...(step.maxCycles !== undefined ? { maxCycles: step.maxCycles } : {}) });
				try {
					controller.initialize();
					await controller.run();
				} catch (error) {
					if (!(error instanceof SimulatedCrash)) throw error;
					crashes += 1;
					log(`   ${error.message}`);
				} finally {
					controller.close();
				}
			}
			const controller = new MissionController(config, paths, { worker, memory, log: () => {} });
			try {
				const mission = controller.mission();
				seedHash = mission.seedArtifactHash;
				evaluatorHash = mission.evaluatorHash;
				const experiments = controller.ledger.listExperiments(missionId).filter((e) => e.taskId === "optimize-search");
				const signatures = experiments.map((e) => e.failureSignature).filter((s): s is string => s !== null);
				const repeatedFailures = signatures.length - new Set(signatures).size;
				const events = controller.ledger.eventsSince(0, 100000);
				const packets = events.filter((e) => e.type === "packet.built").map((e) => e.payload as { tokens: number; injected: string[]; filteredOut: unknown[] });
				const required = mission.baselineP95Ms !== null ? mission.baselineP95Ms * (1 - config.targetP95Reduction) : null;
				measurements.push({
					configuration,
					missionId,
					status: mission.status,
					targetReached: required !== null && mission.bestP95Ms !== null && mission.bestP95Ms <= required,
					baselineP95Ms: mission.baselineP95Ms,
					bestP95Ms: mission.bestP95Ms,
					experiments: experiments.length,
					rejected: experiments.filter((e) => e.status === "rejected").length,
					repeatedFailures,
					crashes,
					recoveries: events.filter((e) => e.type === "controller.recovered").length,
					retrievalInjected: packets.reduce((n, p) => n + p.injected.length, 0),
					retrievalFilteredOut: packets.reduce((n, p) => n + p.filteredOut.length, 0),
					maxPacketTokens: packets.reduce((n, p) => Math.max(n, p.tokens), 0),
					memoryOperations: mission.spentMemoryOperations,
					inputTokens: mission.spentInputTokens,
					outputTokens: mission.spentOutputTokens,
					usageUncertain: mission.usageUncertain !== 0,
					materializedChecks: controller.ledger.listLearnedScenarios(missionId).length,
					wallMs: Date.now() - started,
				});
			} finally {
				controller.close();
			}
		}
	}
	const result: CompareResult = { schedule: options.interruptions, seedHash, evaluatorHash, measurements };
	writeJsonAtomic(join(options.runsRoot, "comparison.json"), result);
	writeFileSync(join(options.runsRoot, "comparison.md"), renderComparison(result));
	return result;
}

export function renderComparison(result: CompareResult): string {
	const cols: [string, (m: MissionMeasurement) => string][] = [
		["configuration", (m) => m.configuration],
		["status", (m) => m.status],
		["target", (m) => (m.targetReached ? "reached" : "missed")],
		["baseline p95", (m) => fmt(m.baselineP95Ms)],
		["best p95", (m) => fmt(m.bestP95Ms)],
		["experiments", (m) => String(m.experiments)],
		["rejected", (m) => String(m.rejected)],
		["repeated failures", (m) => String(m.repeatedFailures)],
		["crashes/recoveries", (m) => `${m.crashes}/${m.recoveries}`],
		["retrieved (injected/filtered)", (m) => `${m.retrievalInjected}/${m.retrievalFilteredOut}`],
		["max packet tokens", (m) => String(m.maxPacketTokens)],
		["memory ops", (m) => String(m.memoryOperations)],
		["tokens in/out", (m) => `${m.inputTokens}/${m.outputTokens}${m.usageUncertain ? "*" : ""}`],
		["materialized checks", (m) => String(m.materializedChecks)],
		["wall ms", (m) => String(m.wallMs)],
	];
	const header = `| ${cols.map(([name]) => name).join(" | ")} |`;
	const sep = `| ${cols.map(() => "---").join(" | ")} |`;
	const rows = result.measurements.map((m) => `| ${cols.map(([, f]) => f(m)).join(" | ")} |`);
	return [
		"# Configuration comparison",
		"",
		`Seed ${result.seedHash?.slice(0, 12) ?? "?"}, evaluator ${result.evaluatorHash?.slice(0, 12) ?? "?"}; identical workload and interruption schedule: ${JSON.stringify(result.schedule)}.`,
		"Scripted worker, local memory adapter. `*` marks estimated token usage (no provider usage report).",
		"",
		header,
		sep,
		...rows,
		"",
		`Runs per configuration: ${result.measurements.length / CONFIGURATIONS.length}. Small samples: treat differences of one experiment as suggestive, not significant.`,
	].join("\n");
}

function fmt(n: number | null): string {
	return n === null ? "n/a" : `${n.toFixed(3)}ms`;
}
