export interface MongoEnv {
  uri: string;
  db: string;
}

export const DEFAULT_MONGODB_DB = "horizon_dev";

/**
 * Reads `MONGODB_URI` / `MONGODB_DB`. Returns undefined when no URI is set so
 * callers can fall back to SQLite without touching the network.
 */
export function readMongoEnv(env: NodeJS.ProcessEnv = process.env): MongoEnv | undefined {
  const uri = env.MONGODB_URI?.trim();
  if (!uri) return undefined;
  const db = env.MONGODB_DB?.trim() || DEFAULT_MONGODB_DB;
  return { uri, db };
}

/**
 * Removes `user:password@` from every mongodb URI inside `text`; safe for logs
 * and `doctor` output. Works on bare connection strings and on error messages
 * that embed one.
 */
export function redactMongoUri(text: string): string {
  return text.replace(/(mongodb(?:\+srv)?:\/\/)[^@/\s]+@/gi, "$1");
}
