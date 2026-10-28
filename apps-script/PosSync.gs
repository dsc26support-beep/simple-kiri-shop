/**
 * Mwakete POS - sync, cases, payments and voids (Oct 2026).
 * Design: docs/mwakete-pos-architecture.md. Behind Script Property POS_HUB.
 *
 * CHANGE LOG. Every stock movement (recordStockMovements, Inventory.gs) and
 * every product save adds rows to PosChanges with a per-store sequence number
 * (Seq: 1, 2, 3 ... with no gaps). A till keeps the last Seq it applied - its
 * cursor - and asks posChanges(since) for what it missed. If anything between
 * its cursor and now is missing (rows trimmed, a write that failed) the answer
 * is resync: true, and the till reloads its catalogue. A till never has to
 * trust that it saw every notice: the cursor is how it knows.
 *
 * Apps Script cannot push to browsers (no WebSockets or Server-Sent Events),
 * so tills poll. A poll with nothing new is answered from a Script Property
 * (the latest Seq) without reading any sheet.
 *
 * LOCKING. posAppendChanges must run inside the script lock: every caller of
 * recordStockMovements and the product save already holds it, which is what
 * keeps Seq numbers unique and in order.
 *
 * VALUES, NOT DELTAS. A stock change carries the new stock and held numbers
 * from the ledger, so applying one twice is harmless and the till never adds
 * up numbers of its own.
 */

var POS_CHANGE_HEADERS = ['Seq', 'OwnerId', 'Kind', 'VariantId', 'ProductId', 'StockQty', 'ReservedQty', 'Ref', 'CreatedAt'];
var POS_CASE_HEADERS = ['CaseId', 'OwnerId', 'Kind', 'SaleId', 'ReceiptNo', 'VariantId', 'Detail', 'Status', 'Resolution', 'ResolvedBy', 'ResolvedAt', 'DeviceId', 'CreatedAt'];
var POS_CHANGES_PAGE = 500;
var POS_UPLOAD_MAX = 20;
var POS_CASE_LABEL = {
  oversold: 'Sold more than Mwakete had in stock',
  price_differs: 'Till price differed from the current price',
  discount_over_cap: 'Discount above this till\'s limit',
  below_reserved: 'Sold stock that online orders were holding',
  min_qty: 'Sold below the wholesale minimum'
};

function posChangesSheet() { return hubSheet('PosChanges', POS_CHANGE_HEADERS); }
function posCasesSheet() { return hubSheet('PosCases', POS_CASE_HEADERS); }

function posFail(message, kind, extra) {
  var f = fail(message);
  f.errorKind = kind || 'invalid';
  if (extra) Object.keys(extra).forEach(function (k) { f[k] = extra[k]; });
  return f;
}

/* ==================== Sequence and change log ==================== */

function posSeqKey(ownerId) { return 'POSSEQ_' + ownerId; }

function posLatestSeq(ownerId) {
  var n = Number(PropertiesService.getScriptProperties().getProperty(posSeqKey(ownerId)));
  return isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * Adds changes for one store. Caller holds the script lock. Never throws: a
 * failed write still moves the counter on, which leaves a gap that tells every
 * till to reload rather than silently miss the change.
 */
function posAppendChanges(ownerId, changes) {
  if (!ownerId || !changes || !changes.length) return;
  var props = PropertiesService.getScriptProperties();
  var start = posLatestSeq(ownerId) + 1;
  var last = start + changes.length - 1;
  try {
    var sheet = posChangesSheet();
    var headers = getHeaders(sheet);
    var now = nowIso();
    var rows = changes.map(function (c, i) {
      var row = { Seq: start + i, OwnerId: ownerId, Kind: c.Kind, VariantId: c.VariantId || '', ProductId: c.ProductId || '',
        StockQty: c.StockQty === undefined ? '' : c.StockQty, ReservedQty: c.ReservedQty === undefined ? '' : c.ReservedQty, Ref: String(c.Ref || '').slice(0, 80), CreatedAt: now };
      return headers.map(function (h) { return row[h] === undefined ? '' : sanitizeForSheetCell(row[h]); });
    });
    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, headers.length).setValues(rows);
  } catch (e) {
    Logger.log('posAppendChanges failed (tills will resync): ' + e);
  }
  props.setProperty(posSeqKey(ownerId), String(last));
}

