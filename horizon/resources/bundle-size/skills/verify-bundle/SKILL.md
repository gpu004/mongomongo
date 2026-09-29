---
name: verify-bundle
description: How the Horizon host verifies a candidate text-kit bundle and what the worker can do about failures.
---

# Verify bundle

The host runs the fixed bundle-size verifier. The worker cannot change it, and the worker's own reasoning about correctness is never authoritative.

## Order

1. `structural`: the bundle is `src/` only. Imports must be relative and stay inside `src/`; packages, runtime modules (`node:*`), `process`, `globalThis`, `require`, `eval`, `Function` and dynamic `import()` are rejected.
2. `smoke`: one call to each exported helper.
3. `correctness`: fixed scenarios; each runs in a fresh process that imports `src/index.ts` and compares every call with the reference semantics.
4. `performance`: `bundleBytes`, the total size of every file under `src/`. It is deterministic, so one measurement is exact.
5. `holdout`: the fixed scenarios plus held-out inputs the worker never sees, run on the best artifact before the mission succeeds.

## Using the tools

- `verify_candidate {"suite":"smoke"}` then `{"suite":"correctness"}` after every change. Each failed assertion names the first differing call and an evidence id.
- `read_evidence {"evidenceId": "..."}` lists the calls whose results differed from the reference.
- `profile_candidate {"scenario":"bundle"}` reports the current `bundleBytes` without changing the score.
- `recall_history {"query":"..."}` returns earlier episodes from this mission only; check it before repeating an approach.

## Status meanings

- `passed` / `failed`: product evidence.
- `infra_error` / `timeout`: not evidence about the product. Report it; do not "fix" the candidate for it.
