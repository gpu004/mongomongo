import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ArtifactStore } from "../src/artifact-store.ts";
import { loadMissionConfig } from "../src/mission-contract.ts";
import { FileEvidenceStore } from "../src/mission-paths.ts";
import {
  SandboxUnavailableError,
  assertSandboxAvailable,
  cleanupOrphanContainers,
  listMissionContainers,
} from "../src/sandbox.ts";
import { ToolBroker, type BrokerHooks } from "../src/tool-broker.ts";
import { launchCandidate } from "../verification/candidate-process.ts";
import { computeEnvironmentHash, computeEvaluatorHash, runSuite } from "../verification/runner.ts";
import { EXAMPLE_CONFIG } from "./helpers.ts";

/** Shape of GET /__probe from verification/fixtures/escape-probe (overlay files are outside tsc's include). */
interface ProbeAttempt {
  ok: boolean;
  detail: string;
}
interface ProbeReport {
  uid: number | null;
  gid: number | null;
  cwd: string;
  envKeys: string[];
  hostReads: Record<string, ProbeAttempt>;
  writeInSnapshot: ProbeAttempt;
  writeInRoot: ProbeAttempt;
  symlinkToRoot: ProbeAttempt;
  network: Record<string, ProbeAttempt>;
}

/**
 * Adversarial fixtures against the container backend (plan.md §3/§5). These run
 * only when Docker and the pinned image are present; they are skipped, never
 * silently downgraded to the host, otherwise. Set HORIZON_REQUIRE_DOCKER=1 to
 * turn the skip into a failure.
 */
const IMAGE = loadMissionConfig(EXAMPLE_CONFIG).containerImage;
const MISSION = `sbx-${process.pid}`;
const EVALUATOR_FILE = new URL("../verification/runner.ts", import.meta.url).pathname;

function dockerSkipReason(): string | undefined {
  try {
    assertSandboxAvailable(IMAGE);
    return undefined;
  } catch (error) {
    if (process.env.HORIZON_REQUIRE_DOCKER === "1") throw error;
    return error instanceof SandboxUnavailableError ? error.message : String(error);
  }
}

const skip = dockerSkipReason();

const hooks: BrokerHooks = {
  verify: () => Promise.reject(new Error("not used")),
  profile: () => Promise.reject(new Error("not used")),
  recall: () => Promise.reject(new Error("not used")),
  proposeRegression: () => Promise.reject(new Error("not used")),
  onToolEvent: () => {},
};

test(
  "worker exec runs inside the sandbox image with no network, and leaves no container behind",
  { skip },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "horizon-sbx-ws-"));
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "real.ts"), "export const ok = 1;\n");
    const evidence = new FileEvidenceStore(mkdtempSync(join(tmpdir(), "horizon-sbx-ev-")));
    const broker = new ToolBroker(root, evidence, hooks, () => Date.now() + 60_000, {
      image: IMAGE,
      missionId: MISSION,
      operationId: "exec-1",
    });
    assert.equal(broker.sandboxed, true);

    const ok = await broker.workspaceExec("cat", ["src/real.ts"], 20_000);
    assert.equal(ok.exitCode, 0);
    assert.equal(ok.stdout, "export const ok = 1;\n");
    const record = JSON.parse(evidence.read(ok.evidenceId, 100_000)!.excerpt) as {
      payload: { sandbox: { container: string; network: string } | null };
    };
    assert.match(record.payload.sandbox!.container, /^horizon-exec-/);
    assert.equal(record.payload.sandbox!.network, "none");

    // busybox `cat --help` (alpine image) vs. GNU coreutils on the host: proves where it ran.
    const help = await broker.workspaceExec("cat", ["--help"], 20_000);
    assert.match(help.stderr + help.stdout, /BusyBox/);

    // The same host-side rules still apply before anything is spawned.
    await assert.rejects(broker.workspaceExec("cat", ["/etc/passwd"], 5000), /argument denied/);
    await assert.rejects(broker.workspaceExec("node", ["-e", "1"], 5000), /command not allowed/);

    assert.deepEqual(listMissionContainers(MISSION), [], "--rm containers are gone after exit");
  },
);

