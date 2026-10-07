/**
 * Mwakete Inventory - locations, transfers, suppliers (wholesalers and
 * distributors; a retailer never sees any of it).
 *
 * The total stock for a variety stays on its Variants row (StockQty), so
 * orders, reservations, shoppers and sync keep working unchanged. Extra
 * places (a second shop, a warehouse) hold part of it in LocationStock; the
 * main location is simply the rest:
 *   main = StockQty - sum(LocationStock for the other locations)
 * A single-shop business therefore needs no set-up at all. If the total
 * falls (a sale, damage) below what the other locations hold, the shortfall
 * is taken from them and logged - see rebalanceLocationStock.
 *
 * Owner-approved tabs, created on first use: Locations, LocationStock,
 * StockTransfers, Suppliers.
 */

var LOCATION_HEADERS = ['LocationId', 'OwnerId', 'Name', 'Type', 'Status', 'CreatedAt', 'UpdatedAt'];
var LOCATION_STOCK_HEADERS = ['OwnerId', 'LocationId', 'VariantId', 'Qty', 'UpdatedAt'];
var STOCK_TRANSFER_HEADERS = ['TransferId', 'OwnerId', 'VariantId', 'FromLocationId', 'ToLocationId', 'Quantity', 'Notes', 'UserId', 'CreatedAt'];
var SUPPLIER_HEADERS = ['SupplierId', 'OwnerId', 'Name', 'Phone', 'Email', 'Notes', 'Status', 'CreatedAt', 'UpdatedAt'];
var LOCATION_TYPES = ['store', 'warehouse', 'branch'];
var MAIN_LOCATION_NAME_KEY = 'MainLocationName';

/* ==================== Sheets + loading ==================== */

function getLocationsSheet() { return getSheetCreating('Locations', LOCATION_HEADERS); }
function getLocationStockSheet() { return getSheetCreating('LocationStock', LOCATION_STOCK_HEADERS); }
function getStockTransfersSheet() { return getSheetCreating('StockTransfers', STOCK_TRANSFER_HEADERS); }
function getSuppliersSheet() { return getSheetCreating('Suppliers', SUPPLIER_HEADERS); }

function existingSheetRows(name) {
  var sheet = SpreadsheetApp.getActive().getSheetByName(name);
  return sheet ? sheetToObjects(sheet) : [];
}

/** This seller's active extra locations (the main one is implicit). */
function ownLocations(ownerId) {
  return existingSheetRows('Locations').filter(function (l) { return l.OwnerId === ownerId && l.Status !== 'archived'; });
}

/** { variantId: { locationId: qty } } for this seller's extra locations. */
function ownLocationStock(ownerId) {
  var map = {};
  existingSheetRows('LocationStock').forEach(function (r) {
    if (r.OwnerId !== ownerId) return;
    (map[r.VariantId] = map[r.VariantId] || {})[r.LocationId] = Math.max(0, Number(r.Qty) || 0);
  });
  return map;
}

function mainLocationName(owner) {
  var row = existingSheetRows('Locations').filter(function (l) { return l.OwnerId === owner.OwnerId && l.LocationId === DEFAULT_LOCATION_ID; })[0];
  return row ? row.Name : 'Main location';
}

/** Pure: a variety's quantity at each place, main first. extras = { locationId: qty }. */
function locationBreakdown(variant, extras, locations, mainName) {
  var total = isStockTracked(variant) ? physicalOf(variant) : 0;
  var others = 0;
  var list = locations.filter(function (l) { return l.LocationId !== DEFAULT_LOCATION_ID; }).map(function (l) {
    var q = (extras && extras[l.LocationId]) || 0;
    others += q;
    return { locationId: l.LocationId, name: l.Name, type: l.Type, qty: q };
  });
  return [{ locationId: DEFAULT_LOCATION_ID, name: mainName, type: 'store', qty: Math.max(0, total - others) }].concat(list);
}

function requireBulkSeller(owner) {
  return isBulkSeller(owner) ? null : fail('Locations and suppliers are for wholesaler and distributor stores.');
}

