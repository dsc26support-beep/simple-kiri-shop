// Account page: filtering, editing and safe removal of My Orders / My Bookings.
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = 'http://127.0.0.1:8099';
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e || '']);
const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

const ORDERS = [
  { orderId: 'o1', storeName: 'Bong', itemsSummary: '2 x Rice', total: 20, status: 'Pending Payment',
    island: 'Tarawa', village: 'Bairiki', customerName: 'Me', customerPhone: '73011111', notes: '',
    archived: false, canEdit: true, canArchive: false },
  { orderId: 'o2', storeName: 'Teaube', itemsSummary: '1 x Shirt', total: 30, status: 'Paid',
    archived: false, canEdit: false, canArchive: false },
  { orderId: 'o3', storeName: 'Burabonita', itemsSummary: '1 x Fan', total: 40, status: 'Fulfilled',
    archived: false, canEdit: false, canArchive: true },
  { orderId: 'o4', storeName: 'Bong', itemsSummary: '1 x Cake', total: 50, status: 'Cancelled',
    archived: false, canEdit: false, canArchive: true }
];
const BOOKINGS = [
  { bookingId: 'b1', productName: 'Kayak', storeName: 'Bong', startDate: day(5), endDate: day(7),
    status: 'Pending', customerName: 'Me', customerPhone: '73011111', notes: '',
    archived: false, canEdit: true, canArchive: false },
  { bookingId: 'b2', productName: 'Van', storeName: 'Teaube', startDate: day(20), endDate: day(22),
    status: 'Confirmed', archived: false, canEdit: false, canArchive: false },
  { bookingId: 'b3', productName: 'Hall', storeName: 'Bong', startDate: day(-30), endDate: day(-28),
    status: 'Declined', archived: false, canEdit: false, canArchive: true }
];

let posted = [];
let archivedOrder = null;

