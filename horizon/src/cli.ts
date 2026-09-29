import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { constants as osConstants, hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { Suite } from "../verification/reports.ts";
import {
  computeEnvironmentHash,
  environmentFingerprint,
  hashDirectory,
} from "../verification/runner.ts";
import { ArtifactStore } from "./artifact-store.ts";
import { compareConfigurations, renderComparison } from "./compare.ts";
import {
  BaselineError,
  MissionController,
  type MissionManifest,
  RESOURCES_DIR,
  SimulatedCrash,
} from "./controller.ts";
import { loadFeatureMap, validateFeatureMap } from "./feature-map.ts";
import { Ledger } from "./ledger.ts";
import { describeLedgerSelection, openLedger, selectLedgerBackend } from "./ledger-backend.ts";
import { readMongoEnv } from "./mongo-env.ts";
import { probeMongo, renderMongoProbe } from "./mongo-probe.ts";
import { evaluateLiveGate, exportLiveGate, renderLiveGate } from "./live-gate.ts";
import { renderMemoryBench, runMemoryBench, type MemoryBenchResult } from "./memory-bench.ts";
import {
  contractHash,
  legacyContractHash,
  loadMissionConfig,
  type MissionConfig,
} from "./mission-contract.ts";
import { missionSpecFor, missionSpecIds, findMissionSpec } from "./objectives/index.ts";
import { FileEvidenceStore, missionPaths, RUNS_ROOT } from "./mission-paths.ts";
import { clearControl, readControl, writeControl } from "./operator-control.ts";
import { PiWorker, resolveProviderApiKey } from "./pi-worker.ts";
import { exportMission, renderProgress, summarize } from "./progress.ts";
import { classifyEnvironmentDrift } from "./recovery.ts";
import { ScriptedWorker } from "./scripted-worker.ts";
import { renderSkillEval, runSkillEval } from "./skill-eval.ts";
import { providerApiKeyEnv, type Worker } from "./worker.ts";

const USAGE = `horizon <command> [options]

  doctor [--config mission.json] [--mission M]
                                           check node, sqlite, mongodb, docker, seed, evaluator hash, provider API key;
                                           with --mission, report drift against the mission's frozen identities
  mission create --config mission.json     freeze identities and import the seed
  amend --config mission.json              replace a mission's operating parameters (budget, model, worker, rotation,
                                           stagnation, memory); the objective stays frozen; audited as mission.amended
  rebaseline --mission M                   adopt a changed evaluator/runtime: re-measure the seed and the best artifact
  run --mission M [--cycles N]             run (or resume) the mission loop; SIGINT/SIGTERM stops it gracefully
  resume --mission M                       clear a pending stop/pause, then run
  stop --mission M                         ask the running controller to stop after in-flight work (exit 0)
  pause --mission M                        like stop, but the mission stays paused until \`resume\`
  verify --mission M --artifact A --suite smoke|correctness|performance|holdout|learned|structural
  profile --mission M --scenario search-read-heavy [--artifact A]
  features check --artifact A|--dir DIR [--config C]  objective structural check + feature-map reference check
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

/** After the first signal a graceful stop has this long before the process is forced out. */
const SHUTDOWN_GRACE_MS = Number(process.env.HORIZON_SHUTDOWN_GRACE_MS ?? 60_000);

/**
 * First SIGINT/SIGTERM: graceful stop (abort the worker and broker children, finish
 * in-flight ledger work, checkpoint, release the lease, exit 0). A second signal, or
 * a stop that outlives the grace period, forces exit with the conventional 128+signal code.
 */
function installShutdownSignals(controller: MissionController): () => void {
  let pending = false;
  const force = (signal: NodeJS.Signals, why: string) => {
    log(`${signal}: ${why}; forcing exit`);
    process.exit(128 + osConstants.signals[signal]);
  };
  const onSignal = (signal: NodeJS.Signals) => {
    if (pending) return force(signal, "second signal");
    pending = true;
    log(
      `${signal}: stopping gracefully (send again to force exit; forced after ${SHUTDOWN_GRACE_MS}ms)`,
    );
    setTimeout(
      () => force(signal, `graceful stop exceeded ${SHUTDOWN_GRACE_MS}ms`),
      SHUTDOWN_GRACE_MS,
    ).unref();
    void controller.requestStop({ intent: "stop", source: "signal", reason: signal });
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  return () => {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  };
}
const log = (line: string) => console.log(line);

function loadMission(): {
  config: MissionConfig;
  paths: ReturnType<typeof missionPaths>;
  manifest: MissionManifest;
} {
  const missionId = values.mission;
  if (!missionId) throw new Error("--mission is required");
  const paths = missionPaths(missionId, runsRoot);
  if (!existsSync(paths.manifest))
    throw new Error(
      `mission ${missionId} not found under ${runsRoot}; run 'horizon mission create'`,
    );
  const manifest = JSON.parse(readFileSync(paths.manifest, "utf8")) as MissionManifest;
  return { config: manifest.config, paths, manifest };
}

/** Drift of this process against a mission's frozen identities, one line per identity. */
function driftNotes(manifest: MissionManifest): string[] {
  const config = manifest.config;
  const notes: string[] = [];
  const contract = contractHash(config);
  notes.push(
    contract === manifest.contractHash
      ? `contract ${contract.slice(0, 12)} matches`
      : legacyContractHash(config) === manifest.contractHash
        ? `contract ${manifest.contractHash.slice(0, 12)} -> ${contract.slice(0, 12)}: frozen before the objective/operating split; resume migrates it and records contract.migrated`
        : `contract ${manifest.contractHash.slice(0, 12)} -> ${contract.slice(0, 12)}: the persisted config no longer hashes to the frozen objective; resume will refuse`,
  );
  if (manifest.pendingAmendment)
    notes.push(
      `amendment ${manifest.pendingAmendment.amendmentId} pending: resume adopts it if the ledger holds it, else discards it`,
    );
  const evaluator = missionSpecFor(config).evaluator.hash();
  notes.push(
    evaluator === manifest.evaluatorHash
      ? `evaluator ${evaluator.slice(0, 12)} matches`
      : `evaluator ${manifest.evaluatorHash.slice(0, 12)} -> ${evaluator.slice(0, 12)}: resume will refuse; run 'horizon rebaseline --mission ${config.missionId}'`,
  );
  const environment = environmentFingerprint(config.isolation, config.containerImage);
  const drift = classifyEnvironmentDrift(manifest.environment, environment);
  notes.push(
    !drift
      ? `environment ${manifest.environmentHash.slice(0, 12)} matches`
      : drift.severity === "warning"
        ? `environment drift (warning): ${drift.reason}; resume continues and records environment.drifted`
        : `environment drift (invalidating): ${drift.reason}; resume will refuse; run 'horizon rebaseline --mission ${config.missionId}'`,
  );
  return notes;
}

function makeWorker(config: MissionConfig, paths: ReturnType<typeof missionPaths>): Worker {
  const spec = missionSpecFor(config);
  if (config.worker === "scripted") return spec.scriptedWorker();
  const { apiKey } = resolveProviderApiKey(config.model.provider, process.env);
  return new PiWorker({
    workspaceDir: paths.candidate,
    agentDir: join(paths.root, "pi-agent"),
    sessionsDir: paths.sessions,
    skillsDir: spec.skillsDir,
    objectivePrompt: spec.workerPrompt,
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
      const mongoEnv = readMongoEnv();
      checks.push([
        "mongodb",
        mongoEnv
          ? renderMongoProbe(await probeMongo(mongoEnv))
          : "no MONGODB_URI (sqlite ledger only; see .env.example)",
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
      for (const id of missionSpecIds()) {
        const spec = findMissionSpec(id)!;
        checks.push([
          `objective ${id}`,
          `${spec.metric.key} (${spec.metric.direction}); tasks ${Object.values(spec.tasks)
            .map((t) => t.taskId)
            .join(" -> ")}`,
        ]);
        checks.push([
          `seed ${id}`,
          existsSync(join(spec.seedDir, "src"))
            ? `ok ${hashDirectory(spec.seedDir).hash.slice(0, 12)}`
            : "missing",
        ]);
        checks.push([`evaluatorHash ${id}`, spec.evaluator.hash().slice(0, 16)]);
      }
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
      if (values.mission) {
        const { manifest } = loadMission();
        for (const note of driftNotes(manifest)) checks.push([`mission(${values.mission})`, note]);
      }
      for (const [k, v] of checks) log(`${k.padEnd(28)} ${v}`);
      return 0;
    }
    case "amend": {
      if (!values.config) throw new Error("--config is required");
      const next = loadMissionConfig(resolve(values.config));
      values.mission ??= next.missionId;
      const { config, paths } = loadMission();
      const controller = new MissionController(config, paths, { log });
      try {
        const amendment = await controller.amend(next);
        log(
          `mission ${config.missionId}: ${amendment.changes.length} operating parameter(s) amended, ${amendment.budgetExtensions.length} budget limit(s) extended; contract ${controller.contractHash.slice(0, 12)} unchanged`,
        );
      } finally {
        await controller.close();
      }
      return 0;
    }
    case "rebaseline": {
      const { config, paths } = loadMission();
      const controller = new MissionController(config, paths, { log });
      try {
        const outcome = await controller.rebaseline();
        log(
          `mission ${config.missionId}: evaluator ${outcome.evaluatorHash.to.slice(0, 12)} env ${outcome.environmentHash.to.slice(0, 12)} baseline p95 ${outcome.baselineP95Ms ?? "n/a"}ms best ${outcome.bestArtifactHash.slice(0, 12)}${outcome.previousBest && outcome.previousBest !== outcome.bestArtifactHash ? ` (previous best ${outcome.previousBest.slice(0, 12)} demoted)` : ""}`,
        );
        return 0;
      } catch (error) {
        if (error instanceof BaselineError) return 2;
        throw error;
      } finally {
        await controller.close();
      }
    }
    case "mission": {
      if (sub !== "create") throw new Error(USAGE);
      if (!values.config) throw new Error("--config is required");
      const config = loadMissionConfig(resolve(values.config));
      const controller = new MissionController(config, missionPaths(config.missionId, runsRoot), {
        log,
      });
      try {
        log(`ledger: ${describeLedgerSelection(selectLedgerBackend(config))}`);
        const row = await controller.initialize();
        log(
          `mission ${row.missionId} ready: contract ${row.contractHash.slice(0, 12)} evaluator ${row.evaluatorHash.slice(0, 12)} env ${row.environmentHash.slice(0, 12)} seed ${row.seedArtifactHash?.slice(0, 12)}`,
        );
      } finally {
        await controller.close();
      }
      return 0;
    }
    case "run":
    case "resume": {
      const { config, paths } = loadMission();
      if (command === "resume") {
        const pending = readControl(paths);
        if (pending && clearControl(paths, pending))
          log(`control: pending ${pending.command} cleared`);
      }
      const controller = new MissionController(config, paths, {
        log,
        worker: makeWorker(config, paths),
        ...(values.cycles ? { maxCycles: Number(values.cycles) } : {}),
        ...(values["crash-at"] ? { crashAt: values["crash-at"] } : {}),
      });
      const uninstall = installShutdownSignals(controller);
      try {
        const row = await controller.run();
        log("");
        log(renderProgress(await summarize(controller.ledger, config)));
        if (controller.stopRequested) return 0;
        return row.status === "succeeded" ? 0 : 2;
      } catch (error) {
        if (error instanceof SimulatedCrash) {
          log(error.message);
          return 3;
        }
        if (error instanceof BaselineError) return 2;
        throw error;
      } finally {
        uninstall();
        await controller.close();
      }
    }
    case "stop":
    case "pause": {
      const { paths } = loadMission();
      const current = readControl(paths);
      writeControl(paths, command, `${hostname()}:${process.pid}`);
      log(
        `control: ${command} requested${current ? ` (replaces ${current.command})` : ""}; a running controller honours it between cycles or during a rate-limit wait`,
      );
      return 0;
    }
    case "verify":
    case "profile": {
      const { config, paths } = loadMission();
      const suite: Suite = command === "profile" ? "performance" : (values.suite as Suite);
      if (!suite) throw new Error("--suite is required");
      const ledger = await openLedger(config, paths);
      try {
        const mission = await ledger.getMission(config.missionId);
        const artifacts = new ArtifactStore(paths.artifacts);
        const hash = values.artifact ?? mission?.bestArtifactHash;
        if (!hash || !artifacts.verify(hash))
          throw new Error(`artifact ${hash ?? "(none)"} not found or corrupt`);
        const spec = missionSpecFor(config);
        const report = await spec.evaluator.run(
          {
            missionId: config.missionId,
            experimentId: `cli-${command}-${Date.now()}`,
            artifactHash: hash,
            evaluatorHash: spec.evaluator.hash(),
            environmentHash: computeEnvironmentHash(config.isolation, config.containerImage),
            snapshotDir: artifacts.pathFor(hash),
            config,
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
        await ledger.close();
      }
    }
    case "features": {
      if (sub !== "check") throw new Error(USAGE);
      let config = values.config ? loadMissionConfig(resolve(values.config)) : undefined;
      let dir = values.dir ? resolve(values.dir) : undefined;
      if (!dir && values.artifact) {
        const mission = loadMission();
        config = mission.config;
        dir = new ArtifactStore(mission.paths.artifacts).pathFor(values.artifact);
      }
      const spec = missionSpecFor(config ?? {});
      if (!dir) dir = spec.seedDir;
      const violations = spec.structuralViolations(dir);
      const featureMapIssues = validateFeatureMap(
        loadFeatureMap(spec.featuresPath),
        spec.scenarios(),
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
      if (base.worker === "pi") {
        const { apiKey, envKeys } = resolveProviderApiKey(base.model.provider, process.env);
        if (!apiKey)
          throw new Error(
            `worker "pi" with provider ${base.model.provider} requires ${envKeys.join(" or ")} in the environment`,
          );
      }
      const root = values["runs-root"]
        ? resolve(values["runs-root"])
        : mkdtempSync(join(tmpdir(), "horizon-compare-"));
      const result = await compareConfigurations({
        runsRoot: root,
        base: { ...base, segmentRotationCycles: 1 },
        workerFactory: (_configuration, config, paths) => makeWorker(config, paths),
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
      const ledger = await openLedger(config, paths);
      try {
        log(renderProgress(await summarize(ledger, config)));
      } finally {
        await ledger.close();
      }
      return 0;
    }
    case "export": {
      const { config, paths } = loadMission();
      const ledger = await openLedger(config, paths);
      try {
        const out = await exportMission(ledger, config, paths);
        log(`${out.json}\n${out.markdown}`);
      } finally {
        await ledger.close();
      }
      return 0;
    }
    case "live-gate": {
      const { config, paths } = loadMission();
      const ledger = await openLedger(config, paths);
      try {
        const result = await evaluateLiveGate(ledger, config);
        const out = exportLiveGate(result, paths);
        log(renderLiveGate(result));
        log(`${out.json}\n${out.markdown}`);
        return result.passed ? 0 : 2;
      } finally {
        await ledger.close();
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
