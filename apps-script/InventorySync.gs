/**
 * Mwakete Inventory Sync - connectors, field mapping, preview-then-apply.
 *
 * The engine never knows where rows came from. A connector only turns its
 * source into { headers, rows } (and, where it can, writes stock back); the
 * seller's saved mapping turns columns into Mwakete fields; the planner
 * matches records to varieties and works out the changes. Nothing is applied
 * without a preview the seller has seen: apply re-runs the plan and refuses if
 * it no longer matches the one previewed.
 *
 * Owner-approved tabs, created on first use: InventoryConnections (saved
 * sources + mappings; never passwords or keys) and SyncJobs (history).
 *
 * Matching (in priority order, never by name): Mwakete variety ID, external
 * product ID, SKU, barcode.
 */

var INVENTORY_CONNECTION_HEADERS = ['ConnectionId', 'OwnerId', 'Type', 'Name', 'SettingsJson', 'MappingJson', 'Mode',
  'Status', 'LastSyncAt', 'LastSyncStatus', 'LastError', 'CreatedAt', 'UpdatedAt'];
var SYNC_JOB_HEADERS = ['SyncId', 'OwnerId', 'ConnectionId', 'ConnectorType', 'Direction', 'StartedAt', 'CompletedAt',
  'RecordsRead', 'RecordsCreated', 'RecordsUpdated', 'RecordsSkipped', 'RecordsFailed', 'Conflicts', 'Status', 'ErrorCount', 'SummaryJson'];
var SYNC_STATUS = { PENDING: 'PENDING', RUNNING: 'RUNNING', SUCCESS: 'SUCCESS', PARTIAL: 'PARTIAL_SUCCESS', FAILED: 'FAILED', CONFLICT: 'CONFLICT' };
var IMPORT_MAX_ROWS = 2000;
var IMPORT_MAX_NEW_PRODUCTS = 200;

/** Mwakete fields a column can map to. */
var INVENTORY_FIELDS = {
  mwaketeId: { label: 'Mwakete ID', kind: 'id' },
  externalId: { label: 'Your system\'s product ID', kind: 'id' },
  sku: { label: 'SKU / item code', kind: 'id' },
  barcode: { label: 'Barcode', kind: 'id' },
  productName: { label: 'Product name', kind: 'text' },
  variantLabel: { label: 'Variety / size', kind: 'text' },
  physicalStock: { label: 'Stock on hand', kind: 'whole' },
  price: { label: 'Selling price', kind: 'money' },
  costPrice: { label: 'Cost price', kind: 'money' },
  reorderLevel: { label: 'Low-stock level', kind: 'whole' },
  reorderQty: { label: 'Reorder quantity', kind: 'whole' }
};

/* ==================== Connector registry ==================== */

/**
 * Every source implements the same small surface. 'configured' says whether
 * Mwakete itself is set up for it (e.g. Microsoft needs an app registration);
 * a connector that isn't says so honestly instead of pretending to work.
 *   readRows(conn, input)  -> { headers, rows } | { error }
 *   writeStock(conn, list) -> { written } | { error }   (optional)
 */
var INVENTORY_CONNECTORS = {
  csv: {
    label: 'CSV file',
    configured: function () { return true; },
    canWrite: false,
    // The browser parses the file and sends the rows (less data on a slow
    // connection than uploading the file and parsing it twice).
    readRows: function (conn, input) {
      var headers = Array.isArray(input && input.headers) ? input.headers.map(function (h) { return String(h == null ? '' : h).trim(); }) : [];
      var rows = Array.isArray(input && input.rows) ? input.rows : [];
      if (!headers.length) return { error: 'The file has no header row. The first line should name the columns.' };
      return { headers: headers, rows: rows };
    }
  },
  microsoftExcel: {
    label: 'Excel / OneDrive',
    // Needs a Microsoft Entra (Azure) app registration and OAuth - see
    // docs/inventory-sync.md. Not set up, so it is shown as not configured.
    configured: function () {
      var p = PropertiesService.getScriptProperties();
      return !!(p.getProperty('MS_GRAPH_CLIENT_ID') && p.getProperty('MS_GRAPH_CLIENT_SECRET'));
    },
    canWrite: true,
    readRows: function () { return { error: 'Excel / OneDrive is not connected to Mwakete yet. Download your sheet as CSV and import that for now.' }; }
  },
  customApi: {
    label: 'Other system (API)',
    configured: function () { return false; },
    canWrite: false,
    readRows: function () { return { error: 'Direct connections to other systems are not available yet. Export a CSV from your system and import that.' }; }
  }
};

