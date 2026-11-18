# Mwakete Performance Audit — index

This is a short pointer, **not** a re-audit. Mwakete's performance has already
been audited in depth and measured repeatedly; this file ties those records
together and points at the current numbers.

## The audits (read these for the full analysis)

- **[`MWAKETE_V1_PERFORMANCE_AUDIT.md`](../MWAKETE_V1_PERFORMANCE_AUDIT.md)** —
  the original 685-line measured audit. Verdict: *the frontend is not slow*;
  biggest lever is bytes (the ~80 KB raw `styles.css`); warm repeat visit is
  128 ms / 0 KB via the service worker.
- **[`V2_BASELINE.md`](V2_BASELINE.md)** — the `39cd862` baseline, findings 1–5
  (asset-bound load, the two heavy files, the CLS regression, what was already
  optimised, backend read cost).
- **[`API_PERFORMANCE_AUDIT.md`](API_PERFORMANCE_AUDIT.md)** — every public action:
  when it fires, whether it is critical, sheets read, cache, and what is safe to
  cache harder vs must stay fresh.
- **[`chat-performance-optimizations.md`](chat-performance-optimizations.md)** —
  the chat/inbox path specifically.

## The current numbers (refreshed at `546b3cd`)

- **[`PERFORMANCE_BASELINE.md`](PERFORMANCE_BASELINE.md)** — the refreshed
  lab baseline (CWV, weight, per-page, warm/cold, backend sweep) and a verified
  list of which V1/V2 findings are now resolved.
- **[`PERFORMANCE_TEST_REPORT.md`](PERFORMANCE_TEST_REPORT.md)** — real test pass
  counts and the CI-gate pass/catch demonstrations.

## The bottom line (unchanged since V1)

The frontend is fast on a good connection, excellent on repeat visits (0 KB via
SW), and not backend-gated at first paint. The single most valuable lever is
**bytes shipped on the first visit** — which the CI budget gate now guards
automatically ([`PERFORMANCE_BUDGETS.md`](PERFORMANCE_BUDGETS.md)).

For bottlenecks and what to do next, see
[`PERFORMANCE_BOTTLENECKS.md`](PERFORMANCE_BOTTLENECKS.md) and
[`PERFORMANCE_IMPLEMENTATION_PLAN.md`](PERFORMANCE_IMPLEMENTATION_PLAN.md).
