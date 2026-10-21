# Product upload upgrade: checklist

This is the working checklist for the product-upload and catalog upgrade (Oct 2026). It records:
- what existed before the upgrade;
- what was changed;
- what was verified;
- what is still open.

Status values:
- **Done**: implemented and covered by a passing test.
- **Partial**: some of it is done; the entry says what is missing.
- **Not done**: deliberately left out; the entry says why.
- **Not verified**: needs a live Apps Script deploy or a real device to check.

## 1. Baseline (before any change)

| Area | What existed |
|---|---|
| Seller page | `owner/products.html` + `assets/js/owner-products.js`. One long form, shown under the product list, with Save and Cancel. |
| Listing type and category | Product / Rental / Service, then a category from the register narrowed to that type, an optional subcategory, and a request for a new category. |
| Category checks | Already existed: `ListingRules.gs` / `ListingReview.gs` and `owner-listing-check.js`. They do deterministic keyword checks, suggest a category, block or hold a listing, and run an admin review queue. |
| How it's sold | Single product (price, stock, SKU), product with options (colour, size and custom options, a combinations grid, bulk price and stock), or a legacy "list of varieties". Code: `owner-product-options.js`, `ProductVariants.gs`. |
| Wholesale | Price tiers and a minimum quantity for bulk sellers (`ProductOptions.gs`, `WHOLESALE_TIERS`). |
| Stock | Ledger-backed (`Inventory.gs`). A save can't set stock below what open orders already hold (`stockBelowReservedError`), and every change writes a `StockMovements` row. |
| Duplicate saves | Each save sends a `requestId`; a retried save gets the first answer back (`idempotentResult`). |
| Unsaved work | `unsaved-guard.js` warns before the seller leaves the page with unsaved changes. |
| Card preview | "Preview the shopper's card", which reuses `renderBrowseProductCard`. |
| Product photos | One main photo (`uploadProductImage`, slot 1). A second photo could only be **removed, never replaced or added** (the reported limitation). Photos per option: up to 4 per variety, stored in `ImagesJson` on the variety. |
| Bulk import | Already existed in the inventory Sync Center (`InventorySync.gs`, `owner/inventory-sync.html`): CSV or Google Sheets, column mapping, preview, then apply. Unmatched rows can become new products in one chosen category. |
| AI | None. The owner chose not to add a paid AI service (Oct 2026). |
| Drafts | None on the server. A product is "Hidden" until it is made Active. |

Baseline test run on `main` at `0a327f9`: all 24 product, inventory and listing test files passed, as did `test-inventory-*`, `verify-product-*`, `verify-photo2`, `verify-unsaved`, `verify-wholesale*`, `test-listing-review` and `test-product-options`. The last full suite, on #119, passed 196/198; the two failures were then fixed in #119.

## 2. Defects found during discovery

| # | Defect | Severity | Fix |
|---|---|---|---|
| D1 | `createProduct` / `updateProduct` accepted `imageUrl`, `imageFileId` and `imageFileId2` from the browser. A seller could point their product at any stored file id; replacing the photo then **trashed that file**, which could be another seller's photo or an ID document. | High | The server ignores all client-sent image fields. Photos change only through the upload and gallery actions, which create their own file ids. |
| D2 | The second photo could not be replaced or added. | Usability | Fixed by the new product photo gallery. |
| D3 | `uploadProductImage` accepted any `image/*` type, and trusted the browser's type. | Medium | Photos are now checked by their first bytes (JPEG, PNG, WebP, GIF). Anything else is refused. |
| D4 | Removing the second photo left its file in storage (an orphan). | Low | Removing a photo from the gallery deletes its file, unless another product or variety still uses it. |

## 3. Plan and status

The detailed status for each feature is kept in [product-upload-testing.md](product-upload-testing.md) once a feature lands. The summary:

| Feature | Status |
|---|---|
| Product photo gallery (up to 6, cover, reorder, replace, remove, drag and drop, camera, retry) | See §4 |
| Client photo optimisation (resize, WebP where supported, keep transparency, skip small files, readable HEIC message) | See §4 |
| Server image checks (by first bytes, size, type) and safe replacement order | See §4 |
| Guided sections with progress, quick add, live preview, completeness meter | See §4 |
| Drafts (recover unsaved work per seller on this device; server-side "Hidden" stays the saved draft) | See §4 |
| Likely-duplicate warning | See §4 |
| Category-aware details (weight, size, brand, condition and so on), stored additively | See §4 |
| Bulk import, built on the existing Sync Center: product template, per-row category, failure report | See §4 |
| AI assistant | Not done: the owner declined the paid service. Rule-based tips are in the completeness meter instead. |

## 4. Preservation risks and how each is handled

- **Product ids, variety ids, orders and stock.** Nothing in this upgrade rewrites them. Stock still changes only through `saveProductLocked` and the ledger (`productFormStockMove`, `recordStockMovements`).
- **Existing photos.** `ImageUrl` and `ImageUrl2` stay the first two photos of the gallery and are always written alongside it. Every page that reads `imageUrl` / `imageUrl2` keeps working. A product without the new `ImagesJson` column reads its gallery from those two fields.
- **Sheets.** The only new column is `Products.ImagesJson` (created on first use), plus `Products.AttributesJson` for category details (see the architecture doc). There are no new tabs and no rewritten columns.
- **API.** The new actions are additive (`uploadProductPhoto`, `setProductPhotos`). The old `uploadProductImage` (slot 1/2) still works, writing into the gallery.

## 5. Deployment

Apps Script files that change, and the version check, are listed in [product-upload-deployment.md](product-upload-deployment.md).
