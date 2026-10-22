/**
 * Outbound order events for the POS & Integration Hub (IntegrationHub.gs).
 *
 * When a seller has switched on "send my online orders to my POS" and has a
 * verified https URL, Mwakete posts three events there: order.created,
 * order.paid, order.cancelled and order.completed. They go through a durable
 * OUTBOX (the IntegrationOutbox tab), never straight from checkout:
 *
 *  - Enqueuing is one fast row append inside the order's own lock, so an
 *    outage on the seller's side can never slow or fail a checkout.
 *  - Delivery runs from the hourly runReminderSweep (runPosOutbox), takes only
 *    what fits in its time budget, and keeps going next hour.
 *  - The network call is made OUTSIDE the script lock. The lock is taken only
 *    to record the result.
 *  - Every message carries a stable idempotency key (X-Mwakete-Idempotency-Key
 *    and in the body). A timeout is an AMBIGUOUS outcome, not a failure: the
 *    same key is sent again and the receiver is expected to de-duplicate.
 *  - Retries back off (2^attempts minutes, with jitter, capped at 6 hours),
 *    six attempts, then the message is "dead" and waits for the seller.
 *  - Messages are signed (HMAC-SHA256 of timestamp + "." + body, with the
 *    connection's secret) in the X-Mwakete-Signature header and the body.
 *  - Only public https URLs are allowed (hubUrlError) and redirects are not
 *    followed. The response body is never kept or shown.
 *  - Customer contact details are left out unless the seller turns them on.
 *
 * Tab (created on first use): IntegrationOutbox.
 */

var HUB_OUTBOX_HEADERS = ['OutboxId', 'OwnerId', 'ConnectionId', 'EventType', 'ReferenceId', 'IdempotencyKey', 'CorrelationId', 'PayloadJson', 'Status',
  'Attempts', 'NextAttemptAt', 'LastStatusCode', 'LastError', 'CreatedAt', 'UpdatedAt', 'SentAt'];
var HUB_OUTBOX_MAX_ATTEMPTS = 6;
var HUB_OUTBOX_BATCH = 25;
var HUB_ORDER_EVENTS = { 'Paid': 'order.paid', 'Cancelled': 'order.cancelled', 'Fulfilled': 'order.completed' };

function hubOutboxSheet() { return hubSheet('IntegrationOutbox', HUB_OUTBOX_HEADERS); }

/** The seller's connections that should receive order events: URL set and verified, exporting on, not paused. */
function hubExportConnections(ownerId) {
  var sheet = SpreadsheetApp.getActive().getSheetByName('InventoryConnections');
  if (!sheet) return [];
  return sheetToObjects(sheet).filter(function (c) {
    if (c.OwnerId !== ownerId || c.Type !== 'pushApi' || c.Status === 'disconnected' || c.Status === 'paused') return false;
    var s = hubParse(c.SettingsJson, {});
    return !!(s.rules && s.rules.exportOrders === true && s.webhookUrl && s.webhookVerifiedAt);
  }).map(hubConn);
}

/** A cheap "does this seller export orders at all?", cached so checkout pays nothing for sellers who do not. */
function posOutboxWanted(ownerId) {
  try {
    var cache = CacheService.getScriptCache();
    var key = 'v1:poshub:export:' + ownerId;
    var hit = cache.get(key);
    if (hit !== null && hit !== undefined) return hit === '1';
    var yes = posHubEnabled() && hubExportConnections(ownerId).length > 0;
    cache.put(key, yes ? '1' : '0', 300);
    return yes;
  } catch (e) { return false; }
}

