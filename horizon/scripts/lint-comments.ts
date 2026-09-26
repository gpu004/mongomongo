import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const SKIP = new Set(["node_modules", "runs", ".git"]);
const EXT = /\.(ts|mts|cts|js|mjs|cjs)$/;

type Finding = { file: string; line: number; rule: string; text: string };

const BANNER = /^\/\/\s*[-=*#_]{3,}(\s.*)?$/;
const RULED_LABEL = /^\/\/\s*[-=*#_]{2,}.*[-=*#_]{2,}\s*$/;
const BARE_LABEL = /^\/\/\s*[a-z][a-z0-9]*(\s*\/\s*[a-z][a-z0-9]*|\s+[a-z][a-z0-9]*){0,3}\s*$/;
const DIFF_NARRATION =
  /^\/\/\s*(now|previously|formerly|no longer|used to|fix(ed|es)? for|this (fix|change|commit|pr)|was |before this)\b/i;
const SUPPRESSION = /^(\/\/|\/\*)\s*(eslint|oxlint|biome-ignore|@ts-(ignore|nocheck|expect-error))/;
const SUPPRESSION_REASON = /(--|:)\s*\S.{7,}/;

function* files(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* files(full);
    else if (EXT.test(name)) yield full;
  }
}

function check(file: string): Finding[] {
  const out: Finding[] = [];
  const lines = readFileSync(file, "utf8").split("\n");
  const rel = relative(ROOT, file);
  lines.forEach((raw, i) => {
    const text = raw.trim();
    if (!text.startsWith("//") && !text.startsWith("/*")) return;
    const flag = (rule: string) => out.push({ file: rel, line: i + 1, rule, text });
    if (BANNER.test(text) || RULED_LABEL.test(text)) return flag("section-divider");
    if (BARE_LABEL.test(text)) {
      const next =
        lines
          .slice(i + 1)
          .find((l) => l.trim() !== "")
          ?.trim() ?? "";
      if (next && !next.startsWith("}") && !next.startsWith("//")) return flag("section-label");
    }
    if (DIFF_NARRATION.test(text)) return flag("diff-narration");
    if (SUPPRESSION.test(text) && !SUPPRESSION_REASON.test(text))
      return flag("unjustified-suppression");
  });
  return out;
}

const findings = [...files(ROOT)].flatMap(check);
for (const f of findings) console.error(`${f.file}:${f.line} [${f.rule}] ${f.text}`);
if (findings.length > 0) {
  console.error(
    `\n${findings.length} comment lint finding(s). Section dividers/labels and diff narration restate structure that names and git history already carry; suppressions need a reason after "--".`,
  );
  process.exit(1);
}
