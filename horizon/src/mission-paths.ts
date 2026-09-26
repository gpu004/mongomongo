import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson, sha256 } from "../verification/reports.ts";
import type { EvidenceSink } from "../verification/runner.ts";

export const RUNS_ROOT = new URL("../runs/", import.meta.url).pathname;

export interface MissionPaths {
	root: string;
	db: string;
	manifest: string;
	candidate: string;
	artifacts: string;
	reports: string;
	evidence: string;
	sessions: string;
	exports: string;
	learnedScenarios: string;
}

export function missionPaths(missionId: string, runsRoot = RUNS_ROOT): MissionPaths {
	const root = join(runsRoot, missionId);
	return {
		root,
		db: join(root, "state.sqlite"),
		manifest: join(root, "manifest.json"),
		candidate: join(root, "candidate"),
		artifacts: join(root, "artifacts"),
		reports: join(root, "reports"),
		evidence: join(root, "evidence"),
		sessions: join(root, "sessions"),
		exports: join(root, "exports"),
		learnedScenarios: join(root, "learned-scenarios"),
	};
}

export function ensureMissionDirs(paths: MissionPaths): void {
	for (const dir of [paths.root, paths.candidate, paths.artifacts, paths.reports, paths.evidence, paths.sessions, paths.exports, paths.learnedScenarios]) {
		mkdirSync(dir, { recursive: true });
	}
}

/** Write JSON to a temp file then rename, so a reader never sees a partial file. */
export function writeJsonAtomic(path: string, value: unknown): void {
	const tmp = `${path}.tmp-${process.pid}`;
	writeFileSync(tmp, JSON.stringify(value, null, 2));
	renameSync(tmp, path);
}

/**
 * Content-addressed evidence files. Raw request/response logs, timing samples
 * and process exits live here; reports and memory only carry evidence IDs.
 */
export class FileEvidenceStore implements EvidenceSink {
	readonly dir: string;

	constructor(dir: string) {
		this.dir = dir;
		mkdirSync(dir, { recursive: true });
	}

	write(kind: string, payload: unknown): string {
		const body = canonicalJson({ kind, payload });
		const id = `ev-${kind.replace(/[^a-z0-9-]/gi, "-")}-${sha256(body).slice(0, 16)}`;
		const path = join(this.dir, `${id}.json`);
		if (!existsSync(path)) writeJsonAtomic(path, { evidenceId: id, kind, payload });
		return id;
	}

	/** Bounded host lookup: only IDs of this exact shape are resolvable; no path traversal. */
	read(evidenceId: string, maxChars = 4000): { evidenceId: string; excerpt: string; truncated: boolean } | undefined {
		if (!/^ev-[a-z0-9-]+-[0-9a-f]{16}$/i.test(evidenceId)) return undefined;
		const path = join(this.dir, `${evidenceId}.json`);
		if (!existsSync(path)) return undefined;
		const text = readFileSync(path, "utf8");
		return { evidenceId, excerpt: text.slice(0, maxChars), truncated: text.length > maxChars };
	}

	has(evidenceId: string): boolean {
		return /^ev-[a-z0-9-]+-[0-9a-f]{16}$/i.test(evidenceId) && existsSync(join(this.dir, `${evidenceId}.json`));
	}
}
