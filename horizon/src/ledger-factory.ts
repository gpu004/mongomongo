import { type Ledger, SqliteLedger } from "./ledger.ts";
import type { MissionConfig } from "./mission-contract.ts";
import type { MissionPaths } from "./mission-paths.ts";
import { MongoLedger, mongoSettingsFromEnv } from "./mongo-ledger.ts";

/**
 * Opens the durable-state backend named by the mission config: the SQLite file
 * under the mission directory by default, or MongoDB when
 * `ledger.backend === "mongodb"` (connection string from MONGODB_URI).
 */
export async function openLedger(
  config: MissionConfig,
  paths: MissionPaths,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Ledger> {
  const backend = config.ledger?.backend ?? "sqlite";
  if (backend === "sqlite") return new SqliteLedger(paths.db);
  const settings = mongoSettingsFromEnv(env, config.ledger?.database);
  return MongoLedger.connect(settings, { missionId: config.missionId });
}
