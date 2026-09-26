import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { openLedger } from "../src/ledger-backend.ts";
import { loadMissionConfig, type MissionConfig } from "../src/mission-contract.ts";
import { missionPaths, writeJsonAtomic } from "../src/mission-paths.ts";

const { values } = parseArgs({
  options: {
    config: { type: "string" },
    out: { type: "string" },
    missions: { type: "string" },
    hours: { type: "string" },
    experiments: { type: "string" },
    "max-runs": { type: "string" },
    "fault-every": { type: "string" },
  },
});

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed < 1)
    throw new Error(`${name} must be a positive integer`);
  return parsed;
}

const configPath = resolve(
  values.config ?? new URL("../mission.example.json", import.meta.url).pathname,
);
const out = resolve(values.out ?? join("runs", `soak-${Date.now()}`));
const hours = values.hours === undefined ? undefined : Number(values.hours);
if (hours !== undefined && (!Number.isFinite(hours) || hours <= 0))
  throw new Error("hours must be a positive number");
const targetExperiments =
  values.experiments === undefined
    ? undefined
    : positiveInteger(values.experiments, 1, "experiments");
const missionCount = positiveInteger(
  values.missions,
  hours !== undefined || targetExperiments !== undefined ? Number.MAX_SAFE_INTEGER : 10,
  "missions",
);
const maxRuns = positiveInteger(values["max-runs"], 8, "max-runs");
const faultEvery = positiveInteger(values["fault-every"], 2, "fault-every");
const base = loadMissionConfig(configPath);
if (base.worker !== "scripted") throw new Error("soak requires a scripted worker config");
if (existsSync(join(out, "samples.jsonl")) || existsSync(join(out, "report.json")))
  throw new Error(`soak output already exists at ${out}`);
mkdirSync(out, { recursive: true });
const runsRoot = join(out, "missions");
mkdirSync(runsRoot, { recursive: true });

function bytes(path: string): number {
  if (!existsSync(path)) return 0;
  const stats = statSync(path);
  if (!stats.isDirectory()) return stats.size;
  return readdirSync(path).reduce((total, name) => total + bytes(join(path, name)), 0);
}

function run(args: string[], expected: number[]): { code: number; ms: number } {
  const started = performance.now();
  const result = spawnSync(
    process.execPath,
    [new URL("../src/cli.ts", import.meta.url).pathname, ...args],
    {
      cwd: new URL("..", import.meta.url).pathname,
      encoding: "utf8",
      timeout: 600_000,
      env: { ...process.env, MONGODB_URI: "", SUPERMEMORY_API_KEY: "" },
    },
  );
  if (result.error) throw result.error;
  if (result.status === null || !expected.includes(result.status))
    throw new Error(
      `horizon ${args.join(" ")} exited ${result.status}: ${result.stderr || result.stdout}`,
    );
  return { code: result.status, ms: Math.round(performance.now() - started) };
}

interface SoakSample {
  missionId: string;
  run: number;
  status: string;
  exitCode: number;
  faultInjected: boolean;
  runMs: number;
  spentExperiments: number;
  workerInputTokens: number;
  usageUncertain: boolean;
  packetTokens: number[];
  retrievalMs: number[];
  recoveryMs: number | null;
  ledgerBytes: number;
  sessionBytes: number;
  artifactBytes: number;
  segments: number;
  checkpoints: number;
  replayedFault: boolean;
}

