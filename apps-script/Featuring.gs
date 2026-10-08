/**
 * Paid featuring - a seller pays 5c per product per day to have products
 * shown in Tips (and the categories "Featured" rail), alongside the ones an
 * admin features for free.
 *
 * Payment is a plain ANZ bank transfer, verified the same way the AM TOPUP
 * site (dsc26support-beep/topup, recharge_backend.gs) verifies its own: the
 * seller is issued a reference, pays it to the account below, and uploads a
 * screenshot of the bank's receipt. The screenshot is OCR'd and checked for
 * the reference, the account number, the full amount, a success word, and
 * that it isn't the "Confirm / Cancel" screen a banking app shows BEFORE the
 * transfer is actually sent. Paid into Mwakete's own account (owner
 * decision, Oct 2026 - it was the AM TOPUP account before).
 *
 * Free monthly featuring (owner decision, revised Oct 2026): one featuring of
 * up to FEATURE_FREE_MAX_PRODUCTS products a month costs nothing - no
 * payment, approved at once. "A month" is the calendar month in Kiribati
 * time, and it is one per PHONE NUMBER, so several stores run by one person
 * share it. The store must be active, have a phone number, and have 2-step
 * sign-in on (TwoFAEnabled - which proved its email with a code). The free
 * row is the one with Amount 0 (a paid amount is always at least 5c), so no
 * new sheet column is needed.
 *
 * Outcomes, as in topup:
 *   Approved       - every check passed; featuring starts now.
 *   Pending review - checks passed but something needs a human (OCR not
 *                    available, or an amount above FEATURE_AUTO_APPROVE_MAX). Admins are
 *                    emailed and decide on the admin page.
 *   Rejected       - a real check failed (wrong reference/account/amount,
 *                    unsubmitted screen). The seller can upload again.
 *
 * Differences from topup, both deliberate:
 *   - No underpayment tolerance. Topup allows 5c short; on a 15c featuring
 *     order that would be a third of the price.
 *   - The bank-reference-sequence check is not ported: it's stateful,
 *     topup's own comments flag its assumption as unverified, and a shared
 *     account means topup and Mwakete would fight over one baseline.
 *
 * OCR uses the Drive advanced service ("Drive API" under Services in the
 * Apps Script editor). Without it nothing breaks - every payment just goes
 * to Pending review.
 *
 * Anti-fraud (owner-approved, Oct 2026). No bank feed exists for the account
 * (no email or SMS alerts), so the system only ever sees the seller's
 * screenshot. These rules make faking it hard and not worth it:
 *   1. The receipt's date can't be before the day the order was started.
 *   2. The bank's own Reference Number (ANZ: "Reference Number AQC84078") is
 *      read and can only ever be used once.
 *   3. Images saved by photo editors, or not shaped like a phone screenshot,
 *      are refused before any checking.
 *   4. Per-store weekly limit on automatic approval (lower for new stores);
 *      above it a payment waits for a human.
 *   5. Featuring starts FEATURE_START_DELAY_HOURS after automatic approval.
 *   6. Free featuring once a month per phone number, for an active store
 *      with 2-step sign-in on.
 *
 * Sheet: FeaturePurchases - created on first use with the headers below. It
 * holds payment records, so like Orders it is deliberately NOT in
 * REQUIRED_TABS, whose setupSheets "repair" rewrites header rows.
 */

var FEATURE_PRICE_PER_PRODUCT_DAY = 0.05;
var FEATURE_MAX_DAYS = 60;
var FEATURE_MAX_PRODUCTS = 30;
var FEATURE_FREE_MAX_PRODUCTS = 3;
var FEATURE_PAY_ACCOUNT_NAME = 'Mwakete';
var FEATURE_PAY_ACCOUNT_NUMBER = '906149';
var FEATURE_SUBMITS_PER_HOUR = 10;
// Kiribati's westernmost zone (Tarawa). Order days are compared in this time,
// so a receipt from Kiritimati (UTC+14) can only ever look later, never earlier.
var FEATURE_LOCAL_UTC_OFFSET_HOURS = 12;
var FEATURE_ESTABLISHED_AFTER_PAYMENTS = 3;

var FEATURE_PURCHASE_HEADERS = ['PurchaseId', 'OwnerId', 'StoreSlug', 'ProductIdsJson', 'Days', 'Amount',
  'Reference', 'Status', 'ScreenshotUrl', 'ScreenshotHash', 'OcrNotes', 'StartsAt', 'EndsAt',
  'CreatedAt', 'UpdatedAt', 'ViewsAtStartJson', 'ViewsAtEndJson', 'BankMatchedAt', 'ReceiptNo'];

var FEATURE_STATUS = {
  AWAITING: 'Awaiting payment',
  PENDING: 'Pending review',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  // Auto-approved, but never ticked "Seen in bank" within FEATURE_BANK_MATCH_DAYS
  // (sweepFeatureBankMatches). Its screenshot and bank receipt stay used.
  STOPPED: 'Stopped'
};

function getFeaturePurchasesSheet() {
  var ss = SpreadsheetApp.getActive();
  var sheet = ss.getSheetByName('FeaturePurchases');
  if (sheet) {
    // Added after the tab went live (owner-approved): each product's Views
    // count when featuring started and ended, for the seller's results.
    // Additive - appends header cells, moves nothing.
    ensureColumn(sheet, 'ViewsAtStartJson');
    ensureColumn(sheet, 'ViewsAtEndJson');
    // Admin ticks a paid purchase once the money is seen in the bank account.
    ensureColumn(sheet, 'BankMatchedAt');
    // The bank's own Reference Number from the receipt - each usable once.
    ensureColumn(sheet, 'ReceiptNo');
    return sheet;
  }
  sheet = ss.insertSheet('FeaturePurchases');
  sheet.getRange(1, 1, 1, FEATURE_PURCHASE_HEADERS.length).setValues([FEATURE_PURCHASE_HEADERS]);
  return sheet;
}

/** Cents-exact: 3 products x 7 days = 1.05, never 1.0500000000000003. */
function featureAmountFor(productCount, days) {
  return Math.round(productCount * days * FEATURE_PRICE_PER_PRODUCT_DAY * 100) / 100;
}

function newFeatureReference(existingRows) {
  var used = {};
  existingRows.forEach(function (r) { used[String(r.Reference)] = true; });
  var alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I - typed into a bank app by hand
  for (var attempt = 0; attempt < 20; attempt++) {
    var ref = 'MWF';
    for (var i = 0; i < 6; i++) ref += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
    if (!used[ref]) return ref;
  }
  throw new Error('Could not issue a unique reference');
}

function publicFeaturePurchase(row, productNamesById) {
  var ids = [];
  try { ids = JSON.parse(row.ProductIdsJson || '[]'); } catch (e) { ids = []; }
  return {
    purchaseId: row.PurchaseId,
    productIds: ids,
    productNames: ids.map(function (id) { return (productNamesById && productNamesById[id]) || id; }),
    days: Number(row.Days),
    amount: Number(row.Amount),
    reference: row.Reference,
    status: row.Status,
    startsAt: row.StartsAt || '',
    endsAt: row.EndsAt || '',
    createdAt: row.CreatedAt
  };
}

/** Kiribati numbers are 7-8 digits; drop spaces, + and the 686 country code. '' when there isn't one. */
function normalizeFeaturePhone(phone) {
  var d = String(phone || '').replace(/\D/g, '');
  if (d.length > 8 && d.indexOf('686') === 0) d = d.slice(3);
  return d.length >= 7 ? d : '';
}

/** 'YYYY-MM' of a moment, in Kiribati (Tarawa) time. */
function featureLocalMonth(ms) {
  return featureLocalDay(ms).slice(0, 7);
}

