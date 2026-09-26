import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { test } from "node:test";
import { missionPaths } from "../src/mission-paths.ts";

const horizonRoot = join(import.meta.dirname, "..");
const report = readFileSync(join(horizonRoot, "REPORT.md"), "utf8");

test("REPORT.md names the ledger file the controller actually writes", () => {
  const dbFile = basename(missionPaths("m", "/tmp/hz-doc-check").db);
  assert.equal(dbFile, "state.sqlite");
  assert.match(report, new RegExp(`runs/<mission>/${dbFile.replace(".", "\\.")}`));
  assert.doesNotMatch(report, /ledger\.sqlite/);
});

test("REPORT.md describes `npm test` without a hard-coded test count", () => {
  const line = /^npm test\s+#\s*(.*)$/m.exec(report);
  assert.ok(line, "REPORT.md should document the `npm test` result");
  assert.doesNotMatch(line[1] ?? "", /\d+ tests?, \d+ pass/);
  assert.match(line[1] ?? "", /all pass/);
});
