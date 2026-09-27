import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { validateReport, type VerificationReport } from "../verification/reports.ts";
import { type EnvironmentFingerprint, hashEnvironment } from "../verification/runner.ts";
import type { ArtifactStore } from "./artifact-store.ts";
import type { CheckpointRow, ExperimentRow } from "./ledger.ts";
import type { AsyncLedger } from "./ledger-contract.ts";

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
    | "removed_orphaned_container"
    | "environment_drift_accepted";
  experimentId?: string;
  detail: string;
}

/** Frozen identities the resuming process is compared against. */
export interface ExpectedIdentities {
  evaluatorHash: string;
  contractHash: string;
  /** Runtime facts of the resuming process. */
  environment: EnvironmentFingerprint;
  /** Runtime facts recorded when the mission's environment hash was last frozen, if known. */
  frozenEnvironment?: EnvironmentFingerprint | undefined;
}

export type EnvironmentDriftSeverity = "warning" | "invalidating";

export interface EnvironmentDrift {
  severity: EnvironmentDriftSeverity;
  /** Fields of the fingerprint that differ; empty when only the hash is known to differ. */
  changed: (keyof EnvironmentFingerprint)[];
  reason: string;
}

function nodeMajor(version: string): string {
  return version.replace(/^v/, "").split(".")[0] ?? version;
}

/**
 * A host runtime that differs from the frozen one is a warning: under container
 * isolation the candidate never runs on the host, and a Node patch or minor
 * upgrade does not change what the evaluator measures. Drift is invalidating
 * only when it changes what the frozen reports measured: isolation mode or
 * image (which the contract already pins), platform or architecture, or the
 * Node major under subprocess isolation, where the candidate runs on the host.
 */