/** Called by recordStockMovements with the ledger rows it just wrote. */
function posEmitStockMovements(movements) {
  if (!posHubEnabled() || !movements || !movements.length) return;
  var byOwner = {};
  movements.forEach(function (m) {
    if (!m || !m.OwnerId || !m.VariantId) return;
    (byOwner[m.OwnerId] = byOwner[m.OwnerId] || []).push({ Kind: 'stock', VariantId: m.VariantId, ProductId: m.ProductId,
      StockQty: m.NewStock === '' || m.NewStock === undefined ? undefined : Number(m.NewStock),
      ReservedQty: m.NewReserved === '' || m.NewReserved === undefined ? undefined : Number(m.NewReserved),
      Ref: String(m.MovementType || '') + ':' + String(m.ReferenceId || '') });
  });
  Object.keys(byOwner).forEach(function (o) { posAppendChanges(o, byOwner[o]); });
}

/** A product, price or variant was saved: tills re-read that product. */
function posEmitCatalogChange(ownerId, productId) {
  if (!posHubEnabled() || !ownerId) return;
  posAppendChanges(ownerId, [{ Kind: 'catalog', ProductId: productId || '', Ref: 'product' }]);
}

/** A sale, void, refund or payment confirmation: other tills refresh their sales list. */
function posEmitSaleChange(ownerId, saleId, what) {
  posAppendChanges(ownerId, [{ Kind: 'sale', Ref: String(what || 'sale') + ':' + saleId }]);
}

/* ==================== Actors and permissions ==================== */

/**
 * Who is acting. Until a till registers staff (docs/mwakete-pos-architecture.md,
 * staff PINs), everything is the store owner.
 */
function posOwnerActor(owner) {
  return { role: 'owner', id: owner.OwnerId, name: (owner.StoreName || 'Owner') + ' (owner)', deviceId: '' };
}

var POS_ROLE_PERMS = {
  owner: ['sell', 'discount', 'override_price', 'credit_sale', 'refund', 'void', 'confirm_payment', 'receive_stock', 'adjust_stock',
    'edit_products', 'view_costs', 'view_reports', 'resolve_cases', 'manage_staff', 'manage_devices', 'manage_settings', 'manage_shift'],
  manager: ['sell', 'discount', 'override_price', 'credit_sale', 'refund', 'void', 'confirm_payment', 'receive_stock', 'adjust_stock',
    'edit_products', 'view_costs', 'view_reports', 'resolve_cases', 'manage_shift'],
  cashier: ['sell', 'discount', 'manage_shift'],
  inventory: ['receive_stock', 'adjust_stock', 'edit_products', 'view_costs'],
  reports: ['view_reports']
};
var POS_ROLE_LABEL = { owner: 'Owner', manager: 'Manager', cashier: 'Cashier', inventory: 'Inventory Manager', reports: 'Reports (read only)' };

function posCan(actor, perm) {
  var perms = POS_ROLE_PERMS[(actor && actor.role) || ''] || [];
  return perms.indexOf(perm) !== -1;
}

function posDenied(actor, perm) {
  return posFail('Your role (' + (POS_ROLE_LABEL[actor && actor.role] || 'unknown') + ') cannot do that. Ask a manager or the owner.', 'forbidden', { needs: perm });
}

/* ==================== Catalogue and changes ==================== */

function posItemOf(v, p, bulkOn, showCost) {
  var tracked = isStockTracked(v);
  var item = { variantId: v.VariantId, productId: v.ProductId, name: p ? p.Name : '', label: v.Label || '', sku: String(v.SKU || ''),
    barcode: posCleanBarcode(v.Barcode), price: roundMoney(Number(v.Price) || 0), tiers: bulkOn ? priceTiersOf(v) : [], minQty: bulkOn ? minOrderQtyOf(v) : 1,
    tracked: tracked, stock: tracked ? physicalOf(v) : null, reserved: tracked ? reservedOf(v) : 0, available: tracked ? availableOf(v) : null,
    health: stockHealthOf(v), reorderLevel: v.ReorderLevel === '' || v.ReorderLevel === undefined ? null : Number(v.ReorderLevel),
    active: v.Status === 'active' && !!p && p.Status !== 'archived' && p.Status !== 'deleted',
    category: p ? (p.CategoryId || '') : '', image: p ? (p.ImageUrl || '') : '' };
  if (showCost) item.costPrice = v.CostPrice === '' || v.CostPrice === undefined ? null : Number(v.CostPrice);
  return item;
}

