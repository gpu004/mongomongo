import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import {
  DEFAULT_RATE_LIMIT_RETRY_MS,
  isRateLimitedProviderError,
  parseRetryAfterMs,
} from "../src/pi-worker.ts";
import { ScriptedWorker } from "../src/scripted-worker.ts";
import {
  providerApiKeyEnv,
  type Worker,
  type WorkerCycleInput,
  type WorkerCycleResult,
  WorkerUnavailableError,
} from "../src/worker.ts";
import { controllerFor, tempRunsRoot } from "./helpers.ts";

const CLI = new URL("../src/cli.ts", import.meta.url).pathname;

/** Pi without a provider credential: the segment cannot even open. */
class NoCredentialWorker implements Worker {
  readonly mode = "pi" as const;
  async openSegment(): Promise<never> {
    throw new WorkerUnavailableError(
      "missing_credential",
      "no API key for provider anthropic; set ANTHROPIC_API_KEY",
    );
  }
  async runCycle(): Promise<WorkerCycleResult> {
    throw new Error("unreachable");
  }
  async closeSegment() {}
  async abort() {}
}

/** Pi whose provider keeps answering 429 after the in-session retries. */
class RateLimitedWorker implements Worker {
  readonly mode = "pi" as const;
  cycles = 0;
  private readonly retryAfterMs: number;
  constructor(retryAfterMs: number) {
    this.retryAfterMs = retryAfterMs;
  }
  async openSegment() {
    return { sessionPath: null, sessionId: "rate-limited" };
  }
  async runCycle(_input: WorkerCycleInput): Promise<WorkerCycleResult> {
    this.cycles += 1;
    throw new WorkerUnavailableError(
      "rate_limited",
      "provider anthropic unavailable after in-session retries: 429 rate_limit_error",
      this.retryAfterMs,
    );
  }
  async closeSegment() {}
  async abort() {}
}

test("a missing provider credential blocks the mission in the ledger instead of leaving it running", async () => {
  const runs = tempRunsRoot();
  const controller = controllerFor("wf-nokey", runs, { worker: new NoCredentialWorker() });
  await controller.initialize();
  const row = await controller.run();
  assert.equal(row.status, "blocked");
  assert.equal(row.nextWakeAt, null);
  const finish = (await controller.ledger.eventsSince(0)).find(
    (e) => e.type === "mission.finished",
  );
  assert.ok(finish);
  assert.match(String((finish.payload as { detail: string }).detail), /ANTHROPIC_API_KEY/);
  // No experiment is left open: the fault surfaced before a cycle was planned.
  const open = (await controller.ledger.listExperiments("wf-nokey")).filter(
    (e) => !["accepted", "rejected", "inconclusive", "interrupted"].includes(e.status),
  );
  assert.deepEqual(open, []);
  assert.equal((await controller.ledger.latestCheckpoint("wf-nokey"))?.missionStatus, "blocked");
  await controller.close();

  // Resume reaches the same durable verdict rather than crashing out.
  const again = controllerFor("wf-nokey", runs, { worker: new NoCredentialWorker() });
  assert.equal((await again.run()).status, "blocked");
  await again.close();
});