/** 'YYYY-MM-01' of the next Kiribati month - when the next free featuring opens. */
function featureNextFreeMonthStart(nowMs) {
  var m = featureLocalMonth(nowMs).split('-').map(Number);
  var y = m[1] === 12 ? m[0] + 1 : m[0];
  var mo = m[1] === 12 ? 1 : m[1] + 1;
  return y + '-' + ('0' + mo).slice(-2) + '-01';
}

/**
 * Pure: why this store can't have the free featuring right now, or '' if it can.
 * 'used'     - this month, this store or another store with the same phone had it.
 * 'inactive' - the store is paused or closed.
 * 'nophone'  - no usable phone number on the store.
 * 'no2fa'    - 2-step sign-in is off (it is how a store proves its email).
 * phoneByOwnerId: { OwnerId: phone } for every store (to spot one person
 * running several stores to collect the offer more than once a month).
 */
function featureFreeBlock(rows, owner, phoneByOwnerId, nowMs) {
  var phones = phoneByOwnerId || {};
  var month = featureLocalMonth(nowMs === undefined ? Date.now() : nowMs);
  var myPhone = normalizeFeaturePhone(owner.Phone);
  var used = rows.some(function (r) {
    if (String(r.Amount) === '' || Number(r.Amount) !== 0) return false;
    var t = new Date(r.CreatedAt).getTime();
    if (isNaN(t) || featureLocalMonth(t) !== month) return false;
    if (r.OwnerId === owner.OwnerId || (owner.StoreSlug && r.StoreSlug === owner.StoreSlug)) return true;
    return !!myPhone && normalizeFeaturePhone(phones[r.OwnerId]) === myPhone;
  });
  if (used) return 'used';
  if (owner.Status !== undefined && owner.Status !== 'active') return 'inactive';
  if (!myPhone) return 'nophone';
  if (String(owner.TwoFAEnabled) !== 'true') return 'no2fa';
  return '';
}

/** Pure: has this store (or its phone) had this month's free featuring? */
function featureFreeUsed(rows, owner, phoneByOwnerId, nowMs) {
  return featureFreeBlock(rows, owner, phoneByOwnerId, nowMs) === 'used';
}

/** Pure: is a featuring of productCount products free for this store right now? */
function featureIsFree(rows, owner, productCount, phoneByOwnerId, nowMs) {
  return productCount >= 1 && productCount <= FEATURE_FREE_MAX_PRODUCTS && featureFreeBlock(rows, owner, phoneByOwnerId, nowMs) === '';
}

function featurePhonesByOwnerId() {
  var out = {};
  sheetToObjects(getSheet('Owners')).forEach(function (o) { out[o.OwnerId] = o.Phone; });
  return out;
}

function featurePaymentDetails() {
  return { accountName: FEATURE_PAY_ACCOUNT_NAME, accountNumber: FEATURE_PAY_ACCOUNT_NUMBER };
}

/* ==================== Seller actions ==================== */