function hubOrderPayload(order, conn, eventType, key, corr) {
  var items = hubParse(order.ItemsJson, []);
  var out = { event: eventType, idempotencyKey: key, correlationId: corr, occurredAt: nowIso(), origin: 'mwakete',
    order: { orderId: order.OrderId, status: eventType === 'order.created' ? 'Pending Payment' : String(order.Status || ''), createdAt: order.CreatedAt || '', storeSlug: order.StoreSlug || '',
      items: (Array.isArray(items) ? items : []).slice(0, HUB_MAX_LINES).map(function (l) {
        return { variantId: l.variantId || '', sku: l.sku || l.SKU || '', name: String(l.name || l.productName || '').slice(0, 120), label: String(l.label || l.variantLabel || '').slice(0, 80),
          qty: Number(l.qty) || 0, unitPrice: Number(l.unitPrice !== undefined ? l.unitPrice : l.price) || 0 };
      }),
      subtotal: Number(order.Subtotal) || 0, deliveryCost: order.DeliveryCost === '' || order.DeliveryCost === undefined ? null : Number(order.DeliveryCost), total: Number(order.Total) || 0,
      deliveryMethod: order.DeliveryMethod || '', paymentMethod: order.PaymentMethod || '' } };
  if (conn.settings.rules.shareCustomerContact === true) out.customer = { name: String(order.CustomerName || '').slice(0, 100), phone: String(order.CustomerPhone || '').slice(0, 30) };
  return out;
}

/**
 * Called from the checkout (order.created) and from applyOrderStatusStock
 * (the other events). Never throws and never blocks the order.
 */
function posOutboxOrderEvent(order, eventType) {
  try {
    if (!order || !eventType || !posOutboxWanted(order.OwnerId)) return;
    var conns = hubExportConnections(order.OwnerId);
    if (!conns.length) return;
    var sheet = hubOutboxSheet();
    conns.forEach(function (conn) {
      var key = conn.id + '|' + eventType + '|' + order.OrderId;
      var corr = 'corr_' + hubPayloadHash(key);
      if (hubRows('IntegrationOutbox').some(function (o) { return o.IdempotencyKey === key; })) return;
      var payload = hubOrderPayload(order, conn, eventType, key, corr);
      appendRowFromObject(sheet, { OutboxId: newId('out'), OwnerId: order.OwnerId, ConnectionId: conn.id, EventType: eventType, ReferenceId: order.OrderId, IdempotencyKey: key,
        CorrelationId: corr, PayloadJson: JSON.stringify(payload).slice(0, 45000), Status: 'pending', Attempts: 0, NextAttemptAt: nowIso(), CreatedAt: nowIso(), UpdatedAt: nowIso() });
    });
  } catch (e) { Logger.log('outbox enqueue failed: ' + (e && e.message)); }
}

function posOutboxOrderCreated(order) { posOutboxOrderEvent(order, 'order.created'); }
function posOutboxOrderStatus(order, newStatus) {
  var ev = HUB_ORDER_EVENTS[newStatus];
  if (ev) posOutboxOrderEvent(Object.assign({}, order, { Status: newStatus }), ev);
}

function hubCancelOutbox(connectionId) {
  var sheet = hubOutboxSheet();
  hubRows('IntegrationOutbox').filter(function (o) { return o.ConnectionId === connectionId && o.Status === 'pending'; }).forEach(function (o) {
    updateRowFromObject(sheet, o.__row, { Status: 'cancelled', UpdatedAt: nowIso(), LastError: 'The connection was disconnected.' });
  });
}

function hubBackoffMs(attempts) {
  var base = Math.min(6 * 3600000, Math.pow(2, attempts) * 60000);
  return Math.round(base * (0.75 + Math.random() * 0.5));
}

