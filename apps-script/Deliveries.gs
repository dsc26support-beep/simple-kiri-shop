/**
 * Independent drivers and delivery jobs (Oct 2026, dashboard stage 6).
 * Design notes and guides: docs/deliveries.md.
 *
 * THE MODEL - low cost first, South Tarawa first:
 *  - A driver is an ordinary signed-in CUSTOMER account that applied to drive
 *    and was approved by a Mwakete admin. No new login system.
 *  - A SELLER books a driver for one of their delivery orders from its order
 *    room, offering a fee. The seller pays the driver directly; Mwakete never
 *    holds or moves money, and checkout prices do not change.
 *  - An approved, available driver accepts the job. Only then do they see the
 *    buyer's name, phone and drop-off details.
 *  - The driver records PICKUP (this is the order's dispatch record), then
 *    DELIVERY with a required photo and the recipient's name - or a FAILED
 *    delivery with a reason. The buyer still confirms receipt in the room;
 *    a driver's record never completes an order.
 *  - LIVE LOCATION is opt-in by the driver, from the phone's own browser,
 *    only while their job is active, at most once every 30 seconds. Only the
 *    last position is kept, and it is wiped when the job ends. The seller,
 *    the buyer and admins see it as a free OpenStreetMap link.
 *
 * ROLLOUT: Script Property DELIVERY_JOBS = 'on' (default off), and order
 * rooms must be on for the store (Transactions.gs).
 *
 * ISLANDS (owner decision, Oct 2026): drivers work on EVERY island, but a
 * delivery never leaves one: a job exists only when the store and the buyer
 * are on the same island, and only drivers on that island see or take it.
 * DELIVERY_AREAS can still narrow the islands (comma list); unset or 'all'
 * means every island.
 *
 * TABS (created on first use, additive):
 *   Drivers       DriverId | CustomerId | Name | Phone | Email | Vehicle | Area | Status
 *                 | Available | ReviewedBy | ReviewedAt | ReviewNote | CreatedAt | UpdatedAt
 *   DeliveryJobs  JobId | OrderId | OwnerId | StoreSlug | Status | DriverId | Fee | Pickup
 *                 | Dropoff | Notes | FeePaid | FailReason | Sharing | LastLat | LastLng
 *                 | LastAccuracy | LastLocAt | Version | CreatedAt | AcceptedAt | PickedUpAt
 *                 | DeliveredAt | ClosedAt | UpdatedAt
 */

var DRIVER_HEADERS = ['DriverId', 'CustomerId', 'Name', 'Phone', 'Email', 'Vehicle', 'Area', 'Status', 'Available',
  'ReviewedBy', 'ReviewedAt', 'ReviewNote', 'CreatedAt', 'UpdatedAt'];
var DELIVERY_JOB_HEADERS = ['JobId', 'OrderId', 'OwnerId', 'StoreSlug', 'Status', 'DriverId', 'Fee', 'Pickup', 'Dropoff', 'Notes',
  'FeePaid', 'FailReason', 'Sharing', 'LastLat', 'LastLng', 'LastAccuracy', 'LastLocAt', 'Version', 'CreatedAt', 'AcceptedAt',
  'PickedUpAt', 'DeliveredAt', 'ClosedAt', 'UpdatedAt',
  'FeeProposedBy', 'FeeSellerOk', 'FeeDriverOk', 'FeeLocked',
  'PayRef', 'PayStatus', 'PayBankRef', 'PayAmount', 'PayNote', 'PaySubmittedAt', 'PayCheckedBy', 'PayCheckedAt', 'PayRefundRef'];
// Fee agreement (driver wallet phase 2) and the seller's payment to Mwakete
// (phase 3), docs/driver-wallet.md. A sheet made before they existed gets them
// appended with ensureColumn; nothing reads them unless the driver is covered
// by DELIVERY_PAYMENTS (DriverWallet.gs).
var DELIVERY_JOB_FEE_COLUMNS = ['FeeProposedBy', 'FeeSellerOk', 'FeeDriverOk', 'FeeLocked',
  'PayRef', 'PayStatus', 'PayBankRef', 'PayAmount', 'PayNote', 'PaySubmittedAt', 'PayCheckedBy', 'PayCheckedAt', 'PayRefundRef'];
var DELIVERY_MESSAGE_HEADERS = ['MessageId', 'JobId', 'SenderType', 'SenderId', 'Body', 'RequestId', 'CreatedAt'];
var DRIVER_VEHICLES = { motorbike: 'Motorbike', car: 'Car', truck: 'Truck / van', bicycle: 'Bicycle', other: 'Other' };
var DELIVERY_JOB_ACTIVE = ['open', 'accepted', 'picked_up'];
var DELIVERY_JOB_LABEL = {
  open: 'Waiting for a driver', accepted: 'Driver on the way to collect', picked_up: 'Driver has the goods',
  delivered: 'Driver reports delivered', failed: 'Delivery failed', cancelled: 'Cancelled'
};
var DELIVERY_FAIL_REASONS = {
  no_one_home: 'Nobody there to receive it', wrong_address: 'Could not find the address', refused: 'Refused by the recipient',
  unreachable: 'Buyer could not be reached', damaged: 'Goods damaged on the way', other: 'Other'
};
var DRIVER_MAX_ACTIVE_JOBS = 3;

function driversSheet() { return getSheetCreating('Drivers', DRIVER_HEADERS); }
function deliveryJobsSheet() {
  var sheet = getSheetCreating('DeliveryJobs', DELIVERY_JOB_HEADERS);
  // A sheet made before the fee columns existed gets them appended (no existing column moves).
  DELIVERY_JOB_FEE_COLUMNS.forEach(function (c) { ensureColumn(sheet, c); });
  return sheet;
}
function deliveryMessagesSheet() { return getSheetCreating('DeliveryMessages', DELIVERY_MESSAGE_HEADERS); }
function deliveryRows(name) { var s = SpreadsheetApp.getActive().getSheetByName(name); return s ? sheetToObjects(s) : []; }

function deliveriesEnabled() {
  return String(PropertiesService.getScriptProperties().getProperty('DELIVERY_JOBS') || 'off').trim().toLowerCase() === 'on';
}

// The same island names as assets/js/kiribati-locations.js (stores, buyers and drivers all pick from it).
var KIRIBATI_ISLAND_NAMES = ['South Tarawa', 'North Tarawa', 'Makin', 'Butaritari', 'Marakei', 'Abaiang', 'Maiana', 'Kuria', 'Aranuka',
  'Abemama', 'Nonouti', 'Tabiteuea North', 'Tabiteuea South', 'Beru', 'Nikunau', 'Onotoa', 'Tamana', 'Arorae', 'Banaba',
  'Kiritimati', 'Tabuaeran', 'Teraina', 'Kanton'];

function deliveryAllIslands() {
  var raw = String(PropertiesService.getScriptProperties().getProperty('DELIVERY_AREAS') || '').trim();
  return !raw || raw.toLowerCase() === 'all';
}

function deliveryAreas() {
  if (deliveryAllIslands()) return KIRIBATI_ISLAND_NAMES.slice();
  return String(PropertiesService.getScriptProperties().getProperty('DELIVERY_AREAS'))
    .split(',').map(function (s) { return s.trim(); }).filter(Boolean);
}

function islandKey(v) { return String(v || '').trim().toLowerCase(); }

/** Why a driver cannot take this order, or '' when one can: same island for store and buyer, and an island drivers cover. */
function deliveryCoverageError(order, store) {
  var island = islandKey(order.Island);
  if (!island) return 'The buyer has no island on this order.';
  store = store || findRowById(getSheet('Owners'), 'OwnerId', order.OwnerId);
  if (!store || islandKey(store.Island) !== island) {
    return 'Mwakete drivers deliver within one island only. This store is on ' + ((store && store.Island) || 'an unknown island') + ' and the buyer is on ' + order.Island + '.';
  }
  if (deliveryAreas().map(islandKey).indexOf(island) === -1) return 'Mwakete drivers do not cover ' + order.Island + ' yet.';
  return '';
}

function deliveryCovers(order, store) { return !deliveryCoverageError(order, store); }

/** Delivery jobs for one order, oldest first. */
function deliveryJobsFor(orderId) {
  return deliveryRows('DeliveryJobs').filter(function (j) { return j.OrderId === orderId; });
}

function activeDeliveryJob(orderId) {
  var list = deliveryJobsFor(orderId).filter(function (j) { return DELIVERY_JOB_ACTIVE.indexOf(String(j.Status)) !== -1; });
  return list.length ? list[list.length - 1] : null;
}

function deliveryMoney(v) { return roundMoney(Number(v) || 0); }

function deliveryOsmLink(lat, lng) {
  if (lat === '' || lng === '' || lat == null || lng == null) return '';
  return 'https://www.openstreetmap.org/?mlat=' + Number(lat).toFixed(5) + '&mlon=' + Number(lng).toFixed(5) + '#map=17/' + Number(lat).toFixed(5) + '/' + Number(lng).toFixed(5);
}

/* ==================== Drivers ==================== */

function findDriverByCustomer(customerId) {
  return deliveryRows('Drivers').filter(function (d) { return d.CustomerId === customerId; })[0] || null;
}

/** The signed-in customer as a driver: { customer, driver } or { error }. */
function resolveDriver(body) {
  var customer;
  try { customer = requireCustomerAuth(body && body.token); } catch (e) { return { error: e.message || 'Please sign in.', auth: true }; }
  return { customer: customer, driver: findDriverByCustomer(customer.CustomerId) };
}

/**
 * body: name, phone, vehicle, area, plus messenger, email, idType, idNumber,
 * idPhotoBase64, selfieBase64, faceResult, faceScore and contract
 * (DriverOnboarding.gs). One application per account.
 */
