/**
 * Seller dashboard summary (Dashboards.gs, Oct 2026) on the REAL backend
 * sources: the arithmetic (sales = confirmed payments only, Kiribati days),
 * stock alerts, room problems, wholesale facts, and that a seller only ever
 * sees their own store's numbers.
 */
const { makeBox } = require('./lib/gas-harness.js');
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e === undefined ? '' : e]);
const J = (x) => JSON.stringify(x).slice(0, 300);
const DAY = 86400000;
const iso = (daysAgo) => new Date(Date.now() - daysAgo * DAY).toISOString();
const box = makeBox({
  Owners: [['OwnerId', 'StoreSlug', 'StoreName', 'Email', 'Status', 'StoreType', 'WholesaleVerified'],
    ['own_a', 'alpha', 'Alpha', 'a@x.test', 'active', 'retailer', ''], ['own_w', 'whole', 'Whole', 'w@x.test', 'active', 'distributor', 'true']],
  Orders: [['OrderId', 'OwnerId', 'StoreSlug', 'CustomerName', 'Total', 'Status', 'ItemsSummary', 'CreatedAt'],
    ['o1', 'own_a', 'alpha', 'Tia', 10, 'Paid', '1x Rice', iso(0)],
    ['o2', 'own_a', 'alpha', 'Ben', 5.5, 'Fulfilled', '1x Oil', iso(0)],
    ['o3', 'own_a', 'alpha', 'Kat', 99, 'Pending Payment', '1x Fan', iso(0)],
    ['o4', 'own_a', 'alpha', 'Lee', 20, 'Paid', '2x Rice', iso(1)],
    ['o5', 'own_a', 'alpha', 'Max', 7, 'Cancelled', '1x Soap', iso(1)],
    ['o6', 'own_a', 'alpha', 'Nia', 40, 'Fulfilled', '1x Lamp', iso(10)],
    ['o7', 'own_w', 'whole', 'Oz', 1000, 'Paid', '50x Rice', iso(0)]],
  Products: [['ProductId', 'OwnerId', 'Name', 'Status'], ['p1', 'own_a', 'Rice', 'active'], ['p2', 'own_a', 'Oil', 'active'], ['p3', 'own_a', 'Old', 'archived'],
    ['p4', 'own_a', 'Held', 'review'], ['p9', 'own_w', 'Bulk rice', 'active']],
  Variants: [['VariantId', 'ProductId', 'OwnerId', 'Label', 'Price', 'StockQty', 'ReservedQty', 'ReorderLevel', 'Status'],
    ['v1', 'p1', 'own_a', '10kg', 20, 3, 1, 5, 'active'], ['v2', 'p2', 'own_a', '1L', 5, 2, 2, '', 'active'], ['v3', 'p2', 'own_a', '2L', 9, '', '', '', 'active'],
    ['v4', 'p3', 'own_a', 'x', 1, 0, 0, '', 'active'], ['v9', 'p9', 'own_w', '25kg', 40, 120, 0, 10, 'active']],
  Bookings: [['BookingId', 'OwnerId', 'Status'], ['b1', 'own_a', 'Pending'], ['b2', 'own_a', 'Confirmed'], ['b3', 'own_w', 'Pending']],
  Locations: [['LocationId', 'OwnerId', 'Name', 'Type', 'Status'], ['l1', 'own_w', 'Main', 'store', 'active'], ['l2', 'own_w', 'Depot', 'warehouse', 'active']],
  TxState: [['OrderId', 'Flow', 'LastSeq', 'ReadSellerSeq', 'OpenDisputeId'], ['o4', 'v1', 6, 2, 'txd_1']],
  TxDisputes: [['DisputeId', 'OrderId', 'Status', 'Category'], ['txd_1', 'o4', 'awaiting_seller', 'damaged']],
  Product_Review_Queue: [['ReviewId', 'SellerId', 'Status'], ['r1', 'own_a', 'AWAITING_SELLER'], ['r2', 'own_a', 'APPROVED']]
});
const [A, W] = box.__sheets.Owners.objects();
box.__props.TX_ROOMS = 'on';
const r = box.actionGetSellerDashboard(A, {});
const k = r.kpis;
ok('summary loads for the signed-in seller', r.ok && r.period === 7 && r.series.length === 7, J(r));
ok('orders today counts every order placed today', k.ordersToday === 3, k.ordersToday);
ok('sales today = only orders whose payment the seller confirmed (Paid/Fulfilled)', k.salesToday === 15.5, k.salesToday);
ok('yesterday: cancelled orders count as orders, never as sales', k.ordersYesterday === 2 && k.salesYesterday === 20, J([k.ordersYesterday, k.salesYesterday]));
ok('the 7-day series ends today and excludes older orders', r.series[6].day === r.today && r.series[6].sales === 15.5 && k.periodSales === 35.5 && k.periodOrders === 5, J(r.series));
ok('30-day view includes the older order', box.actionGetSellerDashboard(A, { days: 30 }).kpis.periodSales === 75.5);
ok('only two period choices (anything else is 7)', box.actionGetSellerDashboard(A, { days: 999 }).period === 7);
ok('pending payment and open problems make "needs action"', k.pendingPayment === 1 && k.openProblems === 1 && k.needsAction === 2);
ok('room activity the seller has not read is counted', k.roomUnread === 4);
ok('stock: low (at/below reorder level) and out (none available) - untracked and archived ignored', k.lowStock === 1 && k.outOfStock === 1
  && r.lowStock.map((s) => s.name + ':' + s.health).join() === 'Oil:out,Rice:low', J(r.lowStock));
