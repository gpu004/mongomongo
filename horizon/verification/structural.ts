import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Predefined import-boundary check for the candidate's `src/` tree.
 * Layers may only import from the layers listed here. Anything else — for
 * example `http/` importing `storage/` to mutate the store directly — is a
 * bypass of the single mutation path and fails the artifact before scenarios run.
 */
const ALLOWED_IMPORTS: Record<string, string[]> = {
	domain: ["domain"],
	storage: ["domain", "storage"],
	search: ["domain", "storage", "search"],
	application: ["domain", "storage", "search", "application"],
	http: ["domain", "application", "http"],
};

const FORBIDDEN_MODULES = ["child_process", "node:child_process", "worker_threads", "node:worker_threads", "vm", "node:vm"];

export interface StructuralViolation {
	file: string;
	line: number;
	rule: "STRUCT-IMPORT-BOUNDARY" | "STRUCT-FORBIDDEN-MODULE" | "STRUCT-UNKNOWN-LAYER";
	detail: string;
}

export function checkImportBoundaries(srcRoot: string): StructuralViolation[] {
	const violations: StructuralViolation[] = [];
	for (const file of walk(srcRoot)) {
		const rel = relative(srcRoot, file).split("\\").join("/");
		const layer = rel.split("/")[0] ?? "";
		const allowed = ALLOWED_IMPORTS[layer];
		if (!allowed) {
			violations.push({ file: rel, line: 0, rule: "STRUCT-UNKNOWN-LAYER", detail: `unknown layer ${layer}` });
			continue;
		}
		const lines = readFileSync(file, "utf8").split("\n");
		lines.forEach((text, index) => {
			const match = /^\s*(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]/u.exec(text) ?? /^\s*import\s+['"]([^'"]+)['"]/u.exec(text);
			if (!match) return;
			const specifier = match[1] ?? "";
			if (FORBIDDEN_MODULES.includes(specifier)) {
				violations.push({ file: rel, line: index + 1, rule: "STRUCT-FORBIDDEN-MODULE", detail: `imports ${specifier}` });
				return;
			}
			if (!specifier.startsWith(".")) return;
			const target = join(rel, "..", specifier).split("\\").join("/");
			const targetLayer = target.split("/")[0] ?? "";
			if (target.startsWith("..")) {
				violations.push({ file: rel, line: index + 1, rule: "STRUCT-IMPORT-BOUNDARY", detail: `escapes src/: ${specifier}` });
			} else if (!allowed.includes(targetLayer)) {
				violations.push({ file: rel, line: index + 1, rule: "STRUCT-IMPORT-BOUNDARY", detail: `${layer} may not import ${targetLayer} (${specifier})` });
			}
		});
	}
	return violations;
}

function walk(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir).sort()) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) out.push(...walk(full));
		else if (entry.endsWith(".ts")) out.push(full);
	}
	return out;
}
