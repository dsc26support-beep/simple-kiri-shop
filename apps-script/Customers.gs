/**
 * Customer accounts - sign-up, email verification and sign-in.
 *
 * Deliberately separate from the owner/vendor auth in Auth.gs (its own sheets
 * and helpers) so owner login is untouched. Reuses the shared primitives
 * (generate6DigitCode, generateToken, constantTimeEquals, sendAppEmail, the
 * Db.gs row helpers) and the same code-expiry / attempt caps as owner 2FA.
 *
 * HOW A SHOPPER GETS IN (owner decisions, Oct 2026)
 *   - Create an account with name, email and a password. Nothing is written
 *     to Customers until the email is confirmed: the pending sign-up waits in
 *     CustomerCodes and the email carries both a 6-digit code and a one-time
 *     link. So an unverified account never exists for email sign-ups.
 *   - Sign in with email + password, or "Email me a code instead" (the
 *     original passwordless way, kept as a fallback), or Google / Facebook
 *     (CustomerOAuth.gs, FacebookAuth.gs).
 *   - Forgot / set a password: a code + link to the address on the account.
 *   - No phone number at sign-up; checkout asks only when delivery needs it.
 *
 * Every public reply about an email address is the same whether or not an
 * account exists (no "that email already has an account"), so the forms
 * cannot be used to find out who shops here. The emails themselves tell the
 * real owner of the address what happened.
 *
 * SHEETS (columns are added on first use with ensureColumn; nothing is
 * renamed or removed):
 *   Customers:        CustomerId | Name | Email | Phone | EmailVerified | CreatedAt | UpdatedAt
 *                     + PasswordHash | Status | PendingEmail (+ AuthProvider | GoogleSub, CustomerOAuth.gs)
 *   CustomerSessions: Token | CustomerId | CreatedAt | ExpiresAt
 *                     Token holds 'h1:' + SHA-256 of the session token for new
 *                     sessions; older rows hold the raw token and still work
 *                     until they expire.
 *   CustomerCodes:    Token | Email | Code | Purpose | Name | Phone | CreatedAt | ExpiresAt | Attempts
 *                     + PasswordHash | LinkHash | CustomerId
 *                     Token / LinkHash hold hashes; the raw values exist only in
 *                     the browser and in the email.
 */

var CUSTOMER_CODE_SEND_MAX = 5;                // code emails allowed per address...
var CUSTOMER_CODE_SEND_WINDOW_SECONDS = 900;   // ...per 15 minutes (anti email-bomb)
var CUSTOMER_RESEND_COOLDOWN_SECONDS = 60;     // between two sends to one pending sign-up
var CUSTOMER_LINK_EXPIRY_MINUTES = 30;         // sign-up, verify-email and reset codes/links
var TOKEN_HASH_PREFIX = 'h1:';

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

/** One-way hash for a high-entropy secret before it is stored in a sheet. */
function hashSecretToken(token) {
  return TOKEN_HASH_PREFIX + sha256Hex(String(token || ''));
}

function findCustomerByEmail(email) {
  var norm = normalizeEmail(email);
  if (!norm) return null;
  var rows = sheetToObjects(getSheet('Customers'));
  for (var i = 0; i < rows.length; i++) {
    if (normalizeEmail(rows[i].Email) === norm) return rows[i];
  }
  return null;
}

function customerIsSuspended(c) {
  return !!c && String(c.Status || '').toLowerCase() === 'suspended';
}

/** Confirmed email: may sign in by code / password, counts as a real account. */
function customerEmailVerified(c) {
  return !!c && String(c.EmailVerified) === 'true' && !!normalizeEmail(c.Email);
}

/**
 * May order, book, chat and review. Only an account explicitly marked
 * EmailVerified 'false' is held back - the ones this version creates from a
 * Facebook sign-in whose email Mwakete has not confirmed yet. Rows from before
 * this change are grandfathered: none of them is marked 'false', and they
 * keep working exactly as they did.
 */
function customerMayTransact(c) {
  return !!c && String(c.EmailVerified).toLowerCase() !== 'false';
}

function publicCustomerFields(c) {
  return {
    customerId: c.CustomerId,
    name: c.Name,
    email: c.Email,
    phone: c.Phone,
    emailVerified: customerEmailVerified(c),
    pendingEmail: String(c.PendingEmail || ''),
    hasPassword: !!String(c.PasswordHash || ''),
    status: String(c.Status || 'active') || 'active'
  };
}

/** a.b@example.com -> a•••@example.com, for screens that say where a code went. */
function maskEmail(email) {
  var e = normalizeEmail(email);
  var at = e.indexOf('@');
  if (at < 1) return '';
  return e.charAt(0) + '•••' + e.slice(at);
}

/* ---------- One-time codes and links ---------- */

/**
 * Stores a one-time code (and, when the site address is configured, a one-time
 * link) for `purpose`: 'signup' | 'login' | 'reset' | 'verify'. Returns the
 * raw pending token - the browser's handle on it - and the raw link token,
 * which goes only into the email. Only hashes are written to the sheet.
 * extra: { name, phone, passwordHash, customerId, expiryMinutes }
 */
function issueCustomerEmailCode(email, purpose, extra) {
  extra = extra || {};
  var token = generateToken();
  var linkToken = generateToken();
  var code = generate6DigitCode();
  var minutes = extra.expiryMinutes || (purpose === 'login' ? TWOFA_CODE_EXPIRY_MINUTES : CUSTOMER_LINK_EXPIRY_MINUTES);
  var sheet = getSheet('CustomerCodes');
  ensureColumn(sheet, 'PasswordHash');
  ensureColumn(sheet, 'LinkHash');
  ensureColumn(sheet, 'CustomerId');
  appendRowFromObject(sheet, {
    Token: hashSecretToken(token),
    Email: normalizeEmail(email),
    Code: code,
    Purpose: purpose,
    Name: extra.name || '',
    Phone: extra.phone || '',
    CreatedAt: nowIso(),
    ExpiresAt: new Date(Date.now() + minutes * 60 * 1000).toISOString(),
    Attempts: 0,
    PasswordHash: extra.passwordHash || '',
    LinkHash: hashSecretToken(linkToken),
    CustomerId: extra.customerId || ''
  });
  sendCustomerCodeEmail(email, purpose, code, linkToken, extra.name, minutes);
  return { token: token };
}

function customerLinkUrl(param, linkToken) {
  var base = siteBaseUrl();
  return base ? base + '/customer-login.html?' + param + '=' + encodeURIComponent(linkToken) : '';
}

