/**
 * Customer accounts — passwordless email-code sign-up / sign-in.
 *
 * Deliberately separate from the owner/vendor auth in Auth.gs (its own sheets
 * and helpers) so owner login is completely untouched. Reuses the shared
 * primitives (generate6DigitCode, generateToken, constantTimeEquals,
 * sendAppEmail, the Db.gs row helpers) and the same code-expiry / attempt caps
 * as owner 2FA (TWOFA_CODE_EXPIRY_MINUTES / TWOFA_MAX_ATTEMPTS).
 *
 * REQUIRES three Sheet tabs (getSheet throws if missing) — create with these
 * exact header rows:
 *   Customers:        CustomerId | Name | Email | Phone | EmailVerified | CreatedAt | UpdatedAt
 *   CustomerSessions: Token | CustomerId | CreatedAt | ExpiresAt
 *   CustomerCodes:    Token | Email | Code | Purpose | Name | Phone | CreatedAt | ExpiresAt | Attempts
 */

var CUSTOMER_CODE_SEND_MAX = 5;                // code emails allowed per address...
var CUSTOMER_CODE_SEND_WINDOW_SECONDS = 900;   // ...per 15 minutes (anti email-bomb)

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function findCustomerByEmail(email) {
  var norm = normalizeEmail(email);
  var rows = sheetToObjects(getSheet('Customers'));
  for (var i = 0; i < rows.length; i++) {
    if (normalizeEmail(rows[i].Email) === norm) return rows[i];
  }
  return null;
}

function publicCustomerFields(c) {
  return {
    customerId: c.CustomerId,
    name: c.Name,
    email: c.Email,
    phone: c.Phone,
    emailVerified: String(c.EmailVerified) === 'true'
  };
}

// One-time email code (mirrors issueTwoFACode). `name`/`phone` carry the pending
// signup details so no Customers row is created until the code is confirmed.
function issueCustomerEmailCode(email, purpose, name, phone) {
  var token = generateToken();
  var code = generate6DigitCode();
  var expiresAt = new Date(Date.now() + TWOFA_CODE_EXPIRY_MINUTES * 60 * 1000).toISOString();
  appendRowFromObject(getSheet('CustomerCodes'), {
    Token: token,
    Email: normalizeEmail(email),
    Code: code,
    Purpose: purpose,
    Name: name || '',
    Phone: phone || '',
    CreatedAt: nowIso(),
    ExpiresAt: expiresAt,
    Attempts: 0
  });

  var isSignup = purpose === 'signup';
  var subject = isSignup ? 'Confirm your Mwakete account' : 'Your Mwakete sign-in code';
  var greeting = name ? ('Hi ' + name + ',\n\n') : 'Hi,\n\n';
  var body = greeting +
    'Your Mwakete ' + (isSignup ? 'account confirmation' : 'sign-in') + ' code is: ' + code + '\n\n' +
    'Enter this code to ' + (isSignup ? 'finish creating your account' : 'sign in') + '. ' +
    'It expires in ' + TWOFA_CODE_EXPIRY_MINUTES + ' minutes.\n\n' +
    'If this was not you, you can safely ignore this email.';
  sendAppEmail(email, subject, body);

  return { token: token };
}

// Validate + consume a one-time code (mirrors consumeTwoFACode). Returns
// {ok:true, data:{email,name,phone}} or a fail() object.
function consumeCustomerEmailCode(token, code, expectedPurpose) {
  if (!token || !code) return fail('Enter the code we emailed you');

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sheet = getSheet('CustomerCodes');
    var row = findRowBySecret(sheet, 'Token', token);
    if (!row || row.Purpose !== expectedPurpose) return fail('This code is invalid or has expired');
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
    var data = { email: row.Email, name: row.Name, phone: row.Phone };
    sheet.deleteRow(row.__row);
    return { ok: true, data: data };
  } finally {
    lock.releaseLock();
  }
}

function issueCustomerSession(customerId) {
  var token = Utilities.getUuid() + Utilities.getUuid();
  var hours = Number(PropertiesService.getScriptProperties().getProperty('TOKEN_EXPIRY_HOURS')) || TOKEN_EXPIRY_HOURS_DEFAULT;
  var expiresAt = new Date(Date.now() + hours * 3600 * 1000).toISOString();
  appendRowFromObject(getSheet('CustomerSessions'), {
    Token: token,
    CustomerId: customerId,
    CreatedAt: nowIso(),
    ExpiresAt: expiresAt
  });
  return token;
}

