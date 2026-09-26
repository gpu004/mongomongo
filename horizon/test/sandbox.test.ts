import assert from "node:assert/strict";
import { test } from "node:test";
import { loadMissionConfig, validateMissionConfig } from "../src/mission-contract.ts";
import {
  MISSION_LABEL,
  OPERATION_LABEL,
  ROLE_LABEL,
  SANDBOX_USER,
  SandboxUnavailableError,
  assertSandboxAvailable,
  dockerRunArgs,
  isDigestPinnedImage,
  missionNetworkName,
  type SandboxSpec,
} from "../src/sandbox.ts";
import { EXAMPLE_CONFIG } from "./helpers.ts";

const PINNED = `node@sha256:${"a".repeat(64)}`;

function spec(overrides: Partial<SandboxSpec> = {}): SandboxSpec {
  return {
    missionId: "m1",
    operationId: "exp-7",
    role: "worker-exec",
    name: "horizon-exec-test",
    image: PINNED,
    hostDir: "/host/candidate",
    mountPath: "/workspace",
    memoryLimitBytes: 256 * 1024 * 1024,
    network: "none",
    command: ["ls", "src"],
    ...overrides,
  };
}

function flag(args: string[], name: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i++) if (args[i] === name) values.push(args[i + 1]!);
  return values;
}

test("sandbox: only digest-pinned image references are accepted", () => {
  assert.equal(isDigestPinnedImage(PINNED), true);
  assert.equal(isDigestPinnedImage(`mirror.gcr.io/library/node@sha256:${"0".repeat(64)}`), true);
  assert.equal(isDigestPinnedImage(`localhost:5000/node@sha256:${"f".repeat(64)}`), true);
  assert.equal(isDigestPinnedImage("node:24-alpine"), false);
  assert.equal(isDigestPinnedImage("node"), false);
  assert.equal(isDigestPinnedImage(`node@sha256:${"a".repeat(63)}`), false);
  assert.equal(isDigestPinnedImage(`node@sha1:${"a".repeat(64)}`), false);
  assert.equal(isDigestPinnedImage(""), false);
  assert.throws(() => dockerRunArgs(spec({ image: "node:24-alpine" })), SandboxUnavailableError);
  assert.throws(
    () => assertSandboxAvailable("node:24-alpine"),
    (e: unknown) => e instanceof SandboxUnavailableError && /pinned by digest/.test(e.message),
  );
});

test("sandbox: docker run is non-root, capability-less, read-only, bounded and labelled", () => {
  const args = dockerRunArgs(spec());
  assert.equal(args[0], "run");
  assert.ok(args.includes("--rm"));
  assert.deepEqual(flag(args, "--user"), [SANDBOX_USER]);
  assert.notEqual(SANDBOX_USER.split(":")[0], "0", "sandbox must never run as uid 0");
  assert.ok(args.includes("--read-only"));
  assert.deepEqual(flag(args, "--cap-drop"), ["ALL"]);
  assert.deepEqual(flag(args, "--security-opt"), ["no-new-privileges"]);
  assert.deepEqual(flag(args, "--memory"), [String(256 * 1024 * 1024)]);
  assert.deepEqual(flag(args, "--memory-swap"), [String(256 * 1024 * 1024)], "no swap headroom");
  assert.deepEqual(flag(args, "--cpus"), ["1"]);
  assert.deepEqual(flag(args, "--pids-limit"), ["128"]);
  assert.match(flag(args, "--tmpfs")[0]!, /^\/tmp:.*noexec.*size=/);
  assert.deepEqual(
    flag(args, "-v"),
    ["/host/candidate:/workspace:ro"],
    "only the candidate dir, read-only",
  );
  assert.deepEqual(flag(args, "-w"), ["/workspace"]);
  assert.ok(!args.some((a) => a.includes("docker.sock")), "docker socket never mounted");
  assert.ok(!args.includes("--privileged"));
  assert.ok(!args.includes("-p") && !args.includes("--publish"), "no port publication");
  assert.deepEqual(flag(args, "--label").sort(), [
    `${MISSION_LABEL}=m1`,
    `${OPERATION_LABEL}=exp-7`,
    `${ROLE_LABEL}=worker-exec`,
  ]);
  // image then command, nothing after
  assert.deepEqual(args.slice(args.indexOf(PINNED)), [PINNED, "ls", "src"]);
});

test("sandbox: ordinary execution has no network; candidates get the mission's internal network", () => {
  assert.deepEqual(flag(dockerRunArgs(spec()), "--network"), ["none"]);
  const net = missionNetworkName("m1");
  const candidate = dockerRunArgs(
    spec({
      role: "candidate",
      network: { internal: net },
      env: { HOST: "0.0.0.0", PORT: "8080" },
      command: ["node", "src/http/server.ts"],
    }),
  );
  assert.deepEqual(flag(candidate, "--network"), [net]);
  assert.deepEqual(flag(candidate, "-e").sort(), ["HOST=0.0.0.0", "PORT=8080"]);
  assert.ok(
    !candidate.some((a) => /API_KEY|TOKEN|SECRET|HOME=/.test(a)),
    "no host credentials passed",
  );
});

test("sandbox: an unreachable Docker daemon fails explicitly instead of falling back to the host", () => {
  const previous = process.env.DOCKER_HOST;
  process.env.DOCKER_HOST = "tcp://127.0.0.1:1";
  try {
    assert.throws(
      () => assertSandboxAvailable(PINNED),
      (e: unknown) =>
        e instanceof SandboxUnavailableError && /Docker daemon is unreachable/.test(e.message),
    );
  } finally {
    if (previous === undefined) delete process.env.DOCKER_HOST;
    else process.env.DOCKER_HOST = previous;
  }
});

test("mission contract: container isolation requires a digest-pinned image", () => {
  const example = loadMissionConfig(EXAMPLE_CONFIG);
  assert.ok(isDigestPinnedImage(example.containerImage), "example config ships a pinned image");
  assert.throws(
    () =>
      validateMissionConfig({
        ...example,
        isolation: "container",
        containerImage: "node:24-alpine",
      }),
    /pinned by digest/,
  );
  assert.doesNotThrow(() =>
    validateMissionConfig({ ...example, isolation: "container", containerImage: PINNED }),
  );
  assert.doesNotThrow(() =>
    validateMissionConfig({ ...example, isolation: "subprocess", containerImage: "" }),
  );
});