function connectorFor(type) {
  return Object.prototype.hasOwnProperty.call(INVENTORY_CONNECTORS, type) ? INVENTORY_CONNECTORS[type] : null;
}

/* ==================== Sheets ==================== */

function getSheetCreating(name, headers) {
  var ss = SpreadsheetApp.getActive();
  var sheet = ss.getSheetByName(name);
  if (sheet) return sheet;
  sheet = ss.insertSheet(name);
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  return sheet;
}

function getInventoryConnectionsSheet() { return getSheetCreating('InventoryConnections', INVENTORY_CONNECTION_HEADERS); }
function getSyncJobsSheet() { return getSheetCreating('SyncJobs', SYNC_JOB_HEADERS); }

/* ==================== Engine (pure) ==================== */

/** Pure: a mapping is { columnHeader: fieldKey }. Returns '' or what is wrong with it. */
function mappingError(mapping, headers) {
  var used = {};
  var keys = Object.keys(mapping || {});
  for (var i = 0; i < keys.length; i++) {
    var f = mapping[keys[i]];
    if (!f) continue;
    if (!INVENTORY_FIELDS[f]) return 'Unknown field for column "' + keys[i] + '".';
    if (headers && headers.indexOf(keys[i]) === -1) return 'Column "' + keys[i] + '" is not in this file.';
    if (used[f]) return '"' + INVENTORY_FIELDS[f].label + '" is chosen for two columns. Pick one.';
    used[f] = true;
  }
  if (!used.mwaketeId && !used.externalId && !used.sku && !used.barcode) {
    return 'Choose the column that identifies each item: Mwakete ID, your product ID, SKU or barcode.';
  }
  if (!used.physicalStock && !used.price && !used.costPrice && !used.reorderLevel && !used.reorderQty) {
    return 'Choose at least one column to update, such as stock on hand or price.';
  }
  return '';
}

function parseFieldValue(kind, raw) {
  var s = String(raw == null ? '' : raw).trim();
  if (s === '') return { blank: true };
  if (kind === 'id' || kind === 'text') return { value: s.slice(0, 150) };
  var n = Number(s.replace(/[$,\s]/g, ''));
  if (isNaN(n) || n < 0) return { error: 'is not a number of 0 or more' };
  if (kind === 'whole') {
    if (n !== Math.floor(n)) return { error: 'must be a whole number' };
    if (n > 10000000) return { error: 'looks too large' };
    return { value: n };
  }
  return { value: Math.round(n * 100) / 100 };
}

/**
 * Pure: rows -> records. Each record: { line, fields:{...}, errors:[...] }.
 * line is the spreadsheet row number (header = 1) so errors point at it.
 */
function normalizeImportRows(headers, rows, mapping) {
  var cols = headers.map(function (h) { return mapping[h] || ''; });
  return rows.map(function (row, i) {
    var rec = { line: i + 2, fields: {}, errors: [] };
    cols.forEach(function (field, c) {
      if (!field) return;
      var parsed = parseFieldValue(INVENTORY_FIELDS[field].kind, Array.isArray(row) ? row[c] : row[headers[c]]);
      if (parsed.error) rec.errors.push(INVENTORY_FIELDS[field].label + ' "' + (Array.isArray(row) ? row[c] : '') + '" ' + parsed.error);
      else if (!parsed.blank) rec.fields[field] = parsed.value;
    });
    return rec;
  }).filter(function (rec) {
    // A completely empty line (common at the end of exported files) is not an item.
    return rec.errors.length || Object.keys(rec.fields).length;
  });
}