/** Validates a customer bearer token and returns the customer row, or throws. */
function requireCustomerAuth(token) {
  if (!token) throw new Error('Not signed in');
  var session = findRowBySecret(getSheet('CustomerSessions'), 'Token', token);
  if (!session) throw new Error('Not signed in');
  if (new Date(session.ExpiresAt).getTime() < Date.now()) throw new Error('Session expired, please sign in again');
  var customer = findRowById(getSheet('Customers'), 'CustomerId', session.CustomerId);
  if (!customer) throw new Error('Not signed in');
  return customer;
}

function customerCodeRateLimited(email) {
  return rateLimitHit('ratelimit:custcode:' + normalizeEmail(email), CUSTOMER_CODE_SEND_MAX, CUSTOMER_CODE_SEND_WINDOW_SECONDS);
}

/* ---------- Actions (all PUBLIC — they do their own auth) ---------- */

function actionRegisterCustomer(body) {
  var name = String(body.name || '').trim();
  var email = normalizeEmail(body.email);
  var phone = String(body.phone || '').trim();

  if (!name) return fail('Please enter your name');
  var nameErr = capLength(name, 100, 'Name');
  if (nameErr) return nameErr;
  if (!EMAIL_FORMAT_RE.test(email)) return fail('Enter a valid email address');
  if (!phone) return fail('Please enter your phone number');
  var phoneErr = capLength(phone, 30, 'Phone number');
  if (phoneErr) return phoneErr;
  if (!isCustomerPhoneValid(phone)) {
    return fail('Local phone numbers must start with 730 or 630. For an overseas number, include your country code.');
  }

  var existing = findCustomerByEmail(email);
  if (existing && String(existing.EmailVerified) === 'true') {
    return fail('That email already has an account - please sign in instead.');
  }

  if (customerCodeRateLimited(email)) {
    return fail('Too many code requests - please wait a few minutes and try again.');
  }
  var issued = issueCustomerEmailCode(email, 'signup', name, phone);
  return ok({ pendingToken: issued.token });
}

function actionVerifyCustomerEmail(body) {
  var result = consumeCustomerEmailCode(body.token, body.code, 'signup');
  if (!result.ok) return result;

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var customer = findCustomerByEmail(result.data.email);
    if (!customer) {
      var customerId = newId('cust');
      appendRowFromObject(getSheet('Customers'), {
        CustomerId: customerId,
        Name: result.data.name,
        Email: result.data.email,
        Phone: result.data.phone,
        EmailVerified: 'true',
        CreatedAt: nowIso(),
        UpdatedAt: nowIso()
      });
      customer = findRowById(getSheet('Customers'), 'CustomerId', customerId);
    } else if (String(customer.EmailVerified) !== 'true') {
      updateRowFromObject(getSheet('Customers'), customer.__row, { EmailVerified: 'true', UpdatedAt: nowIso() });
      customer.EmailVerified = 'true';
    }
    var token = issueCustomerSession(customer.CustomerId);
    return ok({ token: token, customer: publicCustomerFields(customer) });
  } finally {
    lock.releaseLock();
  }
}

function actionLoginCustomer(body) {
  var email = normalizeEmail(body.email);
  if (!EMAIL_FORMAT_RE.test(email)) return fail('Enter a valid email address');

  var customer = findCustomerByEmail(email);
  if (!customer || String(customer.EmailVerified) !== 'true') {
    return fail('No account found for that email - please create one.');
  }
  if (customerCodeRateLimited(email)) {
    return fail('Too many code requests - please wait a few minutes and try again.');
  }
  var issued = issueCustomerEmailCode(email, 'login', customer.Name, '');
  return ok({ pendingToken: issued.token });
}

function actionVerifyCustomerLogin(body) {
  var result = consumeCustomerEmailCode(body.token, body.code, 'login');
  if (!result.ok) return result;

  var customer = findCustomerByEmail(result.data.email);
  if (!customer) return fail('Account not found');
  var token = issueCustomerSession(customer.CustomerId);
  return ok({ token: token, customer: publicCustomerFields(customer) });
}

function actionGetCustomerProfile(body) {
  try {
    var customer = requireCustomerAuth(body.token);
    return ok({ customer: publicCustomerFields(customer) });
  } catch (e) {
    return fail(e.message || 'Not signed in');
  }
}

function actionLogoutCustomer(body) {
  var sheet = getSheet('CustomerSessions');
  var session = findRowBySecret(sheet, 'Token', body.token);
  if (session) sheet.deleteRow(session.__row);
  return ok({});
}
