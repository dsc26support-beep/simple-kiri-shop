# Handoff: POS Integration Hub + native POS

## Goal
Owner's master prompt: audit, then extend existing inventory sync (no duplicate system) with POS hub (signed push, mappings, outbox), native POS, tests, docs, final report. No deploy/merge/prod changes.

## Next steps
0. Draft PR #131 (branch claude/inventory-help-pos-text): rewrote stale help line in owner/inventory-help.html (CSV works; signed-push + native POS exist behind POS_HUB; named providers not available). Owner asked 'import it' (assumed 'update it'). Merge only on explicit OK.
0. Owner asked for deploy steps+raw links; gave them (branch raw links, claude/pos-integration; swap to main after merge). Owner has NOT yet confirmed deploy: await getVersion=pos1-2026-10-22 + checkSetup.
1. Owner: review draft PR #127 (dsc26support-beep/simple-kiri-shop). Merge only with explicit OK.
2. Owner deploy (manual, DEPLOY.md): backup sheet; paste IntegrationHub/IntegrationOutbox/Pos.gs + changed Code/Auth/Inventory/InventorySync/Orders/Reminders; getVersion must = pos1-2026-10-22; checkSetup clean; set POS_HUB=on; send signed ping.
3. Pending/not built: named providers (Square, Loyverse, Shopify, Lightspeed, Odoo) + header-signature relay; staff roles; offline checkout.

## State
- Branch claude/pos-integration, all pushed. Tests: test-pos-hub 48, test-pos-native 60, verify-pos-hub 30, full unit regression pass, build:check clean. sw cache v187.
- Docs: docs/pos-integration-{audit,architecture,setup,troubleshooting,runbook,migration,final-report}.md + config template.
- NOT verified: real Sheet/Apps Script runtime, real providers, live https delivery, printing.

## Decisions (why)
- Feature flag POS_HUB off by default = safe rollout/rollback.
- Physical sale = fact (apply, floor 0, flag); stock count never auto-applied; sale all-or-nothing on mapping; never by name.
- Signature in body (Apps Script cannot read headers).
- Walk-in sales kept out of Orders (avoid online-order side effects).
- Card/mobile = "recorded, not verified"; refunds are records only.

## Gotchas
- Body field `action` overwrites API routing key -> resolve uses `resolution`.
- gh GraphQL blocked: use gh api repos/.../pulls. CLAUDE.md: deploys manual, never claim deploy without getVersion.

## Open questions
- Which provider first; legal/tax advice before wider use.
