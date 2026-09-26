import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

export type IsolationMode = "container" | "subprocess";

export interface LaunchOptions {
  snapshotDir: string;
  isolation: IsolationMode;
  /** Pinned image used in container mode. */
  containerImage: string;
  startupTimeoutMs: number;
  memoryLimitBytes: number;
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
 * The only place that launches candidate code. Container mode mounts the
 * immutable snapshot read-only and exposes one port on loopback; the runner
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
  );
}

function launchInContainer(options: LaunchOptions): Promise<RunningCandidate> {
  const name = `horizon-cand-${randomUUID().slice(0, 12)}`;
  const args = [
    "run",
    "--rm",
    "--name",
    name,
    "--read-only",
    "--tmpfs",
    "/tmp",
    "--memory",
    String(options.memoryLimitBytes),
    "--cpus",
    "1",
    "--pids-limit",
    "128",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "-v",
    `${options.snapshotDir}:/candidate:ro`,
    "-w",
    "/candidate",
    "-e",
    "HOST=0.0.0.0",
    "-e",
    "PORT=8080",
    "-p",
    "127.0.0.1::8080",
    options.containerImage,
    "node",
    "src/http/server.ts",
  ];
  const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
  return waitForListening(
    child,
    options.startupTimeoutMs,
    () => {
      const mapped =
        execFileSync("docker", ["port", name, "8080/tcp"], { encoding: "utf8" })
          .trim()
          .split("\n")[0] ?? "";
      const port = mapped.split(":").pop();
      return `http://127.0.0.1:${port}`;
    },
    name,
  );
}

function waitForListening(
  child: ChildProcess,
  timeoutMs: number,
  resolveBaseUrl: (port: number) => string,
  containerName: string | undefined,
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
      if (containerName) {
        try {
          execFileSync("docker", ["kill", containerName], { stdio: "ignore" });
        } catch {
          /* already gone */
        }
      }
      child.kill("SIGTERM");
      const killTimer = setTimeout(() => child.kill("SIGKILL"), 2000);
      const result = await exit;
      clearTimeout(killTimer);
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
      reject(new CandidateStartupError(`spawn failed: ${error.message}`));
    });
    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
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
