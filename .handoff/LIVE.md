# Handoff: Drive with Mwakete driver wallet

## Goal
Owner (small startup, Kiribati, AUD) wanted drivers paid THROUGH Mwakete: seller+driver chat, agree fee, seller pays Mwakete (bank transfer), driver claims at a minimum. All 6 phases built, merged to main, backend DEPLOYED by owner (getVersion wallet6-2026-10-22, checkSetup ok, missingFiles []). Wallet still OFF.

## Next steps
1. Owner sets Script Properties (no redeploy): MWAKETE_BANK_DETAILS, DELIVERY_JOBS=on, DELIVERY_PAYMENTS=pilot, DELIVERY_PAYMENTS_DRIVERS=<DriverId of one South Tarawa driver, max 5>.
2. Owner runs one small real order end to end (fee agree -> seller pays -> admin confirms real bank statement -> deliver -> buyer confirms -> claim -> admin pays). Quick test: DRIVER_HOLD_HOURS=0, DRIVER_MIN_PAYOUT=1, then restore 48/20.
3. Owner reads terms.html#drivers and gets legal advice before going beyond pilot.
4. Help owner fix whatever the pilot shows. Not built: blocking phone numbers/links in chat (was in plan).

## State
- Repo dsc26support-beep/simple-kiri-shop; PRs #118,#122,#123,#124,#125,#126 merged into main. APP_VERSION wallet6-2026-10-22, sw CACHE v186.
- Tests pass: flow 40, wallet 48, chat 30, payment 41, payouts 44, wording 24, deliveries 69; browser wallet 45. No real Google Sheet test yet.
- Dashboard artifact UPDATED to "built and deployed" (status by phase, risks with status, pilot steps): https://claude.ai/artifact/HE4WCdyeuvaDTaqoTNJUb9

## Decisions (and why)
- Seller pays; min $20; hold 48h; commission 0%; pilot South Tarawa max 5. Credit on order complete. Failed after pickup: no_one/wrong_address/refused/unreachable pay driver; damaged/other -> admin decides.
- DELIVERY_PAYMENTS=off stops only NEW wallet jobs; jobs with PayStatus keep checks; drivers with ledger can still claim.
- Chat is its own DeliveryMessages tab (buyer can see order-room timeline).
- Owner: always push changes; merging to main needed explicit approval + settings.json allow rule (added by owner).

## Gotchas
- CLAUDE.md: Apps Script deploys manual/unverifiable; give steps + getVersion check.
- gh GraphQL blocked: use `gh api repos/.../pulls`. JS/CSS change => node tools/build-assets.js, bump sw CACHE + APP_VERSION.
- Stop hook "unpushed" = missing tracking ref; verify with git ls-remote. Local branch verify-main = scratch copy of main.
- Dashboard artifact pages: update via ArtifactData (files/index.html + datasets), assets via Artifact asset upload.

## Open questions
- Legal OK to hold customer money in Kiribati? (owner)
- How does the real pilot behave on the real Sheet?
