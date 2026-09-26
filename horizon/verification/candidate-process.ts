import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  CandidateStartupError,
  createSandbox,
  type Sandbox,
  type SandboxScope,
} from "./sandbox.ts";

export { CandidateStartupError } from "./sandbox.ts";

export type IsolationMode = "container" | "subprocess";

/**
 * Durable record of container names. `register` runs before `docker run` and
 * `release` after the container is stopped, so a controller that dies mid-run
 * leaves a registered-but-unreleased name that resume can find and remove.
 */
export interface ContainerRegistry {
  register(containerName: string): Promise<void>;
  release(containerName: string): Promise<void>;
}

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
  /** Container mode only; subprocess children die with the controller and need no record. */
  containerRegistry?: ContainerRegistry | undefined;
}

export interface RunningCandidate {
  baseUrl: string;
  pid: number | undefined;
  containerName: string | undefined;
  stop(): Promise<{
    exitCode: number | null;
    signal: string | null;
    peakMemoryBytes: number | undefined;
    stderrTail: string;
  }>;
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
  const registry = options.containerRegistry;
  let registered: string | undefined;
  let service;
  try {
    service = await sandbox.startService({
      scope: options.scope ?? { missionId: "adhoc", operationId: `launch:${randomUUID()}` },
      snapshotDir: options.snapshotDir,
      entry: "src/http/server.ts",
      startupTimeoutMs: options.startupTimeoutMs,
      memoryLimitBytes: options.memoryLimitBytes,
      ...(registry
        ? {
            beforeStart: async (sandboxId: string) => {
              await registry.register(sandboxId);
              registered = sandboxId;
            },
          }
        : {}),
    });
  } catch (error) {
    if (registered) await registry?.release(registered);
    throw error;
  }
  const stop = service.stop;
  return {
    baseUrl: service.baseUrl,
    pid: service.pid,
    containerName: service.sandboxId,
    stop: async () => {
      const exit = await stop();
      if (registered) await registry?.release(registered);
      return exit;
    },
  };
}
