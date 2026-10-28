/**
 * Mwakete POS - the shared rules (Oct 2026, docs/mwakete-pos-architecture.md).
 *
 * ONE SOURCE, THREE PLACES - like ProductOptions.gs: the backend prices and
 * checks every sale with these functions, and `npm run build` copies this file
 * to assets/js/pos-core.js for the till inside the seller dashboard
 * (owner/pos.html) and the standalone POS app (pos/). So a total shown on a
 * till is worked out by the very same code the server uses. The server still
 * has the final say on everything sent to it. Never edit the copy. Plain
 * functions and `var` only - no Apps Script services, no DOM, no Date.now().
 *
 * Needs tierUnitPrice (ProductOptions.gs / product-options.js) for bulk prices.
 */

var POS_CORE_METHODS = ['cash', 'eftpos', 'ib', 'mpaisa'];
var POS_CORE_METHOD_LABEL = { cash: 'Cash', eftpos: 'Card (EFTPOS)', ib: 'IB (Internet Banking)', mpaisa: 'MPaisa',
  // Sales from before Oct 2026 (read only - no longer offered).
  card: 'Card', mobile: 'Mobile money', other: 'Other' };
// Older tills sent these; they mean the same thing.
var POS_CORE_LEGACY_METHOD = { card: 'eftpos', mobile: 'mpaisa' };

var POS_CORE_PAY_STATUS_LABEL = {
  unpaid: 'Unpaid', partially_paid: 'Partially paid', paid: 'Paid', pending_verification: 'Pending verification',
  failed: 'Failed', refunded: 'Refunded',
  // Sales from before Oct 2026.
  received: 'Paid (cash received)', recorded_unverified: 'Recorded by the seller, not verified'
};
var POS_CORE_SALE_STATUS_LABEL = { draft: 'Draft', completed: 'Completed', voided: 'Voided', refunded: 'Returned', partially_refunded: 'Partly returned' };
var POS_CORE_SYNC_LABEL = {
  saved_locally: 'Saved locally', awaiting: 'Awaiting server confirmation', synced: 'Synchronised', offline: 'Offline',
  failed: 'Sync failed', conflict: 'Conflict requires review'
};
var POS_CORE_LIMITS = { maxLines: 100, maxQty: 10000, maxDiscountPctCap: 50, maxTaxPct: 30 };

function posCents(n) { return Math.round((Number(n) || 0) * 100) / 100; }

/** 'cash' | 'eftpos' | 'ib' | 'mpaisa', or '' when not a method the till takes. */
function posNormalizeMethod(method) {
  var m = String(method || '').toLowerCase();
  if (POS_CORE_LEGACY_METHOD[m]) m = POS_CORE_LEGACY_METHOD[m];
  return POS_CORE_METHODS.indexOf(m) === -1 ? '' : m;
}

/**
 * How a payment starts. Cash and EFTPOS are paid at the counter (EFTPOS is
 * typed in from the bank's own terminal - Mwakete is not connected to it).
 * IB and MPaisa wait for a manager or the owner to confirm the money arrived:
 * a reference or a screenshot is not proof (owner decision, Oct 2026).
 */
function posInitialPaymentStatus(method) {
  var m = posNormalizeMethod(method);
  return m === 'ib' || m === 'mpaisa' ? 'pending_verification' : 'paid';
}

/**
 * The sale's payment status from its payments. payments: [{amount, status}].
 * Refunded money is counted by the caller (refunds are their own records).
 */
function posPaymentSummary(total, payments) {
  var paid = 0, pending = 0;
  (payments || []).forEach(function (p) {
    var a = posCents(p && p.amount);
    if (!p || a <= 0) return;
    if (p.status === 'paid' || p.status === 'received' || p.status === 'recorded_unverified') paid = posCents(paid + a);
    else if (p.status === 'pending_verification') pending = posCents(pending + a);
  });
  var t = posCents(total);
  var status;
  if (pending > 0) status = 'pending_verification';
  else if (paid + 0.005 >= t && t > 0) status = 'paid';
  else if (paid > 0) status = 'partially_paid';
  else if ((payments || []).some(function (p) { return p && p.status === 'failed'; })) status = 'failed';
  else status = 'unpaid';
  return { status: status, paid: paid, pending: pending, due: posCents(Math.max(0, t - paid - pending)) };
}

