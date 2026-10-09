# Header adverts

Owner request, October 2026. The strip in the homepage header (red on a
computer, yellow on a phone) shows adverts set on the admin dashboard. Each
advert is one short line of text, and tapping it opens its link.

## How it behaves

- **Movement:** each line slides in from the **right**, stays still for **6
  seconds**, then slides out to the **left**, and the next comes in. Nothing
  pops in or fades.
- **Pausing:** it holds still while the shopper points at or tabs to it, and
  while the browser tab is hidden. With "reduced motion" set on the device,
  lines change in place without sliding.
- **No advert running:** the three built-in lines show (Local Kiribati
  sellers, Chat directly with the seller, and Delivery, shipping & pickup
  options). They slide the same way and are not links.
- **Where:** the homepage only.
- **Phones vs computers:**
  - On phones the strip is the yellow band under the header.
  - On computers it sits inside the red header, between the logo and the cart.
    Only the advert's own text can be clicked; the logo, cart and menu are not
    covered.
- **Links:** a Mwakete page opens in the same tab. An outside https:// address
  opens in a new tab.
- **Returning visitors:** the last adverts seen are remembered on the device,
  so a returning shopper sees them immediately. The backend is then asked
  again once the page is idle. That is one small request per visit, cached for
  5 minutes on the server.

## Managing adverts (Admin → Header adverts)

1. **Text:** up to 80 characters, so it fits on a phone. A live preview of the
   red strip shows it as you type.
2. **Link:** pick a store, which fills in `store.html?store=…`, or type one of:
   - a Mwakete page, such as `product.html?store=…&product=…` or
     `categories.html?category=…`;
   - a full `https://` address.

   Anything else is refused, including `javascript:`, `http://` and `data:`.
3. **Dates:** start and end dates are optional and inclusive, in Kiribati days.
   An advert switches on and off by itself.
4. **Show it:** untick to keep an advert without showing it.
5. **List actions:** reorder (↑ ↓), Edit, Switch off/on, and Delete (asks
   first). Each advert shows whether it is *Showing now*, *Starts …*,
   *Ended …* or *Off*.

Up to 10 adverts rotate at once. Changes reach the homepage within 5 minutes
(at once for the admin who made them).

**Paid seller adverts**, where sellers buy a slot the way they buy featuring,
are a later, separate decision because they involve charging.

## Data

The `HeaderAds` tab is created on first save. Its columns are:

`AdId | Text | Link | StartDate | EndDate | SortOrder | Status | CreatedAt | UpdatedAt | UpdatedBy`

`Status` is `active`, `off` or `deleted`. A deleted row is kept but never
shown.

## Files

- **Backend:** `apps-script/HeaderAds.gs`. Its routes are in `Code.gs`: the
  public GET `getHeaderAds`, and the admin-only `adminListHeaderAds`,
  `adminSaveHeaderAd`, `adminReorderHeaderAds` and `adminDeleteHeaderAd`.
- **Homepage:** `assets/js/header-ads.js`, `index.html` and `assets/css/styles.css`.
- **Admin:** `assets/js/admin-header-ads.js`, `owner/admin.html` and
  `assets/css/owner.css`.

## Tests

- `tests/test-header-ads.js` (backend, 22 checks).
- `tests/verify-header-ads.js` (browser, 23 checks). It covers:
  - right-to-left slide direction, the 6-second hold and pausing on hover;
  - clicking an advert, and that the logo is still clickable on a computer;
  - escaping, keyboard access and the remembered adverts;
  - the admin form.
- `tests/verify-homepage.js` now allows the one idle `getHeaderAds` call.

## Deploy

1. Add the **new file** `HeaderAds` with **+ → Script**, and paste in
   `HeaderAds.gs`.
2. Re-paste `Code.gs`.
3. **Deploy → New version.**
4. `?action=getVersion` should show `headerads1-2026-10-09`, and
   `?action=checkSetup` should show `"missingFiles":[]`.
