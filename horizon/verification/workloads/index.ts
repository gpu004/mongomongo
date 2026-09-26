import type { Operation } from "../reference-model.ts";
import { canonicalJson, sha256 } from "../reports.ts";

export interface WorkloadSpec {
  corpusSize: number;
  seed: number;
  warmupRequests: number;
  measuredRequests: number;
  repetitions: number;
  /** Fraction of measured requests that are mutations (update/delete/insert). */
  mutationRatio: number;
}

export interface Workload {
  spec: WorkloadSpec;
  corpus: Extract<Operation, { op: "insert" }>[];
  /** Requests in schedule order for one repetition; warmup first. */
  schedule: Operation[];
  hash: string;
}

/** Deterministic xorshift32 so corpora are reproducible from `seed` alone. */
export function rng(seed: number): () => number {
  let state = seed >>> 0 || 0x9e3779b9;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x100000000;
  };
}

const WORDS = [
  "alpha",
  "beta",
  "gamma",
  "delta",
  "epsilon",
  "lambda",
  "sigma",
  "omega",
  "database",
  "index",
  "storage",
  "cache",
  "latency",
  "throughput",
  "vector",
  "matrix",
  "tensor",
  "graph",
  "search",
  "query",
  "document",
  "record",
  "field",
  "schema",
  "contract",
  "invariant",
  "mission",
  "worker",
  "memory",
  "episode",
  "artifact",
  "evidence",
  "verify",
  "café",
  "naïve",
  "résumé",
  "Zürich",
  "Ærø",
  "Ångström",
  "coöperate",
  "façade",
];

function pick<T>(random: () => number, items: readonly T[]): T {
  const value = items[Math.floor(random() * items.length)];
  if (value === undefined) throw new Error("empty pick");
  return value;
}

function phrase(random: () => number, min: number, max: number): string {
  const count = min + Math.floor(random() * (max - min + 1));
  const words: string[] = [];
  for (let i = 0; i < count; i++) {
    let word = pick(random, WORDS);
    const roll = random();
    if (roll < 0.15) word = word.toUpperCase();
    else if (roll < 0.3) word = word.normalize("NFD");
    words.push(word);
  }
  return words.join(" ");
}

export function generateWorkload(spec: WorkloadSpec): Workload {
  const random = rng(spec.seed);
  const corpus: Extract<Operation, { op: "insert" }>[] = [];
  for (let i = 0; i < spec.corpusSize; i++) {
    corpus.push({
      op: "insert",
      id: `doc-${i}`,
      title: phrase(random, 2, 5),
      body: phrase(random, 8, 40),
    });
  }
  const hotQueries = Array.from({ length: 12 }, () => phrase(random, 1, 2));
  const schedule: Operation[] = [];
  const total = spec.warmupRequests + spec.measuredRequests;
  let inserted = spec.corpusSize;
  for (let i = 0; i < total; i++) {
    const roll = random();
    if (roll < spec.mutationRatio) {
      const kind = random();
      if (kind < 0.5) {
        schedule.push({
          op: "update",
          id: `doc-${Math.floor(random() * spec.corpusSize)}`,
          body: phrase(random, 8, 40),
        });
      } else if (kind < 0.8) {
        schedule.push({ op: "delete", id: `doc-${Math.floor(random() * spec.corpusSize)}` });
      } else {
        schedule.push({
          op: "insert",
          id: `doc-${inserted++}`,
          title: phrase(random, 2, 5),
          body: phrase(random, 8, 40),
        });
      }
    } else if (roll < spec.mutationRatio + 0.6) {
      schedule.push({ op: "search", q: pick(random, hotQueries), limit: 20 });
    } else if (roll < spec.mutationRatio + 0.9) {
      schedule.push({ op: "search", q: phrase(random, 1, 3), limit: 20 });
    } else {
      schedule.push({ op: "search", q: `nomatch-${Math.floor(random() * 1e6)}` });
    }
  }
  const hash = sha256(canonicalJson({ spec, corpus, schedule }));
  return { spec, corpus, schedule, hash };
}