/** Pure: finds a record's variety by Mwakete ID, then external ID, then SKU, then barcode. Never by name. */
function matchImportRecord(rec, index) {
  var f = rec.fields;
  var tries = [['mwaketeId', 'byId'], ['externalId', 'byExternal'], ['sku', 'bySku'], ['barcode', 'byBarcode']];
  for (var i = 0; i < tries.length; i++) {
    var key = f[tries[i][0]];
    if (key === undefined) continue;
    var hit = index[tries[i][1]][String(key).toLowerCase()];
    if (hit) return { variant: hit, matchedBy: tries[i][0] };
  }
  return null;
}

function buildVariantIndex(variants) {
  var index = { byId: {}, byExternal: {}, bySku: {}, byBarcode: {} };
  variants.forEach(function (v) {
    index.byId[String(v.VariantId).toLowerCase()] = v;
    if (v.ExternalId !== '' && v.ExternalId != null) index.byExternal[String(v.ExternalId).toLowerCase()] = v;
    if (v.SKU !== '' && v.SKU != null) index.bySku[String(v.SKU).toLowerCase()] = v;
    if (v.Barcode !== '' && v.Barcode != null) index.byBarcode[String(v.Barcode).toLowerCase()] = v;
  });
  return index;
}

/**
 * Pure: the whole import plan. variants = this seller's active product
 * varieties; products = { ProductId: row }. opts.createNew (bool) and
 * opts.category for unmatched rows. Nothing here writes.
 */
