/**
 * Free first featuring, on the REAL backend sources (gas-harness): a store's
 * first featuring of up to 3 products costs nothing and is approved at once;
 * once only; 4+ products is paid as normal; and paying goes to Mwakete's
 * own account.
 */
const { makeBox } = require('./lib/gas-harness.js');
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e === undefined ? '' : e]);

const products = [['ProductId', 'OwnerId', 'Name', 'Status', 'Views']];
for (let i = 1; i <= 5; i++) products.push(['pa' + i, 'own_a', 'A' + i, 'active', 10 * i]);
products.push(['pb1', 'own_b', 'B1', 'active', 0], ['pc1', 'own_c', 'C1', 'active', 0]);
for (let i = 1; i <= 4; i++) products.push(['pd' + i, 'own_d', 'D' + i, 'active', 0]);
const box = makeBox({ Products: products, Owners: [['OwnerId', 'StoreSlug', 'StoreName', 'Status'], ['own_a', 'a', 'A', 'active'], ['own_b', 'b', 'B', 'active']] });
const A = { OwnerId: 'own_a', StoreSlug: 'a' };
const B = { OwnerId: 'own_b', StoreSlug: 'b' };
const C = { OwnerId: 'own_c', StoreSlug: 'c' };
const D = { OwnerId: 'own_d', StoreSlug: 'd' };
const rows = () => box.__sheets.FeaturePurchases.objects();

/* ---------- pure rules ---------- */
ok('pure: free for 1-3 products when unused', box.featureIsFree([], A, 1) && box.featureIsFree([], A, 3));
ok('pure: never free for 0 or 4+ products', !box.featureIsFree([], A, 0) && !box.featureIsFree([], A, 4));
ok('pure: a paid row does not use up the free one', !box.featureFreeUsed([{ OwnerId: 'own_a', Amount: 0.35 }], A));
ok('pure: an Amount 0 row does', box.featureFreeUsed([{ OwnerId: 'own_a', Amount: 0 }], A));
ok('pure: matched by store slug too (same store, other owner id)', box.featureFreeUsed([{ OwnerId: 'x', StoreSlug: 'a', Amount: 0 }], A));
ok('pure: another store\'s free row does not count', !box.featureFreeUsed([{ OwnerId: 'own_b', StoreSlug: 'b', Amount: 0 }], A));
ok('pure: a blank Amount is not read as free', !box.featureFreeUsed([{ OwnerId: 'own_a', Amount: '' }], A));

/* ---------- list says the offer is there ---------- */
let res = box.actionListMyFeaturePurchases(A);
ok('list: freeAvailable true and freeMaxProducts 3 for a new store', res.ok && res.freeAvailable === true && res.freeMaxProducts === 3, JSON.stringify(res));
ok('list: pays Mwakete 906149', res.payment.accountName === 'Mwakete' && res.payment.accountNumber === '906149', JSON.stringify(res.payment));

/* ---------- first featuring of 3: free ---------- */
box.__cache['v3:tips'] = 'stale';
res = box.actionStartFeaturePurchase(A, { productIds: ['pa1', 'pa2', 'pa3'], days: 14 });
let p = res.purchase;
ok('3 products: free, Approved straight away, amount 0', res.ok && res.free === true && p.status === 'Approved' && p.amount === 0, JSON.stringify(res));
ok('...runs for the chosen days', Math.abs(new Date(p.endsAt) - new Date(p.startsAt) - 14 * 86400000) < 5000, p.startsAt + ' ' + p.endsAt);
const r0 = rows()[0];
ok('...records the views snapshot so results work', r0.ViewsAtStartJson === '{"pa1":10,"pa2":20,"pa3":30}', r0.ViewsAtStartJson);
ok('...noted as the free one, no screenshot', r0.OcrNotes === 'free: first featuring' && r0.ScreenshotUrl === '');
ok('...Tips cache is cleared so it shows at once', !('v3:tips' in box.__cache));
ok('...is live on Tips right away (in the paid-featured list)', box.activePaidFeaturedProductIds().sort().join() === 'pa1,pa2,pa3', box.activePaidFeaturedProductIds().join());
ok('list: offer now gone', box.actionListMyFeaturePurchases(A).freeAvailable === false);

/* ---------- once only ---------- */
res = box.actionStartFeaturePurchase(A, { productIds: ['pa4'], days: 7 });
ok('second featuring (even 1 product) is paid: Awaiting payment, $0.35', res.ok && res.free === false
  && res.purchase.status === 'Awaiting payment' && res.purchase.amount === 0.35, JSON.stringify(res.purchase));
ok('uploading a payment for the free one is refused (already approved)',
  /already paid and approved/.test(box.actionSubmitFeaturePayment(A, { purchaseId: p.purchaseId }).error || ''));

/* ---------- other stores ---------- */
res = box.actionStartFeaturePurchase(B, { productIds: ['pb1'], days: 60 });
ok('another store still gets its own free one', res.free === true && res.purchase.amount === 0 && res.purchase.status === 'Approved');
res = box.actionStartFeaturePurchase(D, { productIds: ['pd1', 'pd2', 'pd3', 'pd4'], days: 2 });
ok('4 products is paid in full ($0.40), not partly free', res.free === false && res.purchase.amount === 0.4 && res.purchase.status === 'Awaiting payment', JSON.stringify(res.purchase));
ok('...and the store keeps its free offer for later', box.actionListMyFeaturePurchases(D).freeAvailable === true);
res = box.actionStartFeaturePurchase(C, { productIds: ['pa1'], days: 1 });
ok('cannot get a free featuring of another store\'s product', !res.ok && /not an active listing/.test(res.error));
ok('...and the failed try did not use C\'s free one', box.actionListMyFeaturePurchases(C).freeAvailable === true);

/* ---------- admin list shows it ---------- */
box.isOwnerAdmin = () => true;
const admin = box.actionListFeaturePurchases({ OwnerId: 'admin' });
ok('admin list includes the free ones as Approved $0', admin.ok && admin.purchases.filter((x) => x.amount === 0 && x.status === 'Approved').length === 2, JSON.stringify(admin).slice(0, 300));

let f = 0;
console.log('\n--- free first featuring ---');
for (const [s, n, e] of R) { if (s === 'FAIL') f++; console.log(`${s}  ${n}${e !== '' ? '  [' + e + ']' : ''}`); }
console.log(`\n${R.length - f}/${R.length} passed`);
process.exit(f ? 1 : 0);