const samples: SoakSample[] = [];
const suffix = randomUUID().slice(0, 8);
const startedAt = Date.now();
let completedMissions = 0;
let completedExperiments = 0;
for (let i = 0; i < missionCount; i++) {
  if (hours !== undefined && Date.now() - startedAt >= hours * 3_600_000) break;
  if (targetExperiments !== undefined && completedExperiments >= targetExperiments) break;
  const missionId = `soak-${suffix}-${i + 1}`;
  const config: MissionConfig = {
    ...base,
    missionId,
    ledger: { backend: "sqlite" },
    isolation: "subprocess",
    segmentRotationCycles: 1,
    retention: base.retention ?? {
      keepRecentCandidates: 3,
      keepRecentSegments: 2,
      compactEventsAfter: 100,
    },
    memory: { ...base.memory, enabled: true, containerTag: `horizon-${missionId}` },
  };
  const paths = missionPaths(missionId, runsRoot);
  const missionConfigPath = join(out, `${missionId}.json`);
  writeJsonAtomic(missionConfigPath, config);
  run(["mission", "create", "--config", missionConfigPath, "--runs-root", runsRoot], [0]);
  let lastSeq = 0;
  let lastInputTokens = 0;
  let finished = false;
  for (let attempt = 1; attempt <= maxRuns; attempt++) {
    const faultInjected = i % faultEvery === 0 && attempt === 1;
    const result = run(
      [
        "run",
        "--mission",
        missionId,
        "--runs-root",
        runsRoot,
        "--cycles",
        "1",
        ...(faultInjected ? ["--crash-at", "snapshot_ready"] : []),
      ],
      faultInjected ? [3] : [0, 2],
    );
    const ledger = await openLedger(config, paths);
    const mission = await ledger.getMission(missionId);
    const events = await ledger.eventsSince(lastSeq, 100_000);
    lastSeq = await ledger.lastEventSeq();
    const packetTokens = events
      .filter((event) => event.type === "packet.built")
      .map((event) => Number((event.payload as { tokens: number }).tokens));
    const retrievalMs = events
      .filter((event) => event.type === "packet.built")
      .map((event) => (event.payload as { retrievalMs?: number }).retrievalMs)
      .filter((value): value is number => value !== undefined);
    const recoveryMs =
      events
        .filter((event) => event.type === "recovery.measured")
        .map((event) => (event.payload as { durationMs: number }).durationMs)
        .at(-1) ?? null;
    const sample: SoakSample = {
      missionId,
      run: attempt,
      status: mission?.status ?? "missing",
      exitCode: result.code,
      faultInjected,
      runMs: result.ms,
      spentExperiments: mission?.spentExperiments ?? 0,
      workerInputTokens: (mission?.spentInputTokens ?? 0) - lastInputTokens,
      usageUncertain: (mission?.usageUncertain ?? 0) !== 0,
      packetTokens,
      retrievalMs,
      recoveryMs,
      ledgerBytes: bytes(paths.db),
      sessionBytes: bytes(paths.sessions),
      artifactBytes: bytes(paths.artifacts),
      segments: (await ledger.listSegments(missionId)).length,
      checkpoints: await ledger.countCheckpoints(missionId),
      replayedFault: events.some(
        (event) =>
          event.type === "controller.recovered" &&
          (event.payload as { actions: { kind: string }[] }).actions.some(
            (action) => action.kind !== "resume_idle",
          ),
      ),
    };
    await ledger.close();
    lastInputTokens = mission?.spentInputTokens ?? 0;
    samples.push(sample);
    console.log(JSON.stringify(sample));
    appendFileSync(join(out, "samples.jsonl"), `${JSON.stringify(sample)}\n`);
    finished =
      mission?.status === "succeeded" ||
      mission?.status === "budget_exhausted" ||
      mission?.status === "blocked";
    if (finished) break;
  }
  if (!finished) throw new Error(`mission ${missionId} did not finish within ${maxRuns} runs`);
  completedMissions++;
  completedExperiments += samples.at(-1)?.spentExperiments ?? 0;
}

const report = {
  configPath,
  out,
  missions: completedMissions,
  experiments: completedExperiments,
  elapsedMs: Date.now() - startedAt,
  injectedFaults: samples.filter((sample) => sample.faultInjected).length,
  replayedFaults: samples.filter((sample) => sample.replayedFault).length,
  maxPacketTokens: samples.reduce(
    (max, sample) => sample.packetTokens.reduce((peak, tokens) => Math.max(peak, tokens), max),
    0,
  ),
  maxRecoveryMs: samples.reduce((max, sample) => Math.max(max, sample.recoveryMs ?? 0), 0),
  maxLedgerBytes: samples.reduce((max, sample) => Math.max(max, sample.ledgerBytes), 0),
  maxSessionBytes: samples.reduce((max, sample) => Math.max(max, sample.sessionBytes), 0),
  maxArtifactBytes: samples.reduce((max, sample) => Math.max(max, sample.artifactBytes), 0),
  samples: samples.length,
};
writeFileSync(join(out, "samples.json"), JSON.stringify(samples, null, 2));
writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
