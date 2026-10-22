# Handoff: Drive with Mwakete driver wallet

## Goal
Owner (small startup, Kiribati, AUD) wants drivers paid THROUGH Mwakete: seller+driver chat, agree fee, seller pays Mwakete (bank transfer), driver claims at a minimum. Owner approved my small-startup defaults; has said "continue" for phases 2, 3, 4.

## Next steps
1. Phase 5: rewrite "Mwakete never holds money" wording ONLY for delivery fees: terms.html, order-room.html, customer-dashboard.html, driver.html apply text, docs/transaction-rooms.md, docs/deliveries.md, Transactions.gs comments. Owner should read wording before merge; legal advice first (not done).
2. Phase 6: full-flow tests across all phases; update dashboard artifact if plan changes.
3. Owner: merge PRs in order, deploy manually, set MWAKETE_BANK_DETAILS, pilot only.

## State
- Repo dsc26support-beep/simple-kiri-shop (Google Sheet + Apps Script backend, static front end).
- Stacked draft PRs: #118 ph1 ledger (base main) -> #122 ph2 chat+fee lock -> #123 ph3 seller pays, admin confirms -> #124 ph4 credit/claim/payout. Branches claude/drive-wallet-phase1..4.
- Tests: test-driver-wallet 48, test-delivery-chat 30, test-delivery-payment 41, test-driver-payouts 44; all tests/test-*.js pass; npm run build:check clean.
- Dashboard artifact: https://claude.ai/artifact/HE4WCdyeuvaDTaqoTNJUb9 (plan; not updated since phase 1)
- APP_VERSION wallet4-2026-10-22, sw.js CACHE v171.

## Decisions (and why)
- Seller pays fee; min payout $20; hold 48h; commission 0% (fields recorded); pilot South Tarawa max 5 drivers via DELIVERY_PAYMENTS=pilot + DELIVERY_PAYMENTS_DRIVERS.
- Credit on ORDER COMPLETE (txMaybeComplete hook), not driver "delivered". Failed after pickup: no_one_home/wrong_address/refused/unreachable pay driver; damaged/other -> admin decides; before pickup refund seller.
- Chat is separate DeliveryMessages tab (buyer can see order-room timeline).
- Ledger append-only; balances summed. Admin never handles own store/driver.

## Gotchas
- CLAUDE.md: Apps Script deploys manual/unverifiable; give deploy steps + ?action=getVersion. No merge/deploy/push main without approval.
- gh GraphQL blocked: create PRs via `gh api repos/.../pulls`.
- JS/CSS change => node tools/build-assets.js, bump sw.js CACHE, bump APP_VERSION. npm install needed for build.
- test-checksetup has own FILE_PROBES.
- Stop hook "unpushed" = missing local tracking ref; verify with git ls-remote.

## Open questions
- Legal OK to hold customer money in Kiribati? (owner)
- No real browser / real Sheet testing done for any phase.
