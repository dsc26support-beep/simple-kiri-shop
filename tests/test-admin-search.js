/**
 * Admin search across stores, products, orders, featuring payments and
 * listing-review cases, with reference shortcuts and phone matching (Oct
 * 2026), on the REAL backend sources (gas-harness).
 */
const { makeBox } = require('./lib/gas-harness.js');
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e === undefined ? '' : e]);
const J = (x) => JSON.stringify(x).slice(0, 300);

const box = makeBox({
  Owners: [['OwnerId', 'StoreSlug', 'StoreName', 'Status', 'Email', 'Phone', 'WhatsApp'],
    ['own_a', 'adm', 'Admin', 'active', 'admin@x.test', '', ''],
    ['own_b', 'bong', 'Bong Store', 'active', 'bong@x.test', '+686 7300 1234', ''],
    ['own_c', 'tea', 'Teaube', 'active', 'tea@x.test', '63005555', '']],
  Products: [['ProductId', 'OwnerId', 'Name', 'Status'], ['prod_1', 'own_b', 'Jasmine rice', 'active'], ['prod_2', 'own_c', 'Rice cooker', 'hidden']],
  Orders: [['OrderId', 'OwnerId', 'StoreSlug', 'CustomerName', 'CustomerPhone', 'ItemsSummary', 'Total', 'Status', 'CreatedAt'],
    ['SKS-bong-20261001-1111', 'own_b', 'bong', 'Tia Ioane', '73009999', '2× Jasmine rice 5 kg', 27, 'Paid', '2026-10-01T01:00:00Z'],
    ['SKS-tea-20261005-2222', 'own_c', 'tea', 'Baraniko', '+686 7300 1234', '1× Rice cooker', 40, 'Pending Payment', '2026-10-05T01:00:00Z']],
  FeaturePurchases: [['PurchaseId', 'OwnerId', 'Reference', 'ReceiptNo', 'Status', 'Amount', 'CreatedAt'],
    ['fp_1', 'own_b', 'MWFAB23CD', 'AQC11111', 'Approved', 0.7, '2026-10-02T00:00:00Z']],
  Product_Review_Queue: [['ReviewId', 'CaseType', 'ProductId', 'SellerId', 'ProductNameSnapshot', 'ProposedCategoryName', 'Status', 'Severity', 'SubmittedAt'],
    ['rev_abc123', 'LISTING', 'prod_1', 'own_b', 'Water', '', 'PENDING', 'high', '2026-10-03T00:00:00Z'],
    ['rev_def456', 'CATEGORY_REQUEST', '', 'own_c', '', 'Baby Formula', 'PENDING', 'medium', '2026-10-04T00:00:00Z']]
});
box.__props.ADMIN_EMAILS = 'admin@x.test';
const owners = box.__sheets.Owners.objects();
const A = owners[0], B = owners[1];
const search = (q, who) => box.actionAdminSearch(who || A, { q });

let r = search('rice');
ok('one box: products and orders both found', r.ok && r.products.length === 2 && r.orders.length === 2, J(r));
ok('...orders newest first, with store, customer, total, items', r.orders[0].orderId === 'SKS-tea-20261005-2222' && r.orders[0].storeName === 'Teaube'
  && r.orders[0].total === 40 && /Rice cooker/.test(r.orders[0].itemsSummary));
ok('no shortcut for a plain word', r.exact === null);
r = search('SKS-bong-20261001-1111');
ok('shortcut: exact order number opens the order', r.exact && r.exact.type === 'order' && r.exact.id === 'SKS-bong-20261001-1111', J(r.exact));
r = search('sks-bong-20261001-1111');
ok('...in any letter case', r.exact && r.exact.type === 'order');
r = search('SKS-bong');
ok('a partial order number lists, but does not jump', r.orders.length === 1 && r.exact === null);
r = search('mwfab23cd');
ok('shortcut: payment reference', r.exact && r.exact.type === 'payment' && r.exact.id === 'MWFAB23CD' && r.payments[0].storeName === 'Bong Store', J(r));
r = search('AQC11111');
ok('the bank receipt number finds the payment too (no jump)', r.payments.length === 1 && r.exact === null);
r = search('rev_abc123');
ok('shortcut: review case id', r.exact && r.exact.type === 'case' && r.cases[0].productName === 'Water', J(r));
r = search('baby');
ok('category requests are searchable by proposed name', r.cases.length === 1 && r.cases[0].caseType === 'CATEGORY_REQUEST');
r = search('7300 1234');
ok('phone: spaces ignored - finds the store AND the order with that number', r.phone === true && r.stores.map((s) => s.storeSlug).join() === 'bong'
  && r.orders.map((o) => o.orderId).join() === 'SKS-tea-20261005-2222', J(r));
r = search('+686 73001234');
ok('phone: with country code matches the same', r.stores.length === 1 && r.orders.length === 1, J(r));
r = search('63005555');
ok('phone: another store by its number', r.stores.length === 1 && r.stores[0].storeName === 'Teaube');
r = search('73009999');
ok('phone: customer phone on an order', r.orders.length === 1 && r.orders[0].customerName === 'Tia Ioane');
r = search('x');
ok('one character searches nothing', r.ok && r.stores.length === 0 && r.orders.length === 0);
r = search('rice', B);
ok('a seller cannot use the admin search', !r.ok && r.error === 'Not authorized');
ok('works when the payments / review tabs do not exist yet', (() => {
  delete box.__sheets.FeaturePurchases; delete box.__sheets.Product_Review_Queue;
  const x = search('rice');
  return x.ok && x.payments.length === 0 && x.cases.length === 0;
})());

let fails = 0;
console.log('\n--- admin search ---');
for (const [s, n, x] of R) { if (s === 'FAIL') fails++; console.log(`${s}  ${n}${x !== '' ? '  [' + x + ']' : ''}`); }
console.log(`\n${R.length - fails}/${R.length} passed`);
process.exit(fails ? 1 : 0);
