/**
 * My Account, after the crowding pass.
 *
 * The complaint was that the page felt cluttered. What was actually wrong was
 * not density but RAGGEDNESS and the wrong content: each row was four lines
 * with the title and action in a left column and the price and status in a
 * right one at different heights, nothing lined up, and the widest line on a
 * finished order was a sentence saying it could not be edited - while the date
 * the backend had always sent was never shown at all.
 *
 * So this suite is mostly about alignment and content, not prettiness:
 *   - the date and the basket are on the row, because they were missing
 *   - the locked sentence is gone, because it was repeated and said nothing
 *     actionable - the status pill beside it is the reason it is locked
 *   - title/amount share a baseline and status/action share a baseline
 *   - a pill never depends on colour alone, and never falls below contrast
 *   - the desktop grid exists above 900px and NOT below it
 *
 * Every behaviour is someone else's suite: verify-myorders owns Edit, Remove,
 * restore and the filters; verify-dashlinks owns My Store. This one owns how it
 * looks.
 */
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = process.env.AUDIT_BASE || 'http://127.0.0.1:8099';
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('PASS  ' + name + (detail ? '  [' + detail + ']' : '')); }
  else { fail++; console.log('FAIL  ' + name + (detail ? '  [' + detail + ']' : '')); }
};

const rgb = (s) => (s.match(/\d+/g) || []).slice(0, 3).map(Number);
const lum = (c) => {
  const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
};
const contrast = (a, b) => {
  const la = lum(rgb(a)), lb = lum(rgb(b));
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};

const ORDERS = [
  { orderId: 'o1', storeName: 'Bong Store', storeSlug: 'bong', status: 'Pending Payment',
    total: 86.5, createdAt: '2026-09-16T04:00:00Z', itemsSummary: '1 x Rice 10kg, 2 x Cooking oil 2L',
    canEdit: true, canArchive: false, archived: false },
  { orderId: 'o2', storeName: 'Tebora Hardware', storeSlug: 'tebo', status: 'Paid',
    total: 240, createdAt: '2026-09-11T04:00:00Z', itemsSummary: '4 x Cement 40kg',
    canEdit: false, canArchive: false, archived: false },
  { orderId: 'o3', storeName: 'Maiana Crafts', storeSlug: 'mai', status: 'Fulfilled',
    total: 32, createdAt: '2026-08-29T04:00:00Z', itemsSummary: '1 x Pandanus mat',
    canEdit: false, canArchive: true, archived: false },
  // Deliberately broken: a row whose date the sheet never got, or got wrong.
  { orderId: 'o4', storeName: 'Bong Store', storeSlug: 'bong', status: 'Cancelled',
    total: 18, createdAt: 'not-a-date', itemsSummary: '2 x Sugar 2kg',
    canEdit: false, canArchive: true, archived: false }
];
const BOOKINGS = [
  { bookingId: 'b1', storeName: 'Tarawa Kayaks', productName: 'Double kayak', status: 'Pending',
    startDate: '2026-09-25', endDate: '2026-09-27', canEdit: true, canArchive: false, archived: false },
  { bookingId: 'b2', storeName: 'Betio Hire', productName: 'Marquee tent', status: 'Confirmed',
    startDate: '2026-10-02', endDate: '2026-10-03', canEdit: false, canArchive: false, archived: false }
];

