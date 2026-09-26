import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { validateReport, type VerificationReport } from "../verification/reports.ts";
import type { ArtifactStore } from "./artifact-store.ts";
import type { CheckpointRow, ExperimentRow, Ledger } from "./ledger.ts";

export interface RecoveryAction {
  kind:
    | "fresh"
    | "resume_idle"
    | "interrupted_edit"
    | "reuse_snapshot"
    | "rerun_evaluation"
    | "finish_report_commit"
    | "drain_outbox"
    | "discarded_uncommitted_segment"
    | "removed_orphaned_container";
  experimentId?: string;
  detail: string;
}

/** Minimal container runtime surface used by resume to remove orphans; injectable for tests. */
export interface ContainerRuntime {
  /** Force-remove a container by name; returns true if the runtime reported it existed. */
  remove(containerName: string): boolean;
}

export const dockerRuntime: ContainerRuntime = {
  remove(containerName) {
    try {
      execFileSync("docker", ["rm", "-f", containerName], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  },
};

export interface RecoveryOutcome {
  checkpoint: CheckpointRow | undefined;
  replayedEvents: number;
  actions: RecoveryAction[];
  /** Experiment to continue, if any. */
  activeExperiment: ExperimentRow | undefined;
}

/**
 * Startup reconciliation. Loads the latest checkpoint, replays later durable
 * events, then inspects the active operation and decides what is safe to reuse.
 * Never re-accepts an already accepted artifact; never trusts a file that was
 * not atomically published.
 */
export function recover(
  ledger: Ledger,
  artifacts: ArtifactStore,
  missionId: string,
  reportsDir: string,
  expected: { evaluatorHash: string; environmentHash: string; contractHash: string },
  runtime: ContainerRuntime = dockerRuntime,
): RecoveryOutcome {
  const actions: RecoveryAction[] = [];
  const mission = ledger.getMission(missionId);
  if (!mission)
    return {
      checkpoint: undefined,
      replayedEvents: 0,
      actions: [{ kind: "fresh", detail: "no mission row" }],
      activeExperiment: undefined,
    };

  for (const container of ledger.listLiveContainers(missionId)) {
    const existed = runtime.remove(container.containerName);
    ledger.transaction(() => {
      ledger.releaseContainer(container.containerName, "orphan_removed");
      ledger.appendEvent(
        `recovery:${container.containerName}:orphan-removed`,
        "container.orphan_removed",
        container.experimentId,
        { containerName: container.containerName, existed },
      );
    });
    actions.push({
      kind: "removed_orphaned_container",
      experimentId: container.experimentId,
      detail: `${container.containerName} ${existed ? "was still present and was removed" : "already gone; record closed"}`,
    });
  }

  if (mission.contractHash !== expected.contractHash)
    throw new Error(
      `contract hash drift: ledger ${mission.contractHash.slice(0, 12)} vs config ${expected.contractHash.slice(0, 12)}`,
    );
  if (mission.evaluatorHash !== expected.evaluatorHash)
    throw new Error(
      "evaluator hash drift: the verification runner changed since the mission was frozen",
    );
  if (mission.environmentHash !== expected.environmentHash)
    throw new Error(
      "environment hash drift: node/platform/isolation differs from the frozen mission environment",
    );

  const checkpoint = ledger.latestCheckpoint(missionId);
  const replayed = checkpoint
    ? ledger.eventsSince(checkpoint.lastEventSeq).length
    : ledger.lastEventSeq();

  const discarded = ledger.discardUncommittedSegments(missionId);
  if (discarded > 0)
    actions.push({
      kind: "discarded_uncommitted_segment",
      detail: `${discarded} uncommitted replacement segment(s) discarded; last committed segment stays active`,
    });

  const pendingOutbox = ledger.listOutbox(["pending", "submitted", "failed"]).length;
  if (pendingOutbox > 0)
    actions.push({
      kind: "drain_outbox",
      detail: `${pendingOutbox} outbox entries not yet memory_ready`,
    });

  let active: ExperimentRow | undefined;
  const open = ledger
    .listExperiments(missionId)
    .filter((e) => ["planned", "editing", "snapshot_ready", "evaluating"].includes(e.status));
  for (const experiment of open) {
    switch (experiment.status) {
      case "planned":
      case "editing": {
        ledger.transaction(() => {
          ledger.updateExperiment(experiment.experimentId, {
            status: "interrupted",
            verdict: "interrupted during candidate edits",
            finishedAt: new Date().toISOString(),
          });
          ledger.appendEvent(
            `recovery:${experiment.experimentId}:interrupted`,
            "experiment.interrupted",
            experiment.experimentId,
            { previousStatus: experiment.status },
          );
        });
        actions.push({
          kind: "interrupted_edit",
          experimentId: experiment.experimentId,
          detail: "marked interrupted; workspace will be restored from the parent artifact",
        });
        break;
      }
      case "snapshot_ready": {
        if (
          experiment.candidateArtifactHash &&
          artifacts.verify(experiment.candidateArtifactHash)
        ) {
          actions.push({
            kind: "reuse_snapshot",
            experimentId: experiment.experimentId,
            detail: `snapshot ${experiment.candidateArtifactHash.slice(0, 12)} verifies; evaluation will run`,
          });
          active = experiment;
        } else {
          ledger.transaction(() => {
            ledger.updateExperiment(experiment.experimentId, {
              status: "interrupted",
              verdict: "snapshot missing or corrupt",
              finishedAt: new Date().toISOString(),
            });
            ledger.appendEvent(
              `recovery:${experiment.experimentId}:bad-snapshot`,
              "experiment.interrupted",
              experiment.experimentId,
              {},
            );
          });
          actions.push({
            kind: "interrupted_edit",
            experimentId: experiment.experimentId,
            detail: "snapshot did not verify; interrupted",
          });
        }
        break;
      }
      case "evaluating": {
        const found = experiment.candidateArtifactHash
          ? findFinalizedReports(ledger, experiment, reportsDir)
          : [];
        if (found.length > 0) {
          ledger.transaction(() => {
            for (const report of found)
              ledger.insertVerification(
                report,
                join(
                  reportsDir,
                  experiment.experimentId,
                  `${report.suite}-${report.reportId}.json`,
                ),
              );
          });
          actions.push({
            kind: "finish_report_commit",
            experimentId: experiment.experimentId,
            detail: `${found.length} finalized report(s) found on disk; committing idempotently`,
          });
        } else {
          actions.push({
            kind: "rerun_evaluation",
            experimentId: experiment.experimentId,
            detail: `no finalized matching report; rerun under attempt ${experiment.attempt + 1}`,
          });
          ledger.updateExperiment(experiment.experimentId, {
            attempt: experiment.attempt + 1,
            status: "snapshot_ready",
          });
        }
        active = ledger.getExperiment(experiment.experimentId);
        break;
      }
    }
  }

  if (!active && actions.length === 0)
    actions.push({
      kind: "resume_idle",
      detail: checkpoint ? `resuming from ${checkpoint.checkpointId}` : "no checkpoint yet",
    });
  ledger.appendEvent(`recovery:${Date.now()}:${process.pid}`, "controller.recovered", missionId, {
    checkpointId: checkpoint?.checkpointId ?? null,
    replayed,
    actions,
  });
  return { checkpoint, replayedEvents: replayed, actions, activeExperiment: active };
}

/**
 * Finalized (atomically renamed) report files for an experiment that may not
 * have reached the ledger yet: crash between file write and transaction.
 * Partial `.tmp-*` files are ignored, and each report must validate against
 * the frozen identities before it counts.
 */
export function findFinalizedReports(
  ledger: Ledger,
  experiment: ExperimentRow,
  reportsDir: string,
): VerificationReport[] {
  const mission = ledger.getMission(experiment.missionId);
  if (!mission || !experiment.candidateArtifactHash) return [];
  const dir = join(reportsDir, experiment.experimentId);
  if (!existsSync(dir)) return [];
  const reports: VerificationReport[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith(".json")) continue;
    let parsed: VerificationReport;
    try {
      parsed = JSON.parse(readFileSync(join(dir, name), "utf8")) as VerificationReport;
    } catch {
      continue;
    }
    const check = validateReport(parsed, {
      missionId: mission.missionId,
      experimentId: experiment.experimentId,
      suite: parsed.suite,
      artifactHash: experiment.candidateArtifactHash,
      evaluatorHash: mission.evaluatorHash,
      workloadHash: parsed.workloadHash,
      environmentHash: mission.environmentHash,
    });
    if (check.ok) reports.push(parsed);
  }
  return reports;
}
