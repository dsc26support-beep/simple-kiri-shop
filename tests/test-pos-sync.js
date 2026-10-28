/**
 * Mwakete POS sync foundation (PosCore.gs, PosSync.gs, Pos.gs; Oct 2026) on the
 * REAL backend sources against an in-memory spreadsheet:
 *   - one pricing code: the browser copy (assets/js/pos-core.js) and the server agree
 *   - change log + cursor: every stock movement and product save is a numbered change;
 *     gaps and bad cursors make a till reload, never silently miss a change
 *   - offline sales: kept as they happened (time, till receipt number, till prices),
 *     never duplicated, oversells stop at 0 and open a case, nothing last-write-wins
 *   - payments: cash / EFTPOS paid, IB / MPaisa wait for confirmation; voids; roles
 *   - wholesale prices at the till; price overrides only for managers
 */
const fs = require('fs');
const vm = require('vm');
const { makeBox } = require('./lib/gas-harness.js');
let pass = 0, fails = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('PASS  ' + n); } else { fails++; console.log('FAIL  ' + n + (e === undefined ? '' : '  [' + String(e).slice(0, 400) + ']')); } };
const J = (x) => JSON.stringify(x);

const vHead = ['VariantId', 'ProductId', 'OwnerId', 'Label', 'Price', 'SKU', 'StockQty', 'Status', 'ReservedQty', 'Barcode', 'CostPrice', 'PriceTiersJson', 'MinOrderQty'];
const box = makeBox({
  Owners: [['OwnerId', 'StoreSlug', 'StoreName', 'Status', 'StoreType'], ['own_a', 'a', 'A Shop', 'active', ''], ['own_w', 'w', 'W Wholesale', 'active', 'wholesaler'], ['own_b', 'b', 'B Shop', 'active', '']],
  Products: [['ProductId', 'OwnerId', 'Name', 'Status', 'Category'], ['prod_a', 'own_a', 'Rice', 'active', 'food'], ['prod_w', 'own_w', 'Sugar', 'active', 'food'], ['prod_b', 'own_b', 'Flour', 'active', 'food']],
  Variants: [vHead,
    ['v1', 'prod_a', 'own_a', '1kg', 2, 'R1', 50, 'active', 0, '0093000017', 1, '', ''],
    ['v2', 'prod_a', 'own_a', '5kg', 9.99, 'R5', 3, 'active', 0, '', 6, '', ''],
    ['vw', 'prod_w', 'own_w', 'Bag', 20, 'S1', 500, 'active', 0, '', 12, '[{"minQty":10,"price":18},{"minQty":50,"price":16}]', '5'],
    ['vb', 'prod_b', 'own_b', '25kg', 30, 'F1', 100, 'active', 0, '', '', '', '']]
});
box.__props.POS_HUB = 'on';
box.__props.WHOLESALE_TIERS = 'on';
const A = { OwnerId: 'own_a', StoreSlug: 'a', StoreName: 'A Shop', StoreType: '' };
const W = { OwnerId: 'own_w', StoreSlug: 'w', StoreName: 'W Wholesale', StoreType: 'wholesaler' };
const B = { OwnerId: 'own_b', StoreSlug: 'b', StoreName: 'B Shop', StoreType: '' };
const stock = (id) => Number(box.__sheets.Variants.objects().find((r) => r.VariantId === id).StockQty);
let n = 0;
const tx = () => 'txn-sync-' + (++n) + '-abcd';
const cashier = { role: 'cashier', id: 'st_1', name: 'Tiaon (cashier)', deviceId: 'dev_1' };
const manager = { role: 'manager', id: 'st_2', name: 'Bwena (manager)', deviceId: 'dev_1' };
const sell = (o, lines, extra, actor) => box.actionPosCheckout(o, Object.assign({ clientTxnId: tx(), lines, payment: { method: 'cash' } }, extra || {}), actor);

