import assert from "node:assert/strict";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { abortableSleep } from "../src/controller.ts";
import { openLedger } from "../src/ledger-backend.ts";
import type { AsyncLedger } from "../src/ledger-contract.ts";
import { missionPaths } from "../src/mission-paths.ts";
import { clearControl, readControl, writeControl } from "../src/operator-control.ts";
import { ScriptedWorker } from "../src/scripted-worker.ts";
import {
  type Worker,
  type WorkerCycleInput,
  type WorkerCycleResult,
  WorkerUnavailableError,
} from "../src/worker.ts";
import { controllerFor, tempRunsRoot, testConfig } from "./helpers.ts";

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

test("operator stop written before startup is honoured at the first boundary, never discarded as stale", async () => {
  const runs = tempRunsRoot();
  const missionId = "sd-stop-startup";
  const paths = missionPaths(missionId, runs);
  const setup = controllerFor(missionId, runs);
  await setup.initialize();
  await setup.close();

  writeControl(paths, "stop", "before-start");
  const controller = controllerFor(missionId, runs);
  const row = await controller.run();
  assert.equal(row.status, "interrupted");
  assert.equal(row.spentExperiments, 0);
  assert.equal((await controller.ledger.latestCheckpoint(missionId))?.missionStatus, "interrupted");
  await controller.close();
  assert.equal(existsSync(paths.control), false, "stop consumed once checkpointed");

  const next = controllerFor(missionId, runs, { maxCycles: 1 });
  assert.notEqual((await next.run()).status, "interrupted");
  await next.close();
});

/** Opens the real ledger but makes the first `mission.interrupted` append fail inside its transaction. */
function crashingOnInterrupt(missionId: string, runs: string): () => Promise<AsyncLedger> {
  return async () => {
    const real = await openLedger(testConfig(missionId), missionPaths(missionId, runs));
    let crashed = false;
    const wrapTx = (tx: AsyncLedger): AsyncLedger =>
      new Proxy(tx, {
        get(target, key, receiver) {
          if (key !== "appendEvent") return Reflect.get(target, key, receiver);
          return (...args: Parameters<AsyncLedger["appendEvent"]>) => {
            if (args[1] === "mission.interrupted" && !crashed) {
              crashed = true;
              throw new Error("simulated crash before the interruption checkpoint committed");
            }
            return target.appendEvent(...args);
          };
        },
      });
    return new Proxy(real, {
      get(target, key, receiver) {
        if (key !== "transaction") return Reflect.get(target, key, receiver);
        return <T>(fn: (tx: AsyncLedger) => Promise<T>) =>
          target.transaction((tx) => fn(wrapTx(tx)));
      },
    });
  };
}

test("a crash before the interruption checkpoint commits keeps the operator stop; the restart honours it", async () => {
  const runs = tempRunsRoot();
  const missionId = "sd-stop-crash";
  const paths = missionPaths(missionId, runs);
  const setup = controllerFor(missionId, runs);
  await setup.initialize();
  await setup.close();

  const worker = new ScriptedWorker();
  const original = worker.runCycle.bind(worker);
  worker.runCycle = async (input) => {
    writeControl(paths, "stop", "test");
    return original(input);
  };
  const crashing = controllerFor(missionId, runs, {
    worker,
    ledger: crashingOnInterrupt(missionId, runs),
  });
  await assert.rejects(crashing.run(), /simulated crash/);
  await crashing.close();
  assert.equal(readControl(paths)?.command, "stop", "stop request survives the crash");
  assert.notEqual((await setupLedger(missionId, runs)).status, "interrupted");

  const restarted = controllerFor(missionId, runs);
  const row = await restarted.run();
  assert.equal(row.status, "interrupted");
  assert.equal(row.spentExperiments, 1, "the completed experiment is not re-run");
  assert.ok((await restarted.ledger.eventsSince(0)).some((e) => e.type === "mission.interrupted"));
  await restarted.close();
  assert.equal(existsSync(paths.control), false, "consumed after the checkpoint committed");
});

async function setupLedger(missionId: string, runs: string) {
  const ledger = await openLedger(testConfig(missionId), missionPaths(missionId, runs));
  try {
    return (await ledger.getMission(missionId))!;
  } finally {
    await ledger.close();
  }
}

