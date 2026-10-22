# Handoff: POS Integration Hub + native POS

## Goal
Owner's master prompt: extend existing inventory sync with POS hub (signed push, mappings, outbox) + native POS; tests, docs. No dup systems.

## Next steps
1. Owner is trialling: POS_HUB=on set. Gave test plan: menu shows POS links (relogin/hard refresh), cash sale -> stock-2, refund w/ restock, card sale labelled "not verified", create connection -> Waiting -> Connected only after signed ping (docs/pos-integration-setup.md). Await owner's results/errors; fix on a new branch from main.
2. Not built: named providers (Square, Loyverse, Shopify, Lightspeed, Odoo) + header-signature relay; staff roles; offline checkout.

## State
- PR #127 MERGED to main (merge commit) after owner said "merge it" twice (first try blocked by classifier; 2nd worked). Branch claude/pos-integration now stale/merged; new work needs fresh branch from main.
- Deployed by owner: getVersion=pos1-2026-10-22, checkSetup setupOk true, missingFiles [].
- Driver wallet (6 phases) merged+deployed earlier (wallet6); owner still to: read Terms wording, legal advice, pilot via DELIVERY_PAYMENTS.
- NOT verified: real Sheet runtime of POS, real providers, live https delivery, printing.

## Decisions (why)
- POS_HUB flag off by default = safe rollback. Sale=fact (floor 0, flag); counts never auto-applied; no name matching; walk-in sales kept out of Orders; card/mobile "recorded, not verified".

## Gotchas
- Body field `action` overwrites routing key -> resolve uses `resolution`.
- Stop hook "unpushed" = stale local tracking ref; verify with git ls-remote; git update-ref fixes.
- gh GraphQL blocked: use gh api repos/.../pulls; ready-for-review via POST .../ccr/ready_for_review. CLAUDE.md: deploys manual, never claim deploy without getVersion.

## Open questions
- Which provider first; legal/tax advice before wider use.