ok('products: active and held-for-review counts', k.activeProducts === 2 && k.heldProducts === 1);
ok('bookings and listing changes waiting for this seller', k.bookingsPending === 1 && k.reviewWaiting === 1);
ok('recent orders newest first, with problem flag and room link', r.recentOrders[0].orderId !== 'o6' && r.recentOrders.find((o) => o.orderId === 'o4').problem === true
  && r.recentOrders.every((o) => o.room === true), J(r.recentOrders.map((o) => o.orderId)));
ok('problem list names the category', r.problems.length === 1 && r.problems[0].category === 'Goods damaged');
ok('a retailer gets no wholesale panel', r.storeType === 'retailer' && r.wholesale === null);
ok('never another store\'s orders, sales or stock', !r.recentOrders.some((o) => o.orderId === 'o7') && k.salesToday === 15.5);
const w = box.actionGetSellerDashboard(W, {});
ok('distributor: verification, units on hand and locations', w.ok && w.storeType === 'distributor' && w.wholesale.verified === true && w.wholesale.unitsOnHand === 120 && w.wholesale.locations === 2, J(w.wholesale));
ok('distributor sees only their own numbers', w.kpis.salesToday === 1000 && w.kpis.bookingsPending === 1 && w.recentOrders.length === 1);
const empty = makeBox({ Owners: [['OwnerId', 'StoreSlug', 'StoreName', 'Status'], ['own_e', 'e', 'E', 'active']], Orders: [['OrderId', 'OwnerId', 'Total', 'Status', 'CreatedAt']] });
const e = empty.actionGetSellerDashboard(empty.__sheets.Owners.objects()[0], {});
ok('a brand-new store (no tabs for stock, rooms, bookings) gets zeros, not an error', e.ok && e.kpis.ordersToday === 0 && e.recentOrders.length === 0 && e.lowStock.length === 0, J(e));
ok('pure maths: Kiribati day boundary (UTC+12)', box.dashDayOf('2026-10-14T13:00:00Z') === '2026-10-15' && box.dashDayOf('2026-10-14T11:00:00Z') === '2026-10-14');
let fails = 0;
console.log('\n--- seller dashboard summary ---');
for (const [s, n, x] of R) { if (s === 'FAIL') fails++; console.log(`${s}  ${n}${x !== '' ? '  [' + x + ']' : ''}`); }
console.log(`\n${R.length - fails}/${R.length} passed`);
process.exit(fails ? 1 : 0);