function sendCustomerCodeEmail(email, purpose, code, linkToken, name, minutes) {
  var what = {
    signup: { subject: 'Confirm your Mwakete account', doing: 'finish creating your account', param: 'verify' },
    verify: { subject: 'Confirm your email for Mwakete', doing: 'confirm this email address', param: 'verify' },
    login: { subject: 'Your Mwakete sign-in code', doing: 'sign in', param: '' },
    reset: { subject: 'Set your Mwakete password', doing: 'set a new password', param: 'reset' }
  }[purpose];
  var link = what.param ? customerLinkUrl(what.param, linkToken) : '';
  var body = (name ? 'Hi ' + name + ',\n\n' : 'Hi,\n\n') +
    'Your Mwakete code is: ' + code + '\n\n' +
    'Enter it to ' + what.doing + '.' +
    (link ? ' Or open this link on the same phone or computer:\n' + link + '\n\n' : '\n\n') +
    'The code' + (link ? ' and link expire' : ' expires') + ' in ' + minutes + ' minutes and work once.\n\n' +
    'If this was not you, you can safely ignore this email - nothing changes until the code is used.';
  sendAppEmail(email, what.subject, body);
}

/**
 * For a form that must not reveal whether an account exists: the email that
 * goes instead of a code, so the real owner of the address knows why.
 */
function sendCustomerNoticeEmail(email, kind) {
  var base = siteBaseUrl();
  var signIn = base ? '\n\nSign in: ' + base + '/customer-login.html' : '';
  var create = base ? '\n\nCreate an account: ' + base + '/customer-login.html?tab=signup' : '';
  if (kind === 'exists') {
    sendAppEmail(email, 'You already have a Mwakete account',
      'Hi,\n\nSomeone (hopefully you) tried to create a Mwakete account with this email, but you already have one.' +
      ' Sign in instead - or use "Forgot password?" to set a new password.' + signIn +
      '\n\nIf this was not you, you can ignore this email; nothing has changed.');
  } else {
    sendAppEmail(email, 'Mwakete sign-in',
      'Hi,\n\nSomeone (hopefully you) asked to sign in to Mwakete with this email, but there is no account for it yet.' + create +
      '\n\nIf this was not you, you can ignore this email.');
  }
}

/** Finds a pending code row by the browser's token or by an emailed link token. */
function findCustomerCodeRow_(sheet, field, rawToken) {
  if (!rawToken) return null;
  var hashed = hashSecretToken(rawToken);
  var rows = sheetToObjects(sheet);
  for (var i = 0; i < rows.length; i++) {
    var stored = String(rows[i][field] || '');
    // Rows written before tokens were hashed hold the raw value.
    if (constantTimeEquals(stored, hashed) || (field === 'Token' && stored.indexOf(TOKEN_HASH_PREFIX) !== 0 && constantTimeEquals(stored, String(rawToken)))) return rows[i];
  }
  return null;
}

/**
 * Validates + consumes a one-time code. Pass either {token, code} (typed code)
 * or {linkToken} (the emailed link). Returns {ok:true, data:{...}} or a fail().
 * Single use: the row is deleted on success, on expiry and after too many
 * wrong tries, inside the script lock so two requests cannot both use it.
 */
function consumeCustomerEmailCode(token, code, expectedPurpose, linkToken) {
  if (!linkToken && (!token || !code)) return fail('Enter the code we emailed you');

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sheet = getSheet('CustomerCodes');
    var row = linkToken ? findCustomerCodeRow_(sheet, 'LinkHash', linkToken) : findCustomerCodeRow_(sheet, 'Token', token);
    var purposes = Array.isArray(expectedPurpose) ? expectedPurpose : [expectedPurpose];
    if (!row || purposes.indexOf(row.Purpose) === -1) {
      return fail(linkToken ? 'This link is invalid or has already been used. Request a new one.' : 'This code is invalid or has expired');
    }
    if (new Date(row.ExpiresAt).getTime() < Date.now()) {
      sheet.deleteRow(row.__row);
      return fail(linkToken ? 'This link has expired - please request a new one.' : 'This code has expired - please request a new one');
    }
    if (!linkToken) {
      if (Number(row.Attempts) >= TWOFA_MAX_ATTEMPTS) {
        sheet.deleteRow(row.__row);
        return fail('Too many incorrect attempts - please request a new code');
      }
      if (!constantTimeEquals(String(row.Code).trim(), String(code).trim())) {
        updateRowFromObject(sheet, row.__row, { Attempts: Number(row.Attempts) + 1 });
        return fail('Incorrect code, please try again');
      }
    }
    var data = { email: row.Email, name: row.Name, phone: row.Phone, passwordHash: row.PasswordHash || '',
      customerId: row.CustomerId || '', purpose: row.Purpose };
    sheet.deleteRow(row.__row);
    return { ok: true, data: data };
  } finally {
    lock.releaseLock();
  }
}

/* ---------- Sessions ---------- */

// "Remember me on this device" - a shopper should not have to sign in every
// week. Phones get shared here, though, so the long session is opt-OUT: the
// sign-in screen offers "This is a shared device", which keeps it to a day.
// TOKEN_EXPIRY_HOURS in Script Properties still wins over both when set.
var CUSTOMER_REMEMBER_HOURS = 24 * 60;   // 60 days
var CUSTOMER_SHARED_DEVICE_HOURS = 12;

function issueCustomerSession(customerId, opts) {
  opts = opts || {};
  var token = Utilities.getUuid() + Utilities.getUuid();
  var configured = Number(PropertiesService.getScriptProperties().getProperty('TOKEN_EXPIRY_HOURS'));
  var hours = configured || (opts.sharedDevice ? CUSTOMER_SHARED_DEVICE_HOURS : CUSTOMER_REMEMBER_HOURS);
  var expiresAt = new Date(Date.now() + hours * 3600 * 1000).toISOString();
  appendRowFromObject(getSheet('CustomerSessions'), {
    Token: hashSecretToken(token),   // a copy of the sheet is not a set of live sessions
    CustomerId: customerId,
    CreatedAt: nowIso(),
    ExpiresAt: expiresAt
  });
  return token;
}

/** The CustomerSessions row for a raw session token: a legacy raw row, else a hashed one. */
function findCustomerSessionRow(sheet, token) {
  if (!token) return null;
  return findRowBySecret(sheet, 'Token', token) || findRowBySecret(sheet, 'Token', hashSecretToken(token));
}

// Why the last signedInCustomer() said no - so a shopper who still has to
// confirm their email is told that, not "please sign in".
var LAST_CUSTOMER_AUTH_REFUSAL = '';
var VERIFY_EMAIL_FIRST = 'Please confirm your email address first - we sent a code to it. You can send a new one from your account page.';

