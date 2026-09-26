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

export type WorkerFaultKind = "missing_credential" | "rate_limited";

/**
 * The worker cannot run through no fault of the candidate: a missing provider
 * credential blocks the mission; a rate limit parks it in `waiting` until
 * `retryAfterMs` has elapsed.
 */
export class WorkerUnavailableError extends Error {
  readonly kind: WorkerFaultKind;
  readonly retryAfterMs: number | null;

  constructor(kind: WorkerFaultKind, message: string, retryAfterMs: number | null = null) {
    super(message);
    this.name = "WorkerUnavailableError";
    this.kind = kind;
    this.retryAfterMs = retryAfterMs;
  }
}

/** Environment variable the Pi worker reads the provider credential from, e.g. `ANTHROPIC_API_KEY`. */
export function providerApiKeyEnv(provider: string): string {
  return `${provider.toUpperCase().replace(/-/g, "_")}_API_KEY`;
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
