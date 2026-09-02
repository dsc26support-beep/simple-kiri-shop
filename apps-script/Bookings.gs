/**
 * Booking-listing requests (rental cars, hotels, tours, etc.) and their
 * confirm/decline lifecycle. Kept separate from Orders.gs: a booking has no
 * cart, no delivery method, and a stricter status lifecycle - Pending only
 * ever moves to Confirmed or Declined, Confirmed only ever moves to
 * Cancelled, nothing else is legal - unlike actionUpdateOrderStatus's
 * any-status-to-any-status Orders update. All of that exists to support one
 * real guarantee: two Confirmed bookings for the same ProductId can never
 * have overlapping dates. See actionUpdateBookingStatus below for where
 * that's actually enforced.
 */

var VALID_BOOKING_STATUSES = ['Pending', 'Confirmed', 'Declined', 'Cancelled'];
var BOOKING_TRANSITIONS = {
  Pending: ['Confirmed', 'Declined'],
  Confirmed: ['Cancelled']
};

/** Half-open interval overlap: true iff [aStart,aEnd) and [bStart,bEnd) share any day. */
function datesOverlap(aStart, aEnd, bStart, bEnd) {
  return new Date(aStart) < new Date(bEnd) && new Date(bStart) < new Date(aEnd);
}

// Abuse guard against nonsensical date ranges, not a real product
// constraint - see actionCreateBookingRequest's rate-limiting comment.
var BOOKING_DATE_MAX_FUTURE_MS = 2 * 365 * 24 * 60 * 60 * 1000;

function validateBookingDates(startDate, endDate) {
  var start = new Date(startDate);
  var end = new Date(endDate);
  if (isNaN(start.getTime()) || isNaN(end.getTime())) return fail('Please provide valid start and end dates');
  if (start >= end) return fail('End date must be after start date');
  if (start < new Date(new Date().toDateString())) return fail('Start date cannot be in the past');
  if (start.getTime() - Date.now() > BOOKING_DATE_MAX_FUTURE_MS) return fail('Start date is too far in the future');
  return null;
}

/**
 * Which of the given booking-category productIds have a Confirmed booking
 * covering "today" - drives the simple Available/Unavailable badge shown on
 * a listing card so a customer doesn't have to open the date picker just to
 * find out it's booked right now. Uses getSheetByName directly (not
 * getSheet(), which throws) since a store with zero booking-category
 * listings may never have created a Bookings tab at all - this must degrade
 * to "no availability data" rather than break the entire product listing
 * response over a tab that isn't relevant to that store yet. Only ever
 * called with an already-narrowed productIds list (booking-category
 * products already loaded by the caller), so this never scans Bookings for
 * a store with nothing to check.
 */
function unavailableProductIdsToday(productIds) {
  var unavailable = {};
  if (!productIds || productIds.length === 0) return unavailable;
  var sheet = SpreadsheetApp.getActive().getSheetByName('Bookings');
  if (!sheet) return unavailable;

  var todayStr = new Date().toISOString().slice(0, 10);
  var tomorrowStr = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  sheetToObjects(sheet).forEach(function (b) {
    if (b.Status !== 'Confirmed') return;
    if (productIds.indexOf(b.ProductId) === -1) return;
    if (datesOverlap(todayStr, tomorrowStr, b.StartDate, b.EndDate)) unavailable[b.ProductId] = true;
  });
  return unavailable;
}

/**
 * Unauthenticated, like actionCreateOrder - prices/rate details are always
 * re-derived server-side from the live Variants row, never trusted from the
 * client. No dedicated rate limiter (unlike chat's checkChatRateLimit): this
 * form already requires name/phone/valid dates, a much higher friction bar
 * than firing chat messages, so length caps + date-sanity checks are the
 * abuse guard here. If real volumetric abuse shows up later, add this action
 * to a rateLimitHit() counter (Utils.gs) - not built speculatively now.
 */
