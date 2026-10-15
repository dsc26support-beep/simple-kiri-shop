/**
 * Wholesale bulk prices and minimum order (owner decision, Oct 2026), on the
 * REAL backend sources (gas-harness): the shared rules, saving them, what
 * shoppers are sent, and above all what an order is CHARGED - always worked
 * out on the server, only for wholesaler/distributor stores, only while
 * WHOLESALE_TIERS is on. Also checks the cart's display price agrees with the
 * server's rule.
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const { makeBox } = require('./lib/gas-harness.js');
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e === undefined ? '' : e]);
const J = (x) => JSON.stringify(x).slice(0, 400);

const W = { OwnerId: 'own_w', StoreSlug: 'whole', StoreName: 'Whole', Email: '', Status: 'active', Island: 'South Tarawa', DeliveryPickPay: 'true', StoreType: 'wholesaler' };
const D = Object.assign({}, W, { OwnerId: 'own_d', StoreSlug: 'dist', StoreName: 'Dist', StoreType: 'distributor' });
const RT = Object.assign({}, W, { OwnerId: 'own_r', StoreSlug: 'retail', StoreName: 'Retail', StoreType: 'retailer' });
const box = makeBox({
  Owners: [Object.keys(W), Object.values(W), Object.values(D), Object.values(RT)],
  Products: [['ProductId', 'OwnerId', 'StoreSlug', 'Name', 'Description', 'Category', 'ListingType', 'ImageUrl', 'ImageFileId', 'ImageUrl2', 'ImageFileId2', 'Status', 'SortOrder', 'CreatedAt', 'UpdatedAt']],
  Variants: [['VariantId', 'ProductId', 'OwnerId', 'Label', 'Price', 'SKU', 'StockQty', 'Status']],
  Orders: [['OrderId', 'OwnerId', 'StoreSlug', 'CustomerName', 'CustomerPhone', 'CustomerEmail', 'Island', 'Village', 'DeliveryAddress',
    'DeliveryMethod', 'DeliveryCost', 'Notes', 'PaymentMethod', 'PaymentReference', 'ItemsJson', 'ItemsSummary', 'Subtotal', 'Total', 'Status', 'CreatedAt', 'UpdatedAt']],
  AbandonedCarts: [['CartId', 'StoreSlug', 'Email', 'ConvertedOrderId']]
});
const [OW, OD, OR] = box.__sheets.Owners.objects();
box.getImageFolder = () => null;
const flag = (v) => { if (v === null) delete box.__props.WHOLESALE_TIERS; else box.__props.WHOLESALE_TIERS = v; box.WHOLESALE_TIERS_MEMO = null; };
const clearCache = () => { box.__cache && Object.keys(box.__cache).forEach((k) => delete box.__cache[k]); box.WHOLESALE_TIERS_MEMO = null; };
const variants = (pid) => box.__sheets.Variants.objects().filter((v) => v.ProductId === pid);
const headers = () => box.__sheets.Variants.objects().length ? Object.keys(box.__sheets.Variants.objects()[0]) : [];
const save = (who, o) => { box.WHOLESALE_TIERS_MEMO = null; return box.actionCreateOrUpdateProduct(who, Object.assign({ listingType: 'product', status: 'active', description: '', category: 'food', subcategoryId: 'food-rice-grains' }, o)); };
const order = (slug, items, extra) => { clearCache(); return box.actionCreateOrder(Object.assign({ storeSlug: slug, items, customerName: 'Tia', customerPhone: '73000000',
  island: 'South Tarawa', village: 'Betio', deliveryMethod: 'pickPay', paymentMethod: 'cash' }, extra || {})); };
const pub = (slug) => { clearCache(); return box.actionListProducts({ storeSlug: slug }).products; };
const setCell = (sheet, id, col, val) => { const g = box.__sheets[sheet].grid; const h = g[0].indexOf(col); const ri = g.findIndex((row, i) => i > 0 && row[g[0].indexOf('VariantId')] === id); const keep = g[ri][h]; g[ri][h] = val; return keep; };
const TIERS = [{ minQty: 50, price: 15 }, { minQty: 10, price: 16.5 }];

/* ---------- the shared rules ---------- */
let t = box.normalizePriceTiers(TIERS, 18, 'Rice');
ok('rules: valid tiers are sorted by quantity', t.ok && J(t.tiers) === J([{ minQty: 10, price: 16.5 }, { minQty: 50, price: 15 }]), J(t));
ok('rules: blank rows are dropped, nothing = no tiers', box.normalizePriceTiers([{ minQty: '', price: '' }], 18).ok && box.normalizePriceTiers([{ minQty: '', price: '' }], 18).tiers.length === 0 && box.normalizePriceTiers(undefined, 18).tiers.length === 0);
ok('rules: a bulk price must be below the normal price', !box.normalizePriceTiers([{ minQty: 10, price: 18 }], 18).ok);
ok('rules: prices must go down as quantity goes up', !box.normalizePriceTiers([{ minQty: 10, price: 15 }, { minQty: 50, price: 16 }], 18).ok);
ok('rules: two tiers at the same quantity are refused', !box.normalizePriceTiers([{ minQty: 10, price: 15 }, { minQty: 10, price: 14 }], 18).ok);
ok('rules: quantity must be a whole number of 2 or more', !box.normalizePriceTiers([{ minQty: 1, price: 15 }], 18).ok && !box.normalizePriceTiers([{ minQty: 2.5, price: 15 }], 18).ok && !box.normalizePriceTiers([{ minQty: 'ten', price: 15 }], 18).ok);
ok('rules: price must be above 0', !box.normalizePriceTiers([{ minQty: 10, price: 0 }], 18).ok && !box.normalizePriceTiers([{ minQty: 10, price: '' }], 18).ok);
ok('rules: at most 5 tiers', !box.normalizePriceTiers([2, 3, 4, 5, 6, 7].map((q, i) => ({ minQty: q, price: 17 - i })), 18).ok);
ok('rules: not a list = refused', !box.normalizePriceTiers('10:15', 18).ok);
ok('rules: prices are kept to the cent', box.normalizePriceTiers([{ minQty: 10, price: '16.499' }], 18).tiers[0].price === 16.5);
ok('rules: minimum order blank or 1 = none', box.normalizeMinOrderQty('').value === '' && box.normalizeMinOrderQty(1).value === '' && box.normalizeMinOrderQty('10').value === 10);
ok('rules: minimum order must be a whole number', !box.normalizeMinOrderQty(0).ok && !box.normalizeMinOrderQty(2.5).ok && !box.normalizeMinOrderQty('x').ok && !box.normalizeMinOrderQty(10001).ok);
const tt = [{ minQty: 10, price: 16.5 }, { minQty: 50, price: 15 }];
ok('rules: price by quantity (9 / 10 / 49 / 50 / 500)', [9, 10, 49, 50, 500].map((q) => box.tierUnitPrice(18, tt, q)).join(',') === '18,16.5,16.5,15,15');
ok('rules: never above the normal price, even if it was lowered after', box.tierUnitPrice(14, tt, 10) === 14 && box.tierUnitPrice(14, tt, 50) === 14);

