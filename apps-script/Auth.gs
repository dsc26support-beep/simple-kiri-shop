/**
 * Store-owner registration, login, and token-based sessions.
 *
 * Apps Script has no bcrypt/argon2, so passwords are hashed with salted
 * SHA-256 plus a server-side pepper (Script Properties). This is a pragmatic
 * choice for a small regional marketplace, not a bank-grade KDF - see
 * README security notes.
 */

var TOKEN_EXPIRY_HOURS_DEFAULT = 168; // 7 days

var LOGIN_FAIL_WINDOW_SECONDS = 15 * 60;
var LOGIN_FAIL_MAX_ATTEMPTS = 5;
var LOGIN_LOCKOUT_SECONDS = 30 * 60;

/**
 * Tracks failed login attempts per lowercased username - no IP is available
 * to Apps Script Web Apps (doGet/doPost only ever expose e.parameter and
 * e.postData.contents), so lockout has to key off an identifier the caller
 * already supplied. 5 failures within a 15-minute window locks that
 * username out for 30 minutes. Called on every login attempt, success or
 * failure, so a locked and not-yet-locked username do the same cache
 * read-then-write work - only the branch taken differs, not the cost of
 * getting there (the password hash comparison itself already ran before
 * this is called - see actionLoginOwner).
 */
function checkAndRecordLoginAttempt(username, loginSucceeded) {
  var failKey = 'loginfail:v1:' + username;
  var lockKey = 'loginlock:v1:' + username;
  var cache = CacheService.getScriptCache();

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var lockRaw = cache.get(lockKey);
    if (lockRaw) {
      var lockState = JSON.parse(lockRaw);
      var retryAfterMinutes = Math.max(1, Math.ceil((lockState.unlockAt - Date.now()) / 60000));
      return { locked: true, retryAfterMinutes: retryAfterMinutes };
    }

    if (loginSucceeded) {
      cache.remove(failKey);
      return { locked: false };
    }

    var now = Date.now();
    var failRaw = cache.get(failKey);
    var failState = failRaw ? JSON.parse(failRaw) : { count: 0, firstAt: now };
    failState.count++;

    if (failState.count >= LOGIN_FAIL_MAX_ATTEMPTS) {
      var unlockAt = now + LOGIN_LOCKOUT_SECONDS * 1000;
      try { cache.put(lockKey, JSON.stringify({ unlockAt: unlockAt }), LOGIN_LOCKOUT_SECONDS); } catch (e) { /* best effort */ }
      cache.remove(failKey);
      return { locked: true, retryAfterMinutes: Math.ceil(LOGIN_LOCKOUT_SECONDS / 60) };
    }

    var ttlSeconds = Math.max(1, LOGIN_FAIL_WINDOW_SECONDS - Math.floor((now - failState.firstAt) / 1000));
    try { cache.put(failKey, JSON.stringify(failState), ttlSeconds); } catch (e) { /* best effort */ }
    return { locked: false };
  } finally {
    lock.releaseLock();
  }
}

function getPepper() {
  var pepper = PropertiesService.getScriptProperties().getProperty('PEPPER');
  if (!pepper) throw new Error('Server misconfigured: set PEPPER in Script Properties');
  return pepper;
}

function hashPassword(password, salt) {
  var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, password + salt + getPepper());
  return Utilities.base64Encode(digest);
}

function publicOwnerFields(owner) {
  return {
    ownerId: owner.OwnerId,
    storeName: owner.StoreName,
    storeSlug: owner.StoreSlug,
    email: owner.Email,
    phone: owner.Phone,
    messenger: owner.Messenger,
    logoUrl: owner.LogoUrl,
    island: owner.Island,
    village: owner.Village,
    status: owner.Status,
    // Derived so the client never has to know what 'standby' means.
    isOpen: isStoreOpenForBusiness(owner),
    deliveryTruck: String(owner.DeliveryTruck) === 'true',
    deliveryShip: String(owner.DeliveryShip) === 'true',
    deliveryAirCargo: String(owner.DeliveryAirCargo) === 'true',
    deliveryPickPay: String(owner.DeliveryPickPay) === 'true',
    deliveryTruckCost: owner.DeliveryTruckCost === '' || owner.DeliveryTruckCost == null ? null : Number(owner.DeliveryTruckCost),
    deliveryShipCost: owner.DeliveryShipCost === '' || owner.DeliveryShipCost == null ? null : Number(owner.DeliveryShipCost),
    deliveryAirCargoCost: owner.DeliveryAirCargoCost === '' || owner.DeliveryAirCargoCost == null ? null : Number(owner.DeliveryAirCargoCost),
    twoFAEnabled: String(owner.TwoFAEnabled) === 'true',
    isAdmin: isOwnerAdmin(owner)
  };
}

