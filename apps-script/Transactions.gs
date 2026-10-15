/**
 * Order rooms: one private room per order where the buyer and the seller talk
 * about THAT order, send photos and receipts, and record payment, dispatch,
 * collection and receipt - plus problem reports that an admin can review.
 * (Owner request, Oct 2026. Design and guides: docs/transaction-rooms.md.)
 *
 * WHAT MWAKETE IS AND IS NOT. Payment is arranged directly between buyer and
 * seller (checkout.html says so); Mwakete never holds the money. So nothing
 * here is escrow, insurance or a guarantee, and no wording may say it is. A
 * screenshot is what the buyer SAYS they paid; only the seller, looking at
 * their own bank or wallet (or the cash in their hand), can say the money
 * arrived. A dispatch record is what the seller SAYS they sent; only the
 * buyer can say it arrived.
 *
 * WHO. Identity always comes from a session the server checks:
 *   buyer  - a signed-in customer (requireCustomerAuth) whose verified email
 *            is the order's CustomerEmail - the same rule the customer
 *            dashboard already uses to list "my orders".
 *   seller - the store owner session (requireAuth) whose OwnerId is the
 *            order's OwnerId.
 *   admin  - an owner session whose email is in ADMIN_EMAILS. An admin who is
 *            the seller (or the buyer) of an order can read its room but can
 *            never decide its dispute or grant it an exception.
 * The page sends side=buyer|seller|admin to say which session table to check;
 * it can never choose WHO it is. Every action re-checks access to the order;
 * "not found" is the same message whether the order is missing or not yours.
 *
 * TABS - created on first use, all additive (Orders gains no columns; only its
 * existing Status is written, through the same stock-aware path as before):
 *   TxState     one row per order with a room: payment / fulfilment / receipt /
 *               refund sub-states, the open dispute, read marks, a Version.
 *   TxEvents    the room's timeline: messages, system prompts, records.
 *   TxEvidence  one row per uploaded file (metadata only; the file itself is
 *               a PRIVATE Drive file, never shared, served only through
 *               getTxEvidence after the access check).
 *   TxRecords   append-only facts: payment submissions and verifications,
 *               checklists, dispatch, handover, receipt, refunds, exceptions.
 *   TxDisputes  problem reports and their history.
 *   TxConfig    admin settings (evidence policy, limits, retention, prompts).
 * Material actions also go to the shared Audit_Log (appendAudit).
 *
 * ORDER STATUS. Orders.Status stays the one order status (Pending Payment /
 * Paid / Fulfilled / Cancelled) everything else already reads. Here:
 *   payment verified by the seller -> Paid
 *   goods dispatched / handed over  -> stock moves to sold (Inventory.gs)
 *   buyer confirms receipt, payment verified, no open problem -> Fulfilled
 *   cancelled under the rules below -> Cancelled (reservation released)
 *
 * ROLLOUT. Script Property TX_ROOMS: 'off' (default - nothing changes), 'pilot'
 * (only the store slugs in TX_PILOT_STORES) or 'on'. An order placed while
 * rooms are on gets Flow 'v1' - the full workflow, and the Orders page status
 * dropdown no longer applies to it. An older order gets a 'legacy' room when
 * first opened: messages, photos, receipt confirmation and problem reports,
 * but its payment and status stay with the seller's dropdown as before, and
 * no evidence is invented for it.
 */

/* ==================== Schema ==================== */

var TX_STATE_HEADERS = ['OrderId', 'Flow', 'PaymentState', 'FulfilmentState', 'ReceiptState', 'RefundState', 'OpenDisputeId',
  'Hold', 'HoldReason', 'Version', 'LastSeq', 'LastEventAt', 'ReadBuyerSeq', 'ReadSellerSeq', 'CreatedAt', 'UpdatedAt'];
var TX_EVENT_HEADERS = ['EventId', 'OrderId', 'Seq', 'Kind', 'ActorType', 'ActorId', 'Body', 'EvidenceIds', 'DataJson',
  'Audience', 'RequestId', 'CreatedAt'];
var TX_EVIDENCE_HEADERS = ['EvidenceId', 'OrderId', 'EventId', 'SubmitterType', 'SubmitterId', 'Category', 'Stage', 'FileId',
  'ThumbFileId', 'DisplayName', 'MimeType', 'SizeBytes', 'Width', 'Height', 'Sha256', 'Description', 'ReviewStatus',
  'ReviewedBy', 'ReviewedAt', 'ReviewNote', 'Retention', 'DeletedAt', 'DeletedReason', 'RequestId', 'CreatedAt'];
var TX_RECORD_HEADERS = ['RecordId', 'OrderId', 'Type', 'ActorType', 'ActorId', 'Result', 'Reason', 'DataJson', 'EvidenceIds',
  'FlagsJson', 'SupersedesId', 'RequestId', 'CreatedAt'];
var TX_DISPUTE_HEADERS = ['DisputeId', 'OrderId', 'OpenedByType', 'OpenedById', 'Category', 'Description', 'Status',
  'Outcome', 'Rationale', 'OrderEffect', 'DecidedBy', 'DecidedAt', 'HistoryJson', 'Version', 'CreatedAt', 'UpdatedAt'];
var TX_CONFIG_HEADERS = ['Key', 'Value', 'UpdatedAt', 'UpdatedBy'];

function txSheet(name) {
  var headers = { TxState: TX_STATE_HEADERS, TxEvents: TX_EVENT_HEADERS, TxEvidence: TX_EVIDENCE_HEADERS,
    TxRecords: TX_RECORD_HEADERS, TxDisputes: TX_DISPUTE_HEADERS, TxConfig: TX_CONFIG_HEADERS }[name];
  return getSheetCreating(name, headers);
}

/** Rows of a tab that may not exist yet - [] instead of creating it on a read. */
function txRows(name) {
  var sheet = SpreadsheetApp.getActive().getSheetByName(name);
  return sheet ? sheetToObjects(sheet) : [];
}

/* ==================== Labels and lists ==================== */

var TX_PAYMENT_STATES = ['pending', 'submitted', 'verified', 'rejected'];
var TX_FULFILMENT_STATES = ['', 'preparing', 'ready_dispatch', 'ready_collection', 'dispatched', 'delivered', 'handed_over'];
var TX_RECEIPT_CHOICES = ['ok', 'problem', 'partial', 'not_received', 'unable'];
var TX_PAYMENT_METHODS = { bank_transfer: 'Bank transfer', mobile_money: 'Mobile money', cash: 'Cash in person', other: 'Other' };

var TX_PAYMENT_LABEL = {
  pending: 'Payment not yet confirmed', submitted: 'Payment details sent - waiting for the seller to check',
  verified: 'Payment confirmed by the seller', rejected: 'Seller could not find this payment'
};
var TX_FULFILMENT_LABEL = {
  '': 'Not prepared yet', preparing: 'Being prepared', ready_dispatch: 'Ready to send', ready_collection: 'Ready for collection',
  dispatched: 'Sent by the seller', delivered: 'Seller reports delivered', handed_over: 'Handed over'
};
var TX_RECEIPT_LABEL = {
  '': 'Receipt not confirmed', confirmed: 'Buyer confirmed receipt', problem: 'Buyer reported a problem',
  partial: 'Buyer received part of the order', not_received: 'Buyer reports not received'
};

/**
 * Problem categories. `who` = which party may report it; `photo` = a photo is
 * required (Category C - conditional) under the default policy.
 */
var TX_DISPUTE_CATEGORIES = {
  payment_not_received: { label: 'Payment not received', who: ['seller'] },
  payment_amount: { label: 'Payment amount is wrong', who: ['buyer', 'seller'] },
  not_received: { label: 'Goods not received', who: ['buyer'] },
  wrong_item: { label: 'Wrong product or variety', who: ['buyer'], photo: true },
  missing_items: { label: 'Items missing or wrong quantity', who: ['buyer'] },
  damaged: { label: 'Goods damaged', who: ['buyer'], photo: true },
  condition: { label: 'Not as described', who: ['buyer'], photo: true },
  not_dispatched: { label: 'Seller has not sent or made the goods available', who: ['buyer'] },
  fraud: { label: 'Suspected fraud', who: ['buyer', 'seller'] },
  other: { label: 'Something else', who: ['buyer', 'seller'] }
};
var TX_DISPUTE_OPEN = ['awaiting_buyer', 'awaiting_seller', 'under_review', 'resolution_proposed'];
var TX_DISPUTE_LABEL = {
  awaiting_buyer: 'Waiting for the buyer', awaiting_seller: 'Waiting for the seller', under_review: 'Being reviewed by Mwakete',
  resolution_proposed: 'Mwakete has proposed a resolution', resolved: 'Resolved'
};
var TX_DISPUTE_OUTCOMES = {
  buyer: 'Decided in the buyer\'s favour', seller: 'Decided in the seller\'s favour', agreed: 'Buyer and seller agreed',
  no_fault: 'No fault found', withdrawn: 'Withdrawn by the person who reported it', insufficient: 'Not enough information to decide'
};
var TX_EVIDENCE_CATEGORIES = {
  payment: 'Payment receipt', goods: 'Goods condition', packaging: 'Packaging', defect: 'Defect',
  dispatch: 'Dispatch', handover: 'Handover', delivery: 'After delivery', dispute: 'Problem report', refund: 'Refund', other: 'Other'
};

/* ==================== Configuration ==================== */

/**
 * Every admin-tunable setting, with its default and how it is validated. A
 * small key/value model is enough here - there is no policy engine to learn.
 * Photo levels: 'required' (Category A/C - blocks the step), 'recommended'
 * (Category B - asked for, never blocks) or 'off'.
 */
var TX_CONFIG_SPEC = {
  'limits.maxFileMB': { def: 5, type: 'number', min: 1, max: 10, label: 'Largest file (MB)' },
  'limits.maxFilesPerOrder': { def: 40, type: 'number', min: 5, max: 100, label: 'Most files per order' },
  'limits.maxImageSide': { def: 10000, type: 'number', min: 1000, max: 20000, label: 'Largest image side (pixels)' },
  'types.pdf': { def: 'on', type: 'enum', values: ['on', 'off'], label: 'Allow PDF receipts' },
  'payment.receiptOrReference': { def: 'required', type: 'enum', values: ['required', 'recommended'], label: 'Buyer must give a reference or receipt' },
  'checklist.photo': { def: 'recommended', type: 'enum', values: ['required', 'recommended', 'off'], label: 'Goods photo before sending' },
  'dispatch.photo': { def: 'recommended', type: 'enum', values: ['required', 'recommended', 'off'], label: 'Photo when sending' },
  'handover.photo': { def: 'off', type: 'enum', values: ['required', 'recommended', 'off'], label: 'Photo at collection' },
  'conditional.photoCategories': { def: 'electronics,solar,fashion-jewellery,home-kitchenware', type: 'csv', label: 'Categories that must have a goods photo' },
  'conditional.highValueTotal': { def: 200, type: 'number', min: 0, max: 100000, label: 'Order total that needs goods and sending photos ($, 0 = never)' },
  'conditional.defectPhoto': { def: 'required', type: 'enum', values: ['required', 'recommended'], label: 'Photo when a defect is declared' },
  'dispute.photoCategories': { def: 'wrong_item,damaged,condition', type: 'csv', label: 'Problem types that need a photo' },
  'exceptions.allowed': { def: 'checklist.photo,dispatch.photo,handover.photo,dispute.photo,conditional.photo', type: 'csv',
    label: 'Requirements an admin may waive (with a reason)' },
  'retention.days': { def: 365, type: 'number', min: 30, max: 3650, label: 'Keep files of finished orders (days)' },
  'retention.disputeDays': { def: 730, type: 'number', min: 90, max: 3650, label: 'Keep files of disputed orders after resolution (days)' },
  'dispute.reopenDays': { def: 30, type: 'number', min: 0, max: 365, label: 'Days a resolved problem may be reopened' },
  'notify.email': { def: 'on', type: 'enum', values: ['on', 'off'], label: 'Email buyer and seller about room activity' },
  'prompt.payment': { def: 'Please submit your payment receipt or transfer screenshot through this order\'s chat if payment has been made. ' +
    'For your security, hide sensitive banking information. Your order will not be marked as paid until the seller confirms receipt of the funds.',
    type: 'text', label: 'Message: asking the buyer for payment details' },
  'prompt.verify': { def: 'The buyer has sent payment details. Please check your own bank, wallet or cash before confirming. ' +
    'A screenshot or reference on its own does not prove the money arrived.', type: 'text', label: 'Message: asking the seller to check payment' },
  'prompt.predispatch': { def: 'Before dispatch or handover, please check the actual goods against the order. Record the quantity, variety, ' +
    'condition and any defects, and add photos of the actual goods (not catalogue pictures).', type: 'text', label: 'Message: before sending' },
  'prompt.dispatch': { def: 'Please record the dispatch date, delivery method and tracking or reference number where available, with a photo ' +
    'when asked. A dispatch record does not by itself confirm delivery.', type: 'text', label: 'Message: recording dispatch' },
  'prompt.collection': { def: 'Your order is ready for collection. Please use this order\'s chat to confirm the collection arrangements. ' +
    'After the handover, record receipt accurately and report any unresolved issue.', type: 'text', label: 'Message: ready for collection' },
  'prompt.receipt': { def: 'Have you received your order? Please confirm receipt when appropriate. If anything is missing, damaged or different ' +
    'from what you ordered, choose "Report a problem" and add photos. Do not confirm while an unresolved issue remains.', type: 'text', label: 'Message: asking the buyer to confirm receipt' },
  'prompt.dispute': { def: 'This problem has been recorded. Please keep messages and photos about it in this order\'s chat. Mwakete will review ' +
    'the information available here; messages outside Mwakete may not be available to us.', type: 'text', label: 'Message: problem recorded' }
};
var TX_CONFIG_CACHE_KEY = 'v1:txConfig';

function txConfig() {
  var stored = getCached(TX_CONFIG_CACHE_KEY, 300, function () {
    var out = {};
    txRows('TxConfig').forEach(function (r) { out[String(r.Key)] = String(r.Value); });
    return out;
  }) || {};
  var cfg = {};
  Object.keys(TX_CONFIG_SPEC).forEach(function (k) {
    var spec = TX_CONFIG_SPEC[k];
    var v = Object.prototype.hasOwnProperty.call(stored, k) ? stored[k] : undefined;
    var clean = v === undefined ? null : txConfigValueError(k, v) ? null : txConfigClean(k, v);
    cfg[k] = clean === null ? spec.def : clean;
  });
  return cfg;
}

function txConfigClean(key, value) {
  var spec = TX_CONFIG_SPEC[key];
  if (spec.type === 'number') return Number(value);
  if (spec.type === 'csv') return String(value).split(',').map(function (s) { return s.trim(); }).filter(Boolean).join(',');
  return String(value).trim();
}

/** '' when the value is acceptable for that key, else the reason. */
function txConfigValueError(key, value) {
  var spec = TX_CONFIG_SPEC[key];
  if (!spec) return 'Unknown setting.';
  var s = String(value == null ? '' : value).trim();
  if (spec.type === 'number') {
    var n = Number(s);
    if (s === '' || !isFinite(n)) return spec.label + ' must be a number.';
    if (n < spec.min || n > spec.max) return spec.label + ' must be between ' + spec.min + ' and ' + spec.max + '.';
    return '';
  }
  if (spec.type === 'enum') return spec.values.indexOf(s) === -1 ? spec.label + ': choose ' + spec.values.join(' or ') + '.' : '';
  if (spec.type === 'csv') {
    if (s.length > 500) return spec.label + ' is too long.';
    if (!/^[a-z0-9_.,\- ]*$/i.test(s)) return spec.label + ': use ids separated by commas.';
    if (key === 'exceptions.allowed') {
      var bad = s.split(',').map(function (x) { return x.trim(); }).filter(function (x) { return x && TX_EXCEPTION_KEYS.indexOf(x) === -1; });
      if (bad.length) return 'Not a requirement that can be waived: ' + bad.join(', ');
    }
    if (key === 'dispute.photoCategories') {
      var badCat = s.split(',').map(function (x) { return x.trim(); }).filter(function (x) { return x && !TX_DISPUTE_CATEGORIES[x]; });
      if (badCat.length) return 'Unknown problem type: ' + badCat.join(', ');
    }
    return '';
  }
  if (!s) return spec.label + ' cannot be empty.';
  if (s.length > 600) return spec.label + ' must be 600 characters or fewer.';
  if (/[<>]/.test(s)) return spec.label + ' cannot contain < or >.';
  return '';
}

/** Requirements an admin exception can satisfy - never identity, ownership or payment verification. */
var TX_EXCEPTION_KEYS = ['checklist.photo', 'dispatch.photo', 'handover.photo', 'dispute.photo', 'conditional.photo', 'defect.photo'];

/* ==================== Rollout ==================== */

function txMode() {
  var v = String(PropertiesService.getScriptProperties().getProperty('TX_ROOMS') || 'off').trim().toLowerCase();
  return v === 'on' || v === 'pilot' ? v : 'off';
}

