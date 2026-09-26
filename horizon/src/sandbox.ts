import { execFileSync } from "node:child_process";

export const MISSION_LABEL = "horizon.mission";
export const ROLE_LABEL = "horizon.role";
/**
 * Unprivileged uid:gid used inside every sandbox container. The host user's ids are
 * reused so the read-only bind mount stays readable; a root controller falls back to
 * nobody:nogroup rather than running candidate code as root.
 */
export const SANDBOX_USER = (() => {
  const uid = process.getuid?.() ?? 65534;
  const gid = process.getgid?.() ?? 65534;
  return uid === 0 ? "65534:65534" : `${uid}:${gid}`;
})();

export type SandboxRole = "candidate" | "worker-exec";

export interface SandboxSpec {
  missionId: string;
  role: SandboxRole;
  name: string;
  image: string;
  /** Host directory bind-mounted read-only at `mountPath`. */
  hostDir: string;
  mountPath: string;
  memoryLimitBytes: number;
  /** `none` isolates the container from every network; `bridge` allows one published loopback port. */
  network: "none" | "bridge";
  env?: Record<string, string>;
  publishPort?: number;
  command: string[];
}

/**
 * `docker run` arguments shared by candidate services and worker commands:
 * non-root, read-only root filesystem, no capabilities, bounded memory/cpu/pids,
 * labelled by mission so orphans left by a crashed controller can be found.
 */
export function dockerRunArgs(spec: SandboxSpec): string[] {
  const args = [
    "run",
    "--rm",
    "--name",
    spec.name,
    "--label",
    `${MISSION_LABEL}=${spec.missionId}`,
    "--label",
    `${ROLE_LABEL}=${spec.role}`,
    "--user",
    SANDBOX_USER,
    "--read-only",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,size=64m",
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
    spec.network,
    "-v",
    `${spec.hostDir}:${spec.mountPath}:ro`,
    "-w",
    spec.mountPath,
  ];
  for (const [key, value] of Object.entries(spec.env ?? {})) args.push("-e", `${key}=${value}`);
  if (spec.publishPort !== undefined) args.push("-p", `127.0.0.1::${spec.publishPort}`);
  args.push(spec.image, ...spec.command);
  return args;
}

/** Containers labelled with this mission that are still running. */
export function listMissionContainers(missionId: string): string[] {
  try {
    return execFileSync("docker", ["ps", "-q", "--filter", `label=${MISSION_LABEL}=${missionId}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Kill containers a previous controller run left behind. Called on resume, before
 * any new candidate is launched, so a stale candidate cannot answer new probes.
 */
export function cleanupOrphanContainers(missionId: string): string[] {
  const ids = listMissionContainers(missionId);
  if (ids.length === 0) return ids;
  try {
    execFileSync("docker", ["rm", "-f", ...ids], { stdio: "ignore" });
  } catch {
    /* already gone */
  }
  return ids;
}

/** Best-effort kill of one named container; the docker client may already be gone. */
export function killContainer(name: string): void {
  try {
    execFileSync("docker", ["kill", name], { stdio: "ignore" });
  } catch {
    /* already gone */
  }
}
