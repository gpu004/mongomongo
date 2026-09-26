import { type ChildProcess, execFile, execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type SandboxKind = "docker" | "host";

/** The selected sandbox backend cannot run; callers must not fall back to host execution. */
export class SandboxUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxUnavailableError";
  }
}

export class CandidateStartupError extends Error {}

/** Every sandbox is labelled with the mission and operation that created it, so restart can find orphans. */
export interface SandboxScope {
  missionId: string;
  operationId: string;
}

export interface SandboxLimits {
  cpus: number;
  pids: number;
  tmpfsBytes: number;
  maxOutputBytes: number;
}

export const DEFAULT_LIMITS: SandboxLimits = {
  cpus: 1,
  pids: 128,
  tmpfsBytes: 64 * 1024 * 1024,
  maxOutputBytes: 1024 * 1024,
};

export interface ExecRequest {
  scope: SandboxScope;
  /** Writable candidate workspace; the only host path the command can see. */
  workspaceDir: string;
  command: string;
  args: string[];
  timeoutMs: number;
  memoryLimitBytes: number;
  signal?: AbortSignal;
}

export interface ExecOutcome {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
  aborted: boolean;
  sandboxId: string | null;
}

export interface ServiceRequest {
  scope: SandboxScope;
  /** Immutable snapshot, mounted read-only. */
  snapshotDir: string;
  /** Entry point relative to the snapshot. */
  entry: string;
  startupTimeoutMs: number;
  memoryLimitBytes: number;
  /** Container backends call this with the sandbox name before it is started. */
  beforeStart?: (sandboxId: string) => Promise<void>;
}

export interface ServiceExit {
  exitCode: number | null;
  signal: string | null;
  peakMemoryBytes: number | undefined;
  stderrTail: string;
}

export interface RunningService {
  baseUrl: string;
  pid: number | undefined;
  sandboxId: string | undefined;
  stop(): Promise<ServiceExit>;
}

export interface SandboxInfo {
  sandboxId: string;
  missionId: string;
  operationId: string;
  state: string;
}

/**
 * Where candidate code runs: lifecycle (start/stop/list/remove), command
 * execution, service startup and teardown. Files are exchanged only through
 * the workspace/snapshot directories, resolved with `resolveWorkspacePath`.
 */
export interface Sandbox {
  readonly kind: SandboxKind;
  /** Throws SandboxUnavailableError when the backend cannot run. */
  assertAvailable(): Promise<void>;
  exec(request: ExecRequest): Promise<ExecOutcome>;
  startService(request: ServiceRequest): Promise<RunningService>;
  list(missionId: string): Promise<SandboxInfo[]>;
  remove(sandboxId: string): Promise<void>;
  /** Remove every sandbox of the mission not in `keep`; returns removed ids. */
  cleanupOrphans(missionId: string, keep?: ReadonlySet<string>): Promise<string[]>;
}

// ---- filesystem containment ---------------------------------------------

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return (
    rel === "" || (!rel.startsWith("..") && !rel.split(sep).includes("..") && !rel.startsWith(sep))
  );
}

/**
 * Resolve a workspace-relative path to a host path. Rejects absolute paths,
 * traversal, node_modules, and any path whose real location (after resolving
 * symlinks on the deepest existing ancestor) is outside the workspace.
 */
export function resolveWorkspacePath(workspaceDir: string, relPath: string): string {
  if (relPath.startsWith("/") || relPath.includes("\0")) throw new Error(`path denied: ${relPath}`);
  const root = realpathSync(workspaceDir);
  const full = resolve(root, relPath);
  if (!inside(root, full)) throw new Error(`path escapes candidate workspace: ${relPath}`);
  if (relative(root, full).split(sep).includes("node_modules"))
    throw new Error(`path denied: ${relPath}`);
  let probe = full;
  for (;;) {
    try {
      lstatSync(probe);
      break;
    } catch {
      probe = dirname(probe);
    }
  }
  let real: string;
  try {
    real = realpathSync(probe);
  } catch {
    throw new Error(`path escapes candidate workspace (dangling link): ${relPath}`);
  }
  if (!inside(root, real))
    throw new Error(`path escapes candidate workspace (symlink): ${relPath}`);
  return full;
}

// ---- shared process plumbing --------------------------------------------

