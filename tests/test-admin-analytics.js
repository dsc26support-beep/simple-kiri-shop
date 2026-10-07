/**
 * Admin store analytics: buildStoreAnalytics, run against the REAL Admin.gs
 * source (vm, same pattern as test-featuring.js) - the numbers the admin
 * dashboard shows for one store.
 */
const fs = require('fs');
const vm = require('vm');
const src = fs.readFileSync('/home/user/simple-kiri-shop/apps-script/Admin.gs', 'utf8');
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e === undefined ? '' : e]);
const box = { JSON, Math, Date, Number, String, Object, Array, isNaN, PropertiesService: { getScriptProperties: () => ({ getProperty: () => null }) } };
vm.createContext(box);
vm.runInContext(src, box);

const H = 3600 * 1000, now = Date.now();
const store = { OwnerId: 'o1', StoreName: 'Bong', StoreSlug: 'bong', Email: 'b@x.com', Phone: '7300', Status: 'active',
  StoreType: 'wholesaler', WholesaleVerified: true, Visits: '41', CreatedAt: '2026-01-01T00:00:00Z' };
const a = box.buildStoreAnalytics(store, {
  products: [
    { ProductId: 'p1', Name: 'Rice', Status: 'active', Views: '10' },
    { ProductId: 'p2', Name: 'Flour', Status: 'archived', Views: '50' },
    { ProductId: 'p3', Name: 'Sugar', Status: 'active', Views: '' }],
  variants: [
    { ProductId: 'p1', Price: '12', StockQty: '5', Status: 'active' },
    { ProductId: 'p1', Price: '7.5', StockQty: '3', Status: 'active' },
    { ProductId: 'p1', Price: '1', StockQty: '99', Status: 'archived' },
    { ProductId: 'p2', Price: '3', StockQty: '', Status: 'active' }],
  orders: [
    { Status: 'Paid', Total: '10.10' }, { Status: 'Fulfilled', Total: '5.20' },
    { Status: 'Pending Payment', Total: '100' }, { Status: 'Cancelled', Total: '50' }],
  bookings: [{ Status: 'Confirmed' }, { Status: 'Pending' }, { Status: 'Pending' }],
  reviews: [{ Status: 'published', Rating: 5 }, { Status: 'published', Rating: 4 }, { Status: 'hidden', Rating: 1 }],
  featurePurchases: [
    { Reference: 'MWFA', Status: 'Approved', Amount: '0.70', Days: 7, CreatedAt: '2026-10-01', StartsAt: new Date(now - H).toISOString(), EndsAt: new Date(now + H).toISOString() },
    { Reference: 'MWFB', Status: 'Rejected', Amount: '9', Days: 1, CreatedAt: '2026-10-02' }],
  adminFeatured: true
});

ok('store basics: type, verified flag, visits, admin-featured', a.store.storeType === 'wholesaler' && a.store.wholesaleVerified === true && a.store.visits === 41 && a.store.adminFeatured === true, JSON.stringify(a.store));
ok('products sorted most-viewed first', a.products.map((p) => p.name).join() === 'Flour,Rice,Sugar');
const rice = a.products.find((p) => p.name === 'Rice');
ok('price "from" ignores archived varieties', rice.minPrice === 7.5, rice.minPrice);
ok('stock sums tracked, non-archived varieties', rice.stock === 8, rice.stock);
ok('untracked stock is null (shown as "-"), not 0', a.products.find((p) => p.name === 'Flour').stock === null);
ok('no varieties -> no price', a.products.find((p) => p.name === 'Sugar').minPrice === null);
ok('totals: 3 products, 2 active, 60 views', a.totals.products === 3 && a.totals.activeProducts === 2 && a.totals.views === 60, JSON.stringify(a.totals));
ok('sales count Paid + Fulfilled only, cents-exact', a.orders.sales === 15.3 && a.orders.count === 4, a.orders.sales);
ok('orders by status', JSON.stringify(a.orders.byStatus) === '{"Paid":1,"Fulfilled":1,"Pending Payment":1,"Cancelled":1}');
ok('bookings by status', a.bookings.count === 3 && a.bookings.byStatus.Pending === 2);
ok('rating averages published reviews only', a.reviews.count === 2 && a.reviews.average === 4.5, JSON.stringify(a.reviews));
ok('featuring spend counts Approved only', a.featuring.spent === 0.7 && a.featuring.purchases === 2, a.featuring.spent);
ok('featuring "featured now" when a window includes now', a.featuring.activeNow === true);
ok('recent featuring newest first', a.featuring.recent.map((f) => f.reference).join() === 'MWFB,MWFA');

const empty = box.buildStoreAnalytics({ OwnerId: 'o2', StoreName: 'New', Status: 'active' },
  { products: [], variants: [], orders: [], bookings: [], reviews: [], featurePurchases: [], adminFeatured: false });
ok('a brand-new store: zeros, null rating, retailer', empty.orders.sales === 0 && empty.reviews.average === null && empty.store.storeType === 'retailer' && !empty.featuring.activeNow);

let f = 0;
console.log('\n--- admin store analytics ---');
for (const [s, n, e] of R) { if (s === 'FAIL') f++; console.log(`${s}  ${n}${e !== '' ? '  [' + e + ']' : ''}`); }
console.log(`\n${R.length - f}/${R.length} passed`);
process.exit(f ? 1 : 0);
