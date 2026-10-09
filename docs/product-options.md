# Product options, variants and photo carousels

Owner request, October 2026. A product is either a **single product** (one
price, one stock count) or a **product with options** (Colour, Size, or any
option the seller names). Each combination the seller sells has its own price,
stock, SKU and photos. Shoppers see **one** listing per product, with a manual
photo carousel, colour swatches and an option picker. Sold-out choices stay
visible but cannot be bought.

## What already existed, and what changed

The `Variants` sheet already held one row per sellable thing, with its own
price, SKU, stock, reserved stock and stock-movement ledger. Orders already:

- pointed at that exact row;
- re-read the price on the server;
- reserved stock under a script lock;
- stored an item snapshot.

**That remains the single source of truth.** No new table or database was
added. What was missing:

- **Options:** a variant only had a free-text label ("Red M"). There were no
  option types or values, so there were no combinations, no swatches and no
  real "not sold in this combination".
- **Photos:** there were no photos per variant. A product had one photo; the
  second-photo upload was removed in #39.
- **Shopper experience:**
  - the product page pre-selected the first variety in a dropdown;
  - cards had no carousel.
- **Ordering:** there was no protection against a retried checkout creating a
  second order.

| Piece | File |
|---|---|
| Rules: validate options, make combinations, plan changes, availability. Shared with the browser via `npm run build` → `assets/js/product-options.js` | `apps-script/ProductOptions.gs` |
| Save single/options products, per-variant photo upload/reorder/remove, Script Property limits | `apps-script/ProductVariants.gs` |
| Read helpers and the public payload (`productType`, `options`, variant `values` / `images` / `sku`) | `apps-script/Products.gs` |
| Order: options and SKU in the snapshot, money rounded to the cent, `requestId` retry safety, hidden/held products refused | `apps-script/Orders.gs` |
| Routes `uploadVariantImage`, `setVariantImages`; `checkSetup` probes; `APP_VERSION` | `apps-script/Code.gs` |
| Seller editor: Single / Options, options and values, combinations grid, bulk changes, photos per combination, card preview | `owner/products.html`, `assets/js/owner-product-options.js`, `assets/js/owner-products.js` |
| Card carousel and swatches (any page with product cards) | `assets/js/helpers.js`, `assets/css/styles.css` |
| Product page option picker and gallery | `product.html`, `assets/js/product-options-ui.js`, `assets/js/product-card.js`, `assets/js/product-page.js` |
| Checkout sends a `requestId` | `assets/js/checkout.js` |

## Data model

All additions are new columns, created on first use with `ensureColumn` past
the last header. Nothing is renamed or moved, and no existing row is rewritten
until its seller saves it.

| Sheet | New column | Holds |
|---|---|---|
| Products | `ProductType` | `single`, `options`, or blank (an older "list of varieties", unchanged) |
| Products | `OptionsJson` | `[{ id, name, kind: colour/size/custom, values: [{ id, label, hex? }] }]`, in display order |
| Variants | `OptionValuesJson` | `{ optionId: valueId }`: this variant's combination |
| Variants | `ImagesJson` | `[{ id, url, fileId }]`; the first is the primary photo |
| Variants | `CreatedAt`, `UpdatedAt` | timestamps |

`Variants.Status` gains **`disabled`**: a combination that isn't sold, or no
longer exists. The row, its stock history, open orders and photos stay attached
to it. Every order path accepts only `active`, so a disabled combination cannot
be bought even with a hand-made request.

**Identity.** A variant is its `VariantId`, never its label or price. Option and
value ids are stable, so:

- renaming *Red* to *Crimson* renames the variants and keeps their ids;
- regenerating the grid matches existing rows by combination key and reuses
  them, so there are no duplicates.

`Label` is still written ("Red / M"), so carts, inventory screens, reports and
old code keep working.

**Order snapshot** (`Orders.ItemsJson`, written once, never updated):

```json
{ "productId": "...", "variantId": "...", "label": "Cotton T-shirt - Blue / M",
  "options": { "Colour": "Blue", "Size": "M" }, "sku": "TS-BM", "qty": 2, "unitPrice": 13, "lineTotal": 26 }
```

Renames, price changes and switched-off options never alter it. This is tested.

## Seller workflow (Owner → Products → Add / Edit)

1. **Shared details:** name, description, category and subcategory. The listing
   checks still apply.