test("a newer control request written while stopping is not consumed with the one being honoured", async () => {
  const runs = tempRunsRoot();
  const missionId = "sd-stop-newer";
  const paths = missionPaths(missionId, runs);
  const setup = controllerFor(missionId, runs);
  await setup.initialize();
  await setup.close();

  writeControl(paths, "stop", "first");
  const controller = controllerFor(missionId, runs);
  const original = controller.requestStop.bind(controller);
  controller.requestStop = async (request) => {
    await original(request);
    writeControl(paths, "pause", "second");
  };
  const row = await controller.run();
  assert.equal(row.status, "interrupted");
  await controller.close();
  assert.equal(readControl(paths)?.by, "second", "the later request is still pending");
});

/** Pi whose in-flight prompt rejects when aborted (as `session.prompt()` does), and fails outright otherwise. */
class AbortRejectingWorker implements Worker {
  readonly mode = "pi" as const;
  private reject: ((error: Error) => void) | undefined;
  /** Resolves once `runCycle` is in flight. */
  readonly prompting: Promise<void>;
  private markPrompting!: () => void;
  constructor() {
    this.prompting = new Promise((resolve) => {
      this.markPrompting = resolve;
    });
  }
  async openSegment() {
    return { sessionPath: null, sessionId: "abort-rejecting" };
  }
  runCycle(_input: WorkerCycleInput): Promise<WorkerCycleResult> {
    return new Promise((_resolve, reject) => {
      this.reject = reject;
      this.markPrompting();
    });
  }
  async closeSegment() {}
  protected fail(error: Error) {
    this.reject?.(error);
  }
  async abort() {
    this.fail(new Error("prompt aborted"));
  }
}

test("SIGTERM while Pi is mid-prompt: the abort rejection becomes an interruption checkpoint, not a crash", async () => {
  const runs = tempRunsRoot();
  const missionId = "sd-abort-reject";
  const worker = new AbortRejectingWorker();
  const controller = controllerFor(missionId, runs, { worker });
  await controller.initialize();
  const running = controller.run();
  await worker.prompting;
  await controller.requestStop({ intent: "stop", source: "signal", reason: "SIGTERM" });
  const row = await running;
  assert.equal(row.status, "interrupted");
  const experiments = (await controller.ledger.listExperiments(missionId)).filter(
    (e) => e.taskId === "optimize-search",
  );
  assert.equal(experiments.length, 1);
  assert.equal(experiments[0]!.status, "interrupted");
  assert.match(experiments[0]!.verdict ?? "", /prompt aborted/);
  const events = await controller.ledger.eventsSince(0);
  assert.ok(events.find((e) => e.type === "experiment.interrupted"));
  const interrupted = events.find((e) => e.type === "mission.interrupted");
  assert.ok(interrupted);
  assert.equal((interrupted.payload as { reason: string }).reason, "signal");
  const checkpoint = await controller.ledger.latestCheckpoint(missionId);
  assert.equal(checkpoint?.missionStatus, "interrupted");
  assert.equal(checkpoint?.activeExperimentId, null);
  assert.equal(controller.lease, undefined, "lease released");
  await controller.close();
});

test("a worker failure with no stop pending still propagates", async () => {
  const runs = tempRunsRoot();
  const missionId = "sd-real-failure";
  const worker = new AbortRejectingWorker();
  const controller = controllerFor(missionId, runs, { worker });
  await controller.initialize();
  const running = controller.run();
  await worker.prompting;
  await worker.abort();
  await assert.rejects(running, /prompt aborted/);
  assert.equal(controller.stopRequested, undefined);
  await controller.close();
});