export function classifyEnvironmentDrift(
  frozen: EnvironmentFingerprint | undefined,
  current: EnvironmentFingerprint,
): EnvironmentDrift | undefined {
  if (frozen && hashEnvironment(frozen) === hashEnvironment(current)) return undefined;
  if (!frozen)
    return {
      severity: "warning",
      changed: [],
      reason:
        "environment hash differs from the frozen mission; the frozen runtime facts were not recorded",
    };
  const changed = (Object.keys(current) as (keyof EnvironmentFingerprint)[]).filter(
    (key) => frozen[key] !== current[key],
  );
  const describe = changed.map((k) => `${k} ${frozen[k]} -> ${current[k]}`).join(", ");
  if (changed.includes("isolation") || changed.includes("containerImage"))
    return { severity: "invalidating", changed, reason: `sandbox changed (${describe})` };
  if (changed.includes("platform") || changed.includes("arch"))
    return { severity: "invalidating", changed, reason: `host platform changed (${describe})` };
  if (
    changed.includes("node") &&
    current.isolation === "subprocess" &&
    nodeMajor(frozen.node) !== nodeMajor(current.node)
  )
    return {
      severity: "invalidating",
      changed,
      reason: `Node major changed under subprocess isolation, where the candidate runs on the host (${describe})`,
    };
  return { severity: "warning", changed, reason: `host runtime changed (${describe})` };
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
export async function recover(
  ledger: AsyncLedger,
  artifacts: ArtifactStore,
  missionId: string,
  reportsDir: string,
  expected: ExpectedIdentities,
  runtime: ContainerRuntime = dockerRuntime,
): Promise<RecoveryOutcome> {
  const actions: RecoveryAction[] = [];
  const mission = await ledger.getMission(missionId);
  if (!mission)
    return {
      checkpoint: undefined,
      replayedEvents: 0,
      actions: [{ kind: "fresh", detail: "no mission row" }],
      activeExperiment: undefined,
    };

  for (const container of await ledger.listLiveContainers(missionId)) {
    const existed = runtime.remove(container.containerName);
    await ledger.transaction(async (tx) => {
      await tx.releaseContainer(container.containerName, "orphan_removed");
      await tx.appendEvent(
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
      `contract hash drift: ledger ${mission.contractHash.slice(0, 12)} vs config ${expected.contractHash.slice(0, 12)}; the frozen objective cannot be amended (operating parameters can, with 'horizon amend')`,
    );
  if (mission.evaluatorHash !== expected.evaluatorHash)
    throw new Error(
      `evaluator hash drift: the verification runner changed since the mission was frozen (${mission.evaluatorHash.slice(0, 12)} -> ${expected.evaluatorHash.slice(0, 12)}); run 'horizon rebaseline --mission ${missionId}' to re-measure the seed and best artifact under the new evaluator`,
    );
  const environmentHash = hashEnvironment(expected.environment);
  if (mission.environmentHash !== environmentHash) {
    const drift = classifyEnvironmentDrift(expected.frozenEnvironment, expected.environment) ?? {
      severity: "warning" as const,
      changed: [],
      reason: "environment hash differs from the frozen mission",
    };
    if (drift.severity === "invalidating")
      throw new Error(
        `environment drift invalidates the frozen measurements: ${drift.reason}; run 'horizon rebaseline --mission ${missionId}' to re-measure under the current runtime`,
      );
    await ledger.transaction(async (tx) => {
      await tx.updateMission(missionId, { environmentHash });
      await tx.appendEvent(
        `environment:${missionId}:${environmentHash}`,
        "environment.drifted",
        missionId,
        {
          from: mission.environmentHash,
          to: environmentHash,
          frozenEnvironment: expected.frozenEnvironment ?? null,
          environment: expected.environment,
          changed: drift.changed,
          reason: drift.reason,
        },
      );
    });
    actions.push({
      kind: "environment_drift_accepted",
      detail: `${drift.reason}; environment hash refrozen ${mission.environmentHash.slice(0, 12)} -> ${environmentHash.slice(0, 12)}`,
    });
  }

  const checkpoint = await ledger.latestCheckpoint(missionId);
  const replayed = checkpoint
    ? (await ledger.eventsSince(checkpoint.lastEventSeq)).length
    : await ledger.lastEventSeq();

  const discarded = await ledger.discardUncommittedSegments(missionId);
  if (discarded > 0)
    actions.push({
      kind: "discarded_uncommitted_segment",
      detail: `${discarded} uncommitted replacement segment(s) discarded; last committed segment stays active`,
    });

  const pendingOutbox = (await ledger.listOutbox(["pending", "submitted", "failed"])).length;
  if (pendingOutbox > 0)
    actions.push({
      kind: "drain_outbox",
      detail: `${pendingOutbox} outbox entries not yet memory_ready`,
    });

  let active: ExperimentRow | undefined;
  const open = (await ledger.listExperiments(missionId)).filter((e) =>
    ["planned", "editing", "snapshot_ready", "evaluating"].includes(e.status),
  );
  for (const experiment of open) {
    switch (experiment.status) {
      case "planned":
      case "editing": {
        await ledger.transaction(async (tx) => {
          await tx.updateExperiment(experiment.experimentId, {
            status: "interrupted",
            verdict: "interrupted during candidate edits",
            finishedAt: new Date().toISOString(),
          });
          await tx.appendEvent(
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
          await ledger.transaction(async (tx) => {
            await tx.updateExperiment(experiment.experimentId, {
              status: "interrupted",
              verdict: "snapshot missing or corrupt",
              finishedAt: new Date().toISOString(),
            });
            await tx.appendEvent(
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
          ? await findFinalizedReports(ledger, experiment, reportsDir)
          : [];
        if (found.length > 0) {
          await ledger.transaction(async (tx) => {
            for (const report of found)
              await tx.insertVerification(
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
          await ledger.updateExperiment(experiment.experimentId, {
            attempt: experiment.attempt + 1,
            status: "snapshot_ready",
          });
        }
        active = await ledger.getExperiment(experiment.experimentId);
        break;
      }
    }
  }

  if (!active && actions.length === 0)
    actions.push({
      kind: "resume_idle",
      detail: checkpoint ? `resuming from ${checkpoint.checkpointId}` : "no checkpoint yet",
    });
  await ledger.appendEvent(
    `recovery:${Date.now()}:${process.pid}`,
    "controller.recovered",
    missionId,
    { checkpointId: checkpoint?.checkpointId ?? null, replayed, actions },
  );
  return { checkpoint, replayedEvents: replayed, actions, activeExperiment: active };
}

/**
 * Finalized (atomically renamed) report files for an experiment that may not
 * have reached the ledger yet: crash between file write and transaction.
 * Partial `.tmp-*` files are ignored, and each report must validate against
 * the frozen identities before it counts.
 */
export async function findFinalizedReports(
  ledger: AsyncLedger,
  experiment: ExperimentRow,
  reportsDir: string,
): Promise<VerificationReport[]> {
  const mission = await ledger.getMission(experiment.missionId);
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
