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
 * transfer is actually sent. Owner decision: same account as AM TOPUP.
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
 * Sheet: FeaturePurchases - created on first use with the headers below. It
 * holds payment records, so like Orders it is deliberately NOT in
 * REQUIRED_TABS, whose setupSheets "repair" rewrites header rows.
 */

var FEATURE_PRICE_PER_PRODUCT_DAY = 0.05;
var FEATURE_MAX_DAYS = 60;
var FEATURE_MAX_PRODUCTS = 30;
var FEATURE_PAY_ACCOUNT_NAME = 'Nei Recharge';
var FEATURE_PAY_ACCOUNT_NUMBER = '786149';
var FEATURE_SUBMITS_PER_HOUR = 10;

var FEATURE_PURCHASE_HEADERS = ['PurchaseId', 'OwnerId', 'StoreSlug', 'ProductIdsJson', 'Days', 'Amount',
  'Reference', 'Status', 'ScreenshotUrl', 'ScreenshotHash', 'OcrNotes', 'StartsAt', 'EndsAt',
  'CreatedAt', 'UpdatedAt'];

var FEATURE_STATUS = {
  AWAITING: 'Awaiting payment',
  PENDING: 'Pending review',
  APPROVED: 'Approved',
  REJECTED: 'Rejected'
};

function getFeaturePurchasesSheet() {
  var ss = SpreadsheetApp.getActive();
  var sheet = ss.getSheetByName('FeaturePurchases');
  if (sheet) return sheet;
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

  var amount = featureAmountFor(unique.length, days);
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  var row;
  try {
    var sheet = getFeaturePurchasesSheet();
    var now = nowIso();
    var purchaseId = newId('feat');
    appendRowFromObject(sheet, {
      PurchaseId: purchaseId,
      OwnerId: owner.OwnerId,
      StoreSlug: owner.StoreSlug,
      ProductIdsJson: JSON.stringify(unique),
      Days: days,
      Amount: amount,
      Reference: newFeatureReference(sheetToObjects(sheet)),
      Status: FEATURE_STATUS.AWAITING,
      ScreenshotUrl: '',
      ScreenshotHash: '',
      OcrNotes: '',
      StartsAt: '',
      EndsAt: '',
      CreatedAt: now,
      UpdatedAt: now
    });
    row = findRowById(sheet, 'PurchaseId', purchaseId);
  } finally {
    lock.releaseLock();
  }
  return ok({ purchase: publicFeaturePurchase(row), payment: featurePaymentDetails() });
}

/** Every purchase this store has made, newest first, plus where to pay. */
function actionListMyFeaturePurchases(owner) {
  var names = {};
  sheetToObjects(getSheet('Products')).forEach(function (p) {
    if (p.OwnerId === owner.OwnerId) names[p.ProductId] = p.Name;
  });
  var rows = sheetToObjects(getFeaturePurchasesSheet())
    .filter(function (r) { return r.OwnerId === owner.OwnerId; })
    .sort(function (a, b) { return String(b.CreatedAt).localeCompare(String(a.CreatedAt)); })
    .map(function (r) { return publicFeaturePurchase(r, names); });
  return ok({ purchases: rows, payment: featurePaymentDetails(), pricePerProductDay: FEATURE_PRICE_PER_PRODUCT_DAY });
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

  var hash = sha256Hex(bytes);
  var reused = sheetToObjects(sheet).some(function (r) { return r.ScreenshotHash === hash && r.PurchaseId !== row.PurchaseId; });
  if (reused) return fail('That screenshot has already been used for another payment.');

  var screenshotUrl = saveFeatureScreenshot(bytes, mimeType, row.PurchaseId);
  var check = checkFeaturePaymentScreenshot(bytes, mimeType, row);
  var now = nowIso();
  var update = {
    Status: check.status, ScreenshotUrl: screenshotUrl, ScreenshotHash: hash,
    OcrNotes: check.notes, UpdatedAt: now
  };
  if (check.status === FEATURE_STATUS.APPROVED) {
    update.StartsAt = now;
    update.EndsAt = new Date(Date.now() + Number(row.Days) * 86400000).toISOString();
  }
  updateRowFromObject(sheet, row.__row, update);
  if (check.status === FEATURE_STATUS.APPROVED) invalidateCache([TIPS_CACHE_KEY]);
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
      return p;
    });
  return ok({ purchases: rows });
}