function buildImportPlan(records, variants, products, opts) {
  opts = opts || {};
  var index = buildVariantIndex(variants);
  var plan = { updates: [], newItems: [], unmatched: [], errors: [], conflicts: [], unchanged: 0,
    counts: { read: records.length, existing: 0, stockChanges: 0, priceChanges: 0, otherChanges: 0, newProducts: 0, unmatched: 0, errors: 0, conflicts: 0 } };
  var seen = {};

  records.forEach(function (rec) {
    var nameOf = function (v) { var p = products[v.ProductId]; return (p ? p.Name : '') + (v.Label ? ' - ' + v.Label : ''); };
    if (rec.errors.length) { plan.errors.push({ line: rec.line, message: rec.errors.join('; ') }); return; }
    var m = matchImportRecord(rec, index);
    if (!m) {
      if (opts.createNew && rec.fields.productName && rec.fields.price > 0) {
        plan.newItems.push({ line: rec.line, fields: rec.fields });
      } else {
        plan.unmatched.push({ line: rec.line, name: rec.fields.productName || '', key: rec.fields.sku || rec.fields.externalId || rec.fields.barcode || rec.fields.mwaketeId || '',
          reason: opts.createNew ? 'needs a product name and a price above 0 to be added' : 'not on Mwakete yet' });
      }
      return;
    }
    var v = m.variant;
    if (seen[v.VariantId]) {
      plan.errors.push({ line: rec.line, message: 'Same item as line ' + seen[v.VariantId] + ' (' + nameOf(v) + '). Each item may appear once.' });
      return;
    }
    seen[v.VariantId] = rec.line;
    plan.counts.existing++;

    var f = rec.fields;
    var change = { line: rec.line, variantId: v.VariantId, productId: v.ProductId, name: nameOf(v), matchedBy: m.matchedBy, set: {}, before: {} };
    if (f.physicalStock !== undefined) {
      var was = isStockTracked(v) ? physicalOf(v) : null;
      if (was !== f.physicalStock) {
        if (f.physicalStock < reservedOf(v)) {
          plan.conflicts.push({ line: rec.line, variantId: v.VariantId, name: nameOf(v),
            message: 'File says ' + f.physicalStock + ' but ' + reservedOf(v) + ' are held by open orders on Mwakete. Stock left at ' + (was === null ? 'not tracked' : was) + '.' });
        } else {
          change.set.StockQty = f.physicalStock; change.before.StockQty = was;
        }
      }
    }
    var simple = [['price', 'Price'], ['costPrice', 'CostPrice'], ['reorderLevel', 'ReorderLevel'], ['reorderQty', 'ReorderQty']];
    simple.forEach(function (pair) {
      var val = f[pair[0]];
      if (val === undefined) return;
      if (pair[0] === 'price' && !(val > 0)) { plan.errors.push({ line: rec.line, message: 'Selling price must be above 0. Price not changed for ' + nameOf(v) + '.' }); return; }
      var cur = v[pair[1]] === '' || v[pair[1]] == null ? null : Number(v[pair[1]]);
      if (cur !== val) { change.set[pair[1]] = val; change.before[pair[1]] = cur; }
    });
    // Identifiers fill in blanks only - never overwrite the key a seller already relies on.
    [['externalId', 'ExternalId'], ['sku', 'SKU'], ['barcode', 'Barcode']].forEach(function (pair) {
      var val = f[pair[0]];
      if (val !== undefined && (v[pair[1]] === '' || v[pair[1]] == null)) { change.set[pair[1]] = String(val); change.before[pair[1]] = ''; }
    });
    var keys = Object.keys(change.set);
    if (!keys.length) { plan.unchanged++; return; }
    if (change.set.StockQty !== undefined) plan.counts.stockChanges++;
    if (change.set.Price !== undefined) plan.counts.priceChanges++;
    if (keys.some(function (k) { return k !== 'StockQty' && k !== 'Price'; })) plan.counts.otherChanges++;
    plan.updates.push(change);
  });

  // New products: rows with the same name become varieties of one product.
  if (plan.newItems.length > IMPORT_MAX_NEW_PRODUCTS) {
    plan.errors.push({ line: 0, message: 'At most ' + IMPORT_MAX_NEW_PRODUCTS + ' new items per import. Split the file and import the rest after.' });
    plan.newItems = [];
  }
  var groups = {};
  plan.newItems.forEach(function (it) {
    var k = String(it.fields.productName).toLowerCase();
    (groups[k] = groups[k] || []).push(it);
  });
  plan.newProducts = Object.keys(groups).map(function (k) {
    return { name: groups[k][0].fields.productName, category: opts.category || 'other', items: groups[k] };
  });
  plan.counts.newProducts = plan.newProducts.length;
  plan.counts.unmatched = plan.unmatched.length;
  plan.counts.errors = plan.errors.length;
  plan.counts.conflicts = plan.conflicts.length;
  plan.counts.unchanged = plan.unchanged;
  return plan;
}

/** Pure: a short fingerprint of what a plan will do - apply must reproduce it exactly. */
function importPlanToken(plan) {
  var basis = JSON.stringify({
    u: plan.updates.map(function (c) { return [c.variantId, c.set]; }),
    n: plan.newProducts.map(function (p) { return [p.name, p.category, p.items.map(function (i) { return i.fields; })]; })
  });
  var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, basis, Utilities.Charset.UTF_8);
  return digest.slice(0, 12).map(function (b) { var h = (b & 0xff).toString(16); return h.length === 1 ? '0' + h : h; }).join('');
}

/* ==================== Shared loading ==================== */

function sellerImportContext(owner) {
  var variantsSheet = getSheet('Variants');
  ensureInventoryColumns(variantsSheet);
  var products = {};
  sheetToObjects(getSheet('Products')).forEach(function (p) {
    if (p.OwnerId === owner.OwnerId && p.Status !== 'deleted' && listingTypeOfRow(p) === 'product') products[p.ProductId] = p;
  });
  var variants = sheetToObjects(variantsSheet).filter(function (v) {
    return v.OwnerId === owner.OwnerId && v.Status === 'active' && products[v.ProductId];
  });
  return { variantsSheet: variantsSheet, variants: variants, products: products };
}

