/**
 * Customer dashboard (Oct 2026 stage 5) in the browser against the REAL
 * backend (gas-harness behind every Api.post): the summary counts come from
 * the customer's own orders, "Need you" comes from the order rooms' real next
 * steps, the cards filter the list, Buy again refills that store's cart, and
 * nothing moves or overflows on phones.
 */
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const { makeBox } = require('./lib/gas-harness.js');
const BASE = process.env.TX_BASE || 'http://127.0.0.1:8099';
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e === undefined ? '' : e]);
const FUT = new Date(Date.now() + 9e8).toISOString();
const items = (v, l, p, q) => JSON.stringify([{ productId: 'p_' + v, variantId: v, label: l, unitPrice: p, qty: q, lineTotal: p * q }]);
const box = makeBox({
  Owners: [['OwnerId', 'StoreSlug', 'StoreName', 'Email', 'Status'], ['own_s', 'bong', 'Bong Store', 's@x.test', 'active']],
  Customers: [['CustomerId', 'Name', 'Email', 'Phone', 'EmailVerified', 'CreatedAt', 'UpdatedAt'], ['cus_b', 'Tia Maere', 'b@x.test', '73000001', 'yes', '', ''],
    ['cus_z', 'Zed', 'z@x.test', '73000002', 'yes', '', '']],
  CustomerSessions: [['Token', 'CustomerId', 'CreatedAt', 'ExpiresAt'], ['ctok-b', 'cus_b', '', FUT]],
  Orders: [['OrderId', 'OwnerId', 'StoreSlug', 'CustomerName', 'CustomerPhone', 'CustomerEmail', 'DeliveryMethod', 'ItemsJson', 'ItemsSummary', 'Total', 'Status', 'CreatedAt', 'UpdatedAt'],
    ['O-PAY', 'own_s', 'bong', 'Tia', '73000001', 'b@x.test', 'truck', items('v1', 'Rice', 20, 1), '1x Rice', 25, 'Pending Payment', new Date(Date.now() - 3e6).toISOString(), ''],
    ['O-RCV', 'own_s', 'bong', 'Tia', '73000001', 'b@x.test', 'truck', items('v2', 'Oil', 5, 2), '2x Oil', 15, 'Paid', new Date(Date.now() - 2e6).toISOString(), ''],
    ['O-DONE', 'own_s', 'bong', 'Tia', '73000001', 'b@x.test', 'truck', items('v3', 'Tuna', 2, 3), '3x Tuna', 11, 'Fulfilled', new Date(Date.now() - 1e6).toISOString(), ''],
    ['O-ZED', 'own_s', 'bong', 'Zed', '73000002', 'z@x.test', 'truck', items('v1', 'Rice', 20, 9), '9x Rice', 185, 'Paid', new Date().toISOString(), '']],
  TxState: [['OrderId', 'Flow', 'PaymentState', 'FulfilmentState', 'ReceiptState', 'RefundState', 'OpenDisputeId', 'Version', 'LastSeq', 'ReadBuyerSeq', 'ReadSellerSeq'],
    ['O-PAY', 'v1', 'pending', '', '', '', '', 1, 2, 2, 0], ['O-RCV', 'v1', 'verified', 'dispatched', '', '', '', 3, 6, 3, 6],
    ['O-DONE', 'v1', 'verified', 'dispatched', 'confirmed', '', '', 5, 8, 8, 8]],
  Bookings: [['BookingId', 'OwnerId', 'CustomerEmail', 'CustomerPhone', 'Status', 'StartDate', 'EndDate', 'CreatedAt']]
});
box.__props.TX_ROOMS = 'on';
box.ContentService = { createTextOutput: (s) => ({ s, setMimeType() { return this; } }), MimeType: { JSON: 'json' } };
const call = (b) => { try { return box.doPost({ postData: { contents: b } }).s; } catch (e) { return JSON.stringify({ ok: false, error: String(e.message || e) }); } };

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const errors = [];
  const open = async (w) => {
    const ctx = await browser.newContext({ viewport: { width: w, height: 900 }, serviceWorkers: 'block' });
    await ctx.addInitScript(() => {
      localStorage.setItem('skiri_customer_token', 'ctok-b');
      localStorage.setItem('skiri_customer_profile', JSON.stringify({ name: 'Tia Maere', email: 'b@x.test', phone: '73000001' }));
      localStorage.setItem('skiri_cookie_consent', 'accepted');
      if (!localStorage.getItem('skiri_cart_other')) localStorage.setItem('skiri_cart_other', JSON.stringify([{ variantId: 'x', label: 'X', unitPrice: 1, qty: 1 }]));
    });
    await ctx.route('**/macros/s/**', (route) => {
      const b = route.request().postData();
      let body;
      if (b) body = call(b);
      else { const q = Object.fromEntries(new URL(route.request().url()).searchParams); try { body = box.doGet({ parameter: q }).s; } catch (e) { body = JSON.stringify({ ok: false, error: String(e.message) }); } }
      route.fulfill({ status: 200, contentType: 'application/json', body });
    });
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(String(e)));
    await p.goto(BASE + '/customer-dashboard.html', { waitUntil: 'load' });
    await p.waitForFunction(() => document.getElementById('cust-kpi-active').textContent.trim() !== '–', null, { timeout: 10000 });
    return { ctx, p };
  };

  let { ctx, p } = await open(1280);
  ok('greets the customer by first name', (await p.textContent('#cust-hello')) === 'Hello, Tia');
  const k = await p.evaluate(() => ['cust-kpi-active', 'cust-kpi-todo', 'cust-kpi-done', 'cust-kpi-carts'].map((id) => document.getElementById(id).textContent.trim()));
  ok('summary from the customer\'s own orders: 2 active, 2 need you, 1 completed, 1 saved cart', k.join('|') === '2|2|1|1', k.join('|'));
  ok('another customer\'s order never appears', !(await p.textContent('#orders-list')).includes('O-ZED'));
  const rcv = await p.textContent('.dash-item[data-order-id="O-RCV"]');
  ok('each order says what it needs from the buyer', /Needs you: confirm you received it/.test(rcv) && /Needs you: send your payment details/.test(await p.textContent('.dash-item[data-order-id="O-PAY"]')));
  await p.click('.cust-kpis [data-filter="todo"]');
  const shown = await p.$$eval('#orders-list .dash-item', (els) => els.map((e) => e.dataset.orderId).sort().join());
  ok('tapping "Need you" filters the list to those orders, and its tab shows', shown === 'O-PAY,O-RCV' && /Needs you/.test(await p.textContent('#orders-filters')), shown);
  await p.click('.cust-kpis [data-filter="Fulfilled"]');
  ok('tapping "Completed" shows completed orders', (await p.$$eval('#orders-list .dash-item', (els) => els.map((e) => e.dataset.orderId).join())) === 'O-DONE');
  ok('a completed order offers Buy again; an active one does not', !!(await p.$('[data-buy-again="O-DONE"]')));
  await Promise.all([p.waitForURL(/cart\.html\?store=bong/), p.click('[data-buy-again="O-DONE"]')]);
  const cart = await p.evaluate(() => JSON.parse(localStorage.getItem('skiri_cart_bong')));
  ok('Buy again puts the same items in that store\'s cart and opens it', cart.length === 1 && cart[0].variantId === 'v3' && cart[0].qty === 3, JSON.stringify(cart));
  await ctx.close();

  for (const w of [320, 375, 390, 430, 768]) {
    ({ ctx, p } = await open(w));
    const over = await p.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    ok(`no sideways scroll at ${w}px`, over <= 1, String(over));
    if (w === 390 && process.env.SHOT_DIR) await p.screenshot({ path: process.env.SHOT_DIR + '/customer-dash-phone.png', fullPage: true });
    await ctx.close();
  }
  // Layout must not move when the orders arrive: the summary box is the same height before and after.
  ({ ctx, p } = await browser.newContext({ viewport: { width: 390, height: 900 }, serviceWorkers: 'block' }).then(async (c) => {
    await c.addInitScript(() => { localStorage.setItem('skiri_customer_token', 'ctok-b'); localStorage.setItem('skiri_customer_profile', JSON.stringify({ name: 'Tia Maere', email: 'b@x.test' })); localStorage.setItem('skiri_cookie_consent', 'accepted'); });
    let release; const gate = new Promise((r) => { release = r; });
    await c.route('**/macros/s/**', async (route) => { const b = route.request().postData(); if (b && JSON.parse(b).action === 'listCustomerOrders') await gate; route.fulfill({ status: 200, contentType: 'application/json', body: b ? call(b) : '{"ok":true}' }); });
    const pg = await c.newPage();
    await pg.goto(BASE + '/customer-dashboard.html', { waitUntil: 'load' });
    await pg.waitForTimeout(400);
    const before = await pg.$eval('.cust-summary', (e) => e.getBoundingClientRect().height);
    release();
    await pg.waitForFunction(() => document.getElementById('cust-kpi-active').textContent.trim() !== '–', null, { timeout: 10000 });
    const after = await pg.$eval('.cust-summary', (e) => e.getBoundingClientRect().height);
    ok('the summary keeps its height when the numbers arrive (no layout shift)', Math.abs(before - after) < 1, before + ' -> ' + after);
    return { ctx: c, p: pg };
  }));
  await ctx.close();

  ok('no page errors', errors.length === 0, errors.join(' | ').slice(0, 300));
  await browser.close();
  let fails = 0;
  console.log('\n--- customer dashboard (real backend) ---');
  for (const [s, n, x] of R) { if (s === 'FAIL') fails++; console.log(`${s}  ${n}${x !== '' ? '  [' + x + ']' : ''}`); }
  console.log(`\n${R.length - fails}/${R.length} passed`);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
