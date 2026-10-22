/**
 * POS & Inventory Integration Hub (Oct 2026). Design: docs/pos-integration-architecture.md.
 * Audit of what already existed: docs/pos-integration-audit.md.
 *
 * THIS EXTENDS THE EXISTING INVENTORY SYNC (InventorySync.gs); it is not a
 * second engine. Connections live in the same InventoryConnections tab, stock
 * changes go through the same ledger (recordStockMovements) and the same
 * Variants.StockQty / ReservedQty model. What it adds:
 *
 *  - ONE shared stock-delta function (applyStockDelta) used by external sales,
 *    returns and the native POS, so there is a single inventory model.
 *  - A SIGNED PUSH API (posPush): any POS or middleware that can send JSON can
 *    post sales, returns and stock counts. HMAC-SHA256, timestamp window,
 *    replay and duplicate protection. (Apps Script cannot read request
 *    headers, so the signature travels in the body.)
 *  - Persisted, auditable, connection-scoped PRODUCT MAPPINGS (IntegrationMappings).
 *  - A per-event LEDGER (IntegrationEvents) = the activity log, the idempotency
 *    record, the retry queue and the reconciliation queue.
 *  - EXTERNAL SALES (ExternalSales), unique per connection + external id.
 *  - An OUTBOX for exporting Mwakete orders to a seller's own URL (IntegrationOutbox.gs).
 *
 * RULES THAT MATTER
 *  - Off by default: Script Property POS_HUB = on enables it. Nothing here
 *    changes existing inventory behaviour when it is off.
 *  - A physical sale is a FACT: it is applied as a delta and never rejected
 *    because Mwakete's number was wrong. If it takes stock below what open
 *    orders reserved, or more than Mwakete thought it had, it is applied
 *    (floor 0) and an ATTENTION item is raised. Nothing is silently dropped.
 *  - A stock COUNT (snapshot) is never treated as a movement. It is compared
 *    with Mwakete and any difference goes to the seller to accept or keep.
 *  - A sale is all-or-nothing: if any line cannot be matched to exactly one of
 *    the seller's own varieties, no stock moves and the sale waits in the
 *    review queue until it is mapped and retried.
 *  - Never writes to Orders. A POS sale cannot mark an online order paid,
 *    fulfilled or cancelled, whatever reference it carries.
 *  - Secrets live in Script Properties (POSSECRET_<connectionId>), shown to
 *    the seller once, never returned by a list action, never logged.
 *
 * TABS (created on first use, additive, header-mapped):
 *   IntegrationMappings, IntegrationEvents, ExternalSales  (+ IntegrationOutbox in IntegrationOutbox.gs)
 */

var HUB_MAPPING_HEADERS = ['MappingId', 'OwnerId', 'ConnectionId', 'Kind', 'ExternalKey', 'ExternalVariantId', 'ExternalProductId', 'ExternalSku',
  'ExternalBarcode', 'ExternalLabel', 'VariantId', 'LocationId', 'Status', 'MatchedBy', 'Note', 'CreatedBy', 'CreatedAt', 'UpdatedAt', 'RetiredAt'];
var HUB_EVENT_HEADERS = ['EventId', 'OwnerId', 'ConnectionId', 'Provider', 'AccountKey', 'Direction', 'Type', 'ExternalId', 'Version', 'IdempotencyKey',
  'Status', 'Reference', 'CorrelationId', 'Attempts', 'ErrorCode', 'ErrorMessage', 'BeforeJson', 'AfterJson', 'PayloadJson', 'PayloadHash',
  'ReconStatus', 'ResolvedBy', 'ResolvedAt', 'CreatedAt', 'UpdatedAt'];
var HUB_SALE_HEADERS = ['ExternalSaleId', 'OwnerId', 'ConnectionId', 'Provider', 'AccountKey', 'ExternalTxnId', 'ExternalStoreId', 'ExternalRegisterId',
  'LocationId', 'OccurredAt', 'Version', 'Currency', 'Subtotal', 'Discount', 'Tax', 'Total', 'PaymentMethod', 'PaymentStatus', 'Status',
  'LinesJson', 'LinesHash', 'RefundedAmount', 'StockApplied', 'CreatedAt', 'UpdatedAt'];

// Event statuses. "Attention" ones need a person.
var HUB_ATTENTION = ['needs_mapping', 'conflict', 'failed', 'pending_parent', 'dead'];
var HUB_MAX_PAYLOAD = 60000;
var HUB_MAX_LINES = 200;
var HUB_TIMESTAMP_WINDOW_MS = 5 * 60 * 1000;
var HUB_RATE_PER_MINUTE = 120;
var HUB_EVENT_TYPES = ['ping', 'sale', 'refund', 'stock'];

function posHubEnabled() {
  return String(PropertiesService.getScriptProperties().getProperty('POS_HUB') || 'off').trim().toLowerCase() === 'on';
}

function hubOff() { return fail('The POS & Integrations feature is not switched on yet.'); }

/* ==================== Sheets ==================== */

var hubColumnsChecked = {};
function hubSheet(name, headers) {
  var sheet = getSheetCreating(name, headers);
  if (!hubColumnsChecked[name]) {
    headers.forEach(function (h) { ensureColumn(sheet, h); });
    hubColumnsChecked[name] = true;
  }
  return sheet;
}
function hubMappingsSheet() { return hubSheet('IntegrationMappings', HUB_MAPPING_HEADERS); }
function hubEventsSheet() { return hubSheet('IntegrationEvents', HUB_EVENT_HEADERS); }
function hubSalesSheet() { return hubSheet('ExternalSales', HUB_SALE_HEADERS); }

function hubRows(name) {
  var s = SpreadsheetApp.getActive().getSheetByName(name);
  return s ? sheetToObjects(s) : [];
}

function hubParse(text, fallback) {
  try { var v = JSON.parse(text || ''); return v === null || v === undefined ? fallback : v; } catch (e) { return fallback; }
}

/** Removes anything that looks like a secret from text that may reach a seller or a log. */
function hubSafeText(text, max) {
  var t = String(text == null ? '' : text);
  t = t.replace(/[A-Fa-f0-9]{32,}/g, '[hidden]').replace(/(secret|token|password|apikey|api_key|authorization)\s*[:=]\s*\S+/gi, '$1=[hidden]');
  return t.slice(0, max || 300);
}

/* ==================== Secrets and signatures ==================== */

function hubSecretKey(connectionId) { return 'POSSECRET_' + connectionId; }

function hubNewSecret() {
  return (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
}

function hubHmacHex(secret, message) {
  return bytesToHex(Utilities.computeHmacSha256Signature(String(message), String(secret)));
}

/** Compares two strings in time that does not depend on where they differ. */
function hubSafeEqual(a, b) {
  a = String(a || ''); b = String(b || '');
  var diff = a.length ^ b.length;
  var n = Math.max(a.length, b.length);
  for (var i = 0; i < n; i++) diff |= (a.charCodeAt(i % (a.length || 1)) || 0) ^ (b.charCodeAt(i % (b.length || 1)) || 0);
  return diff === 0 && a.length === b.length;
}

/** The text a sender signs: connectionId.timestamp.payload (payload = the exact JSON text sent). */
function hubSignedText(connectionId, timestamp, payloadText) {
  return connectionId + '.' + timestamp + '.' + payloadText;
}

function hubKeyId(secret) {
  return bytesToHex(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, 'keyid:' + secret)).slice(0, 8);
}

/* ==================== Connections ==================== */

var HUB_DEFAULT_RULES = { importSales: true, applyReturns: true, restock: 'when_flagged', snapshots: 'review', exportOrders: false, shareCustomerContact: false };

function hubConnectionRow(owner, connectionId) {
  var sheet = SpreadsheetApp.getActive().getSheetByName('InventoryConnections');
  var row = sheet && connectionId ? findRowById(sheet, 'ConnectionId', String(connectionId)) : null;
  if (!row || row.OwnerId !== owner.OwnerId) return null;
  return row;
}

function hubConn(row) {
  var settings = hubParse(row.SettingsJson, {});
  settings.rules = Object.assign({}, HUB_DEFAULT_RULES, settings.rules || {});
  return { row: row, sheet: SpreadsheetApp.getActive().getSheetByName('InventoryConnections'), id: row.ConnectionId, ownerId: row.OwnerId, name: row.Name,
    type: row.Type, status: row.Status, settings: settings, provider: settings.providerName || 'Mwakete push API', accountKey: settings.accountKey || 'default' };
}

function hubSaveSettings(conn, patch, extraRow) {
  var s = Object.assign({}, conn.settings, patch);
  var row = Object.assign({ SettingsJson: JSON.stringify(s), UpdatedAt: nowIso() }, extraRow || {});
  updateRowFromObject(conn.sheet, conn.row.__row, row);
  conn.settings = s;
}

/** Counts that drive the status badge. */
function hubCounts(connectionId) {
  var ev = hubRows('IntegrationEvents').filter(function (e) { return e.ConnectionId === connectionId; });
  var attention = ev.filter(function (e) { return HUB_ATTENTION.indexOf(e.Status) !== -1 && e.ReconStatus !== 'resolved'; });
  var out = hubRows('IntegrationOutbox').filter(function (o) { return o.ConnectionId === connectionId; });
  return {
    attention: attention.length,
    failed: attention.filter(function (e) { return e.Status === 'failed' || e.Status === 'dead'; }).length,
    needsMapping: attention.filter(function (e) { return e.Status === 'needs_mapping'; }).length,
    conflicts: attention.filter(function (e) { return e.Status === 'conflict'; }).length,
    pendingOut: out.filter(function (o) { return o.Status === 'pending'; }).length,
    deadOut: out.filter(function (o) { return o.Status === 'dead'; }).length,
    lastEventAt: ev.length ? ev.map(function (e) { return e.CreatedAt; }).sort().pop() : ''
  };
}

/**
 * The status shown to the seller, from facts and never from "the form was
 * saved": a connection is only "Connected" after a correctly signed signal
 * from the other system has actually arrived.
 */
function hubDisplayStatus(conn, counts) {
  if (conn.status === 'disconnected') return 'Disconnected';
  if (conn.status === 'paused') return 'Paused';
  if (!conn.settings.verifiedAt) return 'Waiting for first signal';
  if (counts.attention || counts.deadOut) return 'Attention required';
  if (counts.pendingOut) return 'Syncing';
  return 'Connected';
}

