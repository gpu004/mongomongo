import { execFileSync } from "node:child_process";

/**
 * Sandbox backend shared by the tool broker (worker commands) and the verifier
 * (candidate HTTP service). Everything generated runs through `dockerRunArgs`;
 * neither caller assembles `docker run` flags itself, so the containment
 * controls cannot drift between the two paths.
 */

export const MISSION_LABEL = "horizon.mission";
export const ROLE_LABEL = "horizon.role";
export const OPERATION_LABEL = "horizon.operation";

/** Per-sandbox scratch space; small, non-executable, wiped with the container. */
const TMPFS_SPEC = "/tmp:rw,noexec,nosuid,size=64m";

/**
 * Unprivileged uid:gid used inside every sandbox container. The host user's ids are
 * reused so the read-only bind mount stays readable; a root controller falls back to
 * nobody:nogroup rather than running generated code as root.
 */
export const SANDBOX_USER = (() => {
  const uid = process.getuid?.() ?? 65534;
  const gid = process.getgid?.() ?? 65534;
  return uid === 0 ? "65534:65534" : `${uid}:${gid}`;
})();

/** Container isolation was selected but cannot be honoured; never fall back to the host silently. */
export class SandboxUnavailableError extends Error {}

export type SandboxRole = "candidate" | "worker-exec";

export interface SandboxSpec {
  missionId: string;
  /** Experiment or other operation id the container belongs to; recorded as a label for reconciliation. */
  operationId: string;
  role: SandboxRole;
  name: string;
  /** Digest-pinned image (`repo@sha256:...`). */
  image: string;
  /** Host directory bind-mounted read-only at `mountPath`. */
  hostDir: string;
  mountPath: string;
  memoryLimitBytes: number;
  /**
   * `none` detaches the container from every network (ordinary command execution).
   * `{ internal }` joins the mission's private `--internal` network: reachable from the
   * host-side verifier by container IP, no gateway, no external egress, no published ports.
   */
  network: "none" | { internal: string };
  env?: Record<string, string>;
  command: string[];
}

const DIGEST_RE = /^[a-z0-9][a-z0-9._/-]*(?::[0-9]+(?:\/[a-z0-9._-]+)*)?@sha256:[0-9a-f]{64}$/u;

/** A sandbox image must be pinned by digest; a floating tag can change under a frozen mission. */
export function isDigestPinnedImage(image: string): boolean {
  return DIGEST_RE.test(image);
}

/** Deterministic private network name for a mission. */
export function missionNetworkName(missionId: string): string {
  return `horizon-net-${missionId}`;
}

/**
 * `docker run` arguments shared by candidate services and worker commands:
 * non-root, read-only root filesystem, no capabilities, no privilege escalation,
 * bounded memory/cpu/pids, network as requested, labelled by mission and
 * operation so orphans left by a crashed controller can be found and removed.
 */
export function dockerRunArgs(spec: SandboxSpec): string[] {
  if (!isDigestPinnedImage(spec.image))
    throw new SandboxUnavailableError(
      `sandbox image must be pinned by digest (repo@sha256:...): ${spec.image}`,
    );
  const args = [
    "run",
    "--rm",
    "--name",
    spec.name,
    "--label",
    `${MISSION_LABEL}=${spec.missionId}`,
    "--label",
    `${OPERATION_LABEL}=${spec.operationId}`,
    "--label",
    `${ROLE_LABEL}=${spec.role}`,
    "--user",
    SANDBOX_USER,
    "--read-only",
    "--tmpfs",
    TMPFS_SPEC,
    "--memory",
    String(spec.memoryLimitBytes),
    "--memory-swap",
    String(spec.memoryLimitBytes),
    "--cpus",
    "1",
    "--pids-limit",
    "128",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--network",
    spec.network === "none" ? "none" : spec.network.internal,
    "-v",
    `${spec.hostDir}:${spec.mountPath}:ro`,
    "-w",
    spec.mountPath,
  ];
  for (const [key, value] of Object.entries(spec.env ?? {})) args.push("-e", `${key}=${value}`);
  args.push(spec.image, ...spec.command);
  return args;
}

