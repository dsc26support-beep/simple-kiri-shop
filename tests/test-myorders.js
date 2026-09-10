// Customer-managed orders & bookings, run against the REAL .gs sources.
const fs = require('fs');
const vm = require('vm');
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e || '']);
const REPO = '/home/user/simple-kiri-shop/';

const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

function makeSandbox() {
  const SHEETS = {
    Orders: [
      { __row: 2, OrderId: 'o-pending', CustomerEmail: 'Me@Example.com ', CustomerName: 'Me', CustomerPhone: '73011111',
        Island: 'Tarawa', Village: 'Bairiki', DeliveryAddress: 'Bairiki, Tarawa', Notes: '', Status: 'Pending Payment',
        Total: 20, DeliveryMethod: 'truck', DeliveryCost: 5, PaymentReference: 'o-pending', CreatedAt: '2026-09-01T00:00:00Z' },
      { __row: 3, OrderId: 'o-paid', CustomerEmail: 'me@example.com', CustomerName: 'Me', CustomerPhone: '73011111',
        Status: 'Paid', Total: 30, CreatedAt: '2026-09-02T00:00:00Z' },
      { __row: 4, OrderId: 'o-done', CustomerEmail: 'me@example.com', CustomerName: 'Me', CustomerPhone: '73011111',
        Status: 'Fulfilled', Total: 40, CreatedAt: '2026-09-03T00:00:00Z' },
      { __row: 5, OrderId: 'o-cancel', CustomerEmail: 'me@example.com', CustomerName: 'Me', CustomerPhone: '73011111',
        Status: 'Cancelled', Total: 50, CreatedAt: '2026-09-04T00:00:00Z' },
      { __row: 6, OrderId: 'o-someone-else', CustomerEmail: 'other@example.com', CustomerName: 'Other',
        CustomerPhone: '73099999', Status: 'Pending Payment', Total: 60, CreatedAt: '2026-09-05T00:00:00Z' }
    ],
    Bookings: [
      { __row: 2, BookingId: 'b-pending', CustomerEmail: 'me@example.com', CustomerPhone: '73011111', CustomerName: 'Me',
        ProductId: 'prod1', Status: 'Pending', StartDate: day(5), EndDate: day(7), Notes: '', CreatedAt: '2026-09-01T00:00:00Z' },
      { __row: 3, BookingId: 'b-confirmed-future', CustomerEmail: 'me@example.com', CustomerPhone: '73011111',
        ProductId: 'prod1', Status: 'Confirmed', StartDate: day(20), EndDate: day(22), CreatedAt: '2026-09-02T00:00:00Z' },
      { __row: 4, BookingId: 'b-confirmed-past', CustomerEmail: 'me@example.com', CustomerPhone: '73011111',
        ProductId: 'prod2', Status: 'Confirmed', StartDate: day(-30), EndDate: day(-28), CreatedAt: '2026-08-01T00:00:00Z' },
      { __row: 5, BookingId: 'b-declined', CustomerEmail: 'me@example.com', CustomerPhone: '73011111',
        ProductId: 'prod3', Status: 'Declined', StartDate: day(9), EndDate: day(10), CreatedAt: '2026-09-03T00:00:00Z' },
      { __row: 6, BookingId: 'b-other', CustomerEmail: 'other@example.com', CustomerPhone: '73099999',
        ProductId: 'prod1', Status: 'Pending', StartDate: day(5), EndDate: day(6), CreatedAt: '2026-09-04T00:00:00Z' }
    ],
    // The real requireCustomerAuth (Customers.gs) resolves a token through
    // these two tabs. Stubbing it out would have skipped the very check these
    // actions depend on, so the sandbox provides the tables instead.
    CustomerSessions: [
      { __row: 2, Token: 'good-token', CustomerId: 'c1', ExpiresAt: new Date(Date.now() + 86400000).toISOString() },
      { __row: 3, Token: 'expired-token', CustomerId: 'c1', ExpiresAt: '2020-01-01T00:00:00Z' },
      { __row: 4, Token: 'other-token', CustomerId: 'c2', ExpiresAt: new Date(Date.now() + 86400000).toISOString() }
    ],
    Customers: [
      { __row: 2, CustomerId: 'c1', Email: 'me@example.com', Phone: '73011111', Name: 'Me' },
      { __row: 3, CustomerId: 'c2', Email: 'other@example.com', Phone: '73099999', Name: 'Other' }
    ]
  };

  const writes = [];
  const headers = {
    Orders: ['OrderId', 'CustomerEmail', 'CustomerName', 'CustomerPhone', 'Island', 'Village',
             'DeliveryAddress', 'Notes', 'Status', 'Total', 'DeliveryMethod', 'DeliveryCost',
             'PaymentReference', 'CreatedAt', 'UpdatedAt'],
    Bookings: ['BookingId', 'CustomerEmail', 'CustomerPhone', 'CustomerName', 'ProductId', 'Status',
               'StartDate', 'EndDate', 'Notes', 'CreatedAt', 'UpdatedAt']
  };

  const sandbox = {
    console,
    ok: (o) => Object.assign({ ok: true }, o),
    fail: (e) => ({ ok: false, error: e }),
    getSheet: (n) => n,
    getHeaders: (n) => headers[n].slice(),
    sheetToObjects: (n) => (SHEETS[n] || []).map((r) => Object.assign({}, r)),
    findRowById: (n, f, v) => (SHEETS[n] || []).filter((r) => String(r[f]) === String(v))[0] || null,
    findRowBySecret: (n, f, v) => (SHEETS[n] || []).filter((r) => String(r[f]) === String(v))[0] || null,
    updateRowFromObject: (sheetName, row, obj) => {
      writes.push({ sheet: sheetName, row, obj });
      const target = (SHEETS[sheetName] || []).filter((r) => r.__row === row)[0];
      if (target) Object.keys(obj).forEach((k) => {
        // Mirror the real helper: a key with no header column is DROPPED.
        if (headers[sheetName].indexOf(k) !== -1) target[k] = obj[k];
      });
    },
    ensureColumn: (sheetName, name) => {
      if (headers[sheetName].indexOf(name) === -1) headers[sheetName].push(name);
    },
    normalizeEmail: (e) => String(e || '').trim().toLowerCase(),
    digitsOnly: (p) => String(p || '').replace(/\D/g, ''),
    capLength: (v, max, label) => (String(v || '').length > max ? { ok: false, error: label + ' is too long' } : null),
    isCustomerPhoneValid: (p) => /^\+/.test(p) || /^(730|630)\d{4,}$/.test(String(p).replace(/\D/g, '')),
    nowIso: () => new Date().toISOString(),
    getCached: (k, ttl, fn) => {
      if (Object.prototype.hasOwnProperty.call(sandbox.cacheStore, k)) return sandbox.cacheStore[k];
      const v = fn();
      sandbox.cacheStore[k] = v;
      sandbox.cacheProduced.push(k);
      return v;
    },
    invalidateCache: (keys) => { (keys || []).forEach((k) => { delete sandbox.cacheStore[k]; }); },
    cacheStore: {}, cacheProduced: [],
    getOwnerBySlug: () => ({ StoreName: 'Bong' }),
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    SHEETS, writes, headers
  };
  vm.createContext(sandbox);
  for (const f of ['Bookings.gs', 'Customers.gs']) {
    let src = fs.readFileSync(REPO + 'apps-script/' + f, 'utf8');
    if (f === 'Bookings.gs') {
      // Only the date helpers are under test here; the rest of that file
      // reaches for globals this sandbox deliberately does not provide.
      src = [src.match(/function datesOverlap[\s\S]*?\n}/)[0],
             src.match(/var BOOKING_DATE_MAX_FUTURE_MS[^\n]*/)[0],
             src.match(/function validateBookingDates[\s\S]*?\n}/)[0]].join('\n');
    }
    vm.runInContext(src, sandbox);
  }
  return sandbox;
}

