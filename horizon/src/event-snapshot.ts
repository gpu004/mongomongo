import { gunzipSync, gzipSync } from "node:zlib";
import type { EventRow } from "./ledger.ts";

export const SNAPSHOT_BATCH_SIZE = 100;

export function encodeEvents(events: readonly EventRow[]): Buffer {
  return gzipSync(Buffer.from(JSON.stringify(events)));
}

export function decodeEvents(bytes: Uint8Array): EventRow[] {
  return JSON.parse(gunzipSync(bytes).toString("utf8")) as EventRow[];
}
