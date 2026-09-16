# Categories

Seventeen categories, plus one rail entry that is not a category at all.

## The list

| | | Accepts | On the homepage strip |
|---|---|---|---|
| — | **Featured** | *nothing — see below* | No |
| 1 | Food & Groceries | product, service | Yes |
| 2 | Fashion & Beauty | product, service | Yes |
| 3 | Electronics & Phones | all | Yes |
| 4 | Home & Living | all | Yes |
| 5 | Building & Hardware | all | |
| 6 | Vehicles & Transport | all | Yes |
| 7 | Fishing & Marine | all | |
| 8 | Agriculture & Local Products | product, service | |
| 9 | Handicrafts & Souvenirs | product | |
| 10 | Property & Accommodation | rental, service | |
| 11 | Services | service | Yes |
| 12 | Education & Jobs | service | |
| 13 | Events & Travel | all | |
| 14 | Everything Solar | all | Yes |
| 15 | Hire | rental, service | Yes |
| 16 | Rental | rental | Yes |
| 99 | Other | all | No — **and no longer offered to sellers** |

Defined once in `assets/js/helpers.js` (`CATEGORIES`) and mirrored as an id list
in `apps-script/Products.gs` (`CATEGORY_IDS`). `tests/test-taxonomy.js` fails if
the two drift.

## Featured is a view, not a category

It heads the browse rail and shows whatever an admin has hand-picked into the
`Featured` sheet, across every category at once.

**It is deliberately not a member of `CATEGORIES`, and `featured` is
deliberately not in `CATEGORY_IDS`.** That is the entire safety argument:

- `activeCategories()` feeds the seller's category dropdown, so a category in
  that list is a category a seller can choose.
- `CATEGORY_IDS` is the set of ids a stored row may hold.

A category a seller could pick is a category a seller could put themselves at
the top of the rail with — which is the one thing an admin-curated Featured
sheet exists to prevent. Being in neither list means the picker never offers it
and the backend never keeps it: `categoryIdOf()` on both sides falls through to
`other` for an id it does not recognise, so a hand-crafted `category=featured`
lands in Other rather than at the top of the rail.

It lives in `FEATURED_VIEW` (helpers.js) and is prepended by `renderRail()`.

### How the view behaves

- **Not the default landing.** `?category=featured` is a valid shared link, but
  the page opens on the first real category. Featured holds only what someone
  curated, so on a day nobody has curated anything it would open empty.
- **No extra request.** `loadFeatured()` is already in flight from `init()` for
  the per-category strip, so the view awaits that promise instead of asking for
  the same rows again.
- **The strip is hidden inside the view.** The strip exists to show a category's
  featured items *above* that category's products; above a list of featured
  items it would be the same rows twice.
- **Legacy categories still appear.** `getTips` emits the sheet's `Category`
  untouched, so the view maps it through `categoryIdOf()` — otherwise an item
  filed as `pantry` would silently never show.

## Rental is now both a category and a listing type

There is a `rental` **category** and a `rental` **listing type**. That is the
same collision the original `rentals` category caused and was removed for, so
what keeps it safe is worth stating:

- They are separate fields on a row — `Category` and `ListingType` — and
  separate namespaces in code.
- `listingTypeOf()` never consults the category except for the legacy values.
- A product filed under Rental is still a product: the listing type decides
  whether something goes in the cart or through the by-date request flow, and
  it always wins over the category.

**Legacy `rentals` still maps to `other`, not to the new `rental` category.**
Knowing a thing was rented says nothing about *what* it is, and that mapping is
how those rows stay flagged for an admin's eye (`LEGACY_NEEDS_REVIEW`). Worth
revisiting once someone has looked at them.

### Hire vs Rental

Near-synonyms to a shopper, and asked for as two entries. They are told apart by
**type**, not by wording: Hire also takes services — hiring a person to do a job
— and Rental does not.

## Other is off the seller's form

Other was the catch-all that meant nothing could be unfileable, and it became
the place things went *instead of* being filed. There are seventeen categories
now and every listing type has several.

- **Still active**, so it stays on the browse rail and anything already in it is
  still reachable by a shopper. Nothing became invisible.
- **Still the read-time fallback** for a legacy or unrecognised value, on both
  sides. Removing that would have left unmapped rows with nowhere to go.
- **Gone from the seller's picker** — with one exception.

### The exception, and why it exists

A listing *already* filed in Other is offered it back, labelled
**"Other (please re-file)"**, and it disappears the moment they pick anything
else.

Without that, opening such a product's form would leave the picker empty, and
the "choose a category" guard in `saveProduct` would block the save — so a
seller wanting to change that listing's price would be forced to re-file it
first. `tests/verify-featured-view.js` drives that exact flow in a browser and
asserts the save goes through.

## Adding a category

1. `CATEGORIES` in `assets/js/helpers.js` — id, label, order, `popular`,
   `active`, `types`
2. `CATEGORY_IDS` in `apps-script/Products.gs` — the id
3. `SPEC` in `tests/test-taxonomy.js` and `CATS` in `tests/verify-categories.js`
4. `npm run build`, then redeploy the Apps Script with **Version: New version**

`order` is a display sort key only and is never stored on a row, so renumbering
rewrites nothing.

**Neither strip wraps**, so the count is free to grow: the browse rail is its
own scroller (`overflow-y: auto` inside a fixed-height grid column) and the
homepage strip scrolls sideways at a fixed `min-height: 52px`. Adding categories
costs scroll distance, not page height, and so no layout shift.

## Tests

| Suite | |
|---|---|
| `tests/test-taxonomy.js` | The two sources agree; Featured is storable nowhere; legacy values still land somewhere; a legacy rental is still a rental |
| `tests/verify-featured-view.js` | The rail, the Featured view, the three new categories, and the seller's picker driven in a real browser |
| `tests/verify-categories.js` | The browse page and its rail |
| `tests/verify-homepage.js` | The homepage strip, including that it stays one row |