const GOOD = 'good-token';

/* ---------------- ownership ---------------- */
{
  const s = makeSandbox();
  ok('an unauthenticated edit is refused',
    s.actionUpdateCustomerOrder({ token: 'bad', orderId: 'o-pending', customerName: 'X', customerPhone: '73011111' }).ok === false);
  ok('a missing token is refused',
    s.actionUpdateCustomerOrder({ orderId: 'o-pending', customerName: 'X', customerPhone: '73011111' }).ok === false);
  const exp = s.actionUpdateCustomerOrder({ token: 'expired-token', orderId: 'o-pending', customerName: 'X', customerPhone: '73011111' });
  ok('an expired session is refused', exp.ok === false, exp.error);
  ok('  with the shared session-expired wording', /sign in again/i.test(exp.error || ''), exp.error);
  const asOther = s.actionUpdateCustomerOrder({ token: 'other-token', orderId: 'o-pending', customerName: 'X', customerPhone: '73011111' });
  ok('a DIFFERENT signed-in customer cannot touch my order', asOther.ok === false, asOther.error);
  const other = s.actionUpdateCustomerOrder({ token: GOOD, orderId: 'o-someone-else', customerName: 'Hacker', customerPhone: '73011111' });
  ok('cannot edit another customer\'s order', other.ok === false, other.error);
  ok('and the refusal does not reveal the order exists',
    /not found in your account/.test(other.error), other.error);
  ok('another customer\'s row was NOT written',
    s.SHEETS.Orders.filter((o) => o.OrderId === 'o-someone-else')[0].CustomerName === 'Other');
  const otherB = s.actionSetCustomerBookingArchived({ token: GOOD, bookingId: 'b-other', archived: true });
  ok('cannot archive another customer\'s booking', otherB.ok === false, otherB.error);
  ok('identity comes from the token, not the body - a spoofed email is ignored',
    s.actionUpdateCustomerOrder({ token: GOOD, orderId: 'o-someone-else', customerEmail: 'other@example.com',
      customerName: 'X', customerPhone: '73011111' }).ok === false);
}

