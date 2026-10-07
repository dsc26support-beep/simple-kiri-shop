/**
 * Mwakete Inventory - core stock model and ledger.
 *
 * The stock record is the existing Variants row (one per sellable variety),
 * which is the seller's default location. Owner-approved additive columns:
 *   StockQty     - PHYSICAL stock on hand (blank = not tracked / unlimited,
 *                  exactly as before)
 *   ReservedQty  - units held by open orders, not yet handed over
 *   Barcode, ReorderLevel, ReorderQty, CostPrice, ExternalId, LastSyncedAt
 * available = StockQty - ReservedQty, never below 0.
 *
 * Every change to StockQty or ReservedQty is written to the StockMovements
 * ledger (created on first use), so stock is never changed silently.
 *
 * Orders (owner decision: reserve, then deduct):
 *   placed (Pending Payment / Paid) -> reserved   ORDER_RESERVED
 *   Fulfilled                       -> sold       SALE (physical goes down)
 *   Cancelled                       -> released   ORDER_RELEASED, or RETURN
 *                                                 if it had been fulfilled
 * Orders placed before this existed took their stock at checkout, so an
 * order with no ledger rows counts as already 'sold' - cancelling it now
 * gives the stock back, which fixes the old "cancel loses stock" gap.
 */

var INVENTORY_VARIANT_COLUMNS = ['ReservedQty', 'Barcode', 'ReorderLevel', 'ReorderQty', 'CostPrice', 'ExternalId', 'LastSyncedAt'];
var STOCK_MOVEMENT_HEADERS = ['MovementId', 'OwnerId', 'ProductId', 'VariantId', 'LocationId', 'Quantity', 'MovementType',
  'PreviousStock', 'NewStock', 'PreviousReserved', 'NewReserved', 'Source', 'ReferenceId', 'UserId', 'Notes', 'CreatedAt'];
var MOVEMENT_TYPES = ['INITIAL_STOCK', 'STOCK_RECEIVED', 'SALE', 'ORDER_RESERVED', 'ORDER_RELEASED', 'RETURN', 'DAMAGED',
  'EXPIRED', 'MANUAL_ADJUSTMENT', 'STOCK_TRANSFER', 'EXTERNAL_SYNC', 'SYNC_CORRECTION'];
var DEFAULT_LOCATION_ID = 'default';

/* ==================== Sheets ==================== */

/**
 * Adds the inventory columns to Variants once. Must run before any write of
 * ReservedQty: updateRowFromObject silently drops a field with no header, and
 * a dropped reservation would let two orders sell the same last unit.
 */
function ensureInventoryColumns(variantsSheet) {
  var cache = CacheService.getScriptCache();
  if (cache.get('v1:inventoryColumns')) return;
  INVENTORY_VARIANT_COLUMNS.forEach(function (c) { ensureColumn(variantsSheet, c); });
  try { cache.put('v1:inventoryColumns', '1', 21600); } catch (e) { /* best effort */ }
}

function getStockMovementsSheet() {
  var ss = SpreadsheetApp.getActive();
  var sheet = ss.getSheetByName('StockMovements');
  if (sheet) return sheet;
  sheet = ss.insertSheet('StockMovements');
  sheet.getRange(1, 1, 1, STOCK_MOVEMENT_HEADERS.length).setValues([STOCK_MOVEMENT_HEADERS]);
  return sheet;
}

/** Appends ledger rows in one write. Each item uses STOCK_MOVEMENT_HEADERS keys (MovementId/CreatedAt filled in). */
function recordStockMovements(movements) {
  if (!movements || !movements.length) return;
  var sheet = getStockMovementsSheet();
  var headers = getHeaders(sheet);
  var now = nowIso();
  var rows = movements.map(function (m) {
    m.MovementId = m.MovementId || newId('mov');
    m.CreatedAt = m.CreatedAt || now;
    m.LocationId = m.LocationId || DEFAULT_LOCATION_ID;
    return headers.map(function (h) { return m[h] === undefined ? '' : sanitizeForSheetCell(m[h]); });
  });
  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, headers.length).setValues(rows);
}

/* ==================== Stock maths (pure) ==================== */

function isStockTracked(v) {
  return v.StockQty !== '' && v.StockQty !== undefined && v.StockQty !== null;
}