/** body.productIds: string[], body.days: number. Issues a reference and an amount to pay. */
function actionStartFeaturePurchase(owner, body) {
  var days = parseInt(body.days, 10);
  if (!(days >= 1 && days <= FEATURE_MAX_DAYS)) return fail('Choose between 1 and ' + FEATURE_MAX_DAYS + ' days.');

  var requested = Array.isArray(body.productIds) ? body.productIds.map(String) : [];
  var unique = requested.filter(function (id, i) { return id && requested.indexOf(id) === i; });
  if (unique.length === 0) return fail('Choose at least one product to feature.');
  if (unique.length > FEATURE_MAX_PRODUCTS) return fail('You can feature up to ' + FEATURE_MAX_PRODUCTS + ' products at a time.');

  var mine = {};
  sheetToObjects(getSheet('Products')).forEach(function (p) {
    if (p.OwnerId === owner.OwnerId && p.Status === 'active') mine[p.ProductId] = true;
  });
  if (!unique.every(function (id) { return mine[id]; })) {
    return fail('One of those products is not an active listing in your store. Please refresh and try again.');
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  var row, free;
  try {
    var sheet = getFeaturePurchasesSheet();
    var existing = sheetToObjects(sheet);
    // Decided inside the lock, so two quick taps can't both get the free one.
    free = featureIsFree(existing, owner, unique.length, featurePhonesByOwnerId());
    var now = nowIso();
    var purchaseId = newId('feat');
    var record = {
      PurchaseId: purchaseId,
      OwnerId: owner.OwnerId,
      StoreSlug: owner.StoreSlug,
      ProductIdsJson: JSON.stringify(unique),
      Days: days,
      Amount: free ? 0 : featureAmountFor(unique.length, days),
      Reference: newFeatureReference(existing),
      Status: free ? FEATURE_STATUS.APPROVED : FEATURE_STATUS.AWAITING,
      ScreenshotUrl: '',
      ScreenshotHash: '',
      OcrNotes: free ? 'free: monthly featuring' : '',
      StartsAt: free ? now : '',
      EndsAt: free ? new Date(Date.now() + days * 86400000).toISOString() : '',
      CreatedAt: now,
      UpdatedAt: now
    };
    if (free) record.ViewsAtStartJson = JSON.stringify(productViewsSnapshot(record));
    appendRowFromObject(sheet, record);
    row = findRowById(sheet, 'PurchaseId', purchaseId);
  } finally {
    lock.releaseLock();
  }
  if (free) invalidateCache([TIPS_CACHE_KEY, PAID_FEATURED_CACHE_KEY]);
  return ok({ purchase: publicFeaturePurchase(row), payment: featurePaymentDetails(), free: free });
}

/** Every purchase this store has made, newest first, plus where to pay. */
function actionListMyFeaturePurchases(owner) {
  var names = {};
  var views = {};
  sheetToObjects(getSheet('Products')).forEach(function (p) {
    if (p.OwnerId !== owner.OwnerId) return;
    names[p.ProductId] = p.Name;
    views[p.ProductId] = Number(p.Views) || 0;
  });
  var all = sheetToObjects(getFeaturePurchasesSheet());
  var phones = featurePhonesByOwnerId();
  var rows = all
    .filter(function (r) { return r.OwnerId === owner.OwnerId; })
    .sort(function (a, b) { return String(b.CreatedAt).localeCompare(String(a.CreatedAt)); })
    .map(function (r) {
      var p = publicFeaturePurchase(r, names);
      p.viewsGained = featureViewsGained(r, views);
      return p;
    });
  return ok({
    purchases: rows, payment: featurePaymentDetails(), pricePerProductDay: FEATURE_PRICE_PER_PRODUCT_DAY,
    freeAvailable: featureFreeBlock(all, owner, phones) === '',
    freeBlockedBecause: featureFreeBlock(all, owner, phones),
    freeNextOn: featureNextFreeMonthStart(Date.now()),
    freeMaxProducts: FEATURE_FREE_MAX_PRODUCTS
  });
}

/**
 * body.purchaseId, body.imageBase64, body.mimeType. Checks the bank screenshot
 * and settles the purchase as Approved / Pending review / Rejected. Problems
 * with the FILE itself (not an image, too small, already used) are returned as
 * errors and leave the purchase untouched, so the seller just picks another.
 */
function actionSubmitFeaturePayment(owner, body) {
  if (isFeatureSubmitRateLimited(owner.OwnerId)) {
    return fail('Too many uploads in the last hour. Please try again later.');
  }
  var sheet = getFeaturePurchasesSheet();
  var row = findRowById(sheet, 'PurchaseId', String(body.purchaseId || ''));
  if (!row || row.OwnerId !== owner.OwnerId) return fail('Purchase not found.');
  if (row.Status !== FEATURE_STATUS.AWAITING && row.Status !== FEATURE_STATUS.REJECTED) {
    return fail(row.Status === FEATURE_STATUS.APPROVED
      ? 'This purchase is already paid and approved.'
      : 'This payment is already waiting for review.');
  }

  var mimeType = String(body.mimeType || '');
  var bytes;
  try { bytes = Utilities.base64Decode(String(body.imageBase64 || '')); } catch (e) { return fail('That file could not be read. Please choose the screenshot again.'); }
  if (!isValidPaymentImage(bytes, mimeType)) return fail('That file is not a PNG, JPG or WebP image. Please upload a screenshot of your bank receipt.');
  if (bytes.length > MAX_IMAGE_BYTES) return fail('That image is too large (max 5MB).');
  if (bytes.length < featureMinImageBytes()) return fail('That image looks too small or empty. Please upload the full screenshot.');

  // Before any checking: edited or cropped images are refused outright.
  var fileProblem = featureImageProblem(imageInfo(bytes));
  if (fileProblem) return fail(fileProblem);

  var hash = sha256Hex(bytes);
  // Cheap early refusal; repeated under the lock below, where it counts.
  if (featureHashUsedElsewhere(sheetToObjects(sheet), hash, row.PurchaseId)) {
    return fail('That screenshot has already been used for another payment.');
  }

  // Slow work OUTSIDE the lock: saving the file and reading the receipt take
  // seconds, and the script lock is shared by every write on the site.
  var screenshotUrl = saveFeatureScreenshot(bytes, mimeType, row.PurchaseId);
  var ocrText;
  try { ocrText = ocrPaymentImage(bytes, mimeType); } catch (e) { Logger.log('feature OCR failed: ' + e); ocrText = null; }
  var isPhoto = imageHasExif(bytes);

  // Then, under ONE lock: re-read the sheet, re-check everything another
  // upload could have changed meanwhile (this order's status, the screenshot,
  // the bank receipt number, the store's weekly total), decide, and write.
  // Two uploads racing can no longer both pass the duplicate checks.
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  var check, update;
  try {
    var fresh = findRowById(sheet, 'PurchaseId', row.PurchaseId);
    if (!fresh || (fresh.Status !== FEATURE_STATUS.AWAITING && fresh.Status !== FEATURE_STATUS.REJECTED)) {
      return fail(fresh && fresh.Status === FEATURE_STATUS.APPROVED
        ? 'This purchase is already paid and approved.'
        : 'This payment is already being checked. Please wait a moment and refresh.');
    }
    var allRows = sheetToObjects(sheet);
    if (featureHashUsedElsewhere(allRows, hash, fresh.PurchaseId)) {
      return fail('That screenshot has already been used for another payment.');
    }
    check = decideFeaturePayment(ocrText, fresh, isPhoto, featureDecisionContext(allRows, fresh, Date.now()));
    var now = nowIso();
    update = {
      Status: check.status, ScreenshotUrl: screenshotUrl, ScreenshotHash: hash,
      OcrNotes: check.notes, UpdatedAt: now, ReceiptNo: check.receiptNo || ''
    };
    if (check.status === FEATURE_STATUS.APPROVED) {
      // Starts a little later, not now: makes a quick fake-and-go less worth it.
      var startMs = Date.now() + featureStartDelayHours() * 3600000;
      update.StartsAt = new Date(startMs).toISOString();
      update.EndsAt = new Date(startMs + Number(fresh.Days) * 86400000).toISOString();
      update.ViewsAtStartJson = JSON.stringify(productViewsSnapshot(fresh));
    }
    updateRowFromObject(sheet, fresh.__row, update);
  } finally {
    lock.releaseLock();
  }
  if (check.status === FEATURE_STATUS.APPROVED) invalidateCache([TIPS_CACHE_KEY, PAID_FEATURED_CACHE_KEY]);
  if (check.status === FEATURE_STATUS.PENDING) notifyAdminsOfFeaturePayment(owner, row, check.notes);

  var updated = findRowById(sheet, 'PurchaseId', row.PurchaseId) || row;
  return ok({ purchase: publicFeaturePurchase(updated), message: check.message });
}

/* ==================== Admin actions ==================== */

/** Pending review first, then everything else, newest first - with the screenshot link and OCR notes. */
function actionListFeaturePurchases(owner) {
  if (!isOwnerAdmin(owner)) return fail('Not authorized');
  var storeNames = {};
  sheetToObjects(getSheet('Owners')).forEach(function (o) { storeNames[o.OwnerId] = o.StoreName; });
  var productNames = {};
  sheetToObjects(getSheet('Products')).forEach(function (p) { productNames[p.ProductId] = p.Name; });
  var rows = sheetToObjects(getFeaturePurchasesSheet())
    .filter(function (r) { return r.Status !== FEATURE_STATUS.AWAITING; })
    .sort(function (a, b) {
      var ap = a.Status === FEATURE_STATUS.PENDING, bp = b.Status === FEATURE_STATUS.PENDING;
      if (ap !== bp) return ap ? -1 : 1;
      return String(b.UpdatedAt).localeCompare(String(a.UpdatedAt));
    })
    .slice(0, 100)
    .map(function (r) {
      var p = publicFeaturePurchase(r, productNames);
      p.storeName = storeNames[r.OwnerId] || r.StoreSlug;
      p.screenshotUrl = r.ScreenshotUrl || '';
      p.ocrNotes = r.OcrNotes || '';
      p.bankMatchedAt = r.BankMatchedAt || '';
      return p;
    });
  return ok({ purchases: rows, bankMatchDays: featureBankMatchDays() });
}

/** body.purchaseId, body.approve: boolean. Approving starts the featuring now, for the days bought. */
function actionSetFeaturePurchaseStatus(owner, body) {
  if (!isOwnerAdmin(owner)) return fail('Not authorized');
  var sheet = getFeaturePurchasesSheet();
  // Same lock as payment uploads, so an admin decision and an upload can't
  // interleave on one purchase or one bank receipt.
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  var update, row;
  try {
    row = findRowById(sheet, 'PurchaseId', String(body.purchaseId || ''));
    if (!row) return fail('Purchase not found.');
    if (row.Status === FEATURE_STATUS.AWAITING) return fail('No payment has been uploaded for this purchase yet.');
    var now = nowIso();
    update = { UpdatedAt: now, OcrNotes: String(row.OcrNotes || '') + ' | admin ' + (body.approve ? 'approved' : 'rejected') + ' ' + now };
    if (body.approve) {
      if (row.Status === FEATURE_STATUS.APPROVED) return fail('Already approved.');
      var paid = Number(row.Amount) > 0;
      // A person approving a paid purchase must have seen the money arrive
      // ("Seen in bank & approve" sends bankSeen). Free featuring is exempt.
      if (paid && !row.BankMatchedAt && body.bankSeen !== true) {
        return fail('Check this payment arrived in the bank account first, then use "Seen in bank & approve".');
      }
      if (paid && row.ReceiptNo) {
        var receipt = String(row.ReceiptNo).toUpperCase();
        var taken = sheetToObjects(sheet).some(function (r) {
          return r.PurchaseId !== row.PurchaseId && String(r.ReceiptNo || '').toUpperCase() === receipt &&
            (r.Status === FEATURE_STATUS.APPROVED || r.Status === FEATURE_STATUS.PENDING || r.Status === FEATURE_STATUS.STOPPED);
        });
        if (taken) return fail('That bank receipt (Reference Number ' + receipt + ') is already used by another purchase.');
      }
      if (paid && !row.BankMatchedAt) update.BankMatchedAt = now;
      update.Status = FEATURE_STATUS.APPROVED;
      update.StartsAt = now;
      update.EndsAt = new Date(Date.now() + Number(row.Days) * 86400000).toISOString();
      update.ViewsAtStartJson = JSON.stringify(productViewsSnapshot(row));
      update.ViewsAtEndJson = '';
    } else {
      update.Status = FEATURE_STATUS.REJECTED;
      update.StartsAt = '';
      update.EndsAt = '';
      update.ViewsAtStartJson = '';
      update.ViewsAtEndJson = '';
    }
    updateRowFromObject(sheet, row.__row, update);
  } finally {
    lock.releaseLock();
  }
  invalidateCache([TIPS_CACHE_KEY, PAID_FEATURED_CACHE_KEY]);
  return ok({ purchaseId: row.PurchaseId, status: update.Status });
}

/**
 * body.purchaseId, body.matched: boolean. The admin's tick that this payment
 * was seen arriving in the bank account - the one check no screenshot can
 * fake. Only paid purchases that went past Awaiting payment can be ticked.
 */
function actionSetFeatureBankMatched(owner, body) {
  if (!isOwnerAdmin(owner)) return fail('Not authorized');
  var sheet = getFeaturePurchasesSheet();
  var row = findRowById(sheet, 'PurchaseId', String(body.purchaseId || ''));
  if (!row) return fail('Purchase not found.');
  if (Number(row.Amount) === 0) return fail('Free featuring - nothing to match.');
  if (row.Status === FEATURE_STATUS.AWAITING) return fail('No payment has been uploaded for this purchase yet.');
  var at = body.matched ? nowIso() : '';
  updateRowFromObject(sheet, row.__row, { BankMatchedAt: at });
  return ok({ purchaseId: row.PurchaseId, bankMatchedAt: at });
}

/* ==================== Bank matching: reminders and auto-stop ==================== */

// Paid featuring approved automatically must be ticked "Seen in bank" within
// this many days of starting, or it stops (owner's call, Oct 2026). Admins are
// emailed 2 days and 1 day before. Free featuring is never affected.
var FEATURE_BANK_REMINDER_DEFAULT = ['admin@mwakete.com', 'motenakau@gmail.com', 'mootenakau@gmail.com'];
var FEATURE_BANK_REMINDED_KEY = 'FEATURE_BANK_REMINDED';

function featureBankMatchDays() {
  var v = Number(PropertiesService.getScriptProperties().getProperty('FEATURE_BANK_MATCH_DAYS'));
  return v > 0 ? v : 7;
}

/** Who gets the "tick these in the bank" emails. Script Property FEATURE_BANK_REMINDER_EMAILS (comma-separated) overrides. */
function featureBankReminderEmails() {
  var raw = PropertiesService.getScriptProperties().getProperty('FEATURE_BANK_REMINDER_EMAILS');
  var list = raw ? String(raw).split(',') : FEATURE_BANK_REMINDER_DEFAULT;
  return list.map(function (e) { return String(e).trim(); }).filter(function (e) { return /@/.test(e); });
}

/**
 * Pure: what the hourly sweep should do. Paid, approved, not yet ticked, and
 * started: past its deadline -> stop; within 1 day -> 1-day reminder; within
 * 2 days -> 2-day reminder (each reminder once - `sent` records them).
 */
function featureBankMatchPlan(rows, nowMs, days, sent) {
  var plan = { stop: [], remind2: [], remind1: [] };
  sent = sent || {};
  rows.forEach(function (r) {
    if (r.Status !== FEATURE_STATUS.APPROVED || !(Number(r.Amount) > 0) || r.BankMatchedAt) return;
    var start = new Date(r.StartsAt).getTime();
    if (isNaN(start)) return;
    var deadline = start + days * 86400000;
    var left = deadline - nowMs;
    var item = { row: r, deadline: deadline };
    var done = sent[r.PurchaseId] || {};
    if (left <= 0) plan.stop.push(item);
    else if (left <= 86400000) { if (!done['1']) plan.remind1.push(item); }
    else if (left <= 2 * 86400000) { if (!done['2']) plan.remind2.push(item); }
  });
  return plan;
}

function featureBankReminderBody(items, whenText, storeNames) {
  var adminUrl = siteBaseUrl() ? siteBaseUrl() + '/owner/admin.html' : '';
  return 'These paid featurings have not been ticked "Seen in bank" yet. They stop ' + whenText +
    ' unless the money is found in the bank account and ticked in Admin.\n\n' +
    items.map(function (it) {
      var r = it.row;
      return '- ' + (storeNames[r.OwnerId] || r.StoreSlug) + ': ref ' + r.Reference + ', $' + Number(r.Amount).toFixed(2) +
        (r.ReceiptNo ? ', bank Reference Number ' + r.ReceiptNo : '') +
        ' - stops ' + new Date(it.deadline).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
    }).join('\n') +
    '\n\n' + (adminUrl ? 'Tick them here: ' + adminUrl + '\n' : 'Tick them in Admin > Featuring payments.\n');
}

/** Hourly (Reminders.gs sweep): email the 2-day and 1-day reminders, and stop what is past its deadline. */
function sweepFeatureBankMatches() {
  var sheet = SpreadsheetApp.getActive().getSheetByName('FeaturePurchases');
  if (!sheet) return;
  var props = PropertiesService.getScriptProperties();
  var sent = {};
  try { sent = JSON.parse(props.getProperty(FEATURE_BANK_REMINDED_KEY) || '{}'); } catch (e) { sent = {}; }
  var days = featureBankMatchDays();
  var now = Date.now();
  var rows = sheetToObjects(getFeaturePurchasesSheet());
  var plan = featureBankMatchPlan(rows, now, days, sent);
  var storeNames = {};
  var owners = {};
  sheetToObjects(getSheet('Owners')).forEach(function (o) { storeNames[o.OwnerId] = o.StoreName; owners[o.OwnerId] = o; });
  var to = featureBankReminderEmails();

  [['2', plan.remind2, 'in about 2 days'], ['1', plan.remind1, 'within 1 day']].forEach(function (stage) {
    if (!stage[1].length) return;
    var body = featureBankReminderBody(stage[1], stage[2], storeNames);
    var subject = 'Mwakete: ' + stage[1].length + ' featuring payment' + (stage[1].length === 1 ? '' : 's') +
      ' to tick in the bank - stops ' + stage[2];
    to.forEach(function (addr) {
      try { sendAppEmail(addr, subject, body); } catch (e) { Logger.log('bank reminder failed: ' + e); }
    });
    stage[1].forEach(function (it) {
      sent[it.row.PurchaseId] = sent[it.row.PurchaseId] || {};
      sent[it.row.PurchaseId][stage[0]] = new Date(now).toISOString();
    });
  });

  if (plan.stop.length) {
    var lock = LockService.getScriptLock();
    lock.waitLock(30000);
    var stopped = [];
    try {
      plan.stop.forEach(function (it) {
        var fresh = findRowById(sheet, 'PurchaseId', it.row.PurchaseId);
        // Re-checked under the lock: it may have been ticked a moment ago.
        if (!fresh || fresh.Status !== FEATURE_STATUS.APPROVED || fresh.BankMatchedAt) return;
        var at = new Date(now).toISOString();
        updateRowFromObject(sheet, fresh.__row, {
          Status: FEATURE_STATUS.STOPPED, EndsAt: at, UpdatedAt: at,
          OcrNotes: String(fresh.OcrNotes || '') + ' | auto-stopped ' + at + ': not seen in bank within ' + days + ' days'
        });
        stopped.push(fresh);
      });
    } finally {
      lock.releaseLock();
    }
    if (stopped.length) {
      invalidateCache([TIPS_CACHE_KEY, PAID_FEATURED_CACHE_KEY]);
      var adminBody = 'Stopped because the payment was not ticked "Seen in bank" within ' + days + ' days:\n\n' +
        stopped.map(function (r) { return '- ' + (storeNames[r.OwnerId] || r.StoreSlug) + ': ref ' + r.Reference + ', $' + Number(r.Amount).toFixed(2); }).join('\n') +
        '\n\nIf one of these was really paid, tick it in Admin and use "Seen in bank & approve" to restart it.\n';
      to.forEach(function (addr) {
        try { sendAppEmail(addr, 'Mwakete: ' + stopped.length + ' featuring stopped - payment not seen in bank', adminBody); } catch (e) { Logger.log('bank stop notice failed: ' + e); }
      });
      // The seller is told too, so a real payer can get in touch.
      stopped.forEach(function (r) {
        var o = owners[r.OwnerId];
        if (!o || !o.Email) return;
        try {
          sendAppEmail(o.Email, 'Your Mwakete featuring has been stopped',
            'Hi ' + o.StoreName + ',\n\nWe could not find your payment of $' + Number(r.Amount).toFixed(2) +
            ' (reference ' + r.Reference + ') in our bank account, so this featuring has been stopped.\n\n' +
            'If you did pay, reply to this email or contact admin@mwakete.com with your bank receipt and we will restart it.\n');
        } catch (e) { Logger.log('seller stop notice failed: ' + e); }
      });
    }
  }

  // Keep the record small: forget purchases that no longer need reminding.
  var live = {};
  rows.forEach(function (r) { if (r.Status === FEATURE_STATUS.APPROVED && !r.BankMatchedAt) live[r.PurchaseId] = true; });
  Object.keys(sent).forEach(function (id) { if (!live[id]) delete sent[id]; });
  props.setProperty(FEATURE_BANK_REMINDED_KEY, JSON.stringify(sent));
}

/* ==================== What's currently featured ==================== */

/** Product ids with an Approved purchase whose window includes now - merged into Tips by buildTips. */
function activePaidFeaturedProductIds() {
  var sheet = SpreadsheetApp.getActive().getSheetByName('FeaturePurchases');
  if (!sheet) return [];
  var now = Date.now();
  var ids = [];
  sheetToObjects(sheet).forEach(function (r) {
    if (r.Status !== FEATURE_STATUS.APPROVED || !r.StartsAt || !r.EndsAt) return;
    if (new Date(r.StartsAt).getTime() > now || new Date(r.EndsAt).getTime() <= now) return;
    var list = [];
    try { list = JSON.parse(r.ProductIdsJson || '[]'); } catch (e) { list = []; }
    list.forEach(function (id) { if (ids.indexOf(String(id)) === -1) ids.push(String(id)); });
  });
  return ids;
}

/* ==================== "Featured" badge on product cards ==================== */

// Set outside the product-list caches (applied per response in Code.gs), so a
// badge appears within this key's 5 minutes of approval or expiry rather than
// waiting on each list's own cache.
var PAID_FEATURED_CACHE_KEY = 'v1:paidFeaturedIds';

function paidFeaturedIdsCached() {
  var cache = CacheService.getScriptCache();
  var hit = cache.get(PAID_FEATURED_CACHE_KEY);
  if (hit) { try { return JSON.parse(hit); } catch (e) { /* rebuild */ } }
  var ids = activePaidFeaturedProductIds();
  try { cache.put(PAID_FEATURED_CACHE_KEY, JSON.stringify(ids), 300); } catch (e) { /* best effort */ }
  return ids;
}

/** Marks res.products[i].featured on a public product-list response; passes anything else through. */
function markPaidFeatured(res) {
  if (!res || !res.ok || !Array.isArray(res.products) || !res.products.length) return res;
  var ids = paidFeaturedIdsCached();
  res.products.forEach(function (p) { if (p) p.featured = ids.indexOf(String(p.productId)) !== -1; });
  return res;
}

/* ==================== Results: views while featured ==================== */

/** { productId: Views } for a purchase's products, read now from the Products tab. */
function productViewsSnapshot(row) {
  var ids = [];
  try { ids = JSON.parse(row.ProductIdsJson || '[]').map(String); } catch (e) { ids = []; }
  var snap = {};
  sheetToObjects(getSheet('Products')).forEach(function (p) {
    if (ids.indexOf(String(p.ProductId)) !== -1) snap[p.ProductId] = Number(p.Views) || 0;
  });
  return snap;
}

/**
 * Pure: views each product gained while featured - the end snapshot (or the
 * live count while still running) minus the start snapshot. null when there
 * is no start snapshot (not approved, or approved before this was added).
 */
function featureViewsGained(row, currentViews) {
  var start, end = null;
  try { start = JSON.parse(row.ViewsAtStartJson || 'null'); } catch (e) { start = null; }
  if (!start || typeof start !== 'object') return null;
  try { end = JSON.parse(row.ViewsAtEndJson || 'null'); } catch (e) { end = null; }
  var out = {};
  Object.keys(start).forEach(function (id) {
    var after = end && end[id] !== undefined ? end[id] : currentViews[id];
    out[id] = after === undefined ? 0 : Math.max(0, Number(after) - Number(start[id] || 0));
  });
  return out;
}

/** Called from runReminderSweep: freezes the Views count of windows that have ended. */
function recordFeatureEndViews() {
  var sheet = SpreadsheetApp.getActive().getSheetByName('FeaturePurchases');
  if (!sheet) return 0;
  sheet = getFeaturePurchasesSheet(); // makes sure the two Views columns exist
  var now = Date.now();
  var ended = sheetToObjects(sheet).filter(function (r) {
    return r.Status === FEATURE_STATUS.APPROVED && r.ViewsAtStartJson && !r.ViewsAtEndJson &&
      r.EndsAt && new Date(r.EndsAt).getTime() <= now;
  });
  ended.forEach(function (r) {
    updateRowFromObject(sheet, r.__row, { ViewsAtEndJson: JSON.stringify(productViewsSnapshot(r)) });
  });
  return ended.length;
}

/* ==================== Renewal reminders ==================== */

// One email per purchase, about a day before its featuring ends, with a link
// that reopens the Feature page with the same products and days ticked.
// Which purchases were already reminded lives in a Script Property, not a
// sheet column, so this needs no change to the FeaturePurchases tab.
var FEATURE_RENEW_NOTICE_MS = 24 * 60 * 60 * 1000;
var FEATURE_RENEW_SENT_KEY = 'FEATURE_RENEW_SENT';

/**
 * Pure: which Approved purchases are due a reminder at nowMs. Due = ends within
 * the next FEATURE_RENEW_NOTICE_MS, not already reminded, and not already
 * renewed (a later Approved or Pending-review purchase by the same store
 * covering every one of its products).
 */
function featureRenewalsDue(rows, nowMs, sent) {
  var productsOf = function (r) {
    try { return JSON.parse(r.ProductIdsJson || '[]').map(String); } catch (e) { return []; }
  };
  return rows.filter(function (r) {
    if (r.Status !== FEATURE_STATUS.APPROVED || !r.EndsAt || sent[r.PurchaseId]) return false;
    var ends = new Date(r.EndsAt).getTime();
    if (isNaN(ends) || ends <= nowMs || ends - nowMs > FEATURE_RENEW_NOTICE_MS) return false;
    var mine = productsOf(r);
    var renewed = rows.some(function (o) {
      if (o.PurchaseId === r.PurchaseId || o.OwnerId !== r.OwnerId) return false;
      if (o.Status !== FEATURE_STATUS.APPROVED && o.Status !== FEATURE_STATUS.PENDING) return false;
      if (String(o.CreatedAt) <= String(r.CreatedAt)) return false;
      var theirs = productsOf(o);
      return mine.every(function (id) { return theirs.indexOf(id) !== -1; });
    });
    return !renewed;
  });
}

/** Called from runReminderSweep (Reminders.gs) on its hourly trigger. */
function sendFeatureRenewalReminders() {
  var sheet = SpreadsheetApp.getActive().getSheetByName('FeaturePurchases');
  if (!sheet) return 0;
  var props = PropertiesService.getScriptProperties();
  var sent = {};
  try { sent = JSON.parse(props.getProperty(FEATURE_RENEW_SENT_KEY) || '{}'); } catch (e) { sent = {}; }
  var now = Date.now();
  // Forget reminders for windows that have ended - keeps the property small.
  Object.keys(sent).forEach(function (id) { if (new Date(sent[id]).getTime() <= now) delete sent[id]; });

  var rows = sheetToObjects(sheet);
  var due = featureRenewalsDue(rows, now, sent);
  if (due.length) {
    var owners = {};
    sheetToObjects(getSheet('Owners')).forEach(function (o) { owners[o.OwnerId] = o; });
    var names = {};
    sheetToObjects(getSheet('Products')).forEach(function (p) { names[p.ProductId] = p.Name; });
    due.forEach(function (r) {
      var owner = owners[r.OwnerId];
      // Marked as handled even when skipped, so a store without an email
      // isn't re-checked every hour until the window ends.
      sent[r.PurchaseId] = r.EndsAt;
      if (!owner || owner.Status !== 'active' || !owner.Email) return;
      sendAppEmail(owner.Email, 'Your featured products end tomorrow - renew?', featureRenewalEmailBody(owner, publicFeaturePurchase(r, names)));
    });
  }
  props.setProperty(FEATURE_RENEW_SENT_KEY, JSON.stringify(sent));
  return due.length;
}

function featureRenewalEmailBody(owner, p) {
  var base = siteBaseUrl();
  var link = base ? base + '/owner/feature.html?renew=' + encodeURIComponent(p.purchaseId) : '';
  var ends = new Date(p.endsAt);
  return 'Hi ' + owner.StoreName + ',\n\n' +
    'Your featured products stop being featured on ' + ends.toDateString() + ':\n\n' +
    p.productNames.map(function (n) { return '- ' + n; }).join('\n') + '\n\n' +
    'To keep them at the top of Tips, renew for another ' + p.days + ' day' + (p.days === 1 ? '' : 's') +
    ' ($' + featureAmountFor(p.productIds.length, p.days).toFixed(2) + ').\n\n' +
    (link
      ? 'Renew here - the same products and days are already chosen:\n' + link + '\n'
      : 'To renew, open Feature products from your store dashboard.\n') +
    '\nIf you\'d rather let it end, you can ignore this email.';
}

/* ==================== Screenshot checks (ported from topup) ==================== */

function isValidPaymentImage(bytes, mimeType) {
  if (['image/png', 'image/jpeg', 'image/jpg', 'image/webp'].indexOf(mimeType) === -1) return false;
  if (!bytes || bytes.length < 12) return false;
  var b = function (i) { return bytes[i] & 0xff; };
  var isPng = b(0) === 0x89 && b(1) === 0x50 && b(2) === 0x4e && b(3) === 0x47;
  var isJpeg = b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff;
  var isWebp = b(0) === 0x52 && b(1) === 0x49 && b(2) === 0x46 && b(3) === 0x46;
  return isPng || isJpeg || isWebp;
}

function featureMinImageBytes() {
  return Number(PropertiesService.getScriptProperties().getProperty('FEATURE_MIN_IMAGE_BYTES') || '15000');
}

/** A camera photo carries EXIF. Recorded in the notes only, as in topup - some Android phones save screenshots as JPEGs with EXIF too. */
function imageHasExif(bytes) {
  for (var i = 0; i < bytes.length - 4; i++) {
    if (bytes[i] === 0x45 && bytes[i + 1] === 0x78 && bytes[i + 2] === 0x69 && bytes[i + 3] === 0x66) return true;
  }
  return false;
}

function sha256Hex(bytes) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, bytes).map(function (x) {
    var h = (x & 0xff).toString(16);
    return h.length === 1 ? '0' + h : h;
  }).join('');
}