function collect(
  child: ChildProcess,
  maxBytes: number,
): { out: () => { stdout: string; stderr: string; truncated: boolean } } {
  const bufs = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
  const sizes = { stdout: 0, stderr: 0 };
  let truncated = false;
  const take = (stream: "stdout" | "stderr") => (chunk: Buffer) => {
    const room = maxBytes - sizes[stream];
    if (room <= 0) {
      truncated = true;
      return;
    }
    const part = chunk.length > room ? chunk.subarray(0, room) : chunk;
    if (part.length < chunk.length) truncated = true;
    bufs[stream].push(part);
    sizes[stream] += part.length;
  };
  child.stdout?.on("data", take("stdout"));
  child.stderr?.on("data", take("stderr"));
  return {
    out: () => ({
      stdout: Buffer.concat(bufs.stdout).toString("utf8"),
      stderr: Buffer.concat(bufs.stderr).toString("utf8"),
      truncated,
    }),
  };
}

function runBounded(
  child: ChildProcess,
  request: ExecRequest,
  maxBytes: number,
  kill: () => void,
  sandboxId: string | null,
): Promise<ExecOutcome> {
  const output = collect(child, maxBytes);
  return new Promise((done) => {
    let timedOut = false;
    let aborted = false;
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, request.timeoutMs);
    const onAbort = () => {
      aborted = true;
      kill();
    };
    if (request.signal?.aborted) onAbort();
    request.signal?.addEventListener("abort", onAbort, { once: true });
    const finish = (exitCode: number | null) => {
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", onAbort);
      done({ exitCode, ...output.out(), timedOut, aborted, sandboxId });
    };
    child.on("error", (error) => {
      clearTimeout(timer);
      done({
        exitCode: null,
        stdout: "",
        stderr: `spawn failed: ${error.message}`,
        truncated: false,
        timedOut,
        aborted,
        sandboxId,
      });
    });
    child.on("close", (code) => finish(code));
  });
}

function waitForListening(
  child: ChildProcess,
  timeoutMs: number,
  resolveBaseUrl: (port: number) => string,
  sandboxId: string | undefined,
  teardown: () => Promise<void>,
): Promise<RunningService> {
  return new Promise((resolvePromise, reject) => {
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

    const stop = async (): Promise<ServiceExit> => {
      clearTimeout(timer);
      const peak = child.pid && !sandboxId ? readPeakRss(child.pid) : undefined;
      const exit = new Promise<{ exitCode: number | null; signal: string | null }>((done) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          done({ exitCode: child.exitCode, signal: child.signalCode });
          return;
        }
        child.once("exit", (code, signal) => done({ exitCode: code, signal }));
      });
      await teardown();
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
            let baseUrl: string;
            try {
              baseUrl = resolveBaseUrl(parsed.port);
            } catch (error) {
              void stop().then(() =>
                reject(
                  new CandidateStartupError(
                    `could not resolve candidate address: ${error instanceof Error ? error.message : String(error)}`,
                  ),
                ),
              );
              return;
            }
            resolvePromise({ baseUrl, pid: child.pid, sandboxId, stop });
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
      void teardown().then(() =>
        reject(
          new CandidateStartupError(
            `candidate exited during startup with code ${code}; stderr: ${stderr.slice(-800)}`,
          ),
        ),
      );
    });
  });
}

/** Linux VmHWM (peak resident set) in bytes; undefined elsewhere. */
export function readPeakRss(pid: number): number | undefined {
  try {
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    const match = /VmHWM:\s+(\d+)\s+kB/u.exec(status);
    return match ? Number(match[1]) * 1024 : undefined;
  } catch {
    return undefined;
  }
}

// ---- host backend -------------------------------------------------------

/**
 * Cooperative host execution (subprocess isolation). Environment is reduced to
 * PATH; there is no filesystem or network boundary. Reports record the mode.
 */
export class HostSandbox implements Sandbox {
  readonly kind = "host" as const;
  private readonly limits: SandboxLimits;

  constructor(limits: Partial<SandboxLimits> = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
  }

  async assertAvailable(): Promise<void> {}