function physicalOf(v) { return Math.max(0, Math.floor(Number(v.StockQty) || 0)); }
function reservedOf(v) { return Math.max(0, Math.floor(Number(v.ReservedQty) || 0)); }

/** Sellable units; null when not tracked (unlimited). */
function availableOf(v) {
  if (!isStockTracked(v)) return null;
  return Math.max(0, physicalOf(v) - reservedOf(v));
}

/** 'healthy' | 'low' | 'out' | 'untracked' - for the seller's stock-health colours. */
function stockHealthOf(v) {
  var a = availableOf(v);
  if (a === null) return 'untracked';
  if (a <= 0) return 'out';
  var level = Number(v.ReorderLevel);
  if (v.ReorderLevel !== '' && v.ReorderLevel != null && !isNaN(level) && a <= level) return 'low';
  return 'healthy';
}

/* ==================== Orders (pure state machine) ==================== */

var ORDER_STOCK_TARGET = { 'Pending Payment': 'reserved', 'Paid': 'reserved', 'Fulfilled': 'sold', 'Cancelled': 'released' };

/**
 * Where an order's stock currently stands, from its own ledger rows (oldest
 * first). No rows = placed before inventory existed = stock already taken.
 */
function orderStockState(movementsForOrder) {
  var state = 'sold';
  (movementsForOrder || []).forEach(function (m) {
    if (m.MovementType === 'ORDER_RESERVED') state = 'reserved';
    else if (m.MovementType === 'SALE') state = 'sold';
    else if (m.MovementType === 'ORDER_RELEASED' || m.MovementType === 'RETURN') state = 'released';
  });
  return state;
}

/**
 * Pure: the stock changes for moving an order's items from one state to
 * another. items: [{variantId, productId, qty, label}]; variantsById: live
 * rows. Returns { ok:true, updates:[{variant, StockQty, ReservedQty}],
 * movements:[...] } or { ok:false, error } when it would take more than is
 * available - nothing is applied in that case.
 */
function planOrderStockChange(fromState, toState, items, variantsById, ctx) {
  if (fromState === toState) return { ok: true, updates: [], movements: [] };
  // physical delta, reserved delta, movement type, and whether it consumes availability
  var table = {
    'reserved>sold': [-1, -1, 'SALE', false],
    'reserved>released': [0, -1, 'ORDER_RELEASED', false],
    'sold>reserved': [1, 1, 'ORDER_RESERVED', false],
    'sold>released': [1, 0, 'RETURN', false],
    'released>reserved': [0, 1, 'ORDER_RESERVED', true],
    'released>sold': [-1, 0, 'SALE', true]
  };
  var rule = table[fromState + '>' + toState];
  if (!rule) return { ok: false, error: 'Unknown stock change.' };

  // Work on running copies so two lines of the same variety add up.
  var working = {};
  var updates = [];
  var movements = [];
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    var v = variantsById[it.variantId];
    if (!v || !isStockTracked(v)) continue;
    var w = working[it.variantId] || (working[it.variantId] = { variant: v, P: physicalOf(v), R: reservedOf(v) });
    var q = Math.max(1, Math.floor(Number(it.qty) || 1));
    if (rule[3] && w.P - w.R < q) {
      return { ok: false, error: 'Only ' + Math.max(0, w.P - w.R) + ' of ' + (it.label || 'an item') + ' available - not enough to reopen this order.' };
    }
    var prevP = w.P, prevR = w.R;
    w.P = Math.max(0, w.P + rule[0] * q);
    w.R = Math.max(0, w.R + rule[1] * q);
    movements.push({
      OwnerId: v.OwnerId, ProductId: v.ProductId, VariantId: v.VariantId,
      Quantity: (rule[0] || rule[1]) < 0 ? -q : q, MovementType: rule[2],
      PreviousStock: prevP, NewStock: w.P, PreviousReserved: prevR, NewReserved: w.R,
      Source: (ctx && ctx.source) || 'order', ReferenceId: (ctx && ctx.orderId) || '', UserId: (ctx && ctx.userId) || '',
      Notes: (ctx && ctx.notes) || ''
    });
  }
  Object.keys(working).forEach(function (id) {
    updates.push({ variant: working[id].variant, StockQty: working[id].P, ReservedQty: working[id].R });
  });
  return { ok: true, updates: updates, movements: movements };
}