function actionDriverApply(body) {
  if (!deliveriesEnabled()) return fail('Driving for Mwakete is not open yet.');
  var who = resolveDriver(body);
  if (who.error) return txFail(who.error, { authRequired: who.auth });
  var name = txCleanText(body.name, 80), phone = txCleanText(body.phone, 30);
  if (name.length < 2) return fail('Enter your name.');
  if (!isCustomerPhoneValid(phone)) return fail('Local phone numbers must start with 730 or 630.');
  var vehicle = String(body.vehicle || '');
  if (!DRIVER_VEHICLES[vehicle]) return fail('Choose your vehicle.');
  var area = String(body.area || '');
  if (deliveryAreas().indexOf(area) === -1) return fail('Choose the island you will drive on.');
  // Messenger, email, one ID, the face check and the signed agreement
  // (DriverOnboarding.gs). All checked before anything is written.
  var docs = checkDriverOnboarding(body, who.customer);
  if (docs.error) return fail(docs.error);
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  var row;
  try {
    var sheet = driversSheetWithDocs();
    var existing = findDriverByCustomer(who.customer.CustomerId);
    if (existing && existing.Status !== 'rejected') return fail('You have already applied. Your status: ' + existing.Status + '.');
    if (existing) trashDriverFiles(existing);   // a fresh application replaces the old documents
    var now = nowIso();
    row = Object.assign({ DriverId: existing ? existing.DriverId : newId('drv'), CustomerId: who.customer.CustomerId, Name: name, Phone: phone,
      Vehicle: vehicle, Area: area, Status: 'pending', Available: '', ReviewedBy: '', ReviewedAt: '', ReviewNote: '', CreatedAt: now, UpdatedAt: now }, docs.fields);
    Object.assign(row, saveDriverDocs(row.DriverId, docs.files));
    if (existing) updateRowFromObject(sheet, existing.__row, row); else appendRowFromObject(sheet, row);
    appendAudit({ actorId: who.customer.CustomerId, actorRole: 'driver', action: 'DRIVER_APPLIED', entityType: 'driver', entityId: row.DriverId,
      next: 'contract ' + DRIVER_CONTRACT_VERSION + ' (' + row.ContractMethod + '), face ' + row.FaceResult });
  } finally {
    lock.releaseLock();
  }
  try {
    var admins = getAdminEmails();
    if (admins.length) sendAppEmail(admins.join(','), 'New driver application - ' + name, name + ' (' + DRIVER_VEHICLES[vehicle] + ', ' + area + ') applied to drive for Mwakete.\n\n' +
      'ID: ' + DRIVER_ID_TYPES[row.IdType] + '\nFace check: ' + DRIVER_FACE_RESULTS[row.FaceResult] + '\nAgreement: signed ' + (row.ContractMethod === 'digital' ? 'in the app' : 'on paper (photos)') +
      '\nMessenger (send the decision here): ' + row.Messenger + '\n\n' +
      (siteBaseUrl() ? 'Review it: ' + siteBaseUrl() + '/owner/admin.html#deliveries' : 'Review it in the admin page, Deliveries & drivers.'));
  } catch (e) { /* best effort */ }
  return ok({ status: 'pending' });
}

/** Driver home: own status, available jobs (approved + available only), own active and past jobs. */
function actionGetDriverHome(body) {
  var who = resolveDriver(body);
  if (who.error) return txFail(who.error, { authRequired: who.auth });
  var d = who.driver;
  var out = { enabled: deliveriesEnabled(), areas: deliveryAreas(), vehicles: DRIVER_VEHICLES, failReasons: DELIVERY_FAIL_REASONS,
    idTypes: DRIVER_ID_TYPES, contractVersion: DRIVER_CONTRACT_VERSION,
    driver: d ? { status: d.Status, name: d.Name, vehicle: d.Vehicle, area: d.Area, available: d.Available === 'yes', note: d.Status === 'rejected' || d.Status === 'suspended' ? d.ReviewNote : '' } : null,
    open: [], mine: [], history: [], earnings: { delivered: 0, fees: 0, feesPaid: 0 } };
  if (!d || d.Status !== 'approved') return ok(out);
  var orders = {};
  sheetToObjects(getSheet('Orders')).forEach(function (o) { orders[o.OrderId] = o; });
  var storeName = makeStoreNameResolver();
  deliveryRows('DeliveryJobs').forEach(function (j) {
    var o = orders[j.OrderId] || {};
    if (j.Status === 'open' && d.Available === 'yes' && islandKey(o.Island) === islandKey(d.Area)) {
      // Before accepting: where from and where to, by area only - no buyer details.
      out.open.push({ jobId: j.JobId, storeName: storeName(j.StoreSlug), dropoffArea: o.Village ? o.Village + ', ' + o.Island : o.Island,
        fee: deliveryMoney(j.Fee), items: txOrderItems(o).reduce(function (n, l) { return n + (Number(l.qty) || 0); }, 0), postedAt: j.CreatedAt, version: Number(j.Version) || 1 });
    } else if (j.DriverId === d.DriverId) {
      var view = driverJobView(j, o, storeName(j.StoreSlug));
      if (DELIVERY_JOB_ACTIVE.indexOf(String(j.Status)) !== -1) out.mine.push(view);
      else {
        out.history.push(view);
        if (j.Status === 'delivered') {
          out.earnings.delivered++;
          out.earnings.fees = deliveryMoney(out.earnings.fees + deliveryMoney(j.Fee));
          if (j.FeePaid === 'yes') out.earnings.feesPaid = deliveryMoney(out.earnings.feesPaid + deliveryMoney(j.Fee));
        }
      }
    }
  });
  out.wallet = driverWalletView(d);
  out.history.sort(function (a, b) { return String(b.updatedAt).localeCompare(String(a.updatedAt)); });
  out.history = out.history.slice(0, 30);
  return ok(out);
}

/** The assigned driver's view of their job: buyer contact only once it is theirs. */
function driverJobView(j, o, storeName) {
  var active = DELIVERY_JOB_ACTIVE.indexOf(String(j.Status)) !== -1;
  var owner = getOwnerBySlug(j.StoreSlug) || {};
  // Wallet jobs: the pickup place and the buyer's details are released only once
  // Mwakete has confirmed the seller's payment (driver wallet, phase 3).
  var held = active && deliveryFeeChatOn(j) && j.PayStatus !== 'received';
  var seeDetails = active && !held;
  return {
    jobId: j.JobId, orderId: j.OrderId, status: j.Status, statusLabel: DELIVERY_JOB_LABEL[j.Status] || j.Status, fee: deliveryMoney(j.Fee),
    feePaid: j.FeePaid === 'yes', storeName: storeName, storePhone: seeDetails ? (owner.Phone || '') : '',
    pickup: held ? '' : j.Pickup, dropoff: j.Dropoff, notes: held ? '' : j.Notes, sharing: j.Sharing === 'yes', version: Number(j.Version) || 1,
    detailsLocked: held,
    payLabel: DRIVER_PAY_LABEL[j.PayStatus] || '',
    buyerName: seeDetails ? o.CustomerName : '', buyerPhone: seeDetails ? o.CustomerPhone : '',
    items: seeDetails ? txOrderItems(o).map(function (l) { return l.qty + ' × ' + l.label; }) : [],
    mapSearch: 'https://www.openstreetmap.org/search?query=' + encodeURIComponent(String(j.Dropoff || '')),
    failReason: j.FailReason ? (DELIVERY_FAIL_REASONS[j.FailReason.split(':')[0]] || j.FailReason) : '', updatedAt: j.UpdatedAt,
    chat: deliveryChatView(j, 'driver')
  };
}

/** body.available: true/false. */
function actionDriverSetAvailable(body) {
  var who = resolveDriver(body);
  if (who.error) return txFail(who.error, { authRequired: who.auth });
  if (!who.driver || who.driver.Status !== 'approved') return fail('Only approved drivers can go online.');
  updateRowFromObject(driversSheet(), who.driver.__row, { Available: body.available === true ? 'yes' : '', UpdatedAt: nowIso() });
  return ok({ available: body.available === true });
}

/* ==================== Driver actions on a job ==================== */

/**
 * Runs a driver's write on one job under the lock: checks the session, that
 * the driver is approved, and (except for accept) that the job is theirs.
 * fn(ctx) gets { driver, customer, job, order, ordersSheet, state, actor,
 * queue, requestId }.
 */
function runDriverWrite(body, name, fn) {
  if (!deliveriesEnabled()) return fail('Deliveries are not switched on.');
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  var queue = [], result, order = null;
  try {
    var who = resolveDriver(body);
    if (who.error) return txFail(who.error, { authRequired: who.auth });
    if (!who.driver || who.driver.Status !== 'approved') return fail('Only approved drivers can do this.');
    var job = findRowById(deliveryJobsSheet(), 'JobId', String(body.jobId || ''));
    if (!job || (name !== 'accept' && job.DriverId !== who.driver.DriverId)) {
      if (job) appendAudit({ actorId: who.driver.DriverId, actorRole: 'driver', action: 'DRIVER_ACCESS_DENIED', entityType: 'delivery', entityId: job.JobId });
      return fail('Job not found');
    }
    if (body.version !== undefined && body.version !== '' && Number(body.version) !== Number(job.Version)) {
      return txFail('This job changed while you had it open. It has been refreshed.', { stale: true });
    }
    var ordersSheet = getSheet('Orders');
    order = findRowById(ordersSheet, 'OrderId', job.OrderId);
    var state = order ? findRowById(txSheet('TxState'), 'OrderId', order.OrderId) : null;
    if (!order || !state) return fail('Job not found');
    var ctx = { driver: who.driver, customer: who.customer, job: job, order: order, ordersSheet: ordersSheet, state: state,
      actor: { type: 'driver', id: who.driver.DriverId, email: '' }, queue: queue, requestId: cleanRequestId(body.requestId) };
    result = idempotentResult('dlv:' + name + ':' + who.driver.DriverId + ':' + job.JobId, body.requestId, function () { return fn(ctx); });
  } finally {
    lock.releaseLock();
  }
  if (result && result.ok && !result.replayed) {
    flushTxNotify(queue);
    if (order) txInvalidateBuyerLists(order);
  }
  return result;
}

function saveJob(job, fields) {
  var f = Object.assign({}, fields, { Version: (Number(job.Version) || 0) + 1, UpdatedAt: nowIso() });
  updateRowFromObject(deliveryJobsSheet(), job.__row, f);
  Object.keys(f).forEach(function (k) { job[k] = f[k]; });
}

/** Accept an open job in the driver's area. One driver wins; the rest see "taken". */
function actionDriverAcceptJob(body) {
  return runDriverWrite(body, 'accept', function (ctx) {
    if (ctx.driver.Available !== 'yes') return fail('Go online first.');
    if (ctx.job.Status !== 'open') return fail('Another driver has already taken this job.');
    if (islandKey(ctx.order.Island) !== islandKey(ctx.driver.Area)) return fail('This job is on another island.');
    var mine = deliveryRows('DeliveryJobs').filter(function (j) { return j.DriverId === ctx.driver.DriverId && ['accepted', 'picked_up'].indexOf(String(j.Status)) !== -1; });
    if (mine.length >= DRIVER_MAX_ACTIVE_JOBS) return fail('Finish one of your ' + mine.length + ' jobs before taking another.');
    saveJob(ctx.job, { Status: 'accepted', DriverId: ctx.driver.DriverId, AcceptedAt: nowIso() });
    appendTxEvent(ctx.state, { kind: 'fulfilment', actorType: 'driver', actorId: ctx.driver.DriverId,
      body: 'Driver ' + ctx.driver.Name + ' (' + (DRIVER_VEHICLES[ctx.driver.Vehicle] || 'driver') + ', ' + ctx.driver.Phone + ') accepted the delivery and will collect from the store.' });
    appendAudit({ actorId: ctx.driver.DriverId, actorRole: 'driver', action: 'DELIVERY_ACCEPTED', entityType: 'delivery', entityId: ctx.job.JobId, next: ctx.order.OrderId });
    queueTxNotify(ctx.queue, ctx.order, 'seller', 'driver_accepted', ctx.job.JobId, 'A driver accepted your delivery', 'Driver ' + ctx.driver.Name + ' accepted the delivery and will collect the goods.');
    queueTxNotify(ctx.queue, ctx.order, 'buyer', 'driver_accepted', ctx.job.JobId, 'A driver is booked for your order', 'A Mwakete driver will bring your order. You can follow it in the order room.');
    return ok({ status: 'accepted' });
  });
}

