# Product upload: testing and results (Oct 2026)

All results below come from runs in this repository: `tests/lib/gas-harness.js` runs the real `.gs` files on an in-memory spreadsheet, and the browser tests run in Chromium through Playwright. **Nothing here was run against the live Apps Script deployment.** The checks in [product-upload-deployment.md](product-upload-deployment.md) do that after deploying.

## New tests

| Test | Kind | Result | Covers |
|---|---|---|---|
| `test-product-photos.js` | Backend | 39/39 | Older products' two photos become the gallery; replacing the second photo; add up to 6 (`PRODUCT_IMAGES_MAX`); cover and reorder; remove; files still in use elsewhere are kept; retry safety; checks on the actual bytes (HTML and SVG are refused); size limits; ownership; the D1 fix; the old slot upload; the old "remove second photo"; shopper payload with no file ids; routing. |
| `verify-product-photos.js` | Browser | 48/48 | Gallery on edit; an ordinary edit sends no photo calls or fields; replacing photo 2 (WebP, requestId, in place); Cancel cancels; cover, move (keyboard), remove → one `setProductPhotos`; a new product with 7 photos picked (only 6 taken); a failed upload keeps the old photo and is retried with the same requestId; HEIC message; Duplicate copies no photos; layout at 360 / 768 / 1366px; "Take a photo" only on touch screens; store and product pages show all photos; details shown as plain text. |
| `test-product-details.js` | Backend | 26/26 | Details stored and filtered; shoppers' label/value order; an edit without details keeps them; refused values (bad list value, too long, wrong shape); control characters; formula text; details answering the listing checks (volume, and weight holding a volume); duplicates: same product, a different size, another category, itself, archived, another seller, model numbers, weak matches. |
| `verify-product-steps.js` | Browser | 69/69 | Step by step: Continue checks only its step, focus moves to the section heading, the progress bar, details by category (food → electronics keeps Brand), delivery read from Settings, review, quality meter, the shopper card, the details payload. One page: remembered; rentals and services get their own details; Save hidden; edits open on one page with their details. Save from step 1 opens the price. The duplicate note stops Continue once, "Open it", a different size gets no note. Drafts: kept per seller with no token, survive a reload, Restore, Discard, cleared on log out, not offered to another seller, a stale-version warning. Detail lists match the server. Layout at 360 / 390 / 768 / 1366 / 1920px in both modes. |
| `test-product-import.js` | Backend | 27/27 | Category column (names, ids, subcategories, unknown values); a category is required from somewhere; Food per row; existing names skipped (archived names allowed); description; preview = apply; ledger; history; re-importing the same file adds nothing; a stale preview token is refused; listing checks hold a mismatched row; wholesalers; seller isolation; the 2000-character cap; formula text stored as text. |
| `verify-product-import-page.js` | Browser + real backend | 12/12 | Template download; every column matched automatically; preview counts and reasons; the problems file; apply; the result text; the CSV formula guard. |

## Existing tests changed

| Test | Change | Why |
|---|---|---|
| `verify-photo2.js` | **Removed.** | It asserted the old limitation: the second photo could only be removed, never replaced. The new behaviour, and the rule it protected (an edit must never wipe photos), is covered by `verify-product-photos.js`. |
| `verify-duplicate-listing.js` | Checks the gallery is empty instead of the old preview elements. | The same assertion: photos are not copied. |
| 10 browser tests on `owner/products.html` | Their setup sets `mwk_pform_mode = page`. | They fill fields across sections, so they run in one-page mode. No assertion was changed. |
| `test-badge-wiring.js` | Loads `Images.gs` and `ProductDetails.gs` into its sandbox. | The public payload now calls their helpers. |

## Full suite

| Run | Result |
|---|---|
| Before (baseline, `main` at `0a327f9`) | All 24 product, inventory and listing test files passed. |
| After (this branch) | 203 of 205 test files passed in one full run. |

The two that failed in the full run:
- **`test-badge-wiring`**: a missing helper in its sandbox. Fixed; now 60/60.
- **`verify-searchbtn2`**: one search-page check ("Enter alone still runs the search") failed. On two consecutive identical runs it failed once and passed once (34/34). It is timing-dependent, on a page this work does not touch.

## Measurements

These come from a 12-megapixel test image (4000×3000, gradients plus noise) in Chromium, `owner-product-photos.js optimizeProductPhoto` compared with the previous `helpers.js compressImage`:

| Input | Before (JPEG, 1280px, q0.8) | After (WebP, 1280px, q0.75) |
|---|---|---|
| 2.66 MB JPEG | 100.1 KB | 100.9 KB |
| 14.07 MB PNG | 100.3 KB | 100.1 KB |

- **Size:** the upload is the same as before. A first setting (1600px, q0.82) measured 203 KB, double, so it was rejected in favour of these figures.
- **What the new optimiser adds:** transparency is kept; a small JPEG or WebP is sent untouched; photos are turned upright using their orientation tag; the seller gets a clear message for photos the browser can't read.
- **Speed:** about 0.3 s per photo in this test, the same as before. On a large PNG it was 0.4–0.6 s against 0.8–1.3 s before.

No other speed claims are made. Page-load performance was not changed on purpose: the two new scripts are deferred and load only on the seller's Products page.

## Not verified here

| Item | Why | How to verify |
|---|---|---|
| Live Apps Script (Drive or Cloudinary upload, real locks) | No network path to script.google.com from this sandbox. | The manual checks in the deployment doc. |
| Real iPhone and Android cameras, HEIC on Safari | No devices here. | Take a photo with "Take a photo" on a phone. |
| Screen-reader announcements | Checked by structure only: legends, `aria-current`, labelled buttons, focus moves. | Try TalkBack or VoiceOver on the steps. |