/**
 * Validates a customer bearer token and returns the customer row, or throws.
 * Refuses suspended accounts always, and accounts whose email is not yet
 * confirmed (a Facebook sign-up, say) unless opts.allowUnverified - which only
 * the profile / verify-email / sign-out / sign-in-methods actions pass.
 */
function requireCustomerAuth(token, opts) {
  if (!token) throw new Error('Not signed in');
  var session = findCustomerSessionRow(getSheet('CustomerSessions'), token);
  if (!session) throw new Error('Not signed in');
  if (new Date(session.ExpiresAt).getTime() < Date.now()) throw new Error('Session expired, please sign in again');
  var customer = findRowById(getSheet('Customers'), 'CustomerId', session.CustomerId);
  if (!customer) throw new Error('Not signed in');
  if (customerIsSuspended(customer)) throw new Error('This account is suspended. Contact Mwakete via Help and support.');
  if (!(opts && opts.allowUnverified) && !customerMayTransact(customer)) throw new Error(VERIFY_EMAIL_FIRST);
  return customer;
}

/**
 * Owner decision, Oct 2026: a guest is a viewer. Placing an order, sending a
 * booking request, messaging a seller and reviewing all need a signed-in
 * customer - checked here on the server, not only hidden in the page.
 * Returns the customer, or null for a missing, unknown, expired, suspended or
 * not-yet-confirmed session.
 */
function signedInCustomer(token) {
  LAST_CUSTOMER_AUTH_REFUSAL = '';
  if (!token) return null;
  try { return requireCustomerAuth(token); } catch (e) { LAST_CUSTOMER_AUTH_REFUSAL = e.message || ''; return null; }
}

/** The refusal a guest gets; signInRequired lets the page send them to sign in. */
function signInRequiredFail(what) {
  if (LAST_CUSTOMER_AUTH_REFUSAL === VERIFY_EMAIL_FIRST) return Object.assign(fail(VERIFY_EMAIL_FIRST), { verifyEmailRequired: true });
  if (/suspended/.test(LAST_CUSTOMER_AUTH_REFUSAL)) return fail(LAST_CUSTOMER_AUTH_REFUSAL);
  return Object.assign(fail('Please sign in to ' + what + '. Guests can browse, but need an account for this.'), { signInRequired: true });
}

function customerCodeRateLimited(email) {
  return rateLimitHit('ratelimit:custcode:' + normalizeEmail(email), CUSTOMER_CODE_SEND_MAX, CUSTOMER_CODE_SEND_WINDOW_SECONDS);
}

/** The browser's handle for a request that must look the same when nothing was sent. */
function decoyPendingToken() {
  return generateToken();
}

/**
 * A sign-in that has been proven (password, code, Google, Facebook). Refuses a
 * suspended account, completes any pending provider link (providerLinkToken - see
 * CustomerIdentities.gs) and issues the session.
 */
function finishCustomerSignIn(customer, body, how) {
  if (customerIsSuspended(customer)) return fail('This account is suspended. Contact Mwakete via Help and support.');
  var linked = '';
  if (body && body.providerLinkToken) {
    var link = completePendingProviderLink(body.providerLinkToken, customer);
    if (!link.ok) return link;
    linked = link.provider;
  }
  var token = issueCustomerSession(customer.CustomerId, { sharedDevice: !!(body && body.sharedDevice === true) });
  logAuthEvent('signin', customer.CustomerId, how + (linked ? ' +link ' + linked : ''));
  return ok({ token: token, customer: publicCustomerFields(customer), linked: linked });
}

/* ---------- Actions (all PUBLIC - they do their own auth) ---------- */

/**
 * Create an account: name, email, password. Phone is no longer asked for here
 * (owner decision, Oct 2026) - an older page that still sends one is fine.
 * A page cached from before passwords existed may send no password: that
 * still creates a code-only account, the way it always did.
 */
function actionRegisterCustomer(body) {
  var name = String(body.name || '').trim();
  var email = normalizeEmail(body.email);
  var phone = String(body.phone || '').trim();
  var password = body.password === undefined || body.password === null ? null : String(body.password);

  if (!name) return fail('Please enter your name');
  var nameErr = capLength(name, 100, 'Name');
  if (nameErr) return nameErr;
  if (!EMAIL_FORMAT_RE.test(email) || email.length > 254) return fail('Enter a valid email address');
  if (password !== null) {
    var pwErr = passwordPolicyError(password);
    if (pwErr) return fail(pwErr);
  }
  if (phone) {
    var phoneErr = capLength(phone, 30, 'Phone number');
    if (phoneErr) return phoneErr;
    if (!isCustomerPhoneValid(phone)) {
      return fail('Local phone numbers must start with 730 or 630. For an overseas number, include your country code.');
    }
  }

  if (customerCodeRateLimited(email)) {
    return fail('Too many code requests - please wait a few minutes and try again.');
  }

  var existing = findCustomerByEmail(email);
  if (existing && customerEmailVerified(existing)) {
    // Same reply as a new address. The address's owner gets an email instead.
    sendCustomerNoticeEmail(email, 'exists');
    return ok({ pendingToken: decoyPendingToken(), sentTo: maskEmail(email), resendAfterSeconds: CUSTOMER_RESEND_COOLDOWN_SECONDS });
  }

  var issued = issueCustomerEmailCode(email, 'signup', {
    name: name, phone: phone, passwordHash: password !== null ? hashPasswordV2(password) : ''
  });
  coolDownCustomerResend_(issued.token);
  return ok({ pendingToken: issued.token, sentTo: maskEmail(email), resendAfterSeconds: CUSTOMER_RESEND_COOLDOWN_SECONDS });
}

function coolDownCustomerResend_(pendingToken) {
  try { CacheService.getScriptCache().put('custresend:' + hashSecretToken(pendingToken), '1', CUSTOMER_RESEND_COOLDOWN_SECONDS); } catch (e) { /* best effort */ }
}

/**
 * "Send the code again" from the waiting screen. Works for any pending code
 * (sign-up, sign-in, reset, verify). Same reply for a decoy token, so this
 * cannot be used to tell whether the address had an account either.
 */