test("SIGTERM during the baseline phase: interruption is checkpointed between suites and the lease released", async () => {
  const runs = tempRunsRoot();
  const missionId = "sd-baseline";
  const controller = controllerFor(missionId, runs);
  await controller.initialize();
  const running = controller.run();
  // Stop as soon as the baseline experiment is being evaluated (i.e. its first suite is running).
  const untilEvaluating = new Promise<void>((resolve) => {
    const tick = setInterval(() => {
      void controller.ledger.listExperiments(missionId).then((rows) => {
        if (rows.some((e) => e.taskId === "baseline" && e.status === "evaluating")) {
          clearInterval(tick);
          resolve();
        }
      });
    }, 10);
  });
  await untilEvaluating;
  await controller.requestStop({ intent: "stop", source: "signal", reason: "SIGTERM" });
  const row = await running;
  assert.equal(row.status, "interrupted");
  assert.equal(row.spentExperiments, 0);
  const events = await controller.ledger.eventsSince(0);
  const interrupted = events.find((e) => e.type === "mission.interrupted");
  assert.ok(interrupted, "mission.interrupted written even though no optimize cycle ran");
  const checkpoint = await controller.ledger.latestCheckpoint(missionId);
  assert.equal(checkpoint?.missionStatus, "interrupted");
  assert.equal(controller.lease, undefined, "lease released");
  await controller.close();

  // Resume finishes the baseline and moves on without a second baseline experiment.
  const resumed = controllerFor(missionId, runs, { maxCycles: 1 });
  const done = await resumed.run();
  assert.notEqual(done.status, "interrupted");
  const baselines = (await resumed.ledger.listExperiments(missionId)).filter(
    (e) => e.taskId === "baseline",
  );
  assert.equal(baselines.length, 1);
  await resumed.close();
});

/** Pi whose in-flight prompt, when aborted, surfaces the abort dressed as a provider fault. */
class UnavailableOnAbortWorker extends AbortRejectingWorker {
  override async abort() {
    this.fail(new WorkerUnavailableError("rate_limited", "429 during abort", 60 * 60 * 1000));
  }
}

test("a stop wins over a provider fault raised by the aborted worker: interrupted, not parked as waiting", async () => {
  const runs = tempRunsRoot();
  const missionId = "sd-abort-unavailable";
  const worker = new UnavailableOnAbortWorker();
  const controller = controllerFor(missionId, runs, { worker });
  await controller.initialize();
  const running = controller.run();
  await worker.prompting;
  await controller.requestStop({ intent: "stop", source: "signal", reason: "SIGTERM" });
  const row = await running;
  assert.equal(row.status, "interrupted");
  assert.equal(row.nextWakeAt, null);
  const events = await controller.ledger.eventsSince(0);
  assert.ok(events.some((e) => e.type === "mission.interrupted"));
  assert.ok(!events.some((e) => e.type === "mission.waiting"), "no rate-limit parking");
  assert.equal((await controller.ledger.latestCheckpoint(missionId))?.missionStatus, "interrupted");
  await controller.close();

  // Without a stop the same fault still parks the mission.
  const parked = controllerFor("sd-unavailable-plain", runs, { worker: new RateLimitedWorker() });
  await parked.initialize();
  assert.equal((await parked.run()).status, "waiting");
  await parked.close();
});

test("SIGTERM during the holdout phase: checkpoint + mission.interrupted, lease released; resume finishes without repeating experiments", async () => {
  const runs = tempRunsRoot();
  const missionId = "sd-holdout";
  const controller = controllerFor(missionId, runs);
  await controller.initialize();
  const running = controller.run();
  const untilHoldout = new Promise<void>((resolve) => {
    const tick = setInterval(() => {
      void controller.ledger.listExperiments(missionId).then((rows) => {
        if (rows.some((e) => e.taskId === "holdout" && e.status === "evaluating")) {
          clearInterval(tick);
          resolve();
        }
      });
    }, 5);
  });
  await untilHoldout;
  await controller.requestStop({ intent: "stop", source: "signal", reason: "SIGTERM" });
  const row = await running;
  assert.equal(row.status, "interrupted");
  const before = await controller.ledger.listExperiments(missionId);
  const holdouts = before.filter((e) => e.taskId === "holdout");
  assert.equal(holdouts.length, 1);
  const events = await controller.ledger.eventsSince(0);
  assert.ok(events.some((e) => e.type === "mission.interrupted"));
  assert.equal((await controller.ledger.latestCheckpoint(missionId))?.missionStatus, "interrupted");
  assert.equal(controller.lease, undefined, "lease released");
  await controller.close();

  const resumed = controllerFor(missionId, runs);
  const done = await resumed.run();
  assert.equal(done.status, "succeeded");
  assert.equal(done.spentExperiments, row.spentExperiments, "no optimize experiment re-spent");
  const after = await resumed.ledger.listExperiments(missionId);
  assert.equal(after.length, before.length, "no experiment planned twice");
  assert.equal(after.filter((e) => e.taskId === "holdout").length, 1);
  assert.equal(after.find((e) => e.taskId === "holdout")!.status, "accepted");
  await resumed.close();
});
