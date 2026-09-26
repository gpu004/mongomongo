import { existsSync, readFileSync, rmSync } from "node:fs";
import type { MissionPaths } from "./mission-paths.ts";
import { writeJsonAtomic } from "./mission-paths.ts";

export type ControlCommand = "stop" | "pause";

export interface ControlRequest {
  command: ControlCommand;
  requestedAt: string;
  by: string;
}

/**
 * Operator intent for a mission, written by `horizon stop|pause` and polled by the
 * running controller between cycles (and during a rate-limit wait). `stop` is
 * consumed by the controller that honours it; `pause` persists until `horizon resume`.
 */
export function readControl(paths: MissionPaths): ControlRequest | undefined {
  if (!existsSync(paths.control)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(paths.control, "utf8")) as Partial<ControlRequest>;
    if (parsed.command !== "stop" && parsed.command !== "pause") return undefined;
    return {
      command: parsed.command,
      requestedAt: typeof parsed.requestedAt === "string" ? parsed.requestedAt : "",
      by: typeof parsed.by === "string" ? parsed.by : "",
    };
  } catch {
    return undefined;
  }
}

export function writeControl(paths: MissionPaths, command: ControlCommand, by: string): void {
  const request: ControlRequest = { command, requestedAt: new Date().toISOString(), by };
  writeJsonAtomic(paths.control, request);
}

/** Removes the control file when it carries `command` (or any command when omitted). */
export function clearControl(paths: MissionPaths, command?: ControlCommand): boolean {
  const current = readControl(paths);
  if (!current || (command && current.command !== command)) return false;
  rmSync(paths.control, { force: true });
  return true;
}