/** Sets one extra location's quantity (creating the row if needed). */
function setLocationQty(ownerId, locationId, variantId, qty) {
  var sheet = getLocationStockSheet();
  var row = sheetToObjects(sheet).filter(function (r) { return r.OwnerId === ownerId && r.LocationId === locationId && r.VariantId === variantId; })[0];
  if (row) updateRowFromObject(sheet, row.__row, { Qty: qty, UpdatedAt: nowIso() });
  else appendRowFromObject(sheet, { OwnerId: ownerId, LocationId: locationId, VariantId: variantId, Qty: qty, UpdatedAt: nowIso() });
}

/**
 * Called by recordStockMovements (Inventory.gs) after the TOTAL fell for some
 * varieties. Where the other locations now hold more than the total, the
 * shortfall is taken from them (largest first) and logged - stock is never
 * silently invented or lost.
 */
function rebalanceLocationStock(fellMovements) {
  var byOwner = {};
  fellMovements.forEach(function (m) { (byOwner[m.OwnerId] = byOwner[m.OwnerId] || {})[m.VariantId] = Number(m.NewStock); });
  Object.keys(byOwner).forEach(function (ownerId) {
    var extras = ownLocationStock(ownerId);
    var moves = [];
    Object.keys(byOwner[ownerId]).forEach(function (variantId) {
      var held = extras[variantId];
      if (!held) return;
      var total = byOwner[ownerId][variantId];
      var others = Object.keys(held).reduce(function (s, k) { return s + held[k]; }, 0);
      var short = others - total;
      Object.keys(held).sort(function (a, b) { return held[b] - held[a]; }).forEach(function (locId) {
        if (short <= 0 || !held[locId]) return;
        var take = Math.min(short, held[locId]);
        setLocationQty(ownerId, locId, variantId, held[locId] - take);
        moves.push({ OwnerId: ownerId, VariantId: variantId, LocationId: locId, Quantity: -take, MovementType: 'STOCK_TRANSFER',
          PreviousStock: held[locId], NewStock: held[locId] - take, Source: 'rebalance', UserId: 'system',
          Notes: 'Taken to cover a sale or removal - the main location had none left' });
        held[locId] -= take;
        short -= take;
      });
    });
    // Location-level rows (not the main location), so this never re-triggers itself.
    if (moves.length) recordStockMovements(moves);
  });
}

/* ==================== Locations ==================== */

function actionListLocations(owner) {
  var err = requireBulkSeller(owner);
  if (err) return err;
  var locations = ownLocations(owner.OwnerId).filter(function (l) { return l.LocationId !== DEFAULT_LOCATION_ID; });
  var extras = ownLocationStock(owner.OwnerId);
  var ctx = sellerImportContext(owner);
  var mainName = mainLocationName(owner);
  var totals = {};
  ctx.variants.forEach(function (v) {
    locationBreakdown(v, extras[v.VariantId], locations, mainName).forEach(function (b) {
      var t = totals[b.locationId] || (totals[b.locationId] = { units: 0, value: 0, items: 0 });
      t.units += b.qty;
      if (b.qty > 0) t.items++;
      if (v.CostPrice !== '' && v.CostPrice != null) t.value += b.qty * Number(v.CostPrice);
    });
  });
  var shape = function (id, name, type) {
    var t = totals[id] || { units: 0, value: 0, items: 0 };
    return { locationId: id, name: name, type: type, isMain: id === DEFAULT_LOCATION_ID, units: t.units, items: t.items, value: Math.round(t.value * 100) / 100 };
  };
  return ok({ locations: [shape(DEFAULT_LOCATION_ID, mainName, 'store')].concat(locations.map(function (l) { return shape(l.LocationId, l.Name, l.Type); })) });
}