function txEnabledForStore(slug) {
  var mode = txMode();
  if (mode === 'on') return true;
  if (mode !== 'pilot') return false;
  var list = String(PropertiesService.getScriptProperties().getProperty('TX_PILOT_STORES') || '')
    .split(',').map(function (s) { return s.trim().toLowerCase(); }).filter(Boolean);
  return list.indexOf(String(slug || '').toLowerCase()) !== -1;
}

/* ==================== Identity and access ==================== */

/**
 * The caller, from a session the server checks. Returns { actor } or { error }.
 * actor: { type: 'buyer'|'seller'|'admin', id, email, owner?, customer? }
 */
function resolveTxActor(body) {
  body = body || {};
  var side = String(body.side || '');
  if (side === 'buyer') {
    var customer;
    try { customer = requireCustomerAuth(body.token); } catch (e) { return { error: e.message || 'Please sign in again.', auth: true }; }
    return { actor: { type: 'buyer', id: customer.CustomerId, email: normalizeEmail(customer.Email), customer: customer } };
  }
  if (side === 'seller' || side === 'admin') {
    var owner;
    try { owner = requireAuth(body.token); } catch (e2) { return { error: e2.message || 'Please log in again.', auth: true }; }
    if (side === 'admin' && !isOwnerAdmin(owner)) {
      appendAudit({ actorId: owner.OwnerId, actorRole: 'seller', action: 'UNAUTHORIZED_ATTEMPT', entityType: 'order',
        entityId: String(body.orderId || ''), next: 'tx admin: ' + String(body.action || '') });
      return { error: 'Not authorized' };
    }
    return { actor: { type: side, id: owner.OwnerId, email: normalizeEmail(owner.Email), owner: owner } };
  }
  return { error: 'Please sign in to open this order.', auth: true };
}

/** Is the actor the buyer or seller of this order (whatever side they called as)? */
function txIsParty(actor, order) {
  if (!actor || !order) return false;
  if (actor.owner && actor.owner.OwnerId === order.OwnerId) return true;
  return !!actor.email && normalizeEmail(order.CustomerEmail) === actor.email;
}

function txCanAccess(actor, order) {
  if (!actor || !order) return false;
  if (actor.type === 'buyer') return !!actor.email && normalizeEmail(order.CustomerEmail) === actor.email;
  if (actor.type === 'seller') return order.OwnerId === actor.id;
  if (actor.type === 'admin') return isOwnerAdmin(actor.owner);
  return false;
}

/**
 * Actor + order + room state, or { error }. Creates the room (a 'legacy' one
 * for an older order) on first access when rooms are on for the store.
 */
function loadTxContext(body, opts) {
  var who = resolveTxActor(body);
  if (who.error) return { error: who.error, auth: !!who.auth };
  var orderId = String((body && body.orderId) || '').trim();
  if (!orderId || orderId.length > 64) return { error: 'Order not found' };
  var ordersSheet = getSheet('Orders');
  var order = findRowById(ordersSheet, 'OrderId', orderId);
  if (!order || !txCanAccess(who.actor, order)) {
    if (order && who.actor.type !== 'admin') {
      appendAudit({ actorId: who.actor.id, actorRole: who.actor.type, action: 'TX_ACCESS_DENIED', entityType: 'order', entityId: orderId });
    }
    return { error: 'Order not found' };
  }
  if (!txEnabledForStore(order.StoreSlug)) return { error: 'Order rooms are not switched on for this store yet.' };
  var state = findRowById(txSheet('TxState'), 'OrderId', orderId);
  if (!state && !(opts && opts.noCreate)) state = initTxState(order, 'legacy');
  return { actor: who.actor, order: order, ordersSheet: ordersSheet, state: state };
}

/* ==================== State, events, records ==================== */

/**
 * The room for an order. Flow 'v1' = placed while rooms were on (full
 * workflow); 'legacy' = older order (see the header). Adds the opening prompt.
 */
function initTxState(order, flow) {
  var sheet = txSheet('TxState');
  var existing = findRowById(sheet, 'OrderId', order.OrderId);
  if (existing) return existing;
  var now = nowIso();
  var paid = String(order.Status) === 'Paid' || String(order.Status) === 'Fulfilled';
  var row = {
    OrderId: order.OrderId, Flow: flow, PaymentState: flow === 'v1' ? 'pending' : (paid ? 'verified' : 'pending'),
    // Nothing is invented for an older order: no fulfilment record exists, so none is claimed.
    FulfilmentState: '',
    ReceiptState: '', RefundState: '', OpenDisputeId: '', Hold: '', HoldReason: '', Version: 1, LastSeq: 0, LastEventAt: now,
    ReadBuyerSeq: 0, ReadSellerSeq: 0, CreatedAt: now, UpdatedAt: now
  };
  appendRowFromObject(sheet, row);
  var created = findRowById(sheet, 'OrderId', order.OrderId);
  if (flow === 'v1') {
    appendTxEvent(created, { kind: 'system', actorType: 'system', body: txConfig()['prompt.payment'], audience: 'buyer' });
    appendTxEvent(created, { kind: 'system', actorType: 'system',
      body: 'New order. The buyer has been asked to send payment details here. Check your own bank, wallet or cash before confirming payment.',
      audience: 'seller' });
  } else {
    appendTxEvent(created, { kind: 'system', actorType: 'system',
      body: 'This room was opened for an order placed before order rooms existed. Its payment and status are still set by the seller on the Orders page; ' +
        'use this room for messages, photos, confirming receipt and reporting problems.' });
  }
  return findRowById(sheet, 'OrderId', order.OrderId);
}

/** Writes changes to the state row and bumps Version. `state` is updated in place. */
function saveTxState(state, fields) {
  var f = Object.assign({}, fields, { Version: (Number(state.Version) || 0) + 1, UpdatedAt: nowIso() });
  updateRowFromObject(txSheet('TxState'), state.__row, f);
  Object.keys(f).forEach(function (k) { state[k] = f[k]; });
  return state;
}

function txEventsCacheKey(orderId) { return 'v1:tx:events:' + orderId; }

/**
 * Appends one timeline entry. ev: { kind, actorType, actorId, body, evidenceIds,
 * data, audience ('' = both parties, 'buyer', 'seller', 'admin') }.
 */
function appendTxEvent(state, ev) {
  var seq = (Number(state.LastSeq) || 0) + 1;
  var now = nowIso();
  var row = {
    EventId: newId('txe'), OrderId: state.OrderId, Seq: seq, Kind: ev.kind, ActorType: ev.actorType, ActorId: ev.actorId || '',
    Body: String(ev.body || '').slice(0, 2000), EvidenceIds: (ev.evidenceIds || []).join(','),
    DataJson: ev.data ? JSON.stringify(ev.data) : '', Audience: ev.audience || '', RequestId: ev.requestId || '', CreatedAt: now
  };
  appendRowFromObject(txSheet('TxEvents'), row);
  updateRowFromObject(txSheet('TxState'), state.__row, { LastSeq: seq, LastEventAt: now });
  state.LastSeq = seq; state.LastEventAt = now;
  invalidateCache([txEventsCacheKey(state.OrderId)]);
  return row;
}

function appendTxRecord(orderId, rec) {
  var row = {
    RecordId: newId('txr'), OrderId: orderId, Type: rec.type, ActorType: rec.actorType, ActorId: rec.actorId || '',
    Result: rec.result || '', Reason: String(rec.reason || '').slice(0, 1000), DataJson: rec.data ? JSON.stringify(rec.data) : '',
    EvidenceIds: (rec.evidenceIds || []).join(','), FlagsJson: rec.flags && rec.flags.length ? JSON.stringify(rec.flags) : '',
    SupersedesId: rec.supersedesId || '', RequestId: rec.requestId || '', CreatedAt: nowIso()
  };
  appendRowFromObject(txSheet('TxRecords'), row);
  return row;
}

function txRecordsFor(orderId) {
  return txRows('TxRecords').filter(function (r) { return r.OrderId === orderId; });
}

/** Latest record of a type that has not been superseded. */
function latestTxRecord(records, type) {
  var superseded = {};
  records.forEach(function (r) { if (r.SupersedesId) superseded[r.SupersedesId] = true; });
  var list = records.filter(function (r) { return r.Type === type && !superseded[r.RecordId]; });
  return list.length ? list[list.length - 1] : null;
}

function parseTxJson(s, fallback) {
  if (!s) return fallback;
  try { return JSON.parse(s); } catch (e) { return fallback; }
}

function txAudit(actor, action, orderId, previous, next, reason, requestId) {
  appendAudit({ actorId: actor ? actor.id : 'system', actorRole: actor ? actor.type : 'system', action: action, entityType: 'order',
    entityId: orderId, previous: previous, next: next, reason: reason, requestId: requestId });
}

/* ==================== Order facts ==================== */

function txIsCollection(order) { return String(order.DeliveryMethod) === 'pickPay'; }

function txOrderItems(order) {
  var items = [];
  try { items = JSON.parse(order.ItemsJson || '[]'); } catch (e) { items = []; }
  return Array.isArray(items) ? items : [];
}

/** Top category ids and subcategory ids of the order's products, from the live Products rows. */
function txOrderCategories(order) {
  var ids = {};
  txOrderItems(order).forEach(function (l) { if (l && l.productId) ids[l.productId] = true; });
  var cats = [];
  sheetToObjects(getSheet('Products')).forEach(function (p) {
    if (!ids[p.ProductId]) return;
    var c = typeof categoryIdOf === 'function' ? categoryIdOf(p.Category) : String(p.Category || '');
    if (c) cats.push(c);
    if (p.SubcategoryId) cats.push(String(p.SubcategoryId));
  });
  return cats;
}

function txOrderTotal(order) { return roundMoney(Number(order.Total) || 0); }

/* ==================== Evidence policy ==================== */

/**
 * The single place that decides what each step needs. Pure apart from the
 * config. ctx: { action, order, categories, evidence (validated files for this
 * step, [{Category}]), defects (string), exceptions ({key:true}), cfg }.
 * Returns [{ key, level: 'required'|'recommended', met, message }] - a
 * 'required' entry that is not met blocks the step unless ctx.exceptions has
 * its key (and the key is waivable).
 */
function txRequirements(ctx) {
  var cfg = ctx.cfg || txConfig();
  var out = [];
  var photos = (ctx.evidence || []).filter(function (e) { return /^image\//.test(String(e.MimeType || '')); });
  var add = function (key, level, met, message) {
    if (level === 'off') return;
    out.push({ key: key, level: level, met: !!met, message: message });
  };
  var cats = (ctx.categories || []).map(String);
  var photoCats = String(cfg['conditional.photoCategories'] || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  var highValue = Number(cfg['conditional.highValueTotal']) || 0;
  var total = ctx.order ? txOrderTotal(ctx.order) : 0;
  var conditionalHit = cats.some(function (c) { return photoCats.indexOf(c) !== -1; }) || (highValue > 0 && total >= highValue);

  if (ctx.action === 'checklist') {
    var level = conditionalHit ? 'required' : cfg['checklist.photo'];
    var key = conditionalHit && cfg['checklist.photo'] !== 'required' ? 'conditional.photo' : 'checklist.photo';
    add(key, level, photos.length > 0, conditionalHit
      ? 'This order needs a photo of the actual goods (its category or value means a photo matters if there is a problem later).'
      : 'A photo of the actual goods helps if there is any question later.');
    if (String(ctx.defects || '').trim()) {
      add('defect.photo', cfg['conditional.defectPhoto'], photos.some(function (e) { return e.Category === 'defect'; }),
        'You noted a defect - add a photo of it (choose "Defect" for the photo).');
    }
  } else if (ctx.action === 'dispatch') {
    var dl = highValue > 0 && total >= highValue ? 'required' : cfg['dispatch.photo'];
    add('dispatch.photo', dl, photos.length > 0, 'A photo of the packed goods or the hand-over to the carrier helps if the parcel goes missing.');
  } else if (ctx.action === 'handover') {
    add('handover.photo', cfg['handover.photo'], photos.length > 0, 'A photo at handover is a simple record that the goods were collected.');
  } else if (ctx.action === 'dispute') {
    var need = String(cfg['dispute.photoCategories'] || '').split(',').map(function (s) { return s.trim(); });
    if (need.indexOf(ctx.category) !== -1) {
      add('dispute.photo', 'required', photos.length > 0, 'Please add at least one photo showing the problem.');
    } else {
      add('dispute.photo', 'recommended', photos.length > 0, 'Photos help Mwakete understand the problem.');
    }
  } else if (ctx.action === 'payment') {
    add('payment.receipt', cfg['payment.receiptOrReference'], !!ctx.reference || (ctx.evidence || []).length > 0,
      'Add the transfer reference or a screenshot of the receipt, so the seller can find your payment.');
  }
  return out;
}

/** The first blocking requirement, or null. */
function txBlockingRequirement(reqs, exceptions) {
  var allowed = String(txConfig()['exceptions.allowed'] || '').split(',').map(function (s) { return s.trim(); });
  for (var i = 0; i < reqs.length; i++) {
    var r = reqs[i];
    if (r.level !== 'required' || r.met) continue;
    if (exceptions && exceptions[r.key] && allowed.indexOf(r.key) !== -1) continue;
    return r;
  }
  return null;
}

/** Exceptions an admin has granted on this order: { key: true }. */
function txExceptionsFor(records) {
  var out = {};
  records.forEach(function (r) { if (r.Type === 'exception' && r.Result) out[r.Result] = true; });
  return out;
}

/* ==================== Evidence files ==================== */

function getTxEvidenceFolder() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('TX_EVIDENCE_FOLDER_ID');
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) { /* recreate */ } }
  // Never shared: only the account that runs the script can open these files.
  var folder = DriveApp.createFolder('Mwakete Order Evidence (private)');
  props.setProperty('TX_EVIDENCE_FOLDER_ID', folder.getId());
  return folder;
}

/** Unsigned byte i (Apps Script byte arrays are signed). */
function txByte(bytes, i) { return bytes[i] & 0xff; }

/**
 * What the file really is, from its first bytes - never from the name or the
 * browser's MIME type. { type: 'image/jpeg'|'image/png'|'image/webp'|'application/pdf', width, height } or { error }.
 */
function sniffTxFile(bytes) {
  if (!bytes || bytes.length < 16) return { error: 'That file is empty or too small.' };
  var b = function (i) { return txByte(bytes, i); };
  if (b(0) === 0x89 && b(1) === 0x50 && b(2) === 0x4e && b(3) === 0x47) {
    return { type: 'image/png', width: (b(16) << 24 | b(17) << 16 | b(18) << 8 | b(19)) >>> 0, height: (b(20) << 24 | b(21) << 16 | b(22) << 8 | b(23)) >>> 0 };
  }
  if (b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff) {
    var i = 2;
    while (i + 9 < bytes.length) {
      if (b(i) !== 0xff) { i++; continue; }
      var marker = b(i + 1);
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      var len = b(i + 2) << 8 | b(i + 3);
      if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
        return { type: 'image/jpeg', height: b(i + 5) << 8 | b(i + 6), width: b(i + 7) << 8 | b(i + 8) };
      }
      if (len < 2) break;
      i += 2 + len;
    }
    return { type: 'image/jpeg', width: 0, height: 0 };
  }
  if (b(0) === 0x52 && b(1) === 0x49 && b(2) === 0x46 && b(3) === 0x46 && b(8) === 0x57 && b(9) === 0x45 && b(10) === 0x42 && b(11) === 0x50) {
    var chunk = String.fromCharCode(b(12), b(13), b(14), b(15));
    if (chunk === 'VP8X' && bytes.length >= 30) {
      return { type: 'image/webp', width: 1 + (b(24) | b(25) << 8 | b(26) << 16), height: 1 + (b(27) | b(28) << 8 | b(29) << 16) };
    }
    if (chunk === 'VP8L' && bytes.length >= 25) {
      return { type: 'image/webp', width: 1 + ((b(22) & 0x3f) << 8 | b(21)), height: 1 + ((b(24) & 0x0f) << 10 | b(23) << 2 | (b(22) & 0xc0) >> 6) };
    }
    if (chunk === 'VP8 ' && bytes.length >= 30) {
      return { type: 'image/webp', width: (b(26) | b(27) << 8) & 0x3fff, height: (b(28) | b(29) << 8) & 0x3fff };
    }
    return { type: 'image/webp', width: 0, height: 0 };
  }
  if (b(0) === 0x25 && b(1) === 0x50 && b(2) === 0x44 && b(3) === 0x46 && b(4) === 0x2d) return { type: 'application/pdf', width: 0, height: 0 };
  return { error: 'Only photos (JPG, PNG, WebP) and PDF receipts can be added.' };
}

/** A PDF that can run code or carry other files is refused - receipts never need either. */
function txPdfIsActive(bytes) {
  var s = '';
  var n = Math.min(bytes.length, 2 * 1024 * 1024);
  for (var i = 0; i < n; i++) s += String.fromCharCode(txByte(bytes, i));
  return /\/(JavaScript|JS|Launch|EmbeddedFile|OpenAction|AA|RichMedia|XFA)\b/.test(s);
}