/* ---------- one pricing code in both places ---------- */
{
  const ctx = vm.createContext({});
  vm.runInContext(fs.readFileSync('assets/js/product-options.js', 'utf8'), ctx);
  vm.runInContext(fs.readFileSync('assets/js/pos-core.js', 'utf8'), ctx);
  ok('the browser copy pos-core.js is generated from PosCore.gs', fs.readFileSync('assets/js/pos-core.js', 'utf8').includes(fs.readFileSync('apps-script/PosCore.gs', 'utf8')));
  const items = { vw: { price: 20, tiers: [{ minQty: 10, price: 18 }, { minQty: 50, price: 16 }], minQty: 5, name: 'Sugar - Bag' } };
  const cases = [
    { lines: [{ variantId: 'vw', qty: 12 }], mode: 'wholesale' },
    { lines: [{ variantId: 'vw', qty: 60 }], mode: 'wholesale', discount: { type: 'percent', value: 5 } },
    { lines: [{ variantId: 'vw', qty: 12 }], mode: 'retail' },
    { lines: [{ variantId: 'vw', qty: 7 }, { variantId: 'vw', qty: 5 }], mode: 'wholesale', discount: { type: 'amount', value: 3 } }
  ];
  let same = true, detail = '';
  cases.forEach((c, i) => {
    const browser = ctx.posPriceCart(c.lines, items, { mode: c.mode, bulkOn: true, discount: c.discount, maxDiscountPct: 10, taxPercent: 0 });
    const server = sell(W, c.lines, { priceMode: c.mode, discount: c.discount });
    box.actionPosSaveSettings(W, { maxDiscountPct: 10 });
    if (!server.ok || Math.abs(server.sale.total - browser.total) > 0.001) { same = false; detail += i + ':' + J(browser) + ' vs ' + J(server) + ' '; }
  });
  ok('till and server work out the same totals (bulk prices, merged lines, discounts)', same, detail);
  ok('wholesale: 12 bags at the 10+ price ($18)', ctx.posPriceCart([{ variantId: 'vw', qty: 12 }], items, { mode: 'wholesale', bulkOn: true }).total === 216);
  ok('retail: 12 bags at the normal price ($20)', ctx.posPriceCart([{ variantId: 'vw', qty: 12 }], items, { mode: 'retail', bulkOn: true }).total === 240);
  ok('wholesale minimum is checked the same way', ctx.posPriceCart([{ variantId: 'vw', qty: 3 }], items, { mode: 'wholesale', bulkOn: true }).errorCode === 'min_qty'
    && !sell(W, [{ variantId: 'vw', qty: 3 }], { priceMode: 'wholesale' }).ok);
  ok('barcodes are text: leading zeros kept', ctx.posCleanBarcode(' 0093000017 ') === '0093000017' && ctx.posFindItems([{ barcode: '0093000017', name: 'Rice' }], '0093000017').exact);
  ok('cash change: short money refused, change worked out', !ctx.posCashChange(10, 5).ok && ctx.posCashChange(9.5, 20).change === 10.5);
  ok('payment summary: IB waits, partial is partial', ctx.posPaymentSummary(10, [{ amount: 10, status: 'pending_verification' }]).status === 'pending_verification'
    && ctx.posPaymentSummary(10, [{ amount: 4, status: 'paid' }]).status === 'partially_paid' && ctx.posPaymentSummary(10, []).status === 'unpaid');
}

/* ---------- catalogue + change cursor ---------- */
let cat = box.actionPosCatalog(A, {});
ok('catalogue: only this store\'s items, with barcode as text and a cursor', cat.ok && cat.items.length === 2 && cat.items.every((i) => ['v1', 'v2'].includes(i.variantId))
  && cat.items.find((i) => i.variantId === 'v1').barcode === '0093000017' && typeof cat.cursor === 'number', J(cat));
ok('catalogue: payment methods are Cash, EFTPOS, IB, MPaisa; IB and MPaisa need confirming', J(cat.methods.map((m) => m.id)) === J(['cash', 'eftpos', 'ib', 'mpaisa'])
  && cat.methods.filter((m) => m.verify).map((m) => m.id).join() === 'ib,mpaisa');
ok('catalogue: cost prices only for roles that may see them', cat.items[0].costPrice !== undefined && box.actionPosCatalog(A, {}, cashier).items[0].costPrice === undefined);
const c0 = cat.cursor;
let r = box.actionPosChanges(A, { since: c0 });
ok('nothing new: an empty answer at the same cursor', r.ok && r.changes.length === 0 && r.latest === c0, J(r));
r = sell(A, [{ variantId: 'v1', qty: 2 }]);
ok('online sale works', r.ok && stock('v1') === 48, J(r));
r = box.actionPosChanges(A, { since: c0 });
const stockChange = r.changes && r.changes.find((c) => c.kind === 'stock' && c.variantId === 'v1');
ok('the sale is a numbered change carrying the new stock (48), and a sale notice', r.ok && stockChange && stockChange.stock === 48 && r.changes.some((c) => c.kind === 'sale')
  && r.changes.every((c, i) => c.seq === c0 + 1 + i), J(r));