test(
  "candidate escape probe: host files, credentials, evaluator, writes, symlinks and public network are all denied",
  { skip },
  async () => {
    // A host secret the candidate must not see, both as a file and in the environment.
    const hostSecretDir = mkdtempSync(join(tmpdir(), "horizon-host-secret-"));
    const hostSecretFile = join(hostSecretDir, "credentials.json");
    writeFileSync(hostSecretFile, JSON.stringify({ token: "hunter2" }));
    process.env.HORIZON_TEST_HOST_SECRET = "hunter2";

    const runs = mkdtempSync(join(tmpdir(), "horizon-sbx-runs-"));
    const store = new ArtifactStore(join(runs, "artifacts"));
    const seed = store.importSeed();
    const { artifact, fixture } = store.importFixture("escape-probe", seed.hash);
    assert.equal(fixture.kind, "escape-probe");
    const evidence = new FileEvidenceStore(join(runs, "evidence"));

    const candidate = await launchCandidate({
      snapshotDir: artifact.path,
      isolation: "container",
      containerImage: IMAGE,
      missionId: MISSION,
      operationId: "probe-1",
      startupTimeoutMs: 30_000,
      memoryLimitBytes: 256 * 1024 * 1024,
    });
    try {
      assert.match(
        candidate.baseUrl,
        /^http:\/\/\d+\.\d+\.\d+\.\d+:8080$/,
        "reached by internal address, not a published port",
      );
      assert.match(candidate.containerName!, /^horizon-cand-/);
      const running = listMissionContainers(MISSION);
      assert.equal(running.length, 1, "candidate is tracked under the mission label");
      const inspected = execFileSync(
        "docker",
        [
          "inspect",
          "--format",
          "{{.HostConfig.NetworkMode}} {{.HostConfig.ReadonlyRootfs}} {{.Config.User}} {{json .HostConfig.CapDrop}}",
          candidate.containerName!,
        ],
        { encoding: "utf8" },
      ).trim();
      assert.match(inspected, new RegExp(`^horizon-net-${MISSION} true \\d+:\\d+ \\["ALL"\\]$`));

      const health = await fetch(`${candidate.baseUrl}/health`);
      assert.equal(health.status, 200, "the trusted verifier can reach the candidate service");

      const probeUrl = new URL(`${candidate.baseUrl}/__probe`);
      for (const p of [
        hostSecretFile,
        EVALUATOR_FILE,
        join(homedir(), ".bashrc"),
        "/var/run/docker.sock",
        "/host/etc/passwd",
      ])
        probeUrl.searchParams.append("path", p);
      for (const u of [
        "http://1.1.1.1/",
        "https://example.com/",
        "http://host.docker.internal:80/",
      ])
        probeUrl.searchParams.append("url", u);
      probeUrl.searchParams.set("timeoutMs", "4000");
      const response = await fetch(probeUrl, { signal: AbortSignal.timeout(60_000) });
      assert.equal(response.status, 200);
      const report = (await response.json()) as ProbeReport;
      const evidenceId = evidence.write("escape-probe", {
        fixtureId: fixture.fixtureId,
        image: IMAGE,
        report,
      });
      assert.ok(evidence.has(evidenceId), "observed denials are recorded as evidence");

      assert.notEqual(report.uid, 0, "candidate is not root");
      assert.notEqual(report.gid, 0);
      assert.equal(report.cwd, "/candidate");
      for (const [path, outcome] of Object.entries(report.hostReads))
        assert.equal(
          outcome.ok,
          false,
          `host path readable from candidate: ${path} (${outcome.detail})`,
        );
      assert.ok(!report.envKeys.includes("HORIZON_TEST_HOST_SECRET"), "host environment leaked");
      assert.ok(
        !report.envKeys.some((k) => /SUPERMEMORY|API_KEY|MONGODB|ATLAS|TOKEN/i.test(k)),
        `credential-like env: ${report.envKeys.join(",")}`,
      );
      assert.equal(report.writeInSnapshot.ok, false, "snapshot must be read-only");
      assert.equal(report.writeInSnapshot.detail, "EROFS");
      assert.equal(report.writeInRoot.ok, false, "root filesystem must be read-only");
      assert.equal(report.symlinkToRoot.ok, false, "symlink planting must be denied");
      for (const [url, outcome] of Object.entries(report.network))
        assert.equal(
          outcome.ok,
          false,
          `public endpoint reachable from candidate: ${url} (${outcome.detail})`,
        );

      // Nothing changed on the host side of the snapshot either.
      assert.equal(existsSync(join(artifact.path, "src", "__escape.txt")), false);
      assert.equal(existsSync(join(artifact.path, "src", "__root")), false);
      assert.equal(readFileSync(hostSecretFile, "utf8"), JSON.stringify({ token: "hunter2" }));
    } finally {
      delete process.env.HORIZON_TEST_HOST_SECRET;
      await candidate.stop();
    }
    assert.deepEqual(listMissionContainers(MISSION), [], "stopped candidate is removed");
  },
);

