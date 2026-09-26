import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FileEvidenceStore } from "../src/mission-paths.ts";
import {
  dockerRunArgs,
  listMissionContainers,
  MISSION_LABEL,
  SANDBOX_USER,
} from "../src/sandbox.ts";
import { type BrokerHooks, ToolBroker } from "../src/tool-broker.ts";

const IMAGE = "node:24-alpine";

function dockerReady(): boolean {
  if (process.env.HORIZON_SKIP_DOCKER_TESTS === "1") return false;
  return spawnSync("docker", ["info"], { stdio: "ignore", timeout: 10_000 }).status === 0;
}

test("sandbox args: non-root, read-only, capability-less, labelled, network as requested", () => {
  const args = dockerRunArgs({
    missionId: "m1",
    role: "worker-exec",
    name: "n",
    image: IMAGE,
    hostDir: "/host/ws",
    mountPath: "/workspace",
    memoryLimitBytes: 1024,
    network: "none",
    command: ["ls", "-la"],
  });
  const joined = args.join(" ");
  assert.ok(joined.includes(`--user ${SANDBOX_USER}`));
  assert.ok(joined.includes("--read-only"));
  assert.ok(joined.includes("--cap-drop ALL"));
  assert.ok(joined.includes("--network none"));
  assert.ok(joined.includes(`--label ${MISSION_LABEL}=m1`));
  assert.ok(joined.includes("-v /host/ws:/workspace:ro"));
  assert.ok(!joined.includes("-p "));
  assert.deepEqual(args.slice(-3), [IMAGE, "ls", "-la"]);

  const published = dockerRunArgs({
    missionId: "m1",
    role: "candidate",
    name: "c",
    image: IMAGE,
    hostDir: "/snap",
    mountPath: "/candidate",
    memoryLimitBytes: 1024,
    network: "bridge",
    env: { PORT: "8080" },
    publishPort: 8080,
    command: ["node", "src/http/server.ts"],
  });
  assert.ok(published.join(" ").includes("-e PORT=8080 -p 127.0.0.1::8080"));
});

test("worker exec under container isolation runs unprivileged, offline, on a read-only workspace", async (t) => {
  if (!dockerReady()) return t.skip("docker unavailable");
  try {
    execFileSync("docker", ["image", "inspect", IMAGE], { stdio: "ignore" });
  } catch {
    execFileSync("docker", ["pull", IMAGE], { stdio: "ignore", timeout: 300_000 });
  }
  const root = mkdtempSync(join(tmpdir(), "horizon-sbx-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "a.ts"), "hello sandbox\n");
  const hooks: BrokerHooks = {
    verify: () => Promise.reject(new Error("not used")),
    profile: () => Promise.reject(new Error("not used")),
    recall: () => Promise.reject(new Error("not used")),
    proposeRegression: () => Promise.reject(new Error("not used")),
    onToolEvent: () => {},
  };
  const missionId = `sbx-${process.pid}`;
  const broker = new ToolBroker(
    root,
    new FileEvidenceStore(mkdtempSync(join(tmpdir(), "horizon-ev-"))),
    hooks,
    () => Date.now() + 120_000,
    { image: IMAGE, missionId },
  );

  const read = await broker.workspaceExec("cat", ["src/a.ts"], 60_000);
  assert.equal(read.exitCode, 0);
  assert.equal(read.stdout.trim(), "hello sandbox");

  // The allowlist forbids interpreters, so probe the container from the same argument shape
  // the broker uses: the mount is read-only and the process is not root.
  const probe = spawnSync(
    "docker",
    dockerRunArgs({
      missionId,
      role: "worker-exec",
      name: `horizon-probe-${process.pid}`,
      image: IMAGE,
      hostDir: root,
      mountPath: "/workspace",
      memoryLimitBytes: 256 * 1024 * 1024,
      network: "none",
      command: [
        "sh",
        "-c",
        "id -u; touch src/x 2>&1; wget -q -T 2 -O- http://1.1.1.1 2>&1 || echo offline",
      ],
    }),
    { encoding: "utf8", timeout: 60_000 },
  );
  const out = probe.stdout + probe.stderr;
  assert.equal(out.split("\n")[0], SANDBOX_USER.split(":")[0]);
  assert.notEqual(out.split("\n")[0], "0");
  assert.match(out, /Read-only file system/);
  assert.match(out, /offline|bad address|network is unreachable/i);

  const denied = await broker.workspaceExec("cat", ["/etc/passwd"], 60_000).catch((e: Error) => e);
  assert.ok(denied instanceof Error && /denied/.test(denied.message));
  assert.deepEqual(listMissionContainers(missionId), []);
});