function actionResendCustomerCode(body) {
  var token = String(body.pendingToken || '');
  if (!token) return fail('Start again - we could not find that request.');
  var cache = CacheService.getScriptCache();
  var coolKey = 'custresend:' + hashSecretToken(token);
  if (cache.get(coolKey)) return fail('Please wait a minute before asking for another code.');

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  var row, sheet;
  try {
    sheet = getSheet('CustomerCodes');
    row = findCustomerCodeRow_(sheet, 'Token', token);
    if (row) {
      if (customerCodeRateLimited(row.Email)) return fail('Too many code requests - please wait a few minutes and try again.');
      var linkToken = generateToken();
      var code = generate6DigitCode();
      var minutes = row.Purpose === 'login' ? TWOFA_CODE_EXPIRY_MINUTES : CUSTOMER_LINK_EXPIRY_MINUTES;
      updateRowFromObject(sheet, row.__row, {
        Code: code, Attempts: 0, LinkHash: hashSecretToken(linkToken),
        ExpiresAt: new Date(Date.now() + minutes * 60 * 1000).toISOString()
      });
    }
  } finally {
    lock.releaseLock();
  }
  try { cache.put(coolKey, '1', CUSTOMER_RESEND_COOLDOWN_SECONDS); } catch (e) { /* best effort */ }
  if (row) sendCustomerCodeEmail(row.Email, row.Purpose, code, linkToken, row.Name, minutes);
  return ok({ resendAfterSeconds: CUSTOMER_RESEND_COOLDOWN_SECONDS });
}

/** Creates (or completes) the Customers row for a confirmed sign-up. Caller holds the lock. */
function createVerifiedCustomer_(data) {
  var sheet = getSheet('Customers');
  ensureColumn(sheet, 'PasswordHash');
  var customer = findCustomerByEmail(data.email);
  if (!customer) {
    var customerId = newId('cust');
    appendRowFromObject(sheet, {
      CustomerId: customerId,
      Name: data.name,
      Email: data.email,
      Phone: data.phone || '',
      EmailVerified: 'true',
      CreatedAt: nowIso(),
      UpdatedAt: nowIso(),
      PasswordHash: data.passwordHash || ''
    });
    return findRowById(sheet, 'CustomerId', customerId);
  }
  // A row that exists but was never confirmed (from before codes) is completed
  // here; an already-confirmed one is never given a password by a sign-up.
  var patch = { UpdatedAt: nowIso() };
  if (!customerEmailVerified(customer)) {
    patch.EmailVerified = 'true';
    if (data.passwordHash) patch.PasswordHash = data.passwordHash;
  }
  updateRowFromObject(sheet, customer.__row, patch);
  return findRowById(sheet, 'CustomerId', customer.CustomerId);
}

/** Confirm a sign-up by typed code ({token, code}) or by the emailed link ({linkToken}). */
function actionVerifyCustomerEmail(body) {
  var result = consumeCustomerEmailCode(body.token, body.code, ['signup', 'verify'], body.linkToken);
  if (!result.ok) return result;
  if (result.data.purpose === 'verify') return applyVerifiedEmail_(result.data, body);

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  var customer;
  try {
    customer = createVerifiedCustomer_(result.data);
  } finally {
    lock.releaseLock();
  }
  logAuthEvent('verified', customer.CustomerId, 'signup');
  return finishCustomerSignIn(customer, body, 'signup');
}

/**
 * Signed-in shopper whose email is not confirmed yet (a Facebook sign-up, or
 * one who wants to change it): send a code + link to `email` (or to the
 * address already waiting in PendingEmail).
 */
function actionRequestCustomerEmailVerification(body) {
  var customer;
  try { customer = requireCustomerAuth(body.token, { allowUnverified: true }); } catch (e) { return fail(e.message || 'Not signed in'); }
  var email = normalizeEmail(body.email || customer.PendingEmail || customer.Email);
  if (!EMAIL_FORMAT_RE.test(email) || email.length > 254) return fail('Enter a valid email address');
  if (customerEmailVerified(customer) && normalizeEmail(customer.Email) === email) return fail('That email is already confirmed on your account.');
  if (customerCodeRateLimited(email)) return fail('Too many code requests - please wait a few minutes and try again.');

  var sheet = getSheet('Customers');
  ensureColumn(sheet, 'PendingEmail');
  updateRowFromObject(sheet, customer.__row, { PendingEmail: email, UpdatedAt: nowIso() });

  var owner = findCustomerByEmail(email);
  if (owner && owner.CustomerId !== customer.CustomerId && customerEmailVerified(owner)) {
    // Taken by another account: same reply; that address's owner is told.
    sendCustomerNoticeEmail(email, 'exists');
    return ok({ pendingToken: decoyPendingToken(), sentTo: maskEmail(email), resendAfterSeconds: CUSTOMER_RESEND_COOLDOWN_SECONDS });
  }
  var issued = issueCustomerEmailCode(email, 'verify', { name: customer.Name, customerId: customer.CustomerId });
  coolDownCustomerResend_(issued.token);
  return ok({ pendingToken: issued.token, sentTo: maskEmail(email), resendAfterSeconds: CUSTOMER_RESEND_COOLDOWN_SECONDS });
}

/** The code/link for a 'verify' request came back: that address is now this account's. */
function applyVerifiedEmail_(data, body) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  var customer;
  try {
    var sheet = getSheet('Customers');
    customer = findRowById(sheet, 'CustomerId', data.customerId);
    if (!customer) return fail('Account not found');
    var other = findCustomerByEmail(data.email);
    if (other && other.CustomerId !== customer.CustomerId && customerEmailVerified(other)) {
      return fail('That email now belongs to another Mwakete account. Sign in to that account instead, then link this sign-in method from its account page.');
    }
    updateRowFromObject(sheet, customer.__row, { Email: data.email, EmailVerified: 'true', PendingEmail: '', UpdatedAt: nowIso() });
    customer = findRowById(sheet, 'CustomerId', customer.CustomerId);
  } finally {
    lock.releaseLock();
  }
  logAuthEvent('verified', customer.CustomerId, 'email');
  return finishCustomerSignIn(customer, body, 'verify-email');
}

/**
 * Email + password sign-in. One reply for "no such account", "no password on
 * this account" and "wrong password", taking the same time, with the same
 * lockout as store sign-in (keyed on the address typed).
 */
function actionCustomerPasswordLogin(body) {
  var email = normalizeEmail(body.email);
  var password = String(body.password || '');
  if (!email || !password) return fail('Enter your email and password');
  if (password.length > PASSWORD_MAX_LENGTH) return fail('Email or password is incorrect');

  var customer = findCustomerByEmail(email);
  var stored = customer ? String(customer.PasswordHash || '') : '';
  var matches = stored ? verifyPassword(password, stored, '') : burnPasswordCheck(password);
  var success = matches && customerEmailVerified(customer);

  var lockout = checkAndRecordLoginAttempt('cust:' + email, success);
  if (lockout.locked) return fail('Too many failed sign-in attempts. Please try again in ' + lockout.retryAfterMinutes + ' minute(s), or use "Email me a code".');
  if (!success) return fail('Email or password is incorrect');

  if (passwordNeedsRehash(stored)) {
    try { updateRowFromObject(getSheet('Customers'), customer.__row, { PasswordHash: hashPasswordV2(password) }); } catch (e) { /* next time */ }
  }
  return finishCustomerSignIn(customer, body, 'password');
}