function issueSession(ownerId) {
  var sheet = getSheet('Sessions');
  var token = Utilities.getUuid() + Utilities.getUuid();
  var hours = Number(PropertiesService.getScriptProperties().getProperty('TOKEN_EXPIRY_HOURS')) || TOKEN_EXPIRY_HOURS_DEFAULT;
  var expiresAt = new Date(Date.now() + hours * 3600 * 1000).toISOString();
  appendRowFromObject(sheet, { Token: token, OwnerId: ownerId, CreatedAt: nowIso(), ExpiresAt: expiresAt });
  return token;
}

// A store's Status is one of: 'active' (normal), 'standby' (owner paused it -
// hidden from customers, but the owner can still log in to switch it back),
// or 'closed' (owner deleted it from Settings - hidden from customers *and*
// the owner is locked out; a soft delete, so the row itself is never erased).
function ownerCanLogIn(owner) {
  return !!owner && (owner.Status === 'active' || owner.Status === 'standby');
}

/**
 * Two different questions, deliberately separated.
 *
 * isStoreBrowsable  - may customers see this store at all? True for 'active'
 *                     and 'standby'. A standby store is CLOSED FOR BUSINESS,
 *                     not hidden: customers can still find it, read its
 *                     listings and chat with it, and it is clearly marked
 *                     Closed everywhere it appears.
 * isStoreOpenForBusiness - may it take money? 'active' only. A standby store
 *                     must never accept an order or a booking.
 *
 * 'closed' is neither. That is the soft delete from Settings, and it stays
 * hidden from customers and locked out for the owner.
 */
function isStoreBrowsable(owner) {
  return !!owner && (owner.Status === 'active' || owner.Status === 'standby');
}

function isStoreOpenForBusiness(owner) {
  return !!owner && owner.Status === 'active';
}

/** Validates a bearer token and returns the owner row, or throws. */
function requireAuth(token) {
  if (!token) throw new Error('Not authenticated');
  var session = findRowBySecret(getSheet('Sessions'), 'Token', token);
  if (!session) throw new Error('Not authenticated');
  if (new Date(session.ExpiresAt).getTime() < Date.now()) throw new Error('Session expired, please log in again');
  var owner = findRowById(getSheet('Owners'), 'OwnerId', session.OwnerId);
  if (!ownerCanLogIn(owner)) throw new Error('Not authenticated');
  return owner;
}

var EMAIL_FORMAT_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Shared by actionRegisterOwner and actionUpdateOwnerProfile so format/
 * blank/dedupe checks can't drift apart again - previously
 * actionUpdateOwnerProfile skipped all three, letting an owner blank out or
 * duplicate their own recovery email (the same email password reset relies
 * on). excludeOwnerId lets an update skip flagging the caller's own current
 * email as a duplicate of itself. ownersList lets a caller that already has
 * a fresh Owners scan (e.g. actionRegisterOwner, mid-lock) avoid a second one.
 */
function validateOwnerEmail(email, excludeOwnerId, ownersList) {
  var trimmed = String(email || '').trim();
  if (!trimmed) return fail('Contact email is required');
  var lengthErr = capLength(trimmed, 254, 'Email');
  if (lengthErr) return lengthErr;
  if (!EMAIL_FORMAT_RE.test(trimmed)) return fail('Enter a valid contact email');

  var owners = ownersList || sheetToObjects(getSheet('Owners'));
  var taken = owners.some(function (o) {
    return String(o.Email).toLowerCase() === trimmed.toLowerCase() && o.OwnerId !== excludeOwnerId;
  });
  if (taken) return fail('That email is already registered to a store');

  return null;
}