/**
 * act: 'picked_up' | 'delivered' | 'failed'. delivered needs a proof photo
 * (proofId from driverUploadProof) and the recipient's name; failed needs a
 * reason. Picked up IS the order's dispatch record; delivered is the driver's
 * report - the buyer still confirms receipt.
 */
function actionDriverUpdateJob(body) {
  return runDriverWrite(body, 'update:' + String(body.act || ''), function (ctx) {
    var act = String(body.act || '');
    var j = ctx.job;
    var note = txCleanText(body.note, 300);
    if (act === 'picked_up') {
      if (j.Status !== 'accepted') return fail('This job is not waiting for pickup.');
      if (txIsFinal(ctx.order)) return fail('This order was cancelled. Please do not collect it.');
      if (deliveryFeeChatOn(j) && j.FeeLocked !== 'yes') return fail('Agree the delivery fee with the seller first (open the job chat).');
      if (deliveryFeeChatOn(j) && j.PayStatus !== 'received') return fail('Mwakete has not confirmed the seller\'s payment yet, so the goods cannot be collected.');
      var f = String(ctx.state.FulfilmentState || '');
      if (['preparing', 'ready_dispatch'].indexOf(f) === -1) return fail('The seller has not got this order ready yet.');
      var stock = txMarkStockSold(ctx);
      if (!stock.ok) return stock;
      var today = headerAdToday();
      var rec = appendTxRecord(ctx.order.OrderId, { type: 'dispatch', actorType: 'driver', actorId: ctx.driver.DriverId, result: 'dispatched',
        data: { date: today, method: 'Mwakete driver', provider: ctx.driver.Name, tracking: j.JobId, notes: note, sentBeforePayment: ctx.state.PaymentState !== 'verified' },
        requestId: ctx.requestId });
      saveTxState(ctx.state, { FulfilmentState: 'dispatched' });
      saveJob(j, { Status: 'picked_up', PickedUpAt: nowIso() });
      appendTxEvent(ctx.state, { kind: 'fulfilment', actorType: 'driver', actorId: ctx.driver.DriverId,
        body: 'Driver collected the goods from the store and is on the way' + (note ? ': ' + note : '') + '.', data: { recordId: rec.RecordId } });
      appendTxEvent(ctx.state, { kind: 'system', actorType: 'system', audience: 'buyer', body: txConfig()['prompt.receipt'] });
      appendAudit({ actorId: ctx.driver.DriverId, actorRole: 'driver', action: 'DELIVERY_PICKED_UP', entityType: 'delivery', entityId: j.JobId, next: ctx.order.OrderId });
      queueTxNotify(ctx.queue, ctx.order, 'buyer', 'driver_picked', j.JobId, 'Your order is on its way', 'The driver has collected your order and is on the way.');
      queueTxNotify(ctx.queue, ctx.order, 'seller', 'driver_picked', j.JobId, 'The driver collected your goods', 'The driver collected the goods for this order.');
      return ok({ status: 'picked_up' });
    }
    if (act === 'delivered') {
      if (j.Status !== 'picked_up') return fail('Record pickup first.');
      var recipient = txCleanText(body.recipientName, 80);
      if (recipient.length < 2) return fail('Enter the name of the person who received it.');
      var proof = deliveryOwnProof(ctx, body.proofId);
      if (!proof) return txFail('Add a photo of the delivered goods first.', { requirement: 'delivery.photo' });
      var rec2 = appendTxRecord(ctx.order.OrderId, { type: 'delivered', actorType: 'driver', actorId: ctx.driver.DriverId, result: 'driver_reported',
        reason: note, data: { recipient: recipient, jobId: j.JobId }, evidenceIds: [proof.EvidenceId], requestId: ctx.requestId });
      if (String(ctx.state.FulfilmentState) === 'dispatched') saveTxState(ctx.state, { FulfilmentState: 'delivered' });
      saveJob(j, { Status: 'delivered', DeliveredAt: nowIso(), ClosedAt: nowIso(), Sharing: '', LastLat: '', LastLng: '', LastAccuracy: '', LastLocAt: '' });
      appendTxEvent(ctx.state, { kind: 'fulfilment', actorType: 'driver', actorId: ctx.driver.DriverId, evidenceIds: [proof.EvidenceId],
        body: 'Driver reports the order was delivered to ' + recipient + (note ? ' (' + note + ')' : '') + '. This is the driver\'s record - the buyer is asked to confirm receipt.',
        data: { recordId: rec2.RecordId } });
      appendAudit({ actorId: ctx.driver.DriverId, actorRole: 'driver', action: 'DELIVERY_DELIVERED', entityType: 'delivery', entityId: j.JobId, next: ctx.order.OrderId });
      queueTxNotify(ctx.queue, ctx.order, 'buyer', 'driver_delivered', j.JobId, 'Has your order arrived?', 'The driver reports your order was delivered. Please confirm receipt, or report a problem.');
      queueTxNotify(ctx.queue, ctx.order, 'seller', 'driver_delivered', j.JobId, 'Your delivery was completed by the driver', 'The driver reports the order was delivered. Remember to pay the driver the agreed fee and mark it paid in the order room.');
      return ok({ status: 'delivered' });
    }
    if (act === 'failed') {
      if (['accepted', 'picked_up'].indexOf(String(j.Status)) === -1) return fail('This job is not active.');
      var reason = String(body.reason || '');
      if (!DELIVERY_FAIL_REASONS[reason]) return fail('Choose what went wrong.');
      if (note.length < 5) return fail('Add a short note about what happened.');
      var hadGoods = j.Status === 'picked_up';
      var afterPickup = hadGoods ? deliveryFailedAfterPickup(j, reason) : deliveryRefundPatch(j);
      saveJob(j, Object.assign({ Status: 'failed', FailReason: reason + ': ' + note, ClosedAt: nowIso(), Sharing: '', LastLat: '', LastLng: '', LastAccuracy: '', LastLocAt: '' },
        afterPickup || {}));
      if (hadGoods && afterPickup === null) deliveryCreditJob(j, 'failed delivery: ' + DELIVERY_FAIL_REASONS[reason]);
      appendTxEvent(ctx.state, { kind: 'fulfilment', actorType: 'driver', actorId: ctx.driver.DriverId,
        body: 'Delivery failed - ' + DELIVERY_FAIL_REASONS[reason] + ': ' + note + (hadGoods ? ' The driver will bring the goods back to the store.' : ' The goods were not collected.') });
      appendAudit({ actorId: ctx.driver.DriverId, actorRole: 'driver', action: 'DELIVERY_FAILED', entityType: 'delivery', entityId: j.JobId, next: reason, reason: note });
      queueTxNotify(ctx.queue, ctx.order, 'seller', 'driver_failed', j.JobId, 'A delivery failed', 'The driver could not complete this delivery: ' + DELIVERY_FAIL_REASONS[reason] + '. Please check the order room.');
      queueTxNotify(ctx.queue, ctx.order, 'buyer', 'driver_failed', j.JobId, 'Your delivery could not be completed', 'The driver could not deliver your order. The seller has been told; please check the order room.');
      return ok({ status: 'failed' });
    }
    return fail('Unknown action.');
  });
}

/** The driver's own proof photo for this job's order, not removed. */
function deliveryOwnProof(ctx, id) {
  if (!id) return null;
  return deliveryRows('TxEvidence').filter(function (e) {
    return e.EvidenceId === String(id) && e.OrderId === ctx.order.OrderId && e.SubmitterType === 'driver' && e.SubmitterId === ctx.driver.DriverId && !e.DeletedAt;
  })[0] || null;
}

/** body: jobId, dataBase64, mimeType, thumbBase64. A photo stored privately with the order's evidence. */
function actionDriverUploadProof(body) {
  var cfg = txConfig();
  var checked = validateTxFile(body && body.dataBase64, body && body.mimeType, cfg);
  if (checked.error) return fail(checked.error);
  if (checked.sniff.type === 'application/pdf') return fail('Add a photo of the delivered goods.');
  var thumb = null;
  if (body.thumbBase64) {
    var t = validateTxFile(body.thumbBase64, '', cfg);
    if (!t.error && t.bytes.length <= 300 * 1024 && t.sniff.type !== 'application/pdf' && t.sniff.width <= 800 && t.sniff.height <= 800) thumb = t;
  }
  return runDriverWrite(body, 'proof', function (ctx) {
    if (['picked_up', 'accepted'].indexOf(String(ctx.job.Status)) === -1) return fail('This job is not active.');
    if (rateLimitHit('ratelimit:dlv:upload:' + ctx.driver.DriverId, 15, 600)) return txFail('Too many photos in a short time - please wait.', { rateLimited: true });
    var dup = deliveryRows('TxEvidence').filter(function (e) { return e.OrderId === ctx.order.OrderId && e.Sha256 === checked.sha && e.SubmitterId === ctx.driver.DriverId && !e.DeletedAt; })[0];
    if (dup) return ok({ proofId: dup.EvidenceId, duplicate: true });
    var evidenceId = newId('txf');
    var folder = getTxEvidenceFolder();
    var file = folder.createFile(Utilities.newBlob(checked.bytes, checked.sniff.type, evidenceId + txExtension(checked.sniff.type)));
    var thumbFile = thumb ? folder.createFile(Utilities.newBlob(thumb.bytes, thumb.sniff.type, evidenceId + '_thumb' + txExtension(thumb.sniff.type))) : null;
    var ev = appendTxEvent(ctx.state, { kind: 'evidence', actorType: 'driver', actorId: ctx.driver.DriverId, body: 'Delivery photo', evidenceIds: [evidenceId], data: { category: 'delivery' } });
    appendRowFromObject(txSheet('TxEvidence'), {
      EvidenceId: evidenceId, OrderId: ctx.order.OrderId, EventId: ev.EventId, SubmitterType: 'driver', SubmitterId: ctx.driver.DriverId, Category: 'delivery',
      Stage: 'delivery', FileId: file.getId(), ThumbFileId: thumbFile ? thumbFile.getId() : '', DisplayName: 'delivery' + txExtension(checked.sniff.type),
      MimeType: checked.sniff.type, SizeBytes: checked.bytes.length, Width: checked.sniff.width, Height: checked.sniff.height, Sha256: checked.sha,
      Description: 'Proof of delivery', ReviewStatus: '', ReviewedBy: '', ReviewedAt: '', ReviewNote: '', Retention: 'kept', DeletedAt: '', DeletedReason: '',
      RequestId: ctx.requestId, CreatedAt: nowIso()
    });
    return ok({ proofId: evidenceId });
  });
}

/**
 * Live location, opt-in. body: jobId, share (true to turn on / keep sending,
 * false to stop), lat, lng, accuracy. Kept: the last point only.
 */
function actionDriverShareLocation(body) {
  return runDriverWrite(body, 'loc:' + Date.now(), function (ctx) {
    var j = ctx.job;
    if (['accepted', 'picked_up'].indexOf(String(j.Status)) === -1) return fail('Location is only shared during an active job.');
    if (body.share !== true) {
      saveJob(j, { Sharing: '', LastLat: '', LastLng: '', LastAccuracy: '', LastLocAt: '' });
      return ok({ sharing: false });
    }
    var lat = Number(body.lat), lng = Number(body.lng), acc = Math.round(Number(body.accuracy) || 0);
    if (!isFinite(lat) || !isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) return fail('That location could not be read.');
    var last = new Date(j.LastLocAt).getTime();
    if (j.Sharing === 'yes' && last && Date.now() - last < 25000) return ok({ sharing: true, throttled: true });
    var fields = { Sharing: 'yes', LastLat: lat.toFixed(5), LastLng: lng.toFixed(5), LastAccuracy: acc, LastLocAt: nowIso() };
    // Location updates do not bump the job Version (they are not state changes).
    updateRowFromObject(deliveryJobsSheet(), j.__row, fields);
    return ok({ sharing: true });
  });
}

