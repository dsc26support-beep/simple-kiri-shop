const fs = require('fs'), vm = require('vm');
const code = fs.readFileSync('/home/user/simple-kiri-shop/apps-script/Reviews.gs', 'utf8');
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e || '']);

function ctx({ reviews, orders, products, owners, customer, noReviewsTab, noOrdersTab }) {
  const appended = [];
  const sandbox = {
    appended,
    ok: (d) => Object.assign({ ok: true }, d),
    fail: (e) => ({ ok: false, error: String(e) }),
    nowIso: () => '2026-09-02T00:00:00.000Z',
    newId: (p) => p + '_new',
    normalizeEmail: (e) => String(e || '').trim().toLowerCase(),
    capLength: (v, max, label) => (String(v).length > max ? { ok: false, error: label + ' is too long' } : null),
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    getSheet: (n) => {
      if (n === 'Reviews' && noReviewsTab) throw new Error('Sheet tab not found: Reviews');
      if (n === 'Orders' && noOrdersTab) throw new Error('Sheet tab not found: Orders');
      return n;
    },
    sheetToObjects: (n) => (n === 'Reviews' ? reviews : n === 'Orders' ? orders : []) || [],
    findRowById: (sheet, field, val) =>
      (sheet === 'Products' ? products : owners).filter((r) => String(r[field]) === String(val))[0] || null,
    appendRowFromObject: (sheet, obj) => appended.push(obj),
    requireCustomerAuth: (t) => { if (!customer || t !== 'good') throw new Error('Not signed in'); return customer; },
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return sandbox;
}

const PROD = [{ ProductId: 'p1', OwnerId: 'o1', Status: 'active' }];
const OWN = [{ OwnerId: 'o1', StoreSlug: 'bong' }];
const CUST = { CustomerId: 'c1', Name: 'Ana', Email: 'ana@x.com' };
const rev = (o) => Object.assign({ ReviewId: 'r', ProductId: 'p1', CustomerId: 'cX', Rating: 5, Status: 'published', CreatedAt: '2026-09-01T00:00:00Z' }, o);

// --- productRatingIndex ---
let s = ctx({ reviews: [], noReviewsTab: true });
ok('missing Reviews tab degrades to {} (site keeps working)', JSON.stringify(s.productRatingIndex()) === '{}');

s = ctx({ reviews: [rev({ Rating: 5 }), rev({ Rating: 4 }), rev({ Rating: 3, Status: 'hidden' })] });
let idx = s.productRatingIndex();
ok('average ignores hidden reviews', idx.p1.average === 4.5, JSON.stringify(idx.p1));
ok('count ignores hidden reviews', idx.p1.count === 2, String(idx.p1.count));

s = ctx({ reviews: [rev({ Rating: 5 }), rev({ Rating: 4 }), rev({ Rating: 4 })] });
ok('average rounded to one decimal', s.productRatingIndex().p1.average === 4.3, String(s.productRatingIndex().p1.average));

s = ctx({ reviews: [rev({ Rating: 0 }), rev({ Rating: 9 }), rev({ Rating: 'x' }), rev({ Rating: 5 })] });
ok('out-of-range ratings excluded', s.productRatingIndex().p1.count === 1, String(s.productRatingIndex().p1.count));

// --- customerBoughtProduct ---
s = ctx({ reviews: [], orders: [{ CustomerEmail: 'Ana@X.com', Status: 'Paid', ItemsJson: '[{"productId":"p1"}]' }] });
ok('purchase matched case-insensitively', s.customerBoughtProduct('ana@x.com', 'p1') === true);
ok('different product not matched', s.customerBoughtProduct('ana@x.com', 'p9') === false);

s = ctx({ reviews: [], orders: [{ CustomerEmail: 'ana@x.com', Status: 'Cancelled', ItemsJson: '[{"productId":"p1"}]' }] });
ok('cancelled order does not count as a purchase', s.customerBoughtProduct('ana@x.com', 'p1') === false);

s = ctx({ reviews: [], noOrdersTab: true });
ok('missing Orders tab -> not verified, no throw', s.customerBoughtProduct('ana@x.com', 'p1') === false);

// --- actionListProductReviews ---
s = ctx({ reviews: [], noReviewsTab: true });
let r = s.actionListProductReviews({ productId: 'p1' });
ok('no tab -> valid empty answer, not an error', r.ok === true && r.count === 0 && r.average === null);

s = ctx({ reviews: [
  rev({ ReviewId: 'a', Rating: 5, CreatedAt: '2026-09-01T00:00:00Z' }),
  rev({ ReviewId: 'b', Rating: 3, CreatedAt: '2026-09-02T00:00:00Z' }),
  rev({ ReviewId: 'c', Rating: 1, Status: 'hidden' }),
  rev({ ReviewId: 'd', ProductId: 'other', Rating: 1 }),
] });
r = s.actionListProductReviews({ productId: 'p1' });
ok('only this product, only published', r.count === 2, String(r.count));
ok('newest first', r.reviews[0].reviewId === 'b', r.reviews[0].reviewId);
ok('distribution counts stars', JSON.stringify(r.distribution) === '[0,0,1,0,1]', JSON.stringify(r.distribution));
ok('average excludes hidden and other products', r.average === 4, String(r.average));

// --- actionSubmitReview ---
s = ctx({ reviews: [], orders: [], products: PROD, owners: OWN, customer: CUST });
ok('anonymous submit rejected', s.actionSubmitReview({ token: 'bad', productId: 'p1', rating: 5 }).ok === false);

for (const bad of [0, 6, 3.5, 'x', undefined]) {
  const res = s.actionSubmitReview({ token: 'good', productId: 'p1', rating: bad });
  ok('invalid rating rejected: ' + JSON.stringify(bad), res.ok === false, res.error);
}

s = ctx({ reviews: [], orders: [], products: PROD, owners: OWN, customer: CUST });
r = s.actionSubmitReview({ token: 'good', productId: 'p1', rating: 5, comment: 'Great' });
ok('valid review accepted', r.ok === true, r.error);
ok('one row appended', s.appended.length === 1);
ok('rating stored as given', s.appended[0].Rating === 5);
ok('unpurchased -> VerifiedPurchase false', s.appended[0].VerifiedPurchase === 'false', s.appended[0].VerifiedPurchase);
ok('Status forced to published', s.appended[0].Status === 'published');
ok('CustomerId taken from the session, not the body', s.appended[0].CustomerId === 'c1');

// SECURITY: the client must not be able to award itself a verified badge
s = ctx({ reviews: [], orders: [], products: PROD, owners: OWN, customer: CUST });
s.actionSubmitReview({ token: 'good', productId: 'p1', rating: 5, VerifiedPurchase: 'true', verifiedPurchase: true, Status: 'featured', customerId: 'someone-else' });
ok('client-supplied verifiedPurchase ignored', s.appended[0].VerifiedPurchase === 'false', s.appended[0].VerifiedPurchase);
ok('client-supplied Status ignored', s.appended[0].Status === 'published', s.appended[0].Status);
ok('client-supplied customerId ignored', s.appended[0].CustomerId === 'c1', s.appended[0].CustomerId);

// verified when an order exists
s = ctx({ reviews: [], orders: [{ CustomerEmail: 'ana@x.com', Status: 'Paid', ItemsJson: '["p1"]' }], products: PROD, owners: OWN, customer: CUST });
s.actionSubmitReview({ token: 'good', productId: 'p1', rating: 4 });
ok('purchaser -> VerifiedPurchase true', s.appended[0].VerifiedPurchase === 'true');

// duplicate
s = ctx({ reviews: [rev({ CustomerId: 'c1' })], orders: [], products: PROD, owners: OWN, customer: CUST });
r = s.actionSubmitReview({ token: 'good', productId: 'p1', rating: 5 });
ok('second review by same customer rejected', r.ok === false && /already reviewed/.test(r.error), r.error);
ok('nothing appended on duplicate', s.appended.length === 0);

// inactive product
s = ctx({ reviews: [], orders: [], products: [{ ProductId: 'p1', OwnerId: 'o1', Status: 'inactive' }], owners: OWN, customer: CUST });
ok('review on inactive product rejected', s.actionSubmitReview({ token: 'good', productId: 'p1', rating: 5 }).ok === false);

// overlong comment
s = ctx({ reviews: [], orders: [], products: PROD, owners: OWN, customer: CUST });
ok('overlong comment rejected', s.actionSubmitReview({ token: 'good', productId: 'p1', rating: 5, comment: 'x'.repeat(1001) }).ok === false);

let f = 0;
console.log('\n--- Reviews.gs ---');
for (const [st, n, e] of R) { if (st === 'FAIL') f++; console.log(`${st}  ${n}${e ? '  [' + e + ']' : ''}`); }
console.log(`\n${R.length - f}/${R.length} passed`);
process.exit(f ? 1 : 0);
