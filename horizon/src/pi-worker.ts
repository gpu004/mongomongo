import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  type AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { isRetryableAssistantError } from "@earendil-works/pi-ai";
import { type TSchema, Type } from "typebox";
import type { Operation } from "../verification/reference-model.ts";
import type { Suite } from "../verification/reports.ts";
import type { ToolBroker } from "./tool-broker.ts";
import {
  providerApiKeyEnv,
  type SegmentHandle,
  type Worker,
  type WorkerCycleInput,
  type WorkerCycleResult,
  WorkerUnavailableError,
} from "./worker.ts";

/** Wake-up delay when a rate-limited provider does not say how long to wait. */
export const DEFAULT_RATE_LIMIT_RETRY_MS = 60_000;

export interface PiWorkerOptions {
  workspaceDir: string;
  agentDir: string;
  sessionsDir: string;
  skillsDir: string;
  provider: string;
  modelId: string;
  apiKey?: string;
  /** Rotate the Pi session when the context window is this full (0..1). */
  compactionThreshold: number;
}

/** Provider-specific aliases accepted alongside `<PROVIDER>_API_KEY`. */
const PROVIDER_KEY_ALIASES: Record<string, string[]> = {
  google: ["GEMINI_API_KEY"],
};

export function resolveProviderApiKey(
  provider: string,
  env: NodeJS.ProcessEnv,
): { apiKey: string | undefined; envKeys: string[] } {
  const envKeys = [providerApiKeyEnv(provider), ...(PROVIDER_KEY_ALIASES[provider] ?? [])];
  const found = envKeys.find((k) => env[k]);
  return { apiKey: found ? env[found] : undefined, envKeys };
}

const SYSTEM_PROMPT = `You are the Horizon worker for one bounded optimization mission on a small TypeScript document-search service.

Rules that are enforced by the host, not by you:
- You can only read, search and edit files under src/ of the candidate workspace, and run a small allowlist of commands there.
- You cannot change verification, scenarios, the reference model or the mission. The host judges every artifact independently; your own assessment is never authoritative.
- Correctness comes before speed. The frozen contract (NFC normalization, lowercase, whitespace-split terms, every term a substring of title+" "+body, insertion order, limit after ordering, mutations visible immediately) must hold.
- Mutations must go through the DocumentService entry point; the HTTP layer must not touch storage directly.

Work in small steps: read what you need, make one bounded change, run verify_candidate with suite "smoke" then "correctness", and stop when the change is verified or you have learned why it fails. Use recall_history before repeating an approach. When you find a failure that the fixed suites missed, call propose_regression with an operation sequence and the invariant it protects. Finish each turn with a short plain-text summary: hypothesis, what changed, what the verifier said.`;

/**
 * Pi coding agent driven through the public SDK. Built-in tools are disabled;
 * every tool is a thin wrapper over the broker so the same boundary applies
 * whether the worker is Pi or the scripted adapter.
 */
export class PiWorker implements Worker {
  readonly mode = "pi" as const;
  private readonly options: PiWorkerOptions;
  private session: AgentSession | null = null;
  private broker: ToolBroker | null = null;
  private packetText = "";
  private compactions = 0;
  private lastToolText = "";

  constructor(options: PiWorkerOptions) {
    this.options = options;
  }