ok('another store never sees it', box.actionPosChanges(B, { since: 0 }).changes === undefined || box.actionPosChanges(B, { since: 0 }).changes.length === 0);
r = box.actionAdjustStock(A, { variantId: 'v1', reason: 'damaged', quantity: 1, requestId: 'adj-sync-0001' });
const afterAdj = box.actionPosChanges(A, { since: stockChange.seq });
ok('a stock adjustment from the dashboard reaches the tills (47)', r.ok && afterAdj.changes.some((c) => c.kind === 'stock' && c.variantId === 'v1' && c.stock === 47), J(afterAdj));
box.posEmitCatalogChange('own_a', 'prod_a');
const latest = box.actionPosChanges(A, { since: 0 }).latest;
ok('a product save is a catalogue change naming the product', box.actionPosChanges(A, { since: latest - 1 }).changes[0].kind === 'catalog'
  && box.actionPosChanges(A, { since: latest - 1 }).changes[0].productId === 'prod_a');
ok('a cursor ahead of the server means reload', box.actionPosChanges(A, { since: latest + 5 }).resync === true);
ok('a nonsense cursor means reload', box.actionPosChanges(A, { since: 'abc' }).resync === true);
// A missing change (trimmed or failed write) is a gap: reload, never skip.
const rows = box.__sheets.PosChanges.objects();
const sheet = box.SpreadsheetApp.getActive().getSheetByName('PosChanges');
const gapSeq = c0 + 1;
const rowIdx = rows.findIndex((x) => Number(x.Seq) === gapSeq && x.OwnerId === 'own_a');
sheet.deleteRows(rowIdx + 2, 1);
ok('a gap after the cursor means reload (resync), never a silent skip', box.actionPosChanges(A, { since: c0 }).resync === true, J(box.actionPosChanges(A, { since: c0 })));
ok('...while a till already past the gap carries on', box.actionPosChanges(A, { since: gapSeq }).ok && !box.actionPosChanges(A, { since: gapSeq }).resync);

/* ---------- offline sales ---------- */
const before = stock('v2');
const offTime = new Date(Date.now() - 3 * 3600000).toISOString();
const offTxn = tx();
const offBody = { clientTxnId: offTxn, offline: true, completedAt: offTime, receiptNo: 'R-20261028-TILL1-0001', lines: [{ variantId: 'v2', qty: 1, unitPrice: 9.99 }],
  payment: { method: 'cash', amountTendered: 10 }, clientTotal: 9.99 };
r = box.actionPosUploadSales(A, { sales: [offBody] }, cashier);
const up = r.results && r.results[0];
ok('offline sale uploaded: kept its time, its till receipt number, marked offline', r.ok && up.ok && up.receiptNo === 'R-20261028-TILL1-0001'
  && up.sale.completedOffline === true && up.sale.completedAt === offTime && up.sale.createdAt === offTime && stock('v2') === before - 1, J(r));
ok('...and records who sold it on which till', up.sale.staffName === 'Tiaon (cashier)' && box.__sheets.PosSales.objects().find((s) => s.ClientTxnId === offTxn).DeviceId === 'dev_1');
r = box.actionPosUploadSales(A, { sales: [offBody, offBody] }, cashier);
ok('sent again (lost answer, retry): same sale, no second sale, stock not taken twice', r.ok && r.results.every((x) => x.ok && x.replayed && x.saleId === up.saleId)
  && box.__sheets.PosSales.objects().filter((s) => s.ClientTxnId === offTxn).length === 1 && stock('v2') === before - 1, J(r));
r = box.actionPosLookupTxns(A, { clientTxnIds: [offTxn, 'txn-never-sent-1'] });
ok('a till can ask which of its sales arrived', r.ok && r.found[offTxn].saleId === up.saleId && r.missing[0] === 'txn-never-sent-1', J(r));
ok('...another store cannot see them', box.actionPosLookupTxns(B, { clientTxnIds: [offTxn] }).missing.length === 1);

