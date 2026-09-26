import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { Suite } from "../verification/reports.ts";
import {
  computeEnvironmentHash,
  computeEvaluatorHash,
  hashDirectory,
  runSuite,
} from "../verification/runner.ts";
import { loadScenarios } from "../verification/scenarios/index.ts";
import { checkImportBoundaries } from "../verification/structural.ts";
import { ArtifactStore, SEED_DIR } from "./artifact-store.ts";
import { compareConfigurations, renderComparison } from "./compare.ts";
import { BaselineError, MissionController, RESOURCES_DIR, SimulatedCrash } from "./controller.ts";
import { loadFeatureMap, validateFeatureMap } from "./feature-map.ts";
import { Ledger } from "./ledger.ts";
import { evaluateLiveGate, exportLiveGate, renderLiveGate } from "./live-gate.ts";
import { renderMemoryBench, runMemoryBench, type MemoryBenchResult } from "./memory-bench.ts";
import { loadMissionConfig, type MissionConfig } from "./mission-contract.ts";
import { FileEvidenceStore, missionPaths, RUNS_ROOT } from "./mission-paths.ts";
import { PiWorker, resolveProviderApiKey } from "./pi-worker.ts";
import { exportMission, renderProgress, summarize } from "./progress.ts";
import { ScriptedWorker } from "./scripted-worker.ts";
import { renderSkillEval, runSkillEval } from "./skill-eval.ts";
import { providerApiKeyEnv, type Worker } from "./worker.ts";

const USAGE = `horizon <command> [options]

  doctor [--config mission.json]           check node, sqlite, docker, seed, evaluator hash, provider API key
  mission create --config mission.json     freeze identities and import the seed
  run --mission M [--cycles N]             run (or resume) the mission loop
  resume --mission M                       alias of run
  verify --mission M --artifact A --suite smoke|correctness|performance|holdout|learned|structural
  profile --mission M --scenario search-read-heavy [--artifact A]
  features check --artifact A|--dir DIR    structural import-boundary check + feature-map reference check
  inspect --mission M                      progress view
  export --mission M                       write exports/summary.{json,md}
  live-gate --mission M                    check the run against the plan.md live-mission criteria; write exports/live-gate.{json,md}
  compare --config mission.json [--repeats N] [--runs-root DIR]
                                           run the three memory configurations under one crash schedule
  skill-eval [--config mission.json] [--out DIR]
                                           grade the worker on fixed verification-skill fixtures
  memory-bench [--episodes 1000,10000,100000] [--out DIR]
                                           synthetic history benchmark of the retrieval path
`;

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    config: { type: "string" },
    mission: { type: "string" },
    artifact: { type: "string" },
    suite: { type: "string" },
    scenario: { type: "string" },
    dir: { type: "string" },
    cycles: { type: "string" },
    "runs-root": { type: "string" },
    "crash-at": { type: "string" },
    repeats: { type: "string" },
    episodes: { type: "string" },
    out: { type: "string" },
  },
});

const runsRoot = values["runs-root"] ? resolve(values["runs-root"]) : RUNS_ROOT;
const log = (line: string) => console.log(line);

function loadMission(): { config: MissionConfig; paths: ReturnType<typeof missionPaths> } {
  const missionId = values.mission;
  if (!missionId) throw new Error("--mission is required");
  const paths = missionPaths(missionId, runsRoot);
  if (!existsSync(paths.manifest))
    throw new Error(
      `mission ${missionId} not found under ${runsRoot}; run 'horizon mission create'`,
    );
  const manifest = JSON.parse(readFileSync(paths.manifest, "utf8")) as { config: MissionConfig };
  return { config: manifest.config, paths };
}

function makeWorker(config: MissionConfig, paths: ReturnType<typeof missionPaths>): Worker {
  if (config.worker === "scripted") return new ScriptedWorker();
  const { apiKey } = resolveProviderApiKey(config.model.provider, process.env);
  return new PiWorker({
    workspaceDir: paths.candidate,
    agentDir: join(paths.root, "pi-agent"),
    sessionsDir: paths.sessions,
    skillsDir: join(RESOURCES_DIR, "skills"),
    provider: config.model.provider,
    modelId: config.model.id,
    compactionThreshold: 0.7,
    ...(apiKey ? { apiKey } : {}),
  });
}

