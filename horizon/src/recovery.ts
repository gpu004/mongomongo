import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { validateReport, type VerificationReport } from "../verification/reports.ts";
import type { ArtifactStore } from "./artifact-store.ts";
import type { Sandbox } from "../verification/sandbox.ts";
import type { CheckpointRow, ExperimentRow } from "./ledger.ts";
import type { LedgerStore } from "./ledger-store.ts";

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
		| "cleanup_sandboxes"
		| "reconcile_operation";
	experimentId?: string;
	detail: string;
}

export interface RecoveryOutcome {
	checkpoint: CheckpointRow | undefined;
	replayedEvents: number;
	actions: RecoveryAction[];
	/** Experiment to continue, if any. */
	activeExperiment: ExperimentRow | undefined;
}

/**
 * Startup reconciliation. Loads the latest checkpoint, replays later durable
 * events, removes sandboxes left by a crashed controller, reconciles unfinished
 * operation intents, then inspects the active experiment and decides what is
 * safe to reuse. Must run while holding the mission lease.
 * Never re-accepts an already accepted artifact; never trusts a file that was
 * not atomically published.
 */
export async function recover(
	ledger: LedgerStore,
	artifacts: ArtifactStore,
	missionId: string,
	reportsDir: string,
	expected: { evaluatorHash: string; environmentHash: string; contractHash: string },
	sandbox?: Sandbox,
): Promise<RecoveryOutcome> {
	const actions: RecoveryAction[] = [];
	const mission = await ledger.getMission(missionId);
	if (!mission) return { checkpoint: undefined, replayedEvents: 0, actions: [{ kind: "fresh", detail: "no mission row" }], activeExperiment: undefined };

	if (mission.contractHash !== expected.contractHash) throw new Error(`contract hash drift: ledger ${mission.contractHash.slice(0, 12)} vs config ${expected.contractHash.slice(0, 12)}`);
	if (mission.evaluatorHash !== expected.evaluatorHash) throw new Error("evaluator hash drift: the verification runner changed since the mission was frozen");
	if (mission.environmentHash !== expected.environmentHash) throw new Error("environment hash drift: node/platform/isolation differs from the frozen mission environment");

	const checkpoint = await ledger.latestCheckpoint(missionId);
	const replayed = checkpoint ? (await ledger.eventsSince(checkpoint.lastEventSeq)).length : await ledger.lastEventSeq();

	const discarded = await ledger.discardUncommittedSegments(missionId);
	if (discarded > 0) actions.push({ kind: "discarded_uncommitted_segment", detail: `${discarded} uncommitted replacement segment(s) discarded; last committed segment stays active` });

	const pendingOutbox = (await ledger.listOutbox(["pending", "submitted", "failed"])).length;
	if (pendingOutbox > 0) actions.push({ kind: "drain_outbox", detail: `${pendingOutbox} outbox entries not yet memory_ready` });

	let active: ExperimentRow | undefined;
	const open = (await ledger.listExperiments(missionId)).filter((e) => ["planned", "editing", "snapshot_ready", "evaluating"].includes(e.status));
	for (const experiment of open) {
		switch (experiment.status) {
			case "planned":
			case "editing": {
				await ledger.transaction(async () => {
					await ledger.updateExperiment(experiment.experimentId, { status: "interrupted", verdict: "interrupted during candidate edits", finishedAt: new Date().toISOString() });
					await ledger.appendEvent(`recovery:${experiment.experimentId}:interrupted`, "experiment.interrupted", experiment.experimentId, { previousStatus: experiment.status });
				});
				actions.push({ kind: "interrupted_edit", experimentId: experiment.experimentId, detail: "marked interrupted; workspace will be restored from the parent artifact" });
				break;
			}
			case "snapshot_ready": {
				if (experiment.candidateArtifactHash && artifacts.verify(experiment.candidateArtifactHash)) {
					actions.push({ kind: "reuse_snapshot", experimentId: experiment.experimentId, detail: `snapshot ${experiment.candidateArtifactHash.slice(0, 12)} verifies; evaluation will run` });
					active = experiment;
				} else {
					await ledger.transaction(async () => {
						await ledger.updateExperiment(experiment.experimentId, { status: "interrupted", verdict: "snapshot missing or corrupt", finishedAt: new Date().toISOString() });
						await ledger.appendEvent(`recovery:${experiment.experimentId}:bad-snapshot`, "experiment.interrupted", experiment.experimentId, {});
					});
					actions.push({ kind: "interrupted_edit", experimentId: experiment.experimentId, detail: "snapshot did not verify; interrupted" });
				}
				break;
			}
			case "evaluating": {
				const found = experiment.candidateArtifactHash ? await findFinalizedReports(ledger, experiment, reportsDir) : [];
				if (found.length > 0) {
					await ledger.transaction(async () => {
						for (const report of found) await ledger.insertVerification(report, join(reportsDir, experiment.experimentId, `${report.suite}-${report.reportId}.json`));
					});
					actions.push({ kind: "finish_report_commit", experimentId: experiment.experimentId, detail: `${found.length} finalized report(s) found on disk; committing idempotently` });
				} else {
					actions.push({ kind: "rerun_evaluation", experimentId: experiment.experimentId, detail: `no finalized matching report; rerun under attempt ${experiment.attempt + 1}` });
					await ledger.updateExperiment(experiment.experimentId, { attempt: experiment.attempt + 1, status: "snapshot_ready" });
				}
				active = await ledger.getExperiment(experiment.experimentId);
				break;
			}
		}
	}

	await reconcileOperations(ledger, missionId, actions, sandbox);

	if (!active && actions.length === 0) actions.push({ kind: "resume_idle", detail: checkpoint ? `resuming from ${checkpoint.checkpointId}` : "no checkpoint yet" });
	await ledger.appendEvent(`recovery:${Date.now()}:${process.pid}`, "controller.recovered", missionId, { checkpointId: checkpoint?.checkpointId ?? null, replayed, actions });
	return { checkpoint, replayedEvents: replayed, actions, activeExperiment: active };
}

