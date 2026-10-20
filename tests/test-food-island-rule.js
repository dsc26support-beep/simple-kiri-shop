/**
 * Owner decision, Oct 2026: Food & Groceries is closed only to RETAILERS on
 * South Tarawa (a store with no island set counts as South Tarawa).
 * Retailers on other islands, and wholesalers/distributors everywhere, can
 * list it. Food listings from a store that may not list food (older ones, or
 * a store that moved to South Tarawa) are hidden from shoppers, not deleted.
 * On the REAL backend sources (gas-harness).
 */
const { makeBox } = require('./lib/gas-harness.js');
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e === undefined ? '' : e]);
const J = (x) => JSON.stringify(x).slice(0, 300);

const oHead = ['OwnerId', 'StoreName', 'StoreSlug', 'Status', 'StoreType', 'Island', 'Village', 'DeliveryPickPay'];
const box = makeBox({
  Owners: [oHead,
    ['o_st', 'Tarawa Shop', 'tarawa-shop', 'active', 'retailer', 'South Tarawa', 'Bairiki', 'true'],
    ['o_none', 'No Island', 'no-island', 'active', '', '', '', 'true'],
    ['o_ab', 'Abaiang Shop', 'abaiang-shop', 'active', 'retailer', 'Abaiang', 'Tebunginako', 'true'],
    ['o_wh', 'Bulk Foods', 'bulk-foods', 'active', 'wholesaler', 'South Tarawa', 'Betio', 'true']],
  Products: [['ProductId', 'OwnerId', 'StoreSlug', 'Name', 'Description', 'Status', 'Category', 'ListingType'],
    ['p_st', 'o_st', 'tarawa-shop', 'Rice bag', 'Rice', 'active', 'food', 'product'],
    ['p_st2', 'o_st', 'tarawa-shop', 'Bucket', 'Bucket', 'active', 'home', 'product'],
    ['p_none', 'o_none', 'no-island', 'Rice bag', 'Rice', 'active', 'food', 'product'],
    ['p_ab', 'o_ab', 'abaiang-shop', 'Rice bag', 'Rice', 'active', 'food', 'product'],
    ['p_wh', 'o_wh', 'bulk-foods', 'Rice bag', 'Rice', 'active', 'food', 'product']],
  Variants: [['VariantId', 'ProductId', 'OwnerId', 'Label', 'Price', 'StockQty', 'Status'],
    ['v_st', 'p_st', 'o_st', 'Default', '10', '5', 'active'], ['v_st2', 'p_st2', 'o_st', 'Default', '3', '5', 'active'],
    ['v_none', 'p_none', 'o_none', 'Default', '10', '5', 'active'],
    ['v_ab', 'p_ab', 'o_ab', 'Default', '10', '5', 'active'], ['v_wh', 'p_wh', 'o_wh', 'Default', '10', '5', 'active']],
  // Tips show the admin's featured picks.
  Featured: [['Type', 'RefId', 'SortOrder'], ['product', 'p_st', '1'], ['product', 'p_none', '2'], ['product', 'p_ab', '3']]
});
const owner = (id) => Object.assign({ __row: 2 }, box.__sheets.Owners.objects().find((o) => o.OwnerId === id));

/* ---------- the rule ---------- */
ok('South Tarawa retailer: no Food', box.canListFood(owner('o_st')) === false);
ok('no island set: treated as South Tarawa', box.canListFood(owner('o_none')) === false);
ok('outer-island retailer: Food allowed', box.canListFood(owner('o_ab')) === true);
ok('wholesaler on South Tarawa: Food allowed', box.canListFood(owner('o_wh')) === true);
ok('distributor with no island: Food allowed', box.canListFood({ StoreType: 'distributor', Island: '' }) === true);

/* ---------- creating listings ---------- */
const create = (id) => box.actionCreateOrUpdateProduct(owner(id), { name: 'Flour 10kg', description: 'Flour', category: 'food', price: 12, stockQty: 4 });
let res = create('o_st');
ok('South Tarawa retailer cannot file a new Food listing', !res.ok && /South Tarawa/.test(res.error), J(res));
res = create('o_none');
ok('...nor can a store with no island', !res.ok && /South Tarawa/.test(res.error), J(res));
res = create('o_ab');
ok('outer-island retailer is not stopped by the Food rule', !(res.error && /South Tarawa/.test(res.error)), J(res));

/* ---------- shoppers ---------- */
const ids = (list) => (list || []).map((p) => p.productId || p.ProductId);
const search = box.actionSearchProducts({ q: 'rice' });
const found = ids(search.products || search.results || search);
ok('search hides South Tarawa retailer food (incl. no island)', found.indexOf('p_st') === -1 && found.indexOf('p_none') === -1, J(found));
ok('search still shows outer-island retailer and wholesaler food', found.indexOf('p_ab') !== -1 && found.indexOf('p_wh') !== -1, J(found));
const store = box.actionListProducts({ storeSlug: 'tarawa-shop' });
const inStore = ids(store.products);
ok('the store page hides its Food listing but keeps the rest', inStore.indexOf('p_st') === -1 && inStore.indexOf('p_st2') !== -1, J(inStore));
ok('the hidden listing is not deleted', box.__sheets.Products.objects().some((p) => p.ProductId === 'p_st' && p.Status === 'active'));
const tips = ids(box.actionGetTips({}).products);
ok('tips never show a hidden Food listing', tips.indexOf('p_st') === -1 && tips.indexOf('p_none') === -1, J(tips));
ok('...but do show a featured outer-island one', tips.indexOf('p_ab') !== -1, J(tips));

/* ---------- ordering ---------- */
res = box.actionCreateOrder({ storeSlug: 'tarawa-shop', customerName: 'Tia', customerPhone: '73000001', island: 'South Tarawa', village: 'Bairiki',
  deliveryMethod: 'pickpay', paymentMethod: 'cash', items: [{ productId: 'p_st', variantId: 'v_st', quantity: 1 }] });
ok('a hidden Food listing cannot be ordered', !res.ok && /no longer available/.test(res.error), J(res));

/* ---------- the seller's own list ---------- */
const mine = box.actionListOwnerProducts(owner('o_st'), {});
const row = (mine.products || []).find((p) => p.productId === 'p_st');
ok('the seller still sees it, marked foodHidden', !!row && row.foodHidden === true, J(mine));
ok('...and their other listings are not marked', (mine.products || []).find((p) => p.productId === 'p_st2').foodHidden === false);
const abRow = (box.actionListOwnerProducts(owner('o_ab'), {}).products || []).find((p) => p.productId === 'p_ab');
ok('outer-island retailer food is not marked hidden', !!abRow && abRow.foodHidden === false);

/* ---------- moving island ---------- */
const g = box.__sheets.Owners.grid; g[3][oHead.indexOf('Island')] = 'South Tarawa';
box.__cache && typeof box.__cache.clear === 'function' && box.__cache.clear();
const after = ids(box.actionListProducts({ storeSlug: 'abaiang-shop' }).products);
ok('a retailer that moves to South Tarawa has its Food listings hidden', after.indexOf('p_ab') === -1, J(after));

let fails = 0;
console.log('\n--- Food & Groceries: South Tarawa retailers only (real backend) ---');
for (const [s, n, x] of R) { if (s === 'FAIL') fails++; console.log(`${s}  ${n}${x !== '' ? '  [' + x + ']' : ''}`); }
console.log(`\n${R.length - fails}/${R.length} passed`);
process.exit(fails ? 1 : 0);
