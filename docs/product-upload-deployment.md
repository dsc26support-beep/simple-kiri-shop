# Product upload: deployment and rollback

## What changes

| Part | Files | How it goes live |
|---|---|---|
| Apps Script | `Images.gs`, `Products.gs`, `ProductDetails.gs` (new), `InventorySync.gs`, `Code.gs` (`APP_VERSION = 'photos1-2026-10-21'`) | Manually (below) |
| Website | `owner/products.html`, `owner/inventory-sync.html`; the files `owner-products`, `owner-product-photos` (new), `owner-product-steps` (new), `owner-product-options`, `owner-inventory-sync`, `helpers`, `product-card`, `product-options-ui` and `auth` (each a `.js` with its `.min.js`); `styles.css` and `owner.css`; `sw.js` | GitHub Pages, after merging |

## Sheets (all additive, made on first use)

| Sheet | New column | Made when |
|---|---|---|
| `Products` | `ImagesJson` | A photo is first added or reordered |
| `Products` | `AttributesJson` | A product is first saved with details |
| `Products` | `SubcategoryId` | Already existed for the form; now also made by import |

Nothing else is added, renamed or removed. Existing photos keep working without `ImagesJson`.

## Deploy order

1. **Apps Script first.** The new website calls `uploadProductPhoto`, `setProductPhotos` and `findSimilarProducts`, which an older backend doesn't have.
   1. Paste `Images.gs`, `Products.gs`, `InventorySync.gs` and `Code.gs`.
   2. Add a new file `ProductDetails.gs` and paste it in.
   3. Go to **Deploy → Manage deployments → Edit → New version**.
   4. Open `<web app URL>?action=getVersion`. It should show **`photos1-2026-10-21`**.
2. **Then merge the PR** (GitHub Pages publishes the website).
3. **Optional:** set the Script Property `PRODUCT_IMAGES_MAX` (2–12) to change the default of 6 photos.

If the website goes live before the backend:
- products save as before;
- photos say "Unknown action" and stay marked "didn't upload" for a retry;
- the duplicate note simply doesn't show.

Nothing is lost.

## Rollback

| To undo | How | What is kept |
|---|---|---|
| Website | Revert the PR on GitHub. | Products, orders, stock and photos are untouched. |
| Apps Script | Redeploy the previous version (Manage deployments → choose the earlier version), or paste back the previous files. | `ImageUrl` / `ImageUrl2` always hold the first two photos, so older code still shows them. The 3rd–6th photos stay in `ImagesJson`, unused until this version is back. `AttributesJson` is simply not read. |

- Never delete the new columns during a rollback. They hold sellers' photos and details.
- No orders, stock movements or seller data are removed by either rollback.

## Manual checks after deploying

1. **Gallery:** edit a product that has two photos.
   - Replace the second photo and save. Both photos should show on the store page.
   - Add three more, make the 4th the cover, then save. The store card should show 5 photos, cover first.
2. **New product:**
   1. Go through the steps with food details.
   2. Check that Review shows the details and "not saved yet".
   3. Save, then open the product page and check its "Details".
3. **Duplicate note:** type the name of a product you already have. The note should appear with "Open it".
4. **Unsaved copy:**
   - Type a new listing, close the tab, reopen Products and press Add. Restore should be offered.
   - Log out and back in. It should be gone.
5. **Import:**
   1. Download the product template, fill in two rows, choose it, and tick "Add items…".
   2. Preview, then Apply. The products should appear in their categories.
   3. Import the same file again. Nothing new should be added.
