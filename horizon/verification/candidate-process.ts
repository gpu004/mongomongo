import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { CandidateStartupError, createSandbox, type Sandbox, type SandboxScope } from "./sandbox.ts";

export { CandidateStartupError } from "./sandbox.ts";

export type IsolationMode = "container" | "subprocess";

export interface LaunchOptions {
	snapshotDir: string;
	isolation: IsolationMode;
	/** Digest-pinned image used in container mode. */
	containerImage: string;
	startupTimeoutMs: number;
	memoryLimitBytes: number;
	/** Labels the sandbox so restart reconciliation can find it. */
	scope?: SandboxScope;
	sandbox?: Sandbox;
}

export interface RunningCandidate {
	baseUrl: string;
	pid: number | undefined;
	containerName: string | undefined;
	stop(): Promise<{ exitCode: number | null; signal: string | null; peakMemoryBytes: number | undefined; stderrTail: string }>;
}

/**
 * The only place that launches candidate code, always through a sandbox.
 * Container mode mounts the immutable snapshot read-only on a private
 * network with no external egress; the runner never shares its reports,
 * fixtures, or credentials with the candidate. Subprocess mode is a
 * cooperative fallback that cannot establish evaluator tamper resistance;
 * reports record which mode produced them.
 */
export async function launchCandidate(options: LaunchOptions): Promise<RunningCandidate> {
	if (!existsSync(`${options.snapshotDir}/src/http/server.ts`)) {
		throw new CandidateStartupError(`entry point missing: src/http/server.ts`);
	}
	const sandbox = options.sandbox ?? createSandbox(options.isolation, options.containerImage);
	const service = await sandbox.startService({
		scope: options.scope ?? { missionId: "adhoc", operationId: `launch:${randomUUID()}` },
		snapshotDir: options.snapshotDir,
		entry: "src/http/server.ts",
		startupTimeoutMs: options.startupTimeoutMs,
		memoryLimitBytes: options.memoryLimitBytes,
	});
	return { baseUrl: service.baseUrl, pid: service.pid, containerName: service.sandboxId, stop: service.stop };
}