/* ---------- switch OFF (default): nothing changes ---------- */
flag(null);
let res = save(OW, { name: 'Rice 10kg', productType: 'single', variants: [{ price: 18, stockQty: 500, tiers: TIERS, minQty: 10 }] });
const riceId = res.productId;
ok('switch off: the save works as before', res.ok, J(res));
ok('switch off: bulk fields sent are ignored - no new columns in the sheet', headers().indexOf('PriceTiersJson') === -1 && headers().indexOf('MinOrderQty') === -1, J(headers()));
ok('switch off: shoppers get no tiers or minimum', (() => { const v = pub('whole')[0].variants[0]; return v.tiers === undefined && v.minQty === undefined; })());
res = order('whole', [{ variantId: variants(riceId)[0].VariantId, qty: 2 }]);
ok('switch off: an order of 2 pays the normal price', res.ok && res.items[0].unitPrice === 18 && res.items[0].lineTotal === 36 && !res.items[0].bulkPrice, J(res));
ok('switch off: the seller form is told bulk pricing is off', box.actionListOwnerProducts(OW, {}).bulkPricing === false);

/* ---------- switch ON ---------- */
flag('on');
ok('switch on: the seller form is told bulk pricing is on (wholesaler)', box.actionListOwnerProducts(OW, {}).bulkPricing === true);
ok('switch on: a retailer is still told it is off', box.actionListOwnerProducts(OR, {}).bulkPricing === false);
res = save(OW, { productId: riceId, name: 'Rice 10kg', productType: 'single', variants: [{ variantId: variants(riceId)[0].VariantId, price: 18, stockQty: 500, tiers: [{ minQty: 10, price: 19 }] }] });
ok('a bulk price above the normal price is refused with a clear message', !res.ok && /lower than the normal price/.test(res.error), J(res));
ok('...and nothing was written', headers().indexOf('PriceTiersJson') === -1);
res = save(OW, { productId: riceId, name: 'Rice 10kg', productType: 'single', variants: [{ variantId: variants(riceId)[0].VariantId, price: 18, stockQty: 500, tiers: TIERS, minQty: 'x' }] });
ok('a bad minimum order is refused', !res.ok && /minimum order/.test(res.error), J(res));
res = save(OW, { productId: riceId, name: 'Rice 10kg', productType: 'single', variants: [{ variantId: variants(riceId)[0].VariantId, price: 18, stockQty: 500, tiers: TIERS, minQty: '' }] });
const riceV = variants(riceId)[0];
ok('wholesaler: tiers saved, sorted, as JSON on the variant', res.ok && riceV.PriceTiersJson === J([{ minQty: 10, price: 16.5 }, { minQty: 50, price: 15 }]) && riceV.MinOrderQty === '', J(riceV));
ok('the seller form gets the saved tiers back', J(box.actionListOwnerProducts(OW, {}).products[0].variants[0].tiers) === riceV.PriceTiersJson);
let pv = pub('whole')[0].variants[0];
ok('shoppers are sent the tiers', J(pv.tiers) === riceV.PriceTiersJson && pv.minQty === undefined, J(pv));

