# Listing checks and the review queue

Owner request, October 2026: a listing's name, description and category must
agree before it goes live. Where they clearly don't, the seller is told why and
shown better categories, and anything still unresolved goes to an admin.

## What was already here, and what changed

The brief described a Google Sites + Apps Script + Sheets shop. Mwakete differs
in one way: the website is the static site in this repository (GitHub Pages),
not Google Sites. The backend is Apps Script + Google Sheets, as the brief
assumed. Everything here fits the existing architecture:

| Piece | Where |
|---|---|
| Rules engine (pure functions, no AI, no outside calls) | `apps-script/ListingRules.gs`, copied by `npm run build` to `assets/js/listing-rules.js` |
| Category register, review queue, audit log, admin actions | `apps-script/ListingReview.gs` |
| Product save runs the checks | `actionCreateOrUpdateProduct` in `apps-script/Products.gs` |
| Inventory import runs the checks on new products | `applyImportPlan` in `apps-script/InventorySync.gs` |
| Seller form: live check, subcategory, suggestions, request a category | `owner/products.html`, `assets/js/owner-listing-check.js`, `assets/js/owner-products.js` |
| Admin queue, decisions, category register | `owner/admin.html` (Listing review section), `assets/js/admin-listing-review.js` |
| Routes | `apps-script/Code.gs` |

The 17 top-level categories (`CATEGORIES` in `helpers.js`, `CATEGORY_IDS` in
`Products.gs`) are unchanged: same ids, and no stored product is rewritten.
The register adds **optional subcategories** under them, such as Food & Groceries →
Canned Fish & Tuna. The brief's starter tree maps onto them like this:

- **Food & Beverages** → the existing Food & Groceries.
- **Clothing & Fashion** → Fashion & Beauty.
- **Household & Daily Essentials** → Home & Living.

## The rules (`ListingRules.gs`)

Deterministic keyword rules. The same file runs in the seller's browser (an
instant answer while typing) and on the server (the answer that counts). The
browser copy is never trusted.

1. **Normalising.** Text is lower-cased, apostrophes are dropped
   ("children's" becomes "childrens"), punctuation becomes spaces and simple
   plurals are folded ("dresses" becomes "dress").
2. **Matching.** Only whole words match, so "can" never matches inside
   "candle". Longer phrases match first and use up their words, so "water bottle"
   (a container) is never also read as "water" (a drink).
3. **Word guards** (`LISTING_TERM_GUARDS`). A neighbouring word cancels a
   match. Examples:
   - "water tank", "water pump", "cold water" and "waterproof" are not drinks;
   - "we can deliver" is not a tin;
   - "call my phone" is not a phone for sale.
4. **Asides** (`LISTING_ASIDE_CUES`). Anything after a comparison or pairing
   word in the same clause is set aside, for example "better than",
   "goes well with", "instead of", "delivered by" or "call". So "Bottled water,
   goes great with a tuna lunch" is about water.
5. **Kinds.** Every keyword category has a kind (beverage, canned-food,
   clothing, …). The rules compare kinds:

| Rule | Code | Fires when |
|---|---|---|
| A | `NAME_DESCRIPTION_MISMATCH` | The name and description each name a kind of thing, and they share none. |
| B | `CATEGORY_NAME_MISMATCH` | The name names a kind of thing that does not belong in the chosen category or subcategory. Exception: the thing is listed as also allowed there (`alsoIn`), such as a shell necklace under Handicrafts. |
| C | `CATEGORY_DESCRIPTION_MISMATCH` | The name says nothing either way, and the description belongs elsewhere. |
| D | `ATTRIBUTE_REQUIRED` / `ATTRIBUTE_RECOMMENDED` | A required or recommended detail is missing (see below). |
| — | `CATEGORY_INVALID`, `SUBCATEGORY_INVALID`, `TYPE_NOT_PERMITTED` | The category does not exist or is switched off, the subcategory belongs to another parent, or the category does not take this listing type. |

Rental and service listings in Services, Education, Hire, Rental, Property or
Events are not placement-checked by rules B and C. Those categories describe
*how* you get something, not *what* it is.

### Severity

Severity is a defined level, not a probability. Nothing here is a confidence
score.