/** Everything a till needs to sell offline. body: productIds? (only those). */
function actionPosCatalog(owner, body, actor) {
  if (!posHubEnabled()) return hubOff();
  actor = actor || posOwnerActor(owner);
  // The cursor is read FIRST: anything that changes while the catalogue is
  // being read is also in the changes after this cursor, and changes carry
  // values, so seeing it twice is harmless.
  var cursor = posLatestSeq(owner.OwnerId);
  var only = Array.isArray(body && body.productIds) ? body.productIds.map(String).slice(0, 200) : null;
  var sheet = getSheet('Variants');
  ensureInventoryColumns(sheet);
  var products = {};
  sheetToObjects(getSheet('Products')).forEach(function (p) { if (p.OwnerId === owner.OwnerId && p.Status !== 'deleted') products[p.ProductId] = p; });
  var bulkOn = bulkPricingOn(owner);
  var showCost = posCan(actor, 'view_costs');
  var items = sheetToObjects(sheet).filter(function (v) {
    return v.OwnerId === owner.OwnerId && products[v.ProductId] && (!only || only.indexOf(String(v.ProductId)) !== -1);
  }).map(function (v) { return posItemOf(v, products[v.ProductId], bulkOn, showCost); });
  return ok({ items: items, partial: !!only, productIds: only || undefined, cursor: cursor, bulkOn: bulkOn, settings: posSettingsOf(owner),
    store: { name: owner.StoreName || '', phone: owner.Phone || '', island: owner.Island || '', village: owner.Village || '', bulkSeller: isBulkSeller(owner) },
    methods: POS_CORE_METHODS.map(function (m) { return { id: m, label: POS_CORE_METHOD_LABEL[m], verify: posInitialPaymentStatus(m) === 'pending_verification' }; }),
    actor: { role: actor.role, name: actor.name, perms: POS_ROLE_PERMS[actor.role] || [] }, serverTime: nowIso() });
}

/**
 * body: since (the till's cursor). Answers { changes, latest, more } or
 * { resync: true, latest } when the till must reload its catalogue.
 */
function actionPosChanges(owner, body) {
  if (!posHubEnabled()) return hubOff();
  var since = Math.floor(Number(body && body.since));
  var latest = posLatestSeq(owner.OwnerId);
  if (!isFinite(since) || since < 0 || since > latest) return ok({ resync: true, latest: latest, reason: 'cursor', serverTime: nowIso() });
  if (since === latest) return ok({ changes: [], latest: latest, more: false, serverTime: nowIso() });
  var rows = hubRows('PosChanges').filter(function (r) { return r.OwnerId === owner.OwnerId && Number(r.Seq) > since; })
    .sort(function (a, b) { return Number(a.Seq) - Number(b.Seq); });
  // No gaps allowed: the first row must be since + 1, and each next one + 1.
  var expect = since + 1;
  var out = [];
  for (var i = 0; i < rows.length && out.length < POS_CHANGES_PAGE; i++) {
    if (Number(rows[i].Seq) !== expect) return ok({ resync: true, latest: latest, reason: 'gap', serverTime: nowIso() });
    out.push({ seq: Number(rows[i].Seq), kind: rows[i].Kind, variantId: rows[i].VariantId || undefined, productId: rows[i].ProductId || undefined,
      stock: rows[i].StockQty === '' ? undefined : Number(rows[i].StockQty), reserved: rows[i].ReservedQty === '' ? undefined : Number(rows[i].ReservedQty),
      ref: rows[i].Ref || undefined, at: rows[i].CreatedAt });
    expect++;
  }
  if (!out.length) return ok({ resync: true, latest: latest, reason: 'gap', serverTime: nowIso() });
  var lastSeq = out[out.length - 1].seq;
  return ok({ changes: out, latest: latest, more: lastSeq < latest, serverTime: nowIso() });
}

/**
 * Trims change rows older than POS_CHANGES_KEEP_DAYS (default 14). A till
 * that was away longer just reloads. Wire to the daily sweep.
 */
function trimPosChanges() {
  var sheet = SpreadsheetApp.getActive().getSheetByName('PosChanges');
  if (!sheet || sheet.getLastRow() < 2) return 0;
  var days = Number(PropertiesService.getScriptProperties().getProperty('POS_CHANGES_KEEP_DAYS')) || 14;
  var cutoff = new Date(Date.now() - days * 86400000).toISOString();
  var rows = sheetToObjects(sheet);
  var keep = 0;
  while (keep < rows.length && String(rows[keep].CreatedAt) < cutoff) keep++;
  if (keep > 0) sheet.deleteRows(2, keep);
  return keep;
}