function normalizeOcr(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, '');
}

function ocrHas(ocrText, needle) {
  return normalizeOcr(ocrText).indexOf(normalizeOcr(needle)) !== -1;
}

/** First "$1.05" / "AUD 1.05" style figure on the receipt, or null. */
function ocrPaidAmount(ocrText) {
  var m = String(ocrText || '').match(/(?:AUD|NZD|USD|\$)\s?([0-9]+\.[0-9]{2})/i);
  if (!m) return null;
  var v = parseFloat(m[1]);
  return isNaN(v) ? null : v;
}

/** Full amount or more. Falls back to finding the exact figure when no "$x.xx" can be parsed. */
function ocrAmountCovers(ocrText, amount) {
  var paid = ocrPaidAmount(ocrText);
  if (paid === null) return ocrHas(ocrText, Number(amount).toFixed(2));
  return Math.round((paid - Number(amount)) * 100) >= 0;
}

// "receipt" is deliberately NOT a success word: our own page says it.
function ocrHasSuccessWord(ocrText) {
  return /(successful|completed|confirmed|approved|success|posted)/i.test(ocrText);
}

/**
 * A screenshot of Mwakete's own pay page or the drawn example receipt. Both
 * carry the account, reference and amount, so without this they would pass
 * every other check. Matches the words those screens show; spacing-blind.
 */