/* ==================== Seller and room ==================== */

/**
 * Seller books a driver from the order room. body: fee, pickup, notes.
 * Allowed for a delivery order on a covered island, once the goods are
 * checked, while no other driver job is active.
 */
function actionTxRequestDriver(body) {
  if (!deliveriesEnabled()) return fail('Mwakete drivers are not available yet.');
  return runTxWrite(body, 'requestDriver', function (ctx) {
    var deny = txRoleOnly(ctx, ['seller']) || txV1Only(ctx);
    if (deny) return deny;
    if (txIsFinal(ctx.order)) return txFail('This order is cancelled.');
    if (txIsCollection(ctx.order)) return txFail('This is a collection order.');
    var coverErr = deliveryCoverageError(ctx.order);
    if (coverErr) return txFail(coverErr);
    var f = String(ctx.state.FulfilmentState || '');
    if (['preparing', 'ready_dispatch'].indexOf(f) === -1) return txFail(f === '' ? 'Check the goods against the order first.' : 'This order has already been sent.');
    if (activeDeliveryJob(ctx.order.OrderId)) return txFail('A driver job is already open for this order.');
    var fee = Number(body.fee);
    if (!isFinite(fee) || fee < 0 || fee > 500) return txFail('Enter the fee you will pay the driver (0 to 500).');
    var pickup = txCleanText(body.pickup, 300);
    if (pickup.length < 5) return txFail('Tell the driver where to collect the goods.');
    var job = { JobId: newId('dlv'), OrderId: ctx.order.OrderId, OwnerId: ctx.order.OwnerId, StoreSlug: ctx.order.StoreSlug, Status: 'open', DriverId: '',
      Fee: deliveryMoney(fee), FeeProposedBy: 'seller', FeeSellerOk: 'yes', Pickup: pickup, Dropoff: [ctx.order.Village, ctx.order.Island].filter(Boolean).join(', '), Notes: txCleanText(body.notes, 300),
      FeePaid: '', FailReason: '', Sharing: '', LastLat: '', LastLng: '', LastAccuracy: '', LastLocAt: '', Version: 1, CreatedAt: nowIso(),
      AcceptedAt: '', PickedUpAt: '', DeliveredAt: '', ClosedAt: '', UpdatedAt: nowIso() };
    appendRowFromObject(deliveryJobsSheet(), job);
    appendTxEvent(ctx.state, { kind: 'fulfilment', actorType: 'seller', actorId: ctx.actor.id,
      body: 'Seller booked a Mwakete driver (fee ' + orderMoney(job.Fee) + ', paid by the seller). Waiting for a driver to accept.' });
    appendTxEvent(ctx.state, { kind: 'system', actorType: 'system', audience: 'buyer',
      body: 'A Mwakete driver will deliver this order. When a driver accepts, they will see your name, phone and village so they can find you.' });
    txAudit(ctx.actor, 'DELIVERY_REQUESTED', ctx.order.OrderId, '', job.JobId, '', ctx.requestId);
    notifyDriversOfJob(ctx.order);
    return ok({ jobId: job.JobId });
  });
}

/** Approved, online drivers in the order's area get one short email (throttled). */
function notifyDriversOfJob(order) {
  try {
    var cache = CacheService.getScriptCache();
    deliveryRows('Drivers').filter(function (d) { return d.Status === 'approved' && d.Available === 'yes' && islandKey(d.Area) === islandKey(order.Island) && d.Email; })
      .slice(0, 20).forEach(function (d) {
        var key = 'v1:dlv:notify:' + d.DriverId;
        if (cache.get(key)) return;
        cache.put(key, '1', 900);
        sendAppEmail(d.Email, 'New delivery job on Mwakete', 'There is a new delivery job in ' + order.Island + '.\n\n' +
          (siteBaseUrl() ? 'See it: ' + siteBaseUrl() + '/driver.html' : 'Open the driver page on Mwakete to see it.'));
      });
  } catch (e) { /* best effort */ }
}

/** Seller (before pickup) or admin cancels the active job. body: reason. */
function actionTxCancelDriverJob(body) {
  return runTxWrite(body, 'cancelDriverJob', function (ctx) {
    var deny = txRoleOnly(ctx, ['seller', 'admin']);
    if (deny) return deny;
    var j = activeDeliveryJob(ctx.order.OrderId);
    if (!j) return txFail('There is no active driver job.');
    if (j.Status === 'picked_up' && ctx.actor.type !== 'admin') return txFail('The driver already has the goods - ask them to report the delivery, or contact Mwakete.');
    var reason = txCleanText(body.reason, 300);
    if (reason.length < 5) return txFail('Say why the driver job is cancelled.');
    var row = findRowById(deliveryJobsSheet(), 'JobId', j.JobId);
    saveJob(row, Object.assign({ Status: 'cancelled', ClosedAt: nowIso(), FailReason: 'cancelled: ' + reason, Sharing: '', LastLat: '', LastLng: '', LastAccuracy: '', LastLocAt: '' },
      deliveryRefundPatch(row)));
    appendTxEvent(ctx.state, { kind: 'fulfilment', actorType: ctx.actor.type, actorId: ctx.actor.id, body: 'Driver job cancelled: ' + reason });
    txAudit(ctx.actor, 'DELIVERY_CANCELLED', ctx.order.OrderId, j.Status, 'cancelled', reason, ctx.requestId);
    return ok({ status: 'cancelled' });
  });
}

/** Seller records that they paid the driver the agreed fee. */
function actionTxMarkDriverPaid(body) {
  return runTxWrite(body, 'markDriverPaid', function (ctx) {
    var deny = txRoleOnly(ctx, ['seller']);
    if (deny) return deny;
    var jobs = deliveryJobsFor(ctx.order.OrderId).filter(function (x) { return x.Status === 'delivered' && x.FeePaid !== 'yes'; });
    if (!jobs.length) return txFail('There is no unpaid delivered job on this order.');
    if (body.confirmPaid !== true) return txFail('Only mark it paid after you have actually paid the driver.');
    var row = findRowById(deliveryJobsSheet(), 'JobId', jobs[0].JobId);
    saveJob(row, { FeePaid: 'yes' });
    appendTxEvent(ctx.state, { kind: 'fulfilment', actorType: 'seller', actorId: ctx.actor.id, audience: 'seller', body: 'You recorded paying the driver ' + orderMoney(row.Fee) + '.' });
    txAudit(ctx.actor, 'DELIVERY_FEE_PAID', ctx.order.OrderId, '', row.JobId, '', ctx.requestId);
    return ok({ feePaid: true });
  });
}

/**
 * What the order room shows about delivery. Called from actionGetTxRoom.
 * Driver name + phone once a driver accepts; location only while shared.
 */
function deliveryRoomView(order, state, viewer) {
  if (!deliveriesEnabled()) return null;
  var jobs = deliveryJobsFor(order.OrderId);
  var j = jobs.length ? jobs[jobs.length - 1] : null;
  var f = String(state.FulfilmentState || '');
  var canRequest = viewer === 'seller' && state.Flow === 'v1' && !txIsFinal(order) && !txIsCollection(order) && deliveryCovers(order)
    && ['preparing', 'ready_dispatch'].indexOf(f) !== -1 && !(j && DELIVERY_JOB_ACTIVE.indexOf(String(j.Status)) !== -1);
  if (!j) return { available: canRequest, canRequest: canRequest, areas: deliveryAreas(), island: order.Island,
    why: viewer === 'seller' && !canRequest ? deliveryCoverageError(order) : '' };
  var drv = j.DriverId ? deliveryRows('Drivers').filter(function (d) { return d.DriverId === j.DriverId; })[0] : null;
  var live = j.Sharing === 'yes' && DELIVERY_JOB_ACTIVE.indexOf(String(j.Status)) !== -1;
  return {
    available: true, canRequest: canRequest, jobId: j.JobId, status: j.Status, statusLabel: DELIVERY_JOB_LABEL[j.Status] || j.Status,
    fee: viewer === 'buyer' ? undefined : deliveryMoney(j.Fee), feePaid: viewer === 'buyer' ? undefined : j.FeePaid === 'yes',
    driverName: drv ? drv.Name : '', driverPhone: drv && DELIVERY_JOB_ACTIVE.indexOf(String(j.Status)) !== -1 ? drv.Phone : '',
    vehicle: drv ? DRIVER_VEHICLES[drv.Vehicle] || '' : '',
    location: live && j.LastLat !== '' ? { link: deliveryOsmLink(j.LastLat, j.LastLng), at: j.LastLocAt, accuracy: Number(j.LastAccuracy) || 0 } : null,
    canCancel: (viewer === 'seller' && ['open', 'accepted'].indexOf(String(j.Status)) !== -1) || (viewer === 'admin' && DELIVERY_JOB_ACTIVE.indexOf(String(j.Status)) !== -1),
    // A wallet job is paid through Mwakete, so there is no "I paid the driver" step.
    canMarkPaid: viewer === 'seller' && j.Status === 'delivered' && j.FeePaid !== 'yes' && !j.PayStatus,
    paidThroughMwakete: !!j.PayStatus,
    failReason: j.Status === 'failed' ? (DELIVERY_FAIL_REASONS[String(j.FailReason).split(':')[0]] || '') : '',
    chat: viewer === 'buyer' ? null : deliveryChatView(j, viewer)
  };
}

/* ==================== Admin ==================== */

