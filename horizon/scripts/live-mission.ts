// Runs the plan.md demo sequence end to end and then judges the run with `live-gate`:
//   mission create -> run (interrupted at --crash-at) -> resume to completion -> export -> live-gate
// Exit code is live-gate's (0 = every live-mission criterion met), so a passing exit is the evidence
// that a real model authored a verified candidate, survived an interrupt and a segment rotation,
// and passed the holdout. Works with any mission config; only a `"worker": "pi"` config can pass.
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadMissionConfig } from "../src/mission-contract.ts";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    config: { type: "string", default: "mission.live.example.json" },
    "runs-root": { type: "string" },
    "crash-at": { type: "string", default: "snapshot_ready" },
    cycles: { type: "string" },
  },
});

const cli = new URL("../src/cli.ts", import.meta.url).pathname;
const configPath = resolve(values.config);
const config = loadMissionConfig(configPath);
const common = values["runs-root"] ? ["--runs-root", resolve(values["runs-root"])] : [];

function horizon(step: string, args: string[], allowedExit: number[]): number {
  console.log(`\n== ${step}: horizon ${args.join(" ")}`);
  const result = spawnSync(process.execPath, [cli, ...args, ...common], { stdio: "inherit" });
  const code = result.status ?? 1;
  if (!allowedExit.includes(code)) {
    console.error(`${step} exited ${code} (expected one of ${allowedExit.join(",")})`);
    process.exit(code || 1);
  }
  return code;
}

const mission = ["--mission", config.missionId];
horizon("create", ["mission", "create", "--config", configPath], [0]);
// 3 = SimulatedCrash: the controller stopped mid-experiment on purpose; 0/2 = it finished before reaching the crash point.
horizon(
  "run (interrupted)",
  [
    "run",
    ...mission,
    "--crash-at",
    values["crash-at"],
    ...(values.cycles ? ["--cycles", values.cycles] : []),
  ],
  [0, 2, 3],
);
horizon("resume", ["resume", ...mission], [0, 2]);
horizon("export", ["export", ...mission], [0]);
const gate = horizon("live-gate", ["live-gate", ...mission], [0, 2]);
process.exit(gate);