// Two tills sold the last units while offline.
const left = stock('v2');
r = box.actionPosUploadSales(A, { sales: [
  { clientTxnId: tx(), offline: true, completedAt: offTime, lines: [{ variantId: 'v2', qty: left, unitPrice: 9.99 }], payment: { method: 'cash' } },
  { clientTxnId: tx(), offline: true, completedAt: offTime, lines: [{ variantId: 'v2', qty: 2, unitPrice: 9.99 }], payment: { method: 'eftpos' } }] }, cashier);
ok('offline oversell: both sales kept (they happened)', r.ok && r.results.every((x) => x.ok), J(r));
ok('...stock stops at 0, never negative and never "last till wins"', stock('v2') === 0);
ok('...and the second one opens an "oversold" case for review', r.results[1].cases.some((c) => c.kind === 'oversold') && box.actionPosListCases(A, {}).cases.some((c) => c.kind === 'oversold'), J(r.results[1]));
r = sell(A, [{ variantId: 'v2', qty: 1 }]);
ok('online, the same oversell is refused before anything is sold (a conflict)', !r.ok && r.errorKind === 'conflict' && stock('v2') === 0, J(r));

// The till's price was older than Mwakete's.
r = box.actionPosUploadSales(A, { sales: [{ clientTxnId: tx(), offline: true, completedAt: offTime, lines: [{ variantId: 'v1', qty: 1, unitPrice: 1.5 }], payment: { method: 'cash' } }] }, cashier);
ok('offline price that differs: the customer paid $1.50, so the sale says $1.50, and a case is opened', r.ok && r.results[0].ok && r.results[0].sale.total === 1.5
  && r.results[0].cases.some((c) => c.kind === 'price_differs'), J(r));
box.actionPosSaveSettings(A, { maxDiscountPct: 10 });
r = box.actionPosUploadSales(A, { sales: [{ clientTxnId: tx(), offline: true, completedAt: offTime, lines: [{ variantId: 'v1', qty: 2, unitPrice: 2 }], discount: { type: 'percent', value: 50 }, payment: { method: 'cash' } }] }, cashier);
ok('offline discount above the limit: kept, with a case', r.ok && r.results[0].ok && r.results[0].sale.discount === 2 && r.results[0].cases.some((c) => c.kind === 'discount_over_cap'), J(r));
ok('online, the same discount is refused', !sell(A, [{ variantId: 'v1', qty: 2 }], { discount: { type: 'percent', value: 50 } }).ok);
r = box.actionPosUploadSales(A, { sales: [{ clientTxnId: tx(), offline: true, completedAt: new Date(Date.now() + 3600000).toISOString(), lines: [{ variantId: 'v1', qty: 1 }], payment: { method: 'cash' } },
  { clientTxnId: tx(), offline: true, completedAt: new Date(Date.now() - 40 * 86400000).toISOString(), lines: [{ variantId: 'v1', qty: 1 }], payment: { method: 'cash' } }] }, cashier);
ok('offline sale dated in the future, or 40 days old: refused with a reason, nothing sold', r.ok && !r.results[0].ok && !r.results[1].ok && r.results[1].errorKind === 'too_old', J(r));
ok('upload batches are limited', !box.actionPosUploadSales(A, { sales: Array.from({ length: 21 }, () => offBody) }).ok);

/* ---------- payments that wait ---------- */
r = sell(A, [{ variantId: 'v1', qty: 1 }], { payment: { method: 'ib', reference: 'IB-778' } }, cashier);
const ibSale = r.sale;
ok('IB payment waits for confirmation (not "paid")', r.ok && ibSale.paymentStatus === 'pending_verification' && ibSale.payments[0].status === 'pending_verification', J(r));
ok('...listed as pending', box.actionPosPendingPayments(A, {}).payments.some((p) => p.saleId === ibSale.saleId && p.reference === 'IB-778'));
ok('a cashier cannot confirm it (checked on the server)', box.actionPosConfirmPayment(A, { saleId: ibSale.saleId, outcome: 'confirmed' }, cashier).errorKind === 'forbidden');
r = box.actionPosConfirmPayment(A, { saleId: ibSale.saleId, outcome: 'confirmed', note: 'seen in bank app' }, manager);
ok('a manager confirms it: paid, with who and when', r.ok && r.sale.paymentStatus === 'paid' && r.sale.payments[0].verifiedBy === 'Bwena (manager)', J(r));
r = sell(A, [{ variantId: 'v1', qty: 1 }], { payment: { method: 'mpaisa', reference: 'MP1' } }, cashier);
r = box.actionPosConfirmPayment(A, { saleId: r.sale.saleId, outcome: 'failed' }, manager);
ok('MPaisa that never arrived: failed', r.ok && r.sale.paymentStatus === 'failed', J(r));
ok('another store cannot confirm this store\'s payments', !box.actionPosConfirmPayment(B, { saleId: ibSale.saleId, outcome: 'failed' }).ok);
r = sell(A, [{ variantId: 'v1', qty: 1 }], { payment: { method: 'cash', amount: 1 } }, cashier);
ok('a cashier cannot make a credit (part-paid) sale', !r.ok && r.errorKind === 'forbidden');
r = sell(A, [{ variantId: 'v1', qty: 1 }], { payment: { method: 'cash', amount: 1 } }, manager);
ok('a manager can: partially paid', r.ok && r.sale.paymentStatus === 'partially_paid', J(r));

