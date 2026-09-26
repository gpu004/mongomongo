import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ArtifactStore } from "../src/artifact-store.ts";

test("artifact retention preserves seed, accepted and recent snapshots without following symlinks", () => {
  const root = mkdtempSync(join(tmpdir(), "horizon-artifact-retention-"));
  const store = new ArtifactStore(join(root, "artifacts"));
  const source = join(root, "source");
  mkdirSync(source);
  const snapshot = (text: string, parent: string | null) => {
    writeFileSync(join(source, "candidate.txt"), text);
    return store.snapshot(source, parent);
  };

  const seed = snapshot("seed", null);
  const oldRejected = snapshot("old rejected", seed.hash);
  const accepted = snapshot("accepted", seed.hash);
  const recent = snapshot("recent", accepted.hash);
  const staging = join(store.root, ".staging-in-progress");
  mkdirSync(staging);
  const symlink = join(store.root, "f".repeat(64));
  symlinkSync(source, symlink, "dir");

  assert.deepEqual(store.pruneExcept(new Set([seed.hash, accepted.hash, recent.hash])), [
    oldRejected.hash,
  ]);
  assert.equal(store.verify(oldRejected.hash), false);
  for (const hash of [seed.hash, accepted.hash, recent.hash])
    assert.equal(store.verify(hash), true);
  assert.equal(existsSync(staging), true);
  assert.equal(existsSync(symlink), true);
  assert.deepEqual(store.pruneExcept(new Set([seed.hash, accepted.hash, recent.hash])), []);
});
