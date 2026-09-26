import type { ContextPacket } from "./context-packet.ts";
import type { ToolBroker } from "./tool-broker.ts";

export interface WorkerUsage {
	inputTokens: number;
	outputTokens: number;
	/** True when the provider did not report usage and the numbers are estimates. */
	uncertain: boolean;
}

export interface WorkerCycleInput {
	cycle: number;
	packet: ContextPacket;
	broker: ToolBroker;
	deadlineAt: number;
	/** Present on the first cycle after a crash, so the worker knows its last edits may be partial. */
	recoveryNote?: string;
}

export interface WorkerCycleResult {
	hypothesis: string;
	whatChanged: string;
	/** Worker's own account, always labeled model_interpretation until the runner confirms it. */
	claim: string;
	usage: WorkerUsage;
	/** Set when the worker itself applied a labeled fault fixture (scripted worker only). */
	seededFixture: string | null;
	aborted: boolean;
	compactions: number;
}

export interface SegmentHandle {
	sessionPath: string | null;
	sessionId: string;
}

/**
 * One controlled worker. The controller owns the loop, the ledger and all
 * verification; the worker is only asked to run one bounded cycle at a time.
 */
export interface Worker {
	readonly mode: "pi" | "scripted";
	openSegment(segmentOrdinal: number, previous: SegmentHandle | null): Promise<SegmentHandle>;
	runCycle(input: WorkerCycleInput): Promise<WorkerCycleResult>;
	closeSegment(): Promise<void>;
	abort(): Promise<void>;
}
