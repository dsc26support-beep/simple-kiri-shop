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

/**
 * SKS-<store>-<yyyyMMdd>-<4 digits>. The 4 digits are random, so two orders
 * for one store on one day could draw the same number (about 1 in 20 days for
 * a store taking 30 orders a day) - and every lookup by OrderId would then
 * find the older order. isTaken(ref), checked by the caller inside its lock,
 * makes it draw again; after 20 clashes in a row (a very busy day) two more
 * digits are added rather than fail the order.
 */
function generateOrderRef(storeSlug, isTaken) {
  var datePart = Utilities.formatDate(new Date(), 'UTC', 'yyyyMMdd');
  var base = 'SKS-' + storeSlug + '-' + datePart + '-';
  var ref;
  for (var i = 0; i < 40; i++) {
    ref = base + Math.floor(1000 + Math.random() * 9000) + (i >= 20 ? '-' + Math.floor(10 + Math.random() * 90) : '');
    if (!isTaken || !isTaken(ref)) return ref;
  }
  return ref + '-' + Date.now();
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

// From Utilities.getUuid (a cryptographically secure source), not
// Math.random, whose output can be predicted from earlier values.
function generate6DigitCode() {
  var n = parseInt(Utilities.getUuid().replace(/-/g, '').slice(0, 12), 16);
  return String(100000 + (n % 900000));
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
 * Resend (resend.com) is an opt-in swap for MailApp - see
 * docs/production-readiness-report.md Finding 9. MailApp's free-account
 * quota is ~100 emails/day, shared across every login code, password reset,
 * and reminder-sweep email this whole app sends; a transactional email
 * provider has a real (usually much higher, and monitorable) quota instead.
 * Both properties are required together - RESEND_FROM_EMAIL because Resend
 * requires a sender address on a domain you've verified with them (unlike
 * MailApp, which always sends as the script owner's own Gmail address with
 * zero configuration) - so there's no sane default to fall back to for it.
 */
function getResendConfig() {
  var props = PropertiesService.getScriptProperties();
  var apiKey = props.getProperty('RESEND_API_KEY');
  var fromEmail = props.getProperty('RESEND_FROM_EMAIL');
  if (!apiKey || !fromEmail) return null;
  return { apiKey: apiKey, fromEmail: fromEmail };
}

/** Returns true on a confirmed send, false on any failure (network, auth, Resend rejecting the request) - never throws, matching sendAppEmail's own best-effort contract. */
function sendViaResend(to, subject, body, config, htmlBody) {
  try {
    var payload = { from: config.fromEmail, to: [to], subject: subject, text: body };
    if (htmlBody) payload.html = htmlBody;
    var response = UrlFetchApp.fetch('https://api.resend.com/emails', {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + config.apiKey },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
    var result = JSON.parse(response.getContentText());
    return !!(result && result.id);
  } catch (e) {
    return false;
  }
}

/**
 * Sends mail via Resend when configured (see getResendConfig above),
 * falling back to MailApp - the original, always-available path - either
 * when Resend isn't configured at all, or when a configured Resend send
 * itself fails. Swallows every failure end to end (e.g. MailApp's own daily
 * quota exceeded) - callers already return a generic success response
 * regardless, so a delivery failure shouldn't leak account existence or
 * surface a confusing error to the caller. Trade-off worth stating plainly:
 * falling back to MailApp on a Resend failure means a misconfigured Resend
 * setup (e.g. an unverified from-domain) could go unnoticed for a while,
 * since emails would keep quietly arriving via MailApp instead of visibly
 * failing - accepted here as consistent with this function's existing
 * "never surface an error" philosophy, same category of trade-off as
 * MailApp's own quota-exceeded already being swallowed silently.
 */
function sendAppEmail(to, subject, body, htmlBody) {
  var resendConfig = getResendConfig();
  if (resendConfig && sendViaResend(to, subject, body, resendConfig, htmlBody)) return true;

  try {
    if (htmlBody) {
      MailApp.sendEmail(to, subject, body, { htmlBody: htmlBody });
    } else {
      MailApp.sendEmail(to, subject, body);
    }
    return true;
  } catch (e) {
    // best effort only
    return false;
  }
}

/**
 * Where this app is actually hosted (e.g. https://you.github.io/simple-kiri-shop),
 * so a notification email can link back to a page on the live site (e.g. the
 * vendor's Messages inbox) instead of just describing it in text. Optional -
 * Script Property, blank by default - callers that build a link must treat
 * '' as "no link available" and degrade to a plain-text-only email rather
 * than emitting a broken/relative URL.
 */
function siteBaseUrl() {
  var url = PropertiesService.getScriptProperties().getProperty('SITE_BASE_URL');
  return url ? String(url).replace(/\/+$/, '') : '';
}

/** Minimal HTML-escaping for values interpolated into an email's htmlBody - this app has no HTML-templating layer, so this is deliberately just the 5 characters that matter for breaking out of text/attribute context. */
function escapeHtmlForEmail(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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
  var hit = readCachedJson(cache, key);
  if (hit !== null) return hit;

  var value = producerFn();
  putCachedJson(cache, key, value, ttlSeconds);
  return value;
}

/*
 * ScriptCache holds at most ~100KB per key, and a big category's product list
 * is larger than that - it used to be skipped, so every visit to that category
 * re-read every sheet (Oct 2026: "categories feel very slow"). A large value
 * is now split over numbered part keys, with a small marker under the main
 * key: '~parts:<n>'. Parts are written together (putAll) and read together
 * (getAll); a missing part reads as a miss, never as half an answer.
 */
var CACHE_PART_CHARS = 90000;
var CACHE_PARTS_MAX = 20;

function readCachedJson(cache, key) {
  var hit = cache.get(key);
  if (!hit) return null;
  var m = /^~parts:(\d+)$/.exec(hit);
  if (!m) return JSON.parse(hit);
  var n = Number(m[1]);
  var keys = [];
  for (var i = 0; i < n; i++) keys.push(key + '#' + i);
  var got = cache.getAll(keys);
  var text = '';
  for (var j = 0; j < n; j++) {
    if (typeof got[keys[j]] !== 'string') return null;
    text += got[keys[j]];
  }
  try { return JSON.parse(text); } catch (e) { return null; }
}

function putCachedJson(cache, key, value, ttlSeconds) {
  var text = JSON.stringify(value);
  try {
    if (text.length <= CACHE_PART_CHARS) {
      cache.put(key, text, ttlSeconds);
      return true;
    }
    var n = Math.ceil(text.length / CACHE_PART_CHARS);
    if (n > CACHE_PARTS_MAX) throw new Error(n + ' parts');
    var parts = {};
    for (var i = 0; i < n; i++) parts[key + '#' + i] = text.slice(i * CACHE_PART_CHARS, (i + 1) * CACHE_PART_CHARS);
    // Parts first, marker last: a reader never finds a marker without parts.
    cache.putAll(parts, ttlSeconds);
    cache.put(key, '~parts:' + n, ttlSeconds);
    return true;
  } catch (e) {
    Logger.log('getCached: skipped caching ' + key + ' (' + e + ')');
    return false;
  }
}

/**
 * Keeps what shoppers open first ready in the cache, so they never wait for
 * the sheets to be read: the homepage (trending products and stores) and the
 * first screen of every top-level category. Run by a time-driven trigger
 * every 5 minutes (DEPLOY.md, "Speed: warm cache trigger") - each answer is
 * rebuilt and stored for 6 minutes, so one always overlaps the next run.
 * Read-only: it writes nothing to the sheets. Returns what it warmed.
 */
var WARM_TTL_SECONDS = 360;

function warmPublicCaches() {
  var cache = CacheService.getScriptCache();
  var started = Date.now();
  var warmed = [];
  // Rebuilt, not just re-read: drop the main keys so getCached produces fresh.
  cache.removeAll([topProductsCacheKey(), topStoresCacheKey()]);
  var home = { products: getTopProductsCached(), stores: getTopStoresCached() };
  putCachedJson(cache, topProductsCacheKey(), home.products, WARM_TTL_SECONDS);
  putCachedJson(cache, topStoresCacheKey(), home.stores, WARM_TTL_SECONDS);
  warmed.push('homepage');
  LISTING_CATEGORY_SEED.filter(function (c) { return !c.parentId; }).forEach(function (c) {
    // Stop well inside Apps Script's 6-minute limit on a very large catalogue.
    if (Date.now() - started > 240000) return;
    var key = 'v4:search:' + c.id + '::';
    cache.remove(key);
    var res = actionSearchProducts({ category: c.id, type: '', q: '' });
    if (res && res.ok) {
      var stored = readCachedJson(cache, key);
      if (stored !== null) putCachedJson(cache, key, stored, WARM_TTL_SECONDS);
      warmed.push(c.id);
    }
  });
  Logger.log('warmPublicCaches: ' + warmed.join(', ') + ' in ' + (Date.now() - started) + 'ms');
  return warmed;
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

var DEFAULT_LIST_PAGE_SIZE = 20;
var MAX_LIST_PAGE_SIZE = 100;

/**
 * Clamps a client-requested page size to a sane default/ceiling. Shared by
 * every paginated list action (store directory, owner orders, owner
 * products, and - originally introduced there - chat messages/
 * conversations, which keep their own DEFAULT_MESSAGE_PAGE_SIZE-style
 * constants in Chat.gs since their sizes differ) so the clamp logic itself
 * doesn't drift across each one's own limit handling.
 */
function clampPageSize(requested, defaultSize, maxSize) {
  var n = Number(requested);
  if (!n || n <= 0) return defaultSize;
  return Math.min(Math.floor(n), maxSize);
}

/**
 * Rejects (rather than truncates) a field whose length exceeds maxLen.
 * Chat's MAX_CHAT_MESSAGE_LENGTH truncation (Chat.gs's appendMessage) is a
 * deliberately separate, unchanged precedent - not revisited here.
 */
/**
 * Pull the Facebook profile name out of whatever a vendor typed or pasted, and
 * build the one stored shape: a full https://m.me/... link.
 *
 * MUST STAY IN SYNC with messengerHandle() / messengerStoredValue() in
 * assets/js/helpers.js. The browser copy exists so the vendor sees what will be
 * saved before they submit; THIS one decides what actually reaches the sheet,
 * because a value can arrive from anything that can POST. A test runs both over
 * the same inputs and fails if they disagree.
 *
 * Extracts, does not validate - it returns '' when nothing usable is left, and
 * the caller decides whether blank is acceptable there. Registration refuses
 * blank; a settings edit does not, because every store that registered before
 * this has no Messenger and must still be able to save its other fields.
 */
/** Hosts that are not profile names, however much they look like one. */
var BARE_MESSENGER_HOSTS = ['m.me', 'messenger.com', 'facebook.com', 'fb.com', 'fb.me',
  'www.facebook.com', 'web.facebook.com', 'm.facebook.com'];

function messengerHandle(input) {
  var s = String(input == null ? '' : input).trim();
  if (!s) return '';

  s = s.replace(/^@+/, '');
  s = s.replace(/^(?:https?:\/\/)?(?:www\.|web\.|m\.)?(?:m\.me|messenger\.com|facebook\.com|fb\.com|fb\.me)\//i, '');
  s = s.replace(/^t\//i, '');

  // profile.php?id=123456 - a profile with no username set. m.me takes the id.
  var numeric = s.match(/^profile\.php\?(?:.*&)?id=(\d+)/i);
  if (numeric) return numeric[1];

  s = s.split(/[?#]/)[0];
  s = s.replace(/\/+$/, '');
  s = s.split('/')[0];

  // A bare host carries no name - the strip above needs a trailing slash to
  // fire, so "facebook.com" arrives intact and dots are legal in a username.
  if (BARE_MESSENGER_HOSTS.indexOf(s.toLowerCase()) !== -1) return '';

  // First character must be alphanumeric: that is what rejects ".." out of a
  // pasted path, which the character class alone would accept.
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(s) ? s : '';
}

function messengerStoredValue(input) {
  var handle = messengerHandle(input);
  return handle ? 'https://m.me/' + handle : '';
}

// Store names are capped at 22 characters (owner's call, Oct 2026) so they fit
// on cards and headers. Counted in characters, not UTF-16 units.
var STORE_NAME_MAX = 22;

/** null if the store name is short enough, else the fail() to return. */
function storeNameTooLong(name) {
  if (Array.from(String(name == null ? '' : name).trim()).length <= STORE_NAME_MAX) return null;
  return fail('Store name must be ' + STORE_NAME_MAX + ' characters or fewer. Please shorten it.');
}

function capLength(value, maxLen, fieldLabel) {
  var str = String(value == null ? '' : value);
  if (str.length > maxLen) return fail(fieldLabel + ' must be ' + maxLen + ' characters or fewer');
  return null;
}

/**
 * Constant-time string comparison, modeled on Node's crypto.timingSafeEqual
 * (no native equivalent exists in Apps Script). Returns false immediately
 * on a length mismatch - same as timingSafeEqual's own behavior - otherwise
 * XORs every char code so comparison time depends only on length, never on
 * where the first differing character is. Used for secret comparisons
 * (session tokens, 2FA codes, password hashes) - see Db.gs's
 * findRowBySecret and its call sites in Auth.gs.
 */
function constantTimeEquals(a, b) {
  var strA = String(a == null ? '' : a);
  var strB = String(b == null ? '' : b);
  if (strA.length !== strB.length) return false;

  var diff = 0;
  for (var i = 0; i < strA.length; i++) {
    diff |= strA.charCodeAt(i) ^ strB.charCodeAt(i);
  }
  return diff === 0;
}

/* ---------- Image hosting: Cloudinary (opt-in) with a Drive fallback ----------
 *
 * Product/logo/chat photos were originally always uploaded to Google Drive
 * and hotlinked via the googleusercontent.com CDN form - functional, but
 * Drive is a file-storage product, not a real CDN (no availability SLA
 * under load, no resizing) - see docs/production-readiness-report.md
 * Finding 8. Cloudinary support below is entirely opt-in: it only activates
 * once CLOUDINARY_CLOUD_NAME/CLOUDINARY_API_KEY/CLOUDINARY_API_SECRET are
 * all set in Script Properties (see README's setup steps). With none of
 * those set, uploadImage() falls straight through to the exact Drive path
 * this app already had - a fresh deployment that never touches Cloudinary
 * behaves identically to before this was added.
 */

function bytesToHex(bytes) {
  return bytes.map(function (b) {
    var v = b < 0 ? b + 256 : b;
    return (v < 16 ? '0' : '') + v.toString(16);
  }).join('');
}

function getCloudinaryConfig() {
  var props = PropertiesService.getScriptProperties();
  var cloudName = props.getProperty('CLOUDINARY_CLOUD_NAME');
  var apiKey = props.getProperty('CLOUDINARY_API_KEY');
  var apiSecret = props.getProperty('CLOUDINARY_API_SECRET');
  if (!cloudName || !apiKey || !apiSecret) return null;
  return { cloudName: cloudName, apiKey: apiKey, apiSecret: apiSecret };
}

/**
 * Cloudinary's signed-upload scheme: every param sent EXCEPT file/cloud_name/
 * resource_type/api_key gets sorted by key, joined as "k=v&k2=v2", the API
 * secret appended, then SHA-1'd (hex, not base64 - unlike hashPassword's
 * base64Encode elsewhere in this codebase, Cloudinary's API expects a hex
 * digest specifically). Same function signs both the upload and destroy
 * (delete) calls below - the param set just differs.
 */
function cloudinarySign(paramsToSign, apiSecret) {
  var sortedKeys = Object.keys(paramsToSign).sort();
  var toSign = sortedKeys.map(function (k) { return k + '=' + paramsToSign[k]; }).join('&') + apiSecret;
  var digestBytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_1, toSign, Utilities.Charset.UTF_8);
  return bytesToHex(digestBytes);
}

/**
 * Uploads to Cloudinary if configured, else returns null so the caller
 * falls back to Drive. `folder` is optional (chat images use a separate
 * Cloudinary folder from product/logo images, mirroring the existing
 * Drive-folder separation - see Chat.gs's getChatImageFolder comment for
 * why that separation exists). Any request param that affects the upload
 * must be included in the signature or Cloudinary rejects it - folder is
 * no exception, so it's added to paramsToSign only when present.
 */
function uploadToCloudinary(bytes, mimeType, filenameHint, folder) {
  var config = getCloudinaryConfig();
  if (!config) return null;

  var timestamp = Math.floor(Date.now() / 1000);
  var paramsToSign = { timestamp: timestamp };
  if (folder) paramsToSign.folder = folder;
  var signature = cloudinarySign(paramsToSign, config.apiSecret);

  var payload = {
    file: Utilities.newBlob(bytes, mimeType, filenameHint),
    api_key: config.apiKey,
    timestamp: String(timestamp),
    signature: signature
  };
  if (folder) payload.folder = folder;

  var response;
  try {
    response = UrlFetchApp.fetch('https://api.cloudinary.com/v1_1/' + config.cloudName + '/image/upload', {
      method: 'post',
      payload: payload,
      muteHttpExceptions: true
    });
  } catch (e) {
    Logger.log('Cloudinary upload request failed: ' + e);
    return null;
  }

  var result;
  try {
    result = JSON.parse(response.getContentText());
  } catch (e) {
    return null;
  }
  if (!result.secure_url) {
    Logger.log('Cloudinary upload rejected: ' + response.getContentText());
    return null;
  }
  // 'cld:' prefix records provenance in the same column Drive file ids
  // already occupy, so deleteStoredImage can route to the right provider
  // later even if Cloudinary is configured/unconfigured in between - see
  // deleteStoredImage below.
  return { imageUrl: result.secure_url, imageFileId: 'cld:' + result.public_id };
}

function deleteCloudinaryImage(publicId) {
  var config = getCloudinaryConfig();
  if (!config) return;

  var timestamp = Math.floor(Date.now() / 1000);
  var paramsToSign = { public_id: publicId, timestamp: timestamp };
  var signature = cloudinarySign(paramsToSign, config.apiSecret);

  try {
    UrlFetchApp.fetch('https://api.cloudinary.com/v1_1/' + config.cloudName + '/image/destroy', {
      method: 'post',
      payload: { public_id: publicId, api_key: config.apiKey, timestamp: String(timestamp), signature: signature },
      muteHttpExceptions: true
    });
  } catch (e) {
    // best effort - same as the pre-existing Drive setTrashed try/catch this mirrors
  }
}

/**
 * Single upload entry point for every image path in the app (product
 * photos, store logos, chat photos). Tries Cloudinary first (if
 * configured), falls back to Drive otherwise - callers never need to know
 * which provider actually served a given upload. `driveFolder` is a
 * zero-arg function returning the DriveApp folder to use for the fallback
 * path (lazy, so it's never called when Cloudinary handles the upload).
 * `cloudinaryFolder` is optional and only affects the Cloudinary path.
 */
function uploadImage(bytes, mimeType, filenameHint, driveFolder, cloudinaryFolder) {
  var cloudinaryResult = uploadToCloudinary(bytes, mimeType, filenameHint, cloudinaryFolder);
  if (cloudinaryResult) return cloudinaryResult;

  var folder = driveFolder();
  var blob = Utilities.newBlob(bytes, mimeType, filenameHint);
  var file = folder.createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  // drive.google.com/uc?export=view links are unreliable as <img> sources
  // (Google frequently blocks the hotlink and shows a broken image icon) -
  // the googleusercontent.com CDN form embeds reliably instead.
  var url = 'https://lh3.googleusercontent.com/d/' + file.getId();
  return { imageUrl: url, imageFileId: file.getId() };
}

/** Deletes a previously-uploaded image by whichever provider produced its id - see the 'cld:' prefix note in uploadToCloudinary above. */
function deleteStoredImage(fileId) {
  if (!fileId) return;
  if (String(fileId).indexOf('cld:') === 0) {
    deleteCloudinaryImage(String(fileId).slice(4));
    return;
  }
  try {
    DriveApp.getFileById(fileId).setTrashed(true);
  } catch (e) {
    // already gone, ignore
  }
}
