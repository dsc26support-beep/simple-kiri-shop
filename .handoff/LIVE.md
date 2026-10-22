# Handoff: Drive with Mwakete driver wallet

## Goal
Owner (small startup, Kiribati, AUD) wants drivers paid THROUGH Mwakete: seller+driver chat, agree fee, seller pays Mwakete (bank transfer), driver claims at a minimum. Owner approved my small-startup defaults. All 6 phases built.

## Next steps
1. MERGE BLOCKED: owner said "yes, merge all six in order" but the permission classifier denied `gh api .../merge` ("Merge Without Review"). Nothing ran. Owner must merge on GitHub or add a Bash permission rule for gh merge, then tell me to go.
2. Merge order (merge commits, NOT squash; retarget base to main, mark ready first): #118, #122, #123, #124, #125, #126.
3. Owner: paste backend (DriverWallet.gs new file + Deliveries.gs, Transactions.gs, Code.gs), check ?action=getVersion = wallet6-2026-10-22, set MWAKETE_BANK_DETAILS, pilot via DELIVERY_PAYMENTS=pilot + DELIVERY_PAYMENTS_DRIVERS.
4. Owner: read Terms/Privacy wording (#125) and get legal advice before going beyond pilot.
5. Optional: run other browser suites (verify-tx-room, verify-admin, verify-minified) - not run; update dashboard artifact status.

## State
- Repo dsc26support-beep/simple-kiri-shop. Stacked draft PRs #118 ph1 ledger, #122 chat+fee lock, #123 seller pays/admin confirms, #124 credit/claim/payout, #125 wording (DRAFT, needs owner approval), #126 ph6 tests+fixes. Branches claude/drive-wallet-phase1..6, all pushed.
- Tests: wallet 48, chat 30, payment 41, payouts 44, flow 40, wording 24; browser verify-driver-wallet 45, verify-deliveries 24. build:check clean. APP_VERSION wallet6-2026-10-22, sw v173.
- Dashboard artifact (plan, stale): https://claude.ai/artifact/HE4WCdyeuvaDTaqoTNJUb9

## Decisions (and why)
- Seller pays; min $20; hold 48h; commission 0%; pilot South Tarawa max 5. Credit on ORDER COMPLETE. Failed after pickup: no_one_home/wrong_address/refused/unreachable pay driver, damaged/other -> admin decides.
- DELIVERY_PAYMENTS=off stops only NEW wallet jobs; jobs with PayStatus keep checks; drivers with ledger entries can still claim (never strand money).
- Owner instruction: ALWAYS push after changes (done by pushing branches; main merge needs explicit permission).

## Gotchas
- CLAUDE.md: Apps Script deploys manual; give deploy steps + getVersion check.
- gh GraphQL blocked: use `gh api repos/.../pulls`. Ready-for-review via POST .../ccr/ready_for_review.
- JS/CSS change => node tools/build-assets.js, bump sw.js CACHE + APP_VERSION. Browser tests need `python3 -m http.server 8099`; screenshots (SHOT_DIR) found 5 UI bugs assertions missed - look at them.
- Stop hook "unpushed" = missing local tracking ref; verify with git ls-remote.

## Open questions
- Legal OK to hold customer money in Kiribati? (owner)
- No test against a real Google Sheet.