/**
 * Applies an order status change to stock. Call inside the script lock, before
 * the status itself is written; returns fail() (and changes nothing) when the
 * change would oversell.
 */
function applyOrderStatusStock(owner, order, newStatus) {
  var toState = ORDER_STOCK_TARGET[newStatus];
  if (!toState) return ok({});
  var items = [];
  try { items = JSON.parse(order.ItemsJson || '[]'); } catch (e) { items = []; }
  if (!items.length) return ok({});

  var ledgerSheet = SpreadsheetApp.getActive().getSheetByName('StockMovements');
  var mine = ledgerSheet ? sheetToObjects(ledgerSheet).filter(function (m) { return m.ReferenceId === order.OrderId; }) : [];
  var fromState = orderStockState(mine);
  if (fromState === toState) return ok({});

  var variantsSheet = getSheet('Variants');
  ensureInventoryColumns(variantsSheet);
  var byId = {};
  sheetToObjects(variantsSheet).forEach(function (v) { if (v.OwnerId === owner.OwnerId) byId[v.VariantId] = v; });
  var plan = planOrderStockChange(fromState, toState, items, byId,
    { orderId: order.OrderId, userId: owner.OwnerId, source: 'order', notes: 'Order ' + order.OrderId + ' -> ' + newStatus });
  if (!plan.ok) return fail(plan.error);
  plan.updates.forEach(function (u) {
    updateRowFromObject(variantsSheet, u.variant.__row, { StockQty: u.StockQty, ReservedQty: u.ReservedQty });
  });
  recordStockMovements(plan.movements);
  if (plan.updates.length) invalidateCache([storeProductsCacheKey(order.StoreSlug)]);
  return ok({});
}

/* ==================== Product form (Products.gs actionCreateOrUpdateProduct) ==================== */

/** Pure: an error message when the form sets a variety's stock below its reserved units, else ''. */
function stockBelowReservedError(owner, incomingVariants, allVariants) {
  var list = Array.isArray(incomingVariants) ? incomingVariants : [];
  for (var i = 0; i < list.length; i++) {
    var v = list[i];
    if (!v || !v.variantId || v.stockQty === undefined) continue;
    var row = allVariants.filter(function (r) { return r.VariantId === v.variantId && r.OwnerId === owner.OwnerId; })[0];
    if (!row) continue;
    var next = stockQtyOf(v.stockQty);
    var held = reservedOf(row);
    if (next !== '' && held > 0 && next < held) {
      return held + ' of ' + (v.label || row.Label) + ' are held by open orders, so stock can\'t go below ' + held +
        '. Fulfil or cancel those orders first.';
    }
  }
  return '';
}

/** Pure: the ledger row for a stock change made on the product form, or null when stock didn't change. */
function productFormStockMove(before, newStock, userId) {
  var was = isStockTracked(before) ? physicalOf(before) : '';
  if (String(was) === String(newStock)) return null;
  var from = was === '' ? 0 : was;
  var to = newStock === '' ? 0 : Number(newStock);
  return {
    OwnerId: before.OwnerId, ProductId: before.ProductId, VariantId: before.VariantId,
    Quantity: to - from, MovementType: was === '' ? 'INITIAL_STOCK' : 'MANUAL_ADJUSTMENT',
    PreviousStock: was === '' ? '' : from, NewStock: newStock, PreviousReserved: reservedOf(before), NewReserved: reservedOf(before),
    Source: 'product form', UserId: userId,
    Notes: newStock === '' ? 'Stock tracking turned off' : (was === '' ? 'Stock tracking turned on' : 'Edited on the product form')
  };
}

/* ==================== Seller inventory actions ==================== */

var ADJUST_REASONS = { count: 'MANUAL_ADJUSTMENT', damaged: 'DAMAGED', expired: 'EXPIRED', returned: 'RETURN' };

/**
 * Same request id twice (a double tap, or a retry after a dropped
 * connection whose first attempt actually landed) is answered from cache
 * instead of moving stock twice.
 */
function inventoryReplay(owner, requestId) {
  if (!requestId) return null;
  var hit = CacheService.getScriptCache().get('v1:invreq:' + owner.OwnerId + ':' + requestId);
  if (!hit) return null;
  try { return JSON.parse(hit); } catch (e) { return null; }
}

