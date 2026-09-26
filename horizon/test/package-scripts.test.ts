import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const ROOT = new URL("..", import.meta.url).pathname;
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  scripts: Record<string, string>;
  devDependencies: Record<string, string>;
};
const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");

test("lint and format:check scripts invoke the installed oxlint/oxfmt", () => {
  assert.ok(pkg.devDependencies.oxlint);
  assert.ok(pkg.devDependencies.oxfmt);
  assert.equal(pkg.scripts.lint, "oxlint .");
  assert.equal(pkg.scripts["format:check"], "oxfmt --check .");
});

test("README documents lint and format:check next to check", () => {
  for (const script of ["npm run check", "npm run lint", "npm run format:check"]) {
    assert.ok(readme.includes(script), `README missing ${script}`);
  }
});

test("oxfmt --check passes on the checked-in tree", () => {
  const result = spawnSync("npx", ["oxfmt", "--check", "."], { cwd: ROOT, encoding: "utf8" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("oxlint passes on the checked-in tree", () => {
  const result = spawnSync("npx", ["oxlint", "."], { cwd: ROOT, encoding: "utf8" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
