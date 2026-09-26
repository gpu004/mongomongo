import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  assertSandboxAvailable,
  containerAddress,
  dockerRunArgs,
  ensureMissionNetwork,
  killContainer,
} from "../src/sandbox.ts";

export type IsolationMode = "container" | "subprocess";

/**
 * Durable record of container names. `register` runs before `docker run` and
 * `release` after the container is stopped, so a controller that dies mid-run
 * leaves a registered-but-unreleased name that resume can find and remove.
 */
export interface ContainerRegistry {
  register(containerName: string): void;
  release(containerName: string): void;
}

/** Generates the container name; exported so resume can recognise horizon containers. */
export const CONTAINER_NAME_PREFIX = "horizon-cand-";

export interface LaunchOptions {
  snapshotDir: string;
  isolation: IsolationMode;
  /** Digest-pinned image used in container mode. */
  containerImage: string;
  /** Labels the container so orphans can be reclaimed by mission/operation on resume. */
  missionId: string;
  operationId: string;
  startupTimeoutMs: number;
  memoryLimitBytes: number;
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
 * The only place that launches candidate code. Container mode runs the sandbox
 * backend (`src/sandbox.ts`): non-root, read-only snapshot mount, no capabilities,
 * and the mission's private internal network, which the verifier reaches by
 * container address and which has no route to the public network. The runner
 * never shares its reports, fixtures, or credentials with the candidate.
 * Subprocess mode is a cooperative fallback that cannot establish evaluator
 * tamper resistance; reports record which mode produced them.
 */
export async function launchCandidate(options: LaunchOptions): Promise<RunningCandidate> {
  const entry = `${options.snapshotDir}/src/http/server.ts`;
  if (!existsSync(entry)) {
    throw new CandidateStartupError(`entry point missing: src/http/server.ts`);
  }
  if (options.isolation === "container") {
    return launchInContainer(options);
  }
  return launchSubprocess(options, entry);
}

export class CandidateStartupError extends Error {}

function launchSubprocess(options: LaunchOptions, entry: string): Promise<RunningCandidate> {
  const child = spawn(
    process.execPath,
    [`--max-old-space-size=${Math.floor(options.memoryLimitBytes / 1024 / 1024)}`, entry],
    {
      cwd: options.snapshotDir,
      env: { PATH: process.env.PATH ?? "", HOST: "127.0.0.1", PORT: "0", NODE_ENV: "candidate" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  return waitForListening(
    child,
    options.startupTimeoutMs,
    (port) => `http://127.0.0.1:${port}`,
    undefined,
    undefined,
  );
}

function launchInContainer(options: LaunchOptions): Promise<RunningCandidate> {
  assertSandboxAvailable(options.containerImage);
  const name = `${CONTAINER_NAME_PREFIX}${randomUUID().slice(0, 12)}`;
  options.containerRegistry?.register(name);
  const network = ensureMissionNetwork(options.missionId);
  const args = dockerRunArgs({
    missionId: options.missionId,
    operationId: options.operationId,
    role: "candidate",
    name,
    image: options.containerImage,
    hostDir: options.snapshotDir,
    mountPath: "/candidate",
    memoryLimitBytes: options.memoryLimitBytes,
    network: { internal: network },
    env: { HOST: "0.0.0.0", PORT: "8080", NODE_ENV: "candidate" },
    command: ["node", "src/http/server.ts"],
  });
  const child = spawn("docker", args, {
    env: { PATH: process.env.PATH ?? "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return waitForListening(
    child,
    options.startupTimeoutMs,
    (port) => `http://${containerAddress(name, network)}:${port}`,
    name,
    options.containerRegistry,
  );
}

function waitForListening(
  child: ChildProcess,
  timeoutMs: number,
  resolveBaseUrl: (port: number) => string,
  containerName: string | undefined,
  registry: ContainerRegistry | undefined,
): Promise<RunningCandidate> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      void stop().then(() =>
        reject(
          new CandidateStartupError(
            `candidate did not report listening within ${timeoutMs}ms; stderr: ${stderr.slice(-500)}`,
          ),
        ),
      );
    }, timeoutMs);

    const stop = async () => {
      clearTimeout(timer);
      let peak: number | undefined;
      if (child.pid && !containerName) {
        peak = readPeakRss(child.pid);
      }
      const exit = new Promise<{ exitCode: number | null; signal: string | null }>((done) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          done({ exitCode: child.exitCode, signal: child.signalCode });
          return;
        }
        child.once("exit", (code, signal) => done({ exitCode: code, signal }));
      });
      if (containerName) killContainer(containerName);
      child.kill("SIGTERM");
      const killTimer = setTimeout(() => child.kill("SIGKILL"), 2000);
      const result = await exit;
      clearTimeout(killTimer);
      if (containerName) registry?.release(containerName);
      return { ...result, peakMemoryBytes: peak, stderrTail: stderr.slice(-2000) };
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (settled) return;
      for (const line of stdout.split("\n")) {
        if (!line.includes('"listening"')) continue;
        try {
          const parsed = JSON.parse(line) as { listening?: boolean; port?: number };
          if (parsed.listening && typeof parsed.port === "number") {
            settled = true;
            clearTimeout(timer);
            resolve({ baseUrl: resolveBaseUrl(parsed.port), pid: child.pid, containerName, stop });
            return;
          }
        } catch {
          /* partial line */
        }
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (containerName) registry?.release(containerName);
      reject(new CandidateStartupError(`spawn failed: ${error.message}`));
    });
    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (containerName) registry?.release(containerName);
      reject(
        new CandidateStartupError(
          `candidate exited during startup with code ${code}; stderr: ${stderr.slice(-800)}`,
        ),
      );
    });
  });
}

/** Linux VmHWM (peak resident set) in bytes; undefined elsewhere. */
function readPeakRss(pid: number): number | undefined {
  try {
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    const match = /VmHWM:\s+(\d+)\s+kB/u.exec(status);
    return match ? Number(match[1]) * 1024 : undefined;
  } catch {
    return undefined;
  }
}
