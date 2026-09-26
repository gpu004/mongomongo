import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  DockerSandbox,
  HostSandbox,
  resolveWorkspacePath,
  SandboxUnavailableError,
} from "../verification/sandbox.ts";
import { ToolBroker } from "../src/tool-broker.ts";
import { FileEvidenceStore } from "../src/mission-paths.ts";

function workspace(): { root: string; ws: string; outside: string } {
  const root = mkdtempSync(join(tmpdir(), "horizon-sbx-"));
  const ws = join(root, "ws");
  const outside = join(root, "outside");
  mkdirSync(join(ws, "src"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(ws, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(outside, "secret.txt"), "evaluator-only\n");
  return { root, ws, outside };
}

test("workspace paths: traversal, absolute, node_modules, symlink and dangling-link escapes are rejected", () => {
  const { ws, outside } = workspace();
  symlinkSync(outside, join(ws, "escape"));
  symlinkSync(join(outside, "secret.txt"), join(ws, "src", "leak.ts"));
  symlinkSync(join(outside, "missing"), join(ws, "dangling"));
  assert.equal(resolveWorkspacePath(ws, "src/a.ts").endsWith("src/a.ts"), true);
  assert.equal(resolveWorkspacePath(ws, "src/new/file.ts").endsWith("src/new/file.ts"), true);
  assert.throws(() => resolveWorkspacePath(ws, "../outside/secret.txt"), /escapes/);
  assert.throws(() => resolveWorkspacePath(ws, "/etc/passwd"), /denied/);
  assert.throws(() => resolveWorkspacePath(ws, "node_modules/x.js"), /denied/);
  assert.throws(() => resolveWorkspacePath(ws, "escape/secret.txt"), /symlink/);
  assert.throws(() => resolveWorkspacePath(ws, "src/leak.ts"), /symlink/);
  assert.throws(() => resolveWorkspacePath(ws, "dangling/x"), /escapes/);
});

test("broker: reads and writes through a symlink out of the workspace are refused", () => {
  const { root, ws, outside } = workspace();
  symlinkSync(outside, join(ws, "escape"));
  const hooks = {
    verify: async () => {
      throw new Error("n/a");
    },
    profile: async () => ({ evidenceId: "", summary: "" }),
    recall: async () => [],
    proposeRegression: async () => ({ accepted: false, reason: "" }),
    onToolEvent: () => {},
  };
  const broker = new ToolBroker(
    ws,
    new FileEvidenceStore(join(root, "evidence")),
    hooks,
    () => Date.now() + 60_000,
  );
  assert.throws(() => broker.workspaceRead("escape/secret.txt"), /symlink/);
  assert.throws(() => broker.workspaceEdit("escape/planted.txt", { content: "x" }), /symlink/);
  assert.equal(broker.workspaceRead("src/a.ts").content, "export const a = 1;\n");
});

test("host sandbox: a runaway command is killed at its timeout and on abort", async () => {
  const { ws } = workspace();
  const sandbox = new HostSandbox();
  const scope = { missionId: "sbx-host", operationId: "exec:timeout" };
  const started = Date.now();
  const timed = await sandbox.exec({
    scope,
    workspaceDir: ws,
    command: "node",
    args: ["-e", "setInterval(() => {}, 1000)"],
    timeoutMs: 800,
    memoryLimitBytes: 128 * 1024 * 1024,
  });
  assert.equal(timed.timedOut, true);
  assert.ok(Date.now() - started < 5000);
  const abort = new AbortController();
  const pending = sandbox.exec({
    scope,
    workspaceDir: ws,
    command: "node",
    args: ["-e", "setInterval(() => {}, 1000)"],
    timeoutMs: 30_000,
    memoryLimitBytes: 128 * 1024 * 1024,
    signal: abort.signal,
  });
  setTimeout(() => abort.abort(), 300);
  assert.equal((await pending).aborted, true);
});

test("docker sandbox refuses images not pinned by digest", () => {
  assert.throws(() => new DockerSandbox({ image: "node:24-alpine" }), SandboxUnavailableError);
});

function pinnedNodeImage(): string | undefined {
  try {
    const digests = JSON.parse(
      execFileSync(
        "docker",
        ["image", "inspect", "node:24-alpine", "--format", "{{json .RepoDigests}}"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 },
      ),
    ) as string[];
    return digests.find((d) => d.startsWith("node@sha256:"));
  } catch {
    return undefined;
  }
}

const image = pinnedNodeImage();

test(
  "docker sandbox: non-root, read-only root, no host files, no network egress",
  { skip: image ? false : "docker or node:24-alpine unavailable" },
  async () => {
    const { ws, outside } = workspace();
    const sandbox = new DockerSandbox({ image: image! });
    await sandbox.assertAvailable();
    const run = (args: string[], operationId: string) =>
      sandbox.exec({
        scope: { missionId: "sbx-docker", operationId },
        workspaceDir: ws,
        command: "node",
        args,
        timeoutMs: 30_000,
        memoryLimitBytes: 256 * 1024 * 1024,
      });
    const uid = await run(["-e", "process.stdout.write(String(process.getuid()))"], "exec:uid");
    assert.equal(uid.exitCode, 0, uid.stderr);
    assert.notEqual(uid.stdout, "0", "runs as non-root");
    const sees = await run(
      ["-e", "process.stdout.write(require('fs').readFileSync('src/a.ts','utf8'))"],
      "exec:ws",
    );
    assert.equal(sees.stdout, "export const a = 1;\n", "candidate workspace is mounted");
    const hostFile = await run(
      ["-e", `require('fs').readFileSync(${JSON.stringify(join(outside, "secret.txt"))})`],
      "exec:hostfile",
    );
    assert.notEqual(hostFile.exitCode, 0, "files outside the workspace are not mounted");
    const socket = await run(
      ["-e", "require('fs').statSync('/var/run/docker.sock')"],
      "exec:socket",
    );
    assert.notEqual(socket.exitCode, 0, "docker socket is not mounted");
    const rootWrite = await run(
      ["-e", "require('fs').writeFileSync('/usr/planted','x')"],
      "exec:rootfs",
    );
    assert.notEqual(rootWrite.exitCode, 0, "root filesystem is read-only");
    const egress = await run(
      [
        "-e",
        "fetch('http://1.1.1.1', { signal: AbortSignal.timeout(3000) }).then(() => process.exit(0), () => process.exit(7))",
      ],
      "exec:egress",
    );
    assert.equal(egress.exitCode, 7, "external egress is denied");
    const env = await run(
      [
        "-e",
        "process.stdout.write(Object.keys(process.env).filter((k) => /MONGODB|API_KEY|SUPERMEMORY/.test(k)).join(','))",
      ],
      "exec:env",
    );
    assert.equal(env.stdout, "", "no credentials in the sandbox environment");
  },
);

test(
  "docker sandbox: timeout removes the container; orphans are cleaned by mission label",
  { skip: image ? false : "docker or node:24-alpine unavailable" },
  async () => {
    const { ws } = workspace();
    const sandbox = new DockerSandbox({ image: image! });
    const missionId = `sbx-orphan-${Date.now()}`;
    const timed = await sandbox.exec({
      scope: { missionId, operationId: "exec:spin" },
      workspaceDir: ws,
      command: "node",
      args: ["-e", "setInterval(() => {}, 1000)"],
      timeoutMs: 2500,
      memoryLimitBytes: 128 * 1024 * 1024,
    });
    assert.equal(timed.timedOut, true);
    assert.deepEqual(await sandbox.list(missionId), []);

    const abandoned = sandbox.exec({
      scope: { missionId, operationId: "exec:abandoned" },
      workspaceDir: ws,
      command: "node",
      args: ["-e", "setInterval(() => {}, 1000)"],
      timeoutMs: 60_000,
      memoryLimitBytes: 128 * 1024 * 1024,
    });
    for (let i = 0; i < 50 && (await sandbox.list(missionId)).length === 0; i += 1)
      await new Promise((r) => setTimeout(r, 200));
    const [orphan] = await sandbox.list(missionId);
    assert.equal(orphan?.operationId, "exec:abandoned");
    assert.deepEqual(await sandbox.cleanupOrphans(missionId), [orphan.sandboxId]);
    await abandoned;
    assert.deepEqual(await sandbox.list(missionId), []);
  },
);