function ocrLooksLikeMwaketePage(ocrText) {
  var t = String(ocrText || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return ['example', 'copypaste', 'screenshotpaymentreceipt', 'uploadpayment', 'payandupload', 'featureyourproducts']
    .some(function (w) { return t.indexOf(w) !== -1; });
}

/** Some date on the receipt that ocrTooOld can read. */
function ocrHasDate(ocrText) {
  return ocrReceiptDate(ocrText) !== null;
}

/** The "Transfer Confirmation" / Confirm-and-Cancel screen a bank shows BEFORE sending - not proof of payment. */
function ocrLooksUnsubmitted(ocrText) {
  var t = String(ocrText || '').toLowerCase();
  if (/transfer confirmation/.test(t)) return true;
  return /\bconfirm\b/.test(t) && !/confirmed/.test(t) && /\bcancel\b/.test(t);
}

var OCR_MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** The first date on the receipt: 2026-10-08, 08/10/2026, 8 Oct 2026 or Oct 8, 2026. null if none. */
function ocrReceiptDate(ocrText) {
  var text = String(ocrText || '');
  var d = null;
  var m = text.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (!d && (m = text.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/))) d = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
  var mon = '(' + OCR_MONTHS.join('|') + ')[a-z]*\\.?';
  if (!d && (m = text.match(new RegExp('\\b(\\d{1,2})\\s*' + mon + ',?\\s*(\\d{4})', 'i')))) {
    d = new Date(Number(m[3]), OCR_MONTHS.indexOf(m[2].toLowerCase()), Number(m[1]));
  }
  if (!d && (m = text.match(new RegExp('\\b' + mon + '\\s*(\\d{1,2}),?\\s*(\\d{4})', 'i')))) {
    d = new Date(Number(m[3]), OCR_MONTHS.indexOf(m[1].toLowerCase()), Number(m[2]));
  }
  return d && !isNaN(d.getTime()) ? d : null;
}

