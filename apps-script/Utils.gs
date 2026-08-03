/**
 * Small shared helpers: JSON responses, id/reference generation, request parsing.
 *
 * Apps Script Web Apps always return HTTP 200 regardless of outcome, so every
 * response carries an explicit ok:true/false field that callers must check.
 */

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function ok(data) {
  var out = { ok: true };
  if (data) Object.keys(data).forEach(function (k) { out[k] = data[k]; });
  return out;
}

function fail(error) {
  return { ok: false, error: String(error) };
}

function newId(prefix) {
  return prefix + '_' + Utilities.getUuid().replace(/-/g, '').slice(0, 16);
}

function generateOrderRef(storeSlug) {
  var datePart = Utilities.formatDate(new Date(), 'UTC', 'yyyyMMdd');
  var rand = Math.floor(1000 + Math.random() * 9000);
  return 'SKS-' + storeSlug + '-' + datePart + '-' + rand;
}

function slugify(text) {
  return String(text)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-+|-+$)/g, '') || 'store';
}

function nowIso() {
  return new Date().toISOString();
}

function parsePostBody(e) {
  if (!e || !e.postData || !e.postData.contents) return {};
  try {
    return JSON.parse(e.postData.contents);
  } catch (err) {
    return {};
  }
}

function generateToken() {
  return Utilities.getUuid() + Utilities.getUuid();
}

function generate6DigitCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

/**
 * Sends mail via the script owner's Google account (MailApp) and swallows
 * failures (e.g. daily send quota exceeded) - callers already return a
 * generic success response regardless, so a delivery failure shouldn't leak
 * account existence or surface a confusing error to the caller.
 */
function sendAppEmail(to, subject, body) {
  try {
    MailApp.sendEmail(to, subject, body);
  } catch (e) {
    // best effort only
  }
}