async function open(browser, width) {
  const ctx = await browser.newContext({ viewport: { width: width || 390, height: 900 } });
  await ctx.route('**/macros/s/**', async (r) => {
    let b = {};
    try { b = r.request().postDataJSON() || {}; } catch (e) {}
    posted.push(b);
    const J = (o) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
    if (b.action === 'getCustomerProfile') return J({ ok: true, customer: { name: 'Me', email: 'me@example.com', phone: '73011111' } });
    if (b.action === 'listCustomerOrders') {
      let rows = ORDERS.map((o) => Object.assign({}, o, archivedOrder === o.orderId ? { archived: true, canEdit: false } : {}));
      if (!b.includeArchived) rows = rows.filter((o) => !o.archived);
      return J({ ok: true, orders: rows });
    }
    if (b.action === 'listCustomerBookings') {
      let rows = BOOKINGS.slice();
      if (!b.includeArchived) rows = rows.filter((x) => !x.archived);
      return J({ ok: true, bookings: rows });
    }
    if (b.action === 'updateCustomerOrder') {
      if (b.orderId === 'o2') return J({ ok: false, error: 'This order can no longer be edited.' });
      return J({ ok: true, updated: true });
    }
    if (b.action === 'updateCustomerBooking') return J({ ok: true, updated: true });
    if (b.action === 'setCustomerOrderArchived') { archivedOrder = b.archived ? b.orderId : null; return J({ ok: true, archived: b.archived }); }
    if (b.action === 'setCustomerBookingArchived') return J({ ok: true, archived: b.archived });
    return J({ ok: true });
  });
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    localStorage.setItem('skiri_cookie_consent', 'true');
    localStorage.setItem('skiri_customer_token', 'tok');
    localStorage.setItem('skiri_customer', JSON.stringify({ name: 'Me', email: 'me@example.com', phone: '73011111' }));
  });
  await page.goto(BASE + '/customer-dashboard.html', { waitUntil: 'load' });
  await page.waitForSelector('#orders-list .dash-item', { timeout: 8000 });
  return { ctx, page };
}

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

  /* ---------- display + filters ---------- */
  {
    posted = []; archivedOrder = null;
    const { ctx, page } = await open(browser);

    const initial = await page.evaluate(() => ({
      orders: document.querySelectorAll('#orders-list .dash-item').length,
      bookings: document.querySelectorAll('#bookings-list .dash-item').length,
      orderFilters: [...document.querySelectorAll('#orders-filters .dash-filter')].map((b) => b.textContent.trim()),
      bookingFilters: [...document.querySelectorAll('#bookings-filters .dash-filter')].map((b) => b.textContent.trim()),
      active: document.querySelector('#orders-filters .dash-filter.is-active').textContent.trim()
    }));
    ok('all orders shown by default', initial.orders === 4, String(initial.orders));
    ok('all bookings shown by default', initial.bookings === 3, String(initial.bookings));
    ok('"All" is the default filter', initial.active === 'All', initial.active);
    ok('order filters are the statuses actually present',
      JSON.stringify(initial.orderFilters) === JSON.stringify(['All', 'Pending Payment', 'Paid', 'Fulfilled', 'Cancelled', 'Archived']),
      JSON.stringify(initial.orderFilters));
    ok('booking filters likewise - no invented statuses',
      JSON.stringify(initial.bookingFilters) === JSON.stringify(['All', 'Pending', 'Confirmed', 'Declined', 'Archived']),
      JSON.stringify(initial.bookingFilters));

    const callsBefore = posted.filter((p) => p.action === 'listCustomerOrders').length;
    // By label, not position - counting children made this assert against
    // whichever chip happened to be 4th.
    await page.click('#orders-filters .dash-filter >> text="Paid"');
    await page.waitForTimeout(200);
    const filtered = await page.evaluate(() => ({
      n: document.querySelectorAll('#orders-list .dash-item').length,
      status: (document.querySelector('#orders-list .dash-status') || {}).textContent,
      active: document.querySelector('#orders-filters .dash-filter.is-active').textContent.trim()
    }));
    const callsAfter = posted.filter((p) => p.action === 'listCustomerOrders').length;
    ok('filtering narrows the list', filtered.n === 1 && filtered.status === 'Paid', JSON.stringify(filtered));
    ok('the chosen filter is marked active', filtered.active === 'Paid', filtered.active);
    ok('filtering costs NO extra request', callsAfter === callsBefore, `${callsBefore} -> ${callsAfter}`);

    await page.click('#orders-filters .dash-filter >> text="All"');
    await page.waitForTimeout(150);
    ok('back to All restores every row',
      (await page.evaluate(() => document.querySelectorAll('#orders-list .dash-item').length)) === 4);

    // Empty state for a filter with nothing in it.
    await page.click('#bookings-filters .dash-filter >> text="Confirmed"');
    await page.waitForTimeout(150);
    const conf = await page.evaluate(() => document.querySelectorAll('#bookings-list .dash-item').length);
    ok('bookings filter works too', conf === 1, String(conf));

    ok('filters scroll rather than wrap on a phone',
      await page.evaluate(() => {
        const el = document.getElementById('orders-filters');
        return getComputedStyle(el).overflowX === 'auto' && el.getBoundingClientRect().height < 60;
      }));
    ok('nothing overflows the viewport',
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    await ctx.close();
  }

  /* ---------- who may edit ---------- */
  {
    posted = []; archivedOrder = null;
    const { ctx, page } = await open(browser);
    const buttons = await page.evaluate(() => {
      const out = {};
      document.querySelectorAll('#orders-list .dash-item').forEach((r) => {
        out[r.dataset.orderId] = {
          edit: !!r.querySelector('[data-edit]'),
          remove: !!r.querySelector('[data-archive]'),
          locked: (r.querySelector('.dash-item-locked') || {}).textContent || null
        };
      });
      return out;
    });
    ok('a Pending Payment order offers Edit', buttons.o1.edit === true, JSON.stringify(buttons.o1));
    ok('a Paid order offers neither, and explains why',
      buttons.o2.edit === false && buttons.o2.remove === false &&
      /can no longer be edited/.test(buttons.o2.locked || ''), JSON.stringify(buttons.o2));
    ok('a Fulfilled order offers Remove but not Edit',
      buttons.o3.edit === false && buttons.o3.remove === true, JSON.stringify(buttons.o3));
    ok('a Cancelled order offers Remove but not Edit',
      buttons.o4.edit === false && buttons.o4.remove === true, JSON.stringify(buttons.o4));
    await ctx.close();
  }

  /* ---------- editing an order ---------- */
  {
    posted = []; archivedOrder = null;
    const { ctx, page } = await open(browser);
    await page.click('[data-order-id="o1"] [data-edit]');
    await page.waitForSelector('[data-order-id="o1"] .dash-edit-form');
    const prefilled = await page.evaluate(() => {
      const f = document.querySelector('[data-order-id="o1"] .dash-edit-form');
      return {
        name: f.querySelector('[name=customerName]').value,
        phone: f.querySelector('[name=customerPhone]').value,
        island: f.querySelector('[name=island]').value,
        village: f.querySelector('[name=village]').value,
        hasDates: !!f.querySelector('[name=startDate]')
      };
    });
    ok('the form opens pre-filled with the current details',
      prefilled.name === 'Me' && prefilled.island === 'Tarawa' && prefilled.village === 'Bairiki', JSON.stringify(prefilled));
    ok('an order form has no booking date fields', prefilled.hasDates === false);

    await page.fill('[data-order-id="o1"] [name=village]', 'Betio');
    await page.fill('[data-order-id="o1"] [name=notes]', 'call first');
    await page.click('[data-order-id="o1"] button[type=submit]');
    await page.waitForTimeout(1400);

    const sent = posted.filter((p) => p.action === 'updateCustomerOrder');
    ok('exactly one update was sent', sent.length === 1, String(sent.length));
    ok('it carries the session token, never a customer id',
      sent[0].token === 'tok' && !('customerId' in sent[0]) && !('customerEmail' in sent[0]), JSON.stringify(sent[0]));
    ok('it sends only editable fields',
      !['status', 'total', 'deliveryCost', 'deliveryMethod', 'items'].some((k) => k in sent[0]), Object.keys(sent[0]).join(','));
    ok('the edited values are in the payload',
      sent[0].village === 'Betio' && sent[0].notes === 'call first', JSON.stringify(sent[0]));
    ok('the list reloads after saving',
      posted.filter((p) => p.action === 'listCustomerOrders').length >= 2);
    ok('a success confirmation was shown',
      await page.evaluate(() => !!document.getElementById('order-sent-popup')));
    await ctx.close();
  }

  /* ---------- the backend still has the last word ---------- */
  {
    posted = []; archivedOrder = null;
    const { ctx, page } = await open(browser);
    // Force the form open on an order the backend will refuse - what a stale
    // page looks like when the seller has moved on in the meantime.
    await page.evaluate(() => {
      const row = document.querySelector('[data-order-id="o2"] .dash-item-main');
      row.innerHTML = `<form class="dash-edit-form" data-edit-form data-kind="order" data-id="o2">
        <input name="customerName" value="X"><input name="customerPhone" value="73011111">
        <button type="submit">Save</button><p class="form-error" data-edit-error></p></form>`;
    });
    await page.click('[data-order-id="o2"] button[type=submit]');
    await page.waitForTimeout(700);
    const err = await page.evaluate(() => {
      const e = document.querySelector('[data-order-id="o2"] [data-edit-error]');
      return e ? e.textContent : null;
    });
    ok('a refusal from the backend is shown to the customer',
      /can no longer be edited/.test(err || ''), String(err));
    await ctx.close();
  }

  /* ---------- removal ---------- */
  {
    posted = []; archivedOrder = null;
    const { ctx, page } = await open(browser);

    // Cancel the confirm: nothing must happen.
    page.once('dialog', (d) => d.dismiss());
    await page.click('[data-order-id="o3"] [data-archive]');
    await page.waitForTimeout(400);
    ok('declining the confirmation sends nothing',
      posted.filter((p) => p.action === 'setCustomerOrderArchived').length === 0);

    let dialogText = '';
    page.once('dialog', (d) => { dialogText = d.message(); d.accept(); });
    await page.click('[data-order-id="o3"] [data-archive]');
    await page.waitForTimeout(1400);

    ok('removal asks for confirmation first', dialogText.length > 0, dialogText);
    ok('the wording says the transaction is kept',
      /securely recorded/i.test(dialogText) && /store still sees it/i.test(dialogText), dialogText);
    ok('the wording says it can be undone', /put it back/i.test(dialogText), dialogText);

    const arch = posted.filter((p) => p.action === 'setCustomerOrderArchived');
    ok('one archive request was sent', arch.length === 1, String(arch.length));
    ok('it archives rather than deleting - no delete action exists',
      arch[0].archived === true && !posted.some((p) => /delete/i.test(p.action || '')), JSON.stringify(arch[0]));
    ok('the row leaves the active list',
      (await page.evaluate(() => document.querySelectorAll('#orders-list .dash-item').length)) === 3);
    ok('a confirmation was shown',
      await page.evaluate(() => !!document.getElementById('order-sent-popup')));

    // And it can be found again and restored.
    await page.click('#orders-filters .dash-filter >> text="Archived"');
    await page.waitForTimeout(900);
    const archivedView = await page.evaluate(() => ({
      n: document.querySelectorAll('#orders-list .dash-item').length,
      hasRestore: !!document.querySelector('[data-restore]')
    }));
    ok('the Archived filter finds it again', archivedView.n === 1, JSON.stringify(archivedView));
    ok('and offers to put it back', archivedView.hasRestore === true, JSON.stringify(archivedView));
    ok('the archived fetch asked for archived rows',
      posted.some((p) => p.action === 'listCustomerOrders' && p.includeArchived === true));

    await page.click('[data-restore]');
    await page.waitForTimeout(1200);
    ok('restoring sends archived:false',
      posted.some((p) => p.action === 'setCustomerOrderArchived' && p.archived === false));
    await ctx.close();
  }

  /* ---------- booking edit has dates ---------- */
  {
    posted = []; archivedOrder = null;
    const { ctx, page } = await open(browser);
    await page.click('[data-booking-id="b1"] [data-edit]');
    await page.waitForSelector('[data-booking-id="b1"] .dash-edit-form');
    const f = await page.evaluate(() => {
      const form = document.querySelector('[data-booking-id="b1"] .dash-edit-form');
      return {
        start: form.querySelector('[name=startDate]').value,
        end: form.querySelector('[name=endDate]').value,
        hasIsland: !!form.querySelector('[name=island]'),
        labels: [...form.querySelectorAll('.dash-edit-label')].map((l) => l.textContent)
      };
    });
    ok('booking form carries its dates, pre-filled', !!f.start && !!f.end, JSON.stringify(f));
    ok('labelled with the existing Pick-up/Return wording',
      f.labels.join(',') === 'Pick-up date,Return date', JSON.stringify(f.labels));
    ok('a booking form has no delivery address fields', f.hasIsland === false);

    await page.fill('[data-booking-id="b1"] [name=startDate]', day(11));
    await page.fill('[data-booking-id="b1"] [name=endDate]', day(13));
    await page.click('[data-booking-id="b1"] button[type=submit]');
    await page.waitForTimeout(1400);
    const sent = posted.filter((p) => p.action === 'updateCustomerBooking');
    ok('the booking update sends the new dates',
      sent.length === 1 && sent[0].startDate === day(11) && sent[0].endDate === day(13), JSON.stringify(sent[0] || {}));
    ok('and the booking id, with the token', sent[0].bookingId === 'b1' && sent[0].token === 'tok');
    await ctx.close();
  }

  /* ---------- desktop ---------- */
  {
    posted = []; archivedOrder = null;
    const { ctx, page } = await open(browser, 1200);
    const d = await page.evaluate(() => ({
      rows: document.querySelectorAll('#orders-list .dash-item').length,
      filters: document.querySelectorAll('#orders-filters .dash-filter').length,
      noOverflow: document.documentElement.scrollWidth <= window.innerWidth
    }));
    ok('desktop shows the same rows and filters', d.rows === 4 && d.filters === 6, JSON.stringify(d));
    ok('no horizontal overflow on desktop', d.noOverflow);
    await ctx.close();
  }

  await browser.close();
  let f = 0;
  console.log('\n--- Account page: filter, edit, safe removal ---');
  for (const [st, n, e] of R) { if (st === 'FAIL') f++; console.log(`${st}  ${n}${e ? '  [' + e + ']' : ''}`); }
  console.log(`\n${R.length - f}/${R.length} passed`);
  process.exit(f ? 1 : 0);
})();
