/**
 * Native Mwakete POS (Oct 2026): a till inside the seller dashboard for shops
 * that sell in person. Design: docs/pos-integration-architecture.md.
 *
 * ONE INVENTORY. A sale takes stock through applyStockDelta (IntegrationHub.gs)
 * and the existing StockMovements ledger (SALE, source "pos"). There is no
 * second stock balance. Prices come from Variants.Price on the server; the
 * browser's prices, totals and discounts are never trusted.
 *
 * NOT IN Orders. Orders are ONLINE orders: each has a buyer account, an order
 * room, emails, invoices, badges and statistics. A walk-in sale must not
 * trigger any of that, so POS sales have their own small records:
 *   PosSales, PosSaleLines, PosPayments, PosRefunds, PosSettings  (created on first use)
 * Reports combine them with online orders and connected-POS sales.
 *
 * PAYMENTS ARE RECORDED TRUTHFULLY. Cash is "received" (the seller has the
 * money in hand). A card, mobile-money or other payment is "recorded by the
 * seller, not verified by Mwakete": Mwakete has no connection to a payment
 * provider, and a typed reference is not proof. Nothing here claims otherwise.
 * Refunds are recorded; Mwakete moves no money, so the seller hands it back.
 *
 * WHO CAN USE IT. Only the signed-in store owner (every action is behind the
 * owner session and filters by OwnerId). There are no staff accounts in
 * Mwakete, so cashier / manager roles are not offered rather than faked with a
 * hidden button. See the architecture document.
 *
 * ONLINE ONLY. A sale is committed only when the backend answers. Each sale
 * carries a clientTxnId so a double tap or a retry after a dropped connection
 * returns the same sale and never takes stock twice.
 */

var POS_SALE_HEADERS = ['SaleId', 'OwnerId', 'ReceiptNo', 'LocationId', 'Status', 'Subtotal', 'Discount', 'DiscountNote', 'Tax', 'Total', 'Currency',
  'PaymentMethod', 'PaymentStatus', 'AmountTendered', 'ChangeGiven', 'RefundedAmount', 'ClientTxnId', 'CreatedBy', 'CreatedAt', 'UpdatedAt', 'Note'];
var POS_LINE_HEADERS = ['LineId', 'SaleId', 'OwnerId', 'VariantId', 'ProductId', 'Name', 'Label', 'SKU', 'Qty', 'UnitPrice', 'LineDiscount', 'LineTotal', 'CostPrice',
  'RefundedQty', 'TrackedStock'];
var POS_PAYMENT_HEADERS = ['PaymentId', 'SaleId', 'OwnerId', 'Method', 'Amount', 'Status', 'Reference', 'Note', 'CreatedAt'];
var POS_REFUND_HEADERS = ['RefundId', 'SaleId', 'OwnerId', 'Amount', 'Reason', 'LinesJson', 'IdempotencyKey', 'Status', 'CreatedBy', 'CreatedAt'];
var POS_SETTINGS_HEADERS = ['OwnerId', 'SettingsJson', 'UpdatedAt'];
var POS_METHODS = ['cash', 'card', 'mobile', 'other'];
var POS_PAYMENT_LABEL = { received: 'Cash received', recorded_unverified: 'Recorded by the seller. Not verified by Mwakete.' };
var POS_MAX_LINES = 100;
var POS_CURRENCY = 'AUD';
var POS_DEFAULTS = { returnPolicy: '', receiptFooter: '', maxDiscountPct: 10, taxPercent: 0 };

function posSalesSheet() { return hubSheet('PosSales', POS_SALE_HEADERS); }
function posLinesSheet() { return hubSheet('PosSaleLines', POS_LINE_HEADERS); }
function posPaymentsSheet() { return hubSheet('PosPayments', POS_PAYMENT_HEADERS); }
function posRefundsSheet() { return hubSheet('PosRefunds', POS_REFUND_HEADERS); }
function posSettingsSheet() { return hubSheet('PosSettings', POS_SETTINGS_HEADERS); }

/** Hours ahead of UTC for the shop's day (Tarawa is +12). Script Property POS_TZ_OFFSET_HOURS overrides. */
function posTzOffsetHours() {
  var raw = PropertiesService.getScriptProperties().getProperty('POS_TZ_OFFSET_HOURS');
  var n = raw === null || raw === '' ? 12 : Number(raw);
  return isFinite(n) && n >= -12 && n <= 14 ? n : 12;
}

/** 'YYYY-MM-DD' in the shop's local day for a UTC time. */
function posLocalDay(utcMs) {
  return new Date(utcMs + posTzOffsetHours() * 3600000).toISOString().slice(0, 10);
}

