# Drive with Mwakete — identity, face check and Driver Agreement (Oct 2026)

These are the owner's requests and decisions for driver onboarding:

- **Contact details:** Messenger and email sit under Phone. The approval decision goes to the driver on Messenger.
- **ID:** the driver gives ONE ID (KPF ID, National ID, passport or driver's licence) plus a photo of it.
- **Face check:** a head-turn liveness check, where the ring around the face goes green, followed by a match against the ID photo.
  - Passing approves the **face step only**. An admin still approves the driver.
  - If the check fails, the application is still sent, flagged for the admin to check by eye.
- **Driver Agreement:** a 2-page agreement (`driver-contract.html`), signed either in the app or on paper.
  - The driver is an **independent contractor** and sets their own fee per job with the seller.
  - The other party is **MainKT Enterprise**, trading as Mwakete.
- **Document storage:** ID photo, selfie and agreement are stored privately, and deleted 90 days after a driver is rejected or suspended.

## How it works

| Piece | Where |
|---|---|
| Application form (steps 1–4) | `driver.html`, `assets/js/driver.js` |
| Face check (runs on the phone) | `assets/js/driver-face.js`, using face-api.js 1.7.13 (@vladmandic) and its models, loaded from jsDelivr only when the check starts |
| Agreement (2 A4 pages, printable) | `driver-contract.html`, version `2026-10-v1` |
| Checks, storage, admin viewing, purge | `apps-script/DriverOnboarding.gs`, called from `actionDriverApply` (`Deliveries.gs`) |
| Admin review | owner/admin.html → Deliveries & drivers. It shows the ID, the face result, how the agreement was signed, a "Message on Messenger" link and a "View ID & photos" button. |

### Face check
1. The driver looks straight at the camera. The app takes a photo and reads that face.
2. The driver turns their head left and right. The marks on each side turn green as they turn (a turn of at least 0.28 eye-widths each way).
3. The face is compared with the face on the ID photo. A distance below 0.55 counts as "passed".

**Results sent to the server:**

| Result | Meaning |
|---|---|
| `passed` | The head turn was completed and the face matched the ID. |
| `not_matched` | The face didn't match the ID, or no face was found on the ID photo. |
| `liveness_failed` | The head turn wasn't completed after 3 tries. |
| `unsupported` | The phone had no camera access or couldn't load the face-check library; a plain selfie is taken instead. |

Every result lets the driver send the application.

**Limits, stated honestly:**
- A check that runs on the phone can be fooled by a determined person, which is why an admin always compares the photos.
- Nothing is sent to any face-recognition company.
- The library and models are about 7 MB. They download once, and only for applicants.

### Storage and privacy
- Files go in the Drive folder **"Mwakete Driver Documents (private)"**.
  - The script creates it, and only the script account can open it.
  - Its ID is saved in the Script Property `DRIVER_DOCS_FOLDER_ID`.
- The sheet holds only file IDs, the ID type and number, the face result and the agreement details.
- Admins view the files through `adminDriverDocs`. Each viewing is written to the audit log.
- `purgeOldDriverDocs()` runs daily. It deletes the files 90 days after a driver is rejected or suspended; the row stays, marked `DocsDeletedAt`.

**Drivers sheet — new columns** (added automatically, existing columns untouched):

`Messenger`, `IdType`, `IdNumber`, `IdFileId`, `SelfieFileId`, `FaceResult`, `FaceScore`, `ContractVersion`, `ContractMethod`, `ContractSignedName`, `ContractSignedAt`, `ContractFileIds`, `DocsDeletedAt`

## Deploy (owner)
1. In Apps Script, add the new file `DriverOnboarding.gs`.
2. Replace `Deliveries.gs` and `Code.gs` with the new versions.
3. Save, then Deploy → Manage deployments → edit → New version.
4. Check that `?action=getVersion` returns `drv1-2026-10-24`.
5. Set up the daily 90-day clean-up. In the editor go to **Triggers → Add Trigger**, choose **`purgeOldDriverDocs`**, event source **Time-driven**, **Day timer**, **3am to 4am**, then save.
   - Running `installDriverDocsTrigger` from the editor does the same thing, but it fails with "Specified permissions are not sufficient to call ScriptApp.getProjectTriggers" unless `https://www.googleapis.com/auth/script.scriptapp` is in `oauthScopes` in `appsscript.json`. This project lists its scopes by hand, so the Triggers screen is the simpler route.
6. Driving is still switched off until the Script Property `DELIVERY_JOBS` is set to `on`.

## The agreement
- **`driver-contract.html`** is final: approved by the owner (a lawyer) on 24 Oct 2026, with the Terms and Privacy driver sections.
- **Changing the agreement:** bump `DRIVER_CONTRACT_VERSION` (in `DriverOnboarding.gs`) and the version printed in `driver-contract.html` together. New applicants must then sign the new version.
