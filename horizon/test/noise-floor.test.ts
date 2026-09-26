import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { BaselineError } from "../src/controller.ts";
import { Ledger } from "../src/ledger.ts";
import { validateMissionConfig } from "../src/mission-contract.ts";
import { repetitionSpread } from "../src/timing-policy.ts";
import { controllerFor, tempRunsRoot, testConfig } from "./helpers.ts";

test("baseline freezes an acceptance margin that covers the measured spread and records it in the ledger", async () => {
  const runs = tempRunsRoot();
  const lines: string[] = [];
  const controller = controllerFor(
    "noise-freeze",
    runs,
    { log: (l) => lines.push(l), maxCycles: 1 },
    {
      acceptanceMargin: 0.05,
      // Every real spread is accepted so the test is deterministic on noisy hardware.
      maxRepetitionSpread: 1,
    },
  );
  await controller.initialize();
  assert.equal((await controller.mission()).frozenAcceptanceMargin, null);
  await controller.run();
  const mission = await controller.mission();
  const perf = (await controller.ledger.listVerifications("noise-freeze")).find(
    (v) => v.experimentId === "exp-baseline-noise-freeze" && v.suite === "performance",
  )!;
  const report = JSON.parse(readFileSync(perf.path, "utf8")) as {
    metrics: { repetitionP95Ms?: number[] };
  };
  const spread = repetitionSpread(report.metrics.repetitionP95Ms);
  const events = await controller.ledger.eventsSince(0, 10000);
  await controller.close();

  assert.ok(mission.frozenAcceptanceMargin !== null, "margin frozen after baseline");
  assert.ok(mission.frozenAcceptanceMargin! >= 0.05, "never below the configured margin");
  assert.ok(mission.frozenAcceptanceMargin! >= spread, "never below the measured spread");
  const assessed = events.find((e) => e.type === "target.assessed")!;
  const payload = assessed.payload as {
    frozenAcceptanceMargin: number;
    marginCoversNoise: boolean;
    marginRaised: boolean;
  };
  assert.equal(payload.frozenAcceptanceMargin, mission.frozenAcceptanceMargin);
  assert.equal(payload.marginCoversNoise, true);
  assert.equal(payload.marginRaised, spread > 0.05);
  assert.ok(lines.some((l) => /acceptance margin frozen at/.test(l)));
  assert.ok(!lines.some((l) => /warning: acceptance margin/.test(l)));

  // The frozen value survives a restart and is what a resumed controller reads.
  const ledger = new Ledger(controller.paths.db);
  assert.equal(
    ledger.getMission("noise-freeze")!.frozenAcceptanceMargin,
    mission.frozenAcceptanceMargin,
  );
  ledger.close();
});

test("baseline noise above the ceiling blocks the mission before optimization instead of warning", async () => {
  const runs = tempRunsRoot();
  const lines: string[] = [];
  const controller = controllerFor(
    "noise-repair",
    runs,
    { log: (l) => lines.push(l) },
    {
      maxRepetitionSpread: 1e-9,
    },
  );
  await controller.initialize();
  await assert.rejects(controller.run(), BaselineError);
  const mission = await controller.mission();
  const experiments = await controller.ledger.listExperiments("noise-repair");
  const tasks = await controller.ledger.listTasks("noise-repair");
  const events = await controller.ledger.eventsSince(0, 10000);
  await controller.close();

  assert.equal(mission.status, "blocked");
  assert.equal(mission.frozenAcceptanceMargin, null);
  assert.equal(mission.baselineP95Ms, null);
  assert.deepEqual(
    experiments.map((e) => e.taskId),
    ["baseline"],
    "no optimization experiment was started",
  );
  assert.equal(experiments[0]!.status, "inconclusive");
  assert.equal(tasks.find((t) => t.taskId === "baseline")!.status, "pending");
  const finished = events.find((e) => e.type === "mission.finished")!;
  assert.match(
    (finished.payload as { detail: string }).detail,
    /repair the workload or environment before optimizing/,
  );
  assert.ok(events.some((e) => e.type === "target.noise_floor_exceeded"));
  assert.ok(!events.some((e) => e.type === "target.assessed"));
});

test("mission config: maxRepetitionSpread is optional and bounded to (0,1]", () => {
  const { maxRepetitionSpread: _ignored, ...base } = testConfig("cfg-spread", {
    acceptanceMargin: 0.05,
  });
  assert.equal(validateMissionConfig(base).maxRepetitionSpread, undefined);
  assert.equal(
    validateMissionConfig({ ...base, maxRepetitionSpread: 0.2 }).maxRepetitionSpread,
    0.2,
  );
  assert.throws(
    () => validateMissionConfig({ ...base, maxRepetitionSpread: 0 }),
    /maxRepetitionSpread/,
  );
  assert.throws(
    () => validateMissionConfig({ ...base, maxRepetitionSpread: 1.5 }),
    /maxRepetitionSpread/,
  );
});

test("ledger: missions created before the frozen margin column migrate on open", () => {
  const runs = tempRunsRoot();
  const path = `${runs}/state.sqlite`;
  const ledger = new Ledger(path);
  ledger.db.exec("ALTER TABLE mission DROP COLUMN frozen_acceptance_margin");
  ledger.close();
  const reopened = new Ledger(path);
  const columns = (
    reopened.db.prepare("PRAGMA table_info(mission)").all() as { name: string }[]
  ).map((c) => c.name);
  reopened.close();
  assert.ok(columns.includes("frozen_acceptance_margin"));
});