  async openSegment(_ordinal: number, previous: SegmentHandle | null): Promise<SegmentHandle> {
    mkdirSync(this.options.agentDir, { recursive: true });
    mkdirSync(this.options.sessionsDir, { recursive: true });
    const modelRuntime = await ModelRuntime.create({
      authPath: join(this.options.agentDir, "auth.json"),
      modelsPath: null,
    });
    if (this.options.apiKey)
      await modelRuntime.setRuntimeApiKey(this.options.provider, this.options.apiKey);
    if (!modelRuntime.hasConfiguredAuth(this.options.provider))
      throw new WorkerUnavailableError(
        "missing_credential",
        `no API key for provider ${this.options.provider}; set ${providerApiKeyEnv(this.options.provider)}`,
      );
    const model = modelRuntime.getModel(this.options.provider, this.options.modelId);
    if (!model) throw new Error(`unknown model ${this.options.provider}/${this.options.modelId}`);

    const sessionManager = previous?.sessionPath
      ? SessionManager.open(
          previous.sessionPath,
          this.options.sessionsDir,
          this.options.workspaceDir,
        )
      : SessionManager.create(this.options.workspaceDir, this.options.sessionsDir);
    const resourceLoader = new DefaultResourceLoader({
      cwd: this.options.workspaceDir,
      agentDir: this.options.agentDir,
      noExtensions: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      noSkills: true,
      additionalSkillPaths: [this.options.skillsDir],
      systemPrompt: SYSTEM_PROMPT,
      extensionFactories: [
        { name: "horizon-context", factory: (pi) => this.registerContextExtension(pi) },
      ],
    });
    await resourceLoader.reload();
    const { session } = await createAgentSession({
      cwd: this.options.workspaceDir,
      agentDir: this.options.agentDir,
      model,
      thinkingLevel: "off",
      modelRuntime,
      noTools: "builtin",
      customTools: this.tools(),
      resourceLoader,
      sessionManager,
      settingsManager: SettingsManager.inMemory({
        compaction: { enabled: true, reserveTokens: 16000 },
        retry: { enabled: true, maxRetries: 2 },
      }),
    });
    this.session = session;
    return {
      sessionPath: sessionManager.getSessionFile() ?? null,
      sessionId: sessionManager.getSessionId(),
    };
  }

  private registerContextExtension(pi: ExtensionAPI): void {
    // The packet is injected as the most recent user-visible context on every LLM call,
    // so it survives compaction and the model always sees the authoritative state.
    pi.on("context", (event) => {
      if (!this.packetText) return undefined;
      const messages = event.messages.filter(
        (m) =>
          !(
            m.role === "user" &&
            typeof m.content === "string" &&
            m.content.startsWith("<horizon-packet>")
          ),
      );
      return {
        messages: [
          ...messages,
          {
            role: "user",
            content: `<horizon-packet>\n${this.packetText}\n</horizon-packet>`,
            timestamp: Date.now(),
          },
        ],
      };
    });
    pi.on("session_compact", () => {
      this.compactions += 1;
    });
  }