function actionCreateBookingRequest(body) {
  var slug = body.storeSlug;
  if (!slug) return fail('storeSlug is required');
  var owner = getOwnerBySlug(slug);
  if (!isStoreBrowsable(owner)) return fail('Store not found');
  // Browsable but closed: the storefront and chat stay open, taking money
  // does not. Re-checked here because the client cannot be trusted to.
  if (!isStoreOpenForBusiness(owner)) {
    return fail('This store is closed right now and cannot take bookings. You can still chat with them to ask when they reopen.');
  }

  var customerName = String(body.customerName || '').trim();
  var customerPhone = String(body.customerPhone || '').trim();
  if (!customerName || !customerPhone) return fail('Name and phone number are required');
  var nameErr = capLength(customerName, 100, 'Name');
  if (nameErr) return nameErr;
  var phoneErr = capLength(customerPhone, 30, 'Phone number');
  if (phoneErr) return phoneErr;
  var islandErr = capLength(body.island, 100, 'Island');
  if (islandErr) return islandErr;
  var villageErr = capLength(body.village, 100, 'Village');
  if (villageErr) return villageErr;
  var notesErr = capLength(body.notes, 2000, 'Notes');
  if (notesErr) return notesErr;
  if (!body.productId || !body.variantId) return fail('A rate/product selection is required');

  var dateErr = validateBookingDates(body.startDate, body.endDate);
  if (dateErr) return dateErr;

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var product = sheetToObjects(getSheet('Products')).filter(function (p) {
      return p.ProductId === body.productId && p.OwnerId === owner.OwnerId && p.Status === 'active';
    })[0];
    if (!product || !isBookingCategory(product.Category)) return fail('This listing is not available for booking');

    var variant = sheetToObjects(getSheet('Variants')).filter(function (v) {
      return v.VariantId === body.variantId && v.ProductId === product.ProductId && v.Status === 'active';
    })[0];
    if (!variant) return fail('That rate is no longer available. Please refresh and try again.');

    // Fresh, uncached read (never getCached - see actionUpdateBookingStatus's
    // matching comment for why): blocks requesting dates that are already
    // Confirmed elsewhere. Deliberately does NOT block on overlapping
    // Pending requests - multiple customers can have pending requests for
    // the same window, the vendor picks one at confirm time.
    var bookingsSheet = getSheet('Bookings');
    var conflictsConfirmed = sheetToObjects(bookingsSheet).some(function (b) {
      return b.ProductId === product.ProductId && b.Status === 'Confirmed' &&
        datesOverlap(body.startDate, body.endDate, b.StartDate, b.EndDate);
    });
    if (conflictsConfirmed) return fail('Those dates are already booked. Please choose different dates.');

    var bookingId = newId('bkg');
    var now = nowIso();
    appendRowFromObject(bookingsSheet, {
      BookingId: bookingId,
      OwnerId: owner.OwnerId,
      StoreSlug: slug,
      ProductId: product.ProductId,
      ProductName: product.Name,
      VariantId: variant.VariantId,
      RateLabel: variant.Label,
      RatePrice: Number(variant.Price),
      CustomerName: customerName,
      CustomerPhone: customerPhone,
      CustomerEmail: body.customerEmail || '',
      Island: body.island || '',
      Village: body.village || '',
      Notes: body.notes || '',
      StartDate: body.startDate,
      EndDate: body.endDate,
      Status: 'Pending',
      CreatedAt: now,
      UpdatedAt: now
    });

    return ok({
      bookingId: bookingId,
      status: 'Pending',
      productName: product.Name,
      rateLabel: variant.Label,
      ratePrice: Number(variant.Price),
      startDate: body.startDate,
      endDate: body.endDate
    });
  } finally {
    lock.releaseLock();
  }
}

/**
 * Paginated via body.limit/offset (same shape as actionListOwnerOrders) -
 * see docs/production-readiness-report.md Finding 10. Flags each Pending
 * booking whose dates overlap an already-Confirmed booking on the same
 * ProductId (overlapsConfirmed) so the vendor can see at a glance which
 * requests to manually decline - the app deliberately does not auto-decline
 * them (nothing else in this codebase auto-cascades a status change onto
 * other rows, and the vendor may still want to offer the customer
 * alternate dates via chat).
 */
