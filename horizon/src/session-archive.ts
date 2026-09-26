import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

function sessionFile(sessionPath: string, sessionsDir: string): string {
  const path = resolve(sessionPath);
  const relativePath = relative(resolve(sessionsDir), path);
  if (
    !relativePath ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath) ||
    !lstatSync(path).isFile()
  )
    throw new Error("session path must be a regular file inside the sessions directory");
  return path;
}

function archivePath(evidenceDir: string, hash: string): string {
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("invalid session archive hash");
  return join(evidenceDir, `${hash}.session.jsonl.gz`);
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function archiveSession(
  sessionPath: string,
  sessionsDir: string,
  evidenceDir: string,
): string {
  const source = readFileSync(sessionFile(sessionPath, sessionsDir));
  const hash = sha256(source);
  const target = archivePath(evidenceDir, hash);
  mkdirSync(evidenceDir, { recursive: true });
  if (!existsSync(target)) {
    const staging = join(evidenceDir, `.session-${randomUUID()}.tmp`);
    writeFileSync(staging, gzipSync(source));
    renameSync(staging, target);
  }
  if (sha256(gunzipSync(readFileSync(target))) !== hash)
    throw new Error(`session archive failed verification: ${hash}`);
  return hash;
}

export function removeArchivedSession(
  sessionPath: string,
  sessionsDir: string,
  evidenceDir: string,
  hash: string,
): void {
  if (!existsSync(sessionPath)) return;
  const path = sessionFile(sessionPath, sessionsDir);
  const sourceHash = sha256(readFileSync(path));
  if (
    sourceHash !== hash ||
    sha256(gunzipSync(readFileSync(archivePath(evidenceDir, hash)))) !== hash
  )
    throw new Error(`session archive failed verification: ${hash}`);
  unlinkSync(path);
}
