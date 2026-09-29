import type { MissionSpec } from "../mission-spec.ts";
import { BUNDLE_SIZE } from "./bundle-size.ts";
import { SEARCH_P95 } from "./search-p95.ts";

/** Objective of missions whose configuration has no `missionSpec`. */
export const DEFAULT_MISSION_SPEC = SEARCH_P95.id;

const REGISTRY = new Map<string, MissionSpec>([SEARCH_P95, BUNDLE_SIZE].map((s) => [s.id, s]));

export function missionSpecIds(): string[] {
  return [...REGISTRY.keys()];
}

export function findMissionSpec(id: string): MissionSpec | undefined {
  return REGISTRY.get(id);
}

/** The objective plugin a mission configuration selects. */
export function missionSpecFor(config: { missionSpec?: string | undefined }): MissionSpec {
  const id = config.missionSpec ?? DEFAULT_MISSION_SPEC;
  const spec = REGISTRY.get(id);
  if (!spec) throw new Error(`unknown missionSpec ${id}; known: ${missionSpecIds().join(", ")}`);
  return spec;
}