async function open(browser, width) {
  const ctx = await browser.newContext({ viewport: { width: width || 390, height: 900 } });
  await ctx.route('**/macros/s/**', (r) => {
    let b = {}; try { b = r.request().postDataJSON() || {}; } catch (e) {}
    const J = (o) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
    if (b.action === 'getCustomerProfile') return J({ ok: true, customer: { customerId: 'c1', name: 'Aroita Teniti', email: 'aroita@example.com', phone: '73012345' } });
    if (b.action === 'listCustomerOrders') return J({ ok: true, orders: ORDERS });
    if (b.action === 'listCustomerBookings') return J({ ok: true, bookings: BOOKINGS });
    if (b.action === 'getCustomerStore') return J({ ok: true, hasStore: false });
    return J({ ok: true });
  });
  await ctx.addInitScript(() => { try {
    localStorage.setItem('skiri_customer_token', 't');
    localStorage.setItem('skiri_cookie_consent', 'true');
  } catch (e) {} });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(BASE + '/customer-dashboard.html', { waitUntil: 'load' });
  await page.waitForSelector('#orders-list .dash-item', { timeout: 8000 });
  await page.waitForTimeout(300);
  return { ctx, page, errors };
}

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

  /* ---------- the row says what it is ------------------------------------ */
  {
    const { ctx, page, errors } = await open(browser);
    const meta = await page.evaluate(() => Array.from(
      document.querySelectorAll('#orders-list .dash-item'),
      (r) => ({
        id: r.dataset.orderId,
        title: (r.querySelector('.dash-item-title') || {}).textContent,
        amount: (r.querySelector('.dash-item-amount') || {}).textContent,
        meta: (r.querySelector('.dash-item-meta') || {}).textContent || '',
        status: (r.querySelector('.dash-status') || {}).textContent
      })));

    ok('the order date is on the row at last', /16 Sep/.test(meta[0].meta), meta[0].meta);
    ok('and so is what was actually in it', /Rice 10kg/.test(meta[0].meta), meta[0].meta);
    ok('the store name is the row title', meta[0].title === 'Bong Store', meta[0].title);
    ok('the total is its own element, not buried in a column',
      /86\.50/.test(meta[0].amount || ''), meta[0].amount);
    ok('the status is a pill', meta[0].status === 'Pending Payment', meta[0].status);

    // A date the sheet never got must lose the date, not print "Invalid Date".
    const broken = meta.find((m) => m.id === 'o4');
    ok('an unparseable date degrades to no date rather than "Invalid Date"',
      !/Invalid/.test(broken.meta) && /Sugar 2kg/.test(broken.meta), broken.meta);

    ok('no page errors', errors.length === 0, errors.join('; '));
    await ctx.close();
  }

  /* ---------- the repeated sentence is gone ------------------------------ */
  {
    const { ctx, page } = await open(browser);
    ok('"can no longer be edited" appears nowhere on the page',
      await page.evaluate(() => !/can no longer be edited/.test(document.body.textContent)));
    ok('and the element that carried it is gone too',
      await page.evaluate(() => document.querySelectorAll('.dash-item-locked').length === 0));
    // The point was never to hide that it is locked - only to stop repeating it.
    ok('a locked row still shows WHY, as its status', await page.evaluate(() => {
      const row = document.querySelector('[data-order-id="o2"]');
      return /Paid/.test(row.querySelector('.dash-status').textContent)
        && !row.querySelector('[data-edit]') && !row.querySelector('[data-archive]');
    }));
    await ctx.close();
  }

  /* ---------- things line up --------------------------------------------- */
  {
    const { ctx, page } = await open(browser);
    const aligned = await page.evaluate(() => {
      const r = document.querySelector('#orders-list .dash-item');
      const box = (sel) => r.querySelector(sel).getBoundingClientRect();
      const title = box('.dash-item-title'), amount = box('.dash-item-amount');
      const pill = box('.dash-status'), action = box('.dash-item-actions');
      const row = r.getBoundingClientRect();
      return {
        headShareLine: Math.abs(title.top - amount.top) <= 2,
        footShareLine: Math.abs(pill.top - action.top) <= 6,
        amountAtRightEdge: Math.abs(row.right - amount.right) <= 2,
        actionAtRightEdge: Math.abs(row.right - action.right) <= 2,
        titleAtLeftEdge: Math.abs(title.left - row.left) <= 2,
        pillAtLeftEdge: Math.abs(pill.left - row.left) <= 2
      };
    });
    ok('title and amount share a line', aligned.headShareLine, JSON.stringify(aligned));
    ok('status and action share a line', aligned.footShareLine, JSON.stringify(aligned));
    ok('the amount sits on the row\'s right edge', aligned.amountAtRightEdge);
    ok('and so does the action, under it', aligned.actionAtRightEdge);
    ok('the title sits on the left edge', aligned.titleAtLeftEdge);
    ok('and so does the status, under it', aligned.pillAtLeftEdge);

    // The failure this replaced: "Pending Payment" wrapping under the price.
    ok('the status never wraps', await page.evaluate(() => Array.from(
      document.querySelectorAll('.dash-status'),
      (p) => p.getBoundingClientRect().height < 30).every(Boolean)));
    await ctx.close();
  }

  /* ---------- the pills are readable, and not colour alone --------------- */
  {
    const { ctx, page } = await open(browser);
    const pills = await page.evaluate(() => Array.from(
      document.querySelectorAll('.dash-status'),
      (p) => { const cs = getComputedStyle(p);
        return { text: p.textContent.trim(), bg: cs.backgroundColor, color: cs.color,
                 cls: p.className }; }));
    ok('every status is drawn as a pill with its own tint',
      pills.length >= 4 && new Set(pills.map((p) => p.bg)).size >= 3,
      pills.map((p) => p.text + '=' + p.bg).join(' | '));
    const worst = pills.reduce((w, p) => Math.min(w, contrast(p.bg, p.color)), 99);
    ok('and the worst of them still clears 4.5:1 for text', worst >= 4.5, worst.toFixed(2) + ':1');
    // Colour is never the only carrier: the word is always in the pill.
    ok('every pill carries its word, so it reads the same in greyscale',
      pills.every((p) => p.text.length > 0), JSON.stringify(pills.map((p) => p.text)));
    ok('and a distinct class per status, for anyone restyling later',
      pills.some((p) => /dash-status--pending-payment/.test(p.cls))
      && pills.some((p) => /dash-status--fulfilled/.test(p.cls)));
    await ctx.close();
  }

  /* ---------- desktop is two columns, the phone is not ------------------- */
  {
    const { ctx, page } = await open(browser, 1280);
    const cols = await page.evaluate(() => {
      const c = document.querySelector('.page-account > .container');
      const box = (sel) => document.querySelector(sel).getBoundingClientRect();
      return {
        display: getComputedStyle(c).display,
        profileLeftOfOrders: box('.dash-section--profile').right <= box('.dash-section--orders').left + 1,
        sideBySide: Math.abs(box('.dash-section--profile').top - box('.dash-section--orders').top) <= 4
      };
    });
    ok('desktop lays the page out as a grid', cols.display === 'grid', cols.display);
    ok('with profile beside the orders, not above them',
      cols.profileLeftOfOrders && cols.sideBySide, JSON.stringify(cols));
    ok('no sideways scrolling at 1280px', await page.evaluate(() =>
      document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1));
    await ctx.close();
  }
  {
    const { ctx, page } = await open(browser, 390);
    const stacked = await page.evaluate(() => {
      const c = document.querySelector('.page-account > .container');
      const box = (sel) => document.querySelector(sel).getBoundingClientRect();
      return { display: getComputedStyle(c).display,
               profileAboveOrders: box('.dash-section--profile').bottom <= box('.dash-section--orders').top + 1 };
    });
    ok('the phone is NOT gridded - the two-column rule must not leak down',
      stacked.display !== 'grid', stacked.display);
    ok('and the sections stack in order', stacked.profileAboveOrders);
    ok('no sideways scrolling at 390px', await page.evaluate(() =>
      document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1));
    await ctx.close();
  }

  /* ---------- 320px, the narrowest phone this site supports -------------- */
  {
    const { ctx, page } = await open(browser, 320);
    ok('no sideways scrolling at 320px', await page.evaluate(() =>
      document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1));
    ok('the amount still does not wrap', await page.evaluate(() => Array.from(
      document.querySelectorAll('.dash-item-amount'),
      (a) => a.getBoundingClientRect().height < 30).every(Boolean)));
    await ctx.close();
  }

  /* ---------- the inline editor still owns the whole row ----------------- */
  {
    // It replaces .dash-item-main's contents, so that element has to remain the
    // row body - a restyle that split the row into siblings would break editing
    // without breaking any assertion about editing.
    const { ctx, page } = await open(browser);
    await page.click('[data-order-id="o1"] [data-edit]');
    await page.waitForSelector('[data-order-id="o1"] .dash-edit-form', { timeout: 4000 });
    const form = await page.evaluate(() => {
      const row = document.querySelector('[data-order-id="o1"]');
      const f = row.querySelector('.dash-edit-form');
      return { insideMain: !!row.querySelector('.dash-item-main .dash-edit-form'),
               width: Math.round(f.getBoundingClientRect().width),
               rowWidth: Math.round(row.getBoundingClientRect().width) };
    });
    ok('the editor still opens inside the row body', form.insideMain);
    ok('and still gets the full row width', form.width >= form.rowWidth - 2,
      form.width + ' of ' + form.rowWidth);
    await ctx.close();
  }

  await browser.close();
  console.log('\n' + pass + '/' + (pass + fail) + ' passed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
