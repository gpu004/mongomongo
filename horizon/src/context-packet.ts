export interface PacketBudget {
  total: number;
  pinned: number;
  featureMap: number;
  recent: number;
  retrieved: number;
  next: number;
}

/** Initial allocation from the plan; tunable, but `total` is a hard cap. */
export const DEFAULT_PACKET_BUDGET: PacketBudget = {
  total: 8000,
  pinned: 1500,
  featureMap: 1500,
  recent: 1500,
  retrieved: 2500,
  next: 1000,
};

export interface RetrievedEpisode {
  episodeId: string;
  text: string;
}

export interface PacketInput {
  pinned: string;
  featureMap: string;
  recent: string;
  retrieved: RetrievedEpisode[];
  /** Ranked structured lessons; shares the retrieval allowance and is placed ahead of raw episodes. */
  lessons?: string;
  next: string;
}

export interface ContextPacket {
  text: string;
  tokens: number;
  injectedEpisodeIds: string[];
  droppedEpisodeIds: string[];
  sections: Record<keyof Omit<PacketInput, "retrieved" | "lessons"> | "retrieved", number> & {
    lessons: number;
  };
}

/** Share of the retrieval allowance that ranked lessons may occupy before raw episodes are considered. */
export const LESSONS_SHARE_OF_RETRIEVAL = 0.4;

export class PacketConfigurationError extends Error {}

/** Deterministic estimate; a real tokenizer can replace this without changing the policy. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Builds one request-local packet. Required constraints are never truncated:
 * if the pinned section exceeds its allowance, construction stops with a
 * configuration error rather than dropping a constraint to fit retrieval.
 * Optional sections are trimmed to their allowance; retrieved episodes are
 * included whole, in order, until the retrieval allowance is spent.
 */
export function buildPacket(
  input: PacketInput,
  budget: PacketBudget = DEFAULT_PACKET_BUDGET,
): ContextPacket {
  const pinnedTokens = estimateTokens(input.pinned);
  if (pinnedTokens > budget.pinned) {
    throw new PacketConfigurationError(
      `pinned state needs ${pinnedTokens} tokens but the allowance is ${budget.pinned}; refusing to truncate constraints`,
    );
  }
  const featureMap = trimTo(input.featureMap, budget.featureMap);
  const recent = trimTo(input.recent, budget.recent);
  const next = trimTo(input.next, budget.next);

  const lessons = input.lessons
    ? trimTo(input.lessons, Math.floor(budget.retrieved * LESSONS_SHARE_OF_RETRIEVAL))
    : "";
  const lessonTokens = lessons ? estimateTokens(lessons) : 0;

  const injected: string[] = [];
  const dropped: string[] = [];
  const retrievedParts: string[] = [];
  let retrievedTokens = 0;
  for (const episode of input.retrieved) {
    const cost = estimateTokens(episode.text) + 2;
    if (lessonTokens + retrievedTokens + cost <= budget.retrieved) {
      retrievedParts.push(episode.text);
      retrievedTokens += cost;
      injected.push(episode.episodeId);
    } else {
      dropped.push(episode.episodeId);
    }
  }

  const text = [
    "## Mission state (authoritative)",
    input.pinned,
    "## Feature map and verification procedure",
    featureMap,
    "## Recent results and hypothesis",
    recent,
    ...(lessons ? ["## Performance lessons (ranked, measured, with evidence)", lessons] : []),
    "## Retrieved episodes (historical, with provenance for cross-mission priors)",
    retrievedParts.length > 0 ? retrievedParts.join("\n\n") : "(none)",
    "## Evidence pointers and next action",
    next,
  ].join("\n\n");
  const tokens = estimateTokens(text);
  if (tokens > budget.total) {
    throw new PacketConfigurationError(
      `packet is ${tokens} tokens; total budget is ${budget.total}`,
    );
  }
  return {
    text,
    tokens,
    injectedEpisodeIds: injected,
    droppedEpisodeIds: dropped,
    sections: {
      pinned: pinnedTokens,
      featureMap: estimateTokens(featureMap),
      recent: estimateTokens(recent),
      retrieved: retrievedTokens,
      lessons: lessonTokens,
      next: estimateTokens(next),
    },
  };
}

function trimTo(text: string, tokens: number): string {
  const maxChars = tokens * 4;
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 20))}\n[...truncated]`;
}