/* ---------------- status gates: editing ---------------- */
{
  const s = makeSandbox();
  const good = { token: GOOD, customerName: 'New Name', customerPhone: '73022222', island: 'Abaiang', village: 'Tuarabu', notes: 'leave at gate' };
  const okRes = s.actionUpdateCustomerOrder(Object.assign({ orderId: 'o-pending' }, good));
  ok('a Pending Payment order can be edited', okRes.ok === true, JSON.stringify(okRes));
  const row = s.SHEETS.Orders.filter((o) => o.OrderId === 'o-pending')[0];
  ok('name saved', row.CustomerName === 'New Name', row.CustomerName);
  ok('phone saved', row.CustomerPhone === '73022222', row.CustomerPhone);
  ok('island and village saved', row.Island === 'Abaiang' && row.Village === 'Tuarabu', row.Island + '/' + row.Village);
  ok('delivery address recomposed to match', row.DeliveryAddress === 'Tuarabu, Abaiang', row.DeliveryAddress);
  ok('notes saved', row.Notes === 'leave at gate', row.Notes);

  // The money and the seller's columns must be untouchable.
  const patch = s.writes[s.writes.length - 1].obj;
  const forbidden = ['Total', 'Subtotal', 'Status', 'DeliveryMethod', 'DeliveryCost', 'ItemsJson',
                     'ItemsSummary', 'PaymentReference', 'PaymentMethod', 'OrderId', 'StoreSlug', 'OwnerId'];
  ok('the write touches no protected column',
    forbidden.every((k) => !(k in patch)), Object.keys(patch).join(','));
  ok('the total is unchanged', row.Total === 20, String(row.Total));
  ok('the status is unchanged', row.Status === 'Pending Payment', row.Status);
  ok('even when sent explicitly, status/total are ignored',
    (s.actionUpdateCustomerOrder(Object.assign({ orderId: 'o-pending', status: 'Fulfilled', total: 1 }, good)).ok === true) &&
    s.SHEETS.Orders.filter((o) => o.OrderId === 'o-pending')[0].Status === 'Pending Payment' &&
    s.SHEETS.Orders.filter((o) => o.OrderId === 'o-pending')[0].Total === 20);

  for (const [id, label] of [['o-paid', 'Paid'], ['o-done', 'Fulfilled'], ['o-cancel', 'Cancelled']]) {
    const r = s.actionUpdateCustomerOrder(Object.assign({ orderId: id }, good));
    ok(`a ${label} order cannot be edited`, r.ok === false, r.error);
    ok(`  and says so plainly`, /can no longer be edited/.test(r.error || ''), r.error);
  }
}

/* ---------------- validation is reused, not reinvented ---------------- */
{
  const s = makeSandbox();
  const base = { token: GOOD, orderId: 'o-pending', customerName: 'A' };
  ok('a bad phone is rejected by the shared rule',
    s.actionUpdateCustomerOrder(Object.assign({}, base, { customerPhone: '12345' })).ok === false);
  ok('an overseas phone is accepted by the shared rule',
    s.actionUpdateCustomerOrder(Object.assign({}, base, { customerPhone: '+6421234567' })).ok === true);
  ok('an empty name is rejected',
    s.actionUpdateCustomerOrder(Object.assign({}, base, { customerName: '', customerPhone: '73011111' })).ok === false);
  ok('an over-long note is rejected',
    s.actionUpdateCustomerOrder(Object.assign({}, base, { customerPhone: '73011111', notes: 'x'.repeat(2001) })).ok === false);
}