/** One signed POST. No lock is held. Returns { code, retry, error }. */
function hubSendSigned(conn, bodyText, extraHeaders) {
  var secret = PropertiesService.getScriptProperties().getProperty(hubSecretKey(conn.id));
  if (!secret) return { code: 0, retry: false, error: 'The connection has no secret (it was disconnected).' };
  var uErr = hubUrlError(conn.settings.webhookUrl);
  if (uErr) return { code: 0, retry: false, error: uErr };
  var ts = String(Date.now());
  var sig = hubHmacHex(secret, ts + '.' + bodyText);
  var headers = Object.assign({ 'X-Mwakete-Signature': sig, 'X-Mwakete-Timestamp': ts }, extraHeaders || {});
  try {
    var resp = UrlFetchApp.fetch(conn.settings.webhookUrl, { method: 'post', contentType: 'application/json', payload: bodyText, headers: headers, muteHttpExceptions: true, followRedirects: false });
    var code = Number(resp.getResponseCode()) || 0;
    if (code >= 200 && code < 300) return { code: code, ok: true };
    if (code === 408 || code === 425 || code === 429 || code >= 500) return { code: code, retry: true, error: 'The other system answered ' + code + '.' };
    return { code: code, retry: false, error: 'The other system refused it (' + code + '). Check the address and that it accepts these messages.' };
  } catch (e) {
    // No answer is an unknown outcome: send again with the same key.
    return { code: 0, retry: true, error: 'No answer from the other system (' + hubSafeText(e && e.message, 80) + ').' };
  }
}

/** Sends the due messages (called hourly and by a seller's "send now"). Network calls are outside the lock. */
function runPosOutbox(onlyOwnerId) {
  if (!posHubEnabled()) return 0;
  var sheet = SpreadsheetApp.getActive().getSheetByName('IntegrationOutbox');
  if (!sheet) return 0;
  var started = Date.now();
  var now = nowIso();
  var due = sheetToObjects(sheet).filter(function (o) { return o.Status === 'pending' && String(o.NextAttemptAt) <= now && (!onlyOwnerId || o.OwnerId === onlyOwnerId); })
    .sort(function (a, b) { return String(a.CreatedAt).localeCompare(String(b.CreatedAt)); }).slice(0, HUB_OUTBOX_BATCH);
  var done = 0;
  for (var i = 0; i < due.length; i++) {
    if (Date.now() - started > 4 * 60 * 1000) break;
    var o = due[i];
    var crow = SpreadsheetApp.getActive().getSheetByName('InventoryConnections');
    var conn = null;
    var raw = crow ? findRowById(crow, 'ConnectionId', o.ConnectionId) : null;
    if (raw && raw.Status !== 'disconnected' && raw.Status !== 'paused') conn = hubConn(raw);
    var result;
    if (!conn) result = { code: 0, retry: false, error: 'The connection is paused or disconnected.' };
    else result = hubSendSigned(conn, o.PayloadJson, { 'X-Mwakete-Idempotency-Key': o.IdempotencyKey, 'X-Mwakete-Event': o.EventType });
    var lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try {
      var fresh = findRowById(sheet, 'OutboxId', o.OutboxId);
      if (!fresh || fresh.Status !== 'pending') continue; // cancelled or sent meanwhile
      var attempts = (Number(fresh.Attempts) || 0) + 1;
      if (result.ok) updateRowFromObject(sheet, fresh.__row, { Status: 'sent', Attempts: attempts, SentAt: nowIso(), LastStatusCode: result.code, LastError: '', UpdatedAt: nowIso() });
      else if (result.retry && attempts < HUB_OUTBOX_MAX_ATTEMPTS) {
        updateRowFromObject(sheet, fresh.__row, { Attempts: attempts, NextAttemptAt: new Date(Date.now() + hubBackoffMs(attempts)).toISOString(), LastStatusCode: result.code, LastError: result.error, UpdatedAt: nowIso() });
      } else {
        updateRowFromObject(sheet, fresh.__row, { Status: 'dead', Attempts: attempts, LastStatusCode: result.code, LastError: result.error + (result.retry ? ' Gave up after ' + attempts + ' tries.' : ''), UpdatedAt: nowIso() });
        if (conn) hubWriteEvent(conn, { Direction: 'out', Type: fresh.EventType, ExternalId: fresh.ReferenceId, IdempotencyKey: 'out|' + fresh.OutboxId, Status: 'dead', Reference: fresh.OutboxId,
          CorrelationId: fresh.CorrelationId, ErrorCode: 'delivery_failed', ErrorMessage: result.error, ReconStatus: 'open' }, null);
      }
      done++;
    } finally {
      lock.releaseLock();
    }
  }
  return done;
}