function actionAdminListDeliveries(owner, body) {
  if (!isOwnerAdmin(owner)) return denyAdmin(owner, 'adminListDeliveries');
  var now = Date.now();
  var storeName = makeStoreNameResolver();
  var drivers = deliveryRows('Drivers');
  var byId = {};
  drivers.forEach(function (d) { byId[d.DriverId] = d; });
  var want = String((body && body.status) || 'active');
  var jobs = deliveryRows('DeliveryJobs').filter(function (j) {
    if (want === 'all') return true;
    if (want === 'active') return DELIVERY_JOB_ACTIVE.indexOf(String(j.Status)) !== -1;
    if (want === 'problems') return j.Status === 'failed' || deliveryStuck(j, now);
    if (want === 'payments') return j.PayStatus === 'submitted' || j.PayStatus === 'refund_due' || j.PayStatus === 'review';
    return j.Status === want;
  }).sort(function (a, b) { return String(b.UpdatedAt).localeCompare(String(a.UpdatedAt)); }).slice(0, 200);
  var all = deliveryRows('DeliveryJobs');
  return ok({
    enabled: deliveriesEnabled(), areas: deliveryAreas(), allIslands: deliveryAllIslands(),
    counts: {
      open: all.filter(function (j) { return j.Status === 'open'; }).length,
      active: all.filter(function (j) { return ['accepted', 'picked_up'].indexOf(String(j.Status)) !== -1; }).length,
      delivered: all.filter(function (j) { return j.Status === 'delivered'; }).length,
      failed: all.filter(function (j) { return j.Status === 'failed'; }).length,
      stuck: all.filter(function (j) { return deliveryStuck(j, now); }).length,
      driversOnline: drivers.filter(function (d) { return d.Status === 'approved' && d.Available === 'yes'; }).length,
      driversPending: drivers.filter(function (d) { return d.Status === 'pending'; }).length,
      paymentsToCheck: all.filter(function (j) { return j.PayStatus === 'submitted'; }).length,
      refundsDue: all.filter(function (j) { return j.PayStatus === 'refund_due'; }).length,
      toDecide: all.filter(function (j) { return j.PayStatus === 'review'; }).length
    },
    bankDetailsSet: !!deliveryBankDetails(),
    jobs: jobs.map(function (j) {
      var d = byId[j.DriverId] || null;
      return { jobId: j.JobId, orderId: j.OrderId, storeName: storeName(j.StoreSlug), status: j.Status, statusLabel: DELIVERY_JOB_LABEL[j.Status] || j.Status,
        driverName: d ? d.Name : '', driverPhone: d ? d.Phone : '', fee: deliveryMoney(j.Fee), feePaid: j.FeePaid === 'yes', dropoff: j.Dropoff,
        stuck: deliveryStuck(j, now), failReason: j.FailReason,
        payStatus: j.PayStatus || '', payLabel: DELIVERY_PAY_LABEL[j.PayStatus] || '', payRef: j.PayRef || '', payBankRef: j.PayBankRef || '',
        payAmount: j.PayAmount === '' || j.PayAmount == null ? null : deliveryMoney(j.PayAmount), payNote: j.PayNote || '', createdAt: j.CreatedAt, updatedAt: j.UpdatedAt,
        location: j.Sharing === 'yes' && j.LastLat !== '' ? { link: deliveryOsmLink(j.LastLat, j.LastLng), at: j.LastLocAt } : null };
    }),
    drivers: drivers.sort(function (a, b) { return (a.Status === 'pending' ? 0 : 1) - (b.Status === 'pending' ? 0 : 1) || String(b.CreatedAt).localeCompare(String(a.CreatedAt)); })
      .map(function (d) {
        return { driverId: d.DriverId, name: d.Name, phone: d.Phone, email: d.Email, vehicle: DRIVER_VEHICLES[d.Vehicle] || d.Vehicle, area: d.Area,
          status: d.Status, online: d.Available === 'yes', note: d.ReviewNote, createdAt: d.CreatedAt, docs: driverDocsSummary(d),
          delivered: all.filter(function (j) { return j.DriverId === d.DriverId && j.Status === 'delivered'; }).length,
          failed: all.filter(function (j) { return j.DriverId === d.DriverId && j.Status === 'failed'; }).length };
      })
  });
}

/** Open > 6h with no driver, or accepted > 6h and not collected, or picked up > 24h. */
function deliveryStuck(j, now) {
  var age = function (t) { var x = new Date(t).getTime(); return isNaN(x) ? 0 : now - x; };
  if (j.Status === 'open') return age(j.CreatedAt) > 6 * 3600000;
  if (j.Status === 'accepted') return age(j.AcceptedAt) > 6 * 3600000;
  if (j.Status === 'picked_up') return age(j.PickedUpAt) > 24 * 3600000;
  return false;
}

/** body: driverId, status ('approved'|'rejected'|'suspended'), reason. */
function actionAdminSetDriverStatus(owner, body) {
  if (!isOwnerAdmin(owner)) return denyAdmin(owner, 'adminSetDriverStatus');
  var status = String(body.status || '');
  if (['approved', 'rejected', 'suspended'].indexOf(status) === -1) return fail('Choose approve, reject or suspend.');
  var reason = txCleanText(body.reason, 300);
  if (status !== 'approved' && reason.length < 5) return fail('Give the reason (the driver sees it).');
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var row = findRowById(driversSheet(), 'DriverId', String(body.driverId || ''));
    if (!row) return fail('Driver not found');
    if (normalizeEmail(row.Email) === normalizeEmail(owner.Email)) return fail('You cannot approve your own driver application.');
    var prev = row.Status;
    updateRowFromObject(driversSheet(), row.__row, { Status: status, Available: status === 'approved' ? row.Available : '', ReviewedBy: owner.OwnerId,
      ReviewedAt: nowIso(), ReviewNote: reason, UpdatedAt: nowIso() });
    appendAudit({ actorId: owner.OwnerId, actorRole: 'admin', action: 'DRIVER_' + status.toUpperCase(), entityType: 'driver', entityId: row.DriverId, previous: prev, next: status, reason: reason });
    try {
      if (row.Email) sendAppEmail(row.Email, 'Your Mwakete driver application', status === 'approved'
        ? 'You are approved to drive for Mwakete. Open the driver page and go online to see jobs.' + (siteBaseUrl() ? '\n' + siteBaseUrl() + '/driver.html' : '')
        : 'Your driver status is now: ' + status + '. Reason: ' + reason);
    } catch (e) { /* best effort */ }
    return ok({ status: status });
  } finally {
    lock.releaseLock();
  }
}


/* ==================== Job chat and fee agreement (driver wallet, phase 2) ====================
 *
 * A private chat between the seller and the driver of one job, and a two-step
 * fee agreement. The buyer never sees either. Both exist only for drivers the
 * wallet covers (DELIVERY_PAYMENTS, DriverWallet.gs); for everyone else the
 * job works exactly as before.
 *
 * The seller's booking fee is the first offer (the seller has agreed to it).
 * Either side can propose a new fee while the job is accepted and the fee is
 * not locked; that resets the other side's agreement. The other side agrees
 * to the exact amount they see (a stale amount is refused). When both have
 * agreed the fee LOCKS and cannot change. The driver cannot collect the goods
 * until it is locked.
 */

var DELIVERY_CHAT_MAX_FEE = 500;

function deliveryJobDriver(job) {
  if (!job || !job.DriverId) return null;
  return deliveryRows('Drivers').filter(function (d) { return d.DriverId === job.DriverId; })[0] || null;
}

/**
 * True when this job uses chat, fee agreement and payment through Mwakete:
 * deliveries on, and either the wallet switch covers the driver OR the job is
 * already in the wallet flow (it has a PayStatus). Turning DELIVERY_PAYMENTS
 * off stops NEW wallet jobs but never lets a job that Mwakete holds money for
 * skip its payment checks, and never strands a driver's earned balance.
 */
function deliveryFeeChatOn(job) {
  if (!deliveriesEnabled() || typeof walletEnabledForDriver !== 'function') return false;
  var d = deliveryJobDriver(job);
  if (!d) return false;
  return walletEnabledForDriver(d) || !!job.PayStatus;
}

/** A driver may use the wallet screens while the switch covers them, and always while they have anything in the ledger. */
function driverWalletOpen(driver) {
  return !!driver && (walletEnabledForDriver(driver) || walletEntries(driver.DriverId).length > 0);
}

function deliveryChatMessages(jobId) {
  var s = SpreadsheetApp.getActive().getSheetByName('DeliveryMessages');
  if (!s) return [];
  return sheetToObjects(s).filter(function (m) { return m.JobId === jobId; });
}

function deliveryChatPost(job, senderType, senderId, text, requestId) {
  appendRowFromObject(deliveryMessagesSheet(), { MessageId: newId('dmg'), JobId: job.JobId, SenderType: senderType, SenderId: senderId || '',
    Body: txCleanText(text, 1000), RequestId: requestId || '', CreatedAt: nowIso() });
}

/** The chat panel for one side ('seller' | 'driver' | 'admin'), or null when the job does not use it. */
function deliveryChatView(job, viewer) {
  if (!deliveryFeeChatOn(job)) return null;
  var status = String(job.Status);
  var live = status === 'accepted';
  var locked = job.FeeLocked === 'yes';
  var me = viewer === 'driver' ? 'driver' : 'seller';
  var other = me === 'driver' ? 'seller' : 'driver';
  var meOk = job[me === 'driver' ? 'FeeDriverOk' : 'FeeSellerOk'] === 'yes';
  var msgs = deliveryChatMessages(job.JobId).slice(-100).map(function (m) {
    return { id: m.MessageId, by: m.SenderType, mine: m.SenderType === me, body: m.Body, at: m.CreatedAt };
  });
  return {
    payment: deliveryPaymentView(job, viewer),
    messages: msgs,
    canWrite: viewer !== 'admin' && (status === 'accepted' || status === 'picked_up'),
    fee: { amount: deliveryMoney(job.Fee), locked: locked, proposedBy: job.FeeProposedBy || '', agreedByMe: meOk,
      agreedByOther: job[other === 'driver' ? 'FeeDriverOk' : 'FeeSellerOk'] === 'yes',
      canPropose: viewer !== 'admin' && live && !locked,
      canAgree: viewer !== 'admin' && live && !locked && !meOk && job.FeeProposedBy === other }
  };
}

function deliveryChatNotify(job, toType, subject, text) {
  try {
    var cache = CacheService.getScriptCache();
    var key = 'v1:dlv:chat:' + job.JobId + ':' + toType;
    if (cache.get(key)) return;
    cache.put(key, '1', 600);
    var email = '', link = '';
    if (toType === 'driver') {
      var d = deliveryJobDriver(job);
      email = d && d.Email;
      link = siteBaseUrl() ? siteBaseUrl() + '/driver.html' : '';
    } else {
      var o = findRowById(getSheet('Owners'), 'OwnerId', job.OwnerId);
      email = o && o.Email;
      link = siteBaseUrl() ? siteBaseUrl() + '/order-room.html?order=' + encodeURIComponent(job.OrderId) + '&as=seller' : '';
    }
    if (email) sendAppEmail(email, subject, text + (link ? '\n\nOpen it: ' + link : ''));
  } catch (e) { /* best effort */ }
}

/** Common checks. side: 'seller' | 'driver'. Returns an error result or null. */
function deliveryChatGuard(job, side, needAccepted) {
  if (!deliveryFeeChatOn(job)) return fail('Job chat is not switched on for this delivery.');
  var st = String(job.Status);
  if (needAccepted ? st !== 'accepted' : ['accepted', 'picked_up'].indexOf(st) === -1) {
    return fail(needAccepted ? 'The fee can only be changed before the driver collects the goods.' : 'This chat is closed.');
  }
  return null;
}

function deliverySendMessage(job, side, senderId, body, requestId) {
  var bad = deliveryChatGuard(job, side, false);
  if (bad) return bad;
  var text = txCleanText(body && body.text, 1000);
  if (!text) return fail('Write a message first.');
  if (rateLimitHit('ratelimit:dlvchat:' + job.JobId + ':' + side, 20, 60)) return fail('You are sending messages too fast - please wait a moment.');
  deliveryChatPost(job, side, senderId, text, requestId);
  deliveryChatNotify(job, side === 'driver' ? 'seller' : 'driver', 'New message about a delivery', (side === 'driver' ? 'The driver' : 'The seller') + ' sent you a message about a delivery.');
  return ok({});
}