/* ---------- voids ---------- */
const s0 = stock('v1');
r = sell(A, [{ variantId: 'v1', qty: 2 }], { payment: { method: 'eftpos' } }, cashier);
const vs = r.sale;
ok('a cashier cannot void', box.actionPosVoidSale(A, { saleId: vs.saleId, requestId: 'void-test-0001', reason: 'wrong item' }, cashier).errorKind === 'forbidden');
r = box.actionPosVoidSale(A, { saleId: vs.saleId, requestId: 'void-test-0001', reason: 'wrong item' }, manager);
ok('void: stock goes back, sale kept and marked voided, paid money marked refunded', r.ok && r.sale.status === 'voided' && stock('v1') === s0 && r.sale.paymentStatus === 'refunded'
  && r.sale.voided.by === 'Bwena (manager)', J(r));
r = box.actionPosVoidSale(A, { saleId: vs.saleId, requestId: 'void-test-0001', reason: 'wrong item' }, manager);
ok('the same void again changes nothing', r.ok && stock('v1') === s0);
ok('a voided sale cannot be refunded', !box.actionPosRefundSale(A, { saleId: vs.saleId, requestId: 'ref-after-void-1', reason: 'test' }, manager).ok);
ok('a cashier cannot refund', box.actionPosRefundSale(A, { saleId: ibSale.saleId, requestId: 'ref-cashier-0001', reason: 'test' }, cashier).errorKind === 'forbidden');
const rep = box.actionPosReport(A, {});
ok('reports leave voided sales out of gross and count them apart', rep.ok && rep.channels.pos.voided.sales >= 1 && rep.channels.pos.offline >= 1, J(rep.channels.pos));

/* ---------- overrides, cases ---------- */
ok('a cashier cannot change a price', sell(A, [{ variantId: 'v1', qty: 1, priceOverride: 0.5 }], {}, cashier).errorKind === 'forbidden');
r = sell(A, [{ variantId: 'v1', qty: 1, priceOverride: 1.5 }], {}, manager);
ok('a manager can, and the line says so', r.ok && r.sale.total === 1.5 && r.sale.lines[0].priceOverride === true, J(r));
const open = box.actionPosListCases(A, {});
ok('cases list for this store only', open.ok && open.open >= 3 && box.actionPosListCases(B, {}).cases.length === 0);
ok('a cashier cannot close a case', box.actionPosResolveCase(A, { caseId: open.cases[0].caseId, resolution: 'counted' }, cashier).errorKind === 'forbidden');
r = box.actionPosResolveCase(A, { caseId: open.cases[0].caseId, resolution: 'Counted the shelf, adjusted stock' }, manager);
ok('a manager closes it with what was done', r.ok && r.case.status === 'resolved' && r.case.resolvedBy === 'Bwena (manager)', J(r));
ok('every POS action is audited', ['POS_SALE', 'POS_SALE_OFFLINE', 'POS_VOID', 'POS_PAYMENT_CONFIRMED', 'POS_CASE_RESOLVED'].every((a) => box.__sheets.Audit_Log.objects().some((x) => x.Action === a)));
ok('switched off: nothing answers', (() => { box.__props.POS_HUB = 'off'; const x = box.actionPosChanges(A, { since: 0 }); box.__props.POS_HUB = 'on'; return !x.ok; })());

console.log(`\n${pass}/${pass + fails} passed`);
process.exit(fails ? 1 : 0);