/** Validates one uploaded file. Returns { bytes, sniff, sha } or { error }. */
function validateTxFile(base64, claimedMime, cfg) {
  var bytes;
  try { bytes = Utilities.base64Decode(String(base64 || '')); } catch (e) { return { error: 'That file could not be read. Please choose it again.' }; }
  if (!bytes || !bytes.length) return { error: 'No file was received. Please try again.' };
  var maxBytes = Number(cfg['limits.maxFileMB']) * 1024 * 1024;
  if (bytes.length > maxBytes) return { error: 'That file is too large (the limit is ' + cfg['limits.maxFileMB'] + ' MB).' };
  var sniff = sniffTxFile(bytes);
  if (sniff.error) return { error: sniff.error };
  if (sniff.type === 'application/pdf') {
    if (cfg['types.pdf'] !== 'on') return { error: 'PDF files are not accepted - please add a photo or screenshot instead.' };
    if (txPdfIsActive(bytes)) return { error: 'That PDF contains active content and cannot be added. Please add a screenshot instead.' };
  } else {
    if (!sniff.width || !sniff.height) return { error: 'That image could not be read. Please choose another photo.' };
    var side = Number(cfg['limits.maxImageSide']);
    if (sniff.width > side || sniff.height > side) return { error: 'That image is too large (over ' + side + ' pixels on a side).' };
    if (sniff.width < 32 || sniff.height < 32) return { error: 'That image is too small to show anything.' };
  }
  var claimed = String(claimedMime || '').toLowerCase().replace('image/jpg', 'image/jpeg');
  if (claimed && claimed !== sniff.type) return { error: 'That file is not what its name says. Please choose the original photo or PDF.' };
  return { bytes: bytes, sniff: sniff, sha: sha256Hex(bytes) };
}

function txExtension(type) {
  return { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'application/pdf': '.pdf' }[type] || '';
}

function txSafeDisplayName(name, type) {
  var base = String(name || '').replace(/^.*[\\/]/, '').replace(/[^A-Za-z0-9 ._()\-]/g, '').replace(/\.+$/, '').trim().slice(0, 60);
  base = base.replace(/\.[A-Za-z0-9]{1,5}$/, '');
  return (base || 'file') + txExtension(type);
}

/* ==================== Notifications ==================== */

/**
 * Collected during an action and sent after the lock is released, so a slow
 * email never holds the lock and a failed one never undoes the action. No
 * evidence, receipt or address ever goes in an email - only a link back to
 * the signed-in room.
 */
function queueTxNotify(queue, order, to, kind, dedupeId, subject, text) {
  queue.push({ order: order, to: to, kind: kind, dedupeId: dedupeId || '', subject: subject, text: text });
}

function flushTxNotify(queue) {
  if (!queue || !queue.length) return 0;
  if (txConfig()['notify.email'] !== 'on') return 0;
  var cache = CacheService.getScriptCache();
  var sent = 0;
  queue.forEach(function (n) {
    try {
      var key = 'v1:tx:notify:' + n.order.OrderId + ':' + n.to + ':' + n.kind + ':' + n.dedupeId;
      if (cache.get(key)) return;
      cache.put(key, '1', n.kind === 'message' ? 600 : 21600);
      var email = '';
      if (n.to === 'buyer') email = n.order.CustomerEmail;
      else {
        var owner = findRowById(getSheet('Owners'), 'OwnerId', n.order.OwnerId);
        email = owner && owner.Email;
      }
      if (!email) return;
      var base = siteBaseUrl();
      var link = base ? base + '/order-room.html?order=' + encodeURIComponent(n.order.OrderId) + '&as=' + n.to : '';
      var text = n.text + '\n\nOrder ' + n.order.OrderId + '.\n' +
        (link ? 'Open the order room: ' + link : 'Open the order from your Mwakete account.') +
        '\n\nFor your privacy, photos and receipts are only shown inside Mwakete after you sign in.';
      if (sendAppEmail(email, n.subject + ' - order ' + n.order.OrderId, text)) sent++;
    } catch (e) {
      Logger.log('tx notify failed: ' + (e && e.message));
    }
  });
  return sent;
}

/* ==================== Shared guards ==================== */

function txFail(msg, extra) { var f = fail(msg); if (extra) Object.keys(extra).forEach(function (k) { f[k] = extra[k]; }); return f; }

function txStale(state, body) {
  if (body && body.version !== undefined && body.version !== null && body.version !== '' && Number(body.version) !== Number(state.Version)) {
    return txFail('This order changed while you had it open. It has been refreshed - please check and try again.', { stale: true });
  }
  return null;
}

function txIsFinal(order) { return String(order.Status) === 'Cancelled'; }

function txOpenDispute(state) {
  if (!state || !state.OpenDisputeId) return null;
  var d = findRowById(txSheet('TxDisputes'), 'DisputeId', state.OpenDisputeId);
  return d && TX_DISPUTE_OPEN.indexOf(String(d.Status)) !== -1 ? d : null;
}

function txCleanText(v, max) { return String(v == null ? '' : v).replace(/\r\n/g, '\n').trim().slice(0, max); }

/** Validated evidence rows for ids the actor sent: same order, theirs, not removed. Returns { rows } or { error }. */
function txOwnEvidence(ctx, ids) {
  var list = Array.isArray(ids) ? ids.map(String).filter(Boolean) : [];
  if (list.length > 12) return { error: 'Too many files for one step.' };
  if (!list.length) return { rows: [] };
  var all = txRows('TxEvidence');
  var rows = [];
  for (var i = 0; i < list.length; i++) {
    var e = all.filter(function (x) { return x.EvidenceId === list[i]; })[0];
    if (!e || e.OrderId !== ctx.order.OrderId || e.SubmitterId !== ctx.actor.id || e.SubmitterType !== ctx.actor.type || e.DeletedAt) {
      return { error: 'One of the files does not belong to this order. Please add it again.' };
    }
    rows.push(e);
  }
  return { rows: rows };
}

/**
 * Runs a write: actor + order + room, the lock, retry safety (same requestId
 * gets the first answer), then the notifications after the lock.
 */
function runTxWrite(body, name, fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  var queue = [];
  var result, ctxOrder = null;
  try {
    var ctx = loadTxContext(body);
    if (ctx.error) return txFail(ctx.error, ctx.auth ? { authRequired: true } : null);
    ctxOrder = ctx.order;
    ctx.queue = queue;
    ctx.requestId = cleanRequestId(body.requestId);
    // Scoped to the person AND the order, so a reused requestId can never
    // replay one order's answer on another.
    result = idempotentResult('tx:' + name + ':' + ctx.actor.type + ':' + ctx.actor.id + ':' + ctx.order.OrderId, body.requestId, function () {
      var stale = txStale(ctx.state, body);
      if (stale) return stale;
      return fn(ctx);
    });
  } finally {
    lock.releaseLock();
  }
  if (result && result.ok && !result.replayed) {
    flushTxNotify(queue);
    if (ctxOrder) txInvalidateBuyerLists(ctxOrder);
  }
  return result;
}

function txRoleOnly(ctx, types) {
  return types.indexOf(ctx.actor.type) === -1 ? txFail('Not authorized') : null;
}

function txV1Only(ctx) {
  return ctx.state.Flow !== 'v1'
    ? txFail('This order was placed before order rooms existed. Its payment and status are set on the seller\'s Orders page.')
    : null;
}

var TX_GOODS_LEFT = ['dispatched', 'delivered', 'handed_over'];

/**
 * Sets Orders.Status through the same stock-aware path the Orders page uses -
 * except that once the goods have physically left (stock already moved to
 * sold), confirming payment later or cancelling must not put units back on
 * the shelf that are not there. Those cases leave stock alone; a seller who
 * gets goods back adjusts stock on the Inventory page.
 */
function txSetOrderStatus(ctx, status) {
  if (String(ctx.order.Status) === status) return ok({});
  var left = TX_GOODS_LEFT.indexOf(String(ctx.state && ctx.state.FulfilmentState)) !== -1;
  if (!(left && (status === 'Paid' || status === 'Cancelled'))) {
    var owner = findRowById(getSheet('Owners'), 'OwnerId', ctx.order.OwnerId);
    var stock = applyOrderStatusStock(owner, ctx.order, status);
    if (!stock.ok) return stock;
  }
  updateRowFromObject(ctx.ordersSheet, ctx.order.__row, { Status: status, UpdatedAt: nowIso() });
  ctx.order.Status = status;
  return ok({});
}

/** The buyer's cached order list shows the room's stage - refresh it after any change. */
function txInvalidateBuyerLists(order) {
  try {
    var c = order && order.CustomerEmail ? findCustomerByEmail(order.CustomerEmail) : null;
    if (c) invalidateCustomerListCaches(c);
  } catch (e) { /* best effort */ }
}

/**
 * A problem reported instead of confirming receipt has been settled without
 * cancelling or completing the order: set that answer aside (it stays in the
 * records) so the buyer can now confirm receipt, which completes the order.
 * Returns the state fields to save.
 */
function txReopenReceiptAfterDispute(ctx, why) {
  if (['problem', 'partial', 'not_received'].indexOf(String(ctx.state.ReceiptState)) === -1) return {};
  if (txIsFinal(ctx.order) || String(ctx.order.Status) === 'Fulfilled') return {};
  var prior = latestTxRecord(txRecordsFor(ctx.order.OrderId), 'receipt');
  appendTxRecord(ctx.order.OrderId, { type: 'receipt_reopened', actorType: ctx.actor.type, actorId: ctx.actor.id, result: 'cleared', reason: why,
    supersedesId: prior ? prior.RecordId : '', requestId: ctx.requestId });
  appendTxEvent(ctx.state, { kind: 'system', actorType: 'system', audience: 'buyer',
    body: 'The problem is settled. When you have everything you expected, please confirm receipt - or report a new problem if something is still wrong.' });
  return { ReceiptState: '' };
}

/** Clears the hold an open problem put on, but never one an admin placed by hand. */
function txReleaseAutoHold(state) {
  var auto = ['Open problem report', 'Reopened problem report'];
  return auto.indexOf(String(state.HoldReason || '')) !== -1 || !state.HoldReason ? { Hold: '', HoldReason: '' } : {};
}

/** Goods have physically left: move reserved stock to sold now, keeping Status. */
function txMarkStockSold(ctx) {
  var owner = findRowById(getSheet('Owners'), 'OwnerId', ctx.order.OwnerId);
  return applyOrderStatusStock(owner, ctx.order, 'Fulfilled');
}

/**
 * Completion: the buyer confirmed receipt, the seller confirmed payment, and
 * no problem is open. Nothing else completes an order (except an admin
 * exception with a reason) - a buyer who stays silent never "confirms".
 */
function txMaybeComplete(ctx, actor) {
  var s = ctx.state;
  if (s.Flow !== 'v1' || String(ctx.order.Status) === 'Fulfilled' || txIsFinal(ctx.order)) return false;
  if (s.ReceiptState !== 'confirmed' || s.PaymentState !== 'verified' || txOpenDispute(s)) return false;
  var r = txSetOrderStatus(ctx, 'Fulfilled');
  if (!r.ok) return false;
  appendTxEvent(s, { kind: 'status', actorType: 'system', body: 'Order completed: payment confirmed by the seller and receipt confirmed by the buyer.' });
  txAudit(actor, 'TX_ORDER_COMPLETED', ctx.order.OrderId, 'Paid', 'Fulfilled');
  return true;
}

/* ==================== Room read ==================== */

function txActorLabel(viewer, actorType) {
  if (actorType === 'system') return 'Mwakete';
  if (actorType === 'admin') return 'Mwakete review';
  if (actorType === 'driver') return 'Driver';
  if (actorType === viewer) return 'You';
  return actorType === 'buyer' ? 'Buyer' : 'Seller';
}

function txEventVisible(ev, viewerType) {
  var a = String(ev.Audience || '');
  if (!a) return true;
  if (viewerType === 'admin') return true;
  return a === viewerType;
}

function publicTxEvidence(e) {
  return {
    id: e.EvidenceId, category: e.Category, categoryLabel: TX_EVIDENCE_CATEGORIES[e.Category] || 'File', mimeType: e.MimeType,
    name: e.DisplayName, size: Number(e.SizeBytes) || 0, hasThumb: !!e.ThumbFileId, removed: !!e.DeletedAt,
    removedReason: e.DeletedAt ? (e.DeletedReason || 'Removed') : '', by: e.SubmitterType, description: e.Description || '',
    review: e.ReviewStatus || '', createdAt: e.CreatedAt
  };
}

/** Next steps for the viewer, decided here from the real state - the page only draws them. */
function txNextActions(actorType, order, state, dispute, records) {
  var out = [];
  var v1 = state.Flow === 'v1';
  var cancelled = txIsFinal(order);
  var done = String(order.Status) === 'Fulfilled';
  var f = String(state.FulfilmentState || '');
  var p = String(state.PaymentState || '');
  var collect = txIsCollection(order);
  if (!cancelled) out.push('message', 'upload');
  if (actorType === 'buyer' && !cancelled) {
    if (v1 && String(order.Status) === 'Pending Payment' && ['pending', 'submitted', 'rejected'].indexOf(p) !== -1) out.push('submitPayment');
    var canConfirm = v1 ? (['dispatched', 'delivered', 'handed_over'].indexOf(f) !== -1 || (collect && f === 'ready_collection'))
      : ['Paid', 'Fulfilled'].indexOf(String(order.Status)) !== -1;
    if (canConfirm && !state.ReceiptState) out.push('confirmReceipt');
    if (state.RefundState === 'sent') out.push('confirmRefund');
  }
  if (actorType === 'seller' && !cancelled && v1) {
    if (['pending', 'submitted', 'rejected'].indexOf(p) !== -1) out.push('verifyPayment');
    if (['', 'preparing'].indexOf(f) !== -1) out.push('checklist');
    if (f === 'preparing') out.push('markReady');
    if (!collect && ['preparing', 'ready_dispatch'].indexOf(f) !== -1) out.push('dispatch');
    if (collect && ['preparing', 'ready_collection'].indexOf(f) !== -1) out.push('handover');
    if (!collect && f === 'dispatched') out.push('markDelivered');
    if (['', 'preparing', 'ready_dispatch', 'ready_collection'].indexOf(f) !== -1 && !dispute && !done) out.push('cancel');
  }
  if (actorType === 'seller' && state.RefundState === 'due') out.push('recordRefund');
  if ((actorType === 'buyer' || actorType === 'seller') && !dispute) out.push('openDispute');
  if ((actorType === 'buyer' || actorType === 'seller') && dispute) out.push('respondDispute');
  if (actorType === 'admin') {
    out.push('adminNote');
    if (dispute) out.push('adminDispute');
    out.push('adminException', 'adminHold');
    if (state.ReceiptState) out.push('adminCorrectReceipt');
    if (!done && !cancelled && !dispute) out.push('adminComplete');
    if (!cancelled && !done) out.push('cancel');
  }
  return out;
}

function txStageLabel(order, state, dispute) {
  if (dispute) return 'Problem reported - ' + (TX_DISPUTE_LABEL[dispute.Status] || 'open');
  if (txIsFinal(order)) return state.RefundState === 'due' ? 'Cancelled - refund due' : state.RefundState === 'sent' ? 'Cancelled - refund sent' : 'Cancelled';
  if (String(order.Status) === 'Fulfilled') return state.Flow === 'v1' ? 'Completed' : 'Fulfilled';
  if (state.Flow !== 'v1') return String(order.Status);
  var f = String(state.FulfilmentState || '');
  if (f) {
    if (state.ReceiptState === 'confirmed' && state.PaymentState !== 'verified') return 'Received - waiting for payment confirmation';
    return TX_FULFILMENT_LABEL[f];
  }
  return TX_PAYMENT_LABEL[state.PaymentState] || 'Order placed';
}

function txDisputeView(d, viewerType) {
  if (!d) return null;
  var history = parseTxJson(d.HistoryJson, []);
  return {
    id: d.DisputeId, category: d.Category, categoryLabel: (TX_DISPUTE_CATEGORIES[d.Category] || {}).label || d.Category,
    description: d.Description, status: d.Status, statusLabel: TX_DISPUTE_LABEL[d.Status] || d.Status, openedBy: d.OpenedByType,
    outcome: d.Outcome, outcomeLabel: TX_DISPUTE_OUTCOMES[d.Outcome] || '', rationale: d.Rationale, orderEffect: d.OrderEffect,
    decidedAt: d.DecidedAt, version: Number(d.Version) || 1, createdAt: d.CreatedAt,
    history: viewerType === 'admin' ? history : history.map(function (h) { return { at: h.at, by: h.by, action: h.action, to: h.to, note: h.note }; })
  };
}