const RID = riceV.VariantId;
res = order('whole', [{ variantId: RID, qty: 9 }]);
ok('9 bags: normal price $18.00', res.ok && res.items[0].unitPrice === 18 && res.total === 162 && !res.items[0].bulkPrice, J(res));
res = order('whole', [{ variantId: RID, qty: 12 }]);
ok('12 bags: bulk price $16.50 each = $198.00 (not $216)', res.ok && res.items[0].unitPrice === 16.5 && res.items[0].lineTotal === 198 && res.total === 198, J(res));
ok('...the order line records it was a bulk price and the normal price', res.items[0].bulkPrice === true && res.items[0].normalPrice === 18);
const row = box.__sheets.Orders.objects().find((o) => o.OrderId === res.orderId);
ok('...and the saved order says the same (ItemsJson, Total)', Number(row.Total) === 198 && JSON.parse(row.ItemsJson)[0].unitPrice === 16.5);
res = order('whole', [{ variantId: RID, qty: 50 }]);
ok('50 bags: $15.00 each', res.ok && res.items[0].unitPrice === 15 && res.items[0].lineTotal === 750, J(res));
res = order('whole', [{ variantId: RID, qty: 5 }, { variantId: RID, qty: 5 }]);
ok('the same item split over two lines counts together (5 + 5 = 10 → $16.50)', res.ok && res.items.every((i) => i.unitPrice === 16.5) && res.total === 165, J(res));
res = order('whole', [{ variantId: RID, qty: 12, unitPrice: 0.01, lineTotal: 0.12 }], { total: 0.12, subtotal: 0.12 });
ok('a price sent by the browser is ignored - the server works it out', res.ok && res.items[0].unitPrice === 16.5 && res.total === 198, J(res));

/* ---------- minimum order ---------- */
save(OW, { productId: riceId, name: 'Rice 10kg', productType: 'single', variants: [{ variantId: RID, price: 18, stockQty: 500, tiers: TIERS, minQty: 10 }] });
ok('minimum order saved', Number(variants(riceId)[0].MinOrderQty) === 10);
ok('shoppers are sent the minimum', pub('whole')[0].variants[0].minQty === 10);
const ordersBefore = box.__sheets.Orders.objects().length;
const reservedBefore = Number(variants(riceId)[0].ReservedQty) || 0;
res = order('whole', [{ variantId: RID, qty: 5 }]);
ok('below the minimum: refused with a clear message', !res.ok && /minimum order for Rice 10kg is 10/.test(res.error), J(res));
ok('...no order written, no stock held', box.__sheets.Orders.objects().length === ordersBefore && (Number(variants(riceId)[0].ReservedQty) || 0) === reservedBefore);
res = order('whole', [{ variantId: RID, qty: 10 }]);
ok('at the minimum: accepted, at the bulk price', res.ok && res.items[0].unitPrice === 16.5, J(res));

