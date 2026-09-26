import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { hashDirectory } from "../verification/runner.ts";

export interface ArtifactRecord {
  hash: string;
  path: string;
  parentHash: string | null;
  manifest: Record<string, string>;
  createdAt: string;
}

export const SEED_DIR = new URL("../demo/search-service/", import.meta.url).pathname;
export const FIXTURES_DIR = new URL("../verification/fixtures/", import.meta.url).pathname;

export interface FixtureManifest {
  fixtureId: string;
  kind: "fault-injection" | "escape-probe";
  label: string;
  description: string;
  expectedFailures: string[];
  overlayDir: string;
}

/**
 * Immutable, content-addressed snapshots under runs/<mission>/artifacts/<hash>.
 * A snapshot is first materialized in a temp dir, hashed, then atomically
 * renamed into place; a directory that exists at its final path is complete.
 */
export class ArtifactStore {
  readonly root: string;

  constructor(root: string) {
    this.root = root;
    mkdirSync(root, { recursive: true });
  }

  /** Copy a working tree into an immutable snapshot and return its record. */
  snapshot(sourceDir: string, parentHash: string | null): ArtifactRecord {
    const staging = mkdtempSync(join(this.root, ".staging-"));
    cpSync(sourceDir, staging, {
      recursive: true,
      filter: (src) => !src.includes("node_modules") && !src.includes("/.git"),
    });
    const { hash, manifest } = hashDirectory(staging);
    const finalPath = join(this.root, hash);
    if (existsSync(finalPath)) {
      rmSync(staging, { recursive: true, force: true });
    } else {
      writeFileSync(
        join(staging, ".manifest.json"),
        JSON.stringify({ hash, parentHash, files: manifest }, null, 2),
      );
      // mkdtemp creates 0700; the read-only container mount runs as a different uid.
      chmodSync(staging, 0o755);
      renameSync(staging, finalPath);
    }
    return { hash, path: finalPath, parentHash, manifest, createdAt: new Date().toISOString() };
  }

  /** Re-hash a snapshot directory and confirm it still matches its name. */
  verify(hash: string): boolean {
    const path = join(this.root, hash);
    if (!existsSync(path)) return false;
    return hashDirectory(path).hash === hash;
  }

  pathFor(hash: string): string {
    return join(this.root, hash);
  }

  /** Materialize the seed service as the parent of all experiments. */
  importSeed(): ArtifactRecord {
    return this.snapshot(SEED_DIR, null);
  }

  /** Build a labeled fault-injection artifact: seed + overlay. Never presented as a natural discovery. */
  importFixture(
    fixtureId: string,
    parentHash: string,
  ): { artifact: ArtifactRecord; fixture: FixtureManifest } {
    const fixtureRoot = join(FIXTURES_DIR, fixtureId);
    const fixture = JSON.parse(
      readFileSync(join(fixtureRoot, "fixture.json"), "utf8"),
    ) as FixtureManifest;
    const staging = mkdtempSync(join(this.root, ".fixture-"));
    cpSync(SEED_DIR, staging, { recursive: true });
    cpSync(join(fixtureRoot, fixture.overlayDir), join(staging, "src"), { recursive: true });
    const artifact = this.snapshot(staging, parentHash);
    rmSync(staging, { recursive: true, force: true });
    return { artifact, fixture };
  }

  /** Reset a writable candidate workspace to a snapshot's contents. Only the candidate dir is ever a rollback target. */
  restoreWorkspace(hash: string, workspaceDir: string): void {
    rmSync(workspaceDir, { recursive: true, force: true });
    mkdirSync(workspaceDir, { recursive: true });
    cpSync(this.pathFor(hash), workspaceDir, {
      recursive: true,
      filter: (src) => !src.endsWith(".manifest.json"),
    });
  }
}