function inventoryRemember(owner, requestId, result) {
  if (!requestId) return;
  try { CacheService.getScriptCache().put('v1:invreq:' + owner.OwnerId + ':' + requestId, JSON.stringify(result), 1800); } catch (e) { /* best effort */ }
}

/** Public-to-the-seller shape of one stock record. */
function inventoryItemOf(v, product) {
  var tracked = isStockTracked(v);
  return {
    variantId: v.VariantId, productId: v.ProductId,
    productName: product ? product.Name : '', label: v.Label, productStatus: product ? product.Status : '',
    sku: v.SKU || '', barcode: v.Barcode || '', price: Number(v.Price) || 0,
    costPrice: v.CostPrice === '' || v.CostPrice == null ? null : Number(v.CostPrice),
    tracked: tracked,
    physical: tracked ? physicalOf(v) : null, reserved: reservedOf(v), available: availableOf(v),
    reorderLevel: v.ReorderLevel === '' || v.ReorderLevel == null ? null : Number(v.ReorderLevel),
    reorderQty: v.ReorderQty === '' || v.ReorderQty == null ? null : Number(v.ReorderQty),
    health: stockHealthOf(v)
  };
}

/** Pure: the dashboard counts for a list of inventoryItemOf items. */
function inventorySummary(items) {
  var tracked = items.filter(function (i) { return i.tracked; });
  var value = tracked.reduce(function (s, i) { return s + (i.costPrice == null ? 0 : i.costPrice * i.physical); }, 0);
  return {
    varieties: items.length,
    tracked: tracked.length,
    low: items.filter(function (i) { return i.health === 'low'; }).length,
    out: items.filter(function (i) { return i.health === 'out'; }).length,
    reservedUnits: tracked.reduce(function (s, i) { return s + i.reserved; }, 0),
    stockValue: Math.round(value * 100) / 100,
    valueIsPartial: tracked.some(function (i) { return i.costPrice == null && i.physical > 0; })
  };
}

function actionGetInventory(owner) {
  var variantsSheet = getSheet('Variants');
  ensureInventoryColumns(variantsSheet);
  var products = {};
  sheetToObjects(getSheet('Products')).forEach(function (p) { if (p.OwnerId === owner.OwnerId) products[p.ProductId] = p; });
  var items = sheetToObjects(variantsSheet)
    .filter(function (v) {
      var p = products[v.ProductId];
      return v.OwnerId === owner.OwnerId && v.Status === 'active' && p && p.Status !== 'deleted' && listingTypeOfRow(p) === 'product';
    })
    .map(function (v) { return inventoryItemOf(v, products[v.ProductId]); })
    .sort(function (a, b) {
      var rank = { out: 0, low: 1, healthy: 2, untracked: 3 };
      return (rank[a.health] - rank[b.health]) || String(a.productName).localeCompare(String(b.productName));
    });
  return ok({ items: items, summary: inventorySummary(items), businessType: storeTypeOf(owner), capabilities: inventoryCapabilities(owner) });
}

/** What this seller's inventory screens show - grows with business type, never a separate app. */
function inventoryCapabilities(owner) {
  var type = storeTypeOf(owner);
  var advanced = type === 'wholesaler' || type === 'distributor';
  return { locations: type === 'distributor', suppliers: advanced, transfers: type === 'distributor', purchaseOrders: advanced, sync: true };
}

/** Loads one of this seller's active, tracked-or-trackable varieties for a stock action. */
function ownVariantForStock(owner, variantId) {
  var sheet = getSheet('Variants');
  ensureInventoryColumns(sheet);
  var v = findRowById(sheet, 'VariantId', String(variantId || ''));
  if (!v || v.OwnerId !== owner.OwnerId || v.Status !== 'active') return null;
  v.__sheet = sheet;
  return v;
}

function parseWholeQty(raw) {
  var n = Number(raw);
  if (raw === '' || raw === null || raw === undefined || isNaN(n) || n !== Math.floor(n)) return null;
  return n;
}

/**
 * body.variantId, body.quantity (>0), body.supplier, body.invoice, body.unitCost,
 * body.requestId. Adds stock; turns tracking on for an untracked variety.
 */
