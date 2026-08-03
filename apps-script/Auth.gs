/**
 * Store-owner registration, login, and token-based sessions.
 *
 * Apps Script has no bcrypt/argon2, so passwords are hashed with salted
 * SHA-256 plus a server-side pepper (Script Properties). This is a pragmatic
 * choice for a small regional marketplace, not a bank-grade KDF - see
 * README security notes.
 */

var TOKEN_EXPIRY_HOURS_DEFAULT = 168; // 7 days

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
    anzAccountName: owner.ANZ_AccountName,
    anzAccountNumber: owner.ANZ_AccountNumber,
    anzBranch: owner.ANZ_Branch,
    teremoName: owner.Teremo_Name,
    teremoNumber: owner.Teremo_Number,
    paymentNotes: owner.PaymentNotes,
    twoFAEnabled: String(owner.TwoFAEnabled) === 'true'
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

/** Validates a bearer token and returns the owner row, or throws. */
function requireAuth(token) {
  if (!token) throw new Error('Not authenticated');
  var session = findRowById(getSheet('Sessions'), 'Token', token);
  if (!session) throw new Error('Not authenticated');
  if (new Date(session.ExpiresAt).getTime() < Date.now()) throw new Error('Session expired, please log in again');
  var owner = findRowById(getSheet('Owners'), 'OwnerId', session.OwnerId);
  if (!owner || owner.Status !== 'active') throw new Error('Not authenticated');
  return owner;
}

function actionRegisterOwner(body) {
  var storeName = String(body.storeName || '').trim();
  var username = String(body.username || '').trim().toLowerCase();
  var password = String(body.password || '');
  var email = String(body.email || '').trim();
  var phone = String(body.phone || '').trim();

  if (!storeName || !username || !password || !email || !phone) {
    return fail('Store name, username, password, contact email and contact phone are required');
  }
  if (password.length < 8) return fail('Password must be at least 8 characters');
  if (!/^[a-z0-9_.-]{3,40}$/.test(username)) return fail('Username must be 3-40 characters: letters, numbers, . _ -');
  if (email.indexOf('@') === -1) return fail('Enter a valid contact email');

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var ownersSheet = getSheet('Owners');
    var owners = sheetToObjects(ownersSheet);

    var usernameTaken = owners.some(function (o) { return String(o.Username).toLowerCase() === username; });
    if (usernameTaken) return fail('That username is already taken');

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
    return String(o.Username).toLowerCase() === username;
  })[0];

  // Compare against a dummy hash even on a missing user so response timing
  // doesn't reveal whether the username exists.
  var salt = owner ? owner.PasswordSalt : 'no-such-user-salt';
  var candidateHash = hashPassword(password, salt);

  if (!owner || owner.Status !== 'active' || candidateHash !== owner.PasswordHash) {
    return fail('Invalid username or password');
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
  if (!owner || owner.Status !== 'active') return fail('Account not found');

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
    subject = 'Your Simple Kiri Shop password reset code';
    body = 'Hi ' + storeName + ',\n\nYour password reset code is: ' + code + '\n\n' +
      'Enter this code on the password reset page to choose a new password. This code expires in ' +
      TWOFA_CODE_EXPIRY_MINUTES + ' minutes.\n\nIf you did not request this, you can ignore this email.';
  } else if (purpose === 'setup') {
    subject = 'Confirm two-factor authentication for Simple Kiri Shop';
    body = 'Hi ' + storeName + ',\n\nYour verification code is: ' + code + '\n\n' +
      'Enter this code to finish turning on two-factor authentication for your store account. ' +
      'This code expires in ' + TWOFA_CODE_EXPIRY_MINUTES + ' minutes.';
  } else {
    subject = 'Your Simple Kiri Shop login code';
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
    var row = findRowById(sheet, 'Token', token);
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
    if (String(row.Code).trim() !== String(code).trim()) {
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
  if (owner && owner.Status === 'active' && owner.Email) {
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
