import { Ledger } from "./ledger.ts";
import { type LedgerBackend, type LedgerStore, LedgerUnavailableError, SqliteLedgerStore } from "./ledger-store.ts";
import type { MissionConfig } from "./mission-contract.ts";
import type { MissionPaths } from "./mission-paths.ts";
import { DEFAULT_DB, MongoLedgerStore } from "./mongo-ledger.ts";

export function ledgerBackend(config: MissionConfig): LedgerBackend {
	return config.ledger?.backend ?? "sqlite";
}

export interface MongoSettings {
	uri: string;
	dbName: string;
}

/** Connection settings from the environment; the URI (with credentials) never enters config, manifests or logs. */
export function mongoSettings(config: MissionConfig, env: NodeJS.ProcessEnv = process.env): MongoSettings {
	const uri = env.MONGODB_URI;
	if (!uri) throw new LedgerUnavailableError(`mission ${config.missionId} uses the mongodb ledger but MONGODB_URI is not set; refusing to fall back to SQLite`);
	return { uri, dbName: config.ledger?.database ?? env.MONGODB_DB ?? DEFAULT_DB };
}

/** Opens the one store selected by the mission config. There is no fallback between backends. */
export async function openMissionStore(config: MissionConfig, paths: MissionPaths, env: NodeJS.ProcessEnv = process.env): Promise<LedgerStore> {
	if (ledgerBackend(config) === "sqlite") return new SqliteLedgerStore(new Ledger(paths.db));
	const { uri, dbName } = mongoSettings(config, env);
	return MongoLedgerStore.connect({ uri, dbName, missionId: config.missionId });
}