/** Start of a local day as a UTC ISO time. */
function posDayStartUtc(day) {
  var t = Date.parse(day + 'T00:00:00Z');
  return isFinite(t) ? new Date(t - posTzOffsetHours() * 3600000).toISOString() : '';
}

function posSettingsOf(owner) {
  var row = hubRows('PosSettings').filter(function (r) { return r.OwnerId === owner.OwnerId; })[0];
  return Object.assign({}, POS_DEFAULTS, row ? hubParse(row.SettingsJson, {}) : {});
}

function actionPosGetSettings(owner) {
  if (!posHubEnabled()) return hubOff();
  var s = posSettingsOf(owner);
  return ok({ settings: s, store: { name: owner.StoreName || '', phone: owner.Phone || '', island: owner.Island || '', village: owner.Village || '' }, currency: POS_CURRENCY, tzOffsetHours: posTzOffsetHours() });
}

/** body: returnPolicy?, receiptFooter?, maxDiscountPct? (0-50), taxPercent? (0-30; prices already include it). */
function actionPosSaveSettings(owner, body) {
  if (!posHubEnabled()) return hubOff();
  var cur = posSettingsOf(owner);
  var next = Object.assign({}, cur);
  if (body.returnPolicy !== undefined) next.returnPolicy = String(body.returnPolicy || '').trim().slice(0, 300);
  if (body.receiptFooter !== undefined) next.receiptFooter = String(body.receiptFooter || '').trim().slice(0, 200);
  if (body.maxDiscountPct !== undefined) {
    var d = Number(body.maxDiscountPct);
    if (!isFinite(d) || d < 0 || d > 50) return fail('The biggest discount allowed must be between 0 and 50 percent.');
    next.maxDiscountPct = roundMoney(d);
  }
  if (body.taxPercent !== undefined) {
    var t = Number(body.taxPercent);
    if (!isFinite(t) || t < 0 || t > 30) return fail('Tax must be between 0 and 30 percent.');
    next.taxPercent = roundMoney(t);
  }
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sheet = posSettingsSheet();
    var row = hubRows('PosSettings').filter(function (r) { return r.OwnerId === owner.OwnerId; })[0];
    if (row) updateRowFromObject(sheet, row.__row, { SettingsJson: JSON.stringify(next), UpdatedAt: nowIso() });
    else appendRowFromObject(sheet, { OwnerId: owner.OwnerId, SettingsJson: JSON.stringify(next), UpdatedAt: nowIso() });
    appendAudit({ actorId: owner.OwnerId, actorRole: 'seller', action: 'POS_SETTINGS_SAVED', entityType: 'pos', entityId: owner.OwnerId });
  } finally {
    lock.releaseLock();
  }
  return ok({ settings: next });
}

/** Name, SKU and barcode search over the seller's own products. An exact barcode or SKU comes first. body: q, limit. */
function actionPosSearch(owner, body) {
  if (!posHubEnabled()) return hubOff();
  var q = String((body && body.q) || '').trim().toLowerCase();
  if (q.length < 1) return ok({ items: [] });
  if (q.length > 80) return fail('That search is too long.');
  var variants = sheetToObjects(getSheet('Variants')).filter(function (v) { return v.OwnerId === owner.OwnerId && v.Status === 'active'; });
  ensureInventoryColumns(getSheet('Variants'));
  var products = {};
  sheetToObjects(getSheet('Products')).forEach(function (p) { if (p.OwnerId === owner.OwnerId && p.Status !== 'deleted') products[p.ProductId] = p; });
  var out = [];
  variants.forEach(function (v) {
    var p = products[v.ProductId];
    if (!p) return;
    var sku = String(v.SKU || '').toLowerCase(), bc = String(v.Barcode || '').toLowerCase();
    var name = String(p.Name || '').toLowerCase(), label = String(v.Label || '').toLowerCase();
    var exact = (bc && bc === q) || (sku && sku === q);
    var hit = exact || name.indexOf(q) !== -1 || label.indexOf(q) !== -1 || (sku && sku.indexOf(q) !== -1) || (bc && bc.indexOf(q) !== -1);
    if (!hit) return;
    out.push({ rank: exact ? 0 : (name.indexOf(q) === 0 ? 1 : 2), item: { variantId: v.VariantId, productId: v.ProductId, name: p.Name, label: v.Label, sku: v.SKU || '', barcode: v.Barcode || '',
      price: roundMoney(Number(v.Price) || 0), available: availableOf(v), health: stockHealthOf(v) } });
  });
  out.sort(function (a, b) { return a.rank - b.rank || String(a.item.name).localeCompare(String(b.item.name)); });
  var limit = Math.max(1, Math.min(30, parseInt(body.limit, 10) || 20));
  return ok({ items: out.slice(0, limit).map(function (x) { return x.item; }), exact: out.length > 0 && out[0].rank === 0 });
}