function deliveryProposeFee(job, side, senderId, body) {
  var bad = deliveryChatGuard(job, side, true);
  if (bad) return bad;
  if (job.FeeLocked === 'yes') return fail('The fee is agreed and locked.');
  var fee = Number(body && body.fee);
  if (!isFinite(fee) || fee <= 0 || fee > DELIVERY_CHAT_MAX_FEE) return fail('Enter a fee above 0 and up to ' + DELIVERY_CHAT_MAX_FEE + '.');
  fee = deliveryMoney(fee);
  saveJob(job, { Fee: fee, FeeProposedBy: side, FeeSellerOk: side === 'seller' ? 'yes' : '', FeeDriverOk: side === 'driver' ? 'yes' : '' });
  deliveryChatPost(job, 'system', '', (side === 'driver' ? 'The driver' : 'The seller') + ' proposed a fee of ' + orderMoney(fee) + '. The other side needs to agree.');
  deliveryChatNotify(job, side === 'driver' ? 'seller' : 'driver', 'A delivery fee was proposed', (side === 'driver' ? 'The driver' : 'The seller') + ' proposed a fee of ' + orderMoney(fee) + '.');
  return ok({ fee: fee });
}

function deliveryAgreeFee(job, side, senderId, body) {
  var bad = deliveryChatGuard(job, side, true);
  if (bad) return bad;
  if (job.FeeLocked === 'yes') return fail('The fee is already agreed and locked.');
  if (job.FeeProposedBy === side) return fail('You proposed this fee. The other side needs to agree to it.');
  if (deliveryMoney(body && body.fee) !== deliveryMoney(job.Fee)) return txFail('The fee changed. Please check the new amount.', { stale: true });
  var patch = side === 'driver' ? { FeeDriverOk: 'yes' } : { FeeSellerOk: 'yes' };
  var both = (side === 'driver' ? job.FeeSellerOk : job.FeeDriverOk) === 'yes';
  if (both) { patch.FeeLocked = 'yes'; patch.PayStatus = 'awaiting'; patch.PayRef = deliveryPayRef(job); }
  saveJob(job, patch);
  deliveryChatPost(job, 'system', '', (side === 'driver' ? 'The driver' : 'The seller') + ' agreed to ' + orderMoney(job.Fee) + '.' +
    (both ? ' The fee is agreed and locked. The seller now pays ' + orderMoney(job.Fee) + ' to Mwakete. The driver collects once Mwakete confirms it.' : ''));
  deliveryChatNotify(job, side === 'driver' ? 'seller' : 'driver', both ? 'The delivery fee is agreed' : 'A delivery fee was agreed',
    (side === 'driver' ? 'The driver' : 'The seller') + ' agreed to ' + orderMoney(job.Fee) + '.' + (both ? ' The fee is locked.' : ''));
  appendAudit({ actorId: senderId, actorRole: side, action: both ? 'DELIVERY_FEE_LOCKED' : 'DELIVERY_FEE_AGREED', entityType: 'delivery', entityId: job.JobId, next: String(job.Fee) });
  return ok({ locked: both });
}

/* Seller side: through the order room's own checks (runTxWrite). */
function deliverySellerJob(ctx) {
  var deny = txRoleOnly(ctx, ['seller']);
  if (deny) return { error: deny };
  var job = activeDeliveryJob(ctx.order.OrderId);
  if (!job) return { error: txFail('There is no active driver job on this order.') };
  return { job: job };
}
function actionTxJobMessage(body) {
  return runTxWrite(body, 'jobMessage', function (ctx) { var r = deliverySellerJob(ctx); return r.error || deliverySendMessage(r.job, 'seller', ctx.actor.id, body, ctx.requestId); });
}
function actionTxProposeFee(body) {
  return runTxWrite(body, 'proposeFee', function (ctx) { var r = deliverySellerJob(ctx); return r.error || deliveryProposeFee(r.job, 'seller', ctx.actor.id, body); });
}
function actionTxAgreeFee(body) {
  return runTxWrite(body, 'agreeFee', function (ctx) { var r = deliverySellerJob(ctx); return r.error || deliveryAgreeFee(r.job, 'seller', ctx.actor.id, body); });
}

/* Driver side: through runDriverWrite (their own job only). */
function actionDriverJobMessage(body) {
  return runDriverWrite(body, 'jobMessage', function (ctx) { return deliverySendMessage(ctx.job, 'driver', ctx.driver.DriverId, body, ctx.requestId); });
}
function actionDriverProposeFee(body) {
  return runDriverWrite(body, 'proposeFee', function (ctx) { return deliveryProposeFee(ctx.job, 'driver', ctx.driver.DriverId, body); });
}
function actionDriverAgreeFee(body) {
  return runDriverWrite(body, 'agreeFee', function (ctx) { return deliveryAgreeFee(ctx.job, 'driver', ctx.driver.DriverId, body); });
}


/* ==================== Seller pays Mwakete (driver wallet, phase 3) ====================
 *
 * Once the fee is locked the SELLER pays it to Mwakete by bank transfer using
 * a reference code, then tells us the bank reference. An ADMIN checks the REAL
 * bank statement (never a screenshot) and confirms the amount arrived. Only
 * then does the driver see the pickup place and the buyer's details and may
 * collect. Mwakete's bank details are the Script Property MWAKETE_BANK_DETAILS
 * (never in front-end code); they are shown only to the seller of a job whose
 * fee is locked.
 *
 * PayStatus: ''           not a wallet job
 *            awaiting     fee locked, seller to pay
 *            submitted    seller says they paid; an admin must check
 *            rejected     admin could not match it; seller can send it again
 *            received     admin confirmed the money arrived (Mwakete holds it)
 *            refund_due   job ended before the goods were collected; Mwakete owes the seller
 *            refunded     admin returned it and recorded the bank reference
 *
 * Crediting the driver and paying them out is phase 4.
 */

var DELIVERY_PAY_LABEL = {
  awaiting: 'Waiting for the seller to pay Mwakete', submitted: 'Payment sent - Mwakete is checking it', rejected: 'Mwakete could not match the payment',
  received: 'Payment confirmed', refund_due: 'Refund due to the seller', refunded: 'Refunded to the seller'
};

function deliveryPayRef(job) { return 'MWK-' + String(job.JobId).slice(-8).toUpperCase(); }

function deliveryBankDetails() {
  var v = PropertiesService.getScriptProperties().getProperty('MWAKETE_BANK_DETAILS');
  return v ? String(v).trim().slice(0, 500) : '';
}

/** What to change when a job ends before the goods were collected and Mwakete holds the seller's money. */
function deliveryRefundPatch(job) {
  return job && job.PayStatus === 'received' ? { PayStatus: 'refund_due' } : {};
}

/** The payment panel for one viewer. The driver never sees bank details or the seller's references. */
function deliveryPaymentView(job, viewer) {
  var st = String(job.PayStatus || '');
  if (!st) return null;
  var out = { status: st, label: DELIVERY_PAY_LABEL[st] || st, reference: viewer === 'driver' ? '' : job.PayRef, amount: deliveryMoney(job.Fee) };
  if (viewer === 'driver') return out;
  var bank = deliveryBankDetails();
  out.canSubmit = viewer === 'seller' && (st === 'awaiting' || st === 'rejected') && job.Status === 'accepted' && !!bank;
  out.bankDetails = viewer === 'seller' && (st === 'awaiting' || st === 'rejected' || st === 'submitted') ? bank : '';
  out.bankMissing = viewer === 'seller' && (st === 'awaiting' || st === 'rejected') && !bank;
  out.note = st === 'rejected' ? job.PayNote : '';
  out.bankRef = job.PayBankRef || '';
  return out;
}

function deliveryNotifyAdmins(subject, text) {
  try {
    var link = siteBaseUrl() ? '\n\nCheck it: ' + siteBaseUrl() + '/owner/admin.html#deliveries' : '';
    getAdminEmails().forEach(function (to) { try { sendAppEmail(to, subject, text + link); } catch (e) { /* best effort */ } });
  } catch (e) { /* best effort */ }
}

function deliveryNotifySeller(job, subject, text) {
  try {
    var o = findRowById(getSheet('Owners'), 'OwnerId', job.OwnerId);
    if (o && o.Email) sendAppEmail(o.Email, subject, text + (siteBaseUrl() ? '\n\nOpen it: ' + siteBaseUrl() + '/order-room.html?order=' + encodeURIComponent(job.OrderId) + '&as=seller' : ''));
  } catch (e) { /* best effort */ }
}

/** Seller: body.bankRef, body.amount (must be exactly the agreed fee). */
function actionTxSubmitJobPayment(body) {
  return runTxWrite(body, 'jobPayment', function (ctx) {
    var r = deliverySellerJob(ctx);
    if (r.error) return r.error;
    var job = r.job;
    if (!deliveryFeeChatOn(job)) return fail('Job payments are not switched on for this delivery.');
    if (job.Status !== 'accepted') return fail('The payment can only be sent before the driver collects the goods.');
    if (job.FeeLocked !== 'yes') return fail('Agree the delivery fee with the driver first.');
    if (['awaiting', 'rejected'].indexOf(String(job.PayStatus)) === -1) return fail(job.PayStatus === 'received' ? 'Mwakete has already confirmed this payment.' : 'This payment has already been sent.');
    if (!deliveryBankDetails()) return fail('Mwakete\'s bank details are not set up yet. Please contact Mwakete.');
    var bankRef = txCleanText(body.bankRef, 60);
    if (bankRef.length < 3) return fail('Enter the reference your bank gave the transfer.');
    if (deliveryMoney(body.amount) !== deliveryMoney(job.Fee)) return fail('Send exactly the agreed fee of ' + orderMoney(job.Fee) + '.');
    var row = findRowById(deliveryJobsSheet(), 'JobId', job.JobId);
    saveJob(row, { PayStatus: 'submitted', PayBankRef: bankRef, PayAmount: deliveryMoney(body.amount), PayNote: '', PaySubmittedAt: nowIso() });
    deliveryChatPost(row, 'system', '', 'The seller says ' + orderMoney(row.Fee) + ' was sent to Mwakete. Mwakete is checking its bank account.');
    txAudit(ctx.actor, 'DELIVERY_PAYMENT_SUBMITTED', ctx.order.OrderId, job.PayStatus, 'submitted', bankRef, ctx.requestId);
    deliveryNotifyAdmins('A driver delivery payment needs checking', 'Seller ' + job.StoreSlug + ' says ' + orderMoney(row.Fee) + ' was sent with reference ' + row.PayRef + ' (bank reference ' + bankRef + ').');
    return ok({ status: 'submitted' });
  });
}

/** Common admin checks. Returns { row } or { error }. */
function deliveryAdminPaymentJob(owner, body, expected) {
  var row = findRowById(deliveryJobsSheet(), 'JobId', String(body.jobId || ''));
  if (!row) return { error: fail('Job not found') };
  if (row.PayStatus !== expected) return { error: fail('This payment is not waiting for that step (it is: ' + (DELIVERY_PAY_LABEL[row.PayStatus] || 'not a wallet payment') + ').') };
  var store = findRowById(getSheet('Owners'), 'OwnerId', row.OwnerId);
  var drv = deliveryJobDriver(row);
  var me = normalizeEmail(owner.Email);
  if ((store && normalizeEmail(store.Email) === me) || (drv && normalizeEmail(drv.Email) === me)) {
    return { error: fail('You cannot handle a payment for your own store or your own driver job.') };
  }
  return { row: row };
}