function actionReceiveStock(owner, body) {
  var replay = inventoryReplay(owner, body.requestId);
  if (replay) return replay;
  var qty = parseWholeQty(body.quantity);
  if (qty === null || qty <= 0) return fail('Enter how many units arrived (a whole number above 0).');
  if (qty > 1000000) return fail('That quantity looks too large. Please check it.');
  var cost = body.unitCost === '' || body.unitCost == null ? null : Number(body.unitCost);
  if (cost !== null && (isNaN(cost) || cost < 0)) return fail('Cost must be a number of 0 or more.');
  var supplier = String(body.supplier || '').trim().slice(0, 100);
  var invoice = String(body.invoice || '').trim().slice(0, 60);

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var v = ownVariantForStock(owner, body.variantId);
    if (!v) return fail('That product variety was not found.');
    var before = isStockTracked(v) ? physicalOf(v) : 0;
    var after = before + qty;
    var update = { StockQty: after };
    if (cost !== null) update.CostPrice = cost;
    updateRowFromObject(v.__sheet, v.__row, update);
    recordStockMovements([{
      OwnerId: owner.OwnerId, ProductId: v.ProductId, VariantId: v.VariantId, Quantity: qty, MovementType: 'STOCK_RECEIVED',
      PreviousStock: isStockTracked(v) ? before : '', NewStock: after, PreviousReserved: reservedOf(v), NewReserved: reservedOf(v),
      Source: 'receive', ReferenceId: invoice, UserId: owner.OwnerId,
      Notes: [supplier && 'Supplier: ' + supplier, invoice && 'Invoice: ' + invoice, cost !== null && 'Unit cost: ' + cost].filter(Boolean).join(' · ')
    }]);
    invalidateCache([storeProductsCacheKey(owner.StoreSlug)]);
    v.StockQty = after;
    if (cost !== null) v.CostPrice = cost;
    var result = ok({ item: inventoryItemOf(v, findRowById(getSheet('Products'), 'ProductId', v.ProductId)) });
    inventoryRemember(owner, body.requestId, result);
    return result;
  } finally {
    lock.releaseLock();
  }
}

/**
 * body.variantId, body.reason ('count' | 'damaged' | 'expired' | 'returned'),
 * body.newCount (for 'count') or body.quantity (units removed for damaged/
 * expired, units back for returned), body.notes, body.requestId.
 */
function actionAdjustStock(owner, body) {
  var replay = inventoryReplay(owner, body.requestId);
  if (replay) return replay;
  var type = ADJUST_REASONS[body.reason];
  if (!type) return fail('Choose a reason for the change.');
  var notes = String(body.notes || '').trim().slice(0, 200);

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var v = ownVariantForStock(owner, body.variantId);
    if (!v) return fail('That product variety was not found.');
    var before = isStockTracked(v) ? physicalOf(v) : 0;
    var held = reservedOf(v);
    var after;
    if (body.reason === 'count') {
      after = parseWholeQty(body.newCount);
      if (after === null || after < 0) return fail('Enter the number you counted (0 or more).');
    } else {
      var q = parseWholeQty(body.quantity);
      if (q === null || q <= 0) return fail('Enter how many units (a whole number above 0).');
      after = body.reason === 'returned' ? before + q : before - q;
    }
    if (after < 0) return fail('You only have ' + before + ' in stock, so you can\'t remove that many.');
    if (after < held) {
      return fail(held + ' are held by open orders, so stock can\'t go below ' + held + '. Your stock has not been changed.');
    }
    if (after === before && isStockTracked(v)) return fail('That is the same as the current stock (' + before + '). Nothing to change.');
    updateRowFromObject(v.__sheet, v.__row, { StockQty: after });
    recordStockMovements([{
      OwnerId: owner.OwnerId, ProductId: v.ProductId, VariantId: v.VariantId, Quantity: after - before, MovementType: type,
      PreviousStock: isStockTracked(v) ? before : '', NewStock: after, PreviousReserved: held, NewReserved: held,
      Source: 'adjust', UserId: owner.OwnerId, Notes: notes
    }]);
    invalidateCache([storeProductsCacheKey(owner.StoreSlug)]);
    v.StockQty = after;
    var result = ok({ item: inventoryItemOf(v, findRowById(getSheet('Products'), 'ProductId', v.ProductId)) });
    inventoryRemember(owner, body.requestId, result);
    return result;
  } finally {
    lock.releaseLock();
  }
}

