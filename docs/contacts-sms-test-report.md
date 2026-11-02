# Contacts & SMS: test report (stages 1–6)

Date: 2 Nov 2026. All counts below are from runs on that day. **Simulated** means a test stands in for something real (a phone, a SIM, a Google Sheet); those parts still need the owner's live test (deploy guide, section 6).

## 1. Automated tests

| Test | What it covers | Result |
|---|---|---|
| `tests/test-contacts-sms.js` | Backend through `doPost`, on the real `.gs` code. Includes: the feature switch; contacts and validation; isolation between stores; import; duplicates and merge; templates; pairing; SIMs; estimate, draft, approve; a simulated phone taking and reporting messages; pause and cancel; SIM removed; quiet hours and limits; scheduled start; opt-outs; usage; add-on key permissions; export; revoke; admin. | 106/106 |
| `tests/test-sheets-addon.js` | The **add-on's own code** against an in-memory spreadsheet, with every request going into the real backend. Covers connecting, preview and import, consent needing a source, formula-safe cells, drafts only, results, and a revoked key being forgotten. | 38/38 |
| `tests/test-sms-integration.js` | **Android contract**: the Kotlin source is read, and every action, field, status, error word and STOP word must match the backend. **Journey**: Sheet → Mwakete.com → simulated phone → STOP → retry → results in the Sheet, then isolation and a revoked phone. | 36/36 |
| `tests/verify-contacts-sms-ui.js` | Mwakete.com Contacts and SMS pages in Chromium (Playwright), against the real backend code. | 47/47 |
| `android/sms-core` JUnit (CI) | The shared rules in Kotlin: segments, phone numbers, templates, STOP words, quiet hours, batch size, per-part results. Checked against the same `tests/sms-core-cases.json` as the backend and website. | Green: Actions → Android app, runs 1–6 |
| Same rules, run with the local Kotlin compiler | As above, run in this sandbox. | 38/38 cases, 17/17 rules |
| Android build (CI) | `:app:assembleDebug`; the APK is checked with `aapt2` and `apksigner`: min SDK 24, not test-only, v2 signature verifies. | Green; published as build 6 |
| `tests/test-auth.js`, `verify-seller-signup-route.js`, `test-emailchange.js`, `test-hints-messages.js`, `verify-email-change-ui.js` | The one-account seller sign-in the SMS dashboard relies on. | 86/86, 21/21, 52/52, 18/18, 37/37 |

`.github/workflows/sms-backend.yml` runs the four backend tests on every push that touches the backend, add-on, tests or Android sources. `.github/workflows/android.yml` builds and checks the app.

## 2. Known failures that are not Contacts & SMS

These also fail on `main` without any of this work:
- `ReferenceError: gis is not defined`: Google's sign-in script, which cannot load in the sandbox.
- `verify-custauth`
- `verify-perf` offline navigation
- `verify-home-search`
- `verify-meetings-customer`
- `verify-more-colors` (a colour count in `styles.css`)

## 3. Not tested yet (needs the owner)

| What | Why it cannot be tested here | How to test |
|---|---|---|
| Real SMS sending from a SIM | No phone or SIM in the sandbox; the phone is simulated using the field names read from the app's source. | Deploy guide section 6 |
| Delivery reports | These depend on the carrier (ATHKL / Vodafone Kiribati). | Same test: watch for **Delivered** |
| STOP replies arriving on a real phone | Android's incoming-SMS broadcast cannot run here. | Reply STOP from a second phone |
| Android background behaviour (Doze, battery optimisation, Android 14–15 limits on background services) | Needs a real device. | Leave a 20-message campaign running with the screen off |
| The add-on in a live Google Sheet | No Google account here; its code was run against an in-memory sheet. | `sheets-addon/README.md` |
| Updating the app over an older install | The app is debug-signed until signing secrets exist. | After the owner adds a release key |

## 4. Not claimed

- Google Play approval: the app is installed directly from the APK.
- Google Workspace Marketplace listing for the add-on.
- Any carrier's (ATHKL / Vodafone Kiribati) approval for sending campaigns from a personal SIM bundle. The app and the guide say the carrier's terms apply.
- The remaining SMS allowance: Android cannot read it. Usage is counted from what phones reported, and the allowance is what the store typed in, so both are labelled estimates.

## 5. Risks carried forward

- **Sheet scale.** One Google Sheet holds every store's contacts and messages. That is fine for thousands of rows; sustained tens of thousands of messages a day would need a real database.
- **No push to phones.** A pause or cancel reaches a phone at its next check-in. Phones take small batches (default 50) to limit what an offline phone can still send.
- **Debug signing.** Each new app build means uninstall, reinstall and reconnect, until a release key is set.
- **Three admin actions have no button yet**: cancel one campaign, list all phones, edit places. They exist in the backend. Suspending a store is the emergency stop until then.