/** body.locationId (blank = new; 'default' renames the main location), body.name, body.type. */
function actionSaveLocation(owner, body) {
  var err = requireBulkSeller(owner);
  if (err) return err;
  var name = String(body.name || '').trim().slice(0, 60);
  if (!name) return fail('Give the location a name, e.g. "Betio shop" or "Bairiki warehouse".');
  var type = LOCATION_TYPES.indexOf(body.type) !== -1 ? body.type : 'store';
  var sheet = getLocationsSheet();
  var mine = sheetToObjects(sheet).filter(function (l) { return l.OwnerId === owner.OwnerId && l.Status !== 'archived'; });
  var clash = mine.filter(function (l) { return l.LocationId !== body.locationId && String(l.Name).toLowerCase() === name.toLowerCase(); })[0];
  if (clash || (body.locationId !== DEFAULT_LOCATION_ID && name.toLowerCase() === mainLocationName(owner).toLowerCase())) return fail('You already have a location called ' + name + '.');
  var now = nowIso();
  if (body.locationId) {
    var row = mine.filter(function (l) { return l.LocationId === body.locationId; })[0];
    if (!row && body.locationId === DEFAULT_LOCATION_ID) {
      appendRowFromObject(sheet, { LocationId: DEFAULT_LOCATION_ID, OwnerId: owner.OwnerId, Name: name, Type: 'store', Status: 'active', CreatedAt: now, UpdatedAt: now });
      return ok({ locationId: DEFAULT_LOCATION_ID });
    }
    if (!row) return fail('That location was not found.');
    updateRowFromObject(sheet, row.__row, { Name: name, Type: body.locationId === DEFAULT_LOCATION_ID ? 'store' : type, UpdatedAt: now });
    return ok({ locationId: row.LocationId });
  }
  if (mine.length >= 50) return fail('That is the most locations one store can have (50).');
  var id = newId('loc');
  appendRowFromObject(sheet, { LocationId: id, OwnerId: owner.OwnerId, Name: name, Type: type, Status: 'active', CreatedAt: now, UpdatedAt: now });
  return ok({ locationId: id });
}

/** body.locationId. Only an empty location can be closed - stock is moved out first, never lost. */
function actionArchiveLocation(owner, body) {
  var err = requireBulkSeller(owner);
  if (err) return err;
  if (body.locationId === DEFAULT_LOCATION_ID) return fail('The main location can\'t be closed. You can rename it.');
  var sheet = SpreadsheetApp.getActive().getSheetByName('Locations');
  var row = sheet ? sheetToObjects(sheet).filter(function (l) { return l.OwnerId === owner.OwnerId && l.LocationId === body.locationId && l.Status !== 'archived'; })[0] : null;
  if (!row) return fail('That location was not found.');
  var extras = ownLocationStock(owner.OwnerId);
  var units = Object.keys(extras).reduce(function (s, vid) { return s + (extras[vid][row.LocationId] || 0); }, 0);
  if (units > 0) return fail(row.Name + ' still holds ' + units + ' unit' + (units === 1 ? '' : 's') + '. Transfer them to another location first.');
  updateRowFromObject(sheet, row.__row, { Status: 'archived', UpdatedAt: nowIso() });
  return ok({});
}

/**
 * body.variantId, body.fromLocationId, body.toLocationId, body.quantity,
 * body.notes, body.requestId. The total doesn't change; both sides are logged.
 */
