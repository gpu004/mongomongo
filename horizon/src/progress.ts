import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MissionConfig } from "./mission-contract.ts";
import type { ExperimentRow, LessonRow, MissionRow, SegmentRow, TaskRow, VerificationRow } from "./ledger.ts";
import type { LearnedScenarioRow, LedgerStore } from "./ledger-store.ts";
import type { MissionPaths } from "./mission-paths.ts";
import { writeJsonAtomic } from "./mission-paths.ts";

export interface MissionSummary {
	mission: MissionRow | undefined;
	target: { baselineP95Ms: number | null; requiredP95Ms: number | null; bestP95Ms: number | null; reached: boolean };
	tasks: TaskRow[];
	experiments: ExperimentRow[];
	verifications: VerificationRow[];
	lessons: LessonRow[];
	learnedScenarios: LearnedScenarioRow[];
	episodes: number;
	outbox: Record<string, number>;
	checkpoints: number;
	segments: SegmentRow[];
	ledger: { backend: string; location: string };
	isolation: { configured: string; observed: string[] };
	unmet: string[];
}

export async function summarize(ledger: LedgerStore, config: MissionConfig): Promise<MissionSummary> {
	const mission = await ledger.getMission(config.missionId);
	const verifications = await ledger.listVerifications(config.missionId);
	const required = mission?.baselineP95Ms != null ? mission.baselineP95Ms * (1 - config.targetP95Reduction) : null;
	const reached = required !== null && mission?.bestP95Ms != null && mission.bestP95Ms <= required;
	const outbox: Record<string, number> = {};
	for (const row of (await ledger.listOutbox())) outbox[row.state] = (outbox[row.state] ?? 0) + 1;
	const observedIsolation = [...new Set(verifications.map((v) => reportIsolation(v.path)).filter((x): x is string => x !== undefined))];
	const tasks = await ledger.listTasks(config.missionId);
	const unmet: string[] = [];
	if (!reached) unmet.push(`target p95 reduction ${config.targetP95Reduction * 100}% not reached (best ${mission?.bestP95Ms ?? "n/a"}ms vs required ${required?.toFixed(2) ?? "n/a"}ms)`);
	if (tasks.find((t) => t.taskId === "holdout")?.status !== "done") unmet.push("holdout not passed on the chosen artifact");
	if (config.isolation === "container" && observedIsolation.some((i) => i !== "container")) unmet.push("some verifications ran under weaker subprocess isolation");
	if (config.isolation === "subprocess") unmet.push("isolation is cooperative subprocess mode, not the container target");
	if ((await ledger.listLessons(config.missionId)).filter((l) => l.state === "materialized").length === 0) unmet.push("no correction materialized as a learned regression yet");
	if ((outbox.pending ?? 0) + (outbox.failed ?? 0) + (outbox.submitted ?? 0) > 0) unmet.push("memory delivery incomplete for some episodes");
	return {
		mission,
		target: { baselineP95Ms: mission?.baselineP95Ms ?? null, requiredP95Ms: required, bestP95Ms: mission?.bestP95Ms ?? null, reached },
		tasks,
		experiments: (await ledger.listExperiments(config.missionId)),
		verifications,
		lessons: (await ledger.listLessons(config.missionId)),
		learnedScenarios: (await ledger.listLearnedScenarios(config.missionId)),
		episodes: (await ledger.listEpisodes(config.missionId)).length,
		outbox,
		checkpoints: (await ledger.countCheckpoints(config.missionId)),
		segments: (await ledger.listSegments(config.missionId)),
		ledger: { backend: ledger.backend, location: ledger.location },
		isolation: { configured: config.isolation, observed: observedIsolation },
		unmet,
	};
}

function reportIsolation(path: string): string | undefined {
	if (!existsSync(path)) return undefined;
	try {
		return (JSON.parse(readFileSync(path, "utf8")) as { isolation?: string }).isolation;
	} catch {
		return undefined;
	}
}