  exec(request: ExecRequest): Promise<ExecOutcome> {
    const executable = request.command === "node" ? process.execPath : request.command;
    const child = spawn(executable, request.args, {
      cwd: request.workspaceDir,
      env: { PATH: process.env.PATH ?? "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return runBounded(
      child,
      request,
      this.limits.maxOutputBytes,
      () => child.kill("SIGKILL"),
      null,
    );
  }

  async startService(request: ServiceRequest): Promise<RunningService> {
    const child = spawn(
      process.execPath,
      [
        `--max-old-space-size=${Math.floor(request.memoryLimitBytes / 1024 / 1024)}`,
        `${request.snapshotDir}/${request.entry}`,
      ],
      {
        cwd: request.snapshotDir,
        env: { PATH: process.env.PATH ?? "", HOST: "127.0.0.1", PORT: "0", NODE_ENV: "candidate" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    return waitForListening(
      child,
      request.startupTimeoutMs,
      (port) => `http://127.0.0.1:${port}`,
      undefined,
      async () => {},
    );
  }

  async list(): Promise<SandboxInfo[]> {
    return [];
  }

  async remove(): Promise<void> {}

  async cleanupOrphans(): Promise<string[]> {
    return [];
  }
}

// ---- docker backend -----------------------------------------------------

const DIGEST = /@sha256:[0-9a-f]{64}$/;
const LABEL = "horizon.sandbox";

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

/** Container name: derived from mission/operation (for humans), unique per launch. */
export function sandboxName(scope: SandboxScope): string {
  return `hzn-${shortHash(scope.missionId)}-${shortHash(scope.operationId).slice(0, 8)}-${randomUUID().slice(0, 6)}`;
}

export interface DockerSandboxOptions {
  /** Must be pinned by digest (`name@sha256:...`); pulled ahead of time. */
  image: string;
  limits?: Partial<SandboxLimits>;
  /** uid:gid inside the container; defaults to the controller's non-root uid, else nobody. */
  user?: string;
  docker?: string;
}

/**
 * Docker development isolation: non-root, all capabilities dropped,
 * no-new-privileges, read-only root, bounded tmpfs, CPU/memory/pid limits,
 * never pulls. Ordinary commands get `--network none`; candidate services join
 * a per-mission `--internal` network the host verifier reaches directly, with
 * no external egress. Only the candidate workspace (rw, exec) or the snapshot
 * (ro, verification) is mounted — never evaluator files, host home,
 * credentials or the Docker socket. Not a hardened boundary for hostile code.
 */
export class DockerSandbox implements Sandbox {
  readonly kind = "docker" as const;
  readonly image: string;
  private readonly limits: SandboxLimits;
  private readonly user: string;
  private readonly docker: string;

  constructor(options: DockerSandboxOptions) {
    if (!DIGEST.test(options.image))
      throw new SandboxUnavailableError(
        `container image must be pinned by digest (name@sha256:...), got "${options.image}"`,
      );
    this.image = options.image;
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
    const uid = process.getuid?.() ?? 65534;
    const gid = process.getgid?.() ?? 65534;
    this.user = options.user ?? (uid === 0 ? "65534:65534" : `${uid}:${gid}`);
    this.docker = options.docker ?? "docker";
  }

  async assertAvailable(): Promise<void> {
    try {
      await execFileAsync(this.docker, ["version", "--format", "{{.Server.Version}}"], {
        timeout: 10_000,
      });
    } catch (error) {
      throw new SandboxUnavailableError(
        `docker daemon unavailable: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`,
      );
    }
    try {
      await execFileAsync(this.docker, ["image", "inspect", "--format", "{{.Id}}", this.image], {
        timeout: 10_000,
      });
    } catch {
      throw new SandboxUnavailableError(
        `pinned image ${this.image} is not present locally; run: docker pull ${this.image}`,
      );
    }
  }

  private baseArgs(name: string, scope: SandboxScope, memoryLimitBytes: number): string[] {
    const mem = String(memoryLimitBytes);
    return [
      "run",
      "--rm",
      "--init",
      "--name",
      name,
      "--label",
      `${LABEL}=1`,
      "--label",
      `horizon.mission=${scope.missionId}`,
      "--label",
      `horizon.operation=${scope.operationId}`,
      "--pull",
      "never",
      "--user",
      this.user,
      "--read-only",
      "--tmpfs",
      `/tmp:rw,nosuid,nodev,noexec,size=${this.limits.tmpfsBytes}`,
      "--memory",
      mem,
      "--memory-swap",
      mem,
      "--cpus",
      String(this.limits.cpus),
      "--pids-limit",
      String(this.limits.pids),
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "-e",
      "HOME=/tmp",
      "-e",
      "NODE_ENV=sandbox",
    ];
  }

  private kill(name: string): Promise<void> {
    return execFileAsync(this.docker, ["rm", "-f", name], { timeout: 20_000 }).then(
      () => {},
      () => {},
    );
  }

  /** `rm -f` racing another removal can return early; wait until the container is really gone. */
  private async killAndWait(name: string): Promise<void> {
    for (let i = 0; i < 50; i += 1) {
      await this.kill(name);
      const gone = await execFileAsync(this.docker, ["inspect", "--format", "{{.Id}}", name], {
        timeout: 10_000,
      }).then(
        () => false,
        () => true,
      );
      if (gone) return;
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  exec(request: ExecRequest): Promise<ExecOutcome> {
    const name = sandboxName(request.scope);
    const workspace = realpathSync(request.workspaceDir);
    const args = [
      ...this.baseArgs(name, request.scope, request.memoryLimitBytes),
      "--network",
      "none",
      "-v",
      `${workspace}:/workspace:rw`,
      "-w",
      "/workspace",
      this.image,
      request.command,
      ...request.args,
    ];
    const child = spawn(this.docker, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: process.env.PATH ?? "" },
    });
    const kill = () => {
      void this.kill(name);
      child.kill("SIGKILL");
    };
    return runBounded(child, request, this.limits.maxOutputBytes, kill, name).then(
      async (outcome) => {
        if (outcome.timedOut || outcome.aborted) await this.killAndWait(name);
        return outcome;
      },
    );
  }

  /** Per-mission internal network: containers on it cannot reach anything outside the Docker host. */
  async ensureNetwork(missionId: string): Promise<string> {
    const network = `horizon-verify-${shortHash(missionId)}`;
    try {
      await execFileAsync(this.docker, ["network", "inspect", network], { timeout: 10_000 });
    } catch {
      await execFileAsync(
        this.docker,
        [
          "network",
          "create",
          "--internal",
          "--label",
          `${LABEL}=1`,
          "--label",
          `horizon.mission=${missionId}`,
          network,
        ],
        { timeout: 20_000 },
      ).catch(async (error: unknown) => {
        await execFileAsync(this.docker, ["network", "inspect", network], {
          timeout: 10_000,
        }).catch(() => {
          throw error;
        });
      });
    }
    return network;
  }

  async startService(request: ServiceRequest): Promise<RunningService> {
    const network = await this.ensureNetwork(request.scope.missionId);
    const name = sandboxName(request.scope);
    const snapshot = realpathSync(request.snapshotDir);
    await request.beforeStart?.(name);
    const args = [
      ...this.baseArgs(name, request.scope, request.memoryLimitBytes),
      "--network",
      network,
      "-v",
      `${snapshot}:/candidate:ro`,
      "-w",
      "/candidate",
      "-e",
      "HOST=0.0.0.0",
      "-e",
      "PORT=8080",
      this.image,
      "node",
      request.entry,
    ];
    const child = spawn(this.docker, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: process.env.PATH ?? "" },
    });
    const resolveBaseUrl = (port: number) => {
      const ip = execFileSync(
        this.docker,
        [
          "inspect",
          "--format",
          `{{(index .NetworkSettings.Networks "${network}").IPAddress}}`,
          name,
        ],
        { encoding: "utf8", timeout: 10_000 },
      ).trim();
      if (!ip) throw new Error(`container ${name} has no address on ${network}`);
      return `http://${ip}:${port}`;
    };
    return waitForListening(child, request.startupTimeoutMs, resolveBaseUrl, name, () =>
      this.kill(name),
    );
  }

  async list(missionId: string): Promise<SandboxInfo[]> {
    const { stdout } = await execFileAsync(
      this.docker,
      [
        "ps",
        "-a",
        "--filter",
        `label=${LABEL}=1`,
        "--filter",
        `label=horizon.mission=${missionId}`,
        "--format",
        '{{.Names}}\t{{.Label "horizon.mission"}}\t{{.Label "horizon.operation"}}\t{{.State}}',
      ],
      { timeout: 20_000 },
    );
    return stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [sandboxId = "", mission = "", operationId = "", state = ""] = line.split("\t");
        return { sandboxId, missionId: mission, operationId, state };
      })
      .filter((s) => s.missionId === missionId);
  }

  remove(sandboxId: string): Promise<void> {
    return this.killAndWait(sandboxId);
  }

  async cleanupOrphans(
    missionId: string,
    keep: ReadonlySet<string> = new Set(),
  ): Promise<string[]> {
    const removed: string[] = [];
    for (const info of await this.list(missionId)) {
      if (keep.has(info.sandboxId)) continue;
      await this.remove(info.sandboxId);
      removed.push(info.sandboxId);
    }
    return removed;
  }
}

export function createSandbox(
  isolation: "container" | "subprocess",
  containerImage: string,
  limits: Partial<SandboxLimits> = {},
): Sandbox {
  return isolation === "container"
    ? new DockerSandbox({ image: containerImage, limits })
    : new HostSandbox(limits);
}