/** body: orderId, side, token, sinceSeq | beforeSeq, limit. */
function actionGetTxRoom(body) {
  var ctx = loadTxContext(body, { noCreate: true });
  if (ctx.error) return txFail(ctx.error, ctx.auth ? { authRequired: true } : null);
  if (!ctx.state) {
    // First visit to an older order: create its room under the lock.
    var lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try { ctx.state = initTxState(ctx.order, 'legacy'); } finally { lock.releaseLock(); }
  }
  // The page polls with sinceSeq + version: when nothing has happened, answer
  // in a few bytes instead of rebuilding the whole room (low-bandwidth phones).
  if (body.sinceSeq !== undefined && body.sinceSeq !== null && body.sinceSeq !== '' && body.version !== undefined &&
      Number(ctx.state.LastSeq) <= Number(body.sinceSeq) && Number(body.version) === Number(ctx.state.Version)) {
    return ok({ unchanged: true, lastSeq: Number(ctx.state.LastSeq) || 0, version: Number(ctx.state.Version) || 1 });
  }
  var viewer = ctx.actor.type;
  var order = ctx.order, state = ctx.state;
  var allEvents = getCached(txEventsCacheKey(order.OrderId), 15, function () {
    return txRows('TxEvents').filter(function (e) { return e.OrderId === order.OrderId; })
      .map(function (e) { var c = Object.assign({}, e); delete c.__row; return c; });
  }) || [];
  var events = allEvents.filter(function (e) { return txEventVisible(e, viewer); })
    .sort(function (a, b) { return Number(a.Seq) - Number(b.Seq); });
  var limit = Math.max(5, Math.min(100, Number(body.limit) || 40));
  var hasMoreBefore = false;
  if (body.sinceSeq !== undefined && body.sinceSeq !== null && body.sinceSeq !== '') {
    events = events.filter(function (e) { return Number(e.Seq) > Number(body.sinceSeq); });
  } else {
    if (body.beforeSeq) events = events.filter(function (e) { return Number(e.Seq) < Number(body.beforeSeq); });
    hasMoreBefore = events.length > limit;
    events = events.slice(-limit);
  }
  var evidenceIds = {};
  events.forEach(function (e) { String(e.EvidenceIds || '').split(',').filter(Boolean).forEach(function (id) { evidenceIds[id] = true; }); });
  var evidence = {};
  txRows('TxEvidence').forEach(function (e) { if (evidenceIds[e.EvidenceId] && e.OrderId === order.OrderId) evidence[e.EvidenceId] = publicTxEvidence(e); });

  var records = txRecordsFor(order.OrderId);
  var dispute = txOpenDispute(state);
  var lastDispute = dispute || txRows('TxDisputes').filter(function (d) { return d.OrderId === order.OrderId; }).slice(-1)[0] || null;
  var store = getOwnerBySlug(order.StoreSlug);
  var paymentRec = latestTxRecord(records, 'payment_submission');
  var checklist = latestTxRecord(records, 'checklist');
  var dispatch = latestTxRecord(records, 'dispatch');
  var handover = latestTxRecord(records, 'handover');
  var ready = latestTxRecord(records, 'ready');

  var view = {
    orderId: order.OrderId, storeName: store ? store.StoreName : order.StoreSlug, storeSlug: order.StoreSlug,
    createdAt: order.CreatedAt, status: order.Status, stage: txStageLabel(order, state, dispute), flow: state.Flow,
    items: txOrderItems(order).map(function (l) { return { label: l.label, qty: l.qty, unitPrice: l.unitPrice, lineTotal: l.lineTotal, options: l.options || null }; }),
    subtotal: order.Subtotal, total: order.Total, deliveryMethod: order.DeliveryMethod,
    deliveryLabel: DELIVERY_METHOD_LABEL[order.DeliveryMethod] || order.DeliveryMethod, collection: txIsCollection(order),
    deliveryCost: order.DeliveryCost, deliveryNegotiated: order.DeliveryMethod !== 'pickPay' && (order.DeliveryCost === '' || order.DeliveryCost == null),
    payment: { state: state.PaymentState, label: TX_PAYMENT_LABEL[state.PaymentState] || '' },
    fulfilment: { state: state.FulfilmentState, label: TX_FULFILMENT_LABEL[state.FulfilmentState || ''] },
    receipt: { state: state.ReceiptState, label: TX_RECEIPT_LABEL[state.ReceiptState || ''] || state.ReceiptState },
    refund: state.RefundState || '', hold: viewer === 'admin' ? { on: state.Hold === 'yes', reason: state.HoldReason } : undefined,
    version: Number(state.Version) || 1, lastSeq: Number(state.LastSeq) || 0,
    checklistDone: !!checklist, readyInfo: ready ? parseTxJson(ready.DataJson, {}) : null,
    dispatchInfo: dispatch ? parseTxJson(dispatch.DataJson, {}) : null, handoverInfo: handover ? parseTxJson(handover.DataJson, {}) : null
  };
  if (viewer !== 'buyer') {
    view.buyer = { name: order.CustomerName, phone: order.CustomerPhone, address: order.DeliveryAddress, notes: order.Notes };
    view.paymentFlags = paymentRec ? parseTxJson(paymentRec.FlagsJson, []) : [];
    view.paymentSubmission = paymentRec ? Object.assign({ at: paymentRec.CreatedAt }, parseTxJson(paymentRec.DataJson, {})) : null;
  } else {
    view.paymentSubmission = paymentRec ? Object.assign({ at: paymentRec.CreatedAt }, parseTxJson(paymentRec.DataJson, {})) : null;
  }
  var cfg = txConfig();
  var exceptions = txExceptionsFor(records);
  view.policy = {
    checklist: txRequirements({ action: 'checklist', order: order, categories: txOrderCategories(order), evidence: [{ MimeType: 'image/jpeg' }], cfg: cfg })
      .map(function (r) { return { key: r.key, level: r.level, message: r.message, waived: !!exceptions[r.key] }; }),
    dispatch: txRequirements({ action: 'dispatch', order: order, evidence: [{ MimeType: 'image/jpeg' }], cfg: cfg })
      .map(function (r) { return { key: r.key, level: r.level, message: r.message, waived: !!exceptions[r.key] }; }),
    handover: txRequirements({ action: 'handover', order: order, evidence: [{ MimeType: 'image/jpeg' }], cfg: cfg })
      .map(function (r) { return { key: r.key, level: r.level, message: r.message, waived: !!exceptions[r.key] }; }),
    disputePhotoCategories: String(cfg['dispute.photoCategories']).split(','),
    maxFileMB: cfg['limits.maxFileMB'], pdf: cfg['types.pdf'] === 'on', paymentNeedsProof: cfg['payment.receiptOrReference'] === 'required'
  };
  view.dispute = txDisputeView(lastDispute, viewer);
  view.disputeCategories = Object.keys(TX_DISPUTE_CATEGORIES)
    .filter(function (k) { return viewer === 'admin' || TX_DISPUTE_CATEGORIES[k].who.indexOf(viewer) !== -1; })
    .map(function (k) { return { id: k, label: TX_DISPUTE_CATEGORIES[k].label }; });
  view.outcomes = viewer === 'admin' ? Object.keys(TX_DISPUTE_OUTCOMES).map(function (k) { return { id: k, label: TX_DISPUTE_OUTCOMES[k] }; }) : undefined;
  view.exceptionKeys = viewer === 'admin' ? String(cfg['exceptions.allowed']).split(',').filter(Boolean) : undefined;
  view.isParty = txIsParty(ctx.actor, order);
  view.actions = txNextActions(viewer, order, state, dispute, records);
  // Mwakete drivers (Deliveries.gs): the delivery panel and its steps.
  view.delivery = typeof deliveryRoomView === 'function' ? deliveryRoomView(order, state, viewer) : null;
  if (view.delivery) {
    if (view.delivery.canRequest) view.actions.push('requestDriver');
    if (view.delivery.canCancel) view.actions.push('cancelDriverJob');
    if (view.delivery.canMarkPaid) view.actions.push('markDriverPaid');
    if (view.delivery.status && DELIVERY_JOB_ACTIVE.indexOf(view.delivery.status) !== -1) {
      // While a driver is booked, the driver records pickup and delivery.
      view.actions = view.actions.filter(function (a) { return a !== 'dispatch' && a !== 'markDelivered'; });
    }
  }
  if (viewer === 'admin' && view.dispute && view.dispute.status === 'resolved') view.actions.push('adminReopen');
  if (viewer === 'admin' && view.isParty) {
    view.actions = view.actions.filter(function (a) { return ['adminDispute', 'adminException', 'adminCorrectReceipt', 'adminComplete', 'cancel', 'adminReopen'].indexOf(a) === -1; });
  }

  var unreadSeq = viewer === 'buyer' ? Number(state.ReadBuyerSeq) || 0 : Number(state.ReadSellerSeq) || 0;
  if (viewer !== 'admin' && Number(state.LastSeq) > unreadSeq) {
    var markLock = LockService.getScriptLock();
    markLock.waitLock(30000);
    try {
      var fresh = findRowById(txSheet('TxState'), 'OrderId', order.OrderId);
      updateRowFromObject(txSheet('TxState'), fresh.__row, viewer === 'buyer' ? { ReadBuyerSeq: fresh.LastSeq } : { ReadSellerSeq: fresh.LastSeq });
    } finally {
      markLock.releaseLock();
    }
  }
  if (viewer === 'admin') {
    // Once an hour per admin and order - the page polls, the log should not.
    var seenKey = 'v1:tx:adminview:' + ctx.actor.id + ':' + order.OrderId;
    var c = CacheService.getScriptCache();
    if (!c.get(seenKey)) { c.put(seenKey, '1', 3600); txAudit(ctx.actor, 'TX_ROOM_VIEWED_BY_ADMIN', order.OrderId); }
  }

  return ok({
    viewer: viewer, room: view,
    events: events.map(function (e) {
      var data = parseTxJson(e.DataJson, null);
      return {
        id: e.EventId, seq: Number(e.Seq), kind: e.Kind, by: e.ActorType, byLabel: txActorLabel(viewer, e.ActorType),
        body: e.Body, data: data, evidence: String(e.EvidenceIds || '').split(',').filter(Boolean).map(function (id) { return evidence[id]; }).filter(Boolean),
        audience: e.Audience || '', at: e.CreatedAt
      };
    }),
    hasMoreBefore: hasMoreBefore
  });
}

/* ==================== Messages and files ==================== */

function txRateLimited(actor, kind, max, windowSeconds) {
  return rateLimitHit('ratelimit:tx:' + kind + ':' + actor.type + ':' + actor.id, max, windowSeconds);
}

/** body: text, requestId. */
function actionSendTxMessage(body) {
  var text = txCleanText(body && body.text, 2000);
  if (!text) return fail('Write a message first.');
  return runTxWrite(body, 'message', function (ctx) {
    if (ctx.actor.type === 'admin' && txIsParty(ctx.actor, ctx.order)) return txFail('Use your seller or buyer view to message in your own order.');
    if (txRateLimited(ctx.actor, 'msg', 20, 60)) return txFail('You are sending messages too fast - please wait a moment.', { rateLimited: true });
    var ev = appendTxEvent(ctx.state, { kind: 'message', actorType: ctx.actor.type, actorId: ctx.actor.id, body: text, requestId: ctx.requestId });
    var others = ctx.actor.type === 'buyer' ? ['seller'] : ctx.actor.type === 'seller' ? ['buyer'] : ['buyer', 'seller'];
    others.forEach(function (to) {
      queueTxNotify(ctx.queue, ctx.order, to, 'message', '', ctx.actor.type === 'admin' ? 'Mwakete review sent a message' : 'New message about your order',
        (ctx.actor.type === 'buyer' ? 'The buyer' : ctx.actor.type === 'seller' ? 'The seller' : 'Mwakete review') + ' sent a message about this order.');
    });
    return ok({ eventId: ev.EventId, seq: ev.Seq });
  });
}

/**
 * body: dataBase64, mimeType, name, category, description, thumbBase64?, requestId.
 * Saves the file privately, records it, and adds it to the timeline. A retry
 * with the same requestId, or the same file again on this order, returns the
 * first record - never a duplicate.
 */
function actionUploadTxEvidence(body) {
  // Session first: an anonymous request never gets as far as decoding a file.
  var who = resolveTxActor(body);
  if (who.error) return txFail(who.error, who.auth ? { authRequired: true } : null);
  var cfg = txConfig();
  var category = String((body && body.category) || 'other');
  if (!TX_EVIDENCE_CATEGORIES[category]) return fail('Choose what the file shows.');
  var checked = validateTxFile(body && body.dataBase64, body && body.mimeType, cfg);
  if (checked.error) return fail(checked.error);
  var thumb = null;
  if (body.thumbBase64 && checked.sniff.type !== 'application/pdf') {
    var t = validateTxFile(body.thumbBase64, '', cfg);
    if (!t.error && t.bytes.length <= 300 * 1024 && t.sniff.type !== 'application/pdf' && t.sniff.width <= 800 && t.sniff.height <= 800) thumb = t;
  }
  var description = txCleanText(body.description, 300);
  return runTxWrite(body, 'upload', function (ctx) {
    if (ctx.actor.type === 'admin' && txIsParty(ctx.actor, ctx.order)) return txFail('Use your seller or buyer view to add files to your own order.');
    if (txIsFinal(ctx.order) && ctx.actor.type !== 'admin') {
      var d0 = txOpenDispute(ctx.state);
      if (!d0 && ctx.state.RefundState !== 'due' && ctx.state.RefundState !== 'sent') return txFail('This order is cancelled.');
    }
    var all = txRows('TxEvidence').filter(function (e) { return e.OrderId === ctx.order.OrderId; });
    var dup = all.filter(function (e) { return e.Sha256 === checked.sha && !e.DeletedAt && e.SubmitterId === ctx.actor.id; })[0];
    if (dup) return ok({ evidence: publicTxEvidence(dup), duplicate: true });
    if (all.filter(function (e) { return !e.DeletedAt; }).length >= Number(cfg['limits.maxFilesPerOrder'])) {
      return txFail('This order already has the most files allowed. Ask Mwakete if you need to add more.');
    }
    if (txRateLimited(ctx.actor, 'upload', 20, 600)) return txFail('Too many files in a short time - please wait a few minutes.', { rateLimited: true });

    var evidenceId = newId('txf');
    var folder = getTxEvidenceFolder();
    var file = folder.createFile(Utilities.newBlob(checked.bytes, checked.sniff.type, evidenceId + txExtension(checked.sniff.type)));
    var thumbFile = thumb ? folder.createFile(Utilities.newBlob(thumb.bytes, thumb.sniff.type, evidenceId + '_thumb' + txExtension(thumb.sniff.type))) : null;
    var stage = String(ctx.state.FulfilmentState || '') || (ctx.state.PaymentState || '');
    var row = {
      EvidenceId: evidenceId, OrderId: ctx.order.OrderId, EventId: '', SubmitterType: ctx.actor.type, SubmitterId: ctx.actor.id,
      Category: category, Stage: stage, FileId: file.getId(), ThumbFileId: thumbFile ? thumbFile.getId() : '',
      DisplayName: txSafeDisplayName(body.name, checked.sniff.type), MimeType: checked.sniff.type, SizeBytes: checked.bytes.length,
      Width: checked.sniff.width || '', Height: checked.sniff.height || '', Sha256: checked.sha, Description: description,
      ReviewStatus: category === 'payment' ? 'submitted' : '', ReviewedBy: '', ReviewedAt: '', ReviewNote: '', Retention: 'kept',
      DeletedAt: '', DeletedReason: '', RequestId: ctx.requestId, CreatedAt: nowIso()
    };
    var ev = appendTxEvent(ctx.state, {
      kind: 'evidence', actorType: ctx.actor.type, actorId: ctx.actor.id, body: description, evidenceIds: [evidenceId],
      data: { category: category }, requestId: ctx.requestId
    });
    row.EventId = ev.EventId;
    appendRowFromObject(txSheet('TxEvidence'), row);
    txAudit(ctx.actor, 'TX_EVIDENCE_ADDED', ctx.order.OrderId, '', { evidenceId: evidenceId, category: category, type: row.MimeType, bytes: row.SizeBytes }, '', ctx.requestId);
    return ok({ evidence: publicTxEvidence(row), seq: ev.Seq });
  });
}

/** body: evidenceId, variant 'thumb'|'full'. Returns the file only after the order access check. */
function actionGetTxEvidence(body) {
  var who = resolveTxActor(body);
  if (who.error) return txFail(who.error, who.auth ? { authRequired: true } : null);
  var id = String((body && body.evidenceId) || '');
  var e = txRows('TxEvidence').filter(function (x) { return x.EvidenceId === id; })[0];
  var order = e ? findRowById(getSheet('Orders'), 'OrderId', e.OrderId) : null;
  if (!e || !order || !txCanAccess(who.actor, order) || !txEnabledForStore(order.StoreSlug)) {
    if (e && order) appendAudit({ actorId: who.actor.id, actorRole: who.actor.type, action: 'TX_EVIDENCE_ACCESS_DENIED', entityType: 'evidence', entityId: id });
    return fail('File not found');
  }
  if (e.DeletedAt) return fail('This file has been removed (' + (e.DeletedReason || 'retention policy') + ').');
  var wantThumb = String(body.variant) === 'thumb' && e.ThumbFileId;
  var blob;
  try { blob = DriveApp.getFileById(wantThumb ? e.ThumbFileId : e.FileId).getBlob(); } catch (err) { return fail('This file could not be opened. Please try again later.'); }
  if (!wantThumb && (who.actor.type === 'admin' || String(body.variant) === 'full')) {
    appendAudit({ actorId: who.actor.id, actorRole: who.actor.type, action: 'TX_EVIDENCE_OPENED', entityType: 'evidence', entityId: id, next: e.OrderId });
  }
  return ok({ evidenceId: id, mimeType: blob.getContentType() || e.MimeType, name: e.DisplayName, dataBase64: Utilities.base64Encode(blob.getBytes()) });
}

