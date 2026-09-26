import { randomUUID } from "node:crypto";
import { MongoClient, MongoServerError } from "mongodb";
import { MongoLedger } from "./mongo-ledger.ts";
import { redactMongoUri, type MongoEnv } from "./mongo-env.ts";

export interface MongoProbeResult {
  ok: boolean;
  target: string;
  serverVersion: string | null;
  roundTrip: "ok" | "failed";
  transactions: "ok" | "unsupported" | "failed";
  indexes: "ok" | "missing" | "unchecked";
  missingIndexes: string[];
  cleanedUp: boolean;
  error: string | null;
}

const PROBE_COLLECTION = "doctor_probe";

/**
 * Connects with `MONGODB_URI`/`MONGODB_DB`, writes and reads a disposable
 * record, runs a two-write transaction, ensures the ledger indexes, and removes
 * its own data. Output never includes credentials.
 */
export async function probeMongo(env: MongoEnv, timeoutMs = 5000): Promise<MongoProbeResult> {
  const result: MongoProbeResult = {
    ok: false,
    target: `${redactMongoUri(env.uri)} db=${env.db}`,
    serverVersion: null,
    roundTrip: "failed",
    transactions: "failed",
    indexes: "unchecked",
    missingIndexes: [],
    cleanedUp: false,
    error: null,
  };
  const client = new MongoClient(env.uri, {
    serverSelectionTimeoutMS: timeoutMs,
    appName: "horizon-doctor",
  });
  const probeId = `probe-${randomUUID()}`;
  try {
    await client.connect();
    const db = client.db(env.db);
    const info = (await db.admin().serverInfo()) as { version?: string };
    result.serverVersion = info.version ?? null;

    const probe = db.collection<{ _id: string; probeId: string; at: string }>(PROBE_COLLECTION);
    await probe.insertOne({ _id: probeId, probeId, at: new Date().toISOString() });
    const back = await probe.findOne({ _id: probeId });
    result.roundTrip = back?.probeId === probeId ? "ok" : "failed";

    try {
      await client.withSession((session) =>
        session.withTransaction(async () => {
          await probe.insertOne({ _id: `${probeId}:tx1`, probeId, at: "" }, { session });
          await probe.insertOne({ _id: `${probeId}:tx2`, probeId, at: "" }, { session });
        }),
      );
      const committed = await probe.countDocuments({ probeId });
      result.transactions = committed === 3 ? "ok" : "failed";
    } catch (error) {
      result.transactions = isTransactionUnsupported(error) ? "unsupported" : "failed";
      if (result.transactions === "failed") result.error = redactMongoUri(String(error));
    }

    const ledger = new MongoLedger(client, env.db, probeId);
    await ledger.ensureIndexes();
    result.missingIndexes = await ledger.missingIndexes();
    result.indexes = result.missingIndexes.length === 0 ? "ok" : "missing";

    await probe.deleteMany({ probeId });
    result.cleanedUp = (await probe.countDocuments({ probeId })) === 0;
    result.ok =
      result.roundTrip === "ok" &&
      result.transactions === "ok" &&
      result.indexes === "ok" &&
      result.cleanedUp;
  } catch (error) {
    result.error = redactMongoUri(String(error));
  } finally {
    await client.close().catch(() => {});
  }
  return result;
}

/** Standalone servers reject transactions (code 20); Atlas clusters are replica sets and support them. */
function isTransactionUnsupported(error: unknown): boolean {
  return (
    error instanceof MongoServerError &&
    (error.code === 20 || /replica set|Transaction numbers/i.test(error.message))
  );
}

export function renderMongoProbe(result: MongoProbeResult): string {
  const parts = [
    result.ok ? "ok" : "FAILED",
    result.target,
    result.serverVersion ? `server ${result.serverVersion}` : null,
    `roundtrip=${result.roundTrip}`,
    `transactions=${result.transactions}`,
    result.indexes === "missing"
      ? `missingIndexes=${result.missingIndexes.join(",")}`
      : `indexes=${result.indexes}`,
    `cleanup=${result.cleanedUp ? "ok" : "incomplete"}`,
    result.error ? `error=${result.error}` : null,
  ];
  return parts.filter((p): p is string => p !== null).join(" ");
}
