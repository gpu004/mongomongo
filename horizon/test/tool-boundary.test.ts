import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FileEvidenceStore } from "../src/mission-paths.ts";
import { ToolBroker, type BrokerHooks } from "../src/tool-broker.ts";

function brokerFor(workspaceDir: string): ToolBroker {
  const hooks: BrokerHooks = {
    verify: () => Promise.reject(new Error("not used")),
    profile: () => Promise.reject(new Error("not used")),
    recall: () => Promise.reject(new Error("not used")),
    proposeRegression: () => Promise.reject(new Error("not used")),
    onToolEvent: () => {},
  };
  return new ToolBroker(
    workspaceDir,
    new FileEvidenceStore(mkdtempSync(join(tmpdir(), "horizon-ev-"))),
    hooks,
    () => Date.now() + 60_000,
  );
}

function workspace(): { root: string; outside: string } {
  const base = mkdtempSync(join(tmpdir(), "horizon-ws-"));
  const root = join(base, "candidate");
  const outside = join(base, "outside");
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(outside, "dir"), { recursive: true });
  writeFileSync(join(root, "src", "real.ts"), "export const ok = 1;\n");
  writeFileSync(join(outside, "secret.txt"), "host secret\n");
  writeFileSync(join(outside, "dir", "more.ts"), "host file\n");
  return { root, outside };
}

test("tool boundary: reads, edits and exec stay inside the workspace even through symlinks", async () => {
  const { root, outside } = workspace();
  symlinkSync(join(outside, "secret.txt"), join(root, "src", "linked.ts"));
  symlinkSync(join(outside, "dir"), join(root, "src", "extdir"));
  const broker = brokerFor(root);

  assert.equal(broker.workspaceRead("src/real.ts").content, "export const ok = 1;\n");
  assert.throws(() => broker.workspaceRead("src/linked.ts"), /escapes candidate workspace/);
  assert.throws(() => broker.workspaceRead("src/extdir/more.ts"), /escapes candidate workspace/);
  assert.throws(
    () => broker.workspaceEdit("src/linked.ts", { content: "x" }),
    /escapes candidate workspace/,
  );

  assert.deepEqual(broker.listFiles(), ["src/real.ts"]);
  assert.deepEqual(broker.workspaceSearch("host"), []);

  await assert.rejects(
    broker.workspaceExec("node", ["-e", "process.exit(1)"], 5000),
    /command not allowed/,
  );
  await assert.rejects(
    broker.workspaceExec("cat", ["src/linked.ts"], 5000),
    /escapes candidate workspace|argument denied/,
  );
  const result = await broker.workspaceExec("cat", ["src/real.ts"], 5000);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "export const ok = 1;\n");
});
