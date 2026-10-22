# Handoff: Drive with Mwakete driver wallet

## Goal
Owner (small startup, Kiribati, AUD) wanted drivers paid THROUGH Mwakete: seller+driver chat, agree fee, seller pays Mwakete (bank transfer), driver claims at a minimum. All 6 phases built, tested and MERGED to main.

## Next steps
1. Owner deploys backend (manual, Apps Script): new file DriverWallet.gs + replace Deliveries.gs, Transactions.gs, Code.gs; Manage deployments > pencil > New version. Raw links: https://raw.githubusercontent.com/dsc26support-beep/simple-kiri-shop/main/apps-script/<File>.gs
2. Owner checks ?action=getVersion = wallet6-2026-10-22 and ?action=checkSetup missingFiles [] and tells me; I confirm.
3. Owner sets Script Properties: MWAKETE_BANK_DETAILS, DELIVERY_JOBS=on, DELIVERY_PAYMENTS=pilot, DELIVERY_PAYMENTS_DRIVERS=<DriverId(s), South Tarawa, max 5>.
4. Owner reads terms.html#drivers wording and gets legal advice before going beyond pilot.
5. Optional: update planning dashboard artifact to "built"; run other browser suites; test on real Sheet.

## State
- Repo dsc26support-beep/simple-kiri-shop. PRs #118,#122,#123,#124,#125,#126 merged (merge commits) into main. APP_VERSION wallet6-2026-10-22, sw CACHE v186.
- main had moved (PRs #119-121, .claude/settings.json allowing Bash(gh api:*)); I merged main up the stack and fixed conflicts (Code.gs version, styles.css keep both, sw.js cache, regenerate min/help).
- Tests on main pass: flow 40, wallet 48, chat 30, payment 41, payouts 44, deliveries 69, checksetup 12, wording 24, help 50; browser wallet 45 + deliveries 24 (before merge). build:check clean.
- Dashboard artifact (stale plan): https://claude.ai/artifact/HE4WCdyeuvaDTaqoTNJUb9

## Decisions (and why)
- Seller pays; min $20; hold 48h; commission 0%; pilot South Tarawa max 5. Credit on order complete. Failed after pickup: no_one/wrong_address/refused/unreachable pay driver; damaged/other -> admin.
- DELIVERY_PAYMENTS=off stops only NEW wallet jobs; never strands money.
- Owner: always push changes (branches); merging to main needed explicit approval + permission rule.

## Gotchas
- CLAUDE.md: Apps Script deploys manual/unverifiable; give steps + getVersion check.
- gh GraphQL blocked: use `gh api repos/.../pulls`. JS/CSS change => node tools/build-assets.js, bump sw CACHE + APP_VERSION.
- Stop hook "unpushed" = missing tracking ref; verify with git ls-remote. Local branch verify-main = scratch copy of main.

## Open questions
- Legal OK to hold customer money in Kiribati? (owner)
- Real Google Sheet not tested.