2. **How is it sold?** (products only; rentals and services keep their list of
   rates):
   - **Single product:** price, stock (blank means unlimited), SKU and photos.
     No options are asked for. This is the default for a new product.
   - **Product with options:** add **+ Colour**, **+ Size** and/or
     **+ Another option** (any name, such as Package Size, Design or Flavour).
     None is required. Type the values; colours get a colour picker,
     pre-filled for common names. Options can be renamed, reordered or removed.
3. **Make the combinations.** Every combination of the values appears in a
   grid, starting with the price and stock typed above it. Untick the ones you
   don't sell; they can't be ordered.
4. **Per row:** price, stock, SKU and **Photos**:
   - upload several;
   - **Make main** sets the primary photo;
   - **Remove** deletes the photo.
   Photos chosen before the first save upload right after it.
5. **Find and bulk change.** Filter rows, tick some, and set a price or stock.
   You are asked to confirm, with the affected rows listed, first.
6. **Preview the shopper's card** shows the card from what is in the form now.
7. **Save.** If an existing product would gain combinations or have some
   switched off, the seller sees exactly which, and that switched-off rows are
   **kept, not deleted**, before confirming.

**Older listings** (blank `ProductType`) open as their **list of varieties** and
save exactly as before. Converting is explicit: choose *Single product* or
*Product with options*. Converting to options turns the old varieties into the
values of one option called "Option" and **reuses their variant ids**, so stock
history is kept. A page cached from before this release cannot overwrite a
product with options; the backend asks it to reload.

### Limits (Script Properties; defaults in brackets)

| Property | Default | Meaning |
|---|---|---|
| `PRODUCT_OPTION_TYPES_MAX` | 3 | Option types per product (1–5) |
| `PRODUCT_OPTION_VALUES_MAX` | 20 | Values per option (1–50) |
| `PRODUCT_VARIANTS_MAX` | 100 | Combinations per product (1–250). A Products/Variants sheet read stays fast, and the grid stays usable on a phone. |
| `VARIANT_IMAGES_MAX` | 4 | Photos per combination (0–10; 0 turns variant photos off) |

Uploads reuse the existing photo rules: images only (JPEG/PNG/WebP/GIF here),
5 MB maximum, compressed in the browser first, and stored on Cloudinary or the
Drive folder exactly as product photos are.

## Shopper behaviour

**Catalogue card** (home, store page, similar products):

- **One parent product:**
  - one card per product, never one per colour or size;
  - its price is the truthful range of what is on sale ("$12.00-13.00").
- **Photos:**
  - the product's own photo, then each colour's main photo, up to 6;
  - a **manual** carousel: ‹ › arrows, swipe, and a "1 of 4" counter;
  - no autoplay;
  - off-screen photos are lazy-loaded;
  - a photo that fails to load shows a blank panel, not a broken icon.
- **Colour swatches** (when the product has a Colour option):
  - a sold-out colour has a diagonal line through it;
  - tapping one jumps to that colour's photo and says what is in stock, for
    example "Blue: in stock in S, M, L" or "Red: sold out", so a swatch never
    implies every size is available.
- **Controls:** arrows, swatches and the counter sit above the card's link, so
  tapping them never opens the product. Keyboard: ← and → move the carousel.
- **Sold out:** a product whose every combination is sold out shows *Sold out*.
  One sold-out size or colour does not.
- **Compact store-page cards** keep the owner's earlier rule: no swatches,
  badges or place. The carousel stays.

**Product page:**

- **Nothing is pre-selected.** The page asks you to "Choose colour and size",
  and *Add to Cart* stays disabled until a combination is chosen that can be
  bought.
- **Each value is in one of four states:**
  - **available**;
  - **sold out:** marked and announced, still selectable so you can see it;
  - **doesn't go with your other choice:** dashed and tappable. Tapping it
    **clears the conflicting choice and says so**, e.g. "Size L isn't sold in
    Green, so it was cleared". A different variant is never substituted.
  - **not sold at all:** disabled.
- **Gallery:** main photo, arrows, counter and thumbnails. Choosing a colour
  shows **that colour's photos**, and a full combination with its own photos
  shows those. A colour without photos falls back to the product's own photos,
  never another colour's.