/**
 * "Email me a code instead". Same reply whether or not an account exists; when
 * there is none, the address gets a short note instead of a code.
 */
function actionLoginCustomer(body) {
  var email = normalizeEmail(body.email);
  if (!EMAIL_FORMAT_RE.test(email) || email.length > 254) return fail('Enter a valid email address');
  if (customerCodeRateLimited(email)) {
    return fail('Too many code requests - please wait a few minutes and try again.');
  }
  var customer = findCustomerByEmail(email);
  var reply = { sentTo: maskEmail(email), resendAfterSeconds: CUSTOMER_RESEND_COOLDOWN_SECONDS };
  if (!customer || !customerEmailVerified(customer) || customerIsSuspended(customer)) {
    if (!customer) sendCustomerNoticeEmail(email, 'none');
    return ok(Object.assign({ pendingToken: decoyPendingToken() }, reply));
  }
  var issued = issueCustomerEmailCode(email, 'login', { name: customer.Name, customerId: customer.CustomerId });
  coolDownCustomerResend_(issued.token);
  return ok(Object.assign({ pendingToken: issued.token }, reply));
}

function actionVerifyCustomerLogin(body) {
  var result = consumeCustomerEmailCode(body.token, body.code, 'login');
  if (!result.ok) return result;

  var customer = findCustomerByEmail(result.data.email);
  if (!customer) return fail('Account not found');
  return finishCustomerSignIn(customer, body, 'code');
}

/**
 * "Forgot password?" - and "Set a password" for shoppers who signed up with a
 * code or Google. Same reply whether or not the address has an account.
 */
function actionRequestCustomerPasswordReset(body) {
  var email = normalizeEmail(body.email);
  if (!EMAIL_FORMAT_RE.test(email) || email.length > 254) return fail('Enter a valid email address');
  if (customerCodeRateLimited(email)) return fail('Too many code requests - please wait a few minutes and try again.');
  var customer = findCustomerByEmail(email);
  var reply = { sentTo: maskEmail(email), resendAfterSeconds: CUSTOMER_RESEND_COOLDOWN_SECONDS };
  if (!customer || !customerEmailVerified(customer) || customerIsSuspended(customer)) {
    if (!customer) sendCustomerNoticeEmail(email, 'none');
    return ok(Object.assign({ pendingToken: decoyPendingToken() }, reply));
  }
  var issued = issueCustomerEmailCode(email, 'reset', { name: customer.Name, customerId: customer.CustomerId });
  coolDownCustomerResend_(issued.token);
  return ok(Object.assign({ pendingToken: issued.token }, reply));
}

/**
 * New password, by typed code ({token, code}) or by the emailed link
 * ({linkToken}). Signs the shopper out everywhere else (a reset may follow a
 * leaked password) and signs this device in.
 */
function actionResetCustomerPassword(body) {
  var pwErr = passwordPolicyError(body.newPassword);
  if (pwErr) return fail(pwErr);
  var result = consumeCustomerEmailCode(body.token, body.code, 'reset', body.linkToken);
  if (!result.ok) return result;

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  var customer;
  try {
    var sheet = getSheet('Customers');
    ensureColumn(sheet, 'PasswordHash');
    customer = findCustomerByEmail(result.data.email);
    if (!customer) return fail('Account not found');
    updateRowFromObject(sheet, customer.__row, { PasswordHash: hashPasswordV2(String(body.newPassword)), EmailVerified: 'true', UpdatedAt: nowIso() });
    customer = findRowById(sheet, 'CustomerId', customer.CustomerId);
  } finally {
    lock.releaseLock();
  }
  revokeAllCustomerSessions(customer.CustomerId);
  logAuthEvent('password-reset', customer.CustomerId, '');
  return finishCustomerSignIn(customer, body, 'reset');
}

/** Tries a password reset link before the form is shown, without using it up. */
function actionCheckCustomerLink(body) {
  var row = findCustomerCodeRow_(getSheet('CustomerCodes'), 'LinkHash', body.linkToken);
  if (!row || new Date(row.ExpiresAt).getTime() < Date.now()) return fail('This link is invalid, has expired or has already been used. Request a new one.');
  return ok({ purpose: row.Purpose, sentTo: maskEmail(row.Email) });
}

function revokeAllCustomerSessions(customerId) {
  var sheet = getSheet('CustomerSessions');
  sheetToObjects(sheet)
    .filter(function (s) { return String(s.CustomerId) === String(customerId); })
    .sort(function (a, b) { return b.__row - a.__row; })
    .forEach(function (s) { sheet.deleteRow(s.__row); });
}

/** "Sign out of all devices" from the account page. */
function actionLogoutAllCustomerSessions(body) {
  var customer;
  try { customer = requireCustomerAuth(body.token, { allowUnverified: true }); } catch (e) { return fail(e.message || 'Not signed in'); }
  revokeAllCustomerSessions(customer.CustomerId);
  logAuthEvent('signout-all', customer.CustomerId, '');
  return ok({});
}

/**
 * A short security log (sign-ins, resets, links, seller reviews) - who and
 * what, never a password, code or token. Best effort: never blocks the
 * action it records.
 */
function logAuthEvent(event, subjectId, detail) {
  try {
    var ss = SpreadsheetApp.getActive();
    var sheet = ss.getSheetByName('AuthEvents');
    if (!sheet) {
      sheet = ss.insertSheet('AuthEvents');
      sheet.getRange(1, 1, 1, 4).setValues([['At', 'Event', 'SubjectId', 'Detail']]);
    }
    appendRowFromObject(sheet, { At: nowIso(), Event: event, SubjectId: subjectId || '', Detail: String(detail || '').slice(0, 200) });
  } catch (e) { /* best effort */ }
}

/**
 * Does the signed-in customer also own a store?
 *
 * Answers ONLY for the authenticated customer's own address. It would be very
 * easy to write this as "does this email have a store" taking an email in the
 * body - and that would be an enumeration endpoint anyone could walk to learn
 * which addresses belong to vendors. The token decides whose email is checked;
 * the caller never supplies one.
 *
 * Returns the slug too, so the link can go straight to the store rather than
 * bouncing through a dashboard lookup. Closed/deleted stores report false, so
 * a vendor whose store was removed is offered "Create Store" rather than a
 * link into nothing.
 */
