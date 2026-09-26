import assert from "node:assert/strict";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { abortableSleep } from "../src/controller.ts";
import { missionPaths } from "../src/mission-paths.ts";
import { clearControl, readControl, writeControl } from "../src/operator-control.ts";
import { ScriptedWorker } from "../src/scripted-worker.ts";
import {
  type Worker,
  type WorkerCycleInput,
  type WorkerCycleResult,
  WorkerUnavailableError,
} from "../src/worker.ts";
import { controllerFor, tempRunsRoot } from "./helpers.ts";

const CLI = new URL("../src/cli.ts", import.meta.url).pathname;

/** Resolves once `proc` has printed a line matching `pattern`, collecting all output meanwhile. */
function waitForLine(proc: ChildProcess, pattern: RegExp, output: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    let done = false;
    const onData = (chunk: Buffer) => {
      output.push(chunk.toString());
      if (!done && pattern.test(output.join(""))) {
        done = true;
        resolve();
      }
    };
    proc.stdout!.on("data", onData);
    proc.stderr!.on("data", onData);
    proc.once("exit", (code, signal) => {
      if (!done)
        reject(
          new Error(`exited (${code ?? signal}) before /${pattern.source}/:\n${output.join("")}`),
        );
    });
  });
}

function exited(proc: ChildProcess): Promise<{ code: number | null; signal: string | null }> {
  return new Promise((resolve) => proc.once("exit", (code, signal) => resolve({ code, signal })));
}

/** Live processes whose command line mentions `needle` (candidate subprocesses run from the mission's runs root). */
function processesMentioning(needle: string): string[] {
  const listing = execFileSync("ps", ["-eo", "pid,ppid,args"], { encoding: "utf8" });
  return listing.split("\n").filter((line) => line.includes(needle) && !line.includes("ps -eo"));
}