/** Reads + plans from a request body: { type, headers, rows, mapping, createNew, category }. */
function planFromRequest(owner, body) {
  var type = String(body.type || 'csv');
  var connector = connectorFor(type);
  if (!connector) return { error: 'Unknown source.' };
  if (!connector.configured()) return { error: connector.label + ' is not connected to Mwakete yet.' };
  var data = connector.readRows(body.connection || null, body);
  if (data.error) return { error: data.error };
  if (data.rows.length > IMPORT_MAX_ROWS) return { error: 'That file has ' + data.rows.length + ' rows. At most ' + IMPORT_MAX_ROWS + ' per import - split it into smaller files.' };
  var mapping = body.mapping || {};
  var mErr = mappingError(mapping, data.headers);
  if (mErr) return { error: mErr };
  var category = categoryIdOf(body.category);
  if (body.createNew) {
    if (!body.category || CATEGORY_IDS.indexOf(String(body.category)) === -1) return { error: 'Choose a category for the new products.' };
    if (category === 'food' && !canListFood(owner)) return { error: 'Food & Groceries is for wholesaler stores only. Choose another category for the new products.' };
  }
  var ctx = sellerImportContext(owner);
  var records = normalizeImportRows(data.headers, data.rows, mapping);
  var plan = buildImportPlan(records, ctx.variants, ctx.products, { createNew: !!body.createNew, category: category });
  return { plan: plan, ctx: ctx, type: type, mapping: mapping };
}

/** Food & Groceries listing permission - one place, so business types can grow. */
function canListFood(owner) {
  return storeTypeOf(owner) === 'wholesaler';
}

function planPreviewShape(plan) {
  var cap = function (list, n) { return list.slice(0, n); };
  return {
    counts: plan.counts,
    updates: cap(plan.updates, 50).map(function (c) { return { line: c.line, name: c.name, matchedBy: c.matchedBy, set: c.set, before: c.before }; }),
    newProducts: cap(plan.newProducts, 50).map(function (p) { return { name: p.name, category: p.category, varieties: p.items.length }; }),
    unmatched: cap(plan.unmatched, 50),
    errors: cap(plan.errors, 50),
    conflicts: cap(plan.conflicts, 50)
  };
}

/* ==================== Actions ==================== */

/** Connector list for the Sync page: what exists, what is configured, the seller's saved sources. */
function actionListInventoryConnections(owner) {
  var available = Object.keys(INVENTORY_CONNECTORS).map(function (k) {
    return { type: k, label: INVENTORY_CONNECTORS[k].label, configured: INVENTORY_CONNECTORS[k].configured(), canWrite: !!INVENTORY_CONNECTORS[k].canWrite };
  });
  var sheet = SpreadsheetApp.getActive().getSheetByName('InventoryConnections');
  var mine = sheet ? sheetToObjects(sheet).filter(function (c) { return c.OwnerId === owner.OwnerId && c.Status !== 'disconnected'; }) : [];
  return ok({ connectors: available, connections: mine.map(publicConnection) });
}

function publicConnection(c) {
  var mapping = {}; var settings = {};
  try { mapping = JSON.parse(c.MappingJson || '{}'); } catch (e) { mapping = {}; }
  try { settings = JSON.parse(c.SettingsJson || '{}'); } catch (e) { settings = {}; }
  return { connectionId: c.ConnectionId, type: c.Type, name: c.Name, mapping: mapping, settings: settings, mode: c.Mode,
    status: c.Status, lastSyncAt: c.LastSyncAt || '', lastSyncStatus: c.LastSyncStatus || '', lastError: c.LastError || '' };
}