function actionGetCustomerStore(body) {
  var customer;
  try { customer = requireCustomerAuth(body.token); } catch (e) { return fail(e.message || 'Not signed in'); }

  var email = normalizeEmail(customer.Email);
  if (!email) return ok({ hasStore: false });

  var cacheKey = 'v1:custstore:' + email;
  return getCached(cacheKey, 60, function () {
    var owner = sheetToObjects(getSheet('Owners')).filter(function (o) {
      // ownerCanLogIn, not isStoreBrowsable: the question is "can this person
      // open their dashboard", and an admin's own store - hidden from shoppers
      // by isStoreBrowsable - still has a dashboard to open.
      return normalizeEmail(o.Email) === email && ownerCanLogIn(o);
    })[0];
    if (!owner) return ok({ hasStore: false });
    return ok({ hasStore: true, storeSlug: owner.StoreSlug, storeName: owner.StoreName });
  });
}

function actionGetCustomerProfile(body) {
  try {
    // Allowed before the email is confirmed: the account page is where that happens.
    var customer = requireCustomerAuth(body.token, { allowUnverified: true });
    return ok({ customer: publicCustomerFields(customer), signInMethods: customerSignInMethods(customer) });
  } catch (e) {
    return fail(e.message || 'Not signed in');
  }
}

function actionLogoutCustomer(body) {
  var sheet = getSheet('CustomerSessions');
  var session = findCustomerSessionRow(sheet, body.token);
  if (session) sheet.deleteRow(session.__row);
  return ok({});
}

/* ---------- Customer dashboard reads (Phase 3) ---------- */

function digitsOnly(s) {
  return String(s || '').replace(/\D/g, '');
}

// Resolve a store slug to its display name, memoised per call so a customer
// with orders across N stores does a bounded number of lookups.
function makeStoreNameResolver() {
  var cache = {};
  return function (slug) {
    if (Object.prototype.hasOwnProperty.call(cache, slug)) return cache[slug];
    var owner = getOwnerBySlug(slug);
    cache[slug] = owner ? owner.StoreName : slug;
    return cache[slug];
  };
}

/* ===================== Customer-managed orders & bookings =====================
 *
 * Everything below answers one question: may THIS signed-in customer change
 * THIS row, right now? Three rules, applied on the server, never inferred from
 * anything the browser sends:
 *
 *   ownership - the row's CustomerEmail (or, for a booking, phone) must match
 *               the account behind the token. The frontend never sends an
 *               identity; requireCustomerAuth resolves it from the session.
 *   status    - only a transaction that has not been acted on yet is editable,
 *               and only a finished one can be removed from the list.
 *   fields    - a fixed allowlist. Money, items, delivery costs, payment
 *               references, order/booking status and any seller-owned column
 *               are simply not reachable from these actions.
 *
 * Removal never deletes. It writes a CustomerHidden flag on the row, so the
 * transaction stays in the sheet in full, still visible to the seller and to
 * admin, still counted by every report - it just leaves the customer's list.
 * ============================================================================ */

var CUSTOMER_HIDDEN_COLUMN = 'CustomerHidden';
var CUSTOMER_HIDDEN_AT_COLUMN = 'CustomerHiddenAt';

// An order the seller has not yet acted on. Once it is Paid, Fulfilled or
// Cancelled the details have been acted on and must stop moving underneath
// the seller.
var CUSTOMER_EDITABLE_ORDER_STATUSES = ['Pending Payment'];
// Finished, one way or the other. A live order cannot be tidied away.
var CUSTOMER_ARCHIVABLE_ORDER_STATUSES = ['Fulfilled', 'Cancelled'];

var CUSTOMER_EDITABLE_BOOKING_STATUSES = ['Pending'];
var CUSTOMER_ARCHIVABLE_BOOKING_STATUSES = ['Declined', 'Cancelled'];

function isCustomerArchived(row) {
  return String(row[CUSTOMER_HIDDEN_COLUMN] || '').toLowerCase() === 'yes';
}

function orderIsEditable(o) {
  return !isCustomerArchived(o) && CUSTOMER_EDITABLE_ORDER_STATUSES.indexOf(o.Status) !== -1;
}

function orderIsArchivable(o) {
  return CUSTOMER_ARCHIVABLE_ORDER_STATUSES.indexOf(o.Status) !== -1;
}

function bookingIsEditable(b) {
  return !isCustomerArchived(b) && CUSTOMER_EDITABLE_BOOKING_STATUSES.indexOf(b.Status) !== -1;
}

/**
 * Terminal bookings, plus a Confirmed one whose return date has passed.
 *
 * Without that second case a Confirmed booking would be unremovable forever:
 * nothing ever moves it out of Confirmed, so a hire from last year would sit
 * at the top of the list with no way to clear it.
 */
function bookingIsArchivable(b) {
  if (CUSTOMER_ARCHIVABLE_BOOKING_STATUSES.indexOf(b.Status) !== -1) return true;
  if (b.Status !== 'Confirmed') return false;
  var end = new Date(b.EndDate).getTime();
  // Midnight today, the same way validateBookingDates gets it - so a booking
  // ending today is still current, not already archivable.
  var startOfToday = new Date(new Date().toDateString()).getTime();
  return !!end && !isNaN(end) && end < startOfToday;
}

function customerOwnsBooking(b, email, phone) {
  var byEmail = b.CustomerEmail && normalizeEmail(b.CustomerEmail) === email;
  var byPhone = phone && digitsOnly(b.CustomerPhone) === phone;
  return !!(byEmail || byPhone);
}

/**
 * Resolves the caller, then the row, then checks the row is theirs.
 *
 * Returns { error: ... } rather than throwing so each action reads as a flat
 * list of guards. The "not found" message is identical whether the row does
 * not exist or belongs to somebody else - a different message for each would
 * let anyone probe for valid order ids.
 */
function findOwnRow(body, sheetName, idField, idValue) {
  var customer;
  try { customer = requireCustomerAuth(body.token); } catch (e) { return { error: e.message || 'Not signed in' }; }
  if (!idValue) return { error: 'Missing id' };

  var sheet = getSheet(sheetName);
  var email = normalizeEmail(customer.Email);
  var phone = digitsOnly(customer.Phone);
  var rows = sheetToObjects(sheet);
  var row = null;
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][idField]) !== String(idValue)) continue;
    var mine = sheetName === 'Bookings'
      ? customerOwnsBooking(rows[i], email, phone)
      : normalizeEmail(rows[i].CustomerEmail) === email;
    if (!mine) break;
    row = rows[i];
    break;
  }
  if (!row) return { error: 'That record was not found in your account' };
  return { customer: customer, sheet: sheet, row: row };
}

