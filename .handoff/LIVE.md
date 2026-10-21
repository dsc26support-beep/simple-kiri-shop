# Handoff: Drive with Mwakete driver wallet

## Goal
Owner (small startup, Kiribati, AUD) wants drivers paid THROUGH Mwakete: seller+driver chat in Mwakete, agree delivery fee, seller pays Mwakete (bank transfer), driver claims balance at a minimum. Owner approved my small-startup defaults and said "approve", then "continue to phase 2".

## Next steps
1. Phase 3: seller pays Mwakete (reference code per job, proof upload), admin confirms vs REAL bank statement (never screenshot alone), pickup details released only after. Gate behind walletEnabledForDriver.
2. Phase 4: credit on buyer receipt (walletCreditJob, 48h hold), driver balance page + Claim, admin payout queue + mark paid (Friday batch).
3. Phase 5: rewrite "Mwakete never holds money" wording (terms.html, order-room.html, customer-dashboard.html, docs, Transactions.gs comments). Owner must get legal advice first.
4. Phase 6: full-flow tests. Update dashboard artifact if plan changes.

## State
- Repo dsc26support-beep/simple-kiri-shop (Google Sheet + Apps Script backend, static front end).
- PR #118 phase 1 (DriverWallet.gs ledger, branch claude/drive-wallet-phase1) draft, base main.
- PR #122 phase 2 (chat + fee lock, branch claude/drive-wallet-phase2) draft, base = phase1 branch. Merge #118 first.
- Tests: tests/test-driver-wallet.js 48, tests/test-delivery-chat.js 30; all other tests/test-*.js pass; npm run build:check clean (needs npm install).
- Dashboard artifact (recommendation): https://claude.ai/artifact/HE4WCdyeuvaDTaqoTNJUb9

## Decisions (and why)
- Seller pays fee (matches today; buyer-pays = 2nd manual payment). Min payout $20, Friday batch. Hold 48h. Commission 0% (fields already recorded). Pilot: South Tarawa, max 5 drivers.
- Failed delivery: before pickup refund seller; after pickup driver paid unless damage (admin decides).
- Chat is separate DeliveryMessages tab, NOT order-room timeline (buyer can see that; driver has no access).
- Ledger append-only; balance always summed, never stored.
- Switch: Script Property DELIVERY_PAYMENTS off|pilot|on + DELIVERY_PAYMENTS_DRIVERS.

## Gotchas
- CLAUDE.md: Apps Script deploys manual, can't verify from sandbox; always give deploy steps + ?action=getVersion check. Never push main/merge/deploy without approval.
- gh GraphQL blocked: create PRs with `gh api repos/.../pulls`.
- Changed JS/CSS => run node tools/build-assets.js and bump sw.js CACHE; APP_VERSION in Code.gs.
- test-checksetup keeps its own FILE_PROBES list.
- Stop hook "unpushed" warnings were a missing local tracking ref; remote was fine (verify with git ls-remote).

## Open questions
- Legal OK to hold customer money in Kiribati? (owner)
- Real browser/Sheet testing of phase 2 not done.
