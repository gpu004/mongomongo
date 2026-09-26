import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Scenario } from "../verification/scenarios/index.ts";

export interface FeatureMap {
  schemaVersion: number;
  contractVersion: number;
  layers: Record<string, string>;
  features: { id: string; name: string; invariants: string[]; scenarios: string[] }[];
  invariants: Record<string, string>;
  verificationOrder: string[];
}

const SUITES = new Set(["structural", "smoke", "correctness", "learned", "performance", "holdout"]);

export function loadFeatureMap(path: string): FeatureMap {
  return JSON.parse(readFileSync(path, "utf8")) as FeatureMap;
}

/**
 * Checks that every reference in the feature map resolves: invariants are
 * defined and owned by a feature, listed scenarios exist and exercise the
 * invariants of the feature that lists them, layer paths exist in the seed,
 * and the verification order names real suites. Structural invariants are
 * enforced by the structural suite and need no scenario.
 */
export function validateFeatureMap(
  map: FeatureMap,
  scenarios: Scenario[],
  seedDir: string,
): string[] {
  const issues: string[] = [];
  const scenarioById = new Map(scenarios.map((s) => [s.scenarioId, s]));
  const owned = new Set<string>();
  const listed = new Set<string>();
  for (const feature of map.features) {
    for (const invariant of feature.invariants) {
      if (!(invariant in map.invariants))
        issues.push(`${feature.id}: invariant ${invariant} is not defined`);
      owned.add(invariant);
    }
    for (const scenarioId of feature.scenarios) {
      listed.add(scenarioId);
      const scenario = scenarioById.get(scenarioId);
      if (!scenario) {
        issues.push(`${feature.id}: scenario ${scenarioId} does not exist`);
        continue;
      }
      if (!scenario.invariantIds.some((i) => feature.invariants.includes(i)))
        issues.push(
          `${feature.id}: scenario ${scenarioId} exercises none of the feature's invariants`,
        );
    }
  }
  for (const invariant of Object.keys(map.invariants)) {
    if (!owned.has(invariant)) issues.push(`invariant ${invariant} belongs to no feature`);
    if (invariant.startsWith("STRUCT-")) continue;
    if (!scenarios.some((s) => s.invariantIds.includes(invariant)))
      issues.push(`invariant ${invariant} has no scenario`);
  }
  for (const scenario of scenarios) {
    for (const invariant of scenario.invariantIds)
      if (!(invariant in map.invariants))
        issues.push(`scenario ${scenario.scenarioId}: invariant ${invariant} is not defined`);
    if (!scenario.origin && !listed.has(scenario.scenarioId))
      issues.push(`scenario ${scenario.scenarioId} is not listed by any feature`);
  }
  for (const [layer, description] of Object.entries(map.layers)) {
    const path = /src\/[\w\-./]+/.exec(description)?.[0];
    if (!path) issues.push(`layer ${layer}: no src/ path in description`);
    else if (!existsSync(join(seedDir, path)))
      issues.push(`layer ${layer}: ${path} does not exist in the seed`);
  }
  for (const suite of map.verificationOrder)
    if (!SUITES.has(suite)) issues.push(`verificationOrder: unknown suite ${suite}`);
  return issues;
}