/* ==================== Payment ==================== */

/** Buyer. body: method, reference, amount, note, evidenceIds. */
function actionTxSubmitPayment(body) {
  return runTxWrite(body, 'submitPayment', function (ctx) {
    var deny = txRoleOnly(ctx, ['buyer']) || txV1Only(ctx);
    if (deny) return deny;
    if (txIsFinal(ctx.order)) return txFail('This order is cancelled.');
    if (String(ctx.order.Status) !== 'Pending Payment' || ['pending', 'submitted', 'rejected'].indexOf(ctx.state.PaymentState) === -1) {
      return txFail('The seller has already confirmed payment for this order.');
    }
    var method = String(body.method || '');
    if (!TX_PAYMENT_METHODS[method]) return txFail('Choose how you paid.');
    var reference = txCleanText(body.reference, 60);
    if (/[<>]/.test(reference)) return txFail('The reference cannot contain < or >.');
    var note = txCleanText(body.note, 500);
    var amount = body.amount === '' || body.amount == null ? null : Number(body.amount);
    if (amount !== null && (!isFinite(amount) || amount <= 0 || amount > 1000000)) return txFail('Enter the amount you paid, or leave it blank.');
    var ev = txOwnEvidence(ctx, body.evidenceIds);
    if (ev.error) return txFail(ev.error);
    var reqs = txRequirements({ action: 'payment', order: ctx.order, reference: reference, evidence: ev.rows });
    var block = txBlockingRequirement(reqs, {});
    if (block) return txFail(block.message, { requirement: block.key });

    var flags = txPaymentFlags(ctx.order, reference, amount, ev.rows);
    var rec = appendTxRecord(ctx.order.OrderId, {
      type: 'payment_submission', actorType: 'buyer', actorId: ctx.actor.id, result: 'submitted',
      data: { method: method, methodLabel: TX_PAYMENT_METHODS[method], reference: reference, amount: amount === null ? '' : roundMoney(amount), note: note },
      evidenceIds: ev.rows.map(function (e) { return e.EvidenceId; }), flags: flags, requestId: ctx.requestId
    });
    var prev = ctx.state.PaymentState;
    saveTxState(ctx.state, { PaymentState: 'submitted' });
    appendTxEvent(ctx.state, {
      kind: 'payment', actorType: 'buyer', actorId: ctx.actor.id, evidenceIds: ev.rows.map(function (e) { return e.EvidenceId; }),
      body: 'Payment details sent: ' + TX_PAYMENT_METHODS[method] + (reference ? ', reference ' + reference : '') +
        (amount !== null ? ', ' + orderMoney(amount) : '') + (note ? '. ' + note : '') + '. Not yet confirmed - the seller will check their account.',
      data: { recordId: rec.RecordId }
    });
    appendTxEvent(ctx.state, { kind: 'system', actorType: 'system', audience: 'seller', body: txConfig()['prompt.verify'] +
      (flags.length ? ' Please check carefully: ' + flags.map(txFlagText).join(' ') : '') });
    txAudit(ctx.actor, 'TX_PAYMENT_SUBMITTED', ctx.order.OrderId, prev, 'submitted', flags.join(','), ctx.requestId);
    queueTxNotify(ctx.queue, ctx.order, 'seller', 'payment_submitted', rec.RecordId, 'Payment details sent by the buyer',
      'The buyer says they have paid. Please check your own bank, wallet or cash, then confirm or decline in the order room.');
    return ok({ recordId: rec.RecordId, flags: flags.length });
  });
}

/**
 * Differences worth a careful look - never an accusation, and shown only to
 * the seller and Mwakete.
 */
function txPaymentFlags(order, reference, amount, evidenceRows) {
  var flags = [];
  var negotiated = order.DeliveryMethod !== 'pickPay' && (order.DeliveryCost === '' || order.DeliveryCost == null);
  if (amount !== null && amount !== undefined && !negotiated && Math.abs(roundMoney(amount) - txOrderTotal(order)) >= 0.01) flags.push('amount_differs');
  if (amount !== null && amount !== undefined && negotiated && roundMoney(amount) < txOrderTotal(order)) flags.push('amount_below_items');
  var hashes = evidenceRows.map(function (e) { return e.Sha256; });
  if (hashes.length && txRows('TxEvidence').some(function (e) { return e.OrderId !== order.OrderId && e.Category === 'payment' && hashes.indexOf(e.Sha256) !== -1; })) {
    flags.push('receipt_used_on_other_order');
  }
  if (reference && txRows('TxRecords').some(function (r) {
    if (r.OrderId === order.OrderId || r.Type !== 'payment_submission') return false;
    var d = parseTxJson(r.DataJson, {});
    return String(d.reference || '').toLowerCase() === reference.toLowerCase();
  })) flags.push('reference_used_on_other_order');
  return flags;
}

function txFlagText(f) {
  return {
    amount_differs: 'the amount the buyer entered is different from the order total.',
    amount_below_items: 'the amount the buyer entered is less than the items\' total.',
    receipt_used_on_other_order: 'the same receipt image was also sent for another order.',
    reference_used_on_other_order: 'the same reference was also given for another order.'
  }[f] || f;
}

/**
 * Seller only - the one person who can see their own account. body: result
 * 'verified'|'rejected'|'more_info', checkedSource (must be true to verify),
 * method, reference, amountReceived, reason, acceptDifference.
 */
function actionTxVerifyPayment(body) {
  return runTxWrite(body, 'verifyPayment', function (ctx) {
    var deny = txRoleOnly(ctx, ['seller']) || txV1Only(ctx);
    if (deny) return deny;
    if (txIsFinal(ctx.order)) return txFail('This order is cancelled.');
    if (['pending', 'submitted', 'rejected'].indexOf(ctx.state.PaymentState) === -1) return txFail('Payment is already confirmed for this order.');
    var result = String(body.result || '');
    if (['verified', 'rejected', 'more_info'].indexOf(result) === -1) return txFail('Choose whether the money arrived.');
    var reason = txCleanText(body.reason, 500);
    var prev = ctx.state.PaymentState;
    if (result !== 'verified') {
      if (reason.length < 10) return txFail('Tell the buyer what you found (at least 10 characters).');
      appendTxRecord(ctx.order.OrderId, { type: 'payment_verification', actorType: 'seller', actorId: ctx.actor.id, result: result, reason: reason, requestId: ctx.requestId });
      saveTxState(ctx.state, { PaymentState: result === 'rejected' ? 'rejected' : 'pending' });
      appendTxEvent(ctx.state, { kind: 'payment', actorType: 'seller', actorId: ctx.actor.id,
        body: (result === 'rejected' ? 'Seller could not find this payment: ' : 'Seller needs more information about the payment: ') + reason });
      txAudit(ctx.actor, 'TX_PAYMENT_' + result.toUpperCase(), ctx.order.OrderId, prev, ctx.state.PaymentState, reason, ctx.requestId);
      queueTxNotify(ctx.queue, ctx.order, 'buyer', 'payment_' + result, '', 'Your seller checked your payment',
        result === 'rejected' ? 'The seller could not find your payment in their account. Please open the order room to see why.' : 'The seller needs more information about your payment.');
      return ok({ paymentState: ctx.state.PaymentState });
    }
    if (body.checkedSource !== true) {
      return txFail('Only confirm after checking your own bank, wallet or the cash in your hand. A screenshot is not enough.', { requirement: 'payment.source' });
    }
    var method = String(body.method || '');
    if (!TX_PAYMENT_METHODS[method]) return txFail('Choose how the money arrived.');
    var reference = txCleanText(body.reference, 60);
    if (method !== 'cash' && !reference) return txFail('Enter the reference you see in your own account.');
    var amount = Number(body.amountReceived);
    if (!isFinite(amount) || amount <= 0) return txFail('Enter the amount that arrived.');
    var flags = [];
    var negotiated = ctx.order.DeliveryMethod !== 'pickPay' && (ctx.order.DeliveryCost === '' || ctx.order.DeliveryCost == null);
    if (!negotiated && Math.abs(roundMoney(amount) - txOrderTotal(ctx.order)) >= 0.01) {
      if (body.acceptDifference !== true || reason.length < 5) {
        return txFail('The amount is different from the order total (' + orderMoney(ctx.order.Total) + '). Tick "accept the difference" and say why, or decline.', { requirement: 'payment.amount' });
      }
      flags.push('amount_differs_accepted');
    }
    return txRecordVerification(ctx, { method: method, reference: reference, amount: amount, reason: reason, flags: flags, via: 'room' });
  });
}

function txRecordVerification(ctx, v) {
  var prev = ctx.state.PaymentState;
  var rec = appendTxRecord(ctx.order.OrderId, {
    type: 'payment_verification', actorType: 'seller', actorId: ctx.actor.id, result: 'verified', reason: v.reason,
    data: { method: v.method, methodLabel: TX_PAYMENT_METHODS[v.method], reference: v.reference, amountReceived: roundMoney(v.amount),
      checkedOwnAccount: true, via: v.via, at: nowIso() }, flags: v.flags, requestId: ctx.requestId
  });
  var st = txSetOrderStatus(ctx, 'Paid');
  if (!st.ok) return st;
  saveTxState(ctx.state, { PaymentState: 'verified' });
  txRows('TxEvidence').forEach(function (e) {
    if (e.OrderId === ctx.order.OrderId && e.Category === 'payment' && e.ReviewStatus === 'submitted') {
      updateRowFromObject(txSheet('TxEvidence'), e.__row, { ReviewStatus: 'accepted', ReviewedBy: ctx.actor.id, ReviewedAt: nowIso() });
    }
  });
  appendTxEvent(ctx.state, { kind: 'payment', actorType: 'seller', actorId: ctx.actor.id,
    body: 'Payment confirmed by the seller after checking their own account: ' + orderMoney(v.amount) + ' by ' + TX_PAYMENT_METHODS[v.method] +
      (v.reference ? ' (reference ' + v.reference + ')' : '') + '.', data: { recordId: rec.RecordId } });
  if (!ctx.state.FulfilmentState) appendTxEvent(ctx.state, { kind: 'system', actorType: 'system', audience: 'seller', body: txConfig()['prompt.predispatch'] });
  txAudit(ctx.actor, 'TX_PAYMENT_VERIFIED', ctx.order.OrderId, prev, 'verified', v.flags.join(','), ctx.requestId);
  queueTxNotify(ctx.queue, ctx.order, 'buyer', 'payment_verified', rec.RecordId, 'Your payment was confirmed', 'The seller confirmed your payment arrived.');
  txMaybeComplete(ctx, ctx.actor);
  return ok({ paymentState: 'verified', recordId: rec.RecordId });
}

/* ==================== Goods, dispatch, collection ==================== */

function txDateError(s, order) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s || ''))) return 'Enter the date (YYYY-MM-DD).';
  var t = new Date(s + 'T00:00:00Z').getTime();
  if (isNaN(t)) return 'Enter a real date.';
  if (t > Date.now() + 2 * 86400000) return 'That date is in the future.';
  var placed = new Date(order.CreatedAt).getTime();
  if (!isNaN(placed) && t < placed - 2 * 86400000) return 'That date is before the order was placed.';
  return '';
}

/**
 * Seller. body.checklist: { lines: [{ index, ok }], accessories, defects,
 * packaging, substitutions }, evidenceIds. Every line must be ticked, or a
 * substitution described. Can be recorded again (superseding) until sent.
 */
function actionTxChecklist(body) {
  return runTxWrite(body, 'checklist', function (ctx) {
    var deny = txRoleOnly(ctx, ['seller']) || txV1Only(ctx);
    if (deny) return deny;
    if (txIsFinal(ctx.order)) return txFail('This order is cancelled.');
    if (['', 'preparing'].indexOf(String(ctx.state.FulfilmentState || '')) === -1 && String(ctx.state.FulfilmentState) !== 'ready_dispatch' && String(ctx.state.FulfilmentState) !== 'ready_collection') {
      return txFail('The goods have already left - the checklist can no longer change.');
    }
    var c = (body && body.checklist) || {};
    var items = txOrderItems(ctx.order);
    var ticked = {};
    (Array.isArray(c.lines) ? c.lines : []).forEach(function (l) { if (l && l.ok === true) ticked[Number(l.index)] = true; });
    var substitutions = txCleanText(c.substitutions, 500);
    var unticked = items.filter(function (_, i) { return !ticked[i]; });
    if (unticked.length && substitutions.length < 5) {
      return txFail('Tick each item once you have checked it against the order, or describe the change you agreed with the buyer.', { requirement: 'checklist.lines' });
    }
    var defects = txCleanText(c.defects, 500);
    var ev = txOwnEvidence(ctx, body.evidenceIds);
    if (ev.error) return txFail(ev.error);
    var records = txRecordsFor(ctx.order.OrderId);
    var reqs = txRequirements({ action: 'checklist', order: ctx.order, categories: txOrderCategories(ctx.order), evidence: ev.rows, defects: defects });
    var block = txBlockingRequirement(reqs, txExceptionsFor(records));
    if (block) return txFail(block.message, { requirement: block.key });
    var prior = latestTxRecord(records, 'checklist');
    var data = { lines: items.map(function (l, i) { return { label: l.label, qty: l.qty, ok: !!ticked[i] }; }),
      accessories: txCleanText(c.accessories, 300), defects: defects, packaging: txCleanText(c.packaging, 300), substitutions: substitutions };
    var rec = appendTxRecord(ctx.order.OrderId, { type: 'checklist', actorType: 'seller', actorId: ctx.actor.id, result: 'recorded', data: data,
      evidenceIds: ev.rows.map(function (e) { return e.EvidenceId; }), supersedesId: prior ? prior.RecordId : '', requestId: ctx.requestId });
    if (!ctx.state.FulfilmentState) saveTxState(ctx.state, { FulfilmentState: 'preparing' });
    else saveTxState(ctx.state, {});
    var missingRecommended = reqs.filter(function (r) { return r.level === 'recommended' && !r.met; });
    appendTxEvent(ctx.state, { kind: 'fulfilment', actorType: 'seller', actorId: ctx.actor.id, evidenceIds: ev.rows.map(function (e) { return e.EvidenceId; }),
      body: (prior ? 'Goods check updated: ' : 'Goods checked against the order: ') +
        data.lines.map(function (l) { return (l.ok ? '✓ ' : '✗ ') + l.qty + ' × ' + l.label; }).join('; ') +
        (defects ? '. Defects noted: ' + defects : '. No defects noted') + (substitutions ? '. Change agreed: ' + substitutions : '') +
        (data.accessories ? '. Included: ' + data.accessories : '') + (data.packaging ? '. Packaging: ' + data.packaging : '') + '.',
      data: { recordId: rec.RecordId } });
    txAudit(ctx.actor, 'TX_CHECKLIST_RECORDED', ctx.order.OrderId, prior ? prior.RecordId : '', rec.RecordId, '', ctx.requestId);
    return ok({ recordId: rec.RecordId, recommendedMissing: missingRecommended.map(function (r) { return r.message; }) });
  });
}

/** Seller. body.collection { instructions, when } for a collection order. */
function actionTxMarkReady(body) {
  return runTxWrite(body, 'markReady', function (ctx) {
    var deny = txRoleOnly(ctx, ['seller']) || txV1Only(ctx);
    if (deny) return deny;
    if (txIsFinal(ctx.order)) return txFail('This order is cancelled.');
    if (String(ctx.state.FulfilmentState) !== 'preparing') return txFail('Check the goods against the order first.', { requirement: 'checklist' });
    var collect = txIsCollection(ctx.order);
    var data = {};
    if (collect) {
      var c = (body && body.collection) || {};
      data.instructions = txCleanText(c.instructions, 500);
      data.when = txCleanText(c.when, 120);
      if (data.instructions.length < 5) return txFail('Tell the buyer where and how to collect.');
    }
    var rec = appendTxRecord(ctx.order.OrderId, { type: 'ready', actorType: 'seller', actorId: ctx.actor.id, result: collect ? 'collection' : 'dispatch', data: data, requestId: ctx.requestId });
    saveTxState(ctx.state, { FulfilmentState: collect ? 'ready_collection' : 'ready_dispatch' });
    appendTxEvent(ctx.state, { kind: 'fulfilment', actorType: 'seller', actorId: ctx.actor.id,
      body: collect ? 'Ready for collection. ' + data.instructions + (data.when ? ' When: ' + data.when + '.' : '') : 'Packed and ready to send.', data: { recordId: rec.RecordId } });
    if (collect) {
      appendTxEvent(ctx.state, { kind: 'system', actorType: 'system', audience: 'buyer', body: txConfig()['prompt.collection'] });
      queueTxNotify(ctx.queue, ctx.order, 'buyer', 'ready', rec.RecordId, 'Your order is ready for collection', 'The seller says your order is ready to collect.');
    } else {
      appendTxEvent(ctx.state, { kind: 'system', actorType: 'system', audience: 'seller', body: txConfig()['prompt.dispatch'] });
    }
    txAudit(ctx.actor, 'TX_READY', ctx.order.OrderId, 'preparing', ctx.state.FulfilmentState, '', ctx.requestId);
    return ok({ fulfilmentState: ctx.state.FulfilmentState });
  });
}

