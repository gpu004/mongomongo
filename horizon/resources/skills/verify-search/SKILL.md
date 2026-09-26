---
name: verify-search
description: How the Horizon host verifies a candidate search service and what the worker can do about failures.
---

# Verify search

The host runs the fixed verifier. The worker cannot change it, and the worker's own reasoning about correctness is never authoritative.

## Order

1. `structural`: import boundaries (`src/http` must not import `src/storage` or `src/search`).
2. `smoke`: health plus one search round trip.
3. `correctness`: fixed scenarios, each on a fresh process.
4. `learned`: regressions materialized from earlier corrections.
5. `performance`: deterministic workload, repeated; the score is the median of per-repetition p95 after warmup. Only meaningful after correctness passes.

## Using the tools

- `verify_candidate {"suite":"smoke"}` then `{"suite":"correctness"}` after every change. Read `failed[]`: each entry names the assertion, the detail, and an evidence id.
- `read_evidence {"evidenceId": "..."}` shows the request/response pair the reference model disagreed with.
- `profile_candidate {"scenario":"search-read-heavy"}` gives timing evidence without changing the score.
- `recall_history {"query":"..."}` returns earlier episodes from this mission only; check it before repeating an approach.
- `propose_regression` when you find a failure the fixed suites did not name. Provide only the operation sequence and the invariant id; expected results are derived by the host, then the check must fail a known-bad fixture and pass the seed before it is kept.

## Status meanings

- `passed` / `failed`: product evidence.
- `infra_error` / `timeout`: not evidence about the product. Report it; do not "fix" the candidate for it.
