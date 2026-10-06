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