/** Admin: the money really is in Mwakete's bank account. body: jobId, amountReceived, checkedStatement (true). */
function actionAdminConfirmJobPayment(owner, body) {
  if (!isOwnerAdmin(owner)) return denyAdmin(owner, 'adminConfirmJobPayment');
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var g = deliveryAdminPaymentJob(owner, body, 'submitted');
    if (g.error) return g.error;
    var row = g.row;
    if (body.checkedStatement !== true) return fail('Only confirm after you have checked the real bank statement. A screenshot is not enough.');
    var got = deliveryMoney(body.amountReceived);
    if (got < deliveryMoney(row.Fee)) return fail('The amount received (' + orderMoney(got) + ') is less than the agreed fee (' + orderMoney(row.Fee) + '). Reject it instead.');
    var extra = got > deliveryMoney(row.Fee) ? 'Received ' + orderMoney(got) + ', ' + orderMoney(got - deliveryMoney(row.Fee)) + ' more than the fee; the extra must be returned by hand.' : '';
    saveJob(row, { PayStatus: 'received', PayNote: extra, PayCheckedBy: owner.OwnerId, PayCheckedAt: nowIso() });
    deliveryChatPost(row, 'system', '', 'Mwakete confirmed the payment of ' + orderMoney(row.Fee) + '. The driver can now see the pickup details and collect the goods.');
    appendAudit({ actorId: owner.OwnerId, actorRole: 'admin', action: 'DELIVERY_PAYMENT_CONFIRMED', entityType: 'delivery', entityId: row.JobId, previous: 'submitted', next: 'received', reason: extra });
    deliveryNotifySeller(row, 'Mwakete confirmed your delivery payment', 'Mwakete received ' + orderMoney(row.Fee) + ' for the driver. The driver can now collect your goods.');
    try {
      var d = deliveryJobDriver(row);
      if (d && d.Email) sendAppEmail(d.Email, 'You can collect the goods', 'Mwakete confirmed the seller\'s payment. The pickup details are now on your driver page.' + (siteBaseUrl() ? '\n' + siteBaseUrl() + '/driver.html' : ''));
    } catch (e) { /* best effort */ }
    return ok({ status: 'received' });
  } finally {
    lock.releaseLock();
  }
}

/** Admin: the payment did not arrive or does not match. body: jobId, reason. The seller can send it again. */
function actionAdminRejectJobPayment(owner, body) {
  if (!isOwnerAdmin(owner)) return denyAdmin(owner, 'adminRejectJobPayment');
  var reason = txCleanText(body.reason, 300);
  if (reason.length < 5) return fail('Say what is wrong (the seller sees it).');
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var g = deliveryAdminPaymentJob(owner, body, 'submitted');
    if (g.error) return g.error;
    var row = g.row;
    saveJob(row, { PayStatus: 'rejected', PayNote: reason, PayCheckedBy: owner.OwnerId, PayCheckedAt: nowIso() });
    deliveryChatPost(row, 'system', '', 'Mwakete could not match the payment: ' + reason + ' The seller can send the details again.');
    appendAudit({ actorId: owner.OwnerId, actorRole: 'admin', action: 'DELIVERY_PAYMENT_REJECTED', entityType: 'delivery', entityId: row.JobId, previous: 'submitted', next: 'rejected', reason: reason });
    deliveryNotifySeller(row, 'Mwakete could not match your delivery payment', reason);
    return ok({ status: 'rejected' });
  } finally {
    lock.releaseLock();
  }
}

/** Admin: the held money was sent back to the seller. body: jobId, bankRef. */
function actionAdminMarkJobRefunded(owner, body) {
  if (!isOwnerAdmin(owner)) return denyAdmin(owner, 'adminMarkJobRefunded');
  var ref = txCleanText(body.bankRef, 60);
  if (ref.length < 3) return fail('Enter the bank reference of the refund.');
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var g = deliveryAdminPaymentJob(owner, body, 'refund_due');
    if (g.error) return g.error;
    var row = g.row;
    saveJob(row, { PayStatus: 'refunded', PayRefundRef: ref, PayCheckedBy: owner.OwnerId, PayCheckedAt: nowIso() });
    appendAudit({ actorId: owner.OwnerId, actorRole: 'admin', action: 'DELIVERY_PAYMENT_REFUNDED', entityType: 'delivery', entityId: row.JobId, previous: 'refund_due', next: 'refunded', reason: ref });
    deliveryNotifySeller(row, 'Mwakete refunded your delivery payment', 'Mwakete sent back ' + orderMoney(row.Fee) + ' (bank reference ' + ref + ') because the delivery did not go ahead.');
    return ok({ status: 'refunded' });
  } finally {
    lock.releaseLock();
  }
}


/* ==================== Crediting, claiming and paying drivers (driver wallet, phase 4) ====================
 *
 * WHEN A DRIVER IS CREDITED (only for jobs Mwakete confirmed it was paid for,
 * PayStatus 'received'):
 *  - The order COMPLETES (payment verified, buyer confirmed receipt, no open
 *    problem): the full agreed fee is credited. Hooked from txMaybeComplete,
 *    which every completion path (buyer, admin, dispute outcome) goes through.
 *  - The driver reports a FAILED delivery after collecting the goods:
 *      no_one_home / wrong_address / refused / unreachable -> credited at once
 *        (the driver made the trip);
 *      damaged / other -> PayStatus 'review': an admin decides to pay the
 *        driver or refund the seller.
 * Every credit sits in the dispute hold (default 48 hours) before it can be
 * claimed. PayStatus becomes 'credited' so a job is never credited twice (the
 * ledger also refuses a second credit for the same job).
 *
 * The driver saves where to send money (PayoutDetails), claims once their
 * available balance reaches the minimum, and an admin pays by bank transfer
 * and records the reference. The admin sees what Mwakete should be holding.
 */

// What a driver is told about a wallet job's money (never the seller's bank references).
var DRIVER_PAY_LABEL = { awaiting: 'Waiting for the seller to pay Mwakete', submitted: 'Mwakete is checking the seller\'s payment', rejected: 'Waiting for the seller to pay Mwakete',
  received: 'Payment confirmed', credited: 'Credited to your balance', review: 'An admin is deciding who is paid', refund_due: 'Not paid: the delivery did not go ahead', refunded: 'Not paid: the delivery did not go ahead' };
var DELIVERY_FAIL_PAID = ['no_one_home', 'wrong_address', 'refused', 'unreachable'];
var DRIVER_PAYOUT_COLUMN = 'PayoutDetails';

DELIVERY_PAY_LABEL.credited = 'Credited to the driver';
DELIVERY_PAY_LABEL.review = 'An admin must decide who is paid';

function deliveryDriversSheet() {
  var sheet = driversSheet();
  ensureColumn(sheet, DRIVER_PAYOUT_COLUMN);
  return sheet;
}

/** Credit a job's fee to its driver. job is a DeliveryJobs row (with __row). Returns { ok, entry? } or { ok:false, error }. */
function deliveryCreditJob(job, why) {
  if (job.PayStatus === 'credited') return { ok: true, alreadyCredited: true };
  var res = walletCreditJob(Object.assign({}, job, { Status: 'delivered' }));
  if (!res.ok) return res;
  saveJob(job, { PayStatus: 'credited' });
  deliveryChatPost(job, 'system', '', 'Mwakete credited ' + orderMoney(job.Fee) + ' to the driver' + (why ? ' (' + why + ')' : '') + '. It can be claimed after a short hold.');
  appendAudit({ actorId: 'system', actorRole: 'system', action: 'DELIVERY_FEE_CREDITED', entityType: 'delivery', entityId: job.JobId, next: String(job.Fee), reason: why || '' });
  try {
    var d = deliveryJobDriver(job);
    if (d && d.Email) sendAppEmail(d.Email, 'You earned ' + orderMoney(job.Fee), 'Mwakete credited ' + orderMoney(job.Fee) + ' to your driver balance. You can claim it after ' +
      walletHoldHours() + ' hours, once your available balance reaches ' + orderMoney(walletMinPayout()) + '.' + (siteBaseUrl() ? '\n' + siteBaseUrl() + '/driver.html' : ''));
  } catch (e) { /* best effort */ }
  return res;
}

/** Called from txMaybeComplete (under the order's write lock) when an order completes. Never throws. */
function deliveryOnOrderCompleted(order) {
  try {
    var jobs = deliveryJobsFor(order.OrderId).filter(function (j) { return j.PayStatus === 'received' && ['delivered', 'picked_up'].indexOf(String(j.Status)) !== -1; });
    jobs.forEach(function (j) {
      var row = findRowById(deliveryJobsSheet(), 'JobId', j.JobId);
      if (row && deliveryFeeChatOn(row)) deliveryCreditJob(row, 'order completed');
    });
  } catch (e) { Logger.log('credit on completion failed: ' + (e && e.message)); }
}

/** A failed delivery after collecting the goods: pay the driver, or send it to an admin. Returns the extra job fields. */
function deliveryFailedAfterPickup(job, reason) {
  if (job.PayStatus !== 'received') return {};
  if (DELIVERY_FAIL_PAID.indexOf(reason) !== -1) return null; // caller credits after saving the job
  return { PayStatus: 'review' };
}

/** What the driver's wallet panel shows, or null when the wallet does not cover them. */
function driverWalletView(driver) {
  if (!driverWalletOpen(driver)) return null;
  var bal = walletBalance(driver.DriverId);
  var LABEL = { CREDIT: 'Delivery fee', CLAIM: 'Payout requested', PAYOUT_PAID: 'Paid to you', CLAIM_REVERSED: 'Payout returned to balance', ADJUSTMENT: 'Correction' };
  var rows = walletEntries(driver.DriverId);
  var paid = {}, reversed = {};
  rows.forEach(function (e) { if (e.EntryType === 'PAYOUT_PAID') paid[e.RefEntryId] = e.Reference; if (e.EntryType === 'CLAIM_REVERSED') reversed[e.RefEntryId] = true; });
  var now = Date.now();
  var entries = rows.filter(function (e) { return e.EntryType !== 'PAYOUT_PAID'; }).slice(-30).reverse().map(function (e) {
    var at = e.AvailableAt ? Date.parse(e.AvailableAt) : 0;
    return { id: e.EntryId, type: e.EntryType, label: LABEL[e.EntryType] || e.EntryType, amount: walletMoney(e.Amount), at: e.CreatedAt, note: e.Note || '',
      status: e.EntryType === 'CLAIM' ? (reversed[e.EntryId] ? 'returned' : paid[e.EntryId] ? 'paid' : 'waiting to be paid') : (e.EntryType === 'CREDIT' && at > now ? 'in hold until ' + e.AvailableAt : ''),
      reference: e.EntryType === 'CLAIM' ? (paid[e.EntryId] || '') : '' };
  });
  return { enabled: true, currency: WALLET_CURRENCY, balance: bal, holdHours: walletHoldHours(), payoutDetails: driver.PayoutDetails || '',
    canClaim: bal.available >= bal.minPayout && !!driver.PayoutDetails, entries: entries };
}