function actionTransferStock(owner, body) {
  var err = requireBulkSeller(owner);
  if (err) return err;
  var replay = inventoryReplay(owner, body.requestId);
  if (replay) return replay;
  var from = String(body.fromLocationId || '');
  var to = String(body.toLocationId || '');
  if (!from || !to || from === to) return fail('Choose two different locations.');
  var q = parseWholeQty(body.quantity);
  if (q === null || q <= 0) return fail('Enter how many units to move (a whole number above 0).');
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var v = ownVariantForStock(owner, body.variantId);
    if (!v) return fail('That product variety was not found.');
    if (!isStockTracked(v)) return fail('Stock isn\'t tracked for this item yet. Receive or count it first.');
    var locations = ownLocations(owner.OwnerId).filter(function (l) { return l.LocationId !== DEFAULT_LOCATION_ID; });
    var known = function (id) { return id === DEFAULT_LOCATION_ID || locations.some(function (l) { return l.LocationId === id; }); };
    if (!known(from) || !known(to)) return fail('That location was not found.');
    var extras = ownLocationStock(owner.OwnerId)[v.VariantId] || {};
    var breakdown = locationBreakdown(v, extras, locations, mainLocationName(owner));
    var at = function (id) { return breakdown.filter(function (b) { return b.locationId === id; })[0]; };
    var src = at(from), dst = at(to);
    if (src.qty < q) return fail(src.name + ' only has ' + src.qty + '. Nothing was moved.');
    if (from !== DEFAULT_LOCATION_ID) setLocationQty(owner.OwnerId, from, v.VariantId, src.qty - q);
    if (to !== DEFAULT_LOCATION_ID) setLocationQty(owner.OwnerId, to, v.VariantId, dst.qty + q);
    var transferId = newId('trf');
    var notes = String(body.notes || '').trim().slice(0, 200);
    appendRowFromObject(getStockTransfersSheet(), { TransferId: transferId, OwnerId: owner.OwnerId, VariantId: v.VariantId, FromLocationId: from,
      ToLocationId: to, Quantity: q, Notes: notes, UserId: owner.OwnerId, CreatedAt: nowIso() });
    // Each side's own before/after; the total (and so every order) is unchanged.
    recordStockMovements([
      { OwnerId: owner.OwnerId, ProductId: v.ProductId, VariantId: v.VariantId, LocationId: from, Quantity: -q, MovementType: 'STOCK_TRANSFER',
        PreviousStock: src.qty, NewStock: src.qty - q, Source: 'transfer', ReferenceId: transferId, UserId: owner.OwnerId, Notes: 'To ' + dst.name + (notes ? ' · ' + notes : '') },
      { OwnerId: owner.OwnerId, ProductId: v.ProductId, VariantId: v.VariantId, LocationId: to, Quantity: q, MovementType: 'STOCK_TRANSFER',
        PreviousStock: dst.qty, NewStock: dst.qty + q, Source: 'transfer', ReferenceId: transferId, UserId: owner.OwnerId, Notes: 'From ' + src.name + (notes ? ' · ' + notes : '') }
    ]);
    var result = ok({ transferId: transferId, locations: locationBreakdown(v, ownLocationStock(owner.OwnerId)[v.VariantId], locations, mainLocationName(owner)) });
    inventoryRemember(owner, body.requestId, result);
    return result;
  } finally {
    lock.releaseLock();
  }
}

/**
 * Receiving or counting at an extra location (Inventory.gs calls this when
 * body.locationId is set): moves that location's quantity by delta along with
 * the total. Returns '' or an error, before anything is written.
 */
function locationDeltaError(owner, variant, locationId, delta) {
  if (!locationId || locationId === DEFAULT_LOCATION_ID) return '';
  if (!isBulkSeller(owner)) return 'Locations are for wholesaler and distributor stores.';
  var loc = ownLocations(owner.OwnerId).filter(function (l) { return l.LocationId === locationId; })[0];
  if (!loc) return 'That location was not found.';
  var have = (ownLocationStock(owner.OwnerId)[variant.VariantId] || {})[locationId] || 0;
  if (have + delta < 0) return loc.Name + ' only has ' + have + '.';
  return '';
}

function applyLocationDelta(owner, variant, locationId, delta) {
  if (!locationId || locationId === DEFAULT_LOCATION_ID || !delta) return;
  var have = (ownLocationStock(owner.OwnerId)[variant.VariantId] || {})[locationId] || 0;
  setLocationQty(owner.OwnerId, locationId, variant.VariantId, have + delta);
}

/* ==================== Suppliers ==================== */

function actionListSuppliers(owner) {
  var err = requireBulkSeller(owner);
  if (err) return err;
  return ok({ suppliers: existingSheetRows('Suppliers')
    .filter(function (s) { return s.OwnerId === owner.OwnerId && s.Status !== 'archived'; })
    .sort(function (a, b) { return String(a.Name).localeCompare(String(b.Name)); })
    .map(function (s) { return { supplierId: s.SupplierId, name: s.Name, phone: s.Phone || '', email: s.Email || '', notes: s.Notes || '' }; }) });
}

