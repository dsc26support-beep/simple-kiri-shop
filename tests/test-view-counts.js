/**
 * Site scan items 2, 4, 5 (owner, 12 Nov 2026), on the REAL backend sources:
 *  2. Product views and store visits are tallied in the cache and written to
 *     the sheets in batches - never under the script lock that orders, chat
 *     and stock changes wait on.
 *  4. getProduct answers with one product and its store, from the cached
 *     store list.
 *  5. warmPublicCaches also warms the store directory, every store's products
 *     and the counts, and writes the view tallies.
 */
const { makeBox } = require('./lib/gas-harness.js');
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e === undefined ? '' : e]);
const J = (x) => JSON.stringify(x).slice(0, 300);

const box = makeBox({
  Owners: [['OwnerId', 'StoreName', 'StoreSlug', 'Status', 'StoreType', 'Island', 'Village', 'DeliveryPickPay', 'Visits'],
    ['o1', 'Bong Store', 'bong', 'active', 'retailer', 'Abaiang', '', 'true', '10'],
    ['o2', 'Teaube', 'teaube', 'active', 'retailer', 'Abaiang', '', 'true', '']],
  Products: [['ProductId', 'OwnerId', 'StoreSlug', 'Name', 'Description', 'Status', 'Category', 'ListingType', 'Views'],
    ['prod_a', 'o1', 'bong', 'Bucket', 'Bucket', 'active', 'home', 'product', '5'],
    ['prod_b', 'o1', 'bong', 'Mop', 'Mop', 'active', 'home', 'product', ''],
    ['prod_c', 'o2', 'teaube', 'Chair', 'Chair', 'active', 'home', 'product', '1']],
  Variants: [['VariantId', 'ProductId', 'OwnerId', 'Label', 'Price', 'StockQty', 'Status'],
    ['v_a', 'prod_a', 'o1', 'Default', '3', '5', 'active'], ['v_b', 'prod_b', 'o1', 'Default', '4', '5', 'active'],
    ['v_c', 'prod_c', 'o2', 'Default', '9', '2', 'active']]
});
const views = (id) => Number((box.__sheets.Products.objects().find((p) => p.ProductId === id) || {}).Views) || 0;
const visits = (slug) => Number((box.__sheets.Owners.objects().find((o) => o.StoreSlug === slug) || {}).Visits) || 0;

// Count which locks are taken.
let scriptLocks = 0;
const realLock = box.LockService;
box.LockService = {
  getScriptLock: () => { scriptLocks++; return realLock.getScriptLock(); },
  getDocumentLock: () => ({ waitLock() {}, tryLock: () => true, releaseLock() {} })
};

/* ---------- 2. tallied, not written straight away ---------- */
box.actionRecordProductViews({ productIds: ['prod_a', 'prod_b', 'prod_a'] });
box.actionRecordStoreVisit({ storeSlug: 'bong' });
ok('a view does not take the script lock', scriptLocks === 0, scriptLocks);
ok('...nor write the sheet there and then', views('prod_a') === 5 && views('prod_b') === 0 && visits('bong') === 10);
box.actionRecordProductViews({ productIds: ['prod_a'] });
box.actionRecordProductViews({ productIds: ['bad id!', '=HYPERLINK("x")', ''] });
box.actionRecordStoreVisit({ storeSlug: 'Bad Slug!' });

let n = box.flushViewCounts();
ok('flush writes the tallies: one view each (5-minute cooldown kept)', views('prod_a') === 6 && views('prod_b') === 1 && visits('bong') === 11, J([views('prod_a'), views('prod_b'), visits('bong')]));
ok('...odd ids are never counted', !box.__sheets.Products.objects().some((p) => /HYPERLINK|bad/.test(p.ProductId)));
ok('...and the tally is emptied', box.flushViewCounts() === 0, n);

// Without the trigger: the next view writes once 15 minutes have passed.
const cache = box.CacheService.getScriptCache();
box.actionRecordProductViews({ productIds: ['prod_c'] });
ok('within 15 minutes, still only tallied', views('prod_c') === 1);
cache.put('v1:views:flushedAt', String(Date.now() - 16 * 60000));
box.actionRecordStoreVisit({ storeSlug: 'teaube' });
ok('after 15 minutes the next view writes everything', views('prod_c') === 2 && visits('teaube') === 1, J([views('prod_c'), visits('teaube')]));

/* ---------- 4. getProduct ---------- */
let res = box.actionGetProduct({ storeSlug: 'bong', productId: 'prod_b' });
ok('getProduct: just that product, with the store details', res.ok && res.products.length === 1 && res.products[0].productId === 'prod_b' && res.storeName === 'Bong Store', J(res));
const full = box.actionListProducts({ storeSlug: 'bong' });
ok('...the same fields as listProducts', Object.keys(full).filter((k) => k !== 'products').every((k) => k in res), J(Object.keys(res)));
res = box.actionGetProduct({ storeSlug: 'bong', productId: 'prod_c' });
ok('...another store\'s product: none (the page says it is not available)', res.ok && res.products.length === 0, J(res));
ok('...no product id: a clear error', box.actionGetProduct({ storeSlug: 'bong' }).ok === false);
ok('...unknown store: Store not found', /Store not found/.test(box.actionGetProduct({ storeSlug: 'nope', productId: 'x' }).error || ''));
box.ContentService = { createTextOutput: (s) => ({ s, setMimeType() { return this; } }), MimeType: { JSON: 'json' } };
const viaGet = JSON.parse(box.doGet({ parameter: { action: 'getProduct', storeSlug: 'bong', productId: 'prod_a' } }).s);
ok('...routed as a public GET', viaGet.ok && viaGet.products[0].productId === 'prod_a', J(viaGet));

/* ---------- 5. warming ---------- */
cache.remove('viewcooldown:v1:prod_b'); // 5 minutes later
box.actionRecordProductViews({ productIds: ['prod_b'] });
const warmed = box.warmPublicCaches();
ok('warming covers the stores, each store\'s products and the counts', ['stores', 'store:bong', 'store:teaube', 'counts'].every((w) => warmed.indexOf(w) !== -1), J(warmed));
ok('...and writes the view tallies', views('prod_b') === 2 && warmed.some((w) => /^views:/.test(w)), J(warmed));
ok('...the store lists are in the cache afterwards', cache.get('v3:listProducts:bong') !== null && cache.get('v3:listStores') !== null);

R.forEach(([s, n2, e]) => console.log(s + '  ' + n2 + (e && s === 'FAIL' ? '  [' + e + ']' : '')));
const failed = R.filter((r) => r[0] === 'FAIL').length;
console.log('\n' + (R.length - failed) + '/' + R.length + ' passed');
process.exit(failed ? 1 : 0);
