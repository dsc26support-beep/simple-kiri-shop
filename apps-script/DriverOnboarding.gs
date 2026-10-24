/**
 * Drive with Mwakete: identity, face check and contract (owner request, Oct 2026).
 *
 * A driver application (actionDriverApply, Deliveries.gs) now also carries:
 *  - Facebook Messenger and email (approval status is sent by Messenger);
 *  - ONE ID: KPF ID, National ID or passport - its type, number and a photo;
 *  - a live selfie from the face check on the phone (head turn + match with
 *    the ID photo, assets/js/driver-face.js). The check runs ON THE PHONE and
 *    can be fooled by a determined person, so its result is only advice: an
 *    admin still compares the selfie with the ID before approving
 *    (owner decision: the face step passes automatically, not the driver);
 *  - the signed driver agreement (driver-contract.html), signed either
 *    digitally (typed full name + drawn signature) or physically (photos of
 *    the signed printed pages).
 *
 * PRIVACY. The files go in a private Drive folder only the script account can
 * open; admins see them through actionAdminDriverDocs. They are deleted 90
 * days after a driver is rejected or suspended (purgeOldDriverDocs - install
 * its daily trigger with installDriverDocsTrigger, once, from the editor).
 * Only the ID type and number stay in the sheet.
 *
 * Drivers sheet columns added here (additive, ensureColumn):
 *   Messenger | IdType | IdNumber | IdFileId | SelfieFileId | FaceResult | FaceScore
 *   | ContractVersion | ContractMethod | ContractSignedName | ContractSignedAt
 *   | ContractFileIds | DocsDeletedAt
 */

var DRIVER_CONTRACT_VERSION = '2026-10-v1';
var DRIVER_ID_TYPES = { kpf: 'KPF ID', national: 'National ID', passport: 'Passport' };
var DRIVER_FACE_RESULTS = {
  passed: 'Face matched the ID photo',
  not_matched: 'Face did not match - check by eye',
  liveness_failed: 'Head-turn check not completed - check by eye',
  unsupported: 'Phone could not run the face check - check by eye'
};
var DRIVER_DOC_COLUMNS = ['Messenger', 'IdType', 'IdNumber', 'IdFileId', 'SelfieFileId', 'FaceResult', 'FaceScore',
  'ContractVersion', 'ContractMethod', 'ContractSignedName', 'ContractSignedAt', 'ContractFileIds', 'DocsDeletedAt'];
var DRIVER_DOCS_KEEP_DAYS = 90;

function driversSheetWithDocs() {
  var sheet = driversSheet();
  DRIVER_DOC_COLUMNS.forEach(function (c) { ensureColumn(sheet, c); });
  return sheet;
}

function getDriverDocsFolder() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('DRIVER_DOCS_FOLDER_ID');
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) { /* recreate */ } }
  // Never shared: only the account that runs the script can open these files.
  var folder = DriveApp.createFolder('Mwakete Driver Documents (private)');
  props.setProperty('DRIVER_DOCS_FOLDER_ID', folder.getId());
  return folder;
}

/** An image (or, for signed pages, a PDF) checked by its bytes. { bytes, sniff } or { error }. */
function driverDocFile(base64, what, allowPdf) {
  if (!base64) return { error: 'Add ' + what + '.' };
  var cfg = txConfig();
  var checked = validateTxFile(base64, '', Object.assign({}, cfg, { 'types.pdf': allowPdf ? 'on' : 'off' }));
  if (checked.error) return { error: what.charAt(0).toUpperCase() + what.slice(1) + ': ' + checked.error };
  if (!allowPdf && checked.sniff.type === 'application/pdf') return { error: 'Add a photo of ' + what + '.' };
  return checked;
}

/**
 * Checks everything the application adds (before anything is written).
 * Returns { error } or { fields, files } - files are written by
 * saveDriverDocs once the application itself is accepted.
 */
function checkDriverOnboarding(body, customer) {
  var messenger = messengerStoredValue(String(body.messenger || ''));
  if (!messenger) return { error: 'Enter your Facebook Messenger username or profile link - Mwakete sends your approval there.' };
  var email = normalizeEmail(body.email || customer.Email);
  if (!EMAIL_FORMAT_RE.test(email) || email.length > 254) return { error: 'Enter a valid email address.' };

  var idType = String(body.idType || '');
  if (!DRIVER_ID_TYPES[idType]) return { error: 'Choose your ID: KPF ID, National ID or passport.' };
  var idNumber = String(body.idNumber || '').trim().toUpperCase().replace(/\s+/g, '');
  if (!/^[A-Z0-9\-\/]{4,30}$/.test(idNumber)) return { error: 'Enter the number on your ' + DRIVER_ID_TYPES[idType] + ' (letters and numbers only).' };

  var idPhoto = driverDocFile(body.idPhotoBase64, 'a photo of your ID', false);
  if (idPhoto.error) return idPhoto;
  var selfie = driverDocFile(body.selfieBase64, 'your face photo from the face check', false);
  if (selfie.error) return selfie;
  var face = DRIVER_FACE_RESULTS[String(body.faceResult || '')] ? String(body.faceResult) : 'unsupported';
  var score = Number(body.faceScore);

  var c = body.contract || {};
  if (c.version !== DRIVER_CONTRACT_VERSION) return { error: 'The driver agreement has been updated. Please reload the page and read it again.' };
  var method = String(c.method || '');
  var signedName = txCleanText(c.signedName, 80);
  var contractFiles = [];
  if (method === 'digital') {
    if (c.agree !== true) return { error: 'Tick that you have read and agree to the driver agreement.' };
    if (signedName.length < 3) return { error: 'Type your full name to sign the agreement.' };
    var sig = driverDocFile(c.signatureBase64, 'your signature', false);
    if (sig.error) return { error: 'Draw your signature in the box.' };
    contractFiles.push({ checked: sig, label: 'signature' });
  } else if (method === 'physical') {
    var pages = Array.isArray(c.pagesBase64) ? c.pagesBase64.slice(0, 3) : [];
    if (pages.length < 1) return { error: 'Add photos of both signed pages of the agreement.' };
    for (var i = 0; i < pages.length; i++) {
      var pg = driverDocFile(pages[i], 'signed page ' + (i + 1), true);
      if (pg.error) return pg;
      contractFiles.push({ checked: pg, label: 'signed-page-' + (i + 1) });
    }
  } else {
    return { error: 'Sign the driver agreement - in the app, or print it and add photos of the signed pages.' };
  }

  return {
    fields: { Messenger: messenger, Email: email, IdType: idType, IdNumber: idNumber,
      FaceResult: face, FaceScore: isFinite(score) ? Math.round(score * 1000) / 1000 : '',
      ContractVersion: DRIVER_CONTRACT_VERSION, ContractMethod: method, ContractSignedName: method === 'digital' ? signedName : '',
      ContractSignedAt: nowIso(), DocsDeletedAt: '' },
    files: { id: idPhoto, selfie: selfie, contract: contractFiles }
  };
}