/** Cash: { ok, change } or { ok: false, error }. A blank amount means exact money. */
function posCashChange(total, tendered) {
  var t = posCents(total);
  if (tendered === undefined || tendered === null || tendered === '') return { ok: true, tendered: t, change: 0 };
  var g = posCents(tendered);
  if (!isFinite(Number(tendered)) || g + 0.005 < t) return { ok: false, error: 'The cash given is less than the total of $' + t.toFixed(2) + '.' };
  return { ok: true, tendered: g, change: posCents(g - t) };
}

/**
 * One unit's price at the till.
 *   item: { price, tiers: [{minQty, price}], minQty }
 *   mode: 'retail' (normal price) or 'wholesale' (bulk prices by quantity, when
 *         the store has them - bulkOn).
 */
function posUnitPrice(item, qty, mode, bulkOn) {
  var base = posCents(item && item.price);
  if (mode === 'wholesale' && bulkOn && item && item.tiers && item.tiers.length && typeof tierUnitPrice === 'function') {
    var p = tierUnitPrice(base, item.tiers, qty);
    return { unitPrice: p, bulk: p < base, normalPrice: base };
  }
  return { unitPrice: base, bulk: false, normalPrice: base };
}

/**
 * Prices a cart. The server runs exactly this on every sale.
 *   reqLines: [{ variantId, qty }]
 *   items:    { variantId: { price, tiers, minQty, name } }
 *   opts:     { mode, bulkOn, discount: {type:'percent'|'amount', value, note}, maxDiscountPct, taxPercent }
 * Returns { ok, lines, subtotal, discount, discountNote, total, tax, error?, errorCode? }.
 * Repeated varieties are merged (a bulk price counts the whole quantity).
 */
function posPriceCart(reqLines, items, opts) {
  opts = opts || {};
  var req = reqLines || [];
  if (!req.length) return { ok: false, error: 'Add at least one item.', errorCode: 'empty' };
  if (req.length > POS_CORE_LIMITS.maxLines) return { ok: false, error: 'A sale can have at most ' + POS_CORE_LIMITS.maxLines + ' lines.', errorCode: 'too_many' };
  var mode = opts.mode === 'wholesale' ? 'wholesale' : 'retail';
  var wanted = {}, order = [];
  for (var i = 0; i < req.length; i++) {
    var q = Number(req[i] && req[i].qty);
    var id = String((req[i] && req[i].variantId) || '');
    if (!id || !isFinite(q) || q < 1 || Math.floor(q) !== q || q > POS_CORE_LIMITS.maxQty) return { ok: false, error: 'Every item needs a whole quantity of 1 or more.', errorCode: 'qty' };
    if (!wanted[id]) { wanted[id] = 0; order.push(id); }
    wanted[id] += q;
  }
  var lines = [], subtotal = 0;
  for (var j = 0; j < order.length; j++) {
    var item = items[order[j]];
    if (!item) return { ok: false, error: 'One of the items is no longer available. Refresh and try again.', errorCode: 'unknown_item', variantId: order[j] };
    var qty = wanted[order[j]];
    if (!(Number(item.price) > 0)) return { ok: false, error: '"' + (item.name || 'An item') + '" has no price. Set its price in Products first.', errorCode: 'no_price', variantId: order[j] };
    if (mode === 'wholesale' && opts.bulkOn && Number(item.minQty) > 1 && qty < Number(item.minQty)) {
      return { ok: false, error: 'The wholesale minimum for "' + (item.name || 'this item') + '" is ' + item.minQty + '.', errorCode: 'min_qty', variantId: order[j] };
    }
    var up = posUnitPrice(item, qty, mode, opts.bulkOn);
    var lineTotal = posCents(qty * up.unitPrice);
    subtotal = posCents(subtotal + lineTotal);
    lines.push({ variantId: order[j], qty: qty, unitPrice: up.unitPrice, normalPrice: up.normalPrice, bulk: up.bulk, lineTotal: lineTotal });
  }
  var discount = 0, discountNote = '';
  var d = opts.discount;
  if (d && typeof d === 'object' && Number(d.value) > 0) {
    var dv = Number(d.value);
    var cap = Number(opts.maxDiscountPct) || 0;
    if (!isFinite(dv)) return { ok: false, error: 'The discount is not a number.', errorCode: 'discount' };
    discount = d.type === 'percent' ? posCents(subtotal * dv / 100) : posCents(dv);
    if (discount > posCents(subtotal * cap / 100) + 0.005) {
      return { ok: false, error: cap > 0 ? 'A discount can be at most ' + cap + '% of the sale.' : 'Discounts are switched off for this till.', errorCode: 'discount_cap', discount: discount };
    }
    if (discount >= subtotal) return { ok: false, error: 'The discount cannot be the whole sale.', errorCode: 'discount' };
    discountNote = String(d.note || '').trim().slice(0, 80) || (d.type === 'percent' ? dv + '% off' : 'Discount');
  }
  // Share the discount over the lines by value, so a refund can be worked out per line.
  var allocated = 0;
  lines.forEach(function (l, idx) {
    var share = idx === lines.length - 1 ? posCents(discount - allocated) : (subtotal > 0 ? posCents(discount * l.lineTotal / subtotal) : 0);
    allocated = posCents(allocated + share);
    l.lineDiscount = share;
    l.net = posCents(l.lineTotal - share);
  });
  var total = posCents(subtotal - discount);
  var taxPct = Number(opts.taxPercent) || 0;
  var tax = taxPct > 0 ? posCents(total * taxPct / (100 + taxPct)) : 0;
  return { ok: true, mode: mode, lines: lines, subtotal: subtotal, discount: discount, discountNote: discountNote, total: total, tax: tax, taxPercent: taxPct };
}