/** body: { connectionId? , type, name, mapping, settings, mode }. Saves a reusable source + mapping. */
function actionSaveInventoryConnection(owner, body) {
  var type = String(body.type || '');
  if (!connectorFor(type)) return fail('Unknown source.');
  var name = String(body.name || '').trim().slice(0, 80) || connectorFor(type).label;
  var mapping = body.mapping || {};
  var mErr = mappingError(mapping, null);
  if (mErr) return fail(mErr);
  var mode = ['import', 'export', 'twoWay'].indexOf(body.mode) !== -1 ? body.mode : 'import';
  var settings = body.settings && typeof body.settings === 'object' ? body.settings : {};
  var sheet = getInventoryConnectionsSheet();
  var now = nowIso();
  if (body.connectionId) {
    var row = findRowById(sheet, 'ConnectionId', String(body.connectionId));
    if (!row || row.OwnerId !== owner.OwnerId) return fail('That saved source was not found.');
    updateRowFromObject(sheet, row.__row, { Name: name, MappingJson: JSON.stringify(mapping), SettingsJson: JSON.stringify(settings), Mode: mode, UpdatedAt: now });
    return ok({ connection: publicConnection(findRowById(sheet, 'ConnectionId', row.ConnectionId)) });
  }
  var id = newId('conn');
  appendRowFromObject(sheet, { ConnectionId: id, OwnerId: owner.OwnerId, Type: type, Name: name, SettingsJson: JSON.stringify(settings),
    MappingJson: JSON.stringify(mapping), Mode: mode, Status: connectorFor(type).configured() ? 'connected' : 'notConfigured', CreatedAt: now, UpdatedAt: now });
  return ok({ connection: publicConnection(findRowById(sheet, 'ConnectionId', id)) });
}

function actionDeleteInventoryConnection(owner, body) {
  var sheet = SpreadsheetApp.getActive().getSheetByName('InventoryConnections');
  var row = sheet ? findRowById(sheet, 'ConnectionId', String(body.connectionId || '')) : null;
  if (!row || row.OwnerId !== owner.OwnerId) return fail('That saved source was not found.');
  // Soft: the row stays for the sync history that points at it.
  updateRowFromObject(sheet, row.__row, { Status: 'disconnected', UpdatedAt: nowIso() });
  return ok({});
}

/** Dry run. Changes nothing; returns the counts, samples, and the token apply must match. */
function actionPreviewInventoryImport(owner, body) {
  var r = planFromRequest(owner, body);
  if (r.error) return fail(r.error);
  var preview = planPreviewShape(r.plan);
  preview.planToken = importPlanToken(r.plan);
  return ok({ preview: preview });
}

/**
 * Applies exactly what was previewed. body = the preview request + planToken
 * (+ connectionId to record against). Re-plans under the lock; if anything
 * moved in between (an order, another edit), refuses and asks for a new preview.
 */
function actionApplyInventoryImport(owner, body) {
  var started = nowIso();
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var r = planFromRequest(owner, body);
    if (r.error) return fail(r.error);
    if (!body.planToken || importPlanToken(r.plan) !== body.planToken) {
      return fail('Your stock changed since the preview (for example a new order). Nothing was changed - please preview again.');
    }
    var syncId = newId('sync');
    var result = applyImportPlan(owner, r.plan, r.ctx, { syncId: syncId, source: r.type });
    var status = r.plan.counts.errors || r.plan.counts.conflicts || r.plan.counts.unmatched ? SYNC_STATUS.PARTIAL : SYNC_STATUS.SUCCESS;
    recordSyncJob(owner, {
      SyncId: syncId, ConnectionId: body.connectionId || '', ConnectorType: r.type, Direction: 'import', StartedAt: started,
      RecordsRead: r.plan.counts.read, RecordsCreated: result.created, RecordsUpdated: result.updated,
      RecordsSkipped: r.plan.counts.unchanged + r.plan.counts.unmatched, RecordsFailed: r.plan.counts.errors,
      Conflicts: r.plan.counts.conflicts, Status: status, ErrorCount: r.plan.counts.errors,
      SummaryJson: JSON.stringify({ errors: r.plan.errors.slice(0, 20), conflicts: r.plan.conflicts.slice(0, 20), unmatched: r.plan.unmatched.slice(0, 20) })
    });
    markConnectionSynced(owner, body.connectionId, status, '');
    return ok({ syncId: syncId, status: status, created: result.created, updated: result.updated, counts: r.plan.counts });
  } finally {
    lock.releaseLock();
  }
}

