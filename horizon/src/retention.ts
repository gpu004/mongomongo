import type { ExperimentRow, MissionRow } from "./ledger.ts";

type ArtifactExperiment = Pick<
  ExperimentRow,
  "experimentId" | "candidateArtifactHash" | "parentArtifactHash" | "status" | "createdAt"
>;
type ArtifactMission = Pick<MissionRow, "seedArtifactHash" | "bestArtifactHash">;

export function retainedArtifactHashes(
  mission: ArtifactMission,
  experiments: readonly ArtifactExperiment[],
  keepRecent: number,
): Set<string> {
  if (!Number.isSafeInteger(keepRecent) || keepRecent < 1)
    throw new Error("keepRecent must be a positive integer");
  const keep = new Set<string>();
  if (mission.seedArtifactHash) keep.add(mission.seedArtifactHash);
  if (mission.bestArtifactHash) keep.add(mission.bestArtifactHash);
  const active = new Set(["planned", "editing", "snapshot_ready", "evaluating", "interrupted"]);
  for (const experiment of experiments) {
    if (experiment.status === "accepted" && experiment.candidateArtifactHash)
      keep.add(experiment.candidateArtifactHash);
    if (active.has(experiment.status)) {
      keep.add(experiment.parentArtifactHash);
      if (experiment.candidateArtifactHash) keep.add(experiment.candidateArtifactHash);
    }
  }
  const candidates = [...experiments]
    .filter((experiment) => experiment.candidateArtifactHash)
    .sort(
      (a, b) =>
        b.createdAt.localeCompare(a.createdAt) || b.experimentId.localeCompare(a.experimentId),
    );
  const recent = new Set<string>();
  for (const experiment of candidates) {
    if (recent.size >= keepRecent) break;
    recent.add(experiment.candidateArtifactHash!);
  }
  for (const hash of recent) keep.add(hash);
  return keep;
}