/** body.purchaseId, body.approve: boolean. Approving starts the featuring now, for the days bought. */
function actionSetFeaturePurchaseStatus(owner, body) {
  if (!isOwnerAdmin(owner)) return fail('Not authorized');
  var sheet = getFeaturePurchasesSheet();
  var row = findRowById(sheet, 'PurchaseId', String(body.purchaseId || ''));
  if (!row) return fail('Purchase not found.');
  if (row.Status === FEATURE_STATUS.AWAITING) return fail('No payment has been uploaded for this purchase yet.');
  var now = nowIso();
  var update = { UpdatedAt: now, OcrNotes: String(row.OcrNotes || '') + ' | admin ' + (body.approve ? 'approved' : 'rejected') + ' ' + now };
  if (body.approve) {
    if (row.Status === FEATURE_STATUS.APPROVED) return fail('Already approved.');
    update.Status = FEATURE_STATUS.APPROVED;
    update.StartsAt = now;
    update.EndsAt = new Date(Date.now() + Number(row.Days) * 86400000).toISOString();
  } else {
    update.Status = FEATURE_STATUS.REJECTED;
    update.StartsAt = '';
    update.EndsAt = '';
  }
  updateRowFromObject(sheet, row.__row, update);
  invalidateCache([TIPS_CACHE_KEY]);
  return ok({ purchaseId: row.PurchaseId, status: update.Status });
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

function ocrHasSuccessWord(ocrText) {
  return /(successful|completed|confirmed|approved|receipt|success|posted)/i.test(ocrText);
}

/** The "Transfer Confirmation" / Confirm-and-Cancel screen a bank shows BEFORE sending - not proof of payment. */
function ocrLooksUnsubmitted(ocrText) {
  var t = String(ocrText || '').toLowerCase();
  if (/transfer confirmation/.test(t)) return true;
  return /\bconfirm\b/.test(t) && !/confirmed/.test(t) && /\bcancel\b/.test(t);
}

function ocrTooOld(ocrText) {
  var maxHours = Number(PropertiesService.getScriptProperties().getProperty('FEATURE_MAX_PAYMENT_AGE_HOURS') || '72');
  var text = String(ocrText || '');
  var d = null;
  var iso = text.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) d = new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
  if (!d) {
    var dmy = text.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
    if (dmy) d = new Date(Number(dmy[3]), Number(dmy[2]) - 1, Number(dmy[1]));
  }
  if (!d || isNaN(d.getTime())) return false; // no date found - more likely an OCR miss than a problem
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
function decideFeaturePayment(ocrText, purchase, isPhoto) {
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
    recent: !ocrTooOld(ocrText)
  };
  var notes = Object.keys(checks).map(function (k) { return k + ':' + checks[k]; }).join(' ') +
    ' photo:' + !!isPhoto + ' paid:' + ocrPaidAmount(ocrText);

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
  var autoMax = Number(PropertiesService.getScriptProperties().getProperty('FEATURE_AUTO_APPROVE_MAX') || '20');
  if (Number(purchase.Amount) > autoMax) {
    return { status: FEATURE_STATUS.PENDING, notes: notes + ' (over auto-approve max)',
      message: 'Thanks - your payment is waiting for a quick check by Mwakete. Your products will be featured as soon as it is approved.' };
  }
  return { status: FEATURE_STATUS.APPROVED, notes: notes,
    message: 'Payment confirmed - your products are featured now.' };
}

function checkFeaturePaymentScreenshot(bytes, mimeType, purchase) {
  var ocrText;
  try {
    ocrText = ocrPaymentImage(bytes, mimeType);
  } catch (e) {
    Logger.log('feature OCR failed: ' + e);
    ocrText = null;
  }
  return decideFeaturePayment(ocrText, purchase, imageHasExif(bytes));
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