function ocrTooOld(ocrText) {
  var maxHours = Number(PropertiesService.getScriptProperties().getProperty('FEATURE_MAX_PAYMENT_AGE_HOURS') || '72');
  var d = ocrReceiptDate(ocrText);
  if (!d) return false; // no date found - handled by the "dated" check, which sends it to a human
  return (Date.now() - d.getTime()) / 3600000 > maxHours;
}

/** Drive advanced service OCR - null when the service isn't switched on, so the caller can fall back to a human. */
function ocrPaymentImage(bytes, mimeType) {
  if (typeof Drive === 'undefined' || !Drive.Files) return null;
  var blob = Utilities.newBlob(bytes, mimeType, 'feature_ocr_' + Date.now());
  var file = Drive.Files.create
    ? Drive.Files.create({ name: blob.getName(), mimeType: 'application/vnd.google-apps.document' }, blob, { ocrLanguage: 'en' })
    : Drive.Files.insert({ title: blob.getName() }, blob, { ocr: true, ocrLanguage: 'en' });
  try {
    return DocumentApp.openById(file.id).getBody().getText();
  } finally {
    DriveApp.getFileById(file.id).setTrashed(true);
  }
}

/**
 * Pure decision over the OCR text - kept apart from the Drive calls so it can
 * be tested directly (tests/test-featuring.js). ocrText null = OCR unavailable.
 */