/** Sale references made by a till: 8-64 letters, digits, - or _. */
function posValidTxnId(id) { return /^[A-Za-z0-9_-]{8,64}$/.test(String(id || '')); }

/**
 * A receipt number a till can print while offline, unique per device:
 * R-YYYYMMDD-<device code>-<n>. Online sales get the server's own numbers.
 */
function posOfflineReceiptNo(day, deviceCode, n) {
  var code = String(deviceCode || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6) || 'TILL';
  return 'R-' + String(day || '').replace(/-/g, '') + '-' + code + '-' + (n < 1000 ? ('000' + n).slice(-4) : String(n));
}
function posValidReceiptNo(no) { return /^R-\d{8}-[A-Z0-9]{1,6}-\d{4,6}$/.test(String(no || '')); }

/** Barcodes are text: "0012345" stays "0012345". Spaces around it are dropped. */
function posCleanBarcode(raw) { return String(raw == null ? '' : raw).replace(/\s+/g, '').slice(0, 64); }

/**
 * Finds what a scan or a search means in a list of till items:
 *   exact barcode, then exact SKU (case-insensitive), then name / label / SKU / barcode contains.
 */
function posFindItems(items, query, limit) {
  var q = String(query || '').trim().toLowerCase();
  if (!q) return { exact: null, items: [] };
  var code = posCleanBarcode(query).toLowerCase();
  var exact = null, hits = [];
  (items || []).forEach(function (it) {
    var bc = String(it.barcode || '').toLowerCase(), sku = String(it.sku || '').toLowerCase();
    var name = String(it.name || '').toLowerCase(), label = String(it.label || '').toLowerCase();
    if (!exact && ((bc && bc === code) || (sku && sku === q))) exact = it;
    var rank = (bc && bc === code) || (sku && sku === q) ? 0 : name.indexOf(q) === 0 ? 1 :
      (name.indexOf(q) !== -1 || label.indexOf(q) !== -1 || (sku && sku.indexOf(q) !== -1) || (bc && bc.indexOf(code) !== -1)) ? 2 : -1;
    if (rank >= 0) hits.push({ rank: rank, it: it });
  });
  hits.sort(function (a, b) { return a.rank - b.rank || String(a.it.name).localeCompare(String(b.it.name)); });
  return { exact: exact, items: hits.slice(0, limit || 20).map(function (h) { return h.it; }) };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { POS_CORE_METHODS: POS_CORE_METHODS, POS_CORE_METHOD_LABEL: POS_CORE_METHOD_LABEL, POS_CORE_PAY_STATUS_LABEL: POS_CORE_PAY_STATUS_LABEL,
    POS_CORE_SALE_STATUS_LABEL: POS_CORE_SALE_STATUS_LABEL, POS_CORE_SYNC_LABEL: POS_CORE_SYNC_LABEL, POS_CORE_LIMITS: POS_CORE_LIMITS,
    posCents: posCents, posNormalizeMethod: posNormalizeMethod, posInitialPaymentStatus: posInitialPaymentStatus, posPaymentSummary: posPaymentSummary,
    posCashChange: posCashChange, posUnitPrice: posUnitPrice, posPriceCart: posPriceCart, posValidTxnId: posValidTxnId,
    posOfflineReceiptNo: posOfflineReceiptNo, posValidReceiptNo: posValidReceiptNo, posCleanBarcode: posCleanBarcode, posFindItems: posFindItems };
}