/**
 * Seller, delivery orders. body.dispatch { date, method, provider, tracking,
 * notes }, evidenceIds, sendUnpaid (must be true when payment is not confirmed).
 */
function actionTxDispatch(body) {
  return runTxWrite(body, 'dispatch', function (ctx) {
    var deny = txRoleOnly(ctx, ['seller']) || txV1Only(ctx);
    if (deny) return deny;
    if (txIsFinal(ctx.order)) return txFail('This order is cancelled.');
    if (txIsCollection(ctx.order)) return txFail('This is a collection order - record the handover instead.');
    var f = String(ctx.state.FulfilmentState || '');
    if (f === '') return txFail('Check the goods against the order first.', { requirement: 'checklist' });
    if (['preparing', 'ready_dispatch'].indexOf(f) === -1) return txFail('This order has already been sent.');
    if (typeof activeDeliveryJob === 'function' && activeDeliveryJob(ctx.order.OrderId)) {
      return txFail('A Mwakete driver is booked for this order - the driver records the pickup. Cancel the driver job first to send it another way.');
    }
    var d = (body && body.dispatch) || {};
    var dateErr = txDateError(d.date, ctx.order);
    if (dateErr) return txFail(dateErr);
    var method = txCleanText(d.method, 60) || (DELIVERY_METHOD_LABEL[ctx.order.DeliveryMethod] || '');
    if (!method) return txFail('Say how the goods were sent.');
    if (ctx.state.PaymentState !== 'verified' && body.sendUnpaid !== true) {
      return txFail('Payment is not confirmed yet. Tick "send before payment is confirmed" if you agreed to this with the buyer (for example cash on delivery).', { requirement: 'payment.verified' });
    }
    var ev = txOwnEvidence(ctx, body.evidenceIds);
    if (ev.error) return txFail(ev.error);
    var records = txRecordsFor(ctx.order.OrderId);
    var reqs = txRequirements({ action: 'dispatch', order: ctx.order, evidence: ev.rows });
    var block = txBlockingRequirement(reqs, txExceptionsFor(records));
    if (block) return txFail(block.message, { requirement: block.key });
    var data = { date: d.date, method: method, provider: txCleanText(d.provider, 80), tracking: txCleanText(d.tracking, 80), notes: txCleanText(d.notes, 500),
      sentBeforePayment: ctx.state.PaymentState !== 'verified' };
    var stock = txMarkStockSold(ctx);
    if (!stock.ok) return stock;
    var rec = appendTxRecord(ctx.order.OrderId, { type: 'dispatch', actorType: 'seller', actorId: ctx.actor.id, result: 'dispatched', data: data,
      evidenceIds: ev.rows.map(function (e) { return e.EvidenceId; }), requestId: ctx.requestId });
    saveTxState(ctx.state, { FulfilmentState: 'dispatched' });
    appendTxEvent(ctx.state, { kind: 'fulfilment', actorType: 'seller', actorId: ctx.actor.id, evidenceIds: ev.rows.map(function (e) { return e.EvidenceId; }),
      body: 'Seller recorded sending on ' + data.date + ' by ' + method + (data.provider ? ' (' + data.provider + ')' : '') +
        (data.tracking ? ', tracking/reference ' + data.tracking : '') + (data.notes ? '. ' + data.notes : '') +
        '. This is the seller\'s record - it does not by itself confirm delivery.', data: { recordId: rec.RecordId } });
    appendTxEvent(ctx.state, { kind: 'system', actorType: 'system', audience: 'buyer', body: txConfig()['prompt.receipt'] });
    txAudit(ctx.actor, 'TX_DISPATCHED', ctx.order.OrderId, f, 'dispatched', data.sentBeforePayment ? 'sent before payment confirmed' : '', ctx.requestId);
    queueTxNotify(ctx.queue, ctx.order, 'buyer', 'dispatched', rec.RecordId, 'Your order is on its way', 'The seller recorded sending your order. Please confirm receipt when it arrives, or report a problem.');
    return ok({ fulfilmentState: 'dispatched', recordId: rec.RecordId });
  });
}

/** Seller, delivery orders: the seller's own report that it arrived (labelled as such). */
function actionTxMarkDelivered(body) {
  return runTxWrite(body, 'markDelivered', function (ctx) {
    var deny = txRoleOnly(ctx, ['seller']) || txV1Only(ctx);
    if (deny) return deny;
    if (String(ctx.state.FulfilmentState) !== 'dispatched') return txFail('Record sending first.');
    var note = txCleanText(body.note, 300);
    var rec = appendTxRecord(ctx.order.OrderId, { type: 'delivered', actorType: 'seller', actorId: ctx.actor.id, result: 'seller_reported', reason: note, requestId: ctx.requestId });
    saveTxState(ctx.state, { FulfilmentState: 'delivered' });
    appendTxEvent(ctx.state, { kind: 'fulfilment', actorType: 'seller', actorId: ctx.actor.id,
      body: 'Seller reports the order was delivered' + (note ? ': ' + note : '') + '. Waiting for the buyer to confirm.', data: { recordId: rec.RecordId } });
    txAudit(ctx.actor, 'TX_DELIVERY_REPORTED', ctx.order.OrderId, 'dispatched', 'delivered', '', ctx.requestId);
    queueTxNotify(ctx.queue, ctx.order, 'buyer', 'delivered', rec.RecordId, 'Has your order arrived?', 'The seller reports your order was delivered. Please confirm receipt, or report a problem.');
    return ok({ fulfilmentState: 'delivered' });
  });
}

/**
 * Seller, collection orders. body.handover { date, notes, cashReceived,
 * amount }, evidenceIds, handOverUnpaid.
 */
function actionTxHandover(body) {
  return runTxWrite(body, 'handover', function (ctx) {
    var deny = txRoleOnly(ctx, ['seller']) || txV1Only(ctx);
    if (deny) return deny;
    if (txIsFinal(ctx.order)) return txFail('This order is cancelled.');
    if (!txIsCollection(ctx.order)) return txFail('This is a delivery order - record sending instead.');
    var f = String(ctx.state.FulfilmentState || '');
    if (f === '') return txFail('Check the goods against the order first.', { requirement: 'checklist' });
    if (['preparing', 'ready_collection'].indexOf(f) === -1) return txFail('The handover is already recorded.');
    var h = (body && body.handover) || {};
    var dateErr = txDateError(h.date, ctx.order);
    if (dateErr) return txFail(dateErr);
    var cash = h.cashReceived === true;
    if (ctx.state.PaymentState !== 'verified' && !cash && body.handOverUnpaid !== true) {
      return txFail('Payment is not confirmed. Tick "I received the payment in cash" if you did, or "hand over before payment" if you agreed to that.', { requirement: 'payment.verified' });
    }
    var amount = Number(h.amount);
    if (cash && (!isFinite(amount) || amount <= 0)) return txFail('Enter the cash amount you received.');
    var ev = txOwnEvidence(ctx, body.evidenceIds);
    if (ev.error) return txFail(ev.error);
    var records = txRecordsFor(ctx.order.OrderId);
    var block = txBlockingRequirement(txRequirements({ action: 'handover', order: ctx.order, evidence: ev.rows }), txExceptionsFor(records));
    if (block) return txFail(block.message, { requirement: block.key });
    var stock = txMarkStockSold(ctx);
    if (!stock.ok) return stock;
    var data = { date: h.date, notes: txCleanText(h.notes, 500), cashReceived: cash, amount: cash ? roundMoney(amount) : '' };
    var rec = appendTxRecord(ctx.order.OrderId, { type: 'handover', actorType: 'seller', actorId: ctx.actor.id, result: 'handed_over', data: data,
      evidenceIds: ev.rows.map(function (e) { return e.EvidenceId; }), requestId: ctx.requestId });
    saveTxState(ctx.state, { FulfilmentState: 'handed_over' });
    appendTxEvent(ctx.state, { kind: 'fulfilment', actorType: 'seller', actorId: ctx.actor.id, evidenceIds: ev.rows.map(function (e) { return e.EvidenceId; }),
      body: 'Seller recorded the handover on ' + data.date + (data.notes ? ': ' + data.notes : '') + '. Waiting for the buyer to confirm receipt.', data: { recordId: rec.RecordId } });
    if (cash && ctx.state.PaymentState !== 'verified') {
      var flags = [];
      var negotiated = false;
      if (!negotiated && Math.abs(roundMoney(amount) - txOrderTotal(ctx.order)) >= 0.01) flags.push('amount_differs_accepted');
      var v = txRecordVerification(ctx, { method: 'cash', reference: '', amount: amount, reason: 'Cash received at handover', flags: flags, via: 'handover' });
      if (!v.ok) return v;
    }
    appendTxEvent(ctx.state, { kind: 'system', actorType: 'system', audience: 'buyer', body: txConfig()['prompt.receipt'] });
    txAudit(ctx.actor, 'TX_HANDED_OVER', ctx.order.OrderId, f, 'handed_over', '', ctx.requestId);
    queueTxNotify(ctx.queue, ctx.order, 'buyer', 'handed_over', rec.RecordId, 'Please confirm you collected your order', 'The seller recorded the handover. Please confirm receipt, or report a problem.');
    return ok({ fulfilmentState: 'handed_over' });
  });
}

/* ==================== Receipt ==================== */

/**
 * Buyer. body: choice ('ok'|'problem'|'partial'|'not_received'|'unable'),
 * note, category (for 'problem'), evidenceIds. Recorded once - a correction
 * goes through an admin, with a reason, and keeps the original.
 */
function actionTxConfirmReceipt(body) {
  return runTxWrite(body, 'confirmReceipt', function (ctx) {
    var deny = txRoleOnly(ctx, ['buyer']);
    if (deny) return deny;
    if (txIsFinal(ctx.order)) return txFail('This order is cancelled.');
    var choice = String(body.choice || '');
    if (TX_RECEIPT_CHOICES.indexOf(choice) === -1) return txFail('Choose what happened.');
    if (ctx.state.ReceiptState) return txFail('You have already answered for this order. If something is wrong, report a problem.');
    var f = String(ctx.state.FulfilmentState || '');
    var collect = txIsCollection(ctx.order);
    var allowed = ctx.state.Flow === 'v1'
      ? ['dispatched', 'delivered', 'handed_over'].indexOf(f) !== -1 || (collect && f === 'ready_collection')
      : ['Paid', 'Fulfilled'].indexOf(String(ctx.order.Status)) !== -1;
    if (!allowed) return txFail('The seller has not recorded sending or handing over this order yet. If it is late, report a problem.');
    var note = txCleanText(body.note, 1000);
    var ev = txOwnEvidence(ctx, body.evidenceIds);
    if (ev.error) return txFail(ev.error);
    if (choice === 'unable') {
      if (note.length < 5) return txFail('Tell the seller why you cannot confirm yet.');
      appendTxRecord(ctx.order.OrderId, { type: 'receipt', actorType: 'buyer', actorId: ctx.actor.id, result: 'unable', reason: note, requestId: ctx.requestId });
      appendTxEvent(ctx.state, { kind: 'receipt', actorType: 'buyer', actorId: ctx.actor.id, body: 'Buyer cannot confirm receipt yet: ' + note });
      queueTxNotify(ctx.queue, ctx.order, 'seller', 'receipt_unable', '', 'The buyer cannot confirm receipt yet', 'The buyer left a note about receiving the order.');
      return ok({ receiptState: '' });
    }
    if (choice === 'ok') {
      var rec = appendTxRecord(ctx.order.OrderId, { type: 'receipt', actorType: 'buyer', actorId: ctx.actor.id, result: 'confirmed', reason: note,
        evidenceIds: ev.rows.map(function (e) { return e.EvidenceId; }), requestId: ctx.requestId });
      var fields = { ReceiptState: 'confirmed' };
      if (collect && f === 'ready_collection') {
        var stock = txMarkStockSold(ctx);
        if (!stock.ok) return stock;
        fields.FulfilmentState = 'handed_over';
      }
      saveTxState(ctx.state, fields);
      appendTxEvent(ctx.state, { kind: 'receipt', actorType: 'buyer', actorId: ctx.actor.id, evidenceIds: ev.rows.map(function (e) { return e.EvidenceId; }),
        body: 'Buyer confirmed they received the order' + (note ? ': ' + note : '') + '. This records receipt only - a problem found later can still be reported.',
        data: { recordId: rec.RecordId } });
      txAudit(ctx.actor, 'TX_RECEIPT_CONFIRMED', ctx.order.OrderId, '', 'confirmed', '', ctx.requestId);
      queueTxNotify(ctx.queue, ctx.order, 'seller', 'receipt_ok', rec.RecordId, 'The buyer confirmed receipt', 'The buyer confirmed they received the order.');
      var completed = txMaybeComplete(ctx, ctx.actor);
      return ok({ receiptState: 'confirmed', completed: completed });
    }
    var category = choice === 'partial' ? 'missing_items' : choice === 'not_received' ? 'not_received' : String(body.category || '');
    var dr = txOpenDisputeInternal(ctx, category, note, ev.rows, { receiptChoice: choice });
    if (!dr.ok) return dr;
    var state = choice === 'problem' ? 'problem' : choice;
    appendTxRecord(ctx.order.OrderId, { type: 'receipt', actorType: 'buyer', actorId: ctx.actor.id, result: state, reason: note, requestId: ctx.requestId });
    saveTxState(ctx.state, { ReceiptState: state });
    return dr;
  });
}

/* ==================== Disputes ==================== */

function txDisputeHistory(d, entry) {
  var h = parseTxJson(d.HistoryJson, []);
  h.push(Object.assign({ at: nowIso() }, entry));
  return JSON.stringify(h.slice(-100));
}

/** Opens a problem report inside a running write. */
function txOpenDisputeInternal(ctx, category, description, evidenceRows, extra) {
  var cat = TX_DISPUTE_CATEGORIES[category];
  if (!cat) return txFail('Choose the kind of problem.');
  if (ctx.actor.type !== 'admin' && cat.who.indexOf(ctx.actor.type) === -1) return txFail('Choose the kind of problem.');
  if (txOpenDispute(ctx.state)) return txFail('A problem is already open for this order - add to it instead.');
  if (String(description || '').length < 15) return txFail('Describe the problem (at least 15 characters) so it can be looked into.');
  var records = txRecordsFor(ctx.order.OrderId);
  var block = txBlockingRequirement(txRequirements({ action: 'dispute', category: category, evidence: evidenceRows }), txExceptionsFor(records));
  if (block) return txFail(block.message, { requirement: block.key });
  var otherParty = ctx.actor.type === 'buyer' ? 'seller' : 'buyer';
  var now = nowIso();
  var d = {
    DisputeId: newId('txd'), OrderId: ctx.order.OrderId, OpenedByType: ctx.actor.type, OpenedById: ctx.actor.id, Category: category,
    Description: description, Status: 'awaiting_' + otherParty, Outcome: '', Rationale: '', OrderEffect: '', DecidedBy: '', DecidedAt: '',
    HistoryJson: JSON.stringify([{ at: now, by: ctx.actor.type, action: 'opened', to: 'awaiting_' + otherParty, note: TX_DISPUTE_CATEGORIES[category].label }]),
    Version: 1, CreatedAt: now, UpdatedAt: now
  };
  appendRowFromObject(txSheet('TxDisputes'), d);
  saveTxState(ctx.state, { OpenDisputeId: d.DisputeId, Hold: 'yes', HoldReason: ctx.state.HoldReason || 'Open problem report' });
  var ids = evidenceRows.map(function (e) { return e.EvidenceId; });
  appendTxEvent(ctx.state, { kind: 'dispute', actorType: ctx.actor.type, actorId: ctx.actor.id, evidenceIds: ids,
    body: 'Problem reported - ' + cat.label + ': ' + description, data: { disputeId: d.DisputeId, receiptChoice: extra && extra.receiptChoice } });
  appendTxEvent(ctx.state, { kind: 'system', actorType: 'system', body: txConfig()['prompt.dispute'] });
  txAudit(ctx.actor, 'TX_DISPUTE_OPENED', ctx.order.OrderId, '', { disputeId: d.DisputeId, category: category }, description, ctx.requestId);
  queueTxNotify(ctx.queue, ctx.order, otherParty, 'dispute_opened', d.DisputeId, 'A problem was reported on your order',
    'The ' + ctx.actor.type + ' reported a problem: ' + cat.label + '. Please reply in the order room with your side and any photos.');
  txNotifyAdmins(ctx.order, 'A problem was reported: ' + cat.label);
  return ok({ disputeId: d.DisputeId, status: d.Status });
}

function txNotifyAdmins(order, text) {
  try {
    var admins = getAdminEmails();
    if (!admins.length || txConfig()['notify.email'] !== 'on') return;
    var cache = CacheService.getScriptCache();
    var key = 'v1:tx:adminnotify:' + order.OrderId + ':' + text.length;
    if (cache.get(key)) return;
    cache.put(key, '1', 3600);
    var base = siteBaseUrl();
    sendAppEmail(admins.join(','), 'Order problem to review - ' + order.OrderId, text + '\n\n' +
      (base ? 'Review it: ' + base + '/owner/admin.html#tx-disputes' : 'Review it in the admin page, Order problems.'));
  } catch (e) { /* best effort */ }
}