  async runCycle(input: WorkerCycleInput): Promise<WorkerCycleResult> {
    if (!this.session) throw new Error("segment not open");
    this.broker = input.broker;
    this.packetText = input.packet.text;
    const startCompactions = this.compactions;
    const before = this.session.getSessionStats().tokens;
    let text = "";
    let aborted = false;
    let retriesExhausted: string | null = null;
    const unsubscribe = this.session.subscribe((event) => {
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta")
        text += event.assistantMessageEvent.delta;
      if (event.type === "auto_retry_end" && !event.success)
        retriesExhausted = event.finalError ?? "provider error";
    });
    const timer = setTimeout(
      () => {
        aborted = true;
        void this.session?.abort();
        input.broker.terminateChildren();
      },
      Math.max(1000, input.deadlineAt - Date.now()),
    );
    try {
      const prompt = [
        `Cycle ${input.cycle}. Work on the next action described in the packet.`,
        input.recoveryNote ? `Recovery note: ${input.recoveryNote}` : null,
        "Finish with: HYPOTHESIS: ... / CHANGED: ... / CLAIM: ...",
      ]
        .filter((line): line is string => line !== null)
        .join("\n");
      await this.session.prompt(prompt, { expandPromptTemplates: false });
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("No API key found"))
        throw new WorkerUnavailableError(
          "missing_credential",
          `no API key for provider ${this.options.provider}; set ${providerApiKeyEnv(this.options.provider)}`,
        );
      throw error;
    } finally {
      clearTimeout(timer);
      unsubscribe();
    }
    if (!aborted) {
      const last = this.session.messages.at(-1);
      const providerError =
        last?.role === "assistant" && isRetryableAssistantError(last)
          ? (last.errorMessage ?? retriesExhausted ?? "provider error")
          : last?.role === "assistant" && isRateLimitedProviderError(last.errorMessage ?? "")
            ? last.errorMessage
            : retriesExhausted;
      if (providerError)
        throw new WorkerUnavailableError(
          "rate_limited",
          `provider ${this.options.provider} unavailable after in-session retries: ${providerError}`,
          parseRetryAfterMs(providerError) ?? DEFAULT_RATE_LIMIT_RETRY_MS,
        );
      if (last?.role === "assistant" && last.stopReason === "error")
        throw new Error(
          `Pi model request failed (${this.options.provider}/${this.options.modelId}); inspect the Pi session for details`,
        );
    }
    const after = this.session.getSessionStats().tokens;
    const inputTokens =
      after.input +
      after.cacheRead +
      after.cacheWrite -
      before.input -
      before.cacheRead -
      before.cacheWrite;
    const outputTokens = after.output - before.output;
    const usage = this.session.getContextUsage();
    if (usage?.percent != null && usage.percent >= this.options.compactionThreshold * 100) {
      text += "\n[segment-rotation-requested]";
    }
    return {
      hypothesis: pick(text, "HYPOTHESIS") ?? "(worker did not state a hypothesis)",
      whatChanged: pick(text, "CHANGED") ?? "(worker did not summarize changes)",
      claim: pick(text, "CLAIM") ?? text.slice(-600),
      usage: {
        inputTokens,
        outputTokens,
        uncertain: inputTokens === 0 && outputTokens === 0,
      },
      seededFixture: null,
      aborted,
      compactions: this.compactions - startCompactions,
    };
  }

  needsRotation(): boolean {
    const usage = this.session?.getContextUsage();
    return usage?.percent != null && usage.percent >= this.options.compactionThreshold * 100;
  }

  async closeSegment(): Promise<void> {
    this.session?.dispose();
    this.session = null;
  }

  async abort(): Promise<void> {
    await this.session?.abort();
    this.broker?.terminateChildren();
  }

  private brokerOrThrow(): ToolBroker {
    if (!this.broker) throw new Error("no active cycle");
    return this.broker;
  }

  private tools(): ToolDefinition[] {
    const text = (value: unknown) => ({
      content: [
        {
          type: "text" as const,
          text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
        },
      ],
      details: undefined,
    });
    const guard = async (fn: () => Promise<unknown> | unknown) => {
      try {
        const value = await fn();
        this.lastToolText = typeof value === "string" ? value : JSON.stringify(value);
        return text(value);
      } catch (error) {
        return text(`error: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    const operationSchema = Type.Object({
      op: Type.Union([
        Type.Literal("insert"),
        Type.Literal("update"),
        Type.Literal("delete"),
        Type.Literal("search"),
        Type.Literal("health"),
      ]),
      id: Type.Optional(Type.String()),
      title: Type.Optional(Type.String()),
      body: Type.Optional(Type.String()),
      q: Type.Optional(Type.String()),
      limit: Type.Optional(Type.Number()),
    });
    return [
      defineTool({
        name: "workspace_read",
        label: "Read candidate file",
        description:
          "Read a file inside the candidate workspace (path relative to the workspace root).",
        parameters: Type.Object({ path: Type.String() }),
        execute: async (_id, params) =>
          guard(() => this.brokerOrThrow().workspaceRead(params.path)),
      }),
      defineTool({
        name: "workspace_list",
        label: "List candidate files",
        description: "List all files in the candidate workspace.",
        parameters: Type.Object({}),
        execute: async () => guard(() => this.brokerOrThrow().listFiles()),
      }),
      defineTool({
        name: "workspace_search",
        label: "Search candidate files",
        description: "Regex search over candidate source files.",
        parameters: Type.Object({
          pattern: Type.String(),
          maxResults: Type.Optional(Type.Number()),
        }),
        execute: async (_id, params) =>
          guard(() =>
            this.brokerOrThrow().workspaceSearch(params.pattern, params.maxResults ?? 50),
          ),
      }),
      defineTool({
        name: "workspace_edit",
        label: "Edit candidate file",
        description:
          "Replace one unique occurrence of oldText with newText in a file under src/, or write the whole file when content is given.",
        parameters: Type.Object({
          path: Type.String(),
          oldText: Type.Optional(Type.String()),
          newText: Type.Optional(Type.String()),
          content: Type.Optional(Type.String()),
        }),
        execute: async (_id, params) =>
          guard(() => {
            if (params.content !== undefined)
              return this.brokerOrThrow().workspaceEdit(params.path, { content: params.content });
            if (params.oldText === undefined || params.newText === undefined)
              throw new Error("provide oldText+newText or content");
            return this.brokerOrThrow().workspaceEdit(params.path, {
              oldText: params.oldText,
              newText: params.newText,
            });
          }),
      }),
      defineTool({
        name: "workspace_exec",
        label: "Run command in candidate",
        description:
          "Run an allowlisted read-only command (ls, cat, wc, grep) inside the candidate workspace with a timeout. No shell; no interpreters.",
        parameters: Type.Object({
          command: Type.String(),
          args: Type.Array(Type.String()),
          timeoutMs: Type.Optional(Type.Number()),
        }),
        execute: async (_id, params) =>
          guard(() =>
            this.brokerOrThrow().workspaceExec(
              params.command,
              params.args,
              params.timeoutMs ?? 30000,
            ),
          ),
      }),
      defineTool({
        name: "verify_candidate",
        label: "Verify candidate",
        description:
          "Run the fixed verification suite (smoke, correctness, learned, performance) on the current workspace. The result is authoritative.",
        parameters: Type.Object({
          suite: Type.Union([
            Type.Literal("smoke"),
            Type.Literal("correctness"),
            Type.Literal("learned"),
            Type.Literal("performance"),
          ]),
        }),
        execute: async (_id, params) =>
          guard(() => this.brokerOrThrow().verifyCandidate(params.suite as Suite)),
      }),
      defineTool({
        name: "profile_candidate",
        label: "Profile candidate",
        description:
          "Run a named workload against the current workspace and return timing evidence.",
        parameters: Type.Object({ scenario: Type.String() }),
        execute: async (_id, params) =>
          guard(() => this.brokerOrThrow().profileCandidate(params.scenario)),
      }),
      defineTool({
        name: "recall_history",
        label: "Recall mission history",
        description: "Retrieve bounded past experiment episodes from this mission only.",
        parameters: Type.Object({ query: Type.String(), limit: Type.Optional(Type.Number()) }),
        execute: async (_id, params) =>
          guard(() => this.brokerOrThrow().recallHistory(params.query, params.limit ?? 5)),
      }),
      defineTool({
        name: "read_evidence",
        label: "Read evidence",
        description: "Read a bounded excerpt of a stored evidence record by id.",
        parameters: Type.Object({ evidenceId: Type.String() }),
        execute: async (_id, params) =>
          guard(() => this.brokerOrThrow().readEvidence(params.evidenceId)),
      }),
      defineTool({
        name: "propose_regression",
        label: "Propose regression check",
        description:
          "Propose a declarative regression scenario: an operation sequence plus the invariant id it protects. Expected results are derived by the host.",
        parameters: Type.Object({
          scenarioId: Type.String(),
          invariantId: Type.String(),
          description: Type.String(),
          sequence: Type.Array(operationSchema),
        }),
        execute: async (_id, params) =>
          guard(() =>
            this.brokerOrThrow().proposeRegression({
              ...params,
              sequence: params.sequence as Operation[],
            }),
          ),
      }),
    ];
  }
}

function defineTool<T extends TSchema>(tool: ToolDefinition<T>): ToolDefinition {
  return tool as unknown as ToolDefinition;
}

/** Best-effort `retry-after` / `retry after N s|ms` extraction from a provider error message. */
export function parseRetryAfterMs(message: string): number | null {
  const match =
    /retry[-_ ]after\D{0,4}(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|sec(?:onds?)?|m|min(?:utes?)?)?\b/i.exec(
      message,
    );
  if (!match) return null;
  const value = Number(match[1]);
  const unit = (match[2] ?? "s").toLowerCase();
  const scale =
    unit.startsWith("ms") || unit.startsWith("milli") ? 1 : unit.startsWith("m") ? 60_000 : 1000;
  return Math.round(value * scale);
}

export function isRateLimitedProviderError(message: string): boolean {
  return /(?:"code"\s*:\s*429\b|\bHTTP\s*429\b|\bRESOURCE_EXHAUSTED\b|\brate[_ -]limit(?:ed|_error)?\b)/i.test(
    message,
  );
}

function pick(text: string, label: string): string | undefined {
  const match = new RegExp(`${label}:\\s*([^\\n]+)`).exec(text);
  return match?.[1]?.trim();
}