var HUB_CAPABILITIES = {
  pushApi: ['Receive sales', 'Receive returns and refunds', 'Receive stock counts (reviewed before applying)', 'Send new, cancelled and completed Mwakete orders to your URL', 'Product matching by ID, SKU or barcode'],
  csv: ['Import stock and prices from a file (previewed before applying)', 'Export stock to a file'],
  googleSheets: ['Read stock and prices from a shared sheet', 'Write stock back to the sheet', 'Automatic hourly sync']
};
var HUB_LIMITS = {
  pushApi: ['Your POS or a small relay must send the data: Mwakete does not log in to your POS.', 'Online card payments are not verified by Mwakete; sales are recorded as reported by your POS.'],
  csv: ['One-off: choose the file each time.', 'Cannot receive individual sales.'],
  googleSheets: ['Stock counts only: individual sales are not received.', 'Needs the sheet shared with Mwakete.']
};

function hubPublicConnection(row) {
  var conn = hubConn(row);
  var counts = hubCounts(conn.id);
  var s = conn.settings;
  return {
    connectionId: conn.id, type: conn.type, name: conn.name, provider: conn.provider, accountKey: conn.accountKey,
    status: conn.status, displayStatus: hubDisplayStatus(conn, counts),
    verifiedAt: s.verifiedAt || '', lastSignalAt: s.lastSignalAt || '', lastSyncAt: row.LastSyncAt || '', lastSyncStatus: row.LastSyncStatus || '',
    lastError: hubSafeText(row.LastError, 300), counts: counts, rules: s.rules, keyId: s.keyId || '',
    webhookUrlSet: !!s.webhookUrl, webhookHost: s.webhookUrl ? hubHost(s.webhookUrl) : '', locationMap: s.locationMap || {},
    capabilities: HUB_CAPABILITIES[conn.type] || [], limits: HUB_LIMITS[conn.type] || []
  };
}