test("a rate-limited provider parks the mission in waiting with nextWakeAt; resume honours the wake time", async () => {
  const runs = tempRunsRoot();
  const worker = new RateLimitedWorker(30_000);
  const controller = controllerFor("wf-429", runs, { worker });
  await controller.initialize();
  const before = Date.now();
  const row = await controller.run();
  assert.equal(row.status, "waiting");
  assert.ok(row.nextWakeAt, "nextWakeAt persisted");
  const wake = Date.parse(row.nextWakeAt!);
  assert.ok(wake >= before + 30_000 && wake <= Date.now() + 30_000);
  assert.equal(worker.cycles, 1);
  assert.equal(row.activeTaskId, null);

  const experiments = (await controller.ledger.listExperiments("wf-429")).filter(
    (e) => e.taskId === "optimize-search",
  );
  assert.equal(experiments.length, 1);
  assert.equal(experiments[0]!.status, "interrupted");
  assert.match(experiments[0]!.verdict ?? "", /rate_limit/);
  const waiting = (await controller.ledger.eventsSince(0)).find(
    (e) => e.type === "mission.waiting",
  );
  assert.equal((waiting?.payload as { nextWakeAt: string }).nextWakeAt, row.nextWakeAt);
  assert.equal((await controller.ledger.latestCheckpoint("wf-429"))?.missionStatus, "waiting");
  await controller.close();

  // Resume before the wake time sleeps until it (without billing the wait), then continues normally.
  const slept: number[] = [];
  const resumed = controllerFor("wf-429", runs, {
    worker: new ScriptedWorker(),
    maxCycles: 1,
    sleep: async (ms) => {
      slept.push(ms);
    },
  });
  const wallBefore = (await resumed.mission()).spentWallMs;
  const after = await resumed.run();
  assert.equal(slept.length, 1);
  assert.ok(slept[0]! > 0 && slept[0]! <= 30_000);
  assert.notEqual(after.status, "waiting");
  assert.equal(after.nextWakeAt, null);
  assert.ok(after.spentWallMs - wallBefore < 30_000, "the wait itself is not billed as wall time");
  const later = (await resumed.ledger.listExperiments("wf-429")).filter(
    (e) => e.taskId === "optimize-search",
  );
  assert.equal(later.length, 2);
  assert.notEqual(later[1]!.status, "interrupted");
  await resumed.close();
});

test("a waiting mission whose wake time has passed resumes without sleeping", async () => {
  const runs = tempRunsRoot();
  const first = controllerFor("wf-429-past", runs, { worker: new RateLimitedWorker(0) });
  await first.initialize();
  assert.equal((await first.run()).status, "waiting");
  await first.close();
  const slept: number[] = [];
  const second = controllerFor("wf-429-past", runs, {
    worker: new ScriptedWorker(),
    maxCycles: 1,
    sleep: async (ms) => {
      slept.push(ms);
    },
  });
  const row = await second.run();
  assert.deepEqual(slept, []);
  assert.notEqual(row.status, "waiting");
  await second.close();
});

test("retry-after hints are parsed from provider error text; default applies otherwise", () => {
  assert.equal(parseRetryAfterMs("429 too many requests; retry after 12 seconds"), 12_000);
  assert.equal(parseRetryAfterMs("Retry-After: 3"), 3_000);
  assert.equal(parseRetryAfterMs("retry-after 1500ms"), 1_500);
  assert.equal(parseRetryAfterMs("rate limit; retry after 2 minutes"), 120_000);
  assert.equal(parseRetryAfterMs("overloaded_error"), null);
  assert.equal(DEFAULT_RATE_LIMIT_RETRY_MS, 60_000);
  assert.equal(providerApiKeyEnv("anthropic"), "ANTHROPIC_API_KEY");
  assert.equal(providerApiKeyEnv("openai-codex"), "OPENAI_CODEX_API_KEY");
});

test("Google's wrapped 429 is a rate limit but an invalid API key is not", () => {
  assert.equal(
    isRateLimitedProviderError(
      JSON.stringify({
        error: {
          message: JSON.stringify({ error: { code: 429, status: "RESOURCE_EXHAUSTED" } }),
          code: 429,
          status: "Too Many Requests",
        },
      }),
    ),
    true,
  );
  assert.equal(
    isRateLimitedProviderError('{"error":{"code":400,"status":"INVALID_ARGUMENT"}}'),
    false,
  );
});

test("doctor reports the configured provider's API key next to SUPERMEMORY_API_KEY", () => {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  const missing = execFileSync(process.execPath, [CLI, "doctor"], { env, encoding: "utf8" });
  assert.match(missing, /provider\(anthropic\)\s+no ANTHROPIC_API_KEY/);
  const present = execFileSync(process.execPath, [CLI, "doctor"], {
    env: { ...env, ANTHROPIC_API_KEY: "sk-test" },
    encoding: "utf8",
  });
  assert.match(present, /provider\(anthropic\)\s+ANTHROPIC_API_KEY present/);
});