function posReceiptNumber(owner) {
  var day = posLocalDay(Date.now());
  var start = posDayStartUtc(day);
  var n = hubRows('PosSales').filter(function (s) { return s.OwnerId === owner.OwnerId && String(s.CreatedAt) >= start; }).length + 1;
  return 'R-' + day.replace(/-/g, '') + '-' + (n < 1000 ? ('000' + n).slice(-4) : String(n));
}

function posSaleView(sale, lines, payments, refunds) {
  return { saleId: sale.SaleId, receiptNo: sale.ReceiptNo, locationId: sale.LocationId, status: sale.Status, subtotal: Number(sale.Subtotal) || 0, discount: Number(sale.Discount) || 0,
    discountNote: sale.DiscountNote || '', tax: Number(sale.Tax) || 0, total: Number(sale.Total) || 0, currency: sale.Currency, paymentMethod: sale.PaymentMethod, paymentStatus: sale.PaymentStatus,
    paymentLabel: POS_PAYMENT_LABEL[sale.PaymentStatus] || sale.PaymentStatus, amountTendered: sale.AmountTendered === '' ? null : Number(sale.AmountTendered), change: Number(sale.ChangeGiven) || 0,
    refunded: Number(sale.RefundedAmount) || 0, createdAt: sale.CreatedAt, note: sale.Note || '',
    lines: (lines || []).map(function (l) {
      return { lineId: l.LineId, variantId: l.VariantId, name: l.Name, label: l.Label, sku: l.SKU, qty: Number(l.Qty), unitPrice: Number(l.UnitPrice), lineDiscount: Number(l.LineDiscount) || 0,
        lineTotal: Number(l.LineTotal), refundedQty: Number(l.RefundedQty) || 0 };
    }),
    payments: (payments || []).map(function (p) { return { method: p.Method, amount: Number(p.Amount), status: p.Status, reference: p.Reference || '' }; }),
    refunds: (refunds || []).map(function (r) { return { refundId: r.RefundId, amount: Number(r.Amount), reason: r.Reason, createdAt: r.CreatedAt }; }) };
}

function posReceiptOf(owner, view) {
  var s = posSettingsOf(owner);
  return { store: { name: owner.StoreName || '', phone: owner.Phone || '', island: owner.Island || '', village: owner.Village || '' }, receiptNo: view.receiptNo, createdAt: view.createdAt,
    lines: view.lines, subtotal: view.subtotal, discount: view.discount, tax: view.tax, taxIncluded: Number(s.taxPercent) > 0, taxPercent: Number(s.taxPercent) || 0, total: view.total, currency: view.currency,
    payment: { method: view.paymentMethod, status: view.paymentStatus, label: view.paymentLabel, tendered: view.amountTendered, change: view.change },
    returnPolicy: s.returnPolicy || '', footer: s.receiptFooter || '' };
}

function posSaleParts(saleId) {
  return { lines: hubRows('PosSaleLines').filter(function (l) { return l.SaleId === saleId; }), payments: hubRows('PosPayments').filter(function (p) { return p.SaleId === saleId; }),
    refunds: hubRows('PosRefunds').filter(function (r) { return r.SaleId === saleId; }) };
}

/**
 * body: clientTxnId (8-64 letters, digits, - _), lines [{variantId, qty}], discount? {type:'percent'|'amount', value, note?},
 *       payment {method, amountTendered? (cash), reference? (not proof)}, locationId?, note?
 */
