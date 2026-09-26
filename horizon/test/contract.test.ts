import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { type MissionConfig, validateMissionConfig } from "../src/mission-contract.ts";
import { EXAMPLE_CONFIG } from "./helpers.ts";

const example = (): MissionConfig =>
  JSON.parse(readFileSync(EXAMPLE_CONFIG, "utf8")) as MissionConfig;

const BUDGET_FIELDS = Object.keys(example().budget) as (keyof MissionConfig["budget"])[];
const BUDGET_COUNTS = new Set<keyof MissionConfig["budget"]>([
  "maxExperiments",
  "maxInputTokens",
  "maxOutputTokens",
  "maxMemoryOperations",
]);
const NON_POSITIVE = [Number.NaN, Number.POSITIVE_INFINITY, -1, 0, "5", null];

function withBudget(field: keyof MissionConfig["budget"], value: unknown): unknown {
  const c = example();
  const budget: Record<string, unknown> = { ...c.budget };
  if (value === undefined) delete budget[field];
  else budget[field] = value;
  return { ...c, budget };
}

function withField(field: keyof MissionConfig, value: unknown): unknown {
  const c: Record<string, unknown> = { ...example() };
  if (value === undefined) delete c[field];
  else c[field] = value;
  return c;
}

test("contract: the example configs validate", () => {
  assert.doesNotThrow(() => validateMissionConfig(example()));
  const live = JSON.parse(
    readFileSync(new URL("../mission.live.example.json", import.meta.url), "utf8"),
  ) as unknown;
  assert.doesNotThrow(() => validateMissionConfig(live));
});

test("contract: every budget field is required, finite and > 0", () => {
  assert.throws(() => validateMissionConfig(withField("budget", undefined)), /budget incomplete/);
  assert.throws(() => validateMissionConfig(withField("budget", null)), /budget incomplete/);
  assert.equal(BUDGET_FIELDS.length, 6);
  for (const field of BUDGET_FIELDS) {
    const rx = new RegExp(`budget\\.${field}`);
    assert.throws(
      () => validateMissionConfig(withBudget(field, undefined)),
      rx,
      `${field} omitted`,
    );
    for (const bad of NON_POSITIVE)
      assert.throws(() => validateMissionConfig(withBudget(field, bad)), rx, `${field}=${bad}`);
  }
});

test("contract: budget counts are integers, durations may be fractional", () => {
  for (const field of BUDGET_FIELDS) {
    const fractional = () => validateMissionConfig(withBudget(field, 1.5));
    if (BUDGET_COUNTS.has(field))
      assert.throws(fractional, new RegExp(`budget\\.${field} must be an integer`), field);
    else assert.doesNotThrow(fractional, field);
  }
});

test("contract: the issue #40 shape (token, memory and cycle budgets omitted) is rejected", () => {
  const c = example();
  const { maxInputTokens: _a, cycleTimeoutMs: _b, maxMemoryOperations: _c, ...rest } = c.budget;
  assert.throws(
    () => validateMissionConfig({ ...c, budget: rest }),
    /invalid mission config: budget\.maxInputTokens/,
  );
});

test("contract: counts are positive integers", () => {
  const counts: (keyof MissionConfig)[] = [
    "contractVersion",
    "requiredImprovedRepetitions",
    "memoryLimitBytes",
    "segmentRotationCycles",
    "stagnationLimit",
  ];
  for (const field of counts) {
    const rx = new RegExp(field);
    for (const bad of [undefined, ...NON_POSITIVE, 1.5])
      assert.throws(() => validateMissionConfig(withField(field, bad)), rx, `${field}=${bad}`);
  }
  assert.doesNotThrow(() => validateMissionConfig(withField("requiredImprovedRepetitions", 1)));
});

test("contract: timeouts are finite and > 0", () => {
  for (const field of ["startupTimeoutMs", "requestTimeoutMs"] as const) {
    const rx = new RegExp(field);
    for (const bad of [undefined, ...NON_POSITIVE])
      assert.throws(() => validateMissionConfig(withField(field, bad)), rx, `${field}=${bad}`);
    assert.doesNotThrow(() => validateMissionConfig(withField(field, 250.5)));
  }
});

test("contract: ratios reject NaN and out-of-range values", () => {
  for (const bad of [undefined, Number.NaN, Number.POSITIVE_INFINITY, -0.1, 0, 1, 1.5, "0.3"])
    assert.throws(
      () => validateMissionConfig(withField("targetP95Reduction", bad)),
      /targetP95Reduction must be in \(0,1\)/,
      `targetP95Reduction=${bad}`,
    );
  for (const bad of [undefined, Number.NaN, Number.POSITIVE_INFINITY, -0.05, 0, 0.049, 1, "0.05"])
    assert.throws(
      () => validateMissionConfig(withField("acceptanceMargin", bad)),
      /acceptanceMargin must be in \[0\.05,1\)/,
      `acceptanceMargin=${bad}`,
    );
  assert.doesNotThrow(() => validateMissionConfig(withField("acceptanceMargin", 0.05)));
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1, 0, 1.01, "1"])
    assert.throws(
      () => validateMissionConfig(withField("maxRepetitionSpread", bad)),
      /maxRepetitionSpread must be in \(0,1\]/,
      `maxRepetitionSpread=${bad}`,
    );
  assert.doesNotThrow(() => validateMissionConfig(withField("maxRepetitionSpread", 1)));
  assert.doesNotThrow(() => validateMissionConfig(withField("maxRepetitionSpread", undefined)));
});