/**
 * Edit the contact and delivery details on an order the seller has not acted
 * on yet.
 *
 * Deliberately cannot touch DeliveryMethod. The method a store offers, and
 * what it costs, is re-derived server-side at checkout from that store's live
 * configuration; letting it be changed here would mean re-running that whole
 * pricing path and silently moving the order total. Changing the method is a
 * conversation with the store, which the chat already handles.
 */
function invalidateCustomerListCaches(customer) {
  invalidateCache([
    'v1:custorders:' + customer.CustomerId + ':live',
    'v1:custorders:' + customer.CustomerId + ':all',
    'v1:custbookings:' + customer.CustomerId + ':live',
    'v1:custbookings:' + customer.CustomerId + ':all'
  ]);
}

function actionUpdateCustomerOrder(body) {
  var found = findOwnRow(body, 'Orders', 'OrderId', body.orderId);
  if (found.error) return fail(found.error);
  var o = found.row;

  if (isCustomerArchived(o)) return fail('This order has been removed from your list and can no longer be edited.');
  if (!orderIsEditable(o)) return fail('This order can no longer be edited.');

  var name = String(body.customerName || '').trim();
  var phone = String(body.customerPhone || '').trim();
  if (!name) return fail('Please enter your name');
  // Same rule as checkout: optional only for Pick up & pay.
  if (!phone && String(o.DeliveryMethod) !== 'pickPay') return fail('Please enter your phone number - it is needed for delivery');
  var nameErr = capLength(name, 100, 'Name');
  if (nameErr) return nameErr;
  var phoneErr = capLength(phone, 30, 'Phone number');
  if (phoneErr) return phoneErr;
  if (phone && !isCustomerPhoneValid(phone)) {
    return fail('Local phone numbers must start with 730 or 630. For an overseas number, include your country code.');
  }
  var island = String(body.island || '').trim();
  var village = String(body.village || '').trim();
  var islandErr = capLength(island, 100, 'Island');
  if (islandErr) return islandErr;
  var villageErr = capLength(village, 100, 'Village');
  if (villageErr) return villageErr;
  var notes = String(body.notes || '');
  var notesErr = capLength(notes, 2000, 'Notes');
  if (notesErr) return notesErr;

  updateRowFromObject(found.sheet, o.__row, {
    CustomerName: name,
    CustomerPhone: phone,
    Island: island,
    Village: village,
    // Kept consistent with how actionCreateOrder composes it.
    DeliveryAddress: village + ', ' + island,
    Notes: notes,
    UpdatedAt: nowIso()
  });

  invalidateCustomerListCaches(found.customer);
  return ok({ updated: true });
}

/**
 * Edit a booking request the store has not answered yet, dates included.
 *
 * New dates go through the SAME two checks a new request does: the shared
 * validateBookingDates, and a fresh uncached scan for an overlapping Confirmed
 * booking on the same product - excluding this row, or a booking would collide
 * with itself. Reusing them is the point: the rule about what a valid booking
 * window is lives in one place, not two that drift.
 */
function actionUpdateCustomerBooking(body) {
  var found = findOwnRow(body, 'Bookings', 'BookingId', body.bookingId);
  if (found.error) return fail(found.error);
  var b = found.row;

  if (isCustomerArchived(b)) return fail('This booking has been removed from your list and can no longer be edited.');
  if (!bookingIsEditable(b)) return fail('This booking can no longer be edited.');

  var name = String(body.customerName || '').trim();
  var phone = String(body.customerPhone || '').trim();
  if (!name || !phone) return fail('Name and phone number are required');
  var nameErr = capLength(name, 100, 'Name');
  if (nameErr) return nameErr;
  var phoneErr = capLength(phone, 30, 'Phone number');
  if (phoneErr) return phoneErr;
  var notes = String(body.notes || '');
  var notesErr = capLength(notes, 2000, 'Notes');
  if (notesErr) return notesErr;

  var startDate = String(body.startDate || '').trim();
  var endDate = String(body.endDate || '').trim();
  var dateErr = validateBookingDates(startDate, endDate);
  if (dateErr) return dateErr;

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sheet = getSheet('Bookings');
    // Re-read inside the lock: the status may have changed between the check
    // above and here, and a booking confirmed in that gap must not be edited.
    var fresh = findRowById(sheet, 'BookingId', b.BookingId);
    if (!fresh) return fail('That record was not found in your account');
    if (!bookingIsEditable(fresh)) return fail('This booking can no longer be edited.');

    var clash = sheetToObjects(sheet).some(function (other) {
      return other.BookingId !== fresh.BookingId &&
        other.ProductId === fresh.ProductId &&
        other.Status === 'Confirmed' &&
        datesOverlap(startDate, endDate, other.StartDate, other.EndDate);
    });
    if (clash) return fail('Those dates are already booked. Please choose different dates.');

    updateRowFromObject(sheet, fresh.__row, {
      CustomerName: name,
      CustomerPhone: phone,
      StartDate: startDate,
      EndDate: endDate,
      Notes: notes,
      UpdatedAt: nowIso()
    });
  } finally {
    lock.releaseLock();
  }

  invalidateCustomerListCaches(found.customer);
  return ok({ updated: true });
}

/**
 * Hide a finished order from the customer's list, or put it back.
 *
 * Writes a flag. The row is never deleted, never emptied and never moved: the
 * seller's list, the admin views and every total still see it exactly as
 * before. ensureColumn creates the flag column on first use, appended past the
 * last header so no existing column shifts.
 */
function actionSetCustomerOrderArchived(body) {
  var found = findOwnRow(body, 'Orders', 'OrderId', body.orderId);
  if (found.error) return fail(found.error);
  var o = found.row;
  var archived = body.archived !== false;

  if (archived && !orderIsArchivable(o)) {
    return fail('An order can only be removed from your list once it is completed or cancelled.');
  }

  ensureColumn(found.sheet, CUSTOMER_HIDDEN_COLUMN);
  ensureColumn(found.sheet, CUSTOMER_HIDDEN_AT_COLUMN);
  var patch = {};
  patch[CUSTOMER_HIDDEN_COLUMN] = archived ? 'yes' : '';
  patch[CUSTOMER_HIDDEN_AT_COLUMN] = archived ? nowIso() : '';
  updateRowFromObject(found.sheet, o.__row, patch);

  invalidateCustomerListCaches(found.customer);
  return ok({ archived: archived });
}

