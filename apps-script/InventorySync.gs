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
  'Status', 'LastSyncAt', 'LastSyncStatus', 'LastError', 'CreatedAt', 'UpdatedAt', 'SnapshotJson'];
// SnapshotJson: { variantId: stock both sides agreed on at the last sync } -
// how two-way sync tells "changed on Mwakete" from "changed in the sheet".
var SYNC_CONFLICT_HEADERS = ['ConflictId', 'OwnerId', 'ConnectionId', 'SyncId', 'VariantId', 'Field', 'ExternalValue', 'MwaketeValue',
  'Line', 'Status', 'CreatedAt', 'ResolvedAt'];
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
  googleSheets: {
    label: 'Google Sheets',
    // The seller shares their sheet with Mwakete's Google account (owner
    // decision) - no passwords or keys are stored, only the sheet's ID.
    // MWAKETE_SHARE_EMAIL (Script Property) is that account's address, shown
    // to sellers; until it is set this connector is not offered.
    configured: function () { return !!mwaketeShareEmail(); },
    canWrite: true,
    readRows: function (conn, input) {
      var opened = openSellerSheet(conn && conn.settings ? conn.settings : (input && input.settings) || {});
      if (opened.error) return opened;
      var tab = opened.tab;
      var headerRow = opened.headerRow;
      var lastRow = tab.getLastRow();
      var lastCol = tab.getLastColumn();
      if (lastRow < headerRow || lastCol === 0) return { error: 'The tab "' + tab.getName() + '" is empty. Put your column names in row ' + headerRow + '.' };
      if (lastRow - headerRow > IMPORT_MAX_ROWS) return { error: 'That tab has ' + (lastRow - headerRow) + ' rows. At most ' + IMPORT_MAX_ROWS + ' can be synced.' };
      // Display values: what the seller sees, the same as a CSV of the sheet.
      var grid = tab.getRange(headerRow, 1, lastRow - headerRow + 1, lastCol).getDisplayValues();
      return { headers: grid[0].map(function (h) { return String(h).trim(); }), rows: grid.slice(1), firstLine: headerRow + 1 };
    },
    // writes: [{ line, value }] into the column mapped to stock on hand.
    writeStock: function (conn, writes, stockHeader) {
      var opened = openSellerSheet(conn.settings || {});
      if (opened.error) return opened;
      var headers = opened.tab.getRange(opened.headerRow, 1, 1, opened.tab.getLastColumn()).getDisplayValues()[0].map(function (h) { return String(h).trim(); });
      var col = headers.indexOf(stockHeader) + 1;
      if (!col) return { error: 'The column "' + stockHeader + '" is no longer in your sheet, so stock could not be written back.' };
      writes.forEach(function (w) { opened.tab.getRange(w.line, col).setValue(w.value); });
      return { written: writes.length };
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

function mwaketeShareEmail() {
  return String(PropertiesService.getScriptProperties().getProperty('MWAKETE_SHARE_EMAIL') || '').trim();
}

/** Pure: the spreadsheet ID out of a pasted link (or an ID pasted on its own). */
function spreadsheetIdFrom(raw) {
  var s = String(raw || '').trim();
  var m = s.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]{20,})/);
  if (m) return m[1];
  return /^[a-zA-Z0-9_-]{20,}$/.test(s) ? s : '';
}