test("SIGTERM during a scripted cycle: checkpoint + mission.interrupted, lease released, exit 0, no orphans; resume does not re-spend", async () => {
  const runs = tempRunsRoot();
  const missionId = "sd-sigterm";
  const setup = controllerFor(missionId, runs);
  await setup.initialize();
  await setup.close();
  const paths = missionPaths(missionId, runs);

  const proc = spawn(process.execPath, [CLI, "run", "--mission", missionId, "--runs-root", runs], {
    env: { ...process.env, HORIZON_SHUTDOWN_GRACE_MS: "30000" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output: string[] = [];
  // Baseline is complete and the first optimize-search cycle has begun.
  await waitForLine(proc, /segment 1 open/, output);
  proc.kill("SIGTERM");
  const result = await exited(proc);
  const log = output.join("");
  assert.equal(result.code, 0, log);
  assert.match(log, /SIGTERM: stopping gracefully/);
  assert.match(log, /mission interrupted \(signal\); checkpointed/);
  assert.deepEqual(processesMentioning(paths.root), [], "no orphaned candidate process");

  const inspect = controllerFor(missionId, runs);
  await inspect.open();
  const mission = (await inspect.ledger.getMission(missionId))!;
  assert.equal(mission.status, "interrupted");
  assert.equal(mission.spentExperiments, 1);
  assert.equal(await inspect.ledger.getLease(missionId), undefined, "lease released");
  const events = await inspect.ledger.eventsSince(0);
  const interrupted = events.find((e) => e.type === "mission.interrupted");
  assert.ok(interrupted, "mission.interrupted recorded");
  assert.equal((interrupted.payload as { reason: string }).reason, "signal");
  assert.equal((interrupted.payload as { detail: string }).detail, "SIGTERM");
  const checkpoint = (await inspect.ledger.latestCheckpoint(missionId))!;
  assert.equal(checkpoint.missionStatus, "interrupted");
  assert.equal(checkpoint.activeOperation, "stop:signal");
  const open = (await inspect.ledger.listExperiments(missionId)).filter(
    (e) => e.taskId === "optimize-search",
  );
  assert.equal(open.length, 1);
  assert.ok(
    checkpoint.activeExperimentId === open[0]!.experimentId ||
      (checkpoint.activeExperimentId === null && open[0]!.status !== "evaluating"),
    "checkpoint names the experiment left open, if any",
  );
  const baselineEvaluations = events.filter(
    (e) => e.type === "experiment.evaluating" && e.entityId === `exp-baseline-${missionId}`,
  ).length;
  await inspect.close();

  // Resume: the completed baseline is not re-run, the open experiment is concluded from its
  // durable state, and no additional experiment is planned or charged for it.
  const resumed = controllerFor(missionId, runs, { maxCycles: 1 });
  const row = await resumed.run();
  const after = (await resumed.ledger.listExperiments(missionId)).filter(
    (e) => e.taskId === "optimize-search",
  );
  const afterEvents = await resumed.ledger.eventsSince(0);
  await resumed.close();
  assert.equal(row.spentExperiments, 1, "interrupted experiment is not charged twice");
  assert.equal(after.length, 1);
  assert.equal(after[0]!.experimentId, open[0]!.experimentId);
  assert.ok(["rejected", "accepted", "inconclusive"].includes(after[0]!.status), after[0]!.status);
  assert.equal(
    afterEvents.filter(
      (e) => e.type === "experiment.evaluating" && e.entityId === `exp-baseline-${missionId}`,
    ).length,
    baselineEvaluations,
    "baseline not re-evaluated",
  );
  assert.equal(
    afterEvents.filter((e) => e.type === "experiment.planned").length,
    1,
    "no second experiment planned for the interrupted cycle",
  );
});

test("a second SIGTERM within the grace window forces exit with 128+signal", async () => {
  const runs = tempRunsRoot();
  const missionId = "sd-force";
  const setup = controllerFor(missionId, runs);
  await setup.initialize();
  await setup.close();

  const proc = spawn(process.execPath, [CLI, "run", "--mission", missionId, "--runs-root", runs], {
    env: { ...process.env, HORIZON_SHUTDOWN_GRACE_MS: "60000" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output: string[] = [];
  await waitForLine(proc, /lease: /, output);
  proc.kill("SIGTERM");
  await waitForLine(proc, /SIGTERM: stopping gracefully/, output);
  proc.kill("SIGTERM");
  const result = await exited(proc);
  assert.equal(result.code, 143, output.join(""));
  assert.match(output.join(""), /second signal; forcing exit/);
});

/** Pi whose provider keeps answering 429. */
class RateLimitedWorker implements Worker {
  readonly mode = "pi" as const;
  async openSegment() {
    return { sessionPath: null, sessionId: "rate-limited" };
  }
  async runCycle(_input: WorkerCycleInput): Promise<WorkerCycleResult> {
    throw new WorkerUnavailableError("rate_limited", "429 rate_limit_error", 60 * 60 * 1000);
  }
  async closeSegment() {}
  async abort() {}
}

test("a rate-limit wait is abortable: stop while waiting leaves the mission waiting with its wake time", async () => {
  const runs = tempRunsRoot();
  const missionId = "sd-wait";
  const parked = controllerFor(missionId, runs, { worker: new RateLimitedWorker() });
  await parked.initialize();
  const row = await parked.run();
  assert.equal(row.status, "waiting");
  await parked.close();

  const resumed = controllerFor(missionId, runs, { worker: new RateLimitedWorker() });
  const running = resumed.run();
  // Give run() time to reach the wait, then ask it to stop.
  const untilWaiting = new Promise<void>((resolve) => {
    const tick = setInterval(() => {
      if (resumed.lease) {
        clearInterval(tick);
        resolve();
      }
    }, 10);
  });
  await untilWaiting;
  await abortableSleep(200, new AbortController().signal);
  const started = Date.now();
  await resumed.requestStop({ intent: "stop", source: "signal", reason: "SIGINT" });
  const after = await running;
  assert.ok(Date.now() - started < 5_000, "wait cut short instead of sleeping an hour");
  assert.equal(after.status, "waiting");
  assert.equal(after.nextWakeAt, row.nextWakeAt);
  const events = await resumed.ledger.eventsSince(0);
  const interrupted = events.find((e) => e.type === "mission.interrupted");
  assert.ok(interrupted);
  assert.equal((interrupted.payload as { previousStatus: string }).previousStatus, "waiting");
  assert.equal((await resumed.ledger.latestCheckpoint(missionId))?.missionStatus, "waiting");
  assert.equal(resumed.lease, undefined, "lease released");
  await resumed.close();
});

test("operator pause/resume: pause is honoured between cycles and holds until resume clears it", async () => {
  const runs = tempRunsRoot();
  const missionId = "sd-pause";
  const paths = missionPaths(missionId, runs);
  const setup = controllerFor(missionId, runs);
  await setup.initialize();
  await setup.close();

  writeControl(paths, "pause", "test");
  const paused = controllerFor(missionId, runs);
  const row = await paused.run();
  assert.equal(row.status, "paused");
  assert.equal(paused.stopRequested?.intent, "pause");
  const events = await paused.ledger.eventsSince(0);
  assert.ok(events.find((e) => e.type === "mission.paused"));
  assert.equal((await paused.ledger.latestCheckpoint(missionId))?.missionStatus, "paused");
  await paused.close();
  assert.equal(readControl(paths)?.command, "pause", "pause persists until resume");

  // Still paused on a plain run; `resume` clears the control file first.
  const again = controllerFor(missionId, runs);
  assert.equal((await again.run()).status, "paused");
  await again.close();
  assert.equal(clearControl(paths, "pause"), true);

  const resumed = controllerFor(missionId, runs, { maxCycles: 1 });
  const done = await resumed.run();
  await resumed.close();
  assert.notEqual(done.status, "paused");
  assert.equal(done.spentExperiments, 1);
  assert.equal(existsSync(paths.control), false);
});

test("operator stop: a stop written during a cycle is honoured after it, rests the mission as interrupted and is consumed", async () => {
  const runs = tempRunsRoot();
  const missionId = "sd-stop";
  const paths = missionPaths(missionId, runs);
  const setup = controllerFor(missionId, runs);
  await setup.initialize();
  await setup.close();

  // A stop left over from before this run is stale and must not stop it.
  writeControl(paths, "stop", "stale");
  const worker = new ScriptedWorker();
  const original = worker.runCycle.bind(worker);
  worker.runCycle = async (input) => {
    writeControl(paths, "stop", "test");
    return original(input);
  };
  const controller = controllerFor(missionId, runs, { worker });
  const row = await controller.run();
  assert.equal(row.status, "interrupted");
  assert.equal(
    row.spentExperiments,
    1,
    "the cycle that saw the stop completed; no further cycle started",
  );
  const experiments = (await controller.ledger.listExperiments(missionId)).filter(
    (e) => e.taskId === "optimize-search",
  );
  assert.equal(experiments.length, 1);
  assert.ok(["rejected", "accepted", "inconclusive"].includes(experiments[0]!.status));
  const interrupted = (await controller.ledger.eventsSince(0)).find(
    (e) => e.type === "mission.interrupted",
  );
  assert.ok(interrupted);
  assert.equal((interrupted.payload as { reason: string }).reason, "operator");
  await controller.close();
  assert.equal(existsSync(paths.control), false, "stop consumed");

  const next = controllerFor(missionId, runs, { maxCycles: 1 });
  assert.notEqual((await next.run()).status, "interrupted");
  await next.close();
});
