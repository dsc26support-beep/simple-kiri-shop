# Product upload: architecture (Oct 2026)

This upgrade extends the existing product system. Nothing was replaced:
- products and varieties are still saved by `actionCreateOrUpdateProduct` → `saveProductLocked` (`Products.gs`);
- stock still moves only through the ledger (`Inventory.gs`);
- bulk import is still the Import & Sync engine (`InventorySync.gs`).

## Seller page (`owner/products.html`)

| File | What it does |
|---|---|
| `assets/js/owner-products.js` | Loads the list, opens the form, checks and saves (as before). Exposes `validateBasics`, `validatePricing`, `pricingLooksSet` and `pricingSummary` for the steps. |
| `assets/js/owner-product-steps.js` (new) | The five sections. Also: Back / Continue, the Step-by-step / Quick add mode, details by category, the delivery summary, the listing-quality meter, the review, the likely-duplicate note, and the unsaved copy kept on this device. |
| `assets/js/owner-product-photos.js` (new) | The photo gallery and the photo optimiser (`optimizeProductPhoto`). |
| `assets/js/owner-product-options.js` | Single products and products with options (as before). Adds `snapshot()` for drafts, and uses the new optimiser for photos per option. |

### Sections

| # | Section | What's in it |
|---|---|---|
| 1 | Basics | Name, description, what you're offering, category and subcategory. Also the listing check and "request a category". |
| 2 | Photos | The gallery. |
| 3 | Price & stock | How it is sold, then the single price/stock, the options grid, or a list of varieties. |
| 4 | Details & availability | The fields for this category, availability, the store's delivery (read-only, from Settings), and who can see it. |
| 5 | Review | Listing quality, a summary marked *not saved yet*, and the shopper card. |

- **Step by step** (the default for a new listing) shows one section at a time.
- **Quick add (one page)** shows all of them. The choice is remembered on the device.
- **Editing** an existing listing always opens on one page.
- **Continue** checks only its own section.
- **Save** works from any section. It checks the whole form and opens the section that has the first problem.
- **Save hidden (draft)** saves the listing with status Hidden.

### Unsaved work kept on this device

| Topic | How it works |
|---|---|
| Storage key | `localStorage` key `mwk_pdraft_v1:<ownerId>:<productId or "new">` |
| What is kept | The form fields, the options editor's `snapshot()`, the variety rows and the details. Never a token. |
| When it is written | About 800 ms after the seller stops typing. |
| How it is offered back | On the next open, with Restore and Discard. If the listing changed on Mwakete since then, the offer says so first. Photos that were picked but not uploaded are not kept, and the seller is told. |
| When it is cleared | On a successful save, on Discard, after 30 days, and on log out (`auth.js clearSession`). |
| What the seller sees | It is always described as *kept on this device - not on Mwakete until you save*. |

## Photos

| Piece | Where |
|---|---|
| Gallery storage | `Products.ImagesJson` (new column, made on first use): `[{ id, url, fileId, req }]`, the cover first. |
| Compatibility | `ImageUrl/ImageFileId` and `ImageUrl2/ImageFileId2` are always rewritten to the first two photos. A product without `ImagesJson` reads its gallery from them. |
| Limit | `PRODUCT_IMAGES_MAX` Script Property: default 6, allowed range 2–12. |
| Actions | `uploadProductPhoto` (add, or `replaceId` to replace in place, retry-safe by `requestId`) and `setProductPhotos` (order; ids left out are removed). The old `uploadProductImage` (slot 1/2) still works, and writes into the gallery. |
| Shoppers | `images: [url, …]` on `listProducts`, `searchProducts` and top products. `helpers.js productOwnPhotos` / `cardGalleryImages`, `product-card.js` and `product-options-ui.js` show them all. |

### Save order (`ProductPhotos.apply`), after the listing itself is saved

1. Replacements go up in place. The server deletes the old file only after the new photo is saved.
2. One `setProductPhotos` call sets the removals and the order of the photos already saved.
3. New photos are uploaded.
4. A final `setProductPhotos` call puts the new photos in the order shown.

What happens when something fails:
- A failed photo stays on screen marked "Didn't upload", and the next Save retries it with the same `requestId`.
- A failed replacement keeps the old photo.
- A removed photo's file is deleted unless another product or variety still uses it (`storedImageInUse`).

### Optimiser (`optimizeProductPhoto`)

1. The photo is decoded with `createImageBitmap`, using the phone's orientation.
2. If the browser can't read the photo, the seller gets a plain message. HEIC gets its own advice.
3. A JPEG or WebP that is already small enough is sent as it is.
4. Otherwise the longest side is resized to 1280px and the photo is saved as WebP, which keeps transparency.
5. If the browser can't write WebP, it falls back to JPEG on white.

## Details by category

| Piece | Where |
|---|---|
| Server | `apps-script/ProductDetails.gs`. `PRODUCT_DETAIL_FIELDS` is the only list of allowed keys. Each one is a short text with a length limit, or one value from a fixed list. |
| Storage | `Products.AttributesJson` (new column, made on first use). `details` absent means keep the stored values; `{}` clears them. |
| Which fields each category gets | `owner-product-steps.js SETS`, plus a set for rentals and one for services. The server only checks keys and values, so a category can get more fields without a backend change. |
| Listing checks | Details feed `listingSaveGate` as attributes (`listingAttributesFromDetails`). "Weight / size" holding a volume counts as volume. |
| Shoppers | `details: [{ key, label, value }]` in the public payloads, shown on the product page by `productDetailsHtml`. Plain text. |

## Likely duplicates

`findSimilarProducts` (in `ProductDetails.gs`) works only on the signed-in seller's own listings that are not archived. It matches like this:
1. Names are compared word by word, and they must share 75% or more.
2. A listing in a different category doesn't count.
3. Different sizes or quantities in the name (1kg vs 25kg) don't count.
4. Different model numbers don't count.

The check is advice only. In step by step, Continue stops once on the note, and the next Continue carries on.

## Bulk import (Import & Sync)

The existing importer was extended, not replaced: CSV or Google Sheets, column matching, preview, then apply with a plan token, stock on the ledger, and the listing checks.

New:
- **Category column (per row):** a category or subcategory name or id. The Food rule is checked per row.
- **Description column.**
- **Already listed:** a new-product row whose name the seller already lists is skipped as "already on Mwakete". Rows that match by SKU or Mwakete ID update the existing product as before.
- **Downloads:**
  - the product template, whose columns are matched automatically;
  - the problems file, as CSV, with formula-looking cells made safe.
- **Limits (unchanged):** 2,000 rows and 200 new products per import.
- **Photos are not imported.** A file only carries text. Photos are added in the product form.

## Not built, and why

| Item | Reason |
|---|---|
| AI assistant | The owner chose not to pay for an AI service (Oct 2026). The quality meter's tips and the existing listing checks are rule-based and free. |
| Saving to the server while typing | A listing on Mwakete must be complete and checked before it is saved. Unfinished work is kept on the device instead, and "Save hidden" is the saved draft. |
| Delivery fees or areas per product | Delivery is set per store in Settings, and the form shows it read-only. Per-product delivery promises would need a decision on how they combine with store delivery and the drivers system. Sellers can note special handling in "Delivery needs". |
