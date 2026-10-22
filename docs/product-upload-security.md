# Product upload: security review (Oct 2026)

This review covers every changed path in the product-upload upgrade. Each row says how the risk is handled and which test checks it.

## Fixed

| # | Issue | Severity | Fix | Test |
|---|---|---|---|---|
| D1 | `createProduct` / `updateProduct` accepted `imageUrl`, `imageFileId` and `imageFileId2` from the browser. A seller could put another seller's stored file id (a product photo, or an ID document in Drive) on their own product. Replacing that photo later trashed the other file. | High | All photo fields from the browser are ignored. Photos change only through `uploadProductPhoto` / `setProductPhotos` / `uploadProductImage`, which create their own file ids under the lock. | `test-product-photos`: "createProduct ignores photo fields…", "…a later replacement can never delete somebody else's file" |
| D3 | `uploadProductImage` accepted any `image/*` type and trusted the browser's word for it. | Medium | The bytes are sniffed: only JPEG, PNG, WebP and GIF are accepted, and the file is stored as what it actually is. HTML and SVG (which can carry script) are refused. | "an HTML page labelled image/jpeg is refused", "an SVG … is refused" |
| D4 | Removing the second photo left its file in storage. | Low | Removed photos' files are deleted, unless another listing still uses that file. | "removing: … their files deleted", "a file another listing still shows is NOT deleted" |

## Access checks on new and changed actions

| Action | Who | Check |
|---|---|---|
| `uploadProductPhoto`, `setProductPhotos` | Seller | Listed in `PROTECTED_POST_ACTIONS` (owner token required). The product must belong to the signed-in seller; this is checked again after the upload. Photo ids are checked against the product's own list. |
| `findSimilarProducts` | Seller | Protected. Reads only the signed-in seller's own listings. |
| `createProduct` / `updateProduct` with `details` | Seller | Known keys only. Each value is a short text with a length limit, or one value from a fixed list. Control characters are removed. |
| `previewInventoryImport` / `applyInventoryImport` | Seller | As before: the seller's own items only, and apply must match the previewed plan. New: per-row categories are checked against the register, and the Food rule is applied per row. |

Tests that check these: `test-product-photos` (ownership, unknown product), `test-product-details` ("another seller's listings are never looked at"), and `test-product-import` ("another seller's names never count as duplicates").

## Input and output

- **Spreadsheet formulas:** every write goes through `Db.gs sanitizeForSheetCell`, so a value starting with `=`, `+`, `-` or `@` is stored as text. Details are stored inside JSON text, which starts with `{`. Tested in `test-product-details` and `test-product-import`.
- **Downloaded CSVs:** the problems file and the export use `csvCell`, which makes formula-looking text safe and keeps plain numbers as numbers. Tested in `verify-product-import-page`.
- **HTML:** everything a seller typed is escaped before it is shown (`escapeHtml` / `escapeAttr`). This covers names, details, the duplicate note, the draft banner, photo errors and the review list. Tested in `verify-product-photos` ("…plain text").
- **Uploads:**
  - The size is capped before decoding (5MB) and checked again after.
  - The bytes are sniffed for the file type.
  - The browser's file name is never used for storage (the server makes it from the product id and the time).

## Stored on the device

- **The unsaved-listing copy:** form fields only. Its key includes the seller id, so another seller on the same phone is never offered it. It is removed on save, on Discard, after 30 days, and on log out. Tested in `verify-product-steps`: "with no token…", "a different seller…", "logging out removes…".
- **The Step by step / One page choice:** stored as a plain string, nothing private.

## Abuse and limits

| Limit | Value |
|---|---|
| Photos per product | 6 by default (`PRODUCT_IMAGES_MAX`, at most 12). Checked before and after the upload. |
| Repeated uploads | A retry with the same `requestId` returns the first result and stores nothing new. |
| Import | 2,000 rows and 200 new products per import, as before. |
| Duplicate-check name | Cut to 150 characters. The check is debounced in the browser and runs at most once per change. |

## Remaining risks (not changed by this work)

- **Photo links are public.** Drive-stored photos are "anyone with the link" (`uploadImage`), the same model as before.
- **No rate limit per seller** on uploads, beyond the photo cap and Apps Script's own quotas.