function decideFeaturePayment(ocrText, purchase, isPhoto, ctx) {
  ctx = ctx || {};
  if (ocrText === null) {
    return { status: FEATURE_STATUS.PENDING, notes: 'OCR unavailable (Drive API service not enabled)',
      message: 'Thanks - your payment is waiting for a quick check by Mwakete. Your products will be featured as soon as it is approved.' };
  }
  var checks = {
    reference: ocrHas(ocrText, purchase.Reference),
    account: ocrHas(ocrText, FEATURE_PAY_ACCOUNT_NUMBER),
    amount: ocrAmountCovers(ocrText, purchase.Amount),
    success: ocrHasSuccessWord(ocrText),
    submitted: !ocrLooksUnsubmitted(ocrText),
    recent: !ocrTooOld(ocrText),
    dated: ocrHasDate(ocrText),
    notOurPage: !ocrLooksLikeMwaketePage(ocrText)
  };
  // 1. Paid on or after the day this order (and its reference) was created.
  var receiptDay = ocrReceiptDay(ocrText);
  var createdMs = new Date(purchase.CreatedAt).getTime();
  checks.afterOrder = !receiptDay || isNaN(createdMs) || receiptDay >= featureLocalDay(createdMs);
  // 2. The bank's own number for this transfer, used once only.
  var receiptNo = ocrReceiptNumber(ocrText, purchase);
  checks.receiptNo = !!receiptNo;
  checks.receiptUnused = !receiptNo || (ctx.usedReceiptNumbers || []).indexOf(receiptNo) === -1;
  var notes = Object.keys(checks).map(function (k) { return k + ':' + checks[k]; }).join(' ') +
    ' photo:' + !!isPhoto + ' paid:' + ocrPaidAmount(ocrText) + (receiptNo ? ' receiptNo:' + receiptNo : '');
  var pending = function (why) {
    return { status: FEATURE_STATUS.PENDING, notes: notes + ' (' + why + ')', receiptNo: receiptNo,
      message: 'Thanks - your payment is waiting for a quick check by Mwakete. Your products will be featured as soon as it is approved.' };
  };

  if (!checks.notOurPage) {
    return { status: FEATURE_STATUS.REJECTED, notes: notes + ' (Mwakete page or example)',
      message: 'That is a screenshot of the Mwakete page or the example, not your bank\'s receipt. Please pay in your banking app, then upload the receipt screen it shows.' };
  }
  if (!checks.submitted) {
    return { status: FEATURE_STATUS.REJECTED, notes: notes,
      message: 'That looks like the screen before you press Confirm in your bank app. Please finish the transfer, then upload the receipt screen that says it was successful.' };
  }
  var failed = ['reference', 'account', 'amount', 'success', 'recent'].filter(function (k) { return !checks[k]; });
  if (failed.length) {
    var why = {
      reference: 'the reference ' + purchase.Reference,
      account: 'the account number ' + FEATURE_PAY_ACCOUNT_NUMBER,
      amount: 'the full amount of $' + Number(purchase.Amount).toFixed(2),
      success: 'a "successful" or "completed" message',
      recent: 'a recent date'
    };
    return { status: FEATURE_STATUS.REJECTED, notes: notes,
      message: 'We couldn\'t confirm this payment - the screenshot needs to show ' +
        failed.map(function (k) { return why[k]; }).join(', ') + '. Please check and upload the receipt again.' };
  }
  if (!checks.afterOrder) {
    return { status: FEATURE_STATUS.REJECTED, notes: notes + ' (receipt before order)',
      message: 'That receipt is dated before you started this order. Please pay for this order (reference ' +
        purchase.Reference + ') and upload that receipt.' };
  }
  if (!checks.receiptUnused) {
    return { status: FEATURE_STATUS.REJECTED, notes: notes + ' (receipt number reused)',
      message: 'That bank receipt (Reference Number ' + receiptNo + ') has already been used for another payment.' };
  }
  // Couldn't read a date or the bank's number: the checks above couldn't fully run, so a human looks.
  if (!checks.dated) return pending('no date read');
  if (!checks.receiptNo) return pending('no receipt number read');
  // 4. Per-store weekly cap on automatic approval.
  var weekCap = featureWeeklyAutoMax(ctx.paidApprovedCount || 0);
  if (Math.round(((ctx.weekApproved || 0) + Number(purchase.Amount)) * 100) > Math.round(weekCap * 100)) {
    return pending('over weekly auto limit $' + weekCap);
  }
  var autoMax = Number(PropertiesService.getScriptProperties().getProperty('FEATURE_AUTO_APPROVE_MAX') || '20');
  if (Number(purchase.Amount) > autoMax) return pending('over auto-approve max');
  var hours = featureStartDelayHours();
  return { status: FEATURE_STATUS.APPROVED, notes: notes, receiptNo: receiptNo,
    message: hours > 0
      ? 'Payment confirmed - your products will be featured within ' + hours + ' hour' + (hours === 1 ? '' : 's') + '.'
      : 'Payment confirmed - your products are featured now.' };
}

/** Pure: is this screenshot (by file hash) on any OTHER purchase, whatever its status? */
function featureHashUsedElsewhere(rows, hash, purchaseId) {
  return rows.some(function (r) { return r.ScreenshotHash === hash && r.PurchaseId !== purchaseId; });
}

/** Hours between automatic approval and the featuring starting (Script Property, default 2). */
function featureStartDelayHours() {
  var raw = PropertiesService.getScriptProperties().getProperty('FEATURE_START_DELAY_HOURS');
  var v = Number(raw);
  return raw === null || raw === '' || isNaN(v) || v < 0 ? 2 : v;
}

/**
 * Pure: what decideFeaturePayment needs to know beyond the screenshot -
 * receipt numbers already used, and this store's recent paid approvals.
 */
function featureDecisionContext(rows, purchase, nowMs) {
  var weekAgo = nowMs - 7 * 86400000;
  var ctx = { usedReceiptNumbers: [], weekApproved: 0, paidApprovedCount: 0 };
  rows.forEach(function (r) {
    if (r.PurchaseId === purchase.PurchaseId) return;
    // A receipt claimed by an approved, pending or auto-stopped purchase is taken.
    var counts = r.Status === FEATURE_STATUS.APPROVED || r.Status === FEATURE_STATUS.PENDING || r.Status === FEATURE_STATUS.STOPPED;
    if (counts && r.ReceiptNo) ctx.usedReceiptNumbers.push(String(r.ReceiptNo).toUpperCase());
    if (r.OwnerId !== purchase.OwnerId || r.Status !== FEATURE_STATUS.APPROVED || !(Number(r.Amount) > 0)) return;
    ctx.paidApprovedCount++;
    var t = new Date(r.CreatedAt).getTime();
    if (!isNaN(t) && t >= weekAgo) ctx.weekApproved += Number(r.Amount);
  });
  ctx.weekApproved = Math.round(ctx.weekApproved * 100) / 100;
  return ctx;
}

/** Most a store can have approved automatically in 7 days; new stores get less until they've paid a few times. */
function featureWeeklyAutoMax(paidApprovedCount) {
  var props = PropertiesService.getScriptProperties();
  if (paidApprovedCount >= FEATURE_ESTABLISHED_AFTER_PAYMENTS) return Number(props.getProperty('FEATURE_STORE_WEEKLY_AUTO_MAX') || '20');
  return Number(props.getProperty('FEATURE_NEW_STORE_WEEKLY_AUTO_MAX') || '5');
}

/** 'YYYY-MM-DD' of a moment, in Kiribati (Tarawa) time. */
function featureLocalDay(ms) {
  var d = new Date(ms + FEATURE_LOCAL_UTC_OFFSET_HOURS * 3600000);
  return d.getUTCFullYear() + '-' + ('0' + (d.getUTCMonth() + 1)).slice(-2) + '-' + ('0' + d.getUTCDate()).slice(-2);
}

/** 'YYYY-MM-DD' of the date printed on the receipt, or '' if none was read. */
function ocrReceiptDay(ocrText) {
  var d = ocrReceiptDate(ocrText);
  if (!d) return '';
  return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
}