export function renderProgress(s: MissionSummary): string {
	const m = s.mission;
	if (!m) return "mission not initialized";
	const lines: string[] = [];
	lines.push(`Mission ${m.missionId}  status=${m.status}  contract=${m.contractHash.slice(0, 12)} evaluator=${m.evaluatorHash.slice(0, 12)} env=${m.environmentHash.slice(0, 12)}`);
	lines.push(`Goal: baseline p95 ${fmt(s.target.baselineP95Ms)} -> required ${fmt(s.target.requiredP95Ms)}; best ${fmt(s.target.bestP95Ms)} (${(m.bestArtifactHash ?? "").slice(0, 12)}) ${s.target.reached ? "REACHED" : "not reached"}`);
	lines.push(`Budget: experiments ${m.spentExperiments}, tokens in/out ${m.spentInputTokens}/${m.spentOutputTokens}${m.usageUncertain ? " (estimated)" : ""}, memory ops ${m.spentMemoryOperations}, wall ${(m.spentWallMs / 1000).toFixed(0)}s`);
	lines.push(`Ledger: ${s.ledger.backend} ${s.ledger.location}`);
	lines.push(`Durability: ${s.checkpoints} checkpoints, ${s.segments.length} segments (${s.segments.filter((x) => x.committed).length} committed), episodes ${s.episodes}, outbox ${Object.entries(s.outbox).map(([k, v]) => `${k}=${v}`).join(" ") || "empty"}`);
	lines.push(`Isolation: configured ${s.isolation.configured}; observed ${s.isolation.observed.join(",") || "none yet"}`);
	lines.push("Tasks:");
	for (const t of s.tasks) lines.push(`  [${t.status.padEnd(7)}] ${t.taskId}: ${t.completionCriteria}`);
	lines.push("Experiments:");
	for (const e of s.experiments) {
		const perf = s.verifications.find((v) => v.experimentId === e.experimentId && v.suite === "performance" && v.status === "passed");
		lines.push(`  ${e.experimentId.padEnd(22)} ${e.status.padEnd(13)} ${perf ? `p95=${perf.p95LatencyMs}ms ` : ""}${e.verdict ?? ""}`);
	}
	if (s.lessons.length > 0) {
		lines.push("Lessons:");
		for (const l of s.lessons) lines.push(`  ${l.lessonId}: ${l.transitions.map((t) => t.state).join(" -> ")}${l.materializedScenarioId ? ` => ${l.materializedScenarioId}` : ""}`);
	}
	if (s.unmet.length > 0) {
		lines.push("Unmet:");
		for (const u of s.unmet) lines.push(`  - ${u}`);
	}
	return lines.join("\n");
}

function fmt(v: number | null): string {
	return v === null ? "n/a" : `${v.toFixed(2)}ms`;
}

/** Writes summary.json and summary.md into exports/; reports and evidence are referenced by path, not copied. */
export async function exportMission(ledger: LedgerStore, config: MissionConfig, paths: MissionPaths): Promise<{ json: string; markdown: string }> {
	const summary = await summarize(ledger, config);
	const json = join(paths.exports, "summary.json");
	const markdown = join(paths.exports, "summary.md");
	writeJsonAtomic(json, {
		exportedAt: new Date().toISOString(),
		...summary,
		reportsDir: paths.reports,
		evidenceDir: paths.evidence,
		evidenceFiles: existsSync(paths.evidence) ? statSync(paths.evidence).isDirectory() : false,
	});
	const md = [
		`# Horizon mission ${config.missionId}`,
		"",
		"```",
		renderProgress(summary),
		"```",
		"",
		"## Verification reports",
		"",
		...summary.verifications.map((v) => `- ${v.suite} ${v.status} artifact ${v.artifactHash.slice(0, 12)} ${v.p95LatencyMs !== null ? `p95=${v.p95LatencyMs}ms ` : ""}(${v.reportId}) ${v.path}`),
		"",
		"## Learned scenarios",
		"",
		...(summary.learnedScenarios.length > 0 ? summary.learnedScenarios.map((l) => `- ${l.scenarioId} from ${l.lessonId} (suite v${l.suiteVersion}) ${l.path}`) : ["- none"]),
		"",
	].join("\n");
	writeFileSync(`${markdown}.tmp`, md);
	renameSync(`${markdown}.tmp`, markdown);
	return { json, markdown };
}