/* ---------- normal price lowered later ---------- */
save(OW, { productId: riceId, name: 'Rice 10kg', productType: 'single', variants: [{ variantId: RID, price: 18, stockQty: 500 }] });
ok('a save from an older page without bulk fields keeps the saved tiers', variants(riceId)[0].PriceTiersJson === J([{ minQty: 10, price: 16.5 }, { minQty: 50, price: 15 }]) && Number(variants(riceId)[0].MinOrderQty) === 10);
// price edited straight in the sheet (inventory import, by hand)
const oldPrice = setCell('Variants', RID, 'Price', 14);
res = order('whole', [{ variantId: RID, qty: 50 }]);
ok('normal price lowered below a tier: the shopper pays the lower normal price', res.ok && res.items[0].unitPrice === 14 && !res.items[0].bulkPrice, J(res));
setCell('Variants', RID, 'Price', oldPrice);

/* ---------- options product: tiers per combination ---------- */
const size = { id: 'o_siz', name: 'Size', kind: 'size', values: [{ id: 'v_s1', label: '5kg' }, { id: 'v_s2', label: '25kg' }] };
res = save(OD, { name: 'Flour', productType: 'options', options: [size], variants: [
  { values: { o_siz: 'v_s1' }, active: true, price: 10, stockQty: '', tiers: [{ minQty: 20, price: 9 }] },
  { values: { o_siz: 'v_s2' }, active: true, price: 40, stockQty: '', tiers: [{ minQty: 5, price: 36 }], minQty: 2 }] });
const flourId = res.productId;
const f5 = variants(flourId).find((v) => v.Label === '5kg'), f25 = variants(flourId).find((v) => v.Label === '25kg');
ok('distributor, options product: each size keeps its own tiers and minimum', res.ok && f5.PriceTiersJson === J([{ minQty: 20, price: 9 }]) && f25.PriceTiersJson === J([{ minQty: 5, price: 36 }]) && Number(f25.MinOrderQty) === 2, J(res));
res = order('dist', [{ variantId: f5.VariantId, qty: 20 }, { variantId: f25.VariantId, qty: 1 }]);
ok('options: below the 25kg minimum of 2 is refused', !res.ok && /minimum order for Flour - 25kg is 2/.test(res.error), J(res));
res = order('dist', [{ variantId: f5.VariantId, qty: 20 }, { variantId: f25.VariantId, qty: 5 }]);
ok('options: 20 × 5kg at $9 + 5 × 25kg at $36 = $360', res.ok && res.total === 360, J(res));
res = save(OD, { productId: flourId, name: 'Flour', productType: 'options', options: [size], variants: [
  { variantId: f5.VariantId, values: { o_siz: 'v_s1' }, active: true, price: 10, stockQty: '', tiers: [], minQty: '' },
  { variantId: f25.VariantId, values: { o_siz: 'v_s2' }, active: false, price: 40, stockQty: '', tiers: [{ minQty: 5, price: 99 }] }] });
ok('options: clearing tiers clears them; a switched-off size keeps its own untouched', res.ok && variants(flourId).find((v) => v.Label === '5kg').PriceTiersJson === ''
  && variants(flourId).find((v) => v.Label === '25kg').PriceTiersJson === J([{ minQty: 5, price: 36 }]), J(res));
res = save(OD, { productId: flourId, name: 'Flour', productType: 'options', options: [size], variants: [
  { variantId: f5.VariantId, values: { o_siz: 'v_s1' }, active: true, price: 10, stockQty: '', tiers: [{ minQty: 10, price: 11 }] },
  { variantId: f25.VariantId, values: { o_siz: 'v_s2' }, active: true, price: 40, stockQty: '' }] });
ok('options: a bad tier names the combination and points at its row', !res.ok && /5kg/.test(res.error) && res.variantIndex === 0, J(res));

/* ---------- retailers never get it ---------- */
res = save(OR, { name: 'Soap', category: 'home', subcategoryId: 'home-cleaning', productType: 'single', variants: [{ price: 2, stockQty: '', tiers: [{ minQty: 10, price: 1 }], minQty: 5 }] });
if (!res.ok) console.log('retailer save', J(res));
const soap = variants(res.productId)[0] || {};
ok('retailer: bulk fields sent are ignored on save', res.ok && !soap.PriceTiersJson && !soap.MinOrderQty, J(soap));
setCell('Variants', soap.VariantId, 'PriceTiersJson', J([{ minQty: 10, price: 1 }]));
res = order('retail', [{ variantId: soap.VariantId, qty: 10 }]);
ok('retailer: even tiers typed into the sheet are not charged', res.ok && res.items[0].unitPrice === 2, J(res));
ok('retailer: and not shown', pub('retail')[0].variants[0].tiers === undefined);