/** body.supplierId (blank = new), name, phone, email, notes. */
function actionSaveSupplier(owner, body) {
  var err = requireBulkSeller(owner);
  if (err) return err;
  var name = String(body.name || '').trim().slice(0, 100);
  if (!name) return fail('Enter the supplier\'s name.');
  var email = String(body.email || '').trim().slice(0, 120);
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return fail('That email address doesn\'t look right.');
  var fields = { Name: name, Phone: String(body.phone || '').trim().slice(0, 40), Email: email, Notes: String(body.notes || '').trim().slice(0, 300), UpdatedAt: nowIso() };
  var sheet = getSuppliersSheet();
  var mine = sheetToObjects(sheet).filter(function (s) { return s.OwnerId === owner.OwnerId && s.Status !== 'archived'; });
  if (mine.some(function (s) { return s.SupplierId !== body.supplierId && String(s.Name).toLowerCase() === name.toLowerCase(); })) return fail('You already have a supplier called ' + name + '.');
  if (body.supplierId) {
    var row = mine.filter(function (s) { return s.SupplierId === body.supplierId; })[0];
    if (!row) return fail('That supplier was not found.');
    updateRowFromObject(sheet, row.__row, fields);
    return ok({ supplierId: row.SupplierId });
  }
  var id = newId('sup');
  fields.SupplierId = id; fields.OwnerId = owner.OwnerId; fields.Status = 'active'; fields.CreatedAt = fields.UpdatedAt;
  appendRowFromObject(sheet, fields);
  return ok({ supplierId: id });
}

function actionArchiveSupplier(owner, body) {
  var err = requireBulkSeller(owner);
  if (err) return err;
  var sheet = SpreadsheetApp.getActive().getSheetByName('Suppliers');
  var row = sheet ? sheetToObjects(sheet).filter(function (s) { return s.OwnerId === owner.OwnerId && s.SupplierId === body.supplierId && s.Status !== 'archived'; })[0] : null;
  if (!row) return fail('That supplier was not found.');
  // Archived, not deleted: past receipts still name them.
  updateRowFromObject(sheet, row.__row, { Status: 'archived', UpdatedAt: nowIso() });
  return ok({});
}

/* ==================== Reports ==================== */

/**
 * body.days (default 30). Stock received by supplier, sold, damaged/expired,
 * and stock by location - from the ledger and live stock, nothing stored.
 */
function actionInventoryReport(owner, body) {
  var days = Math.min(365, Math.max(1, parseInt(body && body.days, 10) || 30));
  var since = Date.now() - days * 86400000;
  var ctx = sellerImportContext(owner);
  var names = {};
  ctx.variants.forEach(function (v) { var p = ctx.products[v.ProductId]; names[v.VariantId] = (p ? p.Name : '') + ' - ' + v.Label; });
  var moves = existingSheetRows('StockMovements').filter(function (m) { return m.OwnerId === owner.OwnerId && new Date(m.CreatedAt).getTime() >= since; });
  var sum = function (type) { return moves.filter(function (m) { return m.MovementType === type; }).reduce(function (s, m) { return s + Math.abs(Number(m.Quantity) || 0); }, 0); };
  var bySupplier = {};
  moves.filter(function (m) { return m.MovementType === 'STOCK_RECEIVED'; }).forEach(function (m) {
    var match = String(m.Notes || '').match(/Supplier: ([^·]+)/);
    var key = match ? match[1].trim() : 'No supplier given';
    bySupplier[key] = (bySupplier[key] || 0) + (Number(m.Quantity) || 0);
  });
  var sold = {};
  moves.filter(function (m) { return m.MovementType === 'SALE'; }).forEach(function (m) { sold[m.VariantId] = (sold[m.VariantId] || 0) + Math.abs(Number(m.Quantity) || 0); });
  var top = Object.keys(sold).sort(function (a, b) { return sold[b] - sold[a]; }).slice(0, 10).map(function (id) { return { name: names[id] || id, units: sold[id] }; });
  var out = { days: days, received: sum('STOCK_RECEIVED'), sold: sum('SALE'), damaged: sum('DAMAGED') + sum('EXPIRED'), returned: sum('RETURN'),
    bySupplier: Object.keys(bySupplier).map(function (k) { return { supplier: k, units: bySupplier[k] }; }).sort(function (a, b) { return b.units - a.units; }),
    topSellers: top };
  if (isBulkSeller(owner)) {
    var listed = actionListLocations(owner);
    if (listed.ok) out.byLocation = listed.locations;
  }
  return ok({ report: out });
}