/** Buyer or seller. body: category, description, evidenceIds. */
function actionTxOpenDispute(body) {
  return runTxWrite(body, 'openDispute', function (ctx) {
    var deny = txRoleOnly(ctx, ['buyer', 'seller']);
    if (deny) return deny;
    var ev = txOwnEvidence(ctx, body.evidenceIds);
    if (ev.error) return txFail(ev.error);
    return txOpenDisputeInternal(ctx, String(body.category || ''), txCleanText(body.description, 1500), ev.rows, null);
  });
}

/** Buyer or seller, on the open problem. body: text, evidenceIds, withdraw (reporter only). */
function actionTxRespondDispute(body) {
  return runTxWrite(body, 'respondDispute', function (ctx) {
    var deny = txRoleOnly(ctx, ['buyer', 'seller']);
    if (deny) return deny;
    var d = txOpenDispute(ctx.state);
    if (!d) return txFail('There is no open problem on this order.');
    var text = txCleanText(body.text, 1500);
    var ev = txOwnEvidence(ctx, body.evidenceIds);
    if (ev.error) return txFail(ev.error);
    var sheet = txSheet('TxDisputes');
    if (body.withdraw === true) {
      if (d.OpenedByType !== ctx.actor.type) return txFail('Only the person who reported the problem can withdraw it.');
      if (text.length < 5) return txFail('Say why you are withdrawing the problem.');
      updateRowFromObject(sheet, d.__row, { Status: 'resolved', Outcome: 'withdrawn', Rationale: text, DecidedBy: ctx.actor.type + ':' + ctx.actor.id,
        DecidedAt: nowIso(), HistoryJson: txDisputeHistory(d, { by: ctx.actor.type, action: 'withdrawn', to: 'resolved', note: text }),
        Version: (Number(d.Version) || 1) + 1, UpdatedAt: nowIso() });
      saveTxState(ctx.state, Object.assign({ OpenDisputeId: '' }, txReleaseAutoHold(ctx.state), txReopenReceiptAfterDispute(ctx, 'Problem withdrawn')));
      appendTxEvent(ctx.state, { kind: 'dispute', actorType: ctx.actor.type, actorId: ctx.actor.id, body: 'Problem withdrawn: ' + text, data: { disputeId: d.DisputeId } });
      txAudit(ctx.actor, 'TX_DISPUTE_WITHDRAWN', ctx.order.OrderId, d.Status, 'resolved', text, ctx.requestId);
      queueTxNotify(ctx.queue, ctx.order, ctx.actor.type === 'buyer' ? 'seller' : 'buyer', 'dispute_withdrawn', d.DisputeId, 'A problem report was withdrawn', 'The problem on this order was withdrawn.');
      txMaybeComplete(ctx, ctx.actor);
      return ok({ status: 'resolved' });
    }
    if (text.length < 2 && !ev.rows.length) return txFail('Write your reply or add a photo.');
    var to = String(d.Status) === 'awaiting_' + ctx.actor.type ? 'under_review' : String(d.Status);
    updateRowFromObject(sheet, d.__row, { Status: to, HistoryJson: txDisputeHistory(d, { by: ctx.actor.type, action: 'responded', to: to, note: text.slice(0, 200) }),
      Version: (Number(d.Version) || 1) + 1, UpdatedAt: nowIso() });
    appendTxEvent(ctx.state, { kind: 'dispute', actorType: ctx.actor.type, actorId: ctx.actor.id, evidenceIds: ev.rows.map(function (e) { return e.EvidenceId; }),
      body: 'Reply about the problem: ' + (text || '(photos added)'), data: { disputeId: d.DisputeId } });
    txAudit(ctx.actor, 'TX_DISPUTE_RESPONSE', ctx.order.OrderId, d.Status, to, '', ctx.requestId);
    queueTxNotify(ctx.queue, ctx.order, ctx.actor.type === 'buyer' ? 'seller' : 'buyer', 'dispute_reply', '', 'New reply about the problem on your order', 'There is a new reply about the problem on this order.');
    return ok({ status: to });
  });
}

/**
 * Admin, never a party to the order. body: disputeId, version, act
 * ('start'|'request_info'|'propose'|'resolve'|'reopen'), party, note, outcome,
 * orderEffect ('none'|'cancel'|'complete'), refundConfirmed.
 */
function actionAdminTxDispute(body) {
  return runTxWrite(body, 'adminDispute', function (ctx) {
    var deny = txRoleOnly(ctx, ['admin']);
    if (deny) return deny;
    if (txIsParty(ctx.actor, ctx.order)) return txFail('You are a party to this order, so another admin must review it.');
    var sheet = txSheet('TxDisputes');
    var d = findRowById(sheet, 'DisputeId', String(body.disputeId || ''));
    if (!d || d.OrderId !== ctx.order.OrderId) return txFail('Problem report not found.');
    if (body.disputeVersion !== undefined && Number(body.disputeVersion) !== Number(d.Version)) {
      return txFail('Someone else updated this problem while you had it open. It has been refreshed.', { stale: true });
    }
    var act = String(body.act || '');
    var note = txCleanText(body.note, 1500);
    var isOpen = TX_DISPUTE_OPEN.indexOf(String(d.Status)) !== -1;
    var to, fields = {}, eventBody, audit;
    if (act === 'start') {
      if (!isOpen) return txFail('This problem is not open.');
      to = 'under_review'; eventBody = 'Mwakete is reviewing this problem.'; audit = 'TX_DISPUTE_REVIEW_STARTED';
    } else if (act === 'request_info') {
      if (!isOpen) return txFail('This problem is not open.');
      var party = String(body.party || '');
      if (party !== 'buyer' && party !== 'seller') return txFail('Choose who should send more information.');
      if (note.length < 10) return txFail('Say what information is needed.');
      to = 'awaiting_' + party; eventBody = 'Mwakete asks the ' + party + ' for more information: ' + note; audit = 'TX_DISPUTE_INFO_REQUESTED';
      queueTxNotify(ctx.queue, ctx.order, party, 'dispute_info', String(d.Version), 'Mwakete needs more information', 'Mwakete asked you for more information about the problem on this order.');
    } else if (act === 'propose') {
      if (!isOpen) return txFail('This problem is not open.');
      if (note.length < 15) return txFail('Describe the proposed resolution.');
      to = 'resolution_proposed'; eventBody = 'Mwakete proposes: ' + note + ' Reply here if you agree or disagree.'; audit = 'TX_DISPUTE_PROPOSED';
      ['buyer', 'seller'].forEach(function (p) { queueTxNotify(ctx.queue, ctx.order, p, 'dispute_proposed', String(d.Version), 'Mwakete proposed a resolution', 'Mwakete proposed a resolution for the problem on this order.'); });
    } else if (act === 'resolve') {
      if (!isOpen) return txFail('This problem is not open.');
      var outcome = String(body.outcome || '');
      if (!TX_DISPUTE_OUTCOMES[outcome] || outcome === 'withdrawn') return txFail('Choose the outcome.');
      if (note.length < 15) return txFail('Record the reasons for the decision (at least 15 characters).');
      var effect = String(body.orderEffect || 'none');
      if (['none', 'cancel', 'complete'].indexOf(effect) === -1) return txFail('Choose what happens to the order.');
      if (effect === 'complete' && ctx.state.PaymentState !== 'verified') return txFail('The order cannot be completed: the seller has not confirmed payment.');
      to = 'resolved';
      fields = { Outcome: outcome, Rationale: note, OrderEffect: effect, DecidedBy: ctx.actor.id, DecidedAt: nowIso() };
      eventBody = 'Problem resolved - ' + TX_DISPUTE_OUTCOMES[outcome] + '. Reasons: ' + note +
        (effect === 'cancel' ? ' The order is cancelled.' : effect === 'complete' ? ' The order is completed.' : '');
      audit = 'TX_DISPUTE_RESOLVED';
      ['buyer', 'seller'].forEach(function (p) { queueTxNotify(ctx.queue, ctx.order, p, 'dispute_resolved', d.DisputeId, 'The problem on your order was decided', 'Mwakete recorded a decision on the problem on this order.'); });
    } else if (act === 'reopen') {
      if (isOpen) return txFail('This problem is already open.');
      if (txOpenDispute(ctx.state)) return txFail('Another problem is open on this order.');
      var days = Number(txConfig()['dispute.reopenDays']) || 0;
      var decided = new Date(d.DecidedAt || d.UpdatedAt).getTime();
      if (!days || (decided && Date.now() - decided > days * 86400000)) return txFail('This problem was decided more than ' + days + ' days ago and cannot be reopened.');
      if (note.length < 10) return txFail('Say why the problem is being reopened.');
      to = 'under_review'; eventBody = 'Mwakete reopened this problem: ' + note; audit = 'TX_DISPUTE_REOPENED';
    } else {
      return txFail('Unknown action.');
    }
    var from = String(d.Status);
    fields.Status = to;
    fields.HistoryJson = txDisputeHistory(d, { by: 'admin', actorId: ctx.actor.id, action: act, to: to, note: note.slice(0, 300) });
    fields.Version = (Number(d.Version) || 1) + 1;
    fields.UpdatedAt = nowIso();
    updateRowFromObject(sheet, d.__row, fields);
    if (act === 'reopen') saveTxState(ctx.state, { OpenDisputeId: d.DisputeId, Hold: 'yes', HoldReason: 'Reopened problem report' });
    else if (to === 'resolved') {
      saveTxState(ctx.state, Object.assign({ OpenDisputeId: '' }, txReleaseAutoHold(ctx.state),
        fields.OrderEffect === 'none' ? txReopenReceiptAfterDispute(ctx, 'Problem resolved: ' + TX_DISPUTE_OUTCOMES[fields.Outcome]) : {}));
    }
    else saveTxState(ctx.state, {});
    appendTxEvent(ctx.state, { kind: 'dispute', actorType: 'admin', actorId: ctx.actor.id, body: eventBody, data: { disputeId: d.DisputeId, act: act } });
    txAudit(ctx.actor, audit, ctx.order.OrderId, from, to, note, ctx.requestId);
    if (to === 'resolved') {
      if (fields.OrderEffect === 'cancel') { var c = txCancelInternal(ctx, 'Cancelled after the problem review'); if (!c.ok) return c; }
      if (fields.OrderEffect === 'complete') {
        var st = txSetOrderStatus(ctx, 'Fulfilled');
        if (!st.ok) return st;
        appendTxEvent(ctx.state, { kind: 'status', actorType: 'admin', actorId: ctx.actor.id, body: 'Order completed by Mwakete after the problem review.' });
      } else {
        txMaybeComplete(ctx, ctx.actor);
      }
    }
    return ok({ status: to });
  });
}

/* ==================== Cancel and refund ==================== */

function txCancelInternal(ctx, reason) {
  var prevStatus = String(ctx.order.Status);
  // A driver job that has not collected the goods ends with the order.
  if (typeof activeDeliveryJob === 'function') {
    var dj = activeDeliveryJob(ctx.order.OrderId);
    if (dj && dj.Status !== 'picked_up') {
      var djRow = findRowById(deliveryJobsSheet(), 'JobId', dj.JobId);
      saveJob(djRow, { Status: 'cancelled', ClosedAt: nowIso(), FailReason: 'cancelled: order cancelled', Sharing: '', LastLat: '', LastLng: '', LastAccuracy: '', LastLocAt: '' });
    }
  }
  var st = txSetOrderStatus(ctx, 'Cancelled');
  if (!st.ok) return st;
  var refundDue = ctx.state.PaymentState === 'verified';
  var goodsLeft = TX_GOODS_LEFT.indexOf(String(ctx.state.FulfilmentState)) !== -1;
  saveTxState(ctx.state, refundDue ? { RefundState: 'due' } : {});
  appendTxEvent(ctx.state, { kind: 'status', actorType: ctx.actor.type, actorId: ctx.actor.id, body: 'Order cancelled: ' + reason +
    (refundDue ? ' Payment was confirmed, so the seller needs to return it and record the refund here. Mwakete does not hold or send money.' : '') +
    (goodsLeft ? ' The goods had already left, so stock was not put back automatically - adjust it on the Inventory page if they are returned.' : '') });
  txAudit(ctx.actor, 'TX_ORDER_CANCELLED', ctx.order.OrderId, prevStatus, 'Cancelled', reason, ctx.requestId);
  ['buyer', 'seller'].forEach(function (p) {
    if (p !== ctx.actor.type) queueTxNotify(ctx.queue, ctx.order, p, 'cancelled', '', 'Order cancelled', 'This order was cancelled: ' + reason);
  });
  return ok({ status: 'Cancelled', refundDue: refundDue });
}

/** Seller (before the goods leave, no open problem) or admin (any time, not a party). body: reason. */
function actionTxCancel(body) {
  return runTxWrite(body, 'cancel', function (ctx) {
    var deny = txRoleOnly(ctx, ['seller', 'admin']);
    if (deny) return deny;
    if (ctx.state.Flow !== 'v1' && ctx.actor.type === 'seller') return txV1Only(ctx);
    if (txIsFinal(ctx.order)) return txFail('This order is already cancelled.');
    if (String(ctx.order.Status) === 'Fulfilled') return txFail('A completed order cannot be cancelled. Report a problem instead.');
    var reason = txCleanText(body.reason, 500);
    if (reason.length < 5) return txFail('Say why the order is cancelled.');
    if (ctx.actor.type === 'admin') {
      if (txIsParty(ctx.actor, ctx.order)) return txFail('You are a party to this order, so another admin must decide.');
    } else {
      if (txOpenDispute(ctx.state)) return txFail('A problem is open on this order - Mwakete will decide what happens to it.');
      if (['dispatched', 'delivered', 'handed_over'].indexOf(String(ctx.state.FulfilmentState)) !== -1) {
        return txFail('The goods have already left, so only Mwakete can cancel this order. Report a problem if needed.');
      }
    }
    return txCancelInternal(ctx, reason);
  });
}

/** Seller: they actually sent the money back. body: reference, note, confirmSent, evidenceIds. */
function actionTxRecordRefund(body) {
  return runTxWrite(body, 'recordRefund', function (ctx) {
    var deny = txRoleOnly(ctx, ['seller']);
    if (deny) return deny;
    if (ctx.state.RefundState !== 'due') return txFail('No refund is due on this order.');
    if (body.confirmSent !== true) return txFail('Only record a refund after you have actually sent the money back.');
    var reference = txCleanText(body.reference, 60);
    var note = txCleanText(body.note, 500);
    if (!reference && note.length < 5) return txFail('Give the refund reference or say how it was returned.');
    var ev = txOwnEvidence(ctx, body.evidenceIds);
    if (ev.error) return txFail(ev.error);
    var rec = appendTxRecord(ctx.order.OrderId, { type: 'refund', actorType: 'seller', actorId: ctx.actor.id, result: 'sent', reason: note,
      data: { reference: reference }, evidenceIds: ev.rows.map(function (e) { return e.EvidenceId; }), requestId: ctx.requestId });
    saveTxState(ctx.state, { RefundState: 'sent' });
    appendTxEvent(ctx.state, { kind: 'payment', actorType: 'seller', actorId: ctx.actor.id, evidenceIds: ev.rows.map(function (e) { return e.EvidenceId; }),
      body: 'Seller reports the refund was sent' + (reference ? ' (reference ' + reference + ')' : '') + (note ? ': ' + note : '') + '. Waiting for the buyer to confirm it arrived.' });
    txAudit(ctx.actor, 'TX_REFUND_SENT', ctx.order.OrderId, 'due', 'sent', note, ctx.requestId);
    queueTxNotify(ctx.queue, ctx.order, 'buyer', 'refund_sent', rec.RecordId, 'The seller reports sending your refund', 'Please check your account and confirm the refund arrived, or report a problem.');
    return ok({ refundState: 'sent' });
  });
}

/** Buyer: the refund arrived. */
function actionTxConfirmRefund(body) {
  return runTxWrite(body, 'confirmRefund', function (ctx) {
    var deny = txRoleOnly(ctx, ['buyer']);
    if (deny) return deny;
    if (ctx.state.RefundState !== 'sent') return txFail('The seller has not recorded a refund yet.');
    appendTxRecord(ctx.order.OrderId, { type: 'refund', actorType: 'buyer', actorId: ctx.actor.id, result: 'received', requestId: ctx.requestId });
    saveTxState(ctx.state, { RefundState: 'received' });
    appendTxEvent(ctx.state, { kind: 'payment', actorType: 'buyer', actorId: ctx.actor.id, body: 'Buyer confirmed the refund arrived.' });
    txAudit(ctx.actor, 'TX_REFUND_RECEIVED', ctx.order.OrderId, 'sent', 'received', '', ctx.requestId);
    return ok({ refundState: 'received' });
  });
}

/* ==================== Admin tools ==================== */

