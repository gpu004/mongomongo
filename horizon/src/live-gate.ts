import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EventRow, Ledger } from "./ledger.ts";
import type { MissionConfig } from "./mission-contract.ts";
import type { MissionPaths } from "./mission-paths.ts";
import { writeJsonAtomic } from "./mission-paths.ts";

/**
 * The live-mission acceptance gate from plan.md §5 / HACKATHON_PLAN.md §21, evaluated
 * from the ledger alone: no field below is taken from worker prose, only from rows the
 * controller wrote after independent verification.
 */
export interface GateCheck {
  id:
    | "worker_is_pi"
    | "usage_reported"
    | "baseline_measured"
    | "model_candidate_verified"
    | "interrupt_and_resume"
    | "episode_retrieved_after_rotation"
    | "holdout_passed"
    | "mission_succeeded";
  passed: boolean;
  detail: string;
}

export interface LiveGateResult {
  missionId: string;
  worker: MissionConfig["worker"];
  model: MissionConfig["model"];
  passed: boolean;
  checks: GateCheck[];
}

function allEvents(ledger: Ledger): EventRow[] {
  const out: EventRow[] = [];
  let seq = 0;
  for (;;) {
    const batch = ledger.eventsSince(seq, 1000);
    if (batch.length === 0) return out;
    out.push(...batch);
    seq = batch[batch.length - 1]!.seq;
  }
}

function payload<T extends object>(event: EventRow): Partial<T> {
  return (event.payload ?? {}) as Partial<T>;
}

