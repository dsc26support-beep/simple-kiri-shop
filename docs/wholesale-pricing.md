# Wholesale bulk prices and minimum order

Owner decision, October 2026: "Build wholesale tiers". Wholesaler and distributor stores can
charge less per unit for bigger orders, and set a minimum order, for each product option.

## What sellers and shoppers see

- **Seller (Products → Edit):** a *Wholesale prices* box under the price of a single product,
  or a *Wholesale* button on each row of the combinations grid. Up to 5 bulk prices
  ("From 10 — $16.50 each") plus an optional *Minimum order*.
- **Product page:** a *Bulk prices* table for the chosen option, starting at the minimum,
  and the quantity box starting at the minimum.
- **Cart:** the line shows the price for the quantity in the cart ("$16.50 each · Bulk price ~~$18.00~~"),
  the next cheaper step ("Buy 50+ for $15.00 each") and the minimum. It reprices while typing.
  A line can't go below its minimum (it goes back up to it); 0 still removes it.
- **Checkout and order:** the server's total. Order lines priced in bulk record `bulkPrice: true`
  and `normalPrice`, so the seller and the order room see it was a bulk price.

## Rules (one source: `apps-script/ProductOptions.gs`, copied to the browser by `npm run build`)

- Bulk price quantities are whole numbers of 2 or more, and are all different.
- Each bulk price is above $0 and **lower than the normal price**. Prices go down as the
  quantity goes up.
- The minimum order is blank (none) or a whole number. 1 counts as none.
- Price for a quantity = the last bulk price the quantity reaches, else the normal price —
  and **never more than the normal price** (if the normal price is later lowered below a
  bulk price, the shopper pays the lower normal price).
- The quantity is the **whole quantity of that option in the order**, even if it's split
  over two cart lines.

## Who gets it

Only when **both** are true: Script Property `WHOLESALE_TIERS` = `on`, **and** the store is a
wholesaler or distributor (`isBulkSeller`). Otherwise:
- the form doesn't offer it, and saves ignore any bulk fields sent;
- shoppers aren't sent bulk prices or minimums;
- orders are charged the normal price with no minimum.

Saved bulk prices stay in the sheet when the switch is off (nothing is deleted), and
come back when it's switched on again.

## Data (additive)

`Variants.PriceTiersJson` (`[{"minQty":10,"price":16.5}]`) and `Variants.MinOrderQty`,
added on the **first save that uses them** — stores without bulk pricing never change the
sheet. Malformed values read as "none" (normal price), never as an error at checkout.

## Safety

- The order total is always worked out on the server from the sheet (`actionCreateOrder`);
  any price the browser sends is ignored.
- The cart's display rule is checked against the server's rule for many cases in
  `tests/test-wholesale-tiers.js`.
- Not covered: the older "list of varieties" products. Convert them to a single product or
  a product with options to set bulk prices. *Buy again* from the customer dashboard adds
  the normal price to the cart; the server still applies the bulk price at checkout.

## Deploy

1. In Apps Script, update `ProductOptions.gs`, `ProductVariants.gs`, `Products.gs`, `Orders.gs` and `Code.gs`.
2. Deploy a new version. `?action=getVersion` should show `bulkprices1-2026-10-15`.
3. Nothing changes until you add Script Property **`WHOLESALE_TIERS` = `on`**.
4. To switch off: set it to `off` (or delete it). Saved bulk prices are kept.

## Tests

`tests/test-wholesale-tiers.js` (backend + cart rule) and `tests/verify-wholesale-tiers.js`
(browser, real backend: seller form → product page → cart → server total; retailer and
switch-off cases; 320/390px).