/** Admin exception for one waivable requirement. body: key, reason. */
function actionAdminTxException(body) {
  return runTxWrite(body, 'adminException', function (ctx) {
    var deny = txRoleOnly(ctx, ['admin']);
    if (deny) return deny;
    if (txIsParty(ctx.actor, ctx.order)) return txFail('You are a party to this order, so another admin must decide.');
    var key = String(body.key || '');
    var allowed = String(txConfig()['exceptions.allowed']).split(',').map(function (s) { return s.trim(); });
    if (TX_EXCEPTION_KEYS.indexOf(key) === -1 || allowed.indexOf(key) === -1) return txFail('That requirement cannot be waived.');
    var reason = txCleanText(body.reason, 500);
    if (reason.length < 15) return txFail('Record why the exception is justified (at least 15 characters).');
    var rec = appendTxRecord(ctx.order.OrderId, { type: 'exception', actorType: 'admin', actorId: ctx.actor.id, result: key, reason: reason, requestId: ctx.requestId });
    appendTxEvent(ctx.state, { kind: 'status', actorType: 'admin', actorId: ctx.actor.id, body: 'Mwakete waived one requirement for this order (' + key + '): ' + reason });
    txAudit(ctx.actor, 'TX_EXCEPTION_GRANTED', ctx.order.OrderId, '', key, reason, ctx.requestId);
    return ok({ recordId: rec.RecordId });
  });
}

/** Admin: put a buyer's receipt answer aside (kept in history) so they can answer again. body: reason. */
function actionAdminTxCorrectReceipt(body) {
  return runTxWrite(body, 'adminCorrectReceipt', function (ctx) {
    var deny = txRoleOnly(ctx, ['admin']);
    if (deny) return deny;
    if (txIsParty(ctx.actor, ctx.order)) return txFail('You are a party to this order, so another admin must decide.');
    if (!ctx.state.ReceiptState) return txFail('There is no receipt answer to correct.');
    if (String(ctx.order.Status) === 'Fulfilled') return txFail('The order is already complete.');
    var reason = txCleanText(body.reason, 500);
    if (reason.length < 15) return txFail('Record why the answer is being corrected.');
    var prior = latestTxRecord(txRecordsFor(ctx.order.OrderId), 'receipt');
    appendTxRecord(ctx.order.OrderId, { type: 'receipt_correction', actorType: 'admin', actorId: ctx.actor.id, result: 'cleared', reason: reason,
      supersedesId: prior ? prior.RecordId : '', requestId: ctx.requestId });
    var prev = ctx.state.ReceiptState;
    saveTxState(ctx.state, { ReceiptState: '' });
    appendTxEvent(ctx.state, { kind: 'status', actorType: 'admin', actorId: ctx.actor.id, body: 'Mwakete set aside the buyer\'s earlier receipt answer (kept in the history): ' + reason });
    txAudit(ctx.actor, 'TX_RECEIPT_CORRECTED', ctx.order.OrderId, prev, '', reason, ctx.requestId);
    return ok({ receiptState: '' });
  });
}

/**
 * Admin exception: complete an order without the buyer's confirmation (for
 * example a buyer who cannot be reached after delivery was shown). Needs the
 * seller's payment confirmation and no open problem.
 */
function actionAdminTxComplete(body) {
  return runTxWrite(body, 'adminComplete', function (ctx) {
    var deny = txRoleOnly(ctx, ['admin']);
    if (deny) return deny;
    if (txIsParty(ctx.actor, ctx.order)) return txFail('You are a party to this order, so another admin must decide.');
    if (txIsFinal(ctx.order) || String(ctx.order.Status) === 'Fulfilled') return txFail('This order is already finished.');
    if (txOpenDispute(ctx.state)) return txFail('Resolve the open problem first.');
    if (ctx.state.PaymentState !== 'verified') return txFail('The seller has not confirmed payment, so the order cannot be completed.');
    if (['dispatched', 'delivered', 'handed_over'].indexOf(String(ctx.state.FulfilmentState)) === -1) return txFail('The goods have not been recorded as sent or handed over.');
    var reason = txCleanText(body.reason, 500);
    if (reason.length < 15) return txFail('Record why the order is completed without the buyer\'s confirmation.');
    var st = txSetOrderStatus(ctx, 'Fulfilled');
    if (!st.ok) return st;
    appendTxRecord(ctx.order.OrderId, { type: 'admin_completed', actorType: 'admin', actorId: ctx.actor.id, result: 'completed', reason: reason, requestId: ctx.requestId });
    appendTxEvent(ctx.state, { kind: 'status', actorType: 'admin', actorId: ctx.actor.id, body: 'Mwakete completed this order without the buyer\'s confirmation: ' + reason });
    txAudit(ctx.actor, 'TX_ADMIN_COMPLETED', ctx.order.OrderId, 'Paid', 'Fulfilled', reason, ctx.requestId);
    return ok({ status: 'Fulfilled' });
  });
}

/** Admin: keep (or stop keeping) this order's files beyond the normal retention time. body: hold, reason. */
function actionAdminTxHold(body) {
  return runTxWrite(body, 'adminHold', function (ctx) {
    var deny = txRoleOnly(ctx, ['admin']);
    if (deny) return deny;
    var on = body.hold === true;
    var reason = txCleanText(body.reason, 300);
    if (reason.length < 10) return txFail('Record why.');
    if (!on && txOpenDispute(ctx.state)) return txFail('An open problem keeps the hold on.');
    saveTxState(ctx.state, { Hold: on ? 'yes' : '', HoldReason: on ? reason : '' });
    appendTxEvent(ctx.state, { kind: 'status', actorType: 'admin', actorId: ctx.actor.id, audience: 'admin', body: (on ? 'Hold placed: ' : 'Hold lifted: ') + reason });
    txAudit(ctx.actor, on ? 'TX_HOLD_ON' : 'TX_HOLD_OFF', ctx.order.OrderId, '', '', reason, ctx.requestId);
    return ok({ hold: on });
  });
}

/** Admin: note visible only to admins. body: text. */
function actionAdminTxNote(body) {
  return runTxWrite(body, 'adminNote', function (ctx) {
    var deny = txRoleOnly(ctx, ['admin']);
    if (deny) return deny;
    var text = txCleanText(body.text, 1500);
    if (text.length < 3) return txFail('Write the note.');
    appendTxEvent(ctx.state, { kind: 'note', actorType: 'admin', actorId: ctx.actor.id, audience: 'admin', body: text });
    return ok({});
  });
}

/**
 * Admin: remove one file (for example a receipt showing a full account number
 * by mistake). The record stays - who, when, what kind, its hash - the
 * content goes. body: evidenceId, reason.
 */
function actionAdminTxRedactEvidence(body) {
  return runTxWrite(body, 'adminRedact', function (ctx) {
    var deny = txRoleOnly(ctx, ['admin']);
    if (deny) return deny;
    var reason = txCleanText(body.reason, 300);
    if (reason.length < 10) return txFail('Record why the file is removed.');
    var sheet = txSheet('TxEvidence');
    var e = findRowById(sheet, 'EvidenceId', String(body.evidenceId || ''));
    if (!e || e.OrderId !== ctx.order.OrderId) return txFail('File not found');
    if (e.DeletedAt) return txFail('This file was already removed.');
    txTrashEvidenceFiles(e);
    updateRowFromObject(sheet, e.__row, { DeletedAt: nowIso(), DeletedReason: 'removed by Mwakete: ' + reason, Retention: 'redacted' });
    appendTxEvent(ctx.state, { kind: 'status', actorType: 'admin', actorId: ctx.actor.id, body: 'Mwakete removed a file (' + (TX_EVIDENCE_CATEGORIES[e.Category] || 'file') + '): ' + reason });
    txAudit(ctx.actor, 'TX_EVIDENCE_REDACTED', ctx.order.OrderId, e.EvidenceId, 'removed', reason, ctx.requestId);
    invalidateCache([txEventsCacheKey(ctx.order.OrderId)]);
    return ok({});
  });
}

function txTrashEvidenceFiles(e) {
  [e.FileId, e.ThumbFileId].forEach(function (id) {
    if (!id) return;
    try { DriveApp.getFileById(id).setTrashed(true); } catch (err) { /* already gone */ }
  });
}

/** Admin: problem reports, newest first. body.status: 'open' (default) | 'resolved' | 'all'. */
function actionAdminListTxDisputes(owner, body) {
  if (!isOwnerAdmin(owner)) return denyAdmin(owner, 'adminListTxDisputes');
  var want = String((body && body.status) || 'open');
  var orders = {};
  sheetToObjects(getSheet('Orders')).forEach(function (o) { orders[o.OrderId] = o; });
  var storeName = makeStoreNameResolver();
  var rows = txRows('TxDisputes').filter(function (d) {
    var open = TX_DISPUTE_OPEN.indexOf(String(d.Status)) !== -1;
    return want === 'all' || (want === 'open' ? open : !open);
  }).sort(function (a, b) { return String(b.UpdatedAt).localeCompare(String(a.UpdatedAt)); }).slice(0, 200);
  return ok({
    disputes: rows.map(function (d) {
      var o = orders[d.OrderId] || {};
      return { id: d.DisputeId, orderId: d.OrderId, storeName: storeName(o.StoreSlug), category: (TX_DISPUTE_CATEGORIES[d.Category] || {}).label || d.Category,
        status: d.Status, statusLabel: TX_DISPUTE_LABEL[d.Status] || d.Status, openedBy: d.OpenedByType, total: o.Total,
        createdAt: d.CreatedAt, updatedAt: d.UpdatedAt, outcome: TX_DISPUTE_OUTCOMES[d.Outcome] || '',
        yours: !!(o.OwnerId && o.OwnerId === owner.OwnerId) || normalizeEmail(o.CustomerEmail) === normalizeEmail(owner.Email) };
    }),
    mode: txMode()
  });
}

function actionAdminGetTxConfig(owner) {
  if (!isOwnerAdmin(owner)) return denyAdmin(owner, 'adminGetTxConfig');
  var cfg = txConfig();
  return ok({
    mode: txMode(),
    settings: Object.keys(TX_CONFIG_SPEC).map(function (k) {
      var s = TX_CONFIG_SPEC[k];
      return { key: k, label: s.label, type: s.type, values: s.values || null, min: s.min, max: s.max, value: cfg[k], def: s.def };
    })
  });
}

/** body.values: { key: value }. Every change is audited with its old and new value. */
function actionAdminSaveTxConfig(owner, body) {
  if (!isOwnerAdmin(owner)) return denyAdmin(owner, 'adminSaveTxConfig');
  var values = (body && body.values) || {};
  var keys = Object.keys(values);
  if (!keys.length) return fail('Nothing to save.');
  for (var i = 0; i < keys.length; i++) {
    var err = txConfigValueError(keys[i], values[keys[i]]);
    if (err) return fail(err);
  }
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sheet = txSheet('TxConfig');
    var rows = sheetToObjects(sheet);
    var before = txConfig();
    keys.forEach(function (k) {
      var v = String(txConfigClean(k, values[k]));
      var row = rows.filter(function (r) { return r.Key === k; })[0];
      if (String(before[k]) === v && row) return;
      if (row) updateRowFromObject(sheet, row.__row, { Value: v, UpdatedAt: nowIso(), UpdatedBy: owner.OwnerId });
      else appendRowFromObject(sheet, { Key: k, Value: v, UpdatedAt: nowIso(), UpdatedBy: owner.OwnerId });
      appendAudit({ actorId: owner.OwnerId, actorRole: 'admin', action: 'TX_CONFIG_CHANGED', entityType: 'config', entityId: k, previous: before[k], next: v });
    });
    invalidateCache([TX_CONFIG_CACHE_KEY]);
  } finally {
    lock.releaseLock();
  }
  return ok({});
}

/* ==================== Order list summaries ==================== */

/** { orderId: { flow, stage, unread, dispute } } for the given orders - one read of each tab. */
function txSummariesFor(orders, viewer) {
  var out = {};
  if (!orders.length) return out;
  var states = txRows('TxState');
  if (!states.length) return out;
  var byId = {};
  states.forEach(function (s) { byId[s.OrderId] = s; });
  var disputes = {};
  txRows('TxDisputes').forEach(function (d) { if (TX_DISPUTE_OPEN.indexOf(String(d.Status)) !== -1) disputes[d.DisputeId] = d; });
  orders.forEach(function (o) {
    var s = byId[o.OrderId];
    if (!s) return;
    var d = s.OpenDisputeId ? disputes[s.OpenDisputeId] || null : null;
    var read = viewer === 'buyer' ? Number(s.ReadBuyerSeq) || 0 : Number(s.ReadSellerSeq) || 0;
    var entry = { flow: s.Flow, stage: txStageLabel(o, s, d), unread: Math.max(0, (Number(s.LastSeq) || 0) - read), dispute: !!d };
    // What the BUYER has to do next, from the same rules the room uses - for
    // the customer dashboard's "needs you" list.
    if (viewer === 'buyer') {
      var acts = txNextActions('buyer', o, s, d, []);
      entry.todo = acts.indexOf('confirmReceipt') !== -1 ? 'confirmReceipt' : acts.indexOf('submitPayment') !== -1 && s.PaymentState !== 'submitted' ? 'submitPayment'
        : acts.indexOf('confirmRefund') !== -1 ? 'confirmRefund' : '';
    }
    out[o.OrderId] = entry;
  });
  return out;
}

/** Whether this order's room can be opened at all (rooms switched on for its store). */
function txRoomAvailable(order) { return txEnabledForStore(order.StoreSlug); }

/* ==================== Hooks into existing flows ==================== */

/** Called by actionCreateOrder inside its lock. Never fails the order. */
function txOnOrderCreated(order) {
  try {
    if (!txEnabledForStore(order.StoreSlug)) return;
    initTxState(order, 'v1');
  } catch (e) {
    Logger.log('tx room init failed for ' + order.OrderId + ': ' + (e && e.message));
  }
}

/**
 * Called by actionUpdateOrderStatus (the seller's Orders page dropdown).
 * Returns a fail() when the dropdown must not change this order, else null.
 */
function txGuardLegacyStatusChange(order, newStatus) {
  // Rooms switched off for this store (rollback): the dropdown is in charge
  // of every order again, so nothing gets stuck.
  if (!txEnabledForStore(order.StoreSlug)) return null;
  var sheet = SpreadsheetApp.getActive().getSheetByName('TxState');
  if (!sheet) return null;
  var state = findRowById(sheet, 'OrderId', order.OrderId);
  if (!state) return null;
  if (state.Flow === 'v1' && String(order.Status) !== newStatus) {
    return fail('This order uses the order room. Record payment, sending and cancellation there, so the buyer sees each step.');
  }
  if (txOpenDispute(state) && String(order.Status) !== newStatus) {
    return fail('A problem has been reported on this order. Its status cannot change until Mwakete has reviewed it.');
  }
  return null;
}

/* ==================== Retention ==================== */

/**
 * Deletes the FILES of finished orders past the retention time (metadata,
 * hashes and the timeline stay). Never touches an order with an open problem
 * or a hold. Editor-only / time-trigger: run sweepTxRetention from the Apps
 * Script editor, or add a daily trigger for it. Returns a summary.
 */
function sweepTxRetention(nowMs) {
  var now = nowMs || Date.now();
  var cfg = txConfig();
  var orders = {};
  sheetToObjects(getSheet('Orders')).forEach(function (o) { orders[o.OrderId] = o; });
  var states = {};
  txRows('TxState').forEach(function (s) { states[s.OrderId] = s; });
  var disputesByOrder = {};
  txRows('TxDisputes').forEach(function (d) { (disputesByOrder[d.OrderId] = disputesByOrder[d.OrderId] || []).push(d); });
  var sheet = SpreadsheetApp.getActive().getSheetByName('TxEvidence');
  if (!sheet) return { deleted: 0, kept: 0 };
  var deleted = 0, kept = 0;
  sheetToObjects(sheet).forEach(function (e) {
    if (e.DeletedAt) return;
    var o = orders[e.OrderId], s = states[e.OrderId];
    if (!txRetentionEligible(o, s, disputesByOrder[e.OrderId] || [], cfg, now)) { kept++; return; }
    txTrashEvidenceFiles(e);
    updateRowFromObject(sheet, e.__row, { DeletedAt: new Date(now).toISOString(), DeletedReason: 'retention period ended', Retention: 'expired' });
    deleted++;
  });
  if (deleted) appendAudit({ actorId: 'system', actorRole: 'system', action: 'TX_RETENTION_SWEEP', entityType: 'evidence', entityId: '', next: { deleted: deleted, kept: kept } });
  return { deleted: deleted, kept: kept };
}

/** Pure: may this order's files be deleted now? */
function txRetentionEligible(order, state, disputes, cfg, now) {
  if (!order || !state) return false;
  if (state.Hold === 'yes') return false;
  if (disputes.some(function (d) { return TX_DISPUTE_OPEN.indexOf(String(d.Status)) !== -1; })) return false;
  var status = String(order.Status);
  if (status !== 'Fulfilled' && status !== 'Cancelled') return false;
  if (status === 'Cancelled' && state.RefundState === 'due') return false;
  var finishedAt = new Date(state.UpdatedAt || order.UpdatedAt || order.CreatedAt).getTime();
  var lastDecision = disputes.reduce(function (m, d) { return Math.max(m, new Date(d.DecidedAt || d.UpdatedAt).getTime() || 0); }, 0);
  var days = disputes.length ? Number(cfg['retention.disputeDays']) : Number(cfg['retention.days']);
  var from = Math.max(finishedAt || 0, lastDecision || 0);
  return !!from && now - from > days * 86400000;
}