function actionPosCheckout(owner, body) {
  if (!posHubEnabled()) return hubOff();
  var clientTxnId = cleanRequestId(body.clientTxnId);
  if (!clientTxnId) return fail('This sale has no reference number. Reload the page and try again.');
  var req = Array.isArray(body.lines) ? body.lines : [];
  if (!req.length) return fail('Add at least one item.');
  if (req.length > POS_MAX_LINES) return fail('A sale can have at most ' + POS_MAX_LINES + ' lines.');
  var pay = body.payment && typeof body.payment === 'object' ? body.payment : {};
  var method = String(pay.method || '');
  if (POS_METHODS.indexOf(method) === -1) return fail('Choose how the customer paid.');
  var locationId = String(body.locationId || DEFAULT_LOCATION_ID);
  var note = String(body.note || '').trim().slice(0, 200);

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    // A retry of the same sale: answer with the first one, take nothing twice. Checked inside the lock.
    var prior = hubRows('PosSales').filter(function (s) { return s.OwnerId === owner.OwnerId && s.ClientTxnId === clientTxnId; })[0];
    if (prior) {
      var pp = posSaleParts(prior.SaleId);
      var v0 = posSaleView(prior, pp.lines, pp.payments, pp.refunds);
      return ok({ sale: v0, receipt: posReceiptOf(owner, v0), replayed: true });
    }
    var settings = posSettingsOf(owner);
    var ctx = hubStockContext(owner);
    var products = {};
    sheetToObjects(getSheet('Products')).forEach(function (p) { if (p.OwnerId === owner.OwnerId) products[p.ProductId] = p; });
    if (locationId !== DEFAULT_LOCATION_ID) {
      var locErr = typeof locationDeltaError === 'function' ? locationDeltaError(owner, { VariantId: '' }, locationId, 0) : 'Locations are not available.';
      if (locErr) return fail(locErr);
    }
    // Merge repeated varieties, then validate EVERYTHING before any stock moves.
    var wanted = {};
    var order = [];
    for (var i = 0; i < req.length; i++) {
      var q = Number(req[i] && req[i].qty);
      var id = String(req[i] && req[i].variantId || '');
      if (!id || !isFinite(q) || q < 1 || Math.floor(q) !== q || q > 10000) return fail('Every item needs a whole quantity of 1 or more.');
      if (!wanted[id]) { wanted[id] = 0; order.push(id); }
      wanted[id] += q;
    }
    var priced = [];
    var subtotal = 0;
    for (var j = 0; j < order.length; j++) {
      var v = ctx.byId[order[j]];
      if (!v) return fail('One of the items is no longer available. Refresh and try again.');
      var price = roundMoney(Number(v.Price));
      if (!isFinite(price) || price <= 0) return fail('"' + v.Label + '" has no price. Set its price in Products first.');
      var qty = wanted[order[j]];
      if (isStockTracked(v)) {
        var avail = availableOf(v);
        var room = avail;
        if (locationId !== DEFAULT_LOCATION_ID) room = Math.min(avail, ((ownLocationStock(owner.OwnerId)[v.VariantId]) || {})[locationId] || 0);
        if (qty > room) return fail('Only ' + room + ' of "' + (products[v.ProductId] ? products[v.ProductId].Name : '') + ' - ' + v.Label + '" can be sold' + (avail < physicalOf(v) ? ' (some are held for online orders)' : '') + '.');
      }
      var lineTotal = roundMoney(qty * price);
      subtotal = roundMoney(subtotal + lineTotal);
      priced.push({ variant: v, product: products[v.ProductId] || {}, qty: qty, price: price, lineTotal: lineTotal });
    }
    // Discount, capped by the seller's own setting, calculated here.
    var discount = 0, discountNote = '';
    if (body.discount && typeof body.discount === 'object' && Number(body.discount.value) > 0) {
      var dv = Number(body.discount.value);
      var cap = Number(settings.maxDiscountPct) || 0;
      if (!isFinite(dv)) return fail('The discount is not a number.');
      discount = body.discount.type === 'percent' ? roundMoney(subtotal * dv / 100) : roundMoney(dv);
      if (discount > roundMoney(subtotal * cap / 100) + 0.005) return fail(cap > 0 ? 'A discount can be at most ' + cap + '% of the sale. You can change this in POS settings.' : 'Discounts are switched off. Turn them on in POS settings.');
      if (discount >= subtotal) return fail('The discount cannot be the whole sale.');
      discountNote = String(body.discount.note || '').trim().slice(0, 80) || (body.discount.type === 'percent' ? dv + '% off' : 'Discount');
    }
    var total = roundMoney(subtotal - discount);
    var taxPct = Number(settings.taxPercent) || 0;
    var tax = taxPct > 0 ? roundMoney(total * taxPct / (100 + taxPct)) : 0;
    var tendered = null, change = 0, status;
    if (method === 'cash') {
      tendered = pay.amountTendered === undefined || pay.amountTendered === '' ? total : roundMoney(Number(pay.amountTendered));
      if (!isFinite(tendered) || tendered + 0.005 < total) return fail('The cash given is less than the total of ' + orderMoney(total) + '.');
      change = roundMoney(tendered - total);
      status = 'received';
    } else {
      status = 'recorded_unverified';
    }
    var saleId = newId('pos');
    var receiptNo = posReceiptNumber(owner);
    var now = nowIso();
    // Allocate the discount over the lines in proportion, so refunds can be worked out per line.
    var allocated = 0;
    priced.forEach(function (p, idx) {
      var share = idx === priced.length - 1 ? roundMoney(discount - allocated) : roundMoney(discount * p.lineTotal / subtotal);
      allocated = roundMoney(allocated + share);
      p.lineDiscount = share;
      p.net = roundMoney(p.lineTotal - share);
    });
    // Stock: the single inventory model. Validated above, so these cannot fail halfway.
    var linesOut = [];
    for (var k = 0; k < priced.length; k++) {
      var pr = priced[k];
      var d = applyStockDelta(owner, pr.variant, locationId, -pr.qty, 'SALE', 'pos', saleId, 'POS sale ' + receiptNo, { fact: false, userId: owner.OwnerId });
      if (d.error) return fail(d.error + ' Nothing was sold.');
      linesOut.push({ LineId: newId('pl'), SaleId: saleId, OwnerId: owner.OwnerId, VariantId: pr.variant.VariantId, ProductId: pr.variant.ProductId, Name: pr.product.Name || '', Label: pr.variant.Label || '',
        SKU: pr.variant.SKU || '', Qty: pr.qty, UnitPrice: pr.price, LineDiscount: pr.lineDiscount, LineTotal: pr.net, CostPrice: pr.variant.CostPrice === '' || pr.variant.CostPrice === undefined ? '' : Number(pr.variant.CostPrice),
        RefundedQty: 0, TrackedStock: isStockTracked(pr.variant) ? 'yes' : 'no' });
    }
    appendRowFromObject(posSalesSheet(), { SaleId: saleId, OwnerId: owner.OwnerId, ReceiptNo: receiptNo, LocationId: locationId, Status: 'completed', Subtotal: subtotal, Discount: discount,
      DiscountNote: discountNote, Tax: tax, Total: total, Currency: POS_CURRENCY, PaymentMethod: method, PaymentStatus: status, AmountTendered: tendered === null ? '' : tendered, ChangeGiven: change,
      RefundedAmount: 0, ClientTxnId: clientTxnId, CreatedBy: owner.OwnerId, CreatedAt: now, UpdatedAt: now, Note: note });
    var ls = posLinesSheet();
    linesOut.forEach(function (l) { appendRowFromObject(ls, l); });
    appendRowFromObject(posPaymentsSheet(), { PaymentId: newId('pay'), SaleId: saleId, OwnerId: owner.OwnerId, Method: method, Amount: total, Status: status,
      Reference: method === 'cash' ? '' : String(pay.reference || '').trim().slice(0, 40), Note: method === 'cash' ? '' : 'Recorded by the seller. Mwakete has not verified this payment.', CreatedAt: now });
    appendAudit({ actorId: owner.OwnerId, actorRole: 'seller', action: 'POS_SALE', entityType: 'pos_sale', entityId: saleId, next: receiptNo + ' ' + total });
    invalidateCache([storeProductsCacheKey(owner.StoreSlug)]);
    var parts = posSaleParts(saleId);
    var view = posSaleView(hubRows('PosSales').filter(function (s) { return s.SaleId === saleId; })[0], parts.lines, parts.payments, parts.refunds);
    return ok({ sale: view, receipt: posReceiptOf(owner, view) });
  } finally {
    lock.releaseLock();
  }
}

