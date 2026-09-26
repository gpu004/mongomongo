export interface ObservedVerification {
  suite: string;
  status: string;
  reportId: string;
}

export interface ClaimAudit {
  supported: boolean;
  issues: string[];
}

const SUITE_CLAIM =
  /\b(smoke|correctness|learned|performance|holdout|structural)\b(?:\s+suite)?\s*(?:=|:|is|was|has)?\s*(passed|passes|pass|green|verified|ok|failed|fails|fail|infra_error|timeout|timed out)\b/g;
const GENERIC_SUCCESS =
  /\b(all (?:tests|checks|suites) (?:pass|passed)|everything (?:passes|passed)|fully verified|verified and done|task (?:is )?(?:done|complete))\b/;

function normalize(word: string): string {
  if (["passed", "passes", "pass", "green", "verified", "ok"].includes(word)) return "passed";
  if (["failed", "fails", "fail"].includes(word)) return "failed";
  if (word === "timed out") return "timeout";
  return word;
}

/**
 * Compares a worker's plain-text account against the verifier runs the broker
 * actually observed during the cycle. The claim is never a success signal; this
 * only records where it disagrees with evidence so episodes and evals can say so.
 */
export function auditClaim(claim: string, observed: ObservedVerification[]): ClaimAudit {
  const issues: string[] = [];
  const text = claim.toLowerCase();
  const latest = new Map<string, string>();
  for (const o of observed) latest.set(o.suite, o.status);
  for (const match of text.matchAll(SUITE_CLAIM)) {
    const suite = match[1]!;
    const said = normalize(match[2]!);
    const actual = latest.get(suite);
    if (actual === undefined) issues.push(`claims ${suite} ${said} without a verifier run`);
    else if (actual !== said) issues.push(`claims ${suite} ${said}; verifier reported ${actual}`);
  }
  if (GENERIC_SUCCESS.test(text)) {
    const notPassed = [...latest.entries()].filter(([, status]) => status !== "passed");
    if (latest.size === 0) issues.push("generic success claim without any verifier run");
    else if (notPassed.length > 0)
      issues.push(
        `generic success claim while ${notPassed.map(([s, st]) => `${s}=${st}`).join(", ")}`,
      );
  }
  return { supported: issues.length === 0, issues };
}