async function main(): Promise<number> {
  const [command, sub] = positionals;
  switch (command) {
    case "doctor": {
      const checks: [string, string][] = [];
      checks.push(["node", process.version]);
      checks.push([
        "node:sqlite",
        (() => {
          try {
            new Ledger(join(mkdtempSync(join(tmpdir(), "horizon-doctor-")), "t.sqlite")).close();
            return "ok";
          } catch (e) {
            return `unavailable: ${String(e)}`;
          }
        })(),
      ]);
      checks.push([
        "docker",
        (() => {
          try {
            return (
              execFileSync("docker", ["version", "--format", "{{.Server.Version}}"], {
                stdio: ["ignore", "pipe", "ignore"],
                timeout: 5000,
              })
                .toString()
                .trim() || "client only"
            );
          } catch {
            return "unavailable (subprocess isolation only)";
          }
        })(),
      ]);
      checks.push([
        "seed",
        existsSync(join(SEED_DIR, "src/http/server.ts"))
          ? `ok ${hashDirectory(SEED_DIR).hash.slice(0, 12)}`
          : "missing",
      ]);
      checks.push(["evaluatorHash", computeEvaluatorHash().slice(0, 16)]);
      checks.push([
        "environmentHash(subprocess)",
        computeEnvironmentHash("subprocess", "").slice(0, 16),
      ]);
      checks.push([
        "supermemory",
        process.env.SUPERMEMORY_API_KEY
          ? "api key present"
          : "no SUPERMEMORY_API_KEY (local memory adapter)",
      ]);
      const doctorConfig = loadMissionConfig(
        values.config ? resolve(values.config) : join(RESOURCES_DIR, "../mission.example.json"),
      );
      const providerEnv = providerApiKeyEnv(doctorConfig.model.provider);
      checks.push([
        `provider(${doctorConfig.model.provider})`,
        process.env[providerEnv]
          ? `${providerEnv} present`
          : `no ${providerEnv} (required for "worker": "pi"; the scripted worker needs none)`,
      ]);
      checks.push(["runsRoot", runsRoot]);
      for (const [k, v] of checks) log(`${k.padEnd(28)} ${v}`);
      return 0;
    }
    case "mission": {
      if (sub !== "create") throw new Error(USAGE);
      if (!values.config) throw new Error("--config is required");
      const config = loadMissionConfig(resolve(values.config));
      const controller = new MissionController(config, missionPaths(config.missionId, runsRoot), {
        log,
      });
      try {
        const row = controller.initialize();
        log(
          `mission ${row.missionId} ready: contract ${row.contractHash.slice(0, 12)} evaluator ${row.evaluatorHash.slice(0, 12)} env ${row.environmentHash.slice(0, 12)} seed ${row.seedArtifactHash?.slice(0, 12)}`,
        );
      } finally {
        controller.close();
      }
      return 0;
    }
    case "run":
    case "resume": {
      const { config, paths } = loadMission();
      const controller = new MissionController(config, paths, {
        log,
        worker: makeWorker(config, paths),
        ...(values.cycles ? { maxCycles: Number(values.cycles) } : {}),
        ...(values["crash-at"] ? { crashAt: values["crash-at"] } : {}),
      });
      try {
        const row = await controller.run();
        log("");
        log(renderProgress(summarize(controller.ledger, config)));
        return row.status === "succeeded" ? 0 : 2;
      } catch (error) {
        if (error instanceof SimulatedCrash) {
          log(error.message);
          return 3;
        }
        if (error instanceof BaselineError) return 2;
        throw error;
      } finally {
        controller.close();
      }
    }
    case "verify":
    case "profile": {
      const { config, paths } = loadMission();
      const suite: Suite = command === "profile" ? "performance" : (values.suite as Suite);
      if (!suite) throw new Error("--suite is required");
      const ledger = new Ledger(paths.db);
      try {
        const mission = ledger.getMission(config.missionId);
        const artifacts = new ArtifactStore(paths.artifacts);
        const hash = values.artifact ?? mission?.bestArtifactHash;
        if (!hash || !artifacts.verify(hash))
          throw new Error(`artifact ${hash ?? "(none)"} not found or corrupt`);
        const report = await runSuite(
          {
            missionId: config.missionId,
            experimentId: `cli-${command}-${Date.now()}`,
            artifactHash: hash,
            evaluatorHash: computeEvaluatorHash(),
            environmentHash: computeEnvironmentHash(config.isolation, config.containerImage),
            snapshotDir: artifacts.pathFor(hash),
            isolation: config.isolation,
            containerImage: config.containerImage,
            startupTimeoutMs: config.startupTimeoutMs,
            requestTimeoutMs: config.requestTimeoutMs,
            memoryLimitBytes: config.memoryLimitBytes,
            workload: config.workload,
            holdoutWorkload: config.holdoutWorkload,
            learnedScenariosDir: paths.learnedScenarios,
            evidence: new FileEvidenceStore(paths.evidence),
          },
          suite,
        );
        log(
          JSON.stringify(
            {
              scenario: values.scenario ?? null,
              reportId: report.reportId,
              suite,
              status: report.status,
              isolation: report.isolation,
              metrics: report.metrics,
              failed: report.assertions.filter((a) => !a.passed),
              infraMessage: report.infraMessage ?? null,
            },
            null,
            2,
          ),
        );
        return report.status === "passed" ? 0 : 2;
      } finally {
        ledger.close();
      }
    }
    case "features": {
      if (sub !== "check") throw new Error(USAGE);
      let dir = values.dir ? resolve(values.dir) : undefined;
      if (!dir && values.artifact) {
        const { paths } = loadMission();
        dir = new ArtifactStore(paths.artifacts).pathFor(values.artifact);
      }
      if (!dir) dir = SEED_DIR;
      const violations = checkImportBoundaries(join(dir, "src"));
      const featureMapIssues = validateFeatureMap(
        loadFeatureMap(join(RESOURCES_DIR, "features.json")),
        loadScenarios(),
        dir,
      );
      log(
        JSON.stringify(
          { dir, hash: hashDirectory(dir).hash, violations, featureMapIssues },
          null,
          2,
        ),
      );
      return violations.length === 0 && featureMapIssues.length === 0 ? 0 : 2;
    }
    case "skill-eval": {
      const config = values.config ? loadMissionConfig(resolve(values.config)) : undefined;
      const root = mkdtempSync(join(tmpdir(), "horizon-skill-eval-"));
      const worker =
        config && config.worker !== "scripted"
          ? makeWorker(config, missionPaths(config.missionId, root))
          : new ScriptedWorker();
      const result = await runSkillEval(worker);
      const text = renderSkillEval(result);
      log(text);
      if (values.out) {
        mkdirSync(resolve(values.out), { recursive: true });
        writeFileSync(
          join(resolve(values.out), "skill-eval.json"),
          JSON.stringify(result, null, 2),
        );
        writeFileSync(join(resolve(values.out), "skill-eval.md"), `${text}\n`);
      }
      return result.passed === result.total ? 0 : 2;
    }
    case "memory-bench": {
      const sizes = (values.episodes ?? "1000,10000").split(",").map(Number);
      const results: MemoryBenchResult[] = [];
      for (const episodes of sizes) {
        const result = await runMemoryBench({ episodes });
        results.push(result);
        log(`${episodes} episodes: ${JSON.stringify(result)}`);
      }
      const table = renderMemoryBench(results);
      log("");
      log(table);
      if (values.out) {
        mkdirSync(resolve(values.out), { recursive: true });
        writeFileSync(
          join(resolve(values.out), "memory-bench.json"),
          JSON.stringify(results, null, 2),
        );
        writeFileSync(join(resolve(values.out), "memory-bench.md"), `${table}\n`);
      }
      return 0;
    }
    case "compare": {
      if (!values.config) throw new Error("--config is required");
      const base = loadMissionConfig(resolve(values.config));
      const root = values["runs-root"]
        ? resolve(values["runs-root"])
        : mkdtempSync(join(tmpdir(), "horizon-compare-"));
      const result = await compareConfigurations({
        runsRoot: root,
        base: { ...base, segmentRotationCycles: 1 },
        // Same schedule for every configuration: crash right after the first candidate snapshot, then resume to completion.
        interruptions: [{ crashAt: "snapshot_ready" }, { crashAt: null }],
        repeats: values.repeats ? Number(values.repeats) : 1,
        log,
      });
      log("");
      log(renderComparison(result));
      log(`written to ${join(root, "comparison.md")}`);
      return 0;
    }
    case "inspect": {
      const { config, paths } = loadMission();
      const ledger = new Ledger(paths.db);
      try {
        log(renderProgress(summarize(ledger, config)));
      } finally {
        ledger.close();
      }
      return 0;
    }
    case "export": {
      const { config, paths } = loadMission();
      const ledger = new Ledger(paths.db);
      try {
        const out = exportMission(ledger, config, paths);
        log(`${out.json}\n${out.markdown}`);
      } finally {
        ledger.close();
      }
      return 0;
    }
    case "live-gate": {
      const { config, paths } = loadMission();
      const ledger = new Ledger(paths.db);
      try {
        const result = evaluateLiveGate(ledger, config);
        const out = exportLiveGate(result, paths);
        log(renderLiveGate(result));
        log(`${out.json}\n${out.markdown}`);
        return result.passed ? 0 : 2;
      } finally {
        ledger.close();
      }
    }
    default:
      log(USAGE);
      return command ? 1 : 0;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