- **Live line:** shows the exact price, stock ("Only 2 left" or "Sold out") and
  SKU, and is announced to screen readers. Quantity is capped at the stock.
- **Single products:** no picker. They add to the cart under their name alone.

## Server-side protection

- **Prices** are read from the `Variants` row at checkout and rounded to the
  cent. A price sent by the browser is ignored (tested with a $0.01 payload).
- **What is refused at checkout:**
  - inactive, disabled, removed or made-up variant ids;
  - variants of a hidden, held or archived product;
  - quantities that aren't whole numbers from 1 to 10,000.
- **Stock:** checked and **reserved inside the script lock** (existing
  behaviour), so two shoppers can't both buy the last unit. A cancellation
  releases it.
- **Retries:** a checkout retry with the same `requestId` within an hour returns
  the first order: no second order, and stock is not reserved twice. The id is
  recorded before the lock is released.
- **Seller writes** check product ownership on the server. Variant ids from
  another product are refused, and so are photos for another seller's variant.
  Option names and values are length-capped and may not contain `<` or `>`.
  All output is escaped.
- **Storage:** photo file ids are never sent to shoppers, only URLs.

**Residual limits (Apps Script):** the script lock serialises checkouts per
deployment, which is the strongest guarantee the platform offers. It is not a
database transaction. If the script fails part-way through an order (a
timeout), the order row can exist without its reservation; the existing ledger
shows this. Retry ids live in CacheService (one hour), so a retry after that is
treated as a new order.

## Category checks stay separate

Option names and values are never used to classify a product. They feed only
the listing checks' details rule: a "600ml" value counts as the volume. A red
shirt is still Fashion, and "Water blue" as a colour is not a drink (tested).

## Deploying

1. **Merge.** GitHub Pages serves the new pages and scripts. The service-worker
   cache is v130.
2. **Apps Script:**
   1. Add two **new** files with **+ → Script**: `ProductOptions` and
      `ProductVariants`.
   2. Re-paste `Products.gs`, `Orders.gs` and `Code.gs`.
   3. **Deploy → New version.**
3. **Check:**
   - `…/exec?action=getVersion` shows `variants1-2026-10-09`.
   - `…/exec?action=checkSetup` lists no missing files. **If either new file is
     missing, every product save fails.**
4. **Optional:** set the Script Properties above to change the limits.

**Rollback:**

1. Redeploy the previous Apps Script version and revert the PR.
2. The new columns are then unused. Older listings were never touched.
3. Products saved with options keep their variant rows. Under the old code they
   show as plain varieties with labels like "Red / M", which still works.
   Disabled combinations stay unorderable.

## Tests

| File | What | Result |
|---|---|---|
| `tests/test-product-options.js` | Real `.gs` sources in the harness: the brief's creation, validation, combination, photo, payload, ordering, idempotency, cancellation, permission and migration cases | 73 checks, all pass |
| `tests/verify-product-options.js` | Browser at phone width: product page (no preselection, sold-out and not-sold states, clearing a conflicting choice, gallery per colour, add exact variant, qty cap), card carousel (arrows, swipe, counter, no autoplay, no navigation), swatches (stock note, sold-out marking), all-sold-out card, seller editor (Single default, no forced options, duplicate value, combinations, bulk with confirmation, card preview, older listing kept and converted explicitly, change summary on save) | 43 checks, all pass |

```sh
node tests/test-product-options.js
python3 -m http.server 8099 & node tests/verify-product-options.js
```

**Not tested here:**

- The live Apps Script deployment and real Sheets / Cloudinary or Drive uploads.
  This sandbox can't reach Google. Uploads are stubbed in the harness.
- A true parallel race, since the harness runs one request at a time. The lock
  behaviour is the existing, tested inventory path.

## Known limits

- **Photos are per combination.** A seller with Red in S, M and L uploads Red
  photos once (to any Red row): the shopper sees that colour's photos for every
  Red size, but the seller editor doesn't copy them across rows.
- **Card picker.** The round cart button on cards lists combinations by label
  ("Blue / M"), sold-out ones disabled. Choosing by swatch happens on the
  product page.
- **No discount model.** The codebase has no sale/compare-at prices, so none was
  invented. Each combination's price is its price.
- **New top-level option kinds** (only colour, size and custom are styled) need
  no code. Only *colour* gets swatches.
- **Product page preview.** The seller preview shows the card, not the full
  product page.