/* ==================== Cases (things a person must look at) ==================== */

function posOpenCase(ownerId, kind, sale, variantId, detail, deviceId) {
  var id = newId('pcase');
  appendRowFromObject(posCasesSheet(), { CaseId: id, OwnerId: ownerId, Kind: kind, SaleId: sale ? sale.saleId : '', ReceiptNo: sale ? sale.receiptNo : '',
    VariantId: variantId || '', Detail: String(detail || '').slice(0, 300), Status: 'open', Resolution: '', ResolvedBy: '', ResolvedAt: '', DeviceId: deviceId || '', CreatedAt: nowIso() });
  return { caseId: id, kind: kind, label: POS_CASE_LABEL[kind] || kind, detail: String(detail || '').slice(0, 300) };
}

function posCaseView(c) {
  return { caseId: c.CaseId, kind: c.Kind, label: POS_CASE_LABEL[c.Kind] || c.Kind, saleId: c.SaleId, receiptNo: c.ReceiptNo, variantId: c.VariantId,
    detail: c.Detail, status: c.Status, resolution: c.Resolution || '', resolvedBy: c.ResolvedBy || '', resolvedAt: c.ResolvedAt || '', createdAt: c.CreatedAt };
}

/** body: status? ('open' default, 'resolved', 'all') */
function actionPosListCases(owner, body, actor) {
  if (!posHubEnabled()) return hubOff();
  var want = String((body && body.status) || 'open');
  var list = hubRows('PosCases').filter(function (c) { return c.OwnerId === owner.OwnerId && (want === 'all' || c.Status === want); })
    .sort(function (a, b) { return String(b.CreatedAt).localeCompare(String(a.CreatedAt)); });
  return ok({ cases: list.slice(0, 200).map(posCaseView), open: hubRows('PosCases').filter(function (c) { return c.OwnerId === owner.OwnerId && c.Status === 'open'; }).length });
}

/** body: caseId, resolution (what was done, e.g. "counted shelf: 3 left, adjusted"). */
function actionPosResolveCase(owner, body, actor) {
  if (!posHubEnabled()) return hubOff();
  actor = actor || posOwnerActor(owner);
  if (!posCan(actor, 'resolve_cases')) return posDenied(actor, 'resolve_cases');
  var note = String((body && body.resolution) || '').trim().slice(0, 200);
  if (note.length < 3) return posFail('Write what was done, e.g. "counted the shelf and adjusted stock".');
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sheet = posCasesSheet();
    var c = findRowById(sheet, 'CaseId', String(body.caseId || ''));
    if (!c || c.OwnerId !== owner.OwnerId) return posFail('That case was not found.');
    if (c.Status === 'resolved') return ok({ 'case': posCaseView(c), replayed: true });
    updateRowFromObject(sheet, c.__row, { Status: 'resolved', Resolution: note, ResolvedBy: actor.name, ResolvedAt: nowIso() });
    appendAudit({ actorId: actor.id, actorRole: 'pos_' + actor.role, action: 'POS_CASE_RESOLVED', entityType: 'pos_case', entityId: c.CaseId, reason: note });
    return ok({ 'case': posCaseView(findRowById(sheet, 'CaseId', c.CaseId)) });
  } finally {
    lock.releaseLock();
  }
}

/* ==================== Upload and lookup ==================== */

/**
 * Did these sales reach Mwakete? For a till that lost the answer to a sale:
 * it asks before sending again (it would be safe anyway - same clientTxnId -
 * but this lets it show the truth). body: clientTxnIds (up to 50).
 */
function actionPosLookupTxns(owner, body) {
  if (!posHubEnabled()) return hubOff();
  var ids = (Array.isArray(body && body.clientTxnIds) ? body.clientTxnIds : []).map(String).filter(posValidTxnId).slice(0, 50);
  var want = {};
  ids.forEach(function (i) { want[i] = true; });
  var found = {};
  hubRows('PosSales').forEach(function (s) {
    if (s.OwnerId === owner.OwnerId && want[s.ClientTxnId]) {
      found[s.ClientTxnId] = { saleId: s.SaleId, receiptNo: s.ReceiptNo, status: s.Status, paymentStatus: s.PaymentStatus };
    }
  });
  return ok({ found: found, missing: ids.filter(function (i) { return !found[i]; }) });
}

