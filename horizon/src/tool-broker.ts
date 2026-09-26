import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Operation } from "../verification/reference-model.ts";
import type { Suite, VerificationReport } from "../verification/reports.ts";
import { HostSandbox, resolveWorkspacePath, type Sandbox } from "../verification/sandbox.ts";
import type { ObservedVerification } from "./claim-audit.ts";
import type { FileEvidenceStore } from "./mission-paths.ts";

export interface RecallResult {
  episodeId: string;
  summary: string;
  evidenceIds: string[];
  artifactHash: string;
  filteredOut?: string;
}

export interface BrokerHooks {
  /** Fixed runner on the current candidate workspace snapshot; the broker never scores anything itself. */
  verify(suite: Suite): Promise<{ report: VerificationReport; reportPath: string }>;
  profile(scenario: string): Promise<{ evidenceId: string; summary: string }>;
  recall(query: string, limit: number): Promise<RecallResult[]>;
  proposeRegression(proposal: {
    scenarioId: string;
    invariantId: string;
    description: string;
    sequence: Operation[];
  }): Promise<{ accepted: boolean; reason: string; lessonId?: string }>;
  /** Called on every finalized tool call so the ledger sees events as they happen, not at agent_settled. */
  onToolEvent(name: string, params: unknown, summary: string): void;
}

export interface ExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
  evidenceId: string;
}

const MAX_READ_CHARS = 20000;
const MAX_EXEC_CHARS = 8000;
// Read-only inspection only. Any interpreter (e.g. node) combined with workspace_edit is
// arbitrary host code execution under subprocess isolation — even without `-e`, the worker
// can write a script into the workspace and run it. Running candidate code is the
// verifier's job (verify_candidate), not the worker's.
const ALLOWED_EXEC = new Set(["ls", "cat", "wc", "grep"]);
const DEFAULT_EXEC_MEMORY_BYTES = 512 * 1024 * 1024;

export interface BrokerOptions {
  /** Where workspace commands run. Container missions pass a Docker sandbox; there is no host fallback. */
  sandbox?: Sandbox;
  missionId?: string;
  memoryLimitBytes?: number;
}

/**
 * The only component that touches the candidate workspace or launches candidate
 * processes. Every path is confined to `workspaceDir`; anything else (harness,
 * verification, judge files) is denied by construction, not by convention.
 */
export class ToolBroker {
  readonly workspaceDir: string;
  readonly evidence: FileEvidenceStore;
  readonly hooks: BrokerHooks;
  private readonly deadline: () => number;
  private readonly sandbox: Sandbox;
  private readonly missionId: string;
  private readonly memoryLimitBytes: number;
  private readonly running = new Set<AbortController>();
  /** Every verifier result the worker saw this cycle, in order; used to audit its claim. */
  readonly verifications: ObservedVerification[] = [];
  /** Profiling scenarios the worker ran this cycle; a stagnated cycle must profile before repeating a mechanism. */
  readonly profiles: string[] = [];
  private realWorkspaceRoot: string | undefined;

  constructor(
    workspaceDir: string,
    evidence: FileEvidenceStore,
    hooks: BrokerHooks,
    deadline: () => number,
    options: BrokerOptions = {},
  ) {
    this.workspaceDir = resolve(workspaceDir);
    this.sandbox = options.sandbox ?? new HostSandbox();
    this.missionId = options.missionId ?? "adhoc";
    this.memoryLimitBytes = options.memoryLimitBytes ?? DEFAULT_EXEC_MEMORY_BYTES;
    this.evidence = evidence;
    this.hooks = hooks;
    this.deadline = deadline;
  }

  /** Real path of the workspace root, resolved once (the root itself may sit under a symlinked TMPDIR). */
  private realRoot(): string {
    if (this.realWorkspaceRoot === undefined) {
      try {
        this.realWorkspaceRoot = realpathSync(this.workspaceDir);
      } catch {
        this.realWorkspaceRoot = this.workspaceDir;
      }
    }
    return this.realWorkspaceRoot;
  }

  /** Reject when the deepest existing ancestor of `full` resolves outside the real workspace root (symlink escape). */
  private assertContained(full: string): void {
    let probe = full;
    while (!existsSync(probe)) {
      const parent = dirname(probe);
      if (parent === probe) return;
      probe = parent;
    }
    const rel = relative(this.realRoot(), realpathSync(probe));
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
      throw new Error(`path escapes candidate workspace: ${full}`);
  }