/** Driver: where Mwakete should send their money. body.details */
function actionDriverSetPayoutDetails(body) {
  var who = resolveDriver(body);
  if (who.error) return txFail(who.error, { authRequired: who.auth });
  var d = who.driver;
  if (!d || d.Status !== 'approved') return fail('Only approved drivers can do this.');
  if (!driverWalletOpen(d)) return fail('Payouts are not switched on for you yet.');
  var details = txCleanText(body.details, 300);
  if (details.length < 10) return fail('Enter your bank name, the name on the account and the account number.');
  var sheet = deliveryDriversSheet();
  var row = findRowById(sheet, 'DriverId', d.DriverId);
  updateRowFromObject(sheet, row.__row, { PayoutDetails: details, UpdatedAt: nowIso() });
  appendAudit({ actorId: d.DriverId, actorRole: 'driver', action: 'DRIVER_PAYOUT_DETAILS_SET', entityType: 'driver', entityId: d.DriverId });
  return ok({ saved: true });
}

/** Driver: ask to be paid the whole available balance. body.requestId */
function actionDriverClaimPayout(body) {
  var who = resolveDriver(body);
  if (who.error) return txFail(who.error, { authRequired: who.auth });
  var d = who.driver;
  if (!d || d.Status !== 'approved') return fail('Only approved drivers can do this.');
  if (!driverWalletOpen(d)) return fail('Payouts are not switched on for you yet.');
  if (!cleanRequestId(body.requestId)) return fail('Please try again.');
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  var res;
  try {
    var row = findRowById(deliveryDriversSheet(), 'DriverId', d.DriverId);
    var details = row && row.PayoutDetails;
    if (!details) return fail('Add where to send your money first.');
    res = walletClaim(d.DriverId, body.requestId, undefined, details);
    if (res.ok && res.entry) appendAudit({ actorId: d.DriverId, actorRole: 'driver', action: 'DRIVER_PAYOUT_CLAIMED', entityType: 'driver', entityId: d.DriverId, next: String(-res.entry.Amount) });
  } finally {
    lock.releaseLock();
  }
  if (!res.ok) return fail(res.error);
  if (res.entry) {
    try {
      var link = siteBaseUrl() ? '\n\nPay it: ' + siteBaseUrl() + '/owner/admin.html#deliveries' : '';
      getAdminEmails().forEach(function (to) { try { sendAppEmail(to, 'A driver asked to be paid', d.Name + ' asked for ' + orderMoney(-res.entry.Amount) + '.' + link); } catch (e) { /* best effort */ } });
    } catch (e) { /* best effort */ }
  }
  return ok({ claimed: res.entry ? -res.entry.Amount : 0, repeated: !!res.repeated });
}

/* ---------- Admin ---------- */

function deliveryAdminOwnDriver(owner, driverId) {
  var d = deliveryRows('Drivers').filter(function (x) { return x.DriverId === driverId; })[0];
  return d && normalizeEmail(d.Email) === normalizeEmail(owner.Email) ? 'You cannot handle your own driver payout.' : '';
}

/** The payout queue and what Mwakete should be holding. */
function actionAdminListPayouts(owner, body) {
  if (!isOwnerAdmin(owner)) return denyAdmin(owner, 'adminListPayouts');
  var drivers = {};
  deliveryRows('Drivers').forEach(function (d) { drivers[d.DriverId] = d; });
  var all = walletEntries();
  var paid = {}, reversed = {}, byDriver = {};
  all.forEach(function (e) {
    if (e.EntryType === 'PAYOUT_PAID') paid[e.RefEntryId] = e;
    if (e.EntryType === 'CLAIM_REVERSED') reversed[e.RefEntryId] = true;
    byDriver[e.DriverId] = true;
  });
  var claims = all.filter(function (e) { return e.EntryType === 'CLAIM'; });
  var open = claims.filter(function (c) { return !paid[c.EntryId] && !reversed[c.EntryId]; }).sort(function (a, b) { return String(a.CreatedAt).localeCompare(String(b.CreatedAt)); });
  var recent = claims.filter(function (c) { return paid[c.EntryId]; }).sort(function (a, b) { return String(b.CreatedAt).localeCompare(String(a.CreatedAt)); }).slice(0, 20);
  var view = function (c) {
    var d = drivers[c.DriverId] || {};
    var p = paid[c.EntryId];
    return { claimId: c.EntryId, driverId: c.DriverId, driverName: d.Name || '', driverPhone: d.Phone || '', amount: -walletMoney(c.Amount), details: c.Note || '', at: c.CreatedAt,
      paidRef: p ? p.Reference : '', paidAt: p ? p.CreatedAt : '' };
  };
  var jobs = deliveryRows('DeliveryJobs');
  var sumFee = function (st) { return walletMoney(jobs.filter(function (j) { return j.PayStatus === st; }).reduce(function (n, j) { return n + deliveryMoney(j.Fee); }, 0)); };
  var owed = 0, pending = 0, claimedUnpaid = 0, availableAll = 0;
  var rows = Object.keys(byDriver).map(function (id) {
    var b = walletBalance(id), d = drivers[id] || {};
    owed += b.total; pending += b.pending; claimedUnpaid += b.claimed; availableAll += b.available;
    return { driverId: id, name: d.Name || '', phone: d.Phone || '', total: b.total, available: b.available, pending: b.pending, claimed: b.claimed, paidOut: b.paidOut };
  }).sort(function (a, b) { return b.available - a.available; });
  return ok({
    currency: WALLET_CURRENCY, mode: walletMode(), minPayout: walletMinPayout(), holdHours: walletHoldHours(),
    claims: open.map(view), recent: recent.map(view), drivers: rows,
    // What Mwakete should be holding for others: compare this with the bank balance.
    holding: { heldForOpenJobs: sumFee('received'), awaitingDecision: sumFee('review'), owedToDrivers: walletMoney(owed), claimsToPay: walletMoney(claimedUnpaid), refundsDue: sumFee('refund_due'),
      total: walletMoney(sumFee('received') + sumFee('review') + owed + claimedUnpaid + sumFee('refund_due')) }
  });
}

/** Admin: the bank transfer for a claim was made. body: claimId, bankRef */
function actionAdminMarkPayoutPaid(owner, body) {
  if (!isOwnerAdmin(owner)) return denyAdmin(owner, 'adminMarkPayoutPaid');
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var found = walletFindClaim(String(body.claimId || ''));
    if (found.error) return fail(found.error);
    var own = deliveryAdminOwnDriver(owner, found.claim.DriverId);
    if (own) return fail(own);
    var res = walletMarkClaimPaid(found.claim.EntryId, body.bankRef, owner.OwnerId);
    if (!res.ok) return fail(res.error);
    appendAudit({ actorId: owner.OwnerId, actorRole: 'admin', action: 'DRIVER_PAYOUT_PAID', entityType: 'driver', entityId: found.claim.DriverId, previous: found.claim.EntryId, next: String(-walletMoney(found.claim.Amount)), reason: txCleanText(body.bankRef, 60) });
    try {
      var d = deliveryRows('Drivers').filter(function (x) { return x.DriverId === found.claim.DriverId; })[0];
      if (d && d.Email) sendAppEmail(d.Email, 'Mwakete paid you ' + orderMoney(-walletMoney(found.claim.Amount)), 'Mwakete sent ' + orderMoney(-walletMoney(found.claim.Amount)) + ' to your bank account (reference ' + txCleanText(body.bankRef, 60) + ').');
    } catch (e) { /* best effort */ }
    return ok({ paid: true });
  } finally {
    lock.releaseLock();
  }
}

/** Admin: give an unpaid claim back to the driver's balance. body: claimId, reason */
function actionAdminReversePayout(owner, body) {
  if (!isOwnerAdmin(owner)) return denyAdmin(owner, 'adminReversePayout');
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var found = walletFindClaim(String(body.claimId || ''));
    if (found.error) return fail(found.error);
    var own = deliveryAdminOwnDriver(owner, found.claim.DriverId);
    if (own) return fail(own);
    var res = walletReverseClaim(found.claim.EntryId, body.reason, owner.OwnerId);
    if (!res.ok) return fail(res.error);
    appendAudit({ actorId: owner.OwnerId, actorRole: 'admin', action: 'DRIVER_PAYOUT_REVERSED', entityType: 'driver', entityId: found.claim.DriverId, previous: found.claim.EntryId, reason: txCleanText(body.reason, 300) });
    return ok({ reversed: true });
  } finally {
    lock.releaseLock();
  }
}

/** Admin: a correction to a driver's balance, with a reason. body: driverId, amount (+/-), reason, requestId */
function actionAdminAdjustDriverWallet(owner, body) {
  if (!isOwnerAdmin(owner)) return denyAdmin(owner, 'adminAdjustDriverWallet');
  var driverId = String(body.driverId || '');
  if (!deliveryRows('Drivers').some(function (d) { return d.DriverId === driverId; })) return fail('Driver not found');
  var own = deliveryAdminOwnDriver(owner, driverId);
  if (own) return fail(own);
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var res = walletAdjust(driverId, body.amount, body.reason, owner.OwnerId, cleanRequestId(body.requestId));
    if (!res.ok) return fail(res.error);
    if (res.entry) appendAudit({ actorId: owner.OwnerId, actorRole: 'admin', action: 'DRIVER_WALLET_ADJUSTED', entityType: 'driver', entityId: driverId, next: String(res.entry.Amount), reason: txCleanText(body.reason, 300) });
    return ok({ adjusted: true, repeated: !!res.repeated });
  } finally {
    lock.releaseLock();
  }
}

/** Admin: decide a failed delivery with damaged goods or another reason. body: jobId, outcome ('pay_driver'|'refund_seller'), note */
function actionAdminResolveJobPayment(owner, body) {
  if (!isOwnerAdmin(owner)) return denyAdmin(owner, 'adminResolveJobPayment');
  var outcome = String(body.outcome || '');
  if (['pay_driver', 'refund_seller'].indexOf(outcome) === -1) return fail('Choose to pay the driver or refund the seller.');
  var note = txCleanText(body.note, 300);
  if (note.length < 5) return fail('Give your reason (it is recorded).');
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var g = deliveryAdminPaymentJob(owner, body, 'review');
    if (g.error) return g.error;
    var row = g.row;
    if (outcome === 'pay_driver') {
      var res = deliveryCreditJob(row, 'admin decision');
      if (!res.ok) return fail(res.error);
    } else {
      saveJob(row, { PayStatus: 'refund_due', PayNote: note });
      deliveryChatPost(row, 'system', '', 'An admin decided the seller is refunded.');
    }
    saveJob(row, { PayNote: note, PayCheckedBy: owner.OwnerId, PayCheckedAt: nowIso() });
    appendAudit({ actorId: owner.OwnerId, actorRole: 'admin', action: 'DELIVERY_PAYMENT_DECIDED', entityType: 'delivery', entityId: row.JobId, previous: 'review', next: outcome, reason: note });
    return ok({ outcome: outcome });
  } finally {
    lock.releaseLock();
  }
}