/**
 * A till sends the sales it saved (offline, or whose answer it never got).
 * body: sales [ checkout bodies, each with its own clientTxnId ] (up to 20).
 * Each is checked and committed on its own; the answer says what happened to
 * each, so the till can mark it synchronised, retry later, or show a problem.
 */
function actionPosUploadSales(owner, body, actor) {
  if (!posHubEnabled()) return hubOff();
  actor = actor || posOwnerActor(owner);
  var list = Array.isArray(body && body.sales) ? body.sales : [];
  if (!list.length) return posFail('Nothing to send.');
  if (list.length > POS_UPLOAD_MAX) return posFail('Send at most ' + POS_UPLOAD_MAX + ' sales at a time.');
  var results = list.map(function (s) {
    var r = posCheckoutCore(owner, s || {}, actor);
    var id = s && s.clientTxnId;
    if (r.ok) return { clientTxnId: id, ok: true, saleId: r.sale.saleId, receiptNo: r.sale.receiptNo, replayed: !!r.replayed, cases: r.cases || [], sale: r.sale };
    return { clientTxnId: id, ok: false, error: r.error, errorKind: r.errorKind || 'invalid' };
  });
  return ok({ results: results, cursor: posLatestSeq(owner.OwnerId) });
}

/* ==================== Payments that wait for confirmation ==================== */

/** body: saleId, paymentId?, outcome ('confirmed' | 'failed'), note? */
function actionPosConfirmPayment(owner, body, actor) {
  if (!posHubEnabled()) return hubOff();
  actor = actor || posOwnerActor(owner);
  if (!posCan(actor, 'confirm_payment')) return posDenied(actor, 'confirm_payment');
  var outcome = String((body && body.outcome) || '');
  if (outcome !== 'confirmed' && outcome !== 'failed') return posFail('Choose whether the money arrived or not.');
  var note = String(body.note || '').trim().slice(0, 120);
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sales = posSalesSheet();
    var sale = findRowById(sales, 'SaleId', String(body.saleId || ''));
    if (!sale || sale.OwnerId !== owner.OwnerId) return posFail('That sale was not found.');
    var paySheet = posPaymentsSheet();
    ['VerifiedBy', 'VerifiedAt', 'VerifyNote'].forEach(function (h) { ensureColumn(paySheet, h); });
    var pays = sheetToObjects(paySheet).filter(function (p) { return p.SaleId === sale.SaleId; });
    var target = pays.filter(function (p) { return (!body.paymentId || p.PaymentId === String(body.paymentId)) && p.Status === 'pending_verification'; })[0];
    if (!target) return posFail('There is no payment waiting for confirmation on that sale.');
    updateRowFromObject(paySheet, target.__row, { Status: outcome === 'confirmed' ? 'paid' : 'failed', VerifiedBy: actor.name, VerifiedAt: nowIso(), VerifyNote: note });
    var fresh = sheetToObjects(paySheet).filter(function (p) { return p.SaleId === sale.SaleId; });
    var sum = posPaymentSummary(sale.Total, fresh.map(function (p) { return { amount: p.Amount, status: p.Status }; }));
    updateRowFromObject(sales, sale.__row, { PaymentStatus: sum.status, UpdatedAt: nowIso() });
    appendAudit({ actorId: actor.id, actorRole: 'pos_' + actor.role, action: outcome === 'confirmed' ? 'POS_PAYMENT_CONFIRMED' : 'POS_PAYMENT_FAILED',
      entityType: 'pos_sale', entityId: sale.SaleId, next: target.Method + ' ' + target.Amount, reason: note });
    posEmitSaleChange(owner.OwnerId, sale.SaleId, 'payment');
    var parts = posSaleParts(sale.SaleId);
    return ok({ sale: posSaleView(findRowById(sales, 'SaleId', sale.SaleId), parts.lines, parts.payments, parts.refunds) });
  } finally {
    lock.releaseLock();
  }
}

/** Sales with an IB or MPaisa payment still waiting. */
function actionPosPendingPayments(owner, body, actor) {
  if (!posHubEnabled()) return hubOff();
  var pays = hubRows('PosPayments').filter(function (p) { return p.OwnerId === owner.OwnerId && p.Status === 'pending_verification'; });
  var sales = {};
  hubRows('PosSales').forEach(function (s) { if (s.OwnerId === owner.OwnerId) sales[s.SaleId] = s; });
  return ok({ payments: pays.map(function (p) {
    var s = sales[p.SaleId] || {};
    return { paymentId: p.PaymentId, saleId: p.SaleId, receiptNo: s.ReceiptNo || '', method: p.Method, methodLabel: POS_CORE_METHOD_LABEL[p.Method] || p.Method,
      amount: Number(p.Amount) || 0, reference: p.Reference || '', createdAt: p.CreatedAt, staffName: s.StaffName || '' };
  }).sort(function (a, b) { return String(b.createdAt).localeCompare(String(a.createdAt)); }) });
}

