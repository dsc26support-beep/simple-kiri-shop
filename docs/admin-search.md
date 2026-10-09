# Admin page: search everything, shortcuts, section menu

Owner request, October 2026. Everything is on `owner/admin.html`. The server
part is `actionAdminSearch` in `apps-script/Admin.gs`, and it is admin-only:
a seller gets "Not authorized".

## Search everything

One box searches all of these at once:

| Record | Matched on |
|---|---|
| Stores | name, slug, email, phone, WhatsApp |
| Products | name, exact product id |
| Orders | order number, customer name, items, customer phone |
| Featuring payments | MWF reference, bank receipt number |
| Listing review cases | product name, proposed category name, case id, product id |

- **Results:** grouped by type with counts, newest first, at most 10 per group
  (20 for stores and products).
- **What a tap opens:**
  - **Store or product:** the store's analytics panel. This is unchanged.
  - **Order:** its store, customer, phone, status, total, date and items, with
    *Open this store*.
  - **Payment:** its details, with *Show in Featuring payments*, which scrolls
    to the row with its Approve / Seen in bank buttons and highlights it.
  - **Review case:** opens it in *Listing review*, with any filters cleared.

## Shortcuts

An exact reference opens its record straight away. Letter case doesn't matter,
and Enter searches without waiting for the pause.

- `SKS-…` is an order number.
- `MWF` followed by 6 characters is a featuring payment.
- `rev_…` is a listing-review case.

**Phone numbers:** anything that is mostly digits, with at least 5 of them, is
treated as a phone number. Spaces, `+`, `-` and brackets are ignored, so
`+686 7300 1234` finds a store or customer saved as `73001234`, and the other
way round.

## Section menu

- **Placement:** a row of buttons at the top of the admin page that stays put
  while scrolling. On a phone it scrolls sideways.
- **Entries:** Search, Listing review, Featuring payments, Featured now,
  Feature a store / product, Wholesalers, Inventory, Marketing, Seller badges,
  Badge settings.
- **Behaviour:** the section on screen is highlighted. Each section's heading
  lands just below the menu, not under it.

## Tests

- `tests/test-admin-search.js` (backend, 17 checks)
- `tests/verify-admin-jump.js` (browser, 13 checks)
- `tests/verify-admin-search.js` (the existing store analytics, still passing)

## Deploy

1. Re-paste `Admin.gs` and `Code.gs`.
2. **Deploy → New version.**
3. `?action=getVersion` should show `adminsearch2-2026-10-09`.
