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
    paymentNotes: owner.PaymentNotes
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

  if (!storeName || !username || !password) return fail('Store name, username and password are required');
  if (password.length < 8) return fail('Password must be at least 8 characters');
  if (!/^[a-z0-9_.-]{3,40}$/.test(username)) return fail('Username must be 3-40 characters: letters, numbers, . _ -');

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
      Email: body.email || '',
      Phone: body.phone || '',
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