/** body.variantId, body.sku, body.barcode, body.reorderLevel, body.reorderQty, body.costPrice (blank clears). */
function actionUpdateStockSettings(owner, body) {
  var num = function (raw, label, whole) {
    if (raw === '' || raw == null) return { value: '' };
    var n = Number(raw);
    if (isNaN(n) || n < 0 || (whole && n !== Math.floor(n))) return { error: label + ' must be ' + (whole ? 'a whole number' : 'a number') + ' of 0 or more.' };
    return { value: n };
  };
  var level = num(body.reorderLevel, 'Low-stock level', true);
  var rq = num(body.reorderQty, 'Reorder quantity', true);
  var cost = num(body.costPrice, 'Cost price', false);
  var bad = [level, rq, cost].filter(function (x) { return x.error; })[0];
  if (bad) return fail(bad.error);
  var sku = String(body.sku || '').trim().slice(0, 64);
  var barcode = String(body.barcode || '').trim().slice(0, 64);
  if (barcode && !/^[0-9A-Za-z\-]{4,64}$/.test(barcode)) return fail('Barcode can only contain letters, numbers and dashes.');

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sheet = getSheet('Variants');
    ensureInventoryColumns(sheet);
    var all = sheetToObjects(sheet);
    var v = all.filter(function (r) { return r.VariantId === String(body.variantId || ''); })[0];
    if (!v || v.OwnerId !== owner.OwnerId || v.Status !== 'active') return fail('That product variety was not found.');
    // A SKU must identify one variety in this store - sync matches on it.
    if (sku) {
      var clash = all.filter(function (r) {
        return r.OwnerId === owner.OwnerId && r.VariantId !== v.VariantId && r.Status === 'active' && String(r.SKU).toLowerCase() === sku.toLowerCase();
      })[0];
      if (clash) return fail('SKU ' + sku + ' is already used by ' + clash.Label + '. Each variety needs its own SKU.');
    }
    updateRowFromObject(sheet, v.__row, { SKU: sku, Barcode: barcode, ReorderLevel: level.value, ReorderQty: rq.value, CostPrice: cost.value });
    v.SKU = sku; v.Barcode = barcode; v.ReorderLevel = level.value; v.ReorderQty = rq.value; v.CostPrice = cost.value;
    return ok({ item: inventoryItemOf(v, findRowById(getSheet('Products'), 'ProductId', v.ProductId)) });
  } finally {
    lock.releaseLock();
  }
}

/** body.variantId (optional filter), body.offset, body.limit. Newest first. */
function actionListStockMovements(owner, body) {
  body = body || {};
  var sheet = SpreadsheetApp.getActive().getSheetByName('StockMovements');
  var rows = sheet ? sheetToObjects(sheet).filter(function (m) {
    return m.OwnerId === owner.OwnerId && (!body.variantId || m.VariantId === body.variantId);
  }) : [];
  rows.reverse();
  var limit = Math.min(100, Math.max(1, Number(body.limit) || 30));
  var offset = Math.max(0, Number(body.offset) || 0);
  var labels = {};
  sheetToObjects(getSheet('Variants')).forEach(function (v) { if (v.OwnerId === owner.OwnerId) labels[v.VariantId] = v.Label; });
  var names = {};
  sheetToObjects(getSheet('Products')).forEach(function (p) { if (p.OwnerId === owner.OwnerId) names[p.ProductId] = p.Name; });
  return ok({
    total: rows.length,
    hasMore: offset + limit < rows.length,
    movements: rows.slice(offset, offset + limit).map(function (m) {
      return {
        movementId: m.MovementId, createdAt: m.CreatedAt, type: m.MovementType, quantity: Number(m.Quantity) || 0,
        previousStock: m.PreviousStock === '' ? null : Number(m.PreviousStock), newStock: m.NewStock === '' ? null : Number(m.NewStock),
        reservedBefore: Number(m.PreviousReserved) || 0, reservedAfter: Number(m.NewReserved) || 0,
        source: m.Source, referenceId: m.ReferenceId, notes: m.Notes,
        productName: names[m.ProductId] || '', label: labels[m.VariantId] || ''
      };
    })
  });
}
