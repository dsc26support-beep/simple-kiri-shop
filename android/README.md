# Mwakete SMS — Android sender app

A small Android app that sends a store's SMS campaigns from the SIM card in a
phone the store owns. Mwakete.com decides what is sent (consent, opt-outs,
quiet hours, daily limits, which SIM); the phone only sends what it is given
and reports back.

**Status: built and unit-tested in CI. Not yet tested on a real phone with a SIM.**
Until someone runs it on a real phone with a SIM, treat sending, delivery reports and STOP replies as untested.

## Install (sideload, not Google Play)

1. GitHub → **Actions** → **Android app** → the latest green run → **Artifacts** →
   download `mwakete-sms-N` and unzip it. Use `app-release.apk` if it is there,
   otherwise `app-debug.apk`.
2. Copy the APK to the phone and open it. Android will ask to allow installs
   from that source (Files / Chrome) — allow it once.
3. Open **Mwakete SMS**, allow SMS, phone and notification access.
4. On Mwakete.com: **SMS → Phones & SIMs → Get a code**, type the code in the app.
5. Tap **Keep running in the background** and set the app to *Unrestricted* /
   *Don't optimise*, or Android may delay sending.

Debug builds from CI are each signed with a different throwaway key, so a new
debug build will not install over an old one: uninstall first, then connect again
with a new code. A release key (below) fixes this.

## What it does

- Checks in every 15 minutes (Android's minimum) and on **Check now**
  (`smsDeviceSync`): reports results, STOP replies and the SIMs, and takes a batch.
- Sends one message at a time on the chosen SIM (never switches SIM), waiting the
  store's interval between messages; stops for **Pause**, quiet hours or suspension.
- Marks a message as handed over *before* sending, so a crash never sends it twice.
- Reports `submitted` → `sent` / `failed` (Android's error) → `delivered`
  (when the carrier returns a delivery report).
- Reads incoming texts only for a lone STOP / UNSUBSCRIBE / STOP ALL / CANCEL /
  END / QUIT. Only those are uploaded; nothing else leaves the phone.
- If the store removes the phone on Mwakete.com, the app forgets the store.

## Build

```
cd android
./gradlew :sms-core:test        # shared rules, same cases as the backend (tests/sms-core-cases.json)
./gradlew :app:assembleDebug    # needs the Android SDK (ANDROID_HOME)
```

`sms-core` is plain Kotlin (segments, phone numbers, templates, STOP words,
quiet hours, per-part results) so it can be tested without Android.
`-PcoreOnly` skips the app module when no Android SDK is installed.
`-PapiUrl=https://script.google.com/macros/s/…/exec` points a build at a test backend.

## Release signing (optional — needs the owner)

Add these repository secrets (Settings → Secrets and variables → Actions) and CI
also builds a signed `app-release.apk` that installs over earlier releases:
`MWAKETE_KEYSTORE_B64` (the .jks file, base64), `MWAKETE_KEYSTORE_PASSWORD`,
`MWAKETE_KEY_ALIAS`, `MWAKETE_KEY_PASSWORD`. Keep a backup of the keystore — if it
is lost, every phone must uninstall and reinstall. Never commit it.