/** body: from?, to? (YYYY-MM-DD, the shop's days), status?, q? (receipt number), limit?. */
function actionPosListSales(owner, body) {
  if (!posHubEnabled()) return hubOff();
  body = body || {};
  var from = body.from ? posDayStartUtc(String(body.from)) : '';
  var to = body.to ? posDayStartUtc(new Date(Date.parse(String(body.to) + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10)) : '';
  var q = String(body.q || '').trim().toLowerCase();
  var list = hubRows('PosSales').filter(function (s) {
    return s.OwnerId === owner.OwnerId && (!from || String(s.CreatedAt) >= from) && (!to || String(s.CreatedAt) < to) && (!body.status || s.Status === body.status) &&
      (!q || String(s.ReceiptNo).toLowerCase().indexOf(q) !== -1);
  }).sort(function (a, b) { return String(b.CreatedAt).localeCompare(String(a.CreatedAt)); });
  var limit = Math.max(1, Math.min(200, parseInt(body.limit, 10) || 50));
  return ok({ sales: list.slice(0, limit).map(function (s) {
    return { saleId: s.SaleId, receiptNo: s.ReceiptNo, status: s.Status, total: Number(s.Total) || 0, refunded: Number(s.RefundedAmount) || 0, paymentMethod: s.PaymentMethod,
      paymentStatus: s.PaymentStatus, createdAt: s.CreatedAt };
  }), total: list.length });
}

/** body: saleId or receiptNo. */
function actionPosGetSale(owner, body) {
  if (!posHubEnabled()) return hubOff();
  var sale = hubRows('PosSales').filter(function (s) { return s.OwnerId === owner.OwnerId && (s.SaleId === String(body.saleId || '') || (body.receiptNo && s.ReceiptNo === String(body.receiptNo))); })[0];
  if (!sale) return fail('That sale was not found.');
  var parts = posSaleParts(sale.SaleId);
  var view = posSaleView(sale, parts.lines, parts.payments, parts.refunds);
  return ok({ sale: view, receipt: posReceiptOf(owner, view) });
}

/**
 * body: saleId, requestId (8-64), lines [{lineId, qty, restock}] (omit lines for a whole-sale void), reason.
 * Refunds are recorded; Mwakete moves no money. A line is put back in stock only when the seller says the goods are back (restock: true).
 */
function actionPosRefundSale(owner, body) {
  if (!posHubEnabled()) return hubOff();
  var requestId = cleanRequestId(body.requestId);
  if (!requestId) return fail('This refund has no reference number. Reload the page and try again.');
  var reason = String(body.reason || '').trim().slice(0, 120);
  if (reason.length < 3) return fail('Say why (for example "wrong size" or "customer changed their mind").');
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var dup = hubRows('PosRefunds').filter(function (r) { return r.OwnerId === owner.OwnerId && r.IdempotencyKey === requestId; })[0];
    if (dup) {
      var sd = hubRows('PosSales').filter(function (s) { return s.SaleId === dup.SaleId; })[0];
      var pd = posSaleParts(dup.SaleId);
      return ok({ sale: posSaleView(sd, pd.lines, pd.payments, pd.refunds), refundId: dup.RefundId, amount: Number(dup.Amount), replayed: true });
    }
    var sheet = posSalesSheet();
    var sale = findRowById(sheet, 'SaleId', String(body.saleId || ''));
    if (!sale || sale.OwnerId !== owner.OwnerId) return fail('That sale was not found.');
    if (sale.Status === 'refunded') return fail('That sale is already fully refunded.');
    var lines = hubRows('PosSaleLines').filter(function (l) { return l.SaleId === sale.SaleId; });
    var asked = Array.isArray(body.lines) && body.lines.length ? body.lines : lines.map(function (l) { return { lineId: l.LineId, qty: Number(l.Qty) - (Number(l.RefundedQty) || 0), restock: body.restockAll === true }; }).filter(function (x) { return x.qty > 0; });
    if (!asked.length) return fail('Nothing is left to refund on that sale.');
    var ctx = hubStockContext(owner);
    var seen = {};
    var amount = 0;
    var plan = [];
    for (var i = 0; i < asked.length; i++) {
      var a = asked[i];
      var line = lines.filter(function (l) { return l.LineId === String(a.lineId || ''); })[0];
      if (!line) return fail('One of those lines is not on that sale.');
      if (seen[line.LineId]) return fail('A line was listed twice.');
      seen[line.LineId] = true;
      var qty = Number(a.qty);
      var left = Number(line.Qty) - (Number(line.RefundedQty) || 0);
      if (!isFinite(qty) || qty < 1 || Math.floor(qty) !== qty) return fail('Enter a whole quantity to refund.');
      if (qty > left) return fail('Only ' + left + ' of "' + line.Name + ' - ' + line.Label + '" can still be refunded.');
      // The line's money after its share of any discount, divided by quantity (the last unit takes the rounding).
      var unitNet = Number(line.LineTotal) / Number(line.Qty);
      var money = (qty === left && (Number(line.RefundedQty) || 0) > 0) ? roundMoney(Number(line.LineTotal) - roundMoney(unitNet * (Number(line.RefundedQty) || 0))) : roundMoney(unitNet * qty);
      amount = roundMoney(amount + money);
      plan.push({ line: line, qty: qty, money: money, restock: a.restock === true });
    }
    var remaining = roundMoney(Number(sale.Total) - (Number(sale.RefundedAmount) || 0));
    if (amount > remaining + 0.005) return fail('That is more than what is left to refund on this sale (' + orderMoney(remaining) + ').');
    var restocked = [];
    plan.forEach(function (p) {
      if (p.restock && p.line.TrackedStock === 'yes') {
        var v = ctx.byId[p.line.VariantId];
        if (v) {
          var d = applyStockDelta(owner, v, sale.LocationId, p.qty, 'RETURN', 'pos', sale.SaleId, 'POS refund of ' + sale.ReceiptNo, { fact: true, userId: owner.OwnerId });
          restocked.push({ lineId: p.line.LineId, restocked: d.applied });
        }
      }
      updateRowFromObject(posLinesSheet(), p.line.__row, { RefundedQty: (Number(p.line.RefundedQty) || 0) + p.qty });
    });
    var newRefunded = roundMoney((Number(sale.RefundedAmount) || 0) + amount);
    var after = hubRows('PosSaleLines').filter(function (l) { return l.SaleId === sale.SaleId; });
    var full = after.every(function (l) { return (Number(l.RefundedQty) || 0) >= Number(l.Qty); });
    updateRowFromObject(sheet, sale.__row, { RefundedAmount: newRefunded, Status: full ? 'refunded' : 'partially_refunded', UpdatedAt: nowIso() });
    var refundId = newId('ref');
    appendRowFromObject(posRefundsSheet(), { RefundId: refundId, SaleId: sale.SaleId, OwnerId: owner.OwnerId, Amount: amount, Reason: reason,
      LinesJson: JSON.stringify(plan.map(function (p) { return { lineId: p.line.LineId, qty: p.qty, amount: p.money, restock: p.restock && p.line.TrackedStock === 'yes' }; })),
      IdempotencyKey: requestId, Status: 'recorded', CreatedBy: owner.OwnerId, CreatedAt: nowIso() });
    appendAudit({ actorId: owner.OwnerId, actorRole: 'seller', action: 'POS_REFUND', entityType: 'pos_sale', entityId: sale.SaleId, next: String(amount), reason: reason });
    invalidateCache([storeProductsCacheKey(owner.StoreSlug)]);
    var fresh = findRowById(sheet, 'SaleId', sale.SaleId);
    var parts = posSaleParts(sale.SaleId);
    return ok({ sale: posSaleView(fresh, parts.lines, parts.payments, parts.refunds), refundId: refundId, amount: amount,
      note: 'Recorded. Mwakete does not move money: give the customer ' + orderMoney(amount) + ' yourself.' });
  } finally {
    lock.releaseLock();
  }
}