function actionRegisterOwner(body) {
  var storeName = String(body.storeName || '').trim();
  var username = String(body.username || '').trim().toLowerCase();
  var password = String(body.password || '');
  var email = String(body.email || '').trim();
  var phone = String(body.phone || '').trim();
  var messenger = String(body.messenger || '').trim();

  if (!storeName || !username || !password || !email || !phone) {
    return fail('Store name, username, password, contact email and contact phone are required');
  }
  if (password.length < 8) return fail('Password must be at least 8 characters');
  if (!/^[a-z0-9_.-]{3,40}$/.test(username)) return fail('Username must be 3-40 characters: letters, numbers, . _ -');
  var storeNameErr = capLength(storeName, 100, 'Store name');
  if (storeNameErr) return storeNameErr;
  var phoneErr = capLength(phone, 30, 'Phone number');
  if (phoneErr) return phoneErr;
  var messengerErr = capLength(messenger, 100, 'Facebook Messenger');
  if (messengerErr) return messengerErr;

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var ownersSheet = getSheet('Owners');
    var owners = sheetToObjects(ownersSheet);

    var usernameTaken = owners.some(function (o) { return String(o.Username).toLowerCase() === username; });
    if (usernameTaken) return fail('That username is already taken');

    var emailErr = validateOwnerEmail(email, null, owners);
    if (emailErr) return emailErr;

    var phoneDigits = phone.replace(/[^0-9]/g, '');
    var phoneTaken = owners.some(function (o) { return String(o.Phone).replace(/[^0-9]/g, '') === phoneDigits; });
    if (phoneTaken) return fail('That phone number is already registered to a store');

    var slugBase = slugify(storeName);
    var slug = slugBase;
    var suffix = 1;
    while (owners.some(function (o) { return o.StoreSlug === slug; })) {
      suffix++;
      slug = slugBase + '-' + suffix;
    }

    var salt = Utilities.getUuid();
    var ownerId = newId('own');

    appendRowFromObject(ownersSheet, {
      OwnerId: ownerId,
      StoreName: storeName,
      StoreSlug: slug,
      Username: username,
      PasswordHash: hashPassword(password, salt),
      PasswordSalt: salt,
      Email: email,
      Phone: phone,
      Messenger: messenger,
      ANZ_AccountName: '',
      ANZ_AccountNumber: '',
      ANZ_Branch: '',
      Teremo_Name: '',
      Teremo_Number: '',
      PaymentNotes: '',
      Status: 'active',
      CreatedAt: nowIso()
    });

    var token = issueSession(ownerId);
    var owner = findRowById(ownersSheet, 'OwnerId', ownerId);
    return ok({ token: token, owner: publicOwnerFields(owner) });
  } finally {
    lock.releaseLock();
  }
}

function actionLoginOwner(body) {
  var username = String(body.username || '').trim().toLowerCase();
  var password = String(body.password || '');
  if (!username || !password) return fail('Username and password are required');

  var owner = sheetToObjects(getSheet('Owners')).filter(function (o) {
    return constantTimeEquals(String(o.Username).toLowerCase(), username);
  })[0];

  // Compare against a dummy hash even on a missing user so response timing
  // doesn't reveal whether the username exists.
  var salt = owner ? owner.PasswordSalt : 'no-such-user-salt';
  var candidateHash = hashPassword(password, salt);
  var loginSucceeded = ownerCanLogIn(owner) && constantTimeEquals(candidateHash, owner.PasswordHash);

  // Runs AFTER the (constant-cost) hash comparison above and BEFORE
  // branching on its result, so a locked-out username's response isn't
  // detectably faster than a normal wrong-password one. A nonexistent
  // username locks out identically to a real one (this is keyed purely on
  // the submitted string), so this doesn't reopen the enumeration issue the
  // dummy-hash comparison above already closes.
  var lockout = checkAndRecordLoginAttempt(username, loginSucceeded);
  if (lockout.locked) {
    return fail('Too many failed login attempts. Please try again in ' + lockout.retryAfterMinutes + ' minute(s).');
  }

  if (!loginSucceeded) {
    return fail(owner && owner.Status === 'closed'
      ? 'This store has been deleted. Contact admin@mwakete.com if this is a mistake.'
      : 'Invalid username or password');
  }

  if (String(owner.TwoFAEnabled) === 'true') {
    if (!owner.Email) {
      // Shouldn't happen - email is required to enable 2FA - but fail safe.
      return fail('Two-factor authentication is enabled but no contact email is on file. Please contact support.');
    }
    var pending = issueTwoFACode(owner.OwnerId, owner.Email, owner.StoreName, 'login');
    return ok({ twoFactorRequired: true, pendingToken: pending.token });
  }

  var token = issueSession(owner.OwnerId);
  return ok({ token: token, owner: publicOwnerFields(owner) });
}