| Level | What it means | What happens |
|---|---|---|
| **high** | Clear evidence: the name itself, or 2+ points of description evidence. A phrase of 2+ words is 2 points, a word is 1, a weak word (`~`) is 0.5. | **Blocks publishing.** |
| **medium** | Only one word, or only weak words. | Warning. The seller may *Save anyway*: the listing goes live and an admin gets a low-priority case. |
| **low** | A recommended detail is missing. | A tip. Never blocks. |

The point count above is also how suggestions are ranked. Catch-all
subcategories ("Other Canned Foods") are ranked after specific ones.

### Details (rule D)

A detail counts as present if it appears in the name, the description or an
option label: "600ml", "Size M", "185g", "sterling silver". No new form fields
were added. Available details are `volume`, `netQuantity`, `size` and
`material` (`LISTING_ATTRIBUTES`).

By default nothing is mandatory, because the business hasn't decided to require
any detail. The starter register only recommends:

- volume for drinks;
- net weight for food;
- size for clothing and shoes;
- material for jewellery.

An admin can make a detail mandatory per category. A missing mandatory detail
blocks saving and cannot be overridden: the seller must add it.

### Images (rule E)

Images are not analysed, and nothing is sent to an outside service. The rest
works without it.

### Known limits

- **Vocabulary.** It only knows the words in the register. A product named
  with words it doesn't know ("Sunbell 185") is not flagged. Add keywords on the
  admin page.
- **English only.** Kiribati words need adding as keywords or synonyms (for
  example *te ririi*, *babai*).
- **Wrong context.** A word used in an unexpected sense can still trip a check.
  "Chocolate" as a colour is guarded; other cases will turn up. Those land as
  medium warnings or in the queue, where *Dismiss (false positive)* clears that
  one listing. Add a guard or cue in `ListingRules.gs` for repeats.

## What a seller sees

1. **While typing.** The panel above Save shows any mismatch in plain words and
   the suggested categories with their full path. *Use …* applies a suggestion
   and re-checks at once.
2. **On a blocked Save.** Nothing is saved. The explanation stays, with two
   options:
   - fix the listing;
   - **Submit for review**, with an optional note for the reviewer. The listing
     is then saved **held**: Status `review`, hidden from shoppers.
3. **On a warning.** **Save anyway** publishes the listing and opens a
   non-blocking case.
4. **Fixing it later.** Once an edited listing passes, it goes live and its
   open case closes itself (`SELLER_CORRECTED`). Changing only the category
   doesn't get around a check, because every save re-checks the name and
   description too.
5. **Products list.** Shows *in review*, an admin's correction request or a
   rejection reason. Internal notes such as override and dismiss reasons are
   never shown.
6. **Requesting a category.** *Can't find a suitable category? Request a new
   one* takes:
   - a name;
   - a parent (optional);
   - what would go in it;
   - example products.

Repeated blocked saves are throttled: 30 an hour per store.

## Review queue (admin)

**Owner → Admin → Listing review.**

- **Metrics** are counted from the queue rows:
  - pending;
  - high priority;
  - category requests;
  - disputed by the seller;
  - resolved in the last 7/30/90 days.
- **Filters:** status, severity, reason, category, seller, date range, and a
  search on product name, product id or review id.
- **Paging:** 20 a page, filtered on the server.
- **Case view:** what was submitted (a snapshot), the product as it is now, the
  checks then and **re-run now**, suggestions, the seller's note, the history
  and earlier cases.

### Listing case actions

| Action | Result |
|---|---|
| Start review / Release | Takes the case (`IN_REVIEW`) or hands it back (`PENDING`). |
| **Approve** | Publishes the listing, but **only if it passes the checks now**. It is refused otherwise. |
| **Assign & re-check** | Moves the listing to an existing category and re-runs the checks. It publishes only if it now passes; otherwise it stays hidden and the case stays `IN_REVIEW`. |
| **Request correction** | Needs a reason, which is emailed to the seller and shown on their product list. Sets `CORRECTION_REQUIRED`. |
| **Reject** | Needs a reason. The listing is hidden (not deleted) and the seller is told why. |
| **Dismiss (false positive)** | Needs a reason. Publishes the listing (`DISMISSED`). |
| **Override & publish** | Needs a reason. Publishes the listing (`APPROVED`, `OVERRIDE`). |
| Close (final) | Closes a decided case. |
| Reopen | Needs a reason. A listing that now fails the checks is hidden again. |

**Overrides and dismissals:**

