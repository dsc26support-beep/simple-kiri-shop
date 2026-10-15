/**
 * Admin overview (Dashboards.gs getAdminOverview, Oct 2026) on the REAL
 * backend sources: admin-only, marketplace totals from the real rows
 * (confirmed sales only, admin stores excluded), the admin work queue, stock
 * alerts, top stores, and no customer personal details in the payload.
 */
const { makeBox } = require('./lib/gas-harness.js');
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e === undefined ? '' : e]);
const J = (x) => JSON.stringify(x).slice(0, 300);
const iso = (d) => new Date(Date.now() - d * 86400000).toISOString();
const box = makeBox({
  Owners: [['OwnerId', 'StoreSlug', 'StoreName', 'Email', 'Status', 'StoreType', 'WholesaleVerified', 'CreatedAt'],
    ['own_adm', 'admin', 'Admin', 'admin@x.test', 'active', 'retailer', '', iso(100)],
    ['own_a', 'alpha', 'Alpha', 'a@x.test', 'active', 'retailer', '', iso(2)],
    ['own_w', 'whole', 'Whole', 'w@x.test', 'active', 'wholesaler', '', iso(50)],
    ['own_d', 'dist', 'Dist', 'd@x.test', 'standby', 'distributor', 'true', iso(50)],
    ['own_x', 'gone', 'Gone', 'x@x.test', 'closed', 'retailer', '', iso(50)]],
  Orders: [['OrderId', 'OwnerId', 'StoreSlug', 'CustomerName', 'CustomerPhone', 'CustomerEmail', 'DeliveryAddress', 'Total', 'Status', 'CreatedAt'],
    ['o1', 'own_a', 'alpha', 'Tia', '73000001', 't@x.test', 'Betio', 10, 'Paid', iso(0)],
    ['o2', 'own_w', 'whole', 'Ben', '73000002', 'b@x.test', 'Bairiki', 500, 'Fulfilled', iso(0)],
    ['o3', 'own_a', 'alpha', 'Kat', '73000003', 'k@x.test', 'Bikenibeu', 30, 'Pending Payment', iso(5)],
    ['o4', 'own_w', 'whole', 'Lee', '73000004', 'l@x.test', 'Teaoraereke', 40, 'Cancelled', iso(1)],
    ['o5', 'own_a', 'alpha', 'Max', '73000005', 'm@x.test', 'Betio', 20, 'Paid', iso(1)],
    ['o6', 'own_adm', 'admin', 'Test', '730', 'x@x.test', 'x', 9999, 'Paid', iso(0)]],
  Customers: [['CustomerId', 'Name', 'Email', 'CreatedAt'], ['c1', 'Tia', 't@x.test', iso(1)], ['c2', 'Ben', 'b@x.test', iso(40)]],
  FeaturePurchases: [['PurchaseId', 'Status', 'BankMatchedAt'], ['f1', 'Pending review', ''], ['f2', 'Approved', ''], ['f3', 'Approved', '2026-10-01']],
  Product_Review_Queue: [['ReviewId', 'Status'], ['r1', 'PENDING'], ['r2', 'IN_REVIEW'], ['r3', 'APPROVED']],
  TxDisputes: [['DisputeId', 'OrderId', 'Status'], ['d1', 'o1', 'under_review'], ['d2', 'o2', 'resolved']],
  TxState: [['OrderId', 'RefundState'], ['o4', 'due']],
  Products: [['ProductId', 'OwnerId', 'Name', 'Status'], ['p1', 'own_a', 'Rice', 'active'], ['p2', 'own_w', 'Oil', 'active'], ['p3', 'own_w', 'Old', 'hidden']],
  Variants: [['VariantId', 'ProductId', 'OwnerId', 'Label', 'StockQty', 'ReservedQty', 'ReorderLevel', 'Status'],
    ['v1', 'p1', 'own_a', 'x', 0, 0, '', 'active'], ['v2', 'p2', 'own_w', 'x', 3, 0, 5, 'active'], ['v3', 'p3', 'own_w', 'x', 0, 0, '', 'active']]
});
box.__props.ADMIN_EMAILS = 'admin@x.test';
const [ADM, A] = box.__sheets.Owners.objects();
let r = box.actionGetAdminOverview(A, {});
ok('a seller cannot read the overview (refused and logged)', !r.ok && r.error === 'Not authorized'
  && box.__sheets.Audit_Log.objects().some((x) => x.Action === 'UNAUTHORIZED_ATTEMPT' && x.ActorId === 'own_a'));
r = box.actionGetAdminOverview(ADM, {});
const k = r.kpis;
ok('admin gets the overview', r.ok && r.period === 7 && r.series.length === 7, J(r));
ok('orders today across stores, the admin\'s own test store left out', k.ordersToday === 2, k.ordersToday);
ok('confirmed sales today = Paid/Fulfilled only', k.salesToday === 510 && k.salesYesterday === 20, J([k.salesToday, k.salesYesterday]));
ok('active stores = active + standby, not closed, not admin', k.activeStores === 3 && k.storeTypes.retailer === 1 && k.storeTypes.wholesaler === 1 && k.storeTypes.distributor === 1);
ok('new stores and customers in the period', k.newStores === 1 && k.customers === 2 && k.newCustomers === 1);
const w = r.work;
ok('work queue: featuring to review, approved but not seen in bank', w.featurePending === 1 && w.featureUnmatched === 1);
ok('work queue: open listing cases, open problems, refunds due', w.reviewOpen === 2 && w.openDisputes === 1 && w.refundsDue === 1);
ok('work queue: unverified bulk sellers, orders unpaid > 3 days', w.unverifiedBulk === 1 && w.staleUnpaid === 1);
ok('stock alerts: live listings only', r.stock.out === 1 && r.stock.low === 1 && r.stock.stores.length === 2, J(r.stock));
ok('top stores by confirmed sales', r.topStores[0].storeName === 'Whole' && r.topStores[0].sales === 500 && r.topStores[1].sales === 30, J(r.topStores));
ok('recent orders newest first, problem flagged', r.recentOrders[0].orderId !== 'o3' && r.recentOrders.find((o) => o.orderId === 'o1').problem === true);
const text = JSON.stringify(r);
ok('no customer names, phones, emails or addresses in the payload', !/7300000|t@x\.test|Betio|Bairiki|"Tia"|"Ben"/.test(text), text.slice(0, 200));
ok('30-day view', box.actionGetAdminOverview(ADM, { days: 30 }).kpis.periodOrders === 5);
let fails = 0;
console.log('\n--- admin overview ---');
for (const [s, n, x] of R) { if (s === 'FAIL') fails++; console.log(`${s}  ${n}${x !== '' ? '  [' + x + ']' : ''}`); }
console.log(`\n${R.length - fails}/${R.length} passed`);
process.exit(fails ? 1 : 0);
