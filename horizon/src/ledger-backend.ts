import { Ledger } from "./ledger.ts";
import type { AsyncLedger } from "./ledger-contract.ts";
import type { MissionConfig } from "./mission-contract.ts";
import type { MissionPaths } from "./mission-paths.ts";
import { type MongoEnv, readMongoEnv, redactMongoUri } from "./mongo-env.ts";
import { MongoLedger } from "./mongo-ledger.ts";
import { SqliteLedger } from "./sqlite-ledger.ts";

export type LedgerBackend = AsyncLedger["backend"];

export type LedgerSelection =
  | { backend: "sqlite"; source: "config" | "default" }
  | { backend: "mongodb"; source: "config" | "env"; env: MongoEnv };

/**
 * Picks the ledger backend for a mission. An explicit `config.ledger.backend`
 * wins and "mongodb" is an error without `MONGODB_URI` rather than a silent
 * fallback, so a mission never changes backend because the environment moved
 * under it. Without a configured backend the environment decides.
 */
export function selectLedgerBackend(
  config: Pick<MissionConfig, "missionId" | "ledger">,
  env: NodeJS.ProcessEnv = process.env,
): LedgerSelection {
  const mongo = readMongoEnv(env);
  const requested = config.ledger?.backend;
  if (requested === "sqlite") return { backend: "sqlite", source: "config" };
  if (requested === "mongodb") {
    if (!mongo)
      throw new Error(
        `mission ${config.missionId} requires the mongodb ledger but MONGODB_URI is not set`,
      );
    return { backend: "mongodb", source: "config", env: mongo };
  }
  if (mongo) return { backend: "mongodb", source: "env", env: mongo };
  return { backend: "sqlite", source: "default" };
}

export function describeLedgerSelection(selection: LedgerSelection): string {
  if (selection.backend === "sqlite") return `sqlite (${selection.source})`;
  return `mongodb ${redactMongoUri(selection.env.uri)} db=${selection.env.db} (${selection.source})`;
}

/** Opens the mission ledger on the selected backend; SQLite lives at `paths.db`. */
export async function openLedger(
  config: Pick<MissionConfig, "missionId" | "ledger">,
  paths: Pick<MissionPaths, "db">,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AsyncLedger> {
  const selection = selectLedgerBackend(config, env);
  if (selection.backend === "sqlite") return new SqliteLedger(new Ledger(paths.db));
  return MongoLedger.connect(selection.env, config.missionId);
}
