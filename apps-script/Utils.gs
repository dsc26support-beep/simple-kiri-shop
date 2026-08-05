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

// Word-level fuzzy matching (mirrors assets/js/helpers.js's client-side
// version) - used server-side to re-validate delivery-method eligibility
// rather than trusting whatever the client claims is eligible.
function levenshteinDistance(a, b) {
  if (a === b) return 0;
  var m = a.length;
  var n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  var prevRow = [];
  for (var j = 0; j <= n; j++) prevRow[j] = j;
  for (var i = 1; i <= m; i++) {
    var currRow = [i];
    for (var j2 = 1; j2 <= n; j2++) {
      currRow[j2] = a[i - 1] === b[j2 - 1]
        ? prevRow[j2 - 1]
        : 1 + Math.min(prevRow[j2 - 1], prevRow[j2], currRow[j2 - 1]);
    }
    prevRow = currRow;
  }
  return prevRow[n];
}

function wordsAreEquivalent(a, b) {
  if (a === b) return true;
  return levenshteinDistance(a, b) <= 1;
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

/**
 * Script-wide cache for the read-heavy public actions (full-table Sheet
 * scans on every request otherwise). Keys are versioned ('v1:...') since
 * ScriptCache is script-scoped and survives redeploys - bumping the prefix
 * is a cheap way to guarantee a future response-shape change never serves
 * stale-shaped cached JSON.
 */
function getCached(key, ttlSeconds, producerFn) {
  var cache = CacheService.getScriptCache();
  var hit = cache.get(key);
  if (hit) return JSON.parse(hit);

  var value = producerFn();
  try {
    cache.put(key, JSON.stringify(value), ttlSeconds);
  } catch (e) {
    // Value too large for the ~100KB per-key cap - just skip caching this one.
    Logger.log('getCached: skipped caching ' + key + ' (' + e + ')');
  }
  return value;
}

function invalidateCache(keys) {
  CacheService.getScriptCache().removeAll(keys);
}

/**
 * Generic fixed-window rate counter backed by CacheService. The window is
 * anchored to the first hit, not refreshed on every call, so this is a true
 * "no more than maxCount per windowSeconds" cap rather than a rolling one
 * that never lets a saturated key cool down. Callers wrap this in
 * LockService.getScriptLock() around the read-increment-write, same as
 * every other check-then-write sequence in this codebase - this function
 * itself does not lock, matching Db.gs's helpers' convention of leaving
 * locking to the caller.
 */
function rateLimitHit(key, maxCount, windowSeconds) {
  var cache = CacheService.getScriptCache();
  var now = Date.now();
  var raw = cache.get(key);
  var state = raw ? JSON.parse(raw) : { count: 0, firstAt: now };
  state.count++;

  var ttlSeconds = Math.max(1, windowSeconds - Math.floor((now - state.firstAt) / 1000));
  try {
    cache.put(key, JSON.stringify(state), ttlSeconds);
  } catch (e) {
    // best effort - if the cache put fails for some reason, fail open rather than block real traffic
  }

  return state.count > maxCount;
}
