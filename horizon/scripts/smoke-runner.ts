// Dev smoke: run the fixed suites against the seed and the stale-cache fixture.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactStore } from "../src/artifact-store.ts";
import { computeEnvironmentHash, computeEvaluatorHash, runSuite } from "../verification/runner.ts";

const root = mkdtempSync(join(tmpdir(), "horizon-smoke-"));
const store = new ArtifactStore(join(root, "artifacts"));
const seed = store.importSeed();
const { artifact: stale } = store.importFixture("stale-cache", seed.hash);
const { artifact: bypass } = store.importFixture("bypass-mutation-path", seed.hash);
const evidence = { write: (kind: string, payload: unknown) => `ev-${kind}-${JSON.stringify(payload).length}` };
const workload = { corpusSize: 300, seed: 7, warmupRequests: 20, measuredRequests: 100, repetitions: 2, mutationRatio: 0.1 };

for (const [name, artifact] of [["seed", seed], ["stale-cache", stale], ["bypass", bypass]] as const) {
	for (const suite of ["smoke", "correctness", "performance"] as const) {
		const report = await runSuite(
			{
				missionId: "m", experimentId: "x", artifactHash: artifact.hash, evaluatorHash: computeEvaluatorHash(),
				environmentHash: computeEnvironmentHash("subprocess", ""), snapshotDir: artifact.path, isolation: "subprocess", containerImage: "",
				startupTimeoutMs: 10000, requestTimeoutMs: 5000, memoryLimitBytes: 512 * 1024 * 1024, workload, holdoutWorkload: workload, evidence,
			},
			suite,
		);
		const failed = report.assertions.filter((a) => !a.passed).map((a) => `${a.id}: ${a.detail ?? ""}`);
		console.log(name, suite, report.status, JSON.stringify(report.metrics), failed.join(" | "), report.infraMessage ?? "");
	}
}