- They cover **that listing's exact content**: name, description, category and
  subcategory, stored as a fingerprint. A later price or photo edit is not
  blocked again. Any change to the text or category is checked from scratch.
  Nothing switches a rule off for anyone else.
- Some problems cannot be overridden: a broken or switched-off category, a type
  the category doesn't take, or a missing mandatory detail. The seller must fix
  those.

### Category request actions

- **Approve category.** Takes a name (can be renamed), a parent and keywords.
  It is refused if the name duplicates an existing category or keyword, or is
  too broad ("stuff", "general", …). It gets a stable id (`parent-slug`), is
  added to the register as active and is available to sellers at once. Held
  listings are re-checked and the result noted on their cases.
- **Merge.** Points the seller to an existing category.
- **Reject.** Needs a reason, which the seller sees.

Approved categories are **subcategories**. A new top-level category also needs
a browse page and a home-page button, which is a code change in `helpers.js`
and `Products.gs`.

### Statuses and transitions (enforced on the server)

Allowed statuses: `PENDING`, `IN_REVIEW`, `AWAITING_SELLER`,
`CORRECTION_REQUIRED`, `APPROVED`, `REJECTED`, `DISMISSED`, `CLOSED`. Any other
value is refused.

```
PENDING / IN_REVIEW / CORRECTION_REQUIRED / AWAITING_SELLER  (open)
   → APPROVED | REJECTED | DISMISSED          (admin decision)
   → CLOSED                                   (seller fixed it)
   ↔ each other                               (claim, release, ask, resubmit)
APPROVED | REJECTED | DISMISSED → CLOSED (final) or PENDING (reopen)
CLOSED → PENDING (reopen)
```

`REVIEW_TRANSITIONS` in `ListingReview.gs` is the authority. The transition is
checked **before** anything is written, so a refused action leaves the product
untouched.

### Category register

**Admin → Listing review → Categories** shows every category with its listing
count. From there an admin can:

- switch a category on or off;
- edit its keywords.

Deactivating instead of deleting:

- There is no delete.
- A switched-off category disappears from the seller form and is refused for new
  listings.
- Listings already in it stay where they are and can still be edited.

Products store category **ids**, so renaming a subcategory breaks nothing.
Top-level names stay fixed in the site code. The Categories sheet can also be
edited directly; changes show within 10 minutes (the register cache).

## Security

- **Admins.** A signed-in owner session (server-side token, `requireAuth`)
  whose email is in the `ADMIN_EMAILS` Script Property. Every admin action
  checks `isOwnerAdmin` on the server. The page hiding the section is
  convenience only.
- **Unauthorised attempts** are refused with "Not authorized" and logged as
  `UNAUTHORIZED_ATTEMPT`. Only the action name and the actor id are recorded,
  never the request.
- **Sellers** can only touch their own products. They cannot:
  - set a product to `active` while it is held (only `active`/`hidden` are
    theirs to choose);
  - read the queue;
  - change any case.
- **Validation.** Every field is length-capped. Category and subcategory ids
  are checked against the register. Attribute objects are reduced to known
  keys. Category names allow letters, digits and `& ' - ( )` only.
- **Output.** Every value written to a page goes through `escapeHtml`. Sheet
  writes are formula-escaped (`Db.gs`).
- **Concurrency.** Every write holds the script lock. Admin actions carry the
  case **version**: a stale one is refused ("changed by someone else") rather
  than overwriting.
- **Retries.** Saves, category requests and admin actions carry a `requestId`.
  A retry within 10 minutes gets the first answer back: no duplicate product,
  case or override.
- **Secrets.** None in the frontend. The only optional setting is
  `LISTING_REVIEW_NOTIFY` (below).

## Sheets

All created on first use. Nothing existing is rewritten.