  /** Resolve a workspace-relative path; rejects traversal, absolute paths and symlink escapes. */
  resolveInside(relPath: string): string {
    const full = resolveWorkspacePath(this.workspaceDir, relPath);
    this.assertContained(full);
    return full;
  }

  private checkDeadline(): void {
    if (Date.now() > this.deadline()) throw new Error("cycle deadline exceeded");
  }

  workspaceRead(path: string): { path: string; content: string; truncated: boolean } {
    this.checkDeadline();
    const full = this.resolveInside(path);
    if (!existsSync(full) || statSync(full).isDirectory()) throw new Error(`not a file: ${path}`);
    const content = readFileSync(full, "utf8");
    this.hooks.onToolEvent("workspace_read", { path }, `${content.length} chars`);
    return {
      path,
      content: content.slice(0, MAX_READ_CHARS),
      truncated: content.length > MAX_READ_CHARS,
    };
  }

  workspaceSearch(
    pattern: string,
    maxResults = 50,
  ): { file: string; line: number; text: string }[] {
    this.checkDeadline();
    const regex = new RegExp(pattern);
    const results: { file: string; line: number; text: string }[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir).sort()) {
        if (entry === "node_modules" || entry.startsWith(".")) continue;
        const full = join(dir, entry);
        const stat = lstatSync(full);
        if (stat.isSymbolicLink()) continue;
        if (stat.isDirectory()) walk(full);
        else if (entry.endsWith(".ts") || entry.endsWith(".json") || entry.endsWith(".md")) {
          const lines = readFileSync(full, "utf8").split("\n");
          lines.forEach((text, index) => {
            if (results.length < maxResults && regex.test(text))
              results.push({
                file: relative(this.workspaceDir, full),
                line: index + 1,
                text: text.slice(0, 200),
              });
          });
        }
      }
    };
    walk(this.workspaceDir);
    this.hooks.onToolEvent("workspace_search", { pattern }, `${results.length} hits`);
    return results;
  }

  listFiles(): string[] {
    const out: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir).sort()) {
        if (entry === "node_modules" || entry === ".manifest.json") continue;
        const full = join(dir, entry);
        const stat = lstatSync(full);
        if (stat.isSymbolicLink()) continue;
        if (stat.isDirectory()) walk(full);
        else out.push(relative(this.workspaceDir, full));
      }
    };
    walk(this.workspaceDir);
    return out;
  }

  /** Exact-string replacement or whole-file write. `oldText` must occur exactly once when given. */
  workspaceEdit(
    path: string,
    edit: { oldText: string; newText: string } | { content: string },
  ): { path: string; bytes: number } {
    this.checkDeadline();
    const full = this.resolveInside(path);
    if (!path.startsWith("src/")) throw new Error("edits are limited to src/ inside the candidate");
    let next: string;
    if ("content" in edit) {
      next = edit.content;
    } else {
      if (!existsSync(full)) throw new Error(`not a file: ${path}`);
      const current = readFileSync(full, "utf8");
      const first = current.indexOf(edit.oldText);
      if (first === -1) throw new Error("oldText not found");
      if (current.indexOf(edit.oldText, first + 1) !== -1) throw new Error("oldText is not unique");
      next = current.slice(0, first) + edit.newText + current.slice(first + edit.oldText.length);
    }
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, next);
    this.hooks.onToolEvent("workspace_edit", { path }, `${next.length} chars`);
    return { path, bytes: Buffer.byteLength(next) };
  }

  /** Bounded read-only command in the candidate workspace. Small allowlist; no shell; no interpreters. */
  workspaceExec(command: string, args: string[], timeoutMs: number): Promise<ExecResult> {
    this.checkDeadline();
    if (!ALLOWED_EXEC.has(command))
      return Promise.reject(new Error(`command not allowed: ${command}`));
    try {
      for (const arg of args) {
        if (arg.startsWith("/") || arg.includes("..") || arg.includes("\0"))
          throw new Error(`argument denied: ${arg}`);
        // Non-flag args are file operands; a symlink inside the workspace must not escape it.
        if (!arg.startsWith("-")) this.assertContained(resolve(this.workspaceDir, arg));
      }
    } catch (err) {
      return Promise.reject(err);
    }
    const remaining = Math.max(1000, Math.min(timeoutMs, this.deadline() - Date.now()));
    const abort = new AbortController();
    this.running.add(abort);
    return this.sandbox
      .exec({
        scope: { missionId: this.missionId, operationId: `exec:${randomUUID()}` },
        workspaceDir: this.workspaceDir,
        command,
        args,
        timeoutMs: remaining,
        memoryLimitBytes: this.memoryLimitBytes,
        signal: abort.signal,
      })
      .then((outcome) => {
        const { exitCode, stdout, stderr, timedOut } = outcome;
        const evidenceId = this.evidence.write("exec", {
          command,
          args,
          exitCode,
          stdout,
          stderr,
          timedOut,
          sandbox: this.sandbox.kind,
          sandboxId: outcome.sandboxId,
        });
        const truncated =
          outcome.truncated || stdout.length > MAX_EXEC_CHARS || stderr.length > MAX_EXEC_CHARS;
        this.hooks.onToolEvent(
          "workspace_exec",
          { command, args },
          `exit ${exitCode} ${evidenceId}`,
        );
        return {
          exitCode,
          stdout: stdout.slice(0, MAX_EXEC_CHARS),
          stderr: stderr.slice(0, MAX_EXEC_CHARS),
          truncated,
          timedOut,
          evidenceId,
        };
      })
      .finally(() => this.running.delete(abort));
  }

  async verifyCandidate(suite: Suite): Promise<{
    reportId: string;
    status: string;
    failed: string[];
    metrics: VerificationReport["metrics"];
    infraMessage?: string;
  }> {
    this.checkDeadline();
    const { report } = await this.hooks.verify(suite);
    this.verifications.push({ suite, status: report.status, reportId: report.reportId });
    const failed = report.assertions
      .filter((a) => !a.passed)
      .map((a) => `${a.id}: ${a.detail ?? ""} [${a.evidenceId}]`);
    this.hooks.onToolEvent("verify_candidate", { suite }, `${report.status} ${report.reportId}`);
    const result: {
      reportId: string;
      status: string;
      failed: string[];
      metrics: VerificationReport["metrics"];
      infraMessage?: string;
    } = { reportId: report.reportId, status: report.status, failed, metrics: report.metrics };
    if (report.infraMessage !== undefined) result.infraMessage = report.infraMessage;
    return result;
  }

  async profileCandidate(scenario: string): Promise<{ evidenceId: string; summary: string }> {
    this.checkDeadline();
    const result = await this.hooks.profile(scenario);
    this.profiles.push(scenario);
    this.hooks.onToolEvent("profile_candidate", { scenario }, result.evidenceId);
    return result;
  }

  async recallHistory(query: string, limit = 5): Promise<RecallResult[]> {
    this.checkDeadline();
    const results = await this.hooks.recall(query, Math.min(Math.max(limit, 1), 12));
    this.hooks.onToolEvent("recall_history", { query }, results.map((r) => r.episodeId).join(","));
    return results;
  }

  readEvidence(evidenceId: string): { evidenceId: string; excerpt: string; truncated: boolean } {
    this.checkDeadline();
    const found = this.evidence.read(evidenceId);
    if (!found) throw new Error(`unknown evidence id: ${evidenceId}`);
    this.hooks.onToolEvent("read_evidence", { evidenceId }, `${found.excerpt.length} chars`);
    return found;
  }

  async proposeRegression(proposal: {
    scenarioId: string;
    invariantId: string;
    description: string;
    sequence: Operation[];
  }): Promise<{ accepted: boolean; reason: string; lessonId?: string }> {
    this.checkDeadline();
    const result = await this.hooks.proposeRegression(proposal);
    this.hooks.onToolEvent(
      "propose_regression",
      { scenarioId: proposal.scenarioId },
      result.accepted ? `accepted ${result.lessonId ?? ""}` : `rejected: ${result.reason}`,
    );
    return result;
  }

  /** Deadline or abort: kill anything the worker started. */
  terminateChildren(): void {
    for (const abort of this.running) abort.abort();
    this.running.clear();
  }
}
