import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";
import { archiveSession, removeArchivedSession } from "../src/session-archive.ts";

test("session archive verifies bytes before deleting closed Pi session files", () => {
  const root = mkdtempSync(join(tmpdir(), "horizon-session-archive-"));
  const sessions = join(root, "sessions");
  const evidence = join(root, "evidence");
  mkdirSync(sessions);
  const file = join(sessions, "segment.jsonl");
  const text = '{"type":"message"}\n';
  writeFileSync(file, text);

  const hash = archiveSession(file, sessions, evidence);
  const archive = join(evidence, `${hash}.session.jsonl.gz`);
  assert.equal(gunzipSync(readFileSync(archive)).toString(), text);
  assert.equal(existsSync(file), true);
  assert.equal(archiveSession(file, sessions, evidence), hash);

  writeFileSync(file, `${text}{"type":"later"}\n`);
  assert.throws(() => removeArchivedSession(file, sessions, evidence, hash), /failed verification/);
  assert.equal(existsSync(file), true);
  writeFileSync(file, text);
  removeArchivedSession(file, sessions, evidence, hash);
  assert.equal(existsSync(file), false);
  assert.equal(existsSync(archive), true);

  const outside = join(root, "other.jsonl");
  writeFileSync(outside, text);
  assert.throws(() => archiveSession(outside, sessions, evidence), /inside the sessions directory/);
  assert.equal(existsSync(outside), true);
});
