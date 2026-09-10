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

// "Remember me on this device" - a shopper should not have to sign in every
// week. Phones get shared here, though, and order history carries names, phone
// numbers and delivery addresses, so the long session is opt-OUT rather than
// unavoidable: the sign-in screen offers "This is a shared device", which keeps
// the session to a single day.
//
// TOKEN_EXPIRY_HOURS in Script Properties still wins over both when set, so a
// deployment that wants something different does not have to edit code.
var CUSTOMER_REMEMBER_HOURS = 24 * 60;   // 60 days
var CUSTOMER_SHARED_DEVICE_HOURS = 12;

function issueCustomerSession(customerId, opts) {
  opts = opts || {};
  var token = Utilities.getUuid() + Utilities.getUuid();
  var configured = Number(PropertiesService.getScriptProperties().getProperty('TOKEN_EXPIRY_HOURS'));
  var hours = configured || (opts.sharedDevice ? CUSTOMER_SHARED_DEVICE_HOURS : CUSTOMER_REMEMBER_HOURS);
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
    var token = issueCustomerSession(customer.CustomerId, { sharedDevice: body.sharedDevice === true });
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
  var token = issueCustomerSession(customer.CustomerId, { sharedDevice: body.sharedDevice === true });
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
  if (!phone) return fail('Please enter your phone number');
  var nameErr = capLength(name, 100, 'Name');
  if (nameErr) return nameErr;
  var phoneErr = capLength(phone, 30, 'Phone number');
  if (phoneErr) return phoneErr;
  if (!isCustomerPhoneValid(phone)) {
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
  return getCached(cacheKey, CUSTOMER_LIST_CACHE_TTL_SECONDS, function () {
    return buildCustomerOrders(customer, body);
  });
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
      canArchive: orderIsArchivable(o)
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
  try { customer = requireCustomerAuth(body.token); } catch (e) { return fail(e.message || 'Not signed in'); }

  var name = String(body.name || '').trim();
  var phone = String(body.phone || '').trim();
  if (!name) return fail('Please enter your name');
  var nameErr = capLength(name, 100, 'Name');
  if (nameErr) return nameErr;
  if (!phone) return fail('Please enter your phone number');
  var phoneErr = capLength(phone, 30, 'Phone number');
  if (phoneErr) return phoneErr;
  if (!isCustomerPhoneValid(phone)) {
    return fail('Local phone numbers must start with 730 or 630. For an overseas number, include your country code.');
  }

  updateRowFromObject(getSheet('Customers'), customer.__row, { Name: name, Phone: phone, UpdatedAt: nowIso() });
  customer.Name = name;
  customer.Phone = phone;
  return ok({ customer: publicCustomerFields(customer) });
}