/** Writes a plan: variety updates (stock via the ledger), then new products. Caller holds the lock. */
function applyImportPlan(owner, plan, ctx, meta) {
  var byId = {};
  ctx.variants.forEach(function (v) { byId[v.VariantId] = v; });
  var moves = [];
  var now = nowIso();
  plan.updates.forEach(function (c) {
    var v = byId[c.variantId];
    var set = {};
    Object.keys(c.set).forEach(function (k) { set[k] = c.set[k]; });
    set.LastSyncedAt = now;
    updateRowFromObject(ctx.variantsSheet, v.__row, set);
    if (c.set.StockQty !== undefined) {
      var before = c.before.StockQty;
      moves.push({ OwnerId: owner.OwnerId, ProductId: v.ProductId, VariantId: v.VariantId,
        Quantity: c.set.StockQty - (before === null ? 0 : before), MovementType: 'EXTERNAL_SYNC',
        PreviousStock: before === null ? '' : before, NewStock: c.set.StockQty, PreviousReserved: reservedOf(v), NewReserved: reservedOf(v),
        Source: meta.source, ReferenceId: meta.syncId, UserId: owner.OwnerId, Notes: 'Import line ' + c.line + ' (matched by ' + c.matchedBy + ')' });
    }
  });

  var created = 0;
  if (plan.newProducts.length) {
    var productsSheet = getSheet('Products');
    ensureColumn(productsSheet, 'ListingType');
    plan.newProducts.forEach(function (np) {
      var productId = newId('prod');
      appendRowFromObject(productsSheet, { ProductId: productId, OwnerId: owner.OwnerId, StoreSlug: owner.StoreSlug, Name: np.name,
        Description: '', Category: np.category, ListingType: 'product', ImageUrl: '', ImageFileId: '', ImageUrl2: '', ImageFileId2: '',
        Status: 'active', SortOrder: 0, CreatedAt: now, UpdatedAt: now });
      np.items.forEach(function (it) {
        var f = it.fields;
        var variantId = newId('var');
        var stock = f.physicalStock === undefined ? '' : f.physicalStock;
        appendRowFromObject(ctx.variantsSheet, { VariantId: variantId, ProductId: productId, OwnerId: owner.OwnerId,
          Label: f.variantLabel || 'Standard', Price: f.price, SKU: f.sku || '', StockQty: stock, Status: 'active',
          Barcode: f.barcode || '', ExternalId: f.externalId || '', CostPrice: f.costPrice === undefined ? '' : f.costPrice,
          ReorderLevel: f.reorderLevel === undefined ? '' : f.reorderLevel, ReorderQty: f.reorderQty === undefined ? '' : f.reorderQty,
          ReservedQty: '', LastSyncedAt: now });
        if (stock !== '') {
          moves.push({ OwnerId: owner.OwnerId, ProductId: productId, VariantId: variantId, Quantity: stock, MovementType: 'INITIAL_STOCK',
            PreviousStock: '', NewStock: stock, PreviousReserved: 0, NewReserved: 0, Source: meta.source, ReferenceId: meta.syncId,
            UserId: owner.OwnerId, Notes: 'New from import line ' + it.line });
        }
      });
      created++;
    });
  }
  recordStockMovements(moves);
  invalidateCache([storeProductsCacheKey(owner.StoreSlug), storeListCacheKey(), topProductsCacheKey()]);
  return { updated: plan.updates.length, created: created };
}