test("verification smoke suite runs the seed through the container backend", { skip }, async () => {
  const runs = mkdtempSync(join(tmpdir(), "horizon-sbx-runs-"));
  const store = new ArtifactStore(join(runs, "artifacts"));
  const seed = store.importSeed();
  const evidence = new FileEvidenceStore(join(runs, "evidence"));
  const workload = {
    corpusSize: 200,
    seed: 7,
    warmupRequests: 10,
    measuredRequests: 40,
    repetitions: 2,
    mutationRatio: 0.1,
  };
  const report = await runSuite(
    {
      missionId: MISSION,
      experimentId: "smoke-1",
      artifactHash: seed.hash,
      evaluatorHash: computeEvaluatorHash(),
      environmentHash: computeEnvironmentHash("container", IMAGE),
      snapshotDir: seed.path,
      isolation: "container",
      containerImage: IMAGE,
      startupTimeoutMs: 30_000,
      requestTimeoutMs: 10_000,
      memoryLimitBytes: 256 * 1024 * 1024,
      workload,
      holdoutWorkload: workload,
      evidence,
    },
    "smoke",
  );
  assert.equal(report.status, "passed", JSON.stringify(report.assertions.filter((a) => !a.passed)));
  assert.equal(report.isolation, "container");
  assert.deepEqual(listMissionContainers(MISSION), []);
});

test("container isolation with a missing image is an explicit infra_error, never a host run", async () => {
  const runs = mkdtempSync(join(tmpdir(), "horizon-sbx-runs-"));
  const store = new ArtifactStore(join(runs, "artifacts"));
  const seed = store.importSeed();
  const bogus = `node@sha256:${"0".repeat(64)}`;
  const report = await runSuite(
    {
      missionId: MISSION,
      experimentId: "missing-image",
      artifactHash: seed.hash,
      evaluatorHash: computeEvaluatorHash(),
      environmentHash: computeEnvironmentHash("container", bogus),
      snapshotDir: seed.path,
      isolation: "container",
      containerImage: bogus,
      startupTimeoutMs: 10_000,
      requestTimeoutMs: 5_000,
      memoryLimitBytes: 256 * 1024 * 1024,
      workload: {
        corpusSize: 50,
        seed: 1,
        warmupRequests: 2,
        measuredRequests: 5,
        repetitions: 2,
        mutationRatio: 0.1,
      },
      holdoutWorkload: {
        corpusSize: 50,
        seed: 2,
        warmupRequests: 2,
        measuredRequests: 5,
        repetitions: 2,
        mutationRatio: 0.1,
      },
      evidence: new FileEvidenceStore(join(runs, "evidence")),
    },
    "smoke",
  );
  assert.equal(report.status, "infra_error");
  assert.match(report.infraMessage ?? "", /not present locally|Docker daemon is unreachable/);
  assert.deepEqual(
    report.assertions.map((a) => a.id),
    ["structural:import-boundaries"],
    "no candidate was launched",
  );
});

test.after(() => {
  cleanupOrphanContainers(MISSION);
});