/**
 * The bank's own number for this transfer. ANZ goMoney labels it "Reference
 * Number" (e.g. AQC84078); other labels are accepted too. Falls back to the
 * first letters-then-digits code anywhere, since OCR can split a table's
 * labels from its values. Never the MWF reference or the account number.
 */
function ocrReceiptNumber(ocrText, purchase) {
  var text = String(ocrText || '');
  var mine = String((purchase && purchase.Reference) || '').toUpperCase();
  var usable = function (tok) {
    var t = String(tok || '').toUpperCase();
    return t.length >= 6 && t.length <= 16 && /\d{3}/.test(t) && t !== mine && t.indexOf('MWF') !== 0 &&
      t !== FEATURE_PAY_ACCOUNT_NUMBER && !/^\d+$/.test(t) && !/^(AUD|NZD|USD)\d/.test(t);
  };
  var labelled = /(?:reference\s*number|receipt\s*(?:no\.?|number|#)|transaction\s*(?:id|no\.?|number)|trace\s*(?:no\.?|number)|confirmation\s*(?:no\.?|number))\s*[:#.\-]?\s*([A-Za-z0-9]{6,16})/ig;
  var m;
  while ((m = labelled.exec(text))) { if (usable(m[1])) return m[1].toUpperCase(); }
  var loose = /\b([A-Z]{2,4}\d{4,10})\b/g;
  while ((m = loose.exec(text))) { if (usable(m[1])) return m[1]; }
  return '';
}

/* ---------- the image file itself ---------- */

/** Pure: { width, height, editor } from PNG / JPEG / WebP bytes (signed or unsigned). Unknown parts are 0 / ''. */
function imageInfo(bytes) {
  var b = function (i) { return bytes[i] & 0xff; };
  var n = bytes.length;
  var info = { width: 0, height: 0, editor: '' };
  if (n > 24 && b(0) === 0x89 && b(1) === 0x50) {
    info.width = ((b(16) << 24) | (b(17) << 16) | (b(18) << 8) | b(19)) >>> 0;
    info.height = ((b(20) << 24) | (b(21) << 16) | (b(22) << 8) | b(23)) >>> 0;
  } else if (n > 4 && b(0) === 0xff && b(1) === 0xd8) {
    var i = 2;
    while (i + 9 < n && b(i) === 0xff) {
      var marker = b(i + 1);
      var len = (b(i + 2) << 8) | b(i + 3);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        info.height = (b(i + 5) << 8) | b(i + 6);
        info.width = (b(i + 7) << 8) | b(i + 8);
        break;
      }
      if (len < 2) break;
      i += 2 + len;
    }
  } else if (n > 30 && b(8) === 0x57 && b(9) === 0x45 && b(10) === 0x42 && b(11) === 0x50) {
    var kind = String.fromCharCode(b(12), b(13), b(14), b(15));
    if (kind === 'VP8 ') {
      info.width = ((b(27) << 8) | b(26)) & 0x3fff;
      info.height = ((b(29) << 8) | b(28)) & 0x3fff;
    } else if (kind === 'VP8L') {
      info.width = 1 + (((b(22) & 0x3f) << 8) | b(21));
      info.height = 1 + (((b(24) & 0x0f) << 10) | (b(23) << 2) | ((b(22) & 0xc0) >> 6));
    } else if (kind === 'VP8X') {
      info.width = 1 + (b(24) | (b(25) << 8) | (b(26) << 16));
      info.height = 1 + (b(27) | (b(28) << 8) | (b(29) << 16));
    }
  }
  info.editor = imageEditorTag(bytes);
  return info;
}

// Names photo editors write into a file's metadata (EXIF Software, XMP
// CreatorTool, PNG text). Case-sensitive and 5+ characters, so random image
// data practically never matches. A phone's own screenshot carries none.
var IMAGE_EDITOR_TAGS = ['Photoshop', 'Lightroom', 'Snapseed', 'PicsArt', 'Picsart', 'Canva', 'Created with GIMP',
  'Pixlr', 'Fotor', 'PhotoDirector', 'Polarr', 'Meitu', 'InShot', 'Photopea', 'paint.net', 'Affinity Photo',
  'Pixelmator', 'Facetune', 'PicMonkey', 'PhotoRoom'];

/** The editor named in the file's metadata, or ''. Looks at the start and end, where metadata lives. */
function imageEditorTag(bytes) {
  var parts = [];
  var take = function (from, to) {
    var chunk = [];
    for (var i = Math.max(0, from); i < Math.min(bytes.length, to); i++) chunk.push(bytes[i] & 0xff);
    for (var j = 0; j < chunk.length; j += 8192) parts.push(String.fromCharCode.apply(null, chunk.slice(j, j + 8192)));
  };
  take(0, 131072);
  if (bytes.length > 131072) take(bytes.length - 65536, bytes.length);
  var text = parts.join('');
  for (var k = 0; k < IMAGE_EDITOR_TAGS.length; k++) {
    if (text.indexOf(IMAGE_EDITOR_TAGS[k]) !== -1) return IMAGE_EDITOR_TAGS[k];
  }
  return '';
}

/** Pure: a message refusing the file, or '' if it looks like an untouched phone screenshot. */
function featureImageProblem(info) {
  if (info.editor) {
    return 'That image has been through a photo editor (' + info.editor + '). Please upload the screenshot exactly as your phone saved it - not edited or cropped.';
  }
  if (!info.width || !info.height) return ''; // size unreadable - let the other checks decide
  var ratio = info.height / info.width;
  if (info.width < 300 || ratio < 1.3 || ratio > 2.7) {
    return 'That doesn\'t look like a full phone screenshot. Please upload the whole receipt screen exactly as your phone saved it - not cropped, rotated or a photo of it.';
  }
  return '';
}

/** Private Drive folder - never shared by link; these are banking screenshots. Only admins open them. */
function saveFeatureScreenshot(bytes, mimeType, purchaseId) {
  var props = PropertiesService.getScriptProperties();
  var folder = null;
  var folderId = props.getProperty('FEATURE_SCREENSHOT_FOLDER_ID');
  if (folderId) {
    try { folder = DriveApp.getFolderById(folderId); } catch (e) { folder = null; }
  }
  if (!folder) {
    folder = DriveApp.createFolder('Mwakete Featuring Payments');
    props.setProperty('FEATURE_SCREENSHOT_FOLDER_ID', folder.getId());
  }
  return folder.createFile(Utilities.newBlob(bytes, mimeType, 'payment_' + purchaseId + '_' + Date.now())).getUrl();
}

function isFeatureSubmitRateLimited(ownerId) {
  var cache = CacheService.getScriptCache();
  var key = 'v1:feature-submit:' + ownerId;
  var count = Number(cache.get(key) || '0');
  if (count >= FEATURE_SUBMITS_PER_HOUR) return true;
  try { cache.put(key, String(count + 1), 3600); } catch (e) { /* best effort */ }
  return false;
}

function notifyAdminsOfFeaturePayment(owner, purchase, notes) {
  var admins = getAdminEmails();
  if (!admins.length) return;
  var adminUrl = siteBaseUrl() ? siteBaseUrl() + '/owner/admin.html' : '';
  var body = 'A featuring payment needs a check before it goes live.\n\n' +
    'Store: ' + owner.StoreName + '\n' +
    'Reference: ' + purchase.Reference + '\n' +
    'Amount: $' + Number(purchase.Amount).toFixed(2) + ' (' + purchase.Days + ' days)\n' +
    'Checks: ' + notes + '\n' +
    (adminUrl ? '\nApprove or reject it here: ' + adminUrl + '\n' : '');
  admins.forEach(function (to) {
    try { sendAppEmail(to, 'Featuring payment to check - ' + owner.StoreName, body); } catch (e) { Logger.log('feature notify failed: ' + e); }
  });
}
