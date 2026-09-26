import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { test } from "node:test";
import { missionPaths } from "../src/mission-paths.ts";

const horizonRoot = join(import.meta.dirname, "..");
const report = readFileSync(join(horizonRoot, "REPORT.md"), "utf8");
const testDir = join(horizonRoot, "test");

// Counts `test(` registrations the way `node --test` will see them: a call inside a
// `for (const x of [...])` loop registers once per array element.
function countRegisteredTests(source: string): number {
  let count = 0;
  let loopMultiplier = 1;
  let depthAtLoop = -1;
  let depth = 0;
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const forMatch = /^for \(const \w+ of \[/.exec(line);
    if (forMatch) {
      let arrayText = "";
      let j = i;
      while (j < lines.length && !/\]( as const)?\) \{/.test(lines[j] ?? "")) {
        arrayText += `${lines[j]}\n`;
        j++;
      }
      arrayText += lines[j] ?? "";
      const elements = arrayText.match(/"[^"]*"|'[^']*'|\d+/g) ?? [];
      loopMultiplier = elements.length;
      depthAtLoop = depth;
      depth += 1;
      i = j;
      continue;
    }
    if (/^\s*test\(/.test(line)) {
      count += loopMultiplier;
    }
    for (const ch of line) {
      if (ch === "{") depth++;
      if (ch === "}") depth--;
    }
    if (depthAtLoop >= 0 && depth <= depthAtLoop) {
      loopMultiplier = 1;
      depthAtLoop = -1;
    }
  }
  return count;
}

test("REPORT.md names the ledger file the controller actually writes", () => {
  const dbFile = basename(missionPaths("m", "/tmp/hz-doc-check").db);
  assert.equal(dbFile, "state.sqlite");
  assert.match(report, new RegExp(`runs/<mission>/${dbFile.replace(".", "\\.")}`));
  assert.doesNotMatch(report, /ledger\.sqlite/);
});

test("REPORT.md test count matches the registered tests in test/**/*.test.ts", () => {
  const registered = readdirSync(testDir)
    .filter((name) => name.endsWith(".test.ts"))
    .map((name) => countRegisteredTests(readFileSync(join(testDir, name), "utf8")))
    .reduce((sum, n) => sum + n, 0);
  const documented = /npm test\s+#\s*(\d+) tests, (\d+) pass/.exec(report);
  assert.ok(documented, "REPORT.md should document the `npm test` result as `N tests, N pass`");
  assert.equal(Number(documented[1]), registered);
  assert.equal(Number(documented[2]), registered);
});