/**
 * Finalized (atomically renamed) report files for an experiment that may not
 * have reached the ledger yet: crash between file write and transaction.
 * Partial `.tmp-*` files are ignored, and each report must validate against
 * the frozen identities before it counts.
 */
/**
 * Operation intents still `started` belong to a controller that died mid-way.
 * Every sandbox of the mission is an orphan (the lease guarantees no other
 * controller is running), so all are removed first. A verify intent whose
 * report is committed is completed; anything else is abandoned and redone.
 */
async function reconcileOperations(ledger: LedgerStore, missionId: string, actions: RecoveryAction[], sandbox: Sandbox | undefined): Promise<void> {
	if (sandbox) {
		const removed = await sandbox.cleanupOrphans(missionId);
		if (removed.length > 0) actions.push({ kind: "cleanup_sandboxes", detail: `removed ${removed.length} orphaned sandbox(es): ${removed.join(", ")}` });
	}
	const unfinished = await ledger.listOperations(missionId, ["started"]);
	if (unfinished.length === 0) return;
	const verifications = await ledger.listVerifications(missionId);
	for (const op of unfinished) {
		const committed = op.kind === "verify" ? verifications.filter((v) => v.experimentId === op.experimentId && v.suite === op.detail && (op.resultRef === null || v.reportId === op.resultRef)).at(-1) : undefined;
		const state = committed ? "completed" : "abandoned";
		await ledger.finishOperation(op.operationId, state, committed?.reportId ?? null);
		actions.push({ kind: "reconcile_operation", ...(op.experimentId ? { experimentId: op.experimentId } : {}), detail: `${op.kind} ${op.operationId} -> ${state}${committed ? ` (report ${committed.reportId})` : ""}` });
	}
}

export async function findFinalizedReports(ledger: LedgerStore, experiment: ExperimentRow, reportsDir: string): Promise<VerificationReport[]> {
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
			missionId: mission.missionId, experimentId: experiment.experimentId, suite: parsed.suite, artifactHash: experiment.candidateArtifactHash,
			evaluatorHash: mission.evaluatorHash, workloadHash: parsed.workloadHash, environmentHash: mission.environmentHash,
		});
		if (check.ok) reports.push(parsed);
	}
	return reports;
}