export function evaluateLiveGate(ledger: Ledger, config: MissionConfig): LiveGateResult {
  const missionId = config.missionId;
  const mission = ledger.getMission(missionId);
  const tasks = ledger.listTasks(missionId);
  const experiments = ledger.listExperiments(missionId);
  const verifications = ledger.listVerifications(missionId);
  const episodes = ledger.listEpisodes(missionId);
  const events = allEvents(ledger);
  const checks: GateCheck[] = [];

  const workerExperiments = experiments.filter((e) => e.taskId === "optimize-search");
  const modelExperiments = workerExperiments.filter((e) => e.strategy === "pi");
  const scriptedExperiments = workerExperiments.filter((e) => e.strategy !== "pi");
  checks.push({
    id: "worker_is_pi",
    passed:
      config.worker === "pi" && modelExperiments.length > 0 && scriptedExperiments.length === 0,
    detail: `config worker=${config.worker}; experiments by strategy: pi=${modelExperiments.length}, other=${scriptedExperiments.length}`,
  });

  checks.push({
    id: "usage_reported",
    passed: mission !== undefined && mission.usageUncertain === 0 && mission.spentInputTokens > 0,
    detail: mission
      ? `tokens in/out ${mission.spentInputTokens}/${mission.spentOutputTokens}${mission.usageUncertain ? " (estimated, no provider usage report)" : " (provider-reported)"}`
      : "mission not initialized",
  });

  checks.push({
    id: "baseline_measured",
    passed:
      tasks.find((t) => t.taskId === "baseline")?.status === "done" &&
      mission?.baselineP95Ms != null,
    detail: `baseline task ${tasks.find((t) => t.taskId === "baseline")?.status ?? "missing"}; baseline p95 ${mission?.baselineP95Ms ?? "n/a"}ms`,
  });

  const seeded = new Set(
    events
      .filter(
        (e) =>
          e.type === "experiment.snapshot" &&
          payload<{ seededFixture: string | null }>(e).seededFixture,
      )
      .map((e) => e.entityId),
  );
  const verifiedCandidates = modelExperiments.filter((e) => {
    if (!e.candidateArtifactHash || seeded.has(e.experimentId)) return false;
    const passedSuites = new Set(
      verifications
        .filter((v) => v.artifactHash === e.candidateArtifactHash && v.status === "passed")
        .map((v) => v.suite),
    );
    return ["smoke", "correctness", "performance"].every((s) => passedSuites.has(s));
  });
  checks.push({
    id: "model_candidate_verified",
    passed: verifiedCandidates.length > 0,
    detail:
      verifiedCandidates.length > 0
        ? `model-authored candidates passing smoke+correctness+performance: ${verifiedCandidates.map((e) => `${e.experimentId} (${e.candidateArtifactHash!.slice(0, 12)}, ${e.status})`).join(", ")}`
        : `no pi experiment has a non-seeded candidate with passed smoke, correctness and performance reports (pi experiments: ${modelExperiments.length})`,
  });

  const resumes = events.filter(
    (e) =>
      e.type === "controller.recovered" &&
      payload<{ checkpointId: string | null }>(e).checkpointId != null,
  );
  const interrupted = events.filter((e) => e.type === "experiment.interrupted");
  checks.push({
    id: "interrupt_and_resume",
    passed: resumes.length > 0,
    detail: `${resumes.length} launch(es) recovered from a checkpoint; ${interrupted.length} interrupted experiment(s) reconciled`,
  });

  const segmentOf = new Map(experiments.map((e) => [e.experimentId, e.segmentOrdinal]));
  const episodeSegment = new Map(
    episodes.map((ep) => [ep.episodeId, segmentOf.get(ep.experimentId) ?? null]),
  );
  const rotations = events.filter(
    (e) =>
      e.type === "segment.opened" && payload<{ rotatedFrom: number | null }>(e).rotatedFrom != null,
  );
  const crossSegmentRetrievals: string[] = [];
  for (const e of events.filter((e) => e.type === "packet.built")) {
    const target = segmentOf.get(e.entityId);
    if (target === undefined) continue;
    for (const id of payload<{ injected: string[] }>(e).injected ?? []) {
      const source = episodeSegment.get(id);
      if (source != null && source < target)
        crossSegmentRetrievals.push(
          `${id} (segment ${source}) -> ${e.entityId} (segment ${target})`,
        );
    }
  }
  checks.push({
    id: "episode_retrieved_after_rotation",
    passed: rotations.length > 0 && crossSegmentRetrievals.length > 0,
    detail:
      crossSegmentRetrievals.length > 0
        ? `${rotations.length} rotation(s); retrieved across segments: ${crossSegmentRetrievals.slice(0, 5).join("; ")}`
        : `${rotations.length} rotation(s); no packet injected an episode from an earlier segment`,
  });

  const holdout = tasks.find((t) => t.taskId === "holdout");
  const holdoutReports = verifications.filter(
    (v) => v.suite === "holdout" && v.status === "passed",
  );
  checks.push({
    id: "holdout_passed",
    passed: holdout?.status === "done",
    detail: `holdout task ${holdout?.status ?? "missing"}; passed holdout reports on: ${holdoutReports.map((v) => v.artifactHash.slice(0, 12)).join(", ") || "none"}`,
  });

  checks.push({
    id: "mission_succeeded",
    passed: mission?.status === "succeeded",
    detail: `mission status ${mission?.status ?? "n/a"}; best p95 ${mission?.bestP95Ms ?? "n/a"}ms vs baseline ${mission?.baselineP95Ms ?? "n/a"}ms`,
  });

  return {
    missionId,
    worker: config.worker,
    model: config.model,
    passed: checks.every((c) => c.passed),
    checks,
  };
}

export function renderLiveGate(result: LiveGateResult): string {
  const lines = [
    `Live-mission gate for ${result.missionId} (worker ${result.worker}, model ${result.model.provider}/${result.model.id}): ${result.passed ? "PASSED" : "NOT MET"}`,
  ];
  for (const c of result.checks)
    lines.push(`  [${c.passed ? "pass" : "FAIL"}] ${c.id.padEnd(33)} ${c.detail}`);
  return lines.join("\n");
}

/** Writes exports/live-gate.{json,md}; returns the file paths. */
export function exportLiveGate(
  result: LiveGateResult,
  paths: MissionPaths,
): { json: string; markdown: string } {
  mkdirSync(paths.exports, { recursive: true });
  const json = join(paths.exports, "live-gate.json");
  const markdown = join(paths.exports, "live-gate.md");
  writeJsonAtomic(json, { evaluatedAt: new Date().toISOString(), ...result });
  writeFileSync(
    `${markdown}.tmp`,
    `# Live-mission gate\n\n\`\`\`\n${renderLiveGate(result)}\n\`\`\`\n`,
  );
  renameSync(`${markdown}.tmp`, markdown);
  return { json, markdown };
}