function hubHost(url) {
  var m = String(url || '').match(/^https:\/\/([^\/:?#]+)/i);
  return m ? m[1].toLowerCase() : '';
}

/** https only, a public-looking name (no IPs, localhost or internal suffixes), standard port, no credentials. */
function hubUrlError(url) {
  var u = String(url || '').trim();
  if (!u) return '';
  if (u.length > 300) return 'That address is too long.';
  if (!/^https:\/\//i.test(u)) return 'The address must start with https://';
  if (/[\s<>"'\\]/.test(u)) return 'That address has characters that are not allowed.';
  var m = u.match(/^https:\/\/([^\/?#]*)/i);
  var authority = m ? m[1] : '';
  if (authority.indexOf('@') !== -1) return 'The address cannot contain a username or password.';
  if (/:\d+$/.test(authority) && !/:443$/.test(authority)) return 'Only the standard secure port is allowed.';
  var host = hubHost(u);
  if (!host || host.indexOf('.') === -1) return 'Use a full web address with a domain name.';
  if (/^\d+(\.\d+){3}$/.test(host) || host.indexOf(':') !== -1 || host.charAt(0) === '[') return 'Use a domain name, not an IP address.';
  if (/(^|\.)(localhost|local|internal|intranet|lan|home|corp|test|example|invalid)$/.test(host) || /\.(googleusercontent|script\.google)\.com$/.test(host)) return 'That address is not allowed.';
  return '';
}

function hubCleanRules(input, current) {
  var r = Object.assign({}, HUB_DEFAULT_RULES, current || {});
  if (!input || typeof input !== 'object') return r;
  ['importSales', 'applyReturns', 'exportOrders', 'shareCustomerContact'].forEach(function (k) { if (input[k] !== undefined) r[k] = input[k] === true; });
  if (['when_flagged', 'never', 'always'].indexOf(input.restock) !== -1) r.restock = input.restock;
  if (['review', 'ignore'].indexOf(input.snapshots) !== -1) r.snapshots = input.snapshots;
  return r;
}

function hubCleanLocationMap(owner, map) {
  var out = {};
  if (!map || typeof map !== 'object') return out;
  var locs = typeof ownLocations === 'function' ? ownLocations(owner.OwnerId).filter(function (l) { return l.Status !== 'archived'; }).map(function (l) { return l.LocationId; }) : [];
  Object.keys(map).slice(0, 50).forEach(function (k) {
    var key = String(k).trim().slice(0, 80);
    var loc = String(map[k] || '').trim();
    if (!key) return;
    if (loc === DEFAULT_LOCATION_ID || (loc && locs.indexOf(loc) !== -1 && isBulkSeller(owner))) out[key] = loc;
  });
  return out;
}

function hubInvalidateExportCache(ownerId) {
  try { CacheService.getScriptCache().remove('v1:poshub:export:' + ownerId); } catch (e) { /* best effort */ }
}

function actionPosHubStatus(owner) {
  if (!posHubEnabled()) return ok({ enabled: false });
  var sheet = SpreadsheetApp.getActive().getSheetByName('InventoryConnections');
  var mine = sheet ? sheetToObjects(sheet).filter(function (c) { return c.OwnerId === owner.OwnerId && c.Status !== 'disconnected'; }) : [];
  var connections = mine.map(function (row) {
    if (row.Type === 'pushApi') return hubPublicConnection(row);
    // The existing CSV / Google Sheets sources, shown here as they already are (their own page manages them).
    var c = typeof publicConnection === 'function' ? publicConnection(row) : {};
    var failed = row.LastSyncStatus === 'FAILED' || row.LastSyncStatus === 'CONFLICT' || row.LastSyncStatus === 'PARTIAL_SUCCESS';
    return { connectionId: row.ConnectionId, type: row.Type, name: row.Name, provider: (connectorFor(row.Type) || {}).label || row.Type, status: row.Status,
      displayStatus: row.LastSyncAt ? (failed ? 'Attention required' : 'Connected') : 'Waiting for first sync', lastSyncAt: row.LastSyncAt || '', lastSyncStatus: row.LastSyncStatus || '',
      lastError: hubSafeText(row.LastError, 300), counts: { attention: failed ? 1 : 0 }, capabilities: HUB_CAPABILITIES[row.Type] || [], limits: HUB_LIMITS[row.Type] || [], managedOn: 'inventory-sync.html', mode: c.mode || '' };
  });
  var attention = hubRows('IntegrationEvents').filter(function (e) { return e.OwnerId === owner.OwnerId && HUB_ATTENTION.indexOf(e.Status) !== -1 && e.ReconStatus !== 'resolved'; }).length;
  return ok({ enabled: true, connections: connections, attention: attention,
    connectors: [
      { type: 'pushApi', label: 'Any POS (signed push)', available: true, capabilities: HUB_CAPABILITIES.pushApi, limits: HUB_LIMITS.pushApi },
      { type: 'googleSheets', label: 'Google Sheets', available: INVENTORY_CONNECTORS.googleSheets.configured(), capabilities: HUB_CAPABILITIES.googleSheets, limits: HUB_LIMITS.googleSheets, managedOn: 'inventory-sync.html' },
      { type: 'csv', label: 'CSV file', available: true, capabilities: HUB_CAPABILITIES.csv, limits: HUB_LIMITS.csv, managedOn: 'inventory-sync.html' }
    ],
    pending: [{ label: 'Named POS products (Square, Loyverse, Shopify POS, Lightspeed, Odoo)', why: 'Needs an account to test with, and for webhooks signed in a header, a small relay. See the setup guide.' }],
    isBulkSeller: isBulkSeller(owner),
    locations: typeof ownLocations === 'function' && isBulkSeller(owner) ? ownLocations(owner.OwnerId).filter(function (l) { return l.Status !== 'archived'; }).map(function (l) { return { locationId: l.LocationId, name: l.Name }; }) : [] });
}

/** body: name, providerName, accountKey, rules. Returns the secret ONCE. */
function actionCreatePosConnection(owner, body) {
  if (!posHubEnabled()) return hubOff();
  var name = String(body.name || '').trim().slice(0, 80);
  if (name.length < 2) return fail('Give the connection a name, for example "Main shop till".');
  var providerName = String(body.providerName || '').trim().slice(0, 60) || 'My POS';
  var accountKey = String(body.accountKey || '').trim().slice(0, 80) || 'default';
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var mine = hubRows('InventoryConnections').filter(function (c) { return c.OwnerId === owner.OwnerId && c.Type === 'pushApi' && c.Status !== 'disconnected'; });
    if (mine.length >= 10) return fail('You can have up to 10 POS connections. Disconnect one you no longer use first.');
    var id = newId('conn');
    var secret = hubNewSecret();
    var settings = { providerName: providerName, accountKey: accountKey, rules: hubCleanRules(body.rules, null), keyId: hubKeyId(secret), webhookUrl: '', locationMap: {}, verifiedAt: '', lastSignalAt: '' };
    appendRowFromObject(getInventoryConnectionsSheet(), { ConnectionId: id, OwnerId: owner.OwnerId, Type: 'pushApi', Name: name, SettingsJson: JSON.stringify(settings),
      MappingJson: '{}', Mode: 'push', Status: 'pending_setup', CreatedAt: nowIso(), UpdatedAt: nowIso() });
    PropertiesService.getScriptProperties().setProperty(hubSecretKey(id), secret);
    appendAudit({ actorId: owner.OwnerId, actorRole: 'seller', action: 'POS_CONNECTION_CREATED', entityType: 'integration', entityId: id, next: name });
    return ok({ connectionId: id, secret: secret, keyId: settings.keyId, note: 'Copy this secret now. It is shown only once and Mwakete cannot show it again.' });
  } finally {
    lock.releaseLock();
  }
}

/** Replaces the secret (the old one stops working at once). Shown once. */
function actionRotatePosSecret(owner, body) {
  if (!posHubEnabled()) return hubOff();
  var row = hubConnectionRow(owner, body.connectionId);
  if (!row || row.Type !== 'pushApi' || row.Status === 'disconnected') return fail('That connection was not found.');
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var conn = hubConn(hubConnectionRow(owner, body.connectionId));
    var secret = hubNewSecret();
    PropertiesService.getScriptProperties().setProperty(hubSecretKey(conn.id), secret);
    hubSaveSettings(conn, { keyId: hubKeyId(secret), verifiedAt: '' }, { Status: conn.status === 'paused' ? 'paused' : 'pending_setup' });
    appendAudit({ actorId: owner.OwnerId, actorRole: 'seller', action: 'POS_SECRET_ROTATED', entityType: 'integration', entityId: conn.id });
    return ok({ secret: secret, keyId: conn.settings.keyId, note: 'Copy this secret now. The old one no longer works, and the connection shows "Waiting for first signal" until your system sends a signal with the new secret.' });
  } finally {
    lock.releaseLock();
  }
}

/** body: connectionId, name?, rules?, webhookUrl?, locationMap?, providerName?, accountKey? */
function actionUpdatePosConnection(owner, body) {
  if (!posHubEnabled()) return hubOff();
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var row = hubConnectionRow(owner, body.connectionId);
    if (!row || row.Type !== 'pushApi' || row.Status === 'disconnected') return fail('That connection was not found.');
    var conn = hubConn(row);
    var patch = {};
    var rowPatch = {};
    if (body.name !== undefined) {
      var name = String(body.name || '').trim().slice(0, 80);
      if (name.length < 2) return fail('Give the connection a name.');
      rowPatch.Name = name;
    }
    if (body.providerName !== undefined) patch.providerName = String(body.providerName || '').trim().slice(0, 60) || conn.settings.providerName;
    if (body.accountKey !== undefined) {
      var ak = String(body.accountKey || '').trim().slice(0, 80) || 'default';
      if (ak !== conn.accountKey && hubRows('ExternalSales').some(function (s) { return s.ConnectionId === conn.id; })) return fail('The account cannot be changed once sales have arrived, because it would break the link to them. Create a new connection instead.');
      patch.accountKey = ak;
    }
    if (body.rules !== undefined) patch.rules = hubCleanRules(body.rules, conn.settings.rules);
    if (body.webhookUrl !== undefined) {
      var uErr = hubUrlError(body.webhookUrl);
      if (uErr) return fail(uErr);
      patch.webhookUrl = String(body.webhookUrl || '').trim();
    }
    if (body.locationMap !== undefined) patch.locationMap = hubCleanLocationMap(owner, body.locationMap);
    hubSaveSettings(conn, patch, rowPatch);
    hubInvalidateExportCache(owner.OwnerId);
    appendAudit({ actorId: owner.OwnerId, actorRole: 'seller', action: 'POS_CONNECTION_UPDATED', entityType: 'integration', entityId: conn.id, next: Object.keys(patch).concat(Object.keys(rowPatch)).join(',') });
    return ok({ connection: hubPublicConnection(hubConnectionRow(owner, conn.id)) });
  } finally {
    lock.releaseLock();
  }
}

/** body: connectionId, state: 'pause' | 'resume' | 'disconnect'. */
function actionSetPosConnectionState(owner, body) {
  if (!posHubEnabled()) return hubOff();
  var state = String(body.state || '');
  if (['pause', 'resume', 'disconnect'].indexOf(state) === -1) return fail('Choose pause, resume or disconnect.');
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var row = hubConnectionRow(owner, body.connectionId);
    if (!row || row.Status === 'disconnected') return fail('That connection was not found.');
    var conn = hubConn(row);
    if (state === 'pause') updateRowFromObject(conn.sheet, row.__row, { Status: 'paused', UpdatedAt: nowIso() });
    else if (state === 'resume') updateRowFromObject(conn.sheet, row.__row, { Status: conn.settings.verifiedAt ? 'connected' : (conn.type === 'pushApi' ? 'pending_setup' : 'connected'), UpdatedAt: nowIso() });
    else {
      updateRowFromObject(conn.sheet, row.__row, { Status: 'disconnected', UpdatedAt: nowIso() });
      // Credentials are removed, mappings kept (retired) for the audit trail, waiting exports cancelled.
      PropertiesService.getScriptProperties().deleteProperty(hubSecretKey(conn.id));
      var ms = hubMappingsSheet();
      hubRows('IntegrationMappings').filter(function (m) { return m.ConnectionId === conn.id && m.Status !== 'retired'; }).forEach(function (m) {
        updateRowFromObject(ms, m.__row, { Status: 'retired', RetiredAt: nowIso(), UpdatedAt: nowIso(), Note: 'Connection disconnected' });
      });
      if (typeof hubCancelOutbox === 'function') hubCancelOutbox(conn.id);
    }
    hubInvalidateExportCache(owner.OwnerId);
    appendAudit({ actorId: owner.OwnerId, actorRole: 'seller', action: 'POS_CONNECTION_' + state.toUpperCase(), entityType: 'integration', entityId: conn.id });
    return ok({ state: state });
  } finally {
    lock.releaseLock();
  }
}

/* ==================== Mappings ==================== */

function hubExternalKey(ref) {
  if (ref.externalVariantId) return 'v:' + ref.externalVariantId;
  if (ref.externalProductId) return 'p:' + ref.externalProductId;
  if (ref.sku) return 's:' + String(ref.sku).toLowerCase();
  if (ref.barcode) return 'b:' + ref.barcode;
  return '';
}

function hubMappingFor(connectionId, key, rows) {
  return (rows || hubRows('IntegrationMappings')).filter(function (m) { return m.ConnectionId === connectionId && m.Kind === 'variant' && m.ExternalKey === key && m.Status === 'active'; })[0] || null;
}

/** Adds (or refreshes) a row in the review queue for an unmatched external item. */
function hubQueueForReview(owner, conn, ref, reason) {
  var key = hubExternalKey(ref);
  if (!key) return;
  var sheet = hubMappingsSheet();
  var existing = hubRows('IntegrationMappings').filter(function (m) { return m.ConnectionId === conn.id && m.Kind === 'variant' && m.ExternalKey === key && m.Status === 'review'; })[0];
  if (existing) { updateRowFromObject(sheet, existing.__row, { Note: reason, UpdatedAt: nowIso(), ExternalLabel: String(ref.label || existing.ExternalLabel || '').slice(0, 80) }); return; }
  appendRowFromObject(sheet, { MappingId: newId('map'), OwnerId: owner.OwnerId, ConnectionId: conn.id, Kind: 'variant', ExternalKey: key,
    ExternalVariantId: ref.externalVariantId || '', ExternalProductId: ref.externalProductId || '', ExternalSku: ref.sku || '', ExternalBarcode: ref.barcode || '',
    ExternalLabel: String(ref.label || '').slice(0, 80), VariantId: '', Status: 'review', MatchedBy: '', Note: reason, CreatedBy: 'system', CreatedAt: nowIso(), UpdatedAt: nowIso() });
}

/**
 * Finds the ONE of the seller's own varieties an external item refers to.
 * Order: a verified mapping for this connection, then an exact external ID,
 * then an exact SKU, then an exact barcode that no other variety shares. Never
 * by name, description or price. Returns { variant, matchedBy } or { unmatched, ambiguous, reason }.
 */
function hubResolveItem(owner, conn, ref, ctx) {
  var vars = ctx.variants;
  var byId = ctx.byId;
  var key = hubExternalKey(ref);
  var keys = [];
  if (ref.externalVariantId) keys.push('v:' + ref.externalVariantId);
  if (ref.externalProductId) keys.push('p:' + ref.externalProductId);
  if (ref.sku) keys.push('s:' + String(ref.sku).toLowerCase());
  if (ref.barcode) keys.push('b:' + ref.barcode);
  for (var i = 0; i < keys.length; i++) {
    var m = hubMappingFor(conn.id, keys[i], ctx.mappings);
    if (m) {
      var mv = byId[m.VariantId];
      if (!mv) return { unmatched: true, reason: 'This item is mapped to a product that is no longer available. Map it again.' };
      return { variant: mv, matchedBy: 'mapping' };
    }
  }
  var lower = function (x) { return String(x == null ? '' : x).trim().toLowerCase(); };
  var pick = function (list, how) {
    if (list.length === 1) return { variant: list[0], matchedBy: how };
    if (list.length > 1) return { unmatched: true, ambiguous: true, reason: 'More than one of your products matches this ' + how + '. Choose the right one.' };
    return null;
  };
  var r;
  if (ref.externalVariantId) { r = pick(vars.filter(function (v) { return v.ExternalId && lower(v.ExternalId) === lower(ref.externalVariantId); }), 'external id'); if (r) return r; }
  if (ref.externalProductId) { r = pick(vars.filter(function (v) { return v.ExternalId && lower(v.ExternalId) === lower(ref.externalProductId); }), 'external id'); if (r) return r; }
  if (ref.sku) { r = pick(vars.filter(function (v) { return v.SKU && lower(v.SKU) === lower(ref.sku); }), 'SKU'); if (r) return r; }
  if (ref.barcode) { r = pick(vars.filter(function (v) { return v.Barcode && lower(v.Barcode) === lower(ref.barcode); }), 'barcode'); if (r) return r; }
  return { unmatched: true, reason: key ? 'No product of yours matches this item yet.' : 'This item has no ID, SKU or barcode to match with.' };
}

/** Records, once, that an exact match was used, so a later change of SKU cannot silently move it. */
function hubRememberMatch(owner, conn, ref, variant, matchedBy, ctx) {
  if (matchedBy === 'mapping') return;
  var key = ref.externalVariantId ? 'v:' + ref.externalVariantId : (ref.externalProductId ? 'p:' + ref.externalProductId : '');
  if (!key) return;
  var sheet = hubMappingsSheet();
  var review = hubRows('IntegrationMappings').filter(function (m) { return m.ConnectionId === conn.id && m.ExternalKey === key && m.Status === 'review'; })[0];
  var row = { MappingId: review ? review.MappingId : newId('map'), OwnerId: owner.OwnerId, ConnectionId: conn.id, Kind: 'variant', ExternalKey: key,
    ExternalVariantId: ref.externalVariantId || '', ExternalProductId: ref.externalProductId || '', ExternalSku: ref.sku || '', ExternalBarcode: ref.barcode || '',
    ExternalLabel: String(ref.label || '').slice(0, 80), VariantId: variant.VariantId, Status: 'active', MatchedBy: matchedBy, Note: 'Matched by exact ' + matchedBy,
    CreatedBy: 'system', UpdatedAt: nowIso() };
  if (review) updateRowFromObject(sheet, review.__row, row); else { row.CreatedAt = nowIso(); appendRowFromObject(sheet, row); }
  ctx.mappings = hubRows('IntegrationMappings');
}

function hubStockContext(owner) {
  var sheet = getSheet('Variants');
  ensureInventoryColumns(sheet);
  var variants = sheetToObjects(sheet).filter(function (v) { return v.OwnerId === owner.OwnerId && v.Status === 'active'; });
  variants.forEach(function (v) { v.__sheet = sheet; });
  var byId = {};
  variants.forEach(function (v) { byId[v.VariantId] = v; });
  return { sheet: sheet, variants: variants, byId: byId, mappings: hubRows('IntegrationMappings') };
}

/** body: connectionId, externalVariantId?, externalProductId?, externalSku?, variantId, replace? */
function actionSaveIntegrationMapping(owner, body) {
  if (!posHubEnabled()) return hubOff();
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var row = hubConnectionRow(owner, body.connectionId);
    if (!row || row.Status === 'disconnected') return fail('That connection was not found.');
    var conn = hubConn(row);
    var ref = { externalVariantId: String(body.externalVariantId || '').trim().slice(0, 120), externalProductId: String(body.externalProductId || '').trim().slice(0, 120),
      sku: String(body.externalSku || '').trim().slice(0, 80), label: String(body.label || '').slice(0, 80) };
    var key = hubExternalKey(ref);
    if (!key) return fail('Enter the ID or SKU your system uses for this item.');
    var ctx = hubStockContext(owner);
    var variant = ctx.byId[String(body.variantId || '')];
    if (!variant) return fail('Choose one of your own products.');
    var sheet = hubMappingsSheet();
    var rows = hubRows('IntegrationMappings');
    var active = rows.filter(function (m) { return m.ConnectionId === conn.id && m.ExternalKey === key && m.Status === 'active'; })[0];
    if (active && active.VariantId === variant.VariantId) return ok({ mappingId: active.MappingId, unchanged: true });
    if (active && body.replace !== true) return fail('That item is already mapped to a different product. Choose "Replace" to move it.');
    if (active) updateRowFromObject(sheet, active.__row, { Status: 'retired', RetiredAt: nowIso(), UpdatedAt: nowIso(), Note: 'Replaced by a new mapping' });
    var review = rows.filter(function (m) { return m.ConnectionId === conn.id && m.ExternalKey === key && m.Status === 'review'; })[0];
    var record = { OwnerId: owner.OwnerId, ConnectionId: conn.id, Kind: 'variant', ExternalKey: key, ExternalVariantId: ref.externalVariantId, ExternalProductId: ref.externalProductId,
      ExternalSku: ref.sku || (review && review.ExternalSku) || '', ExternalBarcode: review ? review.ExternalBarcode : '', ExternalLabel: ref.label || (review && review.ExternalLabel) || '',
      VariantId: variant.VariantId, Status: 'active', MatchedBy: 'seller', Note: '', CreatedBy: owner.OwnerId, UpdatedAt: nowIso() };
    var id;
    if (review) { id = review.MappingId; updateRowFromObject(sheet, review.__row, record); }
    else { id = newId('map'); record.MappingId = id; record.CreatedAt = nowIso(); appendRowFromObject(sheet, record); }
    appendAudit({ actorId: owner.OwnerId, actorRole: 'seller', action: 'POS_MAPPING_SAVED', entityType: 'integration_mapping', entityId: id, previous: active ? active.VariantId : '', next: variant.VariantId });
    return ok({ mappingId: id });
  } finally {
    lock.releaseLock();
  }
}

/** body: mappingId. The mapping is retired (kept for the audit trail). */
function actionRetireIntegrationMapping(owner, body) {
  if (!posHubEnabled()) return hubOff();
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sheet = hubMappingsSheet();
    var m = findRowById(sheet, 'MappingId', String(body.mappingId || ''));
    if (!m || m.OwnerId !== owner.OwnerId || m.Status === 'retired') return fail('That mapping was not found.');
    updateRowFromObject(sheet, m.__row, { Status: 'retired', RetiredAt: nowIso(), UpdatedAt: nowIso(), Note: String(body.note || 'Unmapped by the seller').slice(0, 200) });
    appendAudit({ actorId: owner.OwnerId, actorRole: 'seller', action: 'POS_MAPPING_RETIRED', entityType: 'integration_mapping', entityId: m.MappingId, previous: m.VariantId });
    return ok({ retired: true });
  } finally {
    lock.releaseLock();
  }
}

/** body: connectionId?, status? ('active'|'review'|'retired'). */
function actionListIntegrationMappings(owner, body) {
  if (!posHubEnabled()) return hubOff();
  var ctx = hubStockContext(owner);
  var want = String((body && body.status) || '');
  var list = hubRows('IntegrationMappings').filter(function (m) {
    return m.OwnerId === owner.OwnerId && (!body || !body.connectionId || m.ConnectionId === body.connectionId) && (!want || m.Status === want);
  }).sort(function (a, b) { return String(b.UpdatedAt).localeCompare(String(a.UpdatedAt)); }).slice(0, 300);
  return ok({ mappings: list.map(function (m) {
    var v = ctx.byId[m.VariantId];
    return { mappingId: m.MappingId, connectionId: m.ConnectionId, externalKey: m.ExternalKey, externalVariantId: m.ExternalVariantId, externalProductId: m.ExternalProductId,
      externalSku: m.ExternalSku, externalBarcode: m.ExternalBarcode, label: m.ExternalLabel, variantId: m.VariantId, variantName: v ? v.Label : '', sku: v ? v.SKU : '',
      status: m.Status, matchedBy: m.MatchedBy, note: m.Note, updatedAt: m.UpdatedAt };
  }) });
}

/* ==================== The one stock-delta function ==================== */

/**
 * Applies a quantity change to one of the seller's varieties through the
 * existing ledger. The caller holds the script lock and passes a variant row
 * read inside it. delta < 0 is a sale, delta > 0 a return or receipt.
 *
 * opts.fact (default true): the goods have physically moved, so the change is
 * applied even if it takes stock below what open orders reserved, and a sale
 * larger than Mwakete's number is applied down to 0. Both are reported, never
 * hidden. With fact === false a change that would break either rule is refused.
 *
 * Returns { applied, shortfall, belowReserved, before, after, untracked, error? }.
 * Not tracked (StockQty blank) = unlimited: nothing to change.
 */
function applyStockDelta(owner, v, locationId, delta, movementType, source, referenceId, notes, opts) {
  opts = opts || {};
  var fact = opts.fact !== false;
  delta = Math.floor(Number(delta) || 0);
  if (!delta) return { applied: 0, shortfall: 0, belowReserved: false, before: null, after: null };
  if (!isStockTracked(v)) return { applied: 0, shortfall: 0, belowReserved: false, before: null, after: null, untracked: true };
  var loc = locationId || DEFAULT_LOCATION_ID;
  var before = physicalOf(v);
  var held = reservedOf(v);
  var applied = delta;
  var shortfall = 0;
  if (delta < 0) {
    var room = before;
    if (loc !== DEFAULT_LOCATION_ID && typeof ownLocationStock === 'function') room = Math.min(before, (ownLocationStock(owner.OwnerId)[v.VariantId] || {})[loc] || 0);
    if (-delta > room) {
      if (!fact) return { error: 'Only ' + room + ' in stock.', applied: 0 };
      applied = -room;
      shortfall = -delta - room;
    }
  }
  var after = before + applied;
  var belowReserved = delta < 0 && after < held;
  if (belowReserved && !fact) return { error: held + ' are held by open orders, so stock cannot go below ' + held + '.', applied: 0 };
  if (!applied) return { applied: 0, shortfall: shortfall, belowReserved: belowReserved, before: before, after: before };
  updateRowFromObject(v.__sheet || getSheet('Variants'), v.__row, { StockQty: after, LastSyncedAt: nowIso() });
  if (loc !== DEFAULT_LOCATION_ID && typeof applyLocationDelta === 'function') applyLocationDelta(owner, v, loc, applied);
  recordStockMovements([{ OwnerId: owner.OwnerId, ProductId: v.ProductId, VariantId: v.VariantId, Quantity: applied, MovementType: movementType,
    PreviousStock: before, NewStock: after, PreviousReserved: held, NewReserved: held, Source: source, ReferenceId: referenceId, UserId: opts.userId || 'system',
    Notes: String(notes || '').slice(0, 200), LocationId: loc }]);
  v.StockQty = after;
  return { applied: applied, shortfall: shortfall, belowReserved: belowReserved, before: before, after: after };
}

/* ==================== Events ledger ==================== */

function hubFindEventByKey(key) {
  return hubRows('IntegrationEvents').filter(function (e) { return e.IdempotencyKey === key; })[0] || null;
}

function hubWriteEvent(conn, fields, existing) {
  var sheet = hubEventsSheet();
  var now = nowIso();
  var row = Object.assign({ OwnerId: conn.ownerId, ConnectionId: conn.id, Provider: conn.provider, AccountKey: conn.accountKey, Direction: 'in', UpdatedAt: now }, fields);
  ['ErrorMessage'].forEach(function (k) { if (row[k] !== undefined) row[k] = hubSafeText(row[k], 300); });
  ['BeforeJson', 'AfterJson'].forEach(function (k) { if (row[k] !== undefined && typeof row[k] !== 'string') row[k] = JSON.stringify(row[k]); if (row[k]) row[k] = String(row[k]).slice(0, 40000); });
  if (existing) { updateRowFromObject(sheet, existing.__row, row); return existing.EventId; }
  row.EventId = newId('evt');
  row.CreatedAt = now;
  row.Attempts = row.Attempts || 1;
  appendRowFromObject(sheet, row);
  return row.EventId;
}

function hubPayloadHash(text) {
  return bytesToHex(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(text))).slice(0, 16);
}

/* ==================== Payload checks ==================== */

function hubNum(v) { var n = Number(v); return isFinite(n) ? n : NaN; }
function hubStr(v, max) { return String(v == null ? '' : v).trim().slice(0, max || 120); }

function hubParseTime(v) {
  if (v === undefined || v === null || v === '') return NaN;
  var t = typeof v === 'number' ? v : (/^\d{10,13}$/.test(String(v)) ? Number(v) : Date.parse(String(v)));
  if (!isFinite(t)) return NaN;
  if (t < 1e12) t = t * 1000; // seconds -> ms
  return t;
}

function hubNormalizeRef(raw) {
  raw = raw && typeof raw === 'object' ? raw : {};
  return { externalVariantId: hubStr(raw.externalVariantId || raw.variantId, 120), externalProductId: hubStr(raw.externalProductId || raw.productId, 120),
    sku: hubStr(raw.sku, 80), barcode: hubStr(raw.barcode, 80), label: hubStr(raw.name || raw.label, 80) };
}

/** Whitelists and validates a sale. Returns { sale } or { error }. Nothing else the sender included is kept. */
function hubNormalizeSale(p) {
  var id = hubStr(p.id, 80);
  if (!id) return { error: 'The sale needs an id.' };
  var lines = Array.isArray(p.lines) ? p.lines : [];
  if (!lines.length) return { error: 'The sale has no lines.' };
  if (lines.length > HUB_MAX_LINES) return { error: 'A sale can have at most ' + HUB_MAX_LINES + ' lines.' };
  var out = [];
  for (var i = 0; i < lines.length; i++) {
    var ref = hubNormalizeRef(lines[i]);
    var qty = hubNum(lines[i] && lines[i].qty);
    var price = hubNum(lines[i] && lines[i].unitPrice);
    if (!(ref.externalVariantId || ref.externalProductId || ref.sku || ref.barcode)) return { error: 'Line ' + (i + 1) + ' has no id, SKU or barcode.' };
    if (!isFinite(qty) || qty < 1 || Math.floor(qty) !== qty || qty > 100000) return { error: 'Line ' + (i + 1) + ' needs a whole quantity of 1 or more.' };
    if (!isFinite(price) || price < 0 || price > 1000000) return { error: 'Line ' + (i + 1) + ' needs a price of 0 or more.' };
    ref.lineId = hubStr(lines[i].lineId || String(i + 1), 40);
    ref.qty = qty; ref.unitPrice = roundMoney(price);
    ref.discount = Math.max(0, roundMoney(hubNum(lines[i].discount) || 0));
    out.push(ref);
  }
  var at = hubParseTime(p.occurredAt);
  if (!isFinite(at)) return { error: 'The sale needs a valid time (occurredAt).' };
  var now = Date.now();
  if (at > now + 24 * 3600000) return { error: 'The sale time is in the future.' };
  if (at < now - 2 * 365 * 24 * 3600000) return { error: 'The sale time is more than two years ago.' };
  var pay = p.payment && typeof p.payment === 'object' ? p.payment : {};
  var pstatus = hubStr(pay.status, 20).toLowerCase();
  var status = hubStr(p.status || 'completed', 20).toLowerCase();
  if (['completed', 'open', 'cancelled', 'voided'].indexOf(status) === -1) return { error: 'The sale status must be completed, open, cancelled or voided.' };
  var sub = roundMoney(out.reduce(function (n, l) { return n + l.qty * l.unitPrice - l.discount; }, 0));
  var discount = Math.max(0, roundMoney(hubNum(p.discount) || 0));
  var tax = Math.max(0, roundMoney(hubNum(p.tax) || 0));
  var total = isFinite(hubNum(p.total)) ? roundMoney(hubNum(p.total)) : roundMoney(sub - discount + tax);
  return { sale: { id: id, version: hubStr(p.version, 40), occurredAt: new Date(at).toISOString(), storeId: hubStr(p.storeId, 80), registerId: hubStr(p.registerId, 80),
    currency: hubStr(p.currency, 8).toUpperCase() || 'AUD', lines: out, subtotal: sub, discount: discount, tax: tax, total: total, status: status,
    payment: { method: hubStr(pay.method, 30).toLowerCase() || 'unknown', status: ['paid', 'pending', 'failed', 'reversed', 'refunded'].indexOf(pstatus) !== -1 ? pstatus : 'unknown' },
    correlationId: hubStr(p.correlationId, 80), origin: hubStr(p.origin, 30) } };
}

function hubNormalizeRefund(p) {
  var id = hubStr(p.id, 80);
  var saleId = hubStr(p.saleId, 80);
  if (!id) return { error: 'The refund needs an id.' };
  if (!saleId) return { error: 'The refund needs the id of the sale it refunds (saleId).' };
  var lines = Array.isArray(p.lines) ? p.lines : [];
  if (lines.length > HUB_MAX_LINES) return { error: 'A refund can have at most ' + HUB_MAX_LINES + ' lines.' };
  var out = [];
  for (var i = 0; i < lines.length; i++) {
    var ref = hubNormalizeRef(lines[i]);
    var qty = hubNum(lines[i] && lines[i].qty);
    if (!isFinite(qty) || qty < 1 || Math.floor(qty) !== qty || qty > 100000) return { error: 'Refund line ' + (i + 1) + ' needs a whole quantity of 1 or more.' };
    ref.lineId = hubStr(lines[i].lineId, 40); ref.qty = qty; ref.restock = lines[i].restock === true;
    out.push(ref);
  }
  var amount = isFinite(hubNum(p.amount)) ? roundMoney(hubNum(p.amount)) : NaN;
  if (!lines.length && !(amount > 0)) return { error: 'The refund needs lines, or an amount.' };
  if (isFinite(amount) && amount < 0) return { error: 'The refund amount cannot be negative.' };
  var at = hubParseTime(p.occurredAt);
  return { refund: { id: id, saleId: saleId, lines: out, amount: isFinite(amount) ? amount : null, reason: hubStr(p.reason, 120), occurredAt: isFinite(at) ? new Date(at).toISOString() : nowIso(),
    correlationId: hubStr(p.correlationId, 80), origin: hubStr(p.origin, 30) } };
}

function hubNormalizeStock(p) {
  var id = hubStr(p.id, 80);
  if (!id) return { error: 'The stock count needs an id.' };
  var items = Array.isArray(p.items) ? p.items : [];
  if (!items.length) return { error: 'The stock count has no items.' };
  if (items.length > HUB_MAX_LINES * 5) return { error: 'A stock count can have at most ' + (HUB_MAX_LINES * 5) + ' items.' };
  var out = [];
  for (var i = 0; i < items.length; i++) {
    var ref = hubNormalizeRef(items[i]);
    var qty = hubNum(items[i] && items[i].qty);
    if (!(ref.externalVariantId || ref.externalProductId || ref.sku || ref.barcode)) return { error: 'Item ' + (i + 1) + ' has no id, SKU or barcode.' };
    if (!isFinite(qty) || qty < 0 || Math.floor(qty) !== qty || qty > 10000000) return { error: 'Item ' + (i + 1) + ' needs a whole quantity of 0 or more.' };
    ref.qty = qty;
    out.push(ref);
  }
  var at = hubParseTime(p.asOf || p.occurredAt);
  if (!isFinite(at)) return { error: 'The stock count needs the time it was taken (asOf).' };
  return { stock: { id: id, storeId: hubStr(p.storeId, 80), asOf: new Date(at).toISOString(), items: out, correlationId: hubStr(p.correlationId, 80), origin: hubStr(p.origin, 30) } };
}

/* ==================== Ingestion (the caller holds the lock) ==================== */

function hubSaleLocation(conn, storeId) {
  var map = conn.settings.locationMap || {};
  return (storeId && map[storeId]) || map['*'] || DEFAULT_LOCATION_ID;
}

function hubLinesKey(lines) {
  return lines.map(function (l) { return [l.externalVariantId, l.externalProductId, l.sku, l.barcode, l.qty].join('~'); }).sort().join('|');
}

/** Resolves every line; all must match exactly one of the seller's own varieties. */
function hubResolveAll(owner, conn, lines, ctx) {
  var resolved = [];
  var problems = [];
  lines.forEach(function (l, i) {
    var r = hubResolveItem(owner, conn, l, ctx);
    if (r.unmatched) { problems.push({ line: i + 1, reason: r.reason, ambiguous: !!r.ambiguous }); hubQueueForReview(owner, conn, l, r.reason); }
    else { resolved.push({ line: l, variant: r.variant, matchedBy: r.matchedBy }); }
  });
  return { resolved: resolved, problems: problems };
}

function hubAttach(result, ctx, owner, conn) {
  result.resolved.forEach(function (r) { hubRememberMatch(owner, conn, r.line, r.variant, r.matchedBy, ctx); });
}

function hubSaleRecord(conn, sale, locationId, linesStored, status, applied, existing) {
  var sheet = hubSalesSheet();
  var row = { OwnerId: conn.ownerId, ConnectionId: conn.id, Provider: conn.provider, AccountKey: conn.accountKey, ExternalTxnId: sale.id, ExternalStoreId: sale.storeId,
    ExternalRegisterId: sale.registerId, LocationId: locationId, OccurredAt: sale.occurredAt, Version: sale.version, Currency: sale.currency, Subtotal: sale.subtotal,
    Discount: sale.discount, Tax: sale.tax, Total: sale.total, PaymentMethod: sale.payment.method, PaymentStatus: sale.payment.status === 'paid' ? 'paid_reported' : sale.payment.status,
    Status: status, LinesJson: JSON.stringify(linesStored).slice(0, 45000), LinesHash: hubPayloadHash(hubLinesKey(sale.lines)), StockApplied: applied, UpdatedAt: nowIso() };
  if (existing) { updateRowFromObject(sheet, existing.__row, row); return existing.ExternalSaleId; }
  row.ExternalSaleId = newId('xs');
  row.RefundedAmount = 0;
  row.CreatedAt = nowIso();
  appendRowFromObject(sheet, row);
  return row.ExternalSaleId;
}

/** True when version a is older than b: numbers compare as numbers ("9" < "10"), otherwise as text (ISO times sort correctly). */
function hubVersionOlder(a, b) {
  var x = Number(a), y = Number(b);
  if (isFinite(x) && isFinite(y) && String(a).trim() !== '' && String(b).trim() !== '') return x < y;
  return String(a) < String(b);
}

/**
 * Takes one sale. Idempotent on connection + sale id; a later version updates
 * the same row instead of creating a second sale. Returns { status, reference, before, after, note, code }.
 */
function hubIngestSale(owner, conn, sale) {
  var existing = hubRows('ExternalSales').filter(function (s) { return s.ConnectionId === conn.id && s.ExternalTxnId === sale.id; })[0] || null;
  if (existing && sale.version && existing.Version && hubVersionOlder(sale.version, existing.Version)) {
    return { status: 'stale', reference: existing.ExternalSaleId, note: 'An older version than the one already recorded.' };
  }
  if (!conn.settings.rules.importSales) return { status: 'ignored', note: 'Importing sales is switched off for this connection.' };
  var wantsStock = sale.status === 'completed' && sale.payment.status !== 'failed' && sale.payment.status !== 'pending';
  var ctx = hubStockContext(owner);
  var loc = hubSaleLocation(conn, sale.storeId);

  // A later version of a sale already recorded.
  if (existing) {
    var linesHash = hubPayloadHash(hubLinesKey(sale.lines));
    var wasApplied = existing.StockApplied === 'yes';
    if (sale.status === 'voided' || sale.status === 'cancelled') {
      if (!wasApplied) { hubSaleRecord(conn, sale, existing.LocationId, hubParse(existing.LinesJson, []), 'voided', 'no', existing); return { status: 'applied', reference: existing.ExternalSaleId, note: 'Marked ' + sale.status + '. No stock had been taken.' }; }
      return hubReverseWholeSale(owner, conn, existing, sale, ctx);
    }
    if (wasApplied && linesHash !== existing.LinesHash) {
      return { status: 'conflict', code: 'sale_lines_changed', reference: existing.ExternalSaleId, before: { lines: existing.LinesHash }, after: { lines: linesHash },
        note: 'The items on this sale changed after the stock was taken. Nothing was changed. Check the sale and correct the stock by hand if needed.' };
    }
    if (!wasApplied && wantsStock) return hubApplySale(owner, conn, sale, loc, ctx, existing);
    hubSaleRecord(conn, sale, existing.LocationId, hubParse(existing.LinesJson, []), existing.Status, existing.StockApplied, existing);
    return { status: 'applied', reference: existing.ExternalSaleId, note: 'Payment details updated. Stock was not touched again.' };
  }

  if (sale.status === 'voided' || sale.status === 'cancelled') {
    var id0 = hubSaleRecord(conn, sale, loc, [], 'voided', 'no', null);
    return { status: 'applied', reference: id0, note: 'A cancelled sale was recorded. No stock was taken.' };
  }
  if (!wantsStock) {
    var stored = sale.lines.map(function (l) { return { lineId: l.lineId, ext: l.externalVariantId || l.externalProductId || l.sku || l.barcode, qty: l.qty, unitPrice: l.unitPrice, variantId: '', refundedQty: 0 }; });
    var id1 = hubSaleRecord(conn, sale, loc, stored, sale.status === 'open' ? 'open' : 'payment_' + sale.payment.status, 'no', null);
    return { status: 'applied', reference: id1, note: 'Recorded. Stock is taken only when the sale is completed and paid.' };
  }
  return hubApplySale(owner, conn, sale, loc, ctx, null);
}

function hubApplySale(owner, conn, sale, loc, ctx, existing) {
  var res = hubResolveAll(owner, conn, sale.lines, ctx);
  if (res.problems.length) {
    var stored0 = sale.lines.map(function (l) { return { lineId: l.lineId, ext: l.externalVariantId || l.externalProductId || l.sku || l.barcode, qty: l.qty, unitPrice: l.unitPrice, variantId: '', refundedQty: 0 }; });
    var xs = hubSaleRecord(conn, sale, loc, stored0, 'needs_mapping', 'no', existing);
    return { status: 'needs_mapping', code: 'needs_mapping', reference: xs, after: { problems: res.problems },
      note: res.problems.length + ' item(s) could not be matched to exactly one of your products, so no stock was taken. Map them, then retry.' };
  }
  hubAttach(res, ctx, owner, conn);
  var xsId = existing ? existing.ExternalSaleId : newId('xs');
  var notes = [];
  var stored = [];
  var beforeAfter = [];
  var flags = { shortfall: 0, belowReserved: 0 };
  // The same variety can appear on several lines: apply the total once per variety so the numbers add up.
  var perVariant = {};
  res.resolved.forEach(function (r) { var k = r.variant.VariantId; perVariant[k] = perVariant[k] || { variant: r.variant, qty: 0 }; perVariant[k].qty += r.line.qty; });
  Object.keys(perVariant).forEach(function (k) {
    var pv = perVariant[k];
    var d = applyStockDelta(owner, pv.variant, loc, -pv.qty, 'SALE', conn.provider, xsId, 'External sale ' + sale.id, { fact: true });
    if (d.shortfall) { flags.shortfall += d.shortfall; notes.push(pv.variant.Label + ': sold ' + pv.qty + ' but Mwakete showed ' + (d.before === null ? '?' : d.before)); }
    if (d.belowReserved) { flags.belowReserved++; notes.push(pv.variant.Label + ' is now below the units held for online orders'); }
    beforeAfter.push({ variantId: pv.variant.VariantId, name: pv.variant.Label, sold: pv.qty, before: d.before, after: d.after });
  });
  res.resolved.forEach(function (r) { stored.push({ lineId: r.line.lineId, ext: r.line.externalVariantId || r.line.externalProductId || r.line.sku || r.line.barcode, qty: r.line.qty, unitPrice: r.line.unitPrice, variantId: r.variant.VariantId, refundedQty: 0 }); });
  var rec = hubSaleRecord(conn, sale, loc, stored, 'applied', 'yes', existing);
  if (flags.shortfall || flags.belowReserved) {
    return { status: 'conflict', code: flags.shortfall ? 'oversold' : 'stock_below_reserved', reference: rec, before: null, after: beforeAfter,
      note: 'The sale was recorded and the stock was taken. ' + notes.join('; ') + '. Check your stock.' };
  }
  return { status: 'applied', reference: rec, after: beforeAfter, note: 'Sale recorded and stock taken once.' };
}

/** A completed sale was later cancelled/voided by the POS: put the stock back, once. */
function hubReverseWholeSale(owner, conn, existing, sale, ctx) {
  if (existing.Status === 'voided') return { status: 'duplicate', reference: existing.ExternalSaleId, note: 'Already voided.' };
  var lines = hubParse(existing.LinesJson, []);
  var back = [];
  lines.forEach(function (l) {
    var left = l.qty - (l.refundedQty || 0);
    var v = ctx.byId[l.variantId];
    if (left > 0 && v) {
      var d = applyStockDelta(owner, v, existing.LocationId, left, 'RETURN', conn.provider, existing.ExternalSaleId, 'External sale ' + sale.id + ' ' + sale.status, { fact: true });
      back.push({ variantId: v.VariantId, returned: d.applied });
      l.refundedQty = l.qty;
    }
  });
  hubSaleRecord(conn, sale, existing.LocationId, lines, 'voided', existing.StockApplied, existing);
  return { status: 'applied', reference: existing.ExternalSaleId, after: back, note: 'The sale was ' + sale.status + ' and its stock was put back once.' };
}

/** Takes one refund / return against a recorded sale. Idempotent on its own id. */
function hubIngestRefund(owner, conn, refund) {
  if (!conn.settings.rules.applyReturns) return { status: 'ignored', note: 'Returns are switched off for this connection.' };
  var sale = hubRows('ExternalSales').filter(function (s) { return s.ConnectionId === conn.id && s.ExternalTxnId === refund.saleId; })[0];
  if (!sale) return { status: 'pending_parent', code: 'sale_not_found', note: 'The sale this refund belongs to has not arrived yet. It will be applied when it does, or retry it later.' };
  var ctx = hubStockContext(owner);
  var lines = hubParse(sale.LinesJson, []);
  var total = Number(sale.Total) || 0;
  var refundedSoFar = Number(sale.RefundedAmount) || 0;

  // Match each refund line to a stored sale line (by line id, else by the item it refers to).
  var plan = [];
  for (var i = 0; i < refund.lines.length; i++) {
    var rl = refund.lines[i];
    var target = null;
    if (rl.lineId) target = lines.filter(function (l) { return l.lineId === rl.lineId; })[0];
    if (!target) {
      var r = hubResolveItem(owner, conn, rl, ctx);
      if (r.unmatched) return { status: 'needs_mapping', code: 'needs_mapping', note: 'Refund line ' + (i + 1) + ' could not be matched to a product. Map it, then retry.' };
      target = lines.filter(function (l) { return l.variantId === r.variant.VariantId && (l.qty - (l.refundedQty || 0)) > 0; })[0];
    }
    if (!target) return { status: 'conflict', code: 'refund_exceeds', note: 'Refund line ' + (i + 1) + ' does not match anything still refundable on that sale.' };
    plan.push({ target: target, rl: rl });
  }
  // Validate quantities against what is left, counting several lines for one sale line together.
  var asked = {};
  plan.forEach(function (p) { asked[p.target.lineId] = (asked[p.target.lineId] || 0) + p.rl.qty; });
  for (var k in asked) {
    var tl = lines.filter(function (l) { return l.lineId === k; })[0];
    if (asked[k] > tl.qty - (tl.refundedQty || 0)) return { status: 'conflict', code: 'refund_exceeds', note: 'More was refunded than was sold (line ' + k + '). Nothing was changed.' };
  }
  if (refund.amount !== null && refund.amount > roundMoney(total - refundedSoFar) + 0.005) {
    return { status: 'conflict', code: 'refund_exceeds', note: 'The refund amount is more than what is left to refund on that sale. Nothing was changed.' };
  }
  var rule = conn.settings.rules.restock;
  var back = [];
  plan.forEach(function (p) {
    p.target.refundedQty = (p.target.refundedQty || 0) + p.rl.qty;
    var restock = rule === 'always' || (rule === 'when_flagged' && p.rl.restock === true);
    var v = ctx.byId[p.target.variantId];
    if (restock && v && sale.StockApplied === 'yes') {
      var d = applyStockDelta(owner, v, sale.LocationId, p.rl.qty, 'RETURN', conn.provider, sale.ExternalSaleId, 'External refund ' + refund.id, { fact: true });
      back.push({ variantId: v.VariantId, restocked: d.applied });
    } else {
      back.push({ variantId: p.target.variantId, restocked: 0 });
    }
  });
  var refundMoney = refund.amount !== null ? refund.amount : roundMoney(plan.reduce(function (n, p) { return n + p.rl.qty * (Number(p.target.unitPrice) || 0); }, 0));
  var newRefunded = roundMoney(refundedSoFar + refundMoney);
  var allBack = lines.length && lines.every(function (l) { return (l.refundedQty || 0) >= l.qty; });
  updateRowFromObject(hubSalesSheet(), sale.__row, { LinesJson: JSON.stringify(lines).slice(0, 45000), RefundedAmount: newRefunded,
    Status: allBack ? 'refunded' : (newRefunded > 0 || plan.length ? 'partially_refunded' : sale.Status), UpdatedAt: nowIso() });
  return { status: 'applied', reference: sale.ExternalSaleId, after: back, note: (allBack ? 'Fully refunded' : 'Partly refunded') + '. Stock restored only for goods marked as returned.' };
}

/**
 * A count from the other system. Never applied as a movement: it is compared
 * with Mwakete and any difference waits for the seller to accept or keep.
 */
function hubIngestStock(owner, conn, stock) {
  if (conn.settings.rules.snapshots === 'ignore') return { status: 'ignored', note: 'Stock counts are switched off for this connection.' };
  var ctx = hubStockContext(owner);
  var prior = hubRows('IntegrationEvents').filter(function (e) { return e.ConnectionId === conn.id && e.Type === 'stock' && e.Status !== 'stale' && e.Status !== 'rejected'; })
    .map(function (e) { return hubParse(e.PayloadJson, {}).asOf || ''; }).sort().pop();
  if (prior && stock.asOf < prior) return { status: 'stale', note: 'An older count than one already received.' };
  var loc = hubSaleLocation(conn, stock.storeId);
  var diffs = [];
  var problems = [];
  stock.items.forEach(function (it, i) {
    var r = hubResolveItem(owner, conn, it, ctx);
    if (r.unmatched) { problems.push({ item: i + 1, reason: r.reason }); hubQueueForReview(owner, conn, it, r.reason); return; }
    var v = r.variant;
    if (!isStockTracked(v)) return;
    var mine = physicalOf(v);
    if (loc !== DEFAULT_LOCATION_ID && typeof ownLocationStock === 'function') mine = (ownLocationStock(owner.OwnerId)[v.VariantId] || {})[loc] || 0;
    if (mine !== it.qty) diffs.push({ variantId: v.VariantId, name: v.Label, external: it.qty, mwakete: mine, reserved: reservedOf(v), locationId: loc });
  });
  if (!diffs.length && !problems.length) return { status: 'applied', note: 'The counts match. Nothing to change.' };
  if (!diffs.length) return { status: 'needs_mapping', code: 'needs_mapping', after: { problems: problems }, note: problems.length + ' item(s) could not be matched.' };
  return { status: 'conflict', code: 'stock_snapshot', before: { differences: diffs }, after: { unmatched: problems },
    note: diffs.length + ' item(s) differ from Mwakete. Nothing was changed. Choose whether to accept the counts from your system.' };
}

function hubIsEcho(conn, normalized) {
  if (normalized.origin === 'mwakete') return true;
  if (!normalized.correlationId) return false;
  return hubRows('IntegrationOutbox').some(function (o) { return o.ConnectionId === conn.id && o.CorrelationId === normalized.correlationId; });
}

/** Processes one normalized event. The caller holds the lock. */
function hubProcessEvent(owner, conn, type, n) {
  if (type === 'sale') return hubIngestSale(owner, conn, n);
  if (type === 'refund') return hubIngestRefund(owner, conn, n);
  if (type === 'stock') return hubIngestStock(owner, conn, n);
  return { status: 'rejected', code: 'bad_type', note: 'Unknown event type.' };
}

function hubIdempotencyKey(conn, type, n) {
  return conn.id + '|' + type + '|' + n.id + '|' + (type === 'sale' ? (n.version || '') : '');
}

/* ==================== The signed push API (public action) ==================== */

function hubPushFail(code, message) { var f = fail(message); f.code = code; return f; }

/**
 * body: { connectionId, timestamp (ms or s since 1970), payload (JSON text), signature }
 * signature = hex HMAC-SHA256(secret, connectionId + "." + timestamp + "." + payload).
 * payload = { type: 'ping'|'sale'|'refund'|'stock', ...event }.
 */
function actionPosPush(body) {
  if (!posHubEnabled()) return hubPushFail('not_enabled', 'This feature is not switched on.');
  var connectionId = hubStr(body && body.connectionId, 60);
  var payloadText = typeof (body && body.payload) === 'string' ? body.payload : '';
  var signature = hubStr(body && body.signature, 100).toLowerCase();
  if (!connectionId || !payloadText || !signature) return hubPushFail('bad_request', 'connectionId, timestamp, payload and signature are required.');
  if (payloadText.length > HUB_MAX_PAYLOAD) return hubPushFail('too_large', 'The payload is too large (limit ' + HUB_MAX_PAYLOAD + ' characters).');
  var ts = hubParseTime(body.timestamp);
  if (!isFinite(ts)) return hubPushFail('bad_request', 'A valid timestamp is required.');
  // Unknown connection and bad signature look the same to the caller.
  var secret = PropertiesService.getScriptProperties().getProperty(hubSecretKey(connectionId));
  var row = secret ? findRowById(getInventoryConnectionsSheet(), 'ConnectionId', connectionId) : null;
  var expected = secret ? hubHmacHex(secret, hubSignedText(connectionId, String(body.timestamp), payloadText)) : '';
  var good = !!row && row.Type === 'pushApi' && row.Status !== 'disconnected' && hubSafeEqual(expected, signature);
  // Bad guesses are limited globally (so they cannot lock a real connection out); real traffic per connection.
  if (!good) {
    if (rateLimitHit('ratelimit:poshub:bad', HUB_RATE_PER_MINUTE, 60)) return hubPushFail('rate_limited', 'Too many requests. Try again in a minute.');
    return hubPushFail('invalid_signature', 'The signature is not valid.');
  }
  if (rateLimitHit('ratelimit:poshub:' + connectionId, HUB_RATE_PER_MINUTE, 60)) return hubPushFail('rate_limited', 'Too many requests. Try again in a minute.');
  if (Math.abs(Date.now() - ts) > HUB_TIMESTAMP_WINDOW_MS) return hubPushFail('stale_timestamp', 'The timestamp is more than 5 minutes from now. Check the clock of your system.');
  if (row.Status === 'paused') return hubPushFail('paused', 'This connection is paused. Try again after it is resumed.');
  var p = hubParse(payloadText, null);
  if (!p || typeof p !== 'object' || Array.isArray(p)) return hubPushFail('bad_payload', 'The payload must be a JSON object.');
  var type = hubStr(p.type, 20).toLowerCase();
  if (HUB_EVENT_TYPES.indexOf(type) === -1) return hubPushFail('bad_payload', 'type must be one of ' + HUB_EVENT_TYPES.join(', ') + '.');

  var conn = hubConn(row);
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    row = findRowById(getInventoryConnectionsSheet(), 'ConnectionId', connectionId);
    if (!row || row.Status === 'disconnected') return hubPushFail('invalid_signature', 'The signature is not valid.');
    conn = hubConn(row);
    var owner = findRowById(getSheet('Owners'), 'OwnerId', conn.ownerId);
    if (!owner || owner.Status === 'closed') return hubPushFail('invalid_signature', 'The signature is not valid.');
    var nowStamp = nowIso();
    var patch = { lastSignalAt: nowStamp };
    if (!conn.settings.verifiedAt) patch.verifiedAt = nowStamp;
    hubSaveSettings(conn, patch, { Status: conn.status === 'pending_setup' ? 'connected' : conn.status, LastSyncAt: nowStamp });

    if (type === 'ping') return ok({ pong: true, verified: true, connectionId: conn.id, serverTime: nowStamp });

    var norm = type === 'sale' ? hubNormalizeSale(p) : type === 'refund' ? hubNormalizeRefund(p) : hubNormalizeStock(p);
    if (norm.error) {
      hubWriteEvent(conn, { Type: type, ExternalId: hubStr(p.id, 80), Status: 'rejected', ErrorCode: 'bad_payload', ErrorMessage: norm.error, PayloadHash: hubPayloadHash(payloadText), ReconStatus: '' });
      return hubPushFail('bad_payload', norm.error);
    }
    var n = norm.sale || norm.refund || norm.stock;
    var key = hubIdempotencyKey(conn, type, n);
    var prior = hubFindEventByKey(key);
    if (prior) {
      return ok({ duplicate: true, status: prior.Status, eventId: prior.EventId, reference: prior.Reference });
    }
    var stored = JSON.stringify(n);
    var base = { Type: type, ExternalId: n.id, Version: n.version || n.asOf || '', IdempotencyKey: key, CorrelationId: n.correlationId || '', PayloadHash: hubPayloadHash(payloadText),
      PayloadJson: stored.length <= 40000 ? stored : '' };
    if (hubIsEcho(conn, n)) {
      var eid = hubWriteEvent(conn, Object.assign(base, { Status: 'echo', ErrorMessage: 'This looks like a copy of a change Mwakete sent, so it was not applied again.' }), null);
      return ok({ echo: true, eventId: eid });
    }
    var res;
    try {
      res = hubProcessEvent(owner, conn, type, n);
    } catch (err) {
      Logger.log('posPush processing failed: ' + (err && err.message));
      res = { status: 'failed', code: 'processing_error', note: 'Mwakete could not process this event. It can be retried.' };
    }
    var attention = HUB_ATTENTION.indexOf(res.status) !== -1;
    var eventId = hubWriteEvent(conn, Object.assign(base, { Status: res.status, Reference: res.reference || '', ErrorCode: res.code || '', ErrorMessage: res.note || '',
      BeforeJson: res.before || '', AfterJson: res.after || '', ReconStatus: attention ? 'open' : '' }), null);
    // A sale that arrives after its refund releases the refund waiting for it.
    if (type === 'sale' && (res.status === 'applied' || res.status === 'conflict')) hubReleasePendingRefunds(owner, conn, n.id);
    return ok({ status: res.status, eventId: eventId, reference: res.reference || '', message: res.note || '' });
  } finally {
    lock.releaseLock();
  }
}

/** Refunds that arrived before their sale are applied now. The caller holds the lock. */
function hubReleasePendingRefunds(owner, conn, saleId) {
  hubRows('IntegrationEvents').filter(function (e) { return e.ConnectionId === conn.id && e.Type === 'refund' && e.Status === 'pending_parent' && e.ReconStatus !== 'resolved'; }).forEach(function (e) {
    var n = hubParse(e.PayloadJson, null);
    if (!n || n.saleId !== saleId) return;
    hubReprocess(owner, conn, e);
  });
}

/** Re-runs a stored event (retry / mapping fixed / parent arrived). The caller holds the lock. */
function hubReprocess(owner, conn, evt) {
  var n = hubParse(evt.PayloadJson, null);
  if (!n) return { status: 'failed', note: 'This event was too large to keep, so it cannot be retried. Ask your system to send it again.' };
  var res;
  try { res = hubProcessEvent(owner, conn, evt.Type, n); }
  catch (err) { Logger.log('retry failed: ' + (err && err.message)); res = { status: 'failed', code: 'processing_error', note: 'Mwakete could not process this event.' }; }
  var attention = HUB_ATTENTION.indexOf(res.status) !== -1;
  hubWriteEvent(conn, { Status: res.status, Reference: res.reference || evt.Reference, ErrorCode: res.code || '', ErrorMessage: res.note || '', BeforeJson: res.before || '', AfterJson: res.after || '',
    Attempts: (Number(evt.Attempts) || 1) + 1, ReconStatus: attention ? 'open' : 'resolved', ResolvedAt: attention ? '' : nowIso() }, evt);
  return res;
}

/* ==================== Seller actions: activity, retry, reconcile ==================== */

function hubPublicEvent(e) {
  return { eventId: e.EventId, connectionId: e.ConnectionId, provider: e.Provider, direction: e.Direction, type: e.Type, externalId: e.ExternalId, status: e.Status,
    reference: e.Reference, code: e.ErrorCode, message: hubSafeText(e.ErrorMessage, 300), attempts: Number(e.Attempts) || 1, recon: e.ReconStatus,
    retryable: ['needs_mapping', 'pending_parent', 'failed', 'dead'].indexOf(e.Status) !== -1 && e.ReconStatus !== 'resolved' && !!e.PayloadJson,
    before: hubParse(e.BeforeJson, null), after: hubParse(e.AfterJson, null), createdAt: e.CreatedAt, updatedAt: e.UpdatedAt };
}

/** body: connectionId?, status?, type?, q?, from?, to?, attentionOnly?, limit? */
function actionListIntegrationEvents(owner, body) {
  if (!posHubEnabled()) return hubOff();
  body = body || {};
  var q = String(body.q || '').trim().toLowerCase();
  var from = String(body.from || ''), to = String(body.to || '');
  var list = hubRows('IntegrationEvents').filter(function (e) {
    if (e.OwnerId !== owner.OwnerId) return false;
    if (body.connectionId && e.ConnectionId !== body.connectionId) return false;
    if (body.status && e.Status !== body.status) return false;
    if (body.type && e.Type !== body.type) return false;
    if (body.attentionOnly === true && !(HUB_ATTENTION.indexOf(e.Status) !== -1 && e.ReconStatus !== 'resolved')) return false;
    if (from && String(e.CreatedAt) < from) return false;
    if (to && String(e.CreatedAt) > to + 'T23:59:59Z') return false;
    if (q && (String(e.ExternalId).toLowerCase().indexOf(q) === -1 && String(e.Reference).toLowerCase().indexOf(q) === -1 && String(e.ErrorMessage).toLowerCase().indexOf(q) === -1)) return false;
    return true;
  }).sort(function (a, b) { return String(b.CreatedAt).localeCompare(String(a.CreatedAt)); });
  var limit = Math.max(1, Math.min(200, parseInt(body.limit, 10) || 50));
  return ok({ events: list.slice(0, limit).map(hubPublicEvent), total: list.length });
}

/** body: eventId, action: 'retry' | 'accept_external' | 'keep_mwakete' | 'acknowledge', note? */
function actionResolveIntegrationEvent(owner, body) {
  if (!posHubEnabled()) return hubOff();
  var action = String(body.resolution || '');
  if (['retry', 'accept_external', 'keep_mwakete', 'acknowledge'].indexOf(action) === -1) return fail('Choose what to do with this item.');
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sheet = hubEventsSheet();
    var evt = findRowById(sheet, 'EventId', String(body.eventId || ''));
    if (!evt || evt.OwnerId !== owner.OwnerId) return fail('That item was not found.');
    var crow = hubConnectionRow(owner, evt.ConnectionId);
    if (!crow) return fail('That connection was not found.');
    var conn = hubConn(crow);
    if (evt.ReconStatus === 'resolved' && action !== 'retry') return fail('That item is already resolved.');
    var note = hubSafeText(body.note, 200);
    if (action === 'retry') {
      if (['needs_mapping', 'pending_parent', 'failed', 'dead'].indexOf(evt.Status) === -1 || evt.ReconStatus === 'resolved') return fail('This item cannot be retried.');
      var res = hubReprocess(owner, conn, evt);
      appendAudit({ actorId: owner.OwnerId, actorRole: 'seller', action: 'POS_EVENT_RETRIED', entityType: 'integration_event', entityId: evt.EventId, next: res.status });
      return ok({ status: res.status, message: res.note || '' });
    }
    if (action === 'acknowledge') {
      hubWriteEvent(conn, { ReconStatus: 'resolved', ResolvedBy: owner.OwnerId, ResolvedAt: nowIso(), ErrorMessage: (evt.ErrorMessage ? evt.ErrorMessage + ' ' : '') + (note ? '[Seller note: ' + note + ']' : '[Acknowledged]') }, evt);
      appendAudit({ actorId: owner.OwnerId, actorRole: 'seller', action: 'POS_EVENT_ACKNOWLEDGED', entityType: 'integration_event', entityId: evt.EventId, reason: note });
      return ok({ resolved: true });
    }
    // accept_external / keep_mwakete are for stock counts only.
    if (evt.ErrorCode !== 'stock_snapshot') return fail('That choice is only for stock counts.');
    if (action === 'keep_mwakete') {
      hubWriteEvent(conn, { ReconStatus: 'resolved', ResolvedBy: owner.OwnerId, ResolvedAt: nowIso(), ErrorMessage: 'You chose to keep the Mwakete numbers. Nothing was changed.' }, evt);
      appendAudit({ actorId: owner.OwnerId, actorRole: 'seller', action: 'POS_RECON_KEPT', entityType: 'integration_event', entityId: evt.EventId });
      return ok({ resolved: true, changed: 0 });
    }
    var diffs = (hubParse(evt.BeforeJson, {}) || {}).differences || [];
    var ctx = hubStockContext(owner);
    var changed = 0, skipped = [];
    diffs.forEach(function (d) {
      var v = ctx.byId[d.variantId];
      if (!v || !isStockTracked(v)) { skipped.push(d.name + ': no longer available'); return; }
      var nowQty = physicalOf(v);
      if (d.locationId && d.locationId !== DEFAULT_LOCATION_ID) {
        var here = ((ownLocationStock(owner.OwnerId)[v.VariantId]) || {})[d.locationId] || 0;
        nowQty = here;
      }
      // The held-stock rule of the existing sync: a count below what open orders hold is never applied.
      var newTotal = physicalOf(v) + (d.external - nowQty);
      if (newTotal < reservedOf(v)) { skipped.push(d.name + ': ' + reservedOf(v) + ' are held by open orders'); return; }
      var r = applyStockDelta(owner, v, d.locationId, d.external - nowQty, 'EXTERNAL_SYNC', conn.provider, evt.EventId, 'Accepted count from your system', { fact: false, userId: owner.OwnerId });
      if (r.error) skipped.push(d.name + ': ' + r.error); else if (r.applied) changed++;
    });
    hubWriteEvent(conn, { ReconStatus: 'resolved', ResolvedBy: owner.OwnerId, ResolvedAt: nowIso(), Status: 'applied',
      ErrorMessage: 'You accepted the counts: ' + changed + ' changed' + (skipped.length ? ', ' + skipped.length + ' skipped (' + hubSafeText(skipped.join('; '), 150) + ')' : '') + '.' }, evt);
    appendAudit({ actorId: owner.OwnerId, actorRole: 'seller', action: 'POS_RECON_ACCEPTED', entityType: 'integration_event', entityId: evt.EventId, next: String(changed) });
    return ok({ resolved: true, changed: changed, skipped: skipped });
  } finally {
    lock.releaseLock();
  }
}

/** body: connectionId?, from?, to?, limit? */
function actionListExternalSales(owner, body) {
  if (!posHubEnabled()) return hubOff();
  body = body || {};
  var list = hubRows('ExternalSales').filter(function (s) {
    return s.OwnerId === owner.OwnerId && (!body.connectionId || s.ConnectionId === body.connectionId) && (!body.from || String(s.OccurredAt) >= body.from) && (!body.to || String(s.OccurredAt) <= body.to + 'T23:59:59Z');
  }).sort(function (a, b) { return String(b.OccurredAt).localeCompare(String(a.OccurredAt)); });
  var limit = Math.max(1, Math.min(200, parseInt(body.limit, 10) || 50));
  return ok({ sales: list.slice(0, limit).map(function (s) {
    return { id: s.ExternalSaleId, connectionId: s.ConnectionId, provider: s.Provider, externalTxnId: s.ExternalTxnId, storeId: s.ExternalStoreId, occurredAt: s.OccurredAt, currency: s.Currency,
      total: Number(s.Total) || 0, refunded: Number(s.RefundedAmount) || 0, paymentMethod: s.PaymentMethod, paymentStatus: s.PaymentStatus, status: s.Status, stockApplied: s.StockApplied };
  }), total: list.length });
}