/** Opens a seller's sheet + tab, turning Google's errors into ones a seller can act on. */
function openSellerSheet(settings) {
  var id = spreadsheetIdFrom(settings.spreadsheetId || settings.url);
  if (!id) return { error: 'That doesn\'t look like a Google Sheets link. Open your sheet and copy the address from the browser.' };
  var ss;
  try {
    ss = SpreadsheetApp.openById(id);
  } catch (e) {
    return { error: 'Mwakete can\'t open that sheet yet. In the sheet, press Share and add ' + mwaketeShareEmail() +
      ' (Editor if Mwakete should write stock back, Viewer to only read). Your Mwakete stock has not been changed.' };
  }
  var tab = settings.sheetName ? ss.getSheetByName(String(settings.sheetName)) : ss.getSheets()[0];
  if (!tab) return { error: 'There is no tab called "' + settings.sheetName + '" in that sheet any more. Choose the tab again.' };
  var headerRow = Math.max(1, Math.min(50, parseInt(settings.headerRow, 10) || 1));
  return { ss: ss, tab: tab, headerRow: headerRow, id: id };
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
function getSyncConflictsSheet() { return getSheetCreating('SyncConflicts', SYNC_CONFLICT_HEADERS); }

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
function normalizeImportRows(headers, rows, mapping, firstLine) {
  var cols = headers.map(function (h) { return mapping[h] || ''; });
  var start = firstLine || 2;
  return rows.map(function (row, i) {
    var rec = { line: i + start, fields: {}, errors: [] };
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
  // mode: 'import' (their system is master), 'export' (Mwakete is master),
  // 'twoWay' (stock both ways; a change on both sides is a conflict to decide).
  var mode = opts.mode || 'import';
  var snapshot = opts.snapshot || {};
  var plan = { mode: mode, updates: [], newItems: [], unmatched: [], errors: [], conflicts: [], writes: [], syncConflicts: [], agreed: {}, unchanged: 0,
    counts: { read: records.length, existing: 0, stockChanges: 0, priceChanges: 0, otherChanges: 0, newProducts: 0, unmatched: 0, errors: 0, conflicts: 0, writes: 0, syncConflicts: 0 } };
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
    var importStock = function (value, was) {
      if (value < reservedOf(v)) {
        plan.conflicts.push({ line: rec.line, variantId: v.VariantId, name: nameOf(v),
          message: 'File says ' + value + ' but ' + reservedOf(v) + ' are held by open orders on Mwakete. Stock left at ' + (was === null ? 'not tracked' : was) + '.' });
        return false;
      }
      change.set.StockQty = value; change.before.StockQty = was;
      return true;
    };
    var mine = isStockTracked(v) ? physicalOf(v) : null;
    var theirs = f.physicalStock;
    if (theirs !== undefined) {
      if (mode === 'import') {
        if (mine !== theirs && importStock(theirs, mine)) plan.agreed[v.VariantId] = theirs;
        else if (mine === theirs) plan.agreed[v.VariantId] = mine;
      } else if (mode === 'export') {
        if (mine !== null && mine !== theirs) plan.writes.push({ line: rec.line, variantId: v.VariantId, name: nameOf(v), value: mine, before: theirs });
        if (mine !== null) plan.agreed[v.VariantId] = mine;
      } else {
        var base = snapshot[v.VariantId];
        if (mine === theirs) plan.agreed[v.VariantId] = mine;
        else if (mine === null) { if (importStock(theirs, mine)) plan.agreed[v.VariantId] = theirs; }
        else if (base !== undefined && mine === base) { if (importStock(theirs, mine)) plan.agreed[v.VariantId] = theirs; }
        else if (base !== undefined && theirs === base) {
          plan.writes.push({ line: rec.line, variantId: v.VariantId, name: nameOf(v), value: mine, before: theirs });
          plan.agreed[v.VariantId] = mine;
        } else {
          plan.syncConflicts.push({ line: rec.line, variantId: v.VariantId, name: nameOf(v), external: theirs, mwakete: mine,
            message: base === undefined
              ? 'First sync: your sheet says ' + theirs + ', Mwakete says ' + mine + '. Choose which is right.'
              : 'Changed in both places since the last sync: sheet ' + base + ' → ' + theirs + ', Mwakete ' + base + ' → ' + mine + '.' });
        }
      }
    }
    // Mwakete is master in 'export': nothing else comes in from their side.
    if (mode === 'export') {
      var wrote = plan.writes.length && plan.writes[plan.writes.length - 1].variantId === v.VariantId;
      if (!wrote) plan.unchanged++;
      return;
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
  plan.counts.writes = plan.writes.length;
  plan.counts.syncConflicts = plan.syncConflicts.length;
  plan.counts.unchanged = plan.unchanged;
  return plan;
}

/** Pure: a short fingerprint of what a plan will do - apply must reproduce it exactly. */
function importPlanToken(plan) {
  var basis = JSON.stringify({
    u: plan.updates.map(function (c) { return [c.variantId, c.set]; }),
    w: plan.writes.map(function (w) { return [w.variantId, w.line, w.value]; }),
    c: plan.syncConflicts.map(function (x) { return [x.variantId, x.external, x.mwakete]; }),
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

/** Loads one of this seller's saved connections (parsed), or null. */
function loadOwnConnection(owner, connectionId) {
  if (!connectionId) return null;
  var sheet = SpreadsheetApp.getActive().getSheetByName('InventoryConnections');
  var row = sheet ? findRowById(sheet, 'ConnectionId', String(connectionId)) : null;
  if (!row || row.OwnerId !== owner.OwnerId || row.Status === 'disconnected') return null;
  var parse = function (t, d) { try { return JSON.parse(t || '') || d; } catch (e) { return d; } };
  return { row: row, sheet: sheet, id: row.ConnectionId, type: row.Type, settings: parse(row.SettingsJson, {}), mapping: parse(row.MappingJson, {}),
    mode: row.Mode || 'import', snapshot: parse(row.SnapshotJson, {}), lastSyncAt: row.LastSyncAt || '' };
}

/**
 * Reads + plans. body: { type, headers, rows (CSV), settings (Sheets), mapping,
 * mode, createNew, category } or { connectionId } to use a saved source as-is.
 */
function planFromRequest(owner, body) {
  var conn = null;
  if (body.connectionId) {
    conn = loadOwnConnection(owner, body.connectionId);
    if (!conn) return { error: 'That saved source was not found.' };
  }
  var type = conn ? conn.type : String(body.type || 'csv');
  var connector = connectorFor(type);
  if (!connector) return { error: 'Unknown source.' };
  if (!connector.configured()) return { error: connector.label + ' is not connected to Mwakete yet.' };
  var connArg = conn || (body.settings ? { settings: body.settings } : null);
  var data = connector.readRows(connArg, body);
  if (data.error) return { error: data.error };
  if (data.rows.length > IMPORT_MAX_ROWS) return { error: 'That file has ' + data.rows.length + ' rows. At most ' + IMPORT_MAX_ROWS + ' per import - split it into smaller files.' };
  // A saved source keeps its matching unless the request brings a new one.
  var mapping = body.mapping && Object.keys(body.mapping).length ? body.mapping : (conn ? conn.mapping : {});
  var mErr = mappingError(mapping, data.headers);
  if (mErr) return { error: mErr };
  var mode = ['import', 'export', 'twoWay'].indexOf(body.mode) !== -1 ? body.mode : (conn ? conn.mode : 'import');
  if (mode !== 'import' && !connector.canWrite) return { error: connector.label + ' can only be read from, so it can only bring stock into Mwakete.' };
  if (mode !== 'import' && !Object.keys(mapping).some(function (h) { return mapping[h] === 'physicalStock'; })) {
    return { error: 'To send stock back, match the column that holds your stock on hand.' };
  }
  var category = categoryIdOf(body.category);
  if (body.createNew) {
    if (!body.category || CATEGORY_IDS.indexOf(String(body.category)) === -1) return { error: 'Choose a category for the new products.' };
    if (category === 'food' && !canListFood(owner)) return { error: 'Food & Groceries is for wholesaler and distributor stores only. Choose another category for the new products.' };
  }
  var ctx = sellerImportContext(owner);
  var records = normalizeImportRows(data.headers, data.rows, mapping, data.firstLine);
  var plan = buildImportPlan(records, ctx.variants, ctx.products,
    { createNew: !!body.createNew && mode !== 'export', category: category, mode: mode, snapshot: conn ? conn.snapshot : {} });
  var stockHeader = Object.keys(mapping).filter(function (h) { return mapping[h] === 'physicalStock'; })[0] || '';
  return { plan: plan, ctx: ctx, type: type, mapping: mapping, mode: mode, conn: conn, connector: connector, stockHeader: stockHeader,
    settings: conn ? conn.settings : (body.settings || {}) };
}


function planPreviewShape(plan) {
  var cap = function (list, n) { return list.slice(0, n); };
  return {
    counts: plan.counts,
    updates: cap(plan.updates, 50).map(function (c) { return { line: c.line, name: c.name, matchedBy: c.matchedBy, set: c.set, before: c.before }; }),
    newProducts: cap(plan.newProducts, 50).map(function (p) { return { name: p.name, category: p.category, varieties: p.items.length }; }),
    unmatched: cap(plan.unmatched, 50),
    errors: cap(plan.errors, 50),
    conflicts: cap(plan.conflicts, 50),
    writes: cap(plan.writes, 50),
    syncConflicts: cap(plan.syncConflicts, 50),
    mode: plan.mode
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
  return ok({ connectors: available, connections: mine.map(publicConnection), shareEmail: mwaketeShareEmail() });
}

function publicConnection(c) {
  var mapping = {}; var settings = {};
  try { mapping = JSON.parse(c.MappingJson || '{}'); } catch (e) { mapping = {}; }
  try { settings = JSON.parse(c.SettingsJson || '{}'); } catch (e) { settings = {}; }
  return { connectionId: c.ConnectionId, type: c.Type, name: c.Name, mapping: mapping, settings: settings, mode: c.Mode,
    status: c.Status, lastSyncAt: c.LastSyncAt || '', lastSyncStatus: c.LastSyncStatus || '', lastError: c.LastError || '',
    nextSyncAt: settings.autoSync && c.LastSyncAt && c.Type === 'googleSheets' ? new Date(new Date(c.LastSyncAt).getTime() + 3600000).toISOString() : '' };
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
  if (type === 'googleSheets') {
    settings = cleanSheetSettings(settings);
    var opened = openSellerSheet(settings);
    if (opened.error) return fail(opened.error);
    settings.sheetName = opened.tab.getName();
  }
  if (mode !== 'import' && !connectorFor(type).canWrite) return fail(connectorFor(type).label + ' can only bring stock into Mwakete.');
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
 * (+ connectionId). Re-plans under the lock; if anything moved in between (an
 * order, another edit), refuses and asks for a new preview.
 */
function actionApplyInventoryImport(owner, body) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var r = planFromRequest(owner, body);
    if (r.error) return fail(r.error);
    if (!body.planToken || importPlanToken(r.plan) !== body.planToken) {
      return fail('Your stock changed since the preview (for example a new order). Nothing was changed - please preview again.');
    }
    var out = runSyncPlan(owner, r, { trigger: 'manual' });
    return ok(out);
  } finally {
    lock.releaseLock();
  }
}

/**
 * Carries out a plan for one source: Mwakete-side changes (ledger-backed),
 * stock written back to their sheet, two-way conflicts recorded for the
 * seller to decide, the agreed snapshot, the history row. Caller holds the lock.
 */
function runSyncPlan(owner, r, meta) {
  var started = nowIso();
  var syncId = newId('sync');
  var plan = r.plan;
  var result = applyImportPlan(owner, plan, r.ctx, { syncId: syncId, source: r.type });

  var writeError = '';
  var written = 0;
  if (plan.writes.length) {
    var w = r.connector.writeStock ? r.connector.writeStock(r.conn || { settings: r.settings }, plan.writes, r.stockHeader) : { error: 'This source can\'t be written to.' };
    if (w.error) {
      writeError = w.error;
      // Not written, so these were not agreed - they'll be retried next sync.
      plan.writes.forEach(function (x) { delete plan.agreed[x.variantId]; });
    } else {
      written = w.written;
    }
  }

  var newConflicts = recordSyncConflicts(owner, r.conn, syncId, plan.syncConflicts);

  if (r.conn) {
    var snap = r.conn.snapshot || {};
    Object.keys(plan.agreed).forEach(function (id) { snap[id] = plan.agreed[id]; });
    var snapText = JSON.stringify(snap);
    if (snapText.length > 45000) snapText = '{}'; // past a sheet cell's limit: start fresh rather than corrupt it
    ensureColumn(r.conn.sheet, 'SnapshotJson');
    updateRowFromObject(r.conn.sheet, r.conn.row.__row, { SnapshotJson: snapText });
  }

  var c = plan.counts;
  var status = writeError && !result.updated && !written ? SYNC_STATUS.FAILED
    : c.syncConflicts ? SYNC_STATUS.CONFLICT
    : (writeError || c.errors || c.conflicts || c.unmatched) ? SYNC_STATUS.PARTIAL : SYNC_STATUS.SUCCESS;
  recordSyncJob(owner, {
    SyncId: syncId, ConnectionId: r.conn ? r.conn.id : '', ConnectorType: r.type, Direction: r.mode, StartedAt: started,
    RecordsRead: c.read, RecordsCreated: result.created, RecordsUpdated: result.updated + written,
    RecordsSkipped: c.unchanged + c.unmatched, RecordsFailed: c.errors + (writeError ? plan.writes.length : 0),
    Conflicts: c.conflicts + c.syncConflicts, Status: status, ErrorCount: c.errors + (writeError ? 1 : 0),
    SummaryJson: JSON.stringify({ trigger: meta.trigger, writeError: writeError, written: written,
      errors: plan.errors.slice(0, 20), conflicts: plan.conflicts.slice(0, 20).concat(plan.syncConflicts.slice(0, 20)), unmatched: plan.unmatched.slice(0, 20) })
  });
  if (r.conn) markConnectionSynced(owner, r.conn.id, status, writeError);
  return { syncId: syncId, status: status, created: result.created, updated: result.updated, written: written,
    writeError: writeError, newConflicts: newConflicts, counts: c };
}

/** Opens a conflict row per item, unless the same disagreement is already open or was set aside. */
function recordSyncConflicts(owner, conn, syncId, list) {
  if (!list.length) return 0;
  var sheet = getSyncConflictsSheet();
  var existing = sheetToObjects(sheet).filter(function (x) { return x.OwnerId === owner.OwnerId && x.ConnectionId === (conn ? conn.id : ''); });
  var added = 0;
  list.forEach(function (k) {
    var same = existing.filter(function (x) {
      return x.VariantId === k.variantId && (x.Status === 'open' || x.Status === 'kept') &&
        Number(x.ExternalValue) === k.external && Number(x.MwaketeValue) === k.mwakete;
    })[0];
    if (same) return;
    // An older open conflict for the item is replaced by the current numbers.
    existing.filter(function (x) { return x.VariantId === k.variantId && x.Status === 'open'; }).forEach(function (x) {
      updateRowFromObject(sheet, x.__row, { Status: 'superseded', ResolvedAt: nowIso() });
    });
    appendRowFromObject(sheet, { ConflictId: newId('cfl'), OwnerId: owner.OwnerId, ConnectionId: conn ? conn.id : '', SyncId: syncId,
      VariantId: k.variantId, Field: 'stock', ExternalValue: k.external, MwaketeValue: k.mwakete, Line: k.line, Status: 'open', CreatedAt: nowIso() });
    added++;
  });
  return added;
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

  var created = 0, held = 0;
  if (plan.newProducts.length) {
    var productsSheet = getSheet('Products');
    ensureColumn(productsSheet, 'ListingType');
    ['RequestedStatus', 'ReviewId'].forEach(function (h) { ensureColumn(productsSheet, h); });
    var register = getListingRegister();
    plan.newProducts.forEach(function (np) {
      var productId = newId('prod');
      // Listing checks (ListingRules.gs): an imported name that clearly does
      // not belong in the chosen category is created held, with a case for an
      // admin, rather than going live.
      var input = { name: np.name, description: '', categoryId: np.category, subcategoryId: '', listingType: 'product',
        optionLabels: np.items.map(function (it) { return it.fields.variantLabel || ''; }) };
      var check = validateListing(input, register);
      var hold = check.blocked && check.overridable;
      appendRowFromObject(productsSheet, { ProductId: productId, OwnerId: owner.OwnerId, StoreSlug: owner.StoreSlug, Name: np.name,
        Description: '', Category: np.category, ListingType: 'product', ImageUrl: '', ImageFileId: '', ImageUrl2: '', ImageFileId2: '',
        Status: hold ? 'review' : 'active', RequestedStatus: hold ? 'active' : '', SortOrder: 0, CreatedAt: now, UpdatedAt: now });
      if (hold) {
        var reviewId = upsertListingCase(owner, productId, input, check, { disputed: false, role: 'import', sellerNote: 'Created by an inventory import' });
        var row = findRowById(productsSheet, 'ProductId', productId);
        if (row) updateRowFromObject(productsSheet, row.__row, { ReviewId: reviewId });
        held++;
      }
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
  return { updated: plan.updates.length, created: created, held: held };
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
    return { syncId: j.SyncId, connectionId: j.ConnectionId, connectorType: j.ConnectorType, direction: j.Direction, startedAt: j.StartedAt, completedAt: j.CompletedAt,
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

/* ==================== Google Sheets: setup, Sync now, conflicts, schedule ==================== */

/** body.settings { url|spreadsheetId, sheetName, headerRow }. Opens the sheet; returns its tabs, columns and a few rows. */
function actionTestSheetConnection(owner, body) {
  if (!INVENTORY_CONNECTORS.googleSheets.configured()) return fail('Google Sheets is not connected to Mwakete yet.');
  var settings = body.settings || {};
  var opened = openSellerSheet(settings);
  if (opened.error) return ok({ connected: false, shareEmail: mwaketeShareEmail(), error: opened.error });
  var data = INVENTORY_CONNECTORS.googleSheets.readRows({ settings: { spreadsheetId: opened.id, sheetName: opened.tab.getName(), headerRow: opened.headerRow } }, {});
  return ok({
    connected: true, shareEmail: mwaketeShareEmail(), spreadsheetId: opened.id, title: opened.ss.getName(),
    tabs: opened.ss.getSheets().map(function (t) { return t.getName(); }), sheetName: opened.tab.getName(), headerRow: opened.headerRow,
    headers: data.error ? [] : data.headers, sample: data.error ? [] : data.rows.slice(0, 3), rowCount: data.error ? 0 : data.rows.length,
    error: data.error || ''
  });
}

function cleanSheetSettings(settings) {
  settings = settings || {};
  return {
    spreadsheetId: spreadsheetIdFrom(settings.spreadsheetId || settings.url),
    sheetName: String(settings.sheetName || '').slice(0, 100),
    headerRow: Math.max(1, Math.min(50, parseInt(settings.headerRow, 10) || 1)),
    autoSync: !!settings.autoSync
  };
}

/** body.connectionId. Runs a saved source now. The very first run must go through Preview. */
function actionSyncNow(owner, body) {
  var conn = loadOwnConnection(owner, body.connectionId);
  if (!conn) return fail('That saved source was not found.');
  if (!conn.lastSyncAt) return fail('Preview this source once and apply it before syncing - so you see the first changes before they happen.');
  if (conn.type === 'csv') return fail('A CSV is a one-off file. Choose the new file and preview it.');
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var r = planFromRequest(owner, { connectionId: conn.id });
    if (r.error) {
      recordSyncFailure(owner, conn, r.error, 'manual');
      return fail(r.error);
    }
    return ok(runSyncPlan(owner, r, { trigger: 'syncNow' }));
  } finally {
    lock.releaseLock();
  }
}

function recordSyncFailure(owner, conn, message, trigger) {
  recordSyncJob(owner, { SyncId: newId('sync'), ConnectionId: conn.id, ConnectorType: conn.type, Direction: conn.mode, StartedAt: nowIso(),
    RecordsRead: 0, RecordsCreated: 0, RecordsUpdated: 0, RecordsSkipped: 0, RecordsFailed: 0, Conflicts: 0, Status: SYNC_STATUS.FAILED, ErrorCount: 1,
    SummaryJson: JSON.stringify({ trigger: trigger, writeError: message, errors: [{ line: 0, message: message }] }) });
  markConnectionSynced(owner, conn.id, SYNC_STATUS.FAILED, message);
}

/** The seller's open stock conflicts, with item names. */
function actionListSyncConflicts(owner) {
  var sheet = SpreadsheetApp.getActive().getSheetByName('SyncConflicts');
  var rows = sheet ? sheetToObjects(sheet).filter(function (x) { return x.OwnerId === owner.OwnerId && x.Status === 'open'; }) : [];
  if (!rows.length) return ok({ conflicts: [] });
  var ctx = sellerImportContext(owner);
  var byId = {};
  ctx.variants.forEach(function (v) { byId[v.VariantId] = v; });
  return ok({ conflicts: rows.map(function (x) {
    var v = byId[x.VariantId];
    var p = v ? ctx.products[v.ProductId] : null;
    return { conflictId: x.ConflictId, connectionId: x.ConnectionId, variantId: x.VariantId, name: (p ? p.Name : '') + (v ? ' - ' + v.Label : ''),
      external: Number(x.ExternalValue), mwakete: Number(x.MwaketeValue), line: x.Line, createdAt: x.CreatedAt,
      reservedNow: v ? reservedOf(v) : 0 };
  }) });
}

/**
 * body.conflictId, body.choice: 'external' | 'mwakete' | 'keep'.
 * Choosing a side moves the agreed snapshot so that side counts as the
 * change, then syncs straight away - the same safe path as every sync, so a
 * value that moved again since is caught rather than overwritten.
 */
function actionResolveSyncConflict(owner, body) {
  var choice = String(body.choice || '');
  if (['external', 'mwakete', 'keep'].indexOf(choice) === -1) return fail('Choose which number to keep.');
  var sheet = SpreadsheetApp.getActive().getSheetByName('SyncConflicts');
  var row = sheet ? findRowById(sheet, 'ConflictId', String(body.conflictId || '')) : null;
  if (!row || row.OwnerId !== owner.OwnerId || row.Status !== 'open') return fail('That conflict was not found or is already settled.');
  if (choice === 'keep') {
    updateRowFromObject(sheet, row.__row, { Status: 'kept', ResolvedAt: nowIso() });
    return ok({ status: 'kept' });
  }
  var conn = loadOwnConnection(owner, row.ConnectionId);
  if (!conn) return fail('The source for this conflict is no longer connected.');
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    // Snapshot = the side that loses, so the chosen side reads as "the one that changed".
    conn.snapshot[row.VariantId] = choice === 'external' ? Number(row.MwaketeValue) : Number(row.ExternalValue);
    ensureColumn(conn.sheet, 'SnapshotJson');
    updateRowFromObject(conn.sheet, conn.row.__row, { SnapshotJson: JSON.stringify(conn.snapshot) });
    updateRowFromObject(sheet, row.__row, { Status: choice === 'external' ? 'resolvedExternal' : 'resolvedMwakete', ResolvedAt: nowIso() });
    var r = planFromRequest(owner, { connectionId: conn.id });
    if (r.error) return fail(r.error + ' Your choice is saved and will apply on the next sync.');
    return ok(runSyncPlan(owner, r, { trigger: 'conflict' }));
  } finally {
    lock.releaseLock();
  }
}

/**
 * Hourly, from runReminderSweep: every Google Sheets source with automatic
 * sync on, that has had its first (previewed) sync. Stops before Apps
 * Script's 6-minute limit; whatever is left runs next hour.
 */
function runScheduledInventorySyncs() {
  var sheet = SpreadsheetApp.getActive().getSheetByName('InventoryConnections');
  if (!sheet || !INVENTORY_CONNECTORS.googleSheets.configured()) return 0;
  var startedMs = Date.now();
  var owners = {};
  sheetToObjects(getSheet('Owners')).forEach(function (o) { owners[o.OwnerId] = o; });
  var due = sheetToObjects(sheet).filter(function (c) {
    var settings = {};
    try { settings = JSON.parse(c.SettingsJson || '{}'); } catch (e) { settings = {}; }
    return c.Type === 'googleSheets' && c.Status === 'connected' && settings.autoSync && c.LastSyncAt;
  }).sort(function (a, b) { return String(a.LastSyncAt).localeCompare(String(b.LastSyncAt)); });
  var ran = 0;
  for (var i = 0; i < due.length; i++) {
    if (Date.now() - startedMs > 4 * 60 * 1000) break;
    var owner = owners[due[i].OwnerId];
    if (!owner || owner.Status === 'closed') continue;
    var lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try {
      var r = planFromRequest(owner, { connectionId: due[i].ConnectionId });
      if (r.error) recordSyncFailure(owner, loadOwnConnection(owner, due[i].ConnectionId), r.error, 'schedule');
      else runSyncPlan(owner, r, { trigger: 'schedule' });
      ran++;
    } catch (e) {
      Logger.log('scheduled sync failed for ' + due[i].ConnectionId + ': ' + e);
    } finally {
      lock.releaseLock();
    }
  }
  return ran;
}
