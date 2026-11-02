# Contacts & SMS: deploy and go-live

What is live now, what to switch on, and how to check each part. Apps Script deploys are done by the owner by hand. Claude cannot reach script.google.com, so a deploy counts as done only after the `getVersion` check below.

## 1. Where each part stands (2 Nov 2026)

| Part | Where it lives | State |
|---|---|---|
| Backend (`SmsCore.gs`, `Contacts.gs`, `SmsDevices.gs`, `SmsCampaigns.gs`, routes in `Code.gs`) | Apps Script web app | Deployed and confirmed (`oneacct-2026-11-02`, which includes everything since `sms1-2026-10-30`). **Switched off** until step 2. |
| Website pages (`owner/contacts.html`, `owner/sms.html`, `sms-stop.html`, admin SMS section) | GitHub Pages (main) | Live; hidden from menus until switched on. |
| Android app | `android/`, built by GitHub Actions | APK at the fixed link below; debug-signed. |
| Google Sheets add-on | `sheets-addon/` | Ready to paste into a sheet; not listed on the Marketplace. |

## 2. Switch it on

1. Open the Apps Script project, then **Project Settings → Script properties**.
2. Add `CONTACTS_SMS` with the value `on`.
3. Optionally add `SMS_LIMITS` to change the defaults. It is JSON, and only these keys are used:
   ```json
   {"maxContactsPerStore":10000,"maxCampaignRecipients":1000,"maxDailyPerDevice":500,"maxDailyPerStore":1500,
    "minIntervalSeconds":3,"defaultIntervalSeconds":8,"batchSize":50,"claimHours":48,"maxDevicesPerStore":5,
    "quietStart":21,"quietEnd":7,"utcOffset":12}
   ```
   Admins can also change the limits on the admin page.
4. No new deploy is needed: a script property takes effect at once.
5. Check it:
   - Sign in as a seller. **Contacts** and **SMS** now appear in the seller menu (after one page reload).
   - Open mwakete.com/owner/contacts.html and add a test contact.

To switch it off again, set `CONTACTS_SMS` to `off`. Every Contacts & SMS action then answers "not switched on yet", phones stop getting messages at their next check-in, and nothing is deleted.

## 3. Backend redeploys (when a later change touches `apps-script/`)

1. Paste the changed `.gs` files into the Apps Script project (same file names).
2. **Deploy → Manage deployments**, then edit the existing deployment. Choose **Version: New version**, then **Deploy**. Keep the same deployment, so the `/exec` URL used by the website, the app and the add-on does not change.
3. Open `https://script.google.com/macros/s/AKfycby70Y4gCJtA5g2-4hKjdKoAxSJG22T0Tm_9bgup4fmPyid8YVdoYr23BbkB6Nh-kaSn/exec?action=getVersion`. It must show the `APP_VERSION` from `apps-script/Code.gs`.

## 4. Android app

- **Download link:** https://github.com/dsc26support-beep/simple-kiri-shop/releases/download/android-latest/mwakete-sms.apk. It always points at the newest build from main.
- **Builds:**
  - Every push touching `android/` runs **Actions → Android app**. That run tests the shared rules, checks the APK will install (minimum Android version, not test-only, signature) and uploads it.
  - A push to main also publishes it at the link above.
- **Signing.** The app is debug-signed until the owner decides otherwise. Each build has a new key, so a new build will not install over an old one. To fix this, the owner adds four repository secrets:
  - `MWAKETE_KEYSTORE_B64`
  - `MWAKETE_KEYSTORE_PASSWORD`
  - `MWAKETE_KEY_ALIAS`
  - `MWAKETE_KEY_PASSWORD`

  CI then publishes a signed release build instead. Keep a backup of the keystore: losing it means every phone must reinstall. Never commit it.
- **Local build** in this cloud environment needs `dl.google.com` allowed in the environment's network settings (for the Android SDK).

## 5. Google Sheets add-on

Per sheet, by the store. Follow [`sheets-addon/README.md`](../sheets-addon/README.md):
1. Make a key on Mwakete.com.
2. Paste the three files in **Extensions → Apps Script**.
3. Reload the sheet.
4. Choose **Mwakete SMS → Open panel**.

The add-on calls the same `/exec` URL. If the deployment URL ever changes, update `MWK_API` at the top of `Code.gs`, the default `apiUrl` in `android/app/build.gradle.kts`, and `APPS_SCRIPT_URL` in `assets/js/config.js` too.

Publishing on the Google Workspace Marketplace is a separate decision. It needs a Google Cloud project, an OAuth consent screen and Google's review.

## 6. First live test (owner, real phone)

1. Switch on (section 2), then on Mwakete.com create two contacts:
   - your own number, with **Promotions: yes** and a note on how you agreed;
   - a second phone you can read, also **Promotions: yes**.
2. Install the app, connect it with a code and allow everything. Check that its SIM shows on **Phones & SIMs**.
3. Make a campaign to those two contacts on that SIM, check it, and start it.
4. Within a minute or two, with the app open, both phones should get the text. Mwakete.com should show **Accepted by network**, then **Delivered** if your carrier sends delivery reports.
5. From the second phone reply **STOP**. After the next check-in, that number is on **People who opted out**, and a new promotion leaves it out.
6. Try **Pause** mid-campaign with a larger test group, and **Disconnect this phone**.

Write down anything that differs. Until this is done, real sending, delivery reports and STOP replies are tested only with a simulated phone (see the test report).