function actionVerifyLoginCode(body) {
  var result = consumeTwoFACode(body.pendingToken, body.code, 'login', null);
  if (!result.ok) return result;

  var owner = findRowById(getSheet('Owners'), 'OwnerId', result.ownerId);
  if (!ownerCanLogIn(owner)) return fail('Account not found');

  var token = issueSession(owner.OwnerId);
  return ok({ token: token, owner: publicOwnerFields(owner) });
}

function actionLogoutOwner(body) {
  if (!body.token) return ok({});
  var sheet = getSheet('Sessions');
  var row = findRowById(sheet, 'Token', body.token);
  if (row) sheet.deleteRow(row.__row);
  return ok({});
}

var VALID_STORE_STATUSES = ['active', 'standby', 'closed'];

/**
 * Standby hides the store from customers but the owner can still log in and
 * switch back. Closed (Settings' "Delete Store") also locks the owner out -
 * a soft delete, so no Sheet rows are ever erased and it's reversible by
 * editing the Owners sheet directly if needed.
 */
function actionSetStoreStatus(owner, body) {
  var status = String(body.status || '');
  if (VALID_STORE_STATUSES.indexOf(status) === -1) return fail('Invalid status');

  var sheet = getSheet('Owners');
  var row = findRowById(sheet, 'OwnerId', owner.OwnerId);
  if (!row) return fail('Store account not found');

  updateRowFromObject(sheet, row.__row, { Status: status });
  if (status === 'closed') revokeAllSessions(owner.OwnerId);

  invalidateCache([
    'v1:listStores',
    'v1:topStores',
    'v1:topProducts',
    'v1:listProducts:' + owner.StoreSlug,
    'v1:storeInfo:' + owner.StoreSlug
  ]);

  return ok({ status: status });
}

/** Optional: wire to a daily time-driven trigger so the Sessions tab doesn't grow forever. */
function pruneExpiredSessions() {
  var sheet = getSheet('Sessions');
  var now = Date.now();
  sheetToObjects(sheet)
    .filter(function (r) { return new Date(r.ExpiresAt).getTime() < now; })
    .sort(function (a, b) { return b.__row - a.__row; }) // delete bottom-up so row numbers stay valid
    .forEach(function (r) { sheet.deleteRow(r.__row); });
}

/* ---------- Shared email-code helpers (used by both 2FA and password reset) ---------- */

var TWOFA_CODE_EXPIRY_MINUTES = 10;
var TWOFA_MAX_ATTEMPTS = 5;

function issueTwoFACode(ownerId, email, storeName, purpose) {
  var token = generateToken();
  var code = generate6DigitCode();
  var expiresAt = new Date(Date.now() + TWOFA_CODE_EXPIRY_MINUTES * 60 * 1000).toISOString();
  appendRowFromObject(getSheet('TwoFACodes'), {
    Token: token,
    OwnerId: ownerId,
    Code: code,
    Purpose: purpose,
    CreatedAt: nowIso(),
    ExpiresAt: expiresAt,
    Attempts: 0
  });

  var subject, body;
  if (purpose === 'reset') {
    subject = 'Your Mwakete password reset code';
    body = 'Hi ' + storeName + ',\n\nYour password reset code is: ' + code + '\n\n' +
      'Enter this code on the password reset page to choose a new password. This code expires in ' +
      TWOFA_CODE_EXPIRY_MINUTES + ' minutes.\n\nIf you did not request this, you can ignore this email.';
  } else if (purpose === 'setup') {
    subject = 'Confirm two-factor authentication for Mwakete';
    body = 'Hi ' + storeName + ',\n\nYour verification code is: ' + code + '\n\n' +
      'Enter this code to finish turning on two-factor authentication for your store account. ' +
      'This code expires in ' + TWOFA_CODE_EXPIRY_MINUTES + ' minutes.';
  } else {
    subject = 'Your Mwakete login code';
    body = 'Hi ' + storeName + ',\n\nYour login code is: ' + code + '\n\n' +
      'Enter this code to finish logging in. This code expires in ' + TWOFA_CODE_EXPIRY_MINUTES + ' minutes.\n\n' +
      'If this was not you, someone may have your password - consider resetting it.';
  }
  sendAppEmail(email, subject, body);

  return { token: token };
}

