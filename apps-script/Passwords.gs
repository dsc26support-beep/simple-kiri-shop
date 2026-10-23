/**
 * Password hashing for sellers (Owners) and shoppers (Customers).
 *
 * WHY NOT THE OLD hashPassword (Auth.gs)
 * --------------------------------------
 * The original store hash is ONE SHA-256 of password + salt + pepper. SHA-256
 * is built to be fast, so a leaked Owners sheet could be guessed at billions
 * of tries a second. New hashes use PBKDF2-HMAC-SHA256 (RFC 8018): the same
 * salt and pepper, but stretched over many HMAC rounds, so each guess costs
 * the attacker that many rounds too.
 *
 * PBKDF2 is assembled from Apps Script's own HMAC (Utilities.
 * computeHmacSha256Signature) following the RFC exactly; nothing here invents
 * a construction. tests/test-passwords.js checks it against Node's
 * crypto.pbkdf2Sync, including the RFC's own test vector.
 *
 * LIMITS, STATED HONESTLY
 * -----------------------
 * Apps Script is slow at tight loops, so the round count is far below what a
 * dedicated server would use (OWASP suggests 600,000 for PBKDF2-SHA256). Two
 * things make up some of the gap:
 *   - the PEPPER (Script Properties) is mixed in first, so a copy of the sheet
 *     alone - without the script's properties - cannot be checked at all;
 *   - the round count is stored inside every hash and can be raised at any
 *     time with PASSWORD_ITERATIONS; older hashes are upgraded silently the
 *     next time that person signs in (passwordNeedsRehash).
 * Run benchmarkPasswordHashing() from the Apps Script editor to see what this
 * deployment can afford (aim for about 0.5-1 second per sign-in).
 *
 * Stored form: pbkdf2$sha256$<rounds>$<salt base64>$<hash base64>
 * A value without that prefix is the legacy single SHA-256 (Owners only).
 */

var PASSWORD_ITERATIONS_DEFAULT = 4000;
var PASSWORD_ITERATIONS_MIN = 1000;
var PASSWORD_ITERATIONS_MAX = 200000;
var PASSWORD_MIN_LENGTH = 8;
var PASSWORD_MAX_LENGTH = 200;   // long enough for any passphrase; caps the work a request can cause

function passwordIterations() {
  var n = Number(PropertiesService.getScriptProperties().getProperty('PASSWORD_ITERATIONS'));
  if (!n || isNaN(n)) return PASSWORD_ITERATIONS_DEFAULT;
  return Math.max(PASSWORD_ITERATIONS_MIN, Math.min(PASSWORD_ITERATIONS_MAX, Math.floor(n)));
}

/** Plain-language problem with a new password, or '' when it is acceptable. */
function passwordPolicyError(password) {
  var p = String(password || '');
  if (p.length < PASSWORD_MIN_LENGTH) return 'Password must be at least ' + PASSWORD_MIN_LENGTH + ' characters';
  if (p.length > PASSWORD_MAX_LENGTH) return 'Password is too long';
  return '';
}

// Apps Script byte arrays are signed Java bytes (-128..127).
function bytesOfString_(s) { return Utilities.newBlob(String(s)).getBytes(); }
function xorInto_(acc, bytes) { for (var i = 0; i < acc.length; i++) acc[i] = acc[i] ^ bytes[i]; }

/**
 * PBKDF2-HMAC-SHA256 with a 32-byte output (one block, RFC 8018 section 5.2).
 * key and salt are byte arrays; returns a byte array.
 */
function pbkdf2Sha256_(keyBytes, saltBytes, iterations) {
  var block = saltBytes.concat([0, 0, 0, 1]);                  // INT(1), big-endian
  var u = Utilities.computeHmacSha256Signature(block, keyBytes);
  var t = u.slice();
  for (var i = 1; i < iterations; i++) {
    u = Utilities.computeHmacSha256Signature(u, keyBytes);
    xorInto_(t, u);
  }
  return t.map(function (b) { return ((b + 128) & 255) - 128; });  // keep the signed-byte shape
}

// The pepper keys an HMAC over the password before stretching, so it never
// travels as part of the salt and a long password cannot push it out.
function pepperedPasswordBytes_(password) {
  return Utilities.computeHmacSha256Signature(bytesOfString_(password), bytesOfString_(getPepper()));
}

function randomSaltBytes_() {
  // Utilities.getUuid is backed by a cryptographically secure generator.
  return bytesOfString_(Utilities.getUuid() + Utilities.getUuid()).slice(0, 32);
}

/** A new stored hash for `password`. */
function hashPasswordV2(password, iterations) {
  var rounds = iterations || passwordIterations();
  var salt = randomSaltBytes_();
  var hash = pbkdf2Sha256_(pepperedPasswordBytes_(password), salt, rounds);
  return 'pbkdf2$sha256$' + rounds + '$' + Utilities.base64Encode(salt) + '$' + Utilities.base64Encode(hash);
}

function isPbkdf2Hash(stored) {
  return /^pbkdf2\$sha256\$\d+\$[^$]+\$[^$]+$/.test(String(stored || ''));
}

/**
 * True when `password` matches `stored`. Legacy (pre-PBKDF2) store hashes are
 * checked with the original hashPassword and `legacySalt` (Owners.PasswordSalt).
 * The comparison is constant-time either way.
 */
function verifyPassword(password, stored, legacySalt) {
  stored = String(stored || '');
  if (!stored) return false;
  if (isPbkdf2Hash(stored)) {
    var parts = stored.split('$');
    var rounds = Number(parts[2]);
    if (!(rounds >= PASSWORD_ITERATIONS_MIN && rounds <= PASSWORD_ITERATIONS_MAX)) return false;
    var salt = Utilities.base64Decode(parts[3]);
    var candidate = Utilities.base64Encode(pbkdf2Sha256_(pepperedPasswordBytes_(password), salt, rounds));
    return constantTimeEquals(candidate, parts[4]);
  }
  if (!legacySalt) return false;
  return constantTimeEquals(hashPassword(password, legacySalt), stored);
}

/** Does this stored hash need upgrading (legacy, or fewer rounds than now configured)? */
function passwordNeedsRehash(stored) {
  if (!isPbkdf2Hash(stored)) return true;
  return Number(String(stored).split('$')[2]) < passwordIterations();
}

/**
 * The same amount of work as a real check, for when there is no account -
 * so "no such account" and "wrong password" take the same time.
 */
function burnPasswordCheck(password) {
  pbkdf2Sha256_(pepperedPasswordBytes_(password), randomSaltBytes_(), passwordIterations());
  return false;
}

/** Run from the Apps Script editor: how long one sign-in check takes here. */
function benchmarkPasswordHashing() {
  [1000, 4000, 10000, 20000].forEach(function (n) {
    var t0 = Date.now();
    hashPasswordV2('benchmark-password', n);
    Logger.log(n + ' rounds: ' + (Date.now() - t0) + ' ms');
  });
}