/** Writes the checked files to the private folder; returns the sheet fields that point at them. */
function saveDriverDocs(driverId, files) {
  var folder = getDriverDocsFolder();
  var put = function (checked, label) {
    return folder.createFile(Utilities.newBlob(checked.bytes, checked.sniff.type, driverId + '_' + label + txExtension(checked.sniff.type))).getId();
  };
  return {
    IdFileId: put(files.id, 'id'),
    SelfieFileId: put(files.selfie, 'selfie'),
    ContractFileIds: files.contract.map(function (f) { return put(f.checked, f.label); }).join(',')
  };
}

function trashDriverFiles(row) {
  [row.IdFileId, row.SelfieFileId].concat(String(row.ContractFileIds || '').split(',')).forEach(function (id) {
    if (!id) return;
    try { DriveApp.getFileById(String(id)).setTrashed(true); } catch (e) { /* already gone */ }
  });
}

/** What the admin list shows about a driver's documents (never the files themselves). */
function driverDocsSummary(d) {
  return {
    messenger: d.Messenger || '', idType: DRIVER_ID_TYPES[d.IdType] || '', idNumber: d.IdNumber || '',
    faceResult: d.FaceResult || '', faceLabel: DRIVER_FACE_RESULTS[d.FaceResult] || '', faceScore: d.FaceScore === '' ? null : d.FaceScore,
    contractMethod: d.ContractMethod || '', contractVersion: d.ContractVersion || '', contractSignedName: d.ContractSignedName || '',
    contractSignedAt: d.ContractSignedAt || '', hasDocs: !!(d.IdFileId && !d.DocsDeletedAt), docsDeletedAt: d.DocsDeletedAt || ''
  };
}

/** Admin: the ID photo, selfie and signed contract of one driver, as data URLs. body: driverId */
function actionAdminDriverDocs(owner, body) {
  if (!isOwnerAdmin(owner)) return denyAdmin(owner, 'adminDriverDocs');
  var row = findRowById(driversSheetWithDocs(), 'DriverId', String((body && body.driverId) || ''));
  if (!row) return fail('Driver not found');
  if (row.DocsDeletedAt) return fail('These documents were deleted on ' + String(row.DocsDeletedAt).slice(0, 10) + ' (kept 90 days after a driver stops).');
  var read = function (id, label) {
    if (!id) return null;
    try {
      var blob = DriveApp.getFileById(String(id)).getBlob();
      return { label: label, mimeType: blob.getContentType(), dataUrl: 'data:' + blob.getContentType() + ';base64,' + Utilities.base64Encode(blob.getBytes()) };
    } catch (e) { return { label: label, missing: true }; }
  };
  var contract = String(row.ContractFileIds || '').split(',').filter(String).map(function (id, i) {
    return read(id, row.ContractMethod === 'digital' ? 'Signature' : 'Signed page ' + (i + 1));
  });
  appendAudit({ actorId: owner.OwnerId, actorRole: 'admin', action: 'DRIVER_DOCS_VIEWED', entityType: 'driver', entityId: row.DriverId });
  return ok({ id: read(row.IdFileId, (DRIVER_ID_TYPES[row.IdType] || 'ID') + ' ' + (row.IdNumber || '')), selfie: read(row.SelfieFileId, 'Face check photo'),
    contract: contract, summary: driverDocsSummary(row) });
}

/**
 * Daily: deletes the ID photo, selfie and contract files of drivers rejected
 * or suspended more than 90 days ago. The row stays (with the ID type and
 * number) so the history still reads.
 */
function purgeOldDriverDocs() {
  var sheet = driversSheetWithDocs();
  var cutoff = Date.now() - DRIVER_DOCS_KEEP_DAYS * 86400000;
  var purged = 0;
  sheetToObjects(sheet).forEach(function (d) {
    if (d.DocsDeletedAt || ['rejected', 'suspended'].indexOf(String(d.Status)) === -1) return;
    var since = new Date(d.ReviewedAt || d.UpdatedAt).getTime();
    if (!(since < cutoff)) return;
    trashDriverFiles(d);
    updateRowFromObject(sheet, d.__row, { IdFileId: '', SelfieFileId: '', ContractFileIds: '', DocsDeletedAt: nowIso() });
    purged++;
  });
  return purged;
}

/** Run once from the Apps Script editor: purgeOldDriverDocs every day. */
function installDriverDocsTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'purgeOldDriverDocs') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('purgeOldDriverDocs').timeBased().everyDays(1).atHour(3).create();
}