/** body: connectionId. Sends a signed "ping" to the seller's URL and remembers that it worked. Never returns the response. */
function actionTestPosWebhook(owner, body) {
  if (!posHubEnabled()) return hubOff();
  var row = hubConnectionRow(owner, body.connectionId);
  if (!row || row.Type !== 'pushApi' || row.Status === 'disconnected') return fail('That connection was not found.');
  var conn = hubConn(row);
  if (!conn.settings.webhookUrl) return fail('Add the address that should receive your orders first.');
  var payload = JSON.stringify({ event: 'ping', occurredAt: nowIso(), origin: 'mwakete', connectionId: conn.id });
  var r = hubSendSigned(conn, payload, { 'X-Mwakete-Event': 'ping' }); // no lock held
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var fresh = hubConnectionRow(owner, body.connectionId);
    if (!fresh) return fail('That connection was not found.');
    var c2 = hubConn(fresh);
    hubSaveSettings(c2, r.ok ? { webhookVerifiedAt: nowIso() } : { webhookVerifiedAt: '' });
    hubInvalidateExportCache(owner.OwnerId);
  } finally {
    lock.releaseLock();
  }
  appendAudit({ actorId: owner.OwnerId, actorRole: 'seller', action: 'POS_WEBHOOK_TESTED', entityType: 'integration', entityId: conn.id, next: r.ok ? 'ok' : 'failed' });
  if (r.ok) return ok({ reachable: true, httpStatus: r.code });
  return ok({ reachable: false, httpStatus: r.code, message: r.error });
}

/** body: connectionId?, status? */
function actionListIntegrationOutbox(owner, body) {
  if (!posHubEnabled()) return hubOff();
  body = body || {};
  var list = hubRows('IntegrationOutbox').filter(function (o) { return o.OwnerId === owner.OwnerId && (!body.connectionId || o.ConnectionId === body.connectionId) && (!body.status || o.Status === body.status); })
    .sort(function (a, b) { return String(b.CreatedAt).localeCompare(String(a.CreatedAt)); }).slice(0, 100);
  return ok({ items: list.map(function (o) {
    return { outboxId: o.OutboxId, connectionId: o.ConnectionId, event: o.EventType, orderId: o.ReferenceId, status: o.Status, attempts: Number(o.Attempts) || 0,
      nextAttemptAt: o.NextAttemptAt, httpStatus: o.LastStatusCode, error: hubSafeText(o.LastError, 200), createdAt: o.CreatedAt, sentAt: o.SentAt };
  }) });
}

/** body: outboxId. A dead or failed message goes back to the queue. */
function actionRetryIntegrationOutbox(owner, body) {
  if (!posHubEnabled()) return hubOff();
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sheet = hubOutboxSheet();
    var o = findRowById(sheet, 'OutboxId', String(body.outboxId || ''));
    if (!o || o.OwnerId !== owner.OwnerId) return fail('That message was not found.');
    if (o.Status !== 'dead') return fail('Only a message that gave up can be retried.');
    updateRowFromObject(sheet, o.__row, { Status: 'pending', Attempts: 0, NextAttemptAt: nowIso(), LastError: '', UpdatedAt: nowIso() });
    appendAudit({ actorId: owner.OwnerId, actorRole: 'seller', action: 'POS_OUTBOX_RETRIED', entityType: 'integration_outbox', entityId: o.OutboxId });
    return ok({ queued: true });
  } finally {
    lock.releaseLock();
  }
}

/** The seller presses "send now": the waiting messages for this seller go out immediately. */
function actionSendIntegrationOutboxNow(owner) {
  if (!posHubEnabled()) return hubOff();
  var sent = runPosOutbox(owner.OwnerId);
  return ok({ processed: sent });
}