/* ---------- switch back OFF ---------- */
flag('off');
pv = pub('whole')[0].variants[0];
ok('switch off again: tiers stay in the sheet but are not shown', pv.tiers === undefined && pv.minQty === undefined && !!variants(riceId)[0].PriceTiersJson);
res = order('whole', [{ variantId: RID, qty: 5 }]);
ok('switch off again: no minimum, normal price', res.ok && res.items[0].unitPrice === 18, J(res));
flag('on');

/* ---------- malformed saved data ---------- */
{ const keep = setCell('Variants', RID, 'PriceTiersJson', '{not json');
  res = order('whole', [{ variantId: RID, qty: 50 }]);
  ok('broken tiers in the sheet read as none - normal price, no crash', res.ok && res.items[0].unitPrice === 18, J(res));
  setCell('Variants', RID, 'PriceTiersJson', J([{ minQty: 10, price: 25 }]));
  res = order('whole', [{ variantId: RID, qty: 50 }]);
  ok('a tier above the normal price typed into the sheet is never charged', res.ok && res.items[0].unitPrice === 18, J(res));
  setCell('Variants', RID, 'PriceTiersJson', keep); }

/* ---------- the browser cart agrees with the server ---------- */
const store = {};
const ctx = { localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } }, console };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'assets/js/cart.js'), 'utf8') + ';this.Cart = Cart;', ctx);
const Cart = ctx.Cart;
let agree = true, bad = '';
const tierSets = [[], [{ minQty: 10, price: 16.5 }, { minQty: 50, price: 15 }], [{ minQty: 2, price: 0.99 }], [{ minQty: 3, price: 7.333 }]];
for (const base of [18, 1, 14, 7.5]) for (const tiers of tierSets) for (const q of [1, 2, 3, 9, 10, 11, 49, 50, 51, 999]) {
  const s = box.tierUnitPrice(base, tiers, q), c = Cart.unitPriceOf({ unitPrice: base, tiers, qty: q });
  if (s !== c) { agree = false; bad = `${base} ${J(tiers)} ${q}: server ${s} cart ${c}`; }
}
ok('cart display price = server price for every case tried', agree, bad);
Cart.addItem('whole', { variantId: 'x', productId: 'p', label: 'Rice', unitPrice: 18, qty: 1, tiers: tt, minQty: 10 });
ok('cart: adding 1 of a "minimum 10" item puts 10 in the cart', Cart.getCart('whole')[0].qty === 10);
Cart.updateQty('whole', 'x', 3);
ok('cart: lowering below the minimum stays at the minimum', Cart.getCart('whole')[0].qty === 10);
Cart.updateQty('whole', 'x', 50);
ok('cart: total uses the bulk price (50 × $15 = $750)', Cart.getTotal('whole') === 750 && Cart.lineTotal(Cart.getCart('whole')[0]) === 750);
ok('cart: next cheaper step is offered ("Buy 50+")', Cart.nextTierOf({ unitPrice: 18, tiers: tt, qty: 12 }).minQty === 50 && Cart.nextTierOf({ unitPrice: 18, tiers: tt, qty: 50 }) === null);
Cart.updateQty('whole', 'x', 0);
ok('cart: 0 still removes the line', Cart.getCart('whole').length === 0);
Cart.addItem('whole', { variantId: 'y', productId: 'p', label: 'Old', unitPrice: 4, qty: 2 });
ok('cart: a line without tiers works exactly as before', Cart.getTotal('whole') === 8 && Cart.minQtyOf(Cart.getCart('whole')[0]) === 1);

/* ---------- the shared copy is current ---------- */
ok('product-options.js is the current copy of ProductOptions.gs', fs.readFileSync(path.join(__dirname, '..', 'assets/js/product-options.js'), 'utf8').indexOf('function tierUnitPrice') !== -1);

let fails = 0;
console.log('\n--- wholesale bulk prices + minimum order (real backend) ---');
for (const [s, n, x] of R) { if (s === 'FAIL') fails++; console.log(`${s}  ${n}${x !== '' ? '  [' + x + ']' : ''}`); }
console.log(`\n${R.length - fails}/${R.length} passed`);
process.exit(fails ? 1 : 0);