function actionSetCustomerBookingArchived(body) {
  var found = findOwnRow(body, 'Bookings', 'BookingId', body.bookingId);
  if (found.error) return fail(found.error);
  var b = found.row;
  var archived = body.archived !== false;

  if (archived && !bookingIsArchivable(b)) {
    return fail('A booking can only be removed from your list once it is finished, declined or cancelled.');
  }

  ensureColumn(found.sheet, CUSTOMER_HIDDEN_COLUMN);
  ensureColumn(found.sheet, CUSTOMER_HIDDEN_AT_COLUMN);
  var patch = {};
  patch[CUSTOMER_HIDDEN_COLUMN] = archived ? 'yes' : '';
  patch[CUSTOMER_HIDDEN_AT_COLUMN] = archived ? nowIso() : '';
  updateRowFromObject(found.sheet, b.__row, patch);

  invalidateCustomerListCaches(found.customer);
  return ok({ archived: archived });
}

// Each of these scans a whole tab (Orders / Bookings) to find one customer's
// rows, and the Account page fires both together. 30s is enough to collapse
// that pair plus a filter tap or a back-and-forward, and short enough that a
// seller marking an order Fulfilled shows up almost immediately. The key
// includes the archived flag so the Archived filter is cached separately
// rather than overwriting the default view.
var CUSTOMER_LIST_CACHE_TTL_SECONDS = 30;

function actionListCustomerOrders(body) {
  var customer;
  try { customer = requireCustomerAuth(body.token); } catch (e) { return fail(e.message || 'Not signed in'); }

  var cacheKey = 'v1:custorders:' + customer.CustomerId + ':' + (body.includeArchived === true ? 'all' : 'live');
  var res = getCached(cacheKey, CUSTOMER_LIST_CACHE_TTL_SECONDS, function () {
    return buildCustomerOrders(customer, body);
  });
  // driversOpen: the dashboard shows "Drive with Mwakete" only once drivers
  // are switched on (DELIVERY_JOBS). Added outside the cache so switching it
  // takes effect at once. typeof guard: a backend missing Deliveries.gs must
  // never break the customer's order list.
  if (res && res.ok) res.driversOpen = typeof deliveriesEnabled === 'function' && deliveriesEnabled();
  return res;
}

function buildCustomerOrders(customer, body) {
  var email = normalizeEmail(customer.Email);
  var storeName = makeStoreNameResolver();
  // includeArchived is how the Archived filter asks for the hidden ones back.
  // Default false, so nothing a customer removed reappears by accident.
  var includeArchived = body.includeArchived === true;
  var orders = sheetToObjects(getSheet('Orders'))
    .filter(function (o) {
      if (normalizeEmail(o.CustomerEmail) !== email) return false;
      return includeArchived || !isCustomerArchived(o);
    });
  orders.sort(function (a, b) { return new Date(b.CreatedAt) - new Date(a.CreatedAt); });
  var tx = typeof txSummariesFor === 'function' ? txSummariesFor(orders, 'buyer') : {};

  var out = orders.map(function (o) {
    var items = [];
    try { items = JSON.parse(o.ItemsJson || '[]'); } catch (e) { /* malformed row */ }
    return {
      orderId: o.OrderId,
      storeSlug: o.StoreSlug,
      storeName: storeName(o.StoreSlug),
      items: items,
      itemsSummary: o.ItemsSummary,
      deliveryMethod: o.DeliveryMethod,
      deliveryCost: o.DeliveryCost,
      total: o.Total,
      status: o.Status,
      createdAt: o.CreatedAt,
      island: o.Island,
      village: o.Village,
      customerName: o.CustomerName,
      customerPhone: o.CustomerPhone,
      notes: o.Notes,
      // Computed here, from the same rules the write actions enforce, so the
      // page never has to guess - and never becomes the thing deciding.
      archived: isCustomerArchived(o),
      canEdit: orderIsEditable(o),
      canArchive: orderIsArchivable(o),
      // Order room summary, or null when rooms are off for this store.
      room: typeof txRoomAvailable === 'function' && txRoomAvailable(o) ? (tx[o.OrderId] || { flow: 'none' }) : null
    };
  });
  return ok({ orders: out });
}

function actionListCustomerBookings(body) {
  var customer;
  try { customer = requireCustomerAuth(body.token); } catch (e) { return fail(e.message || 'Not signed in'); }

  var cacheKey = 'v1:custbookings:' + customer.CustomerId + ':' + (body.includeArchived === true ? 'all' : 'live');
  return getCached(cacheKey, CUSTOMER_LIST_CACHE_TTL_SECONDS, function () {
    return buildCustomerBookings(customer, body);
  });
}

function buildCustomerBookings(customer, body) {
  var email = normalizeEmail(customer.Email);
  var phone = digitsOnly(customer.Phone);
  var storeName = makeStoreNameResolver();
  var includeArchived = body.includeArchived === true;
  var rows = sheetToObjects(getSheet('Bookings')).filter(function (b) {
    if (!customerOwnsBooking(b, email, phone)) return false;
    return includeArchived || !isCustomerArchived(b);
  });
  rows.sort(function (a, b) { return new Date(b.CreatedAt) - new Date(a.CreatedAt); });

  var out = rows.map(function (b) {
    return {
      bookingId: b.BookingId,
      storeSlug: b.StoreSlug,
      storeName: storeName(b.StoreSlug),
      productName: b.ProductName,
      rateLabel: b.RateLabel,
      startDate: b.StartDate,
      endDate: b.EndDate,
      status: b.Status,
      createdAt: b.CreatedAt,
      customerName: b.CustomerName,
      customerPhone: b.CustomerPhone,
      notes: b.Notes,
      archived: isCustomerArchived(b),
      canEdit: bookingIsEditable(b),
      canArchive: bookingIsArchivable(b)
    };
  });
  return ok({ bookings: out });
}

function actionUpdateCustomerProfile(body) {
  var customer;
  try { customer = requireCustomerAuth(body.token, { allowUnverified: true }); } catch (e) { return fail(e.message || 'Not signed in'); }

  var name = String(body.name || '').trim();
  var phone = String(body.phone || '').trim();
  if (!name) return fail('Please enter your name');
  var nameErr = capLength(name, 100, 'Name');
  if (nameErr) return nameErr;
  // Optional (owner decision, Oct 2026): checkout asks for it when delivery needs it.
  if (phone) {
    var phoneErr = capLength(phone, 30, 'Phone number');
    if (phoneErr) return phoneErr;
    if (!isCustomerPhoneValid(phone)) {
      return fail('Local phone numbers must start with 730 or 630. For an overseas number, include your country code.');
    }
  }

  updateRowFromObject(getSheet('Customers'), customer.__row, { Name: name, Phone: phone, UpdatedAt: nowIso() });
  customer.Name = name;
  customer.Phone = phone;
  return ok({ customer: publicCustomerFields(customer) });
}