function recordSyncJob(owner, job) {
  job.OwnerId = owner.OwnerId;
  job.CompletedAt = job.CompletedAt || nowIso();
  appendRowFromObject(getSyncJobsSheet(), job);
}

function markConnectionSynced(owner, connectionId, status, error) {
  if (!connectionId) return;
  var sheet = SpreadsheetApp.getActive().getSheetByName('InventoryConnections');
  var row = sheet ? findRowById(sheet, 'ConnectionId', String(connectionId)) : null;
  if (!row || row.OwnerId !== owner.OwnerId) return;
  updateRowFromObject(sheet, row.__row, { LastSyncAt: nowIso(), LastSyncStatus: status, LastError: String(error || '').slice(0, 300), UpdatedAt: nowIso() });
}

/** body.limit. The seller's sync history, newest first. */
function actionListSyncJobs(owner, body) {
  var sheet = SpreadsheetApp.getActive().getSheetByName('SyncJobs');
  var rows = sheet ? sheetToObjects(sheet).filter(function (j) { return j.OwnerId === owner.OwnerId; }) : [];
  rows.reverse();
  var limit = Math.min(50, Math.max(1, Number(body && body.limit) || 20));
  return ok({ jobs: rows.slice(0, limit).map(function (j) {
    var summary = {};
    try { summary = JSON.parse(j.SummaryJson || '{}'); } catch (e) { summary = {}; }
    return { syncId: j.SyncId, connectorType: j.ConnectorType, direction: j.Direction, startedAt: j.StartedAt, completedAt: j.CompletedAt,
      read: Number(j.RecordsRead) || 0, created: Number(j.RecordsCreated) || 0, updated: Number(j.RecordsUpdated) || 0,
      skipped: Number(j.RecordsSkipped) || 0, failed: Number(j.RecordsFailed) || 0, conflicts: Number(j.Conflicts) || 0,
      status: j.Status, summary: summary };
  }) });
}

/**
 * The seller's stock as rows for a CSV download - in the same columns the
 * importer understands, so the file round-trips (edit it, import it back,
 * matched by Mwakete ID).
 */
function actionExportInventoryRows(owner) {
  var ctx = sellerImportContext(owner);
  var headers = ['Mwakete ID', 'SKU', 'Barcode', 'External ID', 'Product', 'Variety', 'Stock on hand', 'Held by orders', 'Available',
    'Selling price', 'Cost price', 'Low-stock level', 'Reorder quantity'];
  var rows = ctx.variants.map(function (v) {
    var p = ctx.products[v.ProductId];
    var tracked = isStockTracked(v);
    return [v.VariantId, v.SKU || '', v.Barcode || '', v.ExternalId || '', p ? p.Name : '', v.Label,
      tracked ? physicalOf(v) : '', reservedOf(v), tracked ? availableOf(v) : '', Number(v.Price) || '',
      v.CostPrice === '' || v.CostPrice == null ? '' : Number(v.CostPrice), v.ReorderLevel === '' || v.ReorderLevel == null ? '' : Number(v.ReorderLevel),
      v.ReorderQty === '' || v.ReorderQty == null ? '' : Number(v.ReorderQty)];
  }).sort(function (a, b) { return String(a[4]).localeCompare(String(b[4])) || String(a[5]).localeCompare(String(b[5])); });
  return ok({ headers: headers, rows: rows,
    mapping: { 'Mwakete ID': 'mwaketeId', 'SKU': 'sku', 'Barcode': 'barcode', 'External ID': 'externalId', 'Product': 'productName',
      'Variety': 'variantLabel', 'Stock on hand': 'physicalStock', 'Selling price': 'price', 'Cost price': 'costPrice',
      'Low-stock level': 'reorderLevel', 'Reorder quantity': 'reorderQty' } });
}