/* ==================== Voids ==================== */

/**
 * Cancels a whole sale on the day it was made: every tracked item goes back
 * into stock, paid money is marked refunded (hand it back), and payments still
 * waiting are marked failed. The sale itself is never edited or deleted - it
 * stays, marked voided, with who, when and why.
 * body: saleId, requestId, reason
 */
function actionPosVoidSale(owner, body, actor) {
  if (!posHubEnabled()) return hubOff();
  actor = actor || posOwnerActor(owner);
  if (!posCan(actor, 'void')) return posDenied(actor, 'void');
  var requestId = cleanRequestId(body && body.requestId);
  if (!requestId) return posFail('This void has no reference number. Reload the page and try again.');
  var reason = String(body.reason || '').trim().slice(0, 120);
  if (reason.length < 3) return posFail('Say why the sale is being voided.');
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sheet = posSalesSheet();
    var sale = findRowById(sheet, 'SaleId', String(body.saleId || ''));
    if (!sale || sale.OwnerId !== owner.OwnerId) return posFail('That sale was not found.');
    if (sale.Status === 'voided') {
      var p0 = posSaleParts(sale.SaleId);
      return ok({ sale: posSaleView(sale, p0.lines, p0.payments, p0.refunds), replayed: sale.VoidRequestId === requestId });
    }
    if (sale.Status !== 'completed' || (Number(sale.RefundedAmount) || 0) > 0) return posFail('Only a sale with no refunds can be voided. Use a refund instead.');
    if (posLocalDay(Date.parse(sale.CreatedAt)) !== posLocalDay(Date.now())) return posFail('A sale can only be voided on the day it was made. Use a refund instead.');
    var ctx = hubStockContext(owner);
    var lines = hubRows('PosSaleLines').filter(function (l) { return l.SaleId === sale.SaleId; });
    lines.forEach(function (l) {
      if (l.TrackedStock !== 'yes') return;
      var v = ctx.byId[l.VariantId];
      if (v) applyStockDelta(owner, v, sale.LocationId, Number(l.Qty), 'RETURN', 'pos', sale.SaleId, 'POS void of ' + sale.ReceiptNo, { fact: true, userId: actor.id });
    });
    var paySheet = posPaymentsSheet();
    sheetToObjects(paySheet).filter(function (p) { return p.SaleId === sale.SaleId; }).forEach(function (p) {
      var next = p.Status === 'pending_verification' ? 'failed' : (p.Status === 'paid' || p.Status === 'received' || p.Status === 'recorded_unverified') ? 'refunded' : p.Status;
      if (next !== p.Status) updateRowFromObject(paySheet, p.__row, { Status: next });
    });
    ['VoidedAt', 'VoidedBy', 'VoidReason', 'VoidRequestId'].forEach(function (h) { ensureColumn(sheet, h); });
    var paid = hubRows('PosPayments').filter(function (p) { return p.SaleId === sale.SaleId && p.Status === 'refunded'; }).length > 0;
    updateRowFromObject(sheet, sale.__row, { Status: 'voided', PaymentStatus: paid ? 'refunded' : 'failed', VoidedAt: nowIso(), VoidedBy: actor.name, VoidReason: reason,
      VoidRequestId: requestId, UpdatedAt: nowIso() });
    appendAudit({ actorId: actor.id, actorRole: 'pos_' + actor.role, action: 'POS_VOID', entityType: 'pos_sale', entityId: sale.SaleId, next: sale.ReceiptNo + ' ' + sale.Total, reason: reason });
    invalidateCache([storeProductsCacheKey(owner.StoreSlug)]);
    posEmitSaleChange(owner.OwnerId, sale.SaleId, 'void');
    var parts = posSaleParts(sale.SaleId);
    return ok({ sale: posSaleView(findRowById(sheet, 'SaleId', sale.SaleId), parts.lines, parts.payments, parts.refunds),
      note: paid ? 'Voided. Give the customer their money back.' : 'Voided.' });
  } finally {
    lock.releaseLock();
  }
}