/** Validates + consumes a one-time code. Returns {ok:true, ownerId} or a fail() object. */
function consumeTwoFACode(token, code, expectedPurpose, expectedOwnerId) {
  if (!token || !code) return fail('Enter the code we emailed you');

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sheet = getSheet('TwoFACodes');
    var row = findRowBySecret(sheet, 'Token', token);
    if (!row || row.Purpose !== expectedPurpose) return fail('This verification code is invalid or has expired');
    if (expectedOwnerId && row.OwnerId !== expectedOwnerId) return fail('This verification code is invalid');

    if (new Date(row.ExpiresAt).getTime() < Date.now()) {
      sheet.deleteRow(row.__row);
      return fail('This code has expired - please request a new one');
    }
    if (Number(row.Attempts) >= TWOFA_MAX_ATTEMPTS) {
      sheet.deleteRow(row.__row);
      return fail('Too many incorrect attempts - please request a new code');
    }
    if (!constantTimeEquals(String(row.Code).trim(), String(code).trim())) {
      updateRowFromObject(sheet, row.__row, { Attempts: Number(row.Attempts) + 1 });
      return fail('Incorrect code, please try again');
    }

    var ownerId = row.OwnerId;
    sheet.deleteRow(row.__row);
    return { ok: true, ownerId: ownerId };
  } finally {
    lock.releaseLock();
  }
}

/* ---------- Password reset (forgot password) ---------- */

function actionRequestPasswordReset(body) {
  var username = String(body.username || '').trim().toLowerCase();
  if (!username) return fail('Enter your username');

  var owner = sheetToObjects(getSheet('Owners')).filter(function (o) {
    return String(o.Username).toLowerCase() === username;
  })[0];

  // Always return a token so the response looks the same whether or not the
  // account exists - this endpoint must not be usable to enumerate usernames.
  if (ownerCanLogIn(owner) && owner.Email) {
    var pending = issueTwoFACode(owner.OwnerId, owner.Email, owner.StoreName, 'reset');
    return ok({ token: pending.token });
  }
  return ok({ token: generateToken() });
}

function actionResetPasswordWithCode(body) {
  var newPassword = String(body.newPassword || '');
  if (newPassword.length < 8) return fail('Password must be at least 8 characters');

  var result = consumeTwoFACode(body.token, body.code, 'reset', null);
  if (!result.ok) return result;

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var ownersSheet = getSheet('Owners');
    var owner = findRowById(ownersSheet, 'OwnerId', result.ownerId);
    if (!owner) return fail('Account not found');

    var salt = Utilities.getUuid();
    updateRowFromObject(ownersSheet, owner.__row, {
      PasswordSalt: salt,
      PasswordHash: hashPassword(newPassword, salt)
    });

    // Force re-login everywhere, in case the reset was triggered by a compromised password.
    revokeAllSessions(owner.OwnerId);

    return ok({});
  } finally {
    lock.releaseLock();
  }
}

function revokeAllSessions(ownerId) {
  var sheet = getSheet('Sessions');
  sheetToObjects(sheet)
    .filter(function (s) { return s.OwnerId === ownerId; })
    .sort(function (a, b) { return b.__row - a.__row; })
    .forEach(function (s) { sheet.deleteRow(s.__row); });
}

/* ---------- 2FA setup (opt-in, from Settings) ---------- */

function actionEnable2FARequest(owner) {
  if (!owner.Email) return fail('Add a contact email in Settings before enabling 2FA');
  var pending = issueTwoFACode(owner.OwnerId, owner.Email, owner.StoreName, 'setup');
  return ok({ verifyToken: pending.token });
}

function actionConfirm2FASetup(owner, body) {
  var result = consumeTwoFACode(body.verifyToken, body.code, 'setup', owner.OwnerId);
  if (!result.ok) return result;

  var row = findRowById(getSheet('Owners'), 'OwnerId', owner.OwnerId);
  updateRowFromObject(getSheet('Owners'), row.__row, { TwoFAEnabled: 'true' });
  return ok({});
}

function actionDisable2FA(owner) {
  var row = findRowById(getSheet('Owners'), 'OwnerId', owner.OwnerId);
  updateRowFromObject(getSheet('Owners'), row.__row, { TwoFAEnabled: 'false' });
  return ok({});
}
