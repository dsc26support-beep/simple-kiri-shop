# Mwakete Contacts & SMS — Stage 1 architecture report

Owner brief: "MASTER IMPLEMENTATION PROMPT — MWAKETE CONTACT & SMS MANAGEMENT
PLATFORM" (30 Oct 2026). This is the inspection the brief asks for before any
code: what exists, what is reused, what is new, the risks and the plan.

## 1. The stack as it really is

| Layer | What it is | Consequence |
|---|---|---|
| Website | Static GitHub Pages site (mwakete.com), vanilla JS, no framework; `npm run build` only minifies. | The web dashboard is new pages inside the seller dashboard (owner-nav.js shell), not a separate site. |
| Backend | One Google Apps Script web app (`apps-script/*.gs`, ~26,500 lines), one `doPost` dispatcher in `Code.gs`. | Every new endpoint is a `doPost` action. Deploys are manual (owner pastes files, new version, `?action=getVersion`). |
| Database | One Google Sheet; tabs are tables (`sheetToObjects`, `appendRowFromObject`, `updateRowFromObject`, `hubSheet` creates a tab with headers on first use). | "Migrations" are new tabs and columns created on first use — the convention every feature here follows. No transactions: `LockService` + validate-before-write. |
| Auth | Store owners: `Owners` + `Sessions` (`requireAuth(token)`). Admins: owners whose email is in Script Property `ADMIN_EMAILS` (`isOwnerAdmin`). Shoppers: `Customers` (separate). | Reused as is. "Vendors" and "store owners" in the brief are both `Owners` rows (`StoreType` retailer / wholesaler / distributor); no second user table. |
| Devices | Mwakete POS tills (`PosStaff.gs`): device id + secret answered once, stored hashed (`hashSecretToken`), revocable, constant-time compare. | The Android phone uses the same pattern (own sheets, same helpers). |
| Push | None. Apps Script cannot hold sockets. | The phone polls (adaptive), as the tills do. |
| Google | Google sign-in, the Inventory Sheets sync (`InventorySync.gs`, reads a seller's shared Sheet). | The Sheets add-on is a separate Apps Script project that calls the same web app with a per-store API key. |
| Tests | Node harness running the real `.gs` on an in-memory sheet (`tests/lib/gas-harness.js`); Playwright page tests. | New backend logic gets harness tests; pages get Playwright tests. |

## 2. Reused, not rebuilt

* Accounts, sessions, admin check, audit log (`appendAudit`), rate limiter (`rateLimitHit`), idempotency (`idempotentResult`), secret hashing, `hubSheet`.
* Kiribati islands and villages (`assets/js/kiribati-locations.js`, reviewed by the owner) — seeds the editable reference list.
* The Kiribati phone rule already used at checkout (`isCustomerPhoneValid`, Orders.gs: local numbers start 730 / 630, +686 / 00686 / 686 prefixes).
* Existing customers: `Orders` (CustomerName, CustomerPhone, per store) can be imported into a store's contacts.
* Email marketing consent (`Marketing.gs`) is NOT reused for SMS — SMS consent is separate, per store and per contact, as the brief requires.
* `Notify.gs` documents why there is no SMS gateway; this project does not change that — it sends from each user's own phone.

## 3. New

| Brief | Built as |
|---|---|
| Contacts, categories, tags, consent, suppression, groups, templates | `Contacts.gs` + tabs `Contacts`, `ContactGroups`, `ContactGroupMembers`, `ContactConsentLog`, `SmsSuppression`, `ContactCategories`, `SmsTemplates`, `GeoPlaces` |
| Kiribati number normalisation, duplicates, merge | `Contacts.gs` (`contactNormalisePhone`, duplicate finder, merge keeps consent history) |
| Campaigns, recipients, statuses, approval, pause/resume/cancel/retry | `SmsCampaigns.gs` + `SmsCampaigns`, `SmsMessages` |
| Devices, SIMs, pairing, rotation, revocation, queue claim, result reports, usage | `SmsDevices.gs` + `SmsDevices`, `SmsPairCodes`, `SmsSims` |
| Segment counting (GSM-7 / UCS-2) | `SmsCore.gs`, copied to the browser and mirrored in Kotlin; one test table checks all three agree |
| Web dashboard | `owner/contacts.html`, `owner/sms.html` (+ admin view) |
| Android app | `android/` (Kotlin, Room, WorkManager, SmsManager) |
| Sheets add-on | `sheets-addon/` (Apps Script) |

## 4. Owner decisions (30 Oct 2026)

* **APK build:** both in this environment and on GitHub Actions (free for a public repository). Building here needs `dl.google.com` (Android SDK) allowed in the environment's network settings; `maven.google.com` is already reachable.
* **App scope:** a focused campaign-sender app installed directly from Mwakete.com, not Google Play. Google Play allows SEND_SMS only for the device's default SMS app; a default-SMS-app version is a later stage.
* **Admin access:** admins see counts, statuses, devices and abuse flags. Opening a store's contacts or message text needs a written reason and is audited.
* **Roll-out:** off until Script Property `CONTACTS_SMS = on`, then every approved store.

## 5. Risks and limits (stated, not hidden)

* **Carrier terms.** Sending from a personal SIM bundle may be restricted by ATHKL / Vodafone Kiribati's terms (fair use, bulk/commercial use). Mwakete does not claim it is allowed; the app shows that messages use the user's own SIM and that their carrier's terms apply. Written confirmation from ATHKL is the owner's to obtain.
* **Remaining allowance.** Android cannot read a carrier's remaining free-SMS balance. Usage is counted from what the phone sent; the allowance is what the user types in; all of it is labelled an estimate.
* **Delivery reports** depend on the network; a message is "Delivered" only when a report arrives, otherwise "Sent" (accepted by the network) or "Submitted" (handed to Android).
* **No push.** A paused or cancelled campaign reaches the phone at its next check-in (seconds online). Messages the phone already took for offline sending may still go out; the phone takes small batches to keep this small.
* **Sheet scale.** One Google Sheet holds every store's contacts and messages. Fine for thousands of rows; tens of thousands of messages a day would need a real database — measured, not assumed.
* **Google Play** is not claimed. A Sheets add-on for the owner's account can be installed directly; public Marketplace listing needs a Google Cloud project and Google's review.
* **Live SIM sending** can only be proven on the owner's own phone; automated tests use simulated sends.

## 6. Plan (separate PRs, each tested)

1. Backend: contacts, consent, groups, templates, campaigns, devices, queue — harness tests.
2. Web dashboard pages — Playwright tests against the real backend code.
3. Android app + APK (local build when allowed; GitHub Actions artifact).
4. Google Sheets add-on.
5. Integration tests, manuals, deploy steps, test report.

All of it stays behind `CONTACTS_SMS`, so nothing changes for stores until it is switched on.