| Tab | Columns |
|---|---|
| `Categories` | CategoryId, CategoryName, ParentCategoryId, Description, Keywords, Synonyms, PermittedProductTypes, RequiredAttributes, RecommendedAttributes, Kind, AlsoListedIn, Status, CreatedAt, CreatedBy, UpdatedAt, UpdatedBy |
| `Product_Review_Queue` | ReviewId, CaseType (LISTING / CATEGORY_REQUEST), ProductId, SellerId, ProductNameSnapshot, DescriptionSnapshot, SelectedCategoryId, SelectedSubcategoryId, SuggestedCategoryIds, IssueType, Severity, Reason, ValidationRulesTriggered, ValidationJson, SellerDisputed, SellerNote, Status, SubmittedAt, ReviewedAt, ReviewedBy, ResolutionType, ResolutionReason, FinalCategoryId, FinalSubcategoryId, ProposedCategoryName, ProposedParentId, ExampleProducts, DuplicateOf, HistoryJson, Version, UpdatedAt |
| `Audit_Log` | AuditId, Timestamp, ActorId, ActorRole, Action, EntityType, EntityId, PreviousStateSummary, NewStateSummary, Reason, RequestId |
| `Products` (existing) | **+** SubcategoryId, RequestedStatus, ReviewId, ReviewApprovedFingerprint, appended after the last column |

`Products.Status` gains one value, `review` (held). Every public read already
shows only `active`, so held listings are hidden without other changes.

Audit actions:

- `VALIDATION_FAILED`
- `REVIEW_CASE_CREATED`, `REVIEW_CASE_UPDATED`
- `SELLER_CORRECTION`
- `REVIEW_*` (one per decision)
- `ADMIN_CATEGORY_CHANGE`
- `OVERRIDE`, `DISMISSED_FALSE_POSITIVE`
- `REVIEW_REJECT`
- `CATEGORY_REQUESTED`, `CATEGORY_APPROVED`, `CATEGORY_MERGED`, `CATEGORY_REJECTED`, `CATEGORY_UPDATED`
- `SAVED_UNDER_ADMIN_CLEARANCE`
- `UNAUTHORIZED_ATTEMPT`

Rows are only appended. No product payloads or personal data are stored;
summaries are capped at 300 characters.

## Deploying

1. **Merge** the PR. GitHub Pages serves the new pages and scripts.
2. **Apps Script:**
   1. Add two **new files** with **+ → Script**: `ListingRules` and
      `ListingReview`, pasted from the raw links in `DEPLOY.md`.
   2. Re-paste `Products.gs`, `InventorySync.gs` and `Code.gs`.
   3. **Deploy → Manage deployments → Edit → New version → Deploy.**
3. **Check:**
   - `…/exec?action=getVersion` shows the new `APP_VERSION`.
   - `…/exec?action=checkSetup` shows no missing files. **If either new file is
     missing, every product save fails**, which is why `checkSetup` probes them.
4. **Optional:** run `setupListingReview` once from the editor. It creates the
   three tabs and seeds `Categories`. Otherwise this happens by itself on first
   use, and until then the built-in starter register is used.
5. **Optional Script Property:** `LISTING_REVIEW_NOTIFY` = `true` emails
   `ADMIN_EMAILS` about each new case. It is off by default to avoid noise.

### Rollback

- **Code.** Re-deploy the previous Apps Script version (Manage deployments →
  pick the earlier version) and revert the PR.
- **Data.** Nothing needs undoing. The new tabs and columns are simply unused
  by the old code.
- **Held listings.** Held products (`Status = review`) stay hidden under the old
  code. To release them, set their Status to `active` in the Products sheet
  (filter Status = review).

### Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Every product save fails with "validateListing is not defined" | `ListingRules.gs` was not pasted (`checkSetup` names it). |
| A good listing is blocked | Open its case and use *Dismiss (false positive)* with a reason. If it keeps happening, add a guard or cue in `ListingRules.gs`, or edit the keywords on the Categories panel. |
| A new subcategory doesn't show in the form | The register is cached for 10 minutes. Changes made on the admin page clear it at once; direct sheet edits do not. |
| "This case was changed by someone else" | Another admin acted first. The case reloads; check it and try again. |

## Tests

| File | Covers | Result |
|---|---|---|
| `tests/test-listing-review.js` | Real backend sources in the gas harness: the brief's tests 1–31, mapped by number in each test name | 95 assertions, all pass |
| `tests/verify-listing-review.js` | Browser, phone width: live check, suggestions, submit for review, a dropped connection (no false success, retry reuses the request id), category request, admin metrics and filters, case view, versioned decisions, non-admin | 26 assertions, all pass |

```sh
node tests/test-listing-review.js
python3 -m http.server 8099 & node tests/verify-listing-review.js
```

**Not tested here:** the live Apps Script deployment and real Google Sheets.
This sandbox cannot reach script.google.com. The harness runs the real `.gs`
files against an in-memory sheet with the same row-1-headers behaviour.