/* ---------------- bookings: dates go through the same checks ---------------- */
{
  const s = makeSandbox();
  const b = { token: GOOD, bookingId: 'b-pending', customerName: 'Me', customerPhone: '73011111' };
  const good = s.actionUpdateCustomerBooking(Object.assign({}, b, { startDate: day(11), endDate: day(13) }));
  ok('a Pending booking\'s dates can be changed', good.ok === true, JSON.stringify(good));
  const row = s.SHEETS.Bookings.filter((x) => x.BookingId === 'b-pending')[0];
  ok('new dates saved', row.StartDate === day(11) && row.EndDate === day(13), row.StartDate + '..' + row.EndDate);

  ok('a start date in the past is refused (shared validateBookingDates)',
    s.actionUpdateCustomerBooking(Object.assign({}, b, { startDate: day(-2), endDate: day(3) })).ok === false);
  ok('an end before the start is refused',
    s.actionUpdateCustomerBooking(Object.assign({}, b, { startDate: day(9), endDate: day(8) })).ok === false);
  ok('dates far in the future are refused',
    s.actionUpdateCustomerBooking(Object.assign({}, b, { startDate: day(900), endDate: day(902) })).ok === false);

  // prod1 has a Confirmed booking at day 20-22.
  const clash = s.actionUpdateCustomerBooking(Object.assign({}, b, { startDate: day(20), endDate: day(21) }));
  ok('cannot move onto dates already Confirmed for that product', clash.ok === false, clash.error);
  ok('  and says why', /already booked/.test(clash.error || ''), clash.error);
  ok('a booking does not clash with ITSELF',
    s.actionUpdateCustomerBooking(Object.assign({}, b, { startDate: day(11), endDate: day(14) })).ok === true);

  for (const [id, label] of [['b-confirmed-future', 'Confirmed'], ['b-declined', 'Declined']]) {
    const r = s.actionUpdateCustomerBooking(Object.assign({}, b, { bookingId: id, startDate: day(11), endDate: day(12) }));
    ok(`a ${label} booking cannot be edited`, r.ok === false, r.error);
  }
}

/* ---------------- archiving never deletes ---------------- */
{
  const s = makeSandbox();
  const before = s.SHEETS.Orders.length;

  const live = s.actionSetCustomerOrderArchived({ token: GOOD, orderId: 'o-pending', archived: true });
  ok('a live order cannot be removed from the list', live.ok === false, live.error);
  const paid = s.actionSetCustomerOrderArchived({ token: GOOD, orderId: 'o-paid', archived: true });
  ok('nor a Paid one', paid.ok === false, paid.error);

  const done = s.actionSetCustomerOrderArchived({ token: GOOD, orderId: 'o-done', archived: true });
  ok('a Fulfilled order can be removed', done.ok === true, JSON.stringify(done));
  ok('NOTHING was deleted - the row is still there', s.SHEETS.Orders.length === before, String(s.SHEETS.Orders.length));
  const row = s.SHEETS.Orders.filter((o) => o.OrderId === 'o-done')[0];
  ok('it is only flagged hidden', row.CustomerHidden === 'yes', JSON.stringify(row.CustomerHidden));
  ok('the transaction data is completely intact',
    row.Total === 40 && row.Status === 'Fulfilled' && row.CustomerEmail === 'me@example.com', JSON.stringify(row));
  ok('the flag column was created on demand', s.headers.Orders.indexOf('CustomerHidden') !== -1);
  ok('a timestamp records when', !!row.CustomerHiddenAt, String(row.CustomerHiddenAt));

  ok('a cancelled order can be removed',
    s.actionSetCustomerOrderArchived({ token: GOOD, orderId: 'o-cancel', archived: true }).ok === true);

  // ...and it comes back.
  ok('it can be put back', s.actionSetCustomerOrderArchived({ token: GOOD, orderId: 'o-done', archived: false }).ok === true);
  ok('the flag is cleared', s.SHEETS.Orders.filter((o) => o.OrderId === 'o-done')[0].CustomerHidden === '');
}

/* ---------------- archiving bookings ---------------- */
{
  const s = makeSandbox();
  ok('a Pending booking cannot be removed',
    s.actionSetCustomerBookingArchived({ token: GOOD, bookingId: 'b-pending', archived: true }).ok === false);
  ok('a Confirmed booking still to come cannot be removed',
    s.actionSetCustomerBookingArchived({ token: GOOD, bookingId: 'b-confirmed-future', archived: true }).ok === false);
  ok('a Confirmed booking that has already finished CAN be removed',
    s.actionSetCustomerBookingArchived({ token: GOOD, bookingId: 'b-confirmed-past', archived: true }).ok === true);
  ok('a Declined booking can be removed',
    s.actionSetCustomerBookingArchived({ token: GOOD, bookingId: 'b-declined', archived: true }).ok === true);
  ok('the booking rows are all still present', s.SHEETS.Bookings.length === 5, String(s.SHEETS.Bookings.length));
}