/** body: from, to (YYYY-MM-DD, the shop's days; default today). Gross, refunds and net are kept apart. */
function actionPosReport(owner, body) {
  if (!posHubEnabled()) return hubOff();
  body = body || {};
  var today = posLocalDay(Date.now());
  var fromDay = /^\d{4}-\d{2}-\d{2}$/.test(String(body.from || '')) ? body.from : today;
  var toDay = /^\d{4}-\d{2}-\d{2}$/.test(String(body.to || '')) ? body.to : today;
  if (toDay < fromDay) return fail('The end date is before the start date.');
  if ((Date.parse(toDay) - Date.parse(fromDay)) / 86400000 > 366) return fail('Choose a range of up to one year.');
  var from = posDayStartUtc(fromDay);
  var to = posDayStartUtc(new Date(Date.parse(toDay + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10));
  var inRange = function (t) { return String(t) >= from && String(t) < to; };
  var money = function (n) { return roundMoney(n); };

  var sales = hubRows('PosSales').filter(function (s) { return s.OwnerId === owner.OwnerId && inRange(s.CreatedAt); });
  var saleIds = {};
  sales.forEach(function (s) { saleIds[s.SaleId] = true; });
  var refunds = hubRows('PosRefunds').filter(function (r) { return r.OwnerId === owner.OwnerId && inRange(r.CreatedAt); });
  var lines = hubRows('PosSaleLines').filter(function (l) { return l.OwnerId === owner.OwnerId && saleIds[l.SaleId]; });
  var posGross = money(sales.reduce(function (n, s) { return n + (Number(s.Total) || 0); }, 0));
  var posRefunds = money(refunds.reduce(function (n, r) { return n + (Number(r.Amount) || 0); }, 0));

  var byMethod = {};
  hubRows('PosPayments').filter(function (p) { return p.OwnerId === owner.OwnerId && saleIds[p.SaleId]; }).forEach(function (p) {
    var k = p.Method + '|' + p.Status;
    byMethod[k] = byMethod[k] || { method: p.Method, status: p.Status, label: POS_PAYMENT_LABEL[p.Status] || p.Status, count: 0, amount: 0 };
    byMethod[k].count++; byMethod[k].amount = money(byMethod[k].amount + (Number(p.Amount) || 0));
  });

  var ordersTab = SpreadsheetApp.getActive().getSheetByName('Orders');
  var online = (ordersTab ? sheetToObjects(ordersTab) : []).filter(function (o) { return o.OwnerId === owner.OwnerId && inRange(o.CreatedAt) && (o.Status === 'Paid' || o.Status === 'Fulfilled'); });
  var onlineGross = money(online.reduce(function (n, o) { return n + (Number(o.Total) || 0); }, 0));
  var ext = hubRows('ExternalSales').filter(function (s) { return s.OwnerId === owner.OwnerId && inRange(s.OccurredAt) && s.Status !== 'voided' && s.Status !== 'needs_mapping' && s.Status !== 'open'; });
  var extGross = money(ext.reduce(function (n, s) { return n + (Number(s.Total) || 0); }, 0));
  var extRefunds = money(ext.reduce(function (n, s) { return n + (Number(s.RefundedAmount) || 0); }, 0));

  // Profit only when every sold line has a cost price recorded at the time.
  var withCost = lines.filter(function (l) { return l.CostPrice !== '' && l.CostPrice !== undefined && isFinite(Number(l.CostPrice)); });
  var coverage = lines.length ? withCost.length / lines.length : 0;
  var profit = null;
  if (lines.length && coverage === 1) profit = money(lines.reduce(function (n, l) { return n + (Number(l.LineTotal) || 0) - (Number(l.CostPrice) || 0) * (Number(l.Qty) || 0); }, 0));

  var locations = {};
  if (typeof ownLocations === 'function') ownLocations(owner.OwnerId).forEach(function (l) { locations[l.LocationId] = l.Name; });
  var byOutlet = {};
  sales.forEach(function (s) {
    var k = s.LocationId || DEFAULT_LOCATION_ID;
    byOutlet[k] = byOutlet[k] || { locationId: k, name: locations[k] || (k === DEFAULT_LOCATION_ID ? (typeof mainLocationName === 'function' ? mainLocationName(owner) : 'Main') : k), sales: 0, gross: 0 };
    byOutlet[k].sales++; byOutlet[k].gross = money(byOutlet[k].gross + (Number(s.Total) || 0));
  });
  var byUser = {};
  sales.forEach(function (s) {
    var k = s.CreatedBy || owner.OwnerId;
    byUser[k] = byUser[k] || { userId: k, name: k === owner.OwnerId ? (owner.StoreName || 'Owner') + ' (owner)' : k, sales: 0, gross: 0 };
    byUser[k].sales++; byUser[k].gross = money(byUser[k].gross + (Number(s.Total) || 0));
  });

  var vars = sheetToObjects(getSheet('Variants')).filter(function (v) { return v.OwnerId === owner.OwnerId && v.Status === 'active'; });
  var prods = {};
  sheetToObjects(getSheet('Products')).forEach(function (p) { prods[p.ProductId] = p; });
  var low = vars.filter(function (v) { var h = stockHealthOf(v); return h === 'low' || h === 'out'; }).slice(0, 30).map(function (v) {
    return { variantId: v.VariantId, name: (prods[v.ProductId] || {}).Name || '', label: v.Label, available: availableOf(v), health: stockHealthOf(v) };
  });

  var moves = {};
  var ledger = SpreadsheetApp.getActive().getSheetByName('StockMovements');
  (ledger ? sheetToObjects(ledger) : []).filter(function (m) { return m.OwnerId === owner.OwnerId && inRange(m.CreatedAt); }).forEach(function (m) {
    moves[m.MovementType] = moves[m.MovementType] || { type: m.MovementType, count: 0, units: 0 };
    moves[m.MovementType].count++; moves[m.MovementType].units += Number(m.Quantity) || 0;
  });

  return ok({ range: { from: fromDay, to: toDay, tzOffsetHours: posTzOffsetHours() }, currency: POS_CURRENCY,
    channels: {
      pos: { sales: sales.length, gross: posGross, refunds: posRefunds, net: money(posGross - posRefunds) },
      online: { orders: online.length, gross: onlineGross, refunds: 0, net: onlineGross, note: 'Paid and fulfilled orders, including delivery. Online refunds are handled in each order.' },
      connected: { sales: ext.length, gross: extGross, refunds: extRefunds, net: money(extGross - extRefunds), note: 'Sales reported by your connected POS systems.' }
    },
    combined: { gross: money(posGross + onlineGross + extGross), refunds: money(posRefunds + extRefunds), net: money(posGross - posRefunds + onlineGross + extGross - extRefunds) },
    payments: Object.keys(byMethod).map(function (k) { return byMethod[k]; }),
    profit: { available: profit !== null, estimated: profit, coveragePct: Math.round(coverage * 100), note: profit === null ? (lines.length ? 'Not shown: some items sold have no cost price. Add cost prices in Inventory.' : 'No POS sales in this range.') : 'POS sales only, from the cost prices recorded when each item was sold.' },
    outlets: Object.keys(byOutlet).map(function (k) { return byOutlet[k]; }), cashiers: Object.keys(byUser).map(function (k) { return byUser[k]; }),
    lowStock: low, movements: Object.keys(moves).map(function (k) { return moves[k]; }) });
}