function actionListOwnerBookings(owner, body) {
  body = body || {};
  var allBookings = sheetToObjects(getSheet('Bookings')).filter(function (b) { return b.OwnerId === owner.OwnerId; });
  allBookings.sort(function (a, b) { return new Date(b.CreatedAt) - new Date(a.CreatedAt); });

  var confirmedByProduct = {};
  allBookings.forEach(function (b) {
    if (b.Status !== 'Confirmed') return;
    (confirmedByProduct[b.ProductId] = confirmedByProduct[b.ProductId] || []).push(b);
  });

  var limit = clampPageSize(body.limit, DEFAULT_LIST_PAGE_SIZE, MAX_LIST_PAGE_SIZE);
  var offset = Math.max(0, Number(body.offset) || 0);
  var page = allBookings.slice(offset, offset + limit);

  var result = page.map(function (b) {
    var overlapsConfirmed = false;
    if (b.Status === 'Pending') {
      overlapsConfirmed = (confirmedByProduct[b.ProductId] || []).some(function (c) {
        return c.BookingId !== b.BookingId && datesOverlap(b.StartDate, b.EndDate, c.StartDate, c.EndDate);
      });
    }
    return {
      bookingId: b.BookingId,
      productId: b.ProductId,
      productName: b.ProductName,
      rateLabel: b.RateLabel,
      ratePrice: Number(b.RatePrice),
      customerName: b.CustomerName,
      customerPhone: b.CustomerPhone,
      customerEmail: b.CustomerEmail,
      island: b.Island,
      village: b.Village,
      notes: b.Notes,
      startDate: b.StartDate,
      endDate: b.EndDate,
      status: b.Status,
      overlapsConfirmed: overlapsConfirmed,
      createdAt: b.CreatedAt
    };
  });

  return ok({ bookings: result, total: allBookings.length, hasMore: offset + limit < allBookings.length });
}

function actionUpdateBookingStatus(owner, body) {
  if (VALID_BOOKING_STATUSES.indexOf(body.status) === -1) return fail('Invalid status');
  var sheet = getSheet('Bookings');
  var existing = findRowById(sheet, 'BookingId', body.bookingId);
  if (!existing || existing.OwnerId !== owner.OwnerId) return fail('Booking not found');

  var allowed = BOOKING_TRANSITIONS[existing.Status] || [];
  if (allowed.indexOf(body.status) === -1) {
    return fail('Cannot change a ' + existing.Status + ' booking to ' + body.status);
  }

  if (body.status !== 'Confirmed') {
    // Declined/Cancelled: a single read+write, not a check-then-write race -
    // same reasoning actionUpdateOrderStatus itself relies on for skipping a
    // lock entirely.
    updateRowFromObject(sheet, existing.__row, { Status: body.status, UpdatedAt: nowIso() });
    return ok({});
  }

  // This is the actual double-booking guarantee. Re-check for a conflicting
  // Confirmed booking on this ProductId INSIDE the lock, reading fresh -
  // never getCached, since staleness here would be a correctness bug, not
  // just UX (same reasoning Orders.gs never caches its own reads). This is
  // the one true check-then-write race in this whole feature, matching the
  // LockService convention used everywhere else in this codebase for
  // exactly this shape of problem (e.g. actionCreateOrder,
  // apps-script/Orders.gs:98-100). Two concurrent confirm attempts on
  // overlapping Pending requests can never both succeed, because the second
  // one's locked re-check will see the first's now-Confirmed row.
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var conflict = sheetToObjects(sheet).some(function (b) {
      return b.ProductId === existing.ProductId && b.Status === 'Confirmed' && b.BookingId !== existing.BookingId &&
        datesOverlap(existing.StartDate, existing.EndDate, b.StartDate, b.EndDate);
    });
    if (conflict) return fail('These dates were just confirmed for another booking - please decline this request instead.');

    updateRowFromObject(sheet, existing.__row, { Status: 'Confirmed', UpdatedAt: nowIso() });
    return ok({});
  } finally {
    lock.releaseLock();
  }
}