function docker(args: string[], timeoutMs = 15_000): string {
  return execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: timeoutMs,
  }).trim();
}

/**
 * Fail explicitly when container isolation was selected but cannot be honoured:
 * no reachable daemon, or the pinned image is not present locally (the sandbox
 * never pulls at run time; a pull would need network and could change the image).
 */
export function assertSandboxAvailable(image: string): { serverVersion: string; imageId: string } {
  if (!isDigestPinnedImage(image))
    throw new SandboxUnavailableError(
      `containerImage must be pinned by digest (repo@sha256:...), got ${JSON.stringify(image)}`,
    );
  let serverVersion: string;
  try {
    serverVersion = docker(["version", "--format", "{{.Server.Version}}"]);
  } catch (error) {
    throw new SandboxUnavailableError(
      `container isolation selected but the Docker daemon is unreachable: ${describe(error)}`,
    );
  }
  let imageId: string;
  try {
    imageId = docker(["image", "inspect", "--format", "{{.Id}}", image]);
  } catch {
    throw new SandboxUnavailableError(
      `container isolation selected but image ${image} is not present locally; pull it before running the mission`,
    );
  }
  return { serverVersion, imageId };
}

/** Create the mission's private network if missing; `--internal` denies every route off the bridge. */
export function ensureMissionNetwork(missionId: string): string {
  const name = missionNetworkName(missionId);
  let internal: string | undefined;
  try {
    internal = docker(["network", "inspect", "--format", "{{.Internal}}", name]);
  } catch {
    /* not yet created */
  }
  if (internal !== undefined) {
    if (internal !== "true")
      throw new SandboxUnavailableError(
        `network ${name} exists but is not --internal; refusing to run the candidate with egress`,
      );
    return name;
  }
  try {
    docker(["network", "create", "--internal", "--label", `${MISSION_LABEL}=${missionId}`, name]);
  } catch (error) {
    throw new SandboxUnavailableError(
      `could not create private network ${name}: ${describe(error)}`,
    );
  }
  return name;
}

/** IPv4 address of a running container on the given network (how the verifier reaches a candidate). */
export function containerAddress(name: string, network: string): string {
  const ip = docker([
    "inspect",
    "--format",
    `{{(index .NetworkSettings.Networks "${network}").IPAddress}}`,
    name,
  ]);
  if (!/^\d+\.\d+\.\d+\.\d+$/u.test(ip))
    throw new Error(`container ${name} has no address on ${network}`);
  return ip;
}

/** Containers labelled with this mission, whatever their state. */
export function listMissionContainers(missionId: string): string[] {
  try {
    return docker(["ps", "-aq", "--filter", `label=${MISSION_LABEL}=${missionId}`])
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Remove containers (and the private network) a previous controller run left behind.
 * Called on resume before any new candidate is launched, so a stale candidate cannot
 * answer new probes and a stale worker command cannot keep running.
 */
export function cleanupOrphanContainers(missionId: string): string[] {
  const ids = listMissionContainers(missionId);
  if (ids.length > 0) {
    try {
      docker(["rm", "-f", ...ids], 60_000);
    } catch {
      /* already gone */
    }
  }
  try {
    docker(["network", "rm", missionNetworkName(missionId)]);
  } catch {
    /* never created, or still in use by a container this process did not label */
  }
  return ids;
}

/** Best-effort kill of one named container; the docker client may already be gone. */
export function killContainer(name: string): void {
  try {
    docker(["kill", name]);
  } catch {
    /* already gone */
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    const stderr = (error as Error & { stderr?: string }).stderr;
    return stderr && stderr.trim().length > 0 ? stderr.trim().split("\n")[0]! : error.message;
  }
  return String(error);
}