/* ---------------- listing hides archived, and can show them ---------------- */
{
  const s = makeSandbox();
  s.actionSetCustomerOrderArchived({ token: GOOD, orderId: 'o-done', archived: true });

  const def = s.actionListCustomerOrders({ token: GOOD });
  ok('archived orders are out of the default list',
    !def.orders.some((o) => o.orderId === 'o-done'), def.orders.map((o) => o.orderId).join(','));
  ok('another customer\'s orders were never in it',
    !def.orders.some((o) => o.orderId === 'o-someone-else'), def.orders.map((o) => o.orderId).join(','));
  ok('the rest are still listed', def.orders.length === 3, String(def.orders.length));

  const all = s.actionListCustomerOrders({ token: GOOD, includeArchived: true });
  ok('includeArchived brings it back', all.orders.some((o) => o.orderId === 'o-done'));
  ok('and marks it archived', all.orders.filter((o) => o.orderId === 'o-done')[0].archived === true);

  // The flags the page draws its buttons from.
  const byId = {}; all.orders.forEach((o) => { byId[o.orderId] = o; });
  ok('canEdit is true only for the pending order',
    byId['o-pending'].canEdit === true && byId['o-paid'].canEdit === false &&
    byId['o-done'].canEdit === false && byId['o-cancel'].canEdit === false,
    JSON.stringify(all.orders.map((o) => [o.orderId, o.canEdit])));
  ok('canArchive is true only for finished orders',
    byId['o-pending'].canArchive === false && byId['o-paid'].canArchive === false &&
    byId['o-cancel'].canArchive === true,
    JSON.stringify(all.orders.map((o) => [o.orderId, o.canArchive])));
  ok('an archived order is not editable', byId['o-done'].canEdit === false);
  ok('editable fields are sent back so the form can be filled',
    'customerName' in byId['o-pending'] && 'island' in byId['o-pending'] && 'notes' in byId['o-pending'],
    Object.keys(byId['o-pending']).join(','));

  const leak = Object.keys(byId['o-pending']).filter((k) => /paymentmethod|ownerid|__row/i.test(k));
  ok('no internal or payment columns leak to the browser', leak.length === 0, leak.join(','));

  const bk = s.actionListCustomerBookings({ token: GOOD });
  ok('bookings list excludes other customers',
    !bk.bookings.some((b) => b.bookingId === 'b-other'), bk.bookings.map((b) => b.bookingId).join(','));
  ok('bookings carry their own canEdit/canArchive',
    bk.bookings.every((b) => typeof b.canEdit === 'boolean' && typeof b.canArchive === 'boolean'));
}

/* ---------------- router wiring ---------------- */
{
  const code = fs.readFileSync(REPO + 'apps-script/Code.gs', 'utf8');
  for (const a of ['updateCustomerOrder', 'updateCustomerBooking', 'setCustomerOrderArchived', 'setCustomerBookingArchived']) {
    ok(`${a} is routed`, new RegExp("case '" + a + "':").test(code));
    // Slice on the DECLARATION, not the first mention - the word appears in a
    // comment above the public list, and cutting there hid the entries.
    const publicBlock = code.slice(code.indexOf('var PUBLIC_POST_ACTIONS'), code.indexOf('var PROTECTED_POST_ACTIONS'));
    ok(`${a} is declared public (auth happens inside)`, new RegExp("'" + a + "'").test(publicBlock));
    ok(`${a} is NOT in the owner-token list`,
      !new RegExp("'" + a + "'").test(code.slice(code.indexOf('var PROTECTED_POST_ACTIONS'), code.indexOf('CHAT_RATE_LIMIT_ACTIONS'))));
  }
  ok('Orders and Bookings are still absent from REQUIRED_TABS, so setupSheets never rewrites their headers',
    !/REQUIRED_TABS = \{[\s\S]*?\n\};/.exec(code)[0].match(/\bOrders:|\bBookings:/));
}

let f = 0;
console.log('\n--- Customer-managed orders & bookings (real .gs) ---');
for (const [st, n, e] of R) { if (st === 'FAIL') f++; console.log(`${st}  ${n}${e ? '  [' + e + ']' : ''}`); }
console.log(`\n${R.length - f}/${R.length} passed`);
process.exit(f ? 1 : 0);
