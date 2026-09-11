const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = 'http://127.0.0.1:8099';

const results = [];
const ok = (n, c, e) => results.push([c ? 'PASS' : 'FAIL', n, e || '']);

function route(ctx, opts, posted) {
  return ctx.route('**/macros/s/**', (r) => {
    let action = '', body = {};
    try { body = r.request().postDataJSON() || {}; action = body.action; } catch (e) {}
    if (action) posted.push({ action, body });
    let out = { ok: true };
    if (action === 'getCustomerProfile') out = opts.profileOk === false ? { ok: false, error: 'Not signed in' } : { ok: true, customer: { customerId: 'c1', name: 'Debby', email: 'd@x.com', phone: '7301234', emailVerified: true } };
    else if (action === 'listCustomerOrders') out = opts.ordersFail ? { ok: false, error: 'boom' } : { ok: true, orders: opts.orders || [] };
    else if (action === 'listCustomerBookings') out = { ok: true, bookings: opts.bookings || [] };
    else if (action === 'updateCustomerProfile') out = { ok: true, customer: { customerId: 'c1', name: body.name, email: 'd@x.com', phone: body.phone, emailVerified: true } };
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(out) });
  });
}

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

  // Guard: no token -> redirect to login
  {
    const ctx = await browser.newContext(); const posted = [];
    await route(ctx, {}, posted);
    const page = await ctx.newPage();
    await page.goto(BASE + '/customer-dashboard.html', { waitUntil: 'load' });
    await page.waitForURL('**/customer-login.html', { timeout: 4000 }).catch(() => {});
    ok('guard: no token redirects to login', /customer-login\.html/.test(page.url()), page.url());
    await ctx.close();
  }

  // Signed in: profile + orders + bookings + seller link + edit + logout
  {
    const ctx = await browser.newContext({ viewport: { width: 500, height: 900 } }); const posted = [];
    await route(ctx, {
      orders: [{ orderId: 'o1', storeSlug: 'bong', storeName: 'Bong', itemsSummary: '1× Rice', total: 6, status: 'Pending Payment' }],
      bookings: [{ bookingId: 'b1', storeSlug: 'kv', storeName: 'KV', productName: 'Kayak', startDate: '2026-09-01', endDate: '2026-09-03', status: 'Pending' }]
    }, posted);
    const page = await ctx.newPage();
    await page.addInitScript(() => { try { localStorage.setItem('skiri_customer_token', 'ct'); localStorage.setItem('skiri_owner_token', 'ot'); } catch (e) {} });
    await page.goto(BASE + '/customer-dashboard.html', { waitUntil: 'load' });
    await page.waitForSelector('#orders-list .dash-item, #orders-status');
    await page.waitForFunction(() => document.querySelector('#orders-list .dash-item'));
    const st = await page.evaluate(() => ({
      name: document.getElementById('profile-name').textContent,
      email: document.getElementById('profile-email').textContent,
      phone: document.getElementById('profile-phone').textContent,
      orderCount: document.querySelectorAll('#orders-list .dash-item').length,
      orderText: document.getElementById('orders-list').textContent,
      bookingCount: document.querySelectorAll('#bookings-list .dash-item').length,
      bookingText: document.getElementById('bookings-list').textContent,
      sellerShown: !document.getElementById('seller-link-wrap').classList.contains('hidden'),
    }));
    ok('profile shows name/email/phone', st.name === 'Debby' && st.email === 'd@x.com' && st.phone === '7301234', JSON.stringify(st));
    ok('my orders renders 1 order with total+status', st.orderCount === 1 && /Bong/.test(st.orderText) && /Pending Payment/.test(st.orderText), st.orderText);
    ok('my bookings renders 1 booking', st.bookingCount === 1 && /Kayak/.test(st.bookingText), st.bookingText);
    ok('seller link shown (also owns a store)', st.sellerShown);

    // profile edit: bad phone blocked, then good save
    await page.click('#profile-edit-btn');
    await page.fill('#profile-name-input', 'Debby H');
    await page.fill('#profile-phone-input', '7201234');
    await page.click('#profile-form button[type="submit"]');
    await page.waitForTimeout(80);
    const blocked = !posted.some(p => p.action === 'updateCustomerProfile');
    ok('profile edit blocks bad local phone', blocked && /730 or 630/.test(await page.textContent('#profile-error')));
    await page.fill('#profile-phone-input', '6301234');
    await page.click('#profile-form button[type="submit"]');
    await page.waitForFunction(() => document.getElementById('profile-form').classList.contains('hidden'));
    ok('profile edit saves good phone (updateCustomerProfile called)', posted.some(p => p.action === 'updateCustomerProfile' && p.body.phone === '6301234'));
    ok('profile view shows updated name', (await page.textContent('#profile-name')) === 'Debby H');

    // logout (addInitScript re-seeds the token on the index.html nav, so assert
    // on the logout call + redirect rather than the re-seeded storage value)
    await page.click('#customer-logout');
    await page.waitForURL('**/index.html', { timeout: 4000 }).catch(() => {});
    ok('logout calls logoutCustomer + redirects home', posted.some(p => p.action === 'logoutCustomer') && /index\.html/.test(page.url()), page.url());
    await ctx.close();
  }

  // Empty + error states
  {
    const ctx = await browser.newContext(); const posted = [];
    await route(ctx, { orders: [], bookings: [], ordersFail: true }, posted);
    const page = await ctx.newPage();
    await page.addInitScript(() => { try { localStorage.setItem('skiri_customer_token', 'ct'); } catch (e) {} });
    await page.goto(BASE + '/customer-dashboard.html', { waitUntil: 'load' });
    await page.waitForFunction(() => /Refresh|refresh/.test(document.getElementById('orders-status').textContent) || document.querySelector('#orders-status').textContent.length > 0);
    const s = await page.evaluate(() => ({ orders: document.getElementById('orders-status').textContent, bookings: document.getElementById('bookings-status').textContent }));
    ok('orders error shows a refresh/failed message (not blank)', /refresh|Refresh/.test(s.orders), s.orders);
    ok('bookings empty shows "No bookings yet."', /No bookings yet/.test(s.bookings), s.bookings);
    ok('no seller link when not an owner', await page.evaluate(() => document.getElementById('seller-link-wrap').classList.contains('hidden')));
    await ctx.close();
  }

  // home-nav: signed-in customer -> "Account" link to dashboard
  {
    const ctx = await browser.newContext(); const posted = [];
    await ctx.route('**/macros/s/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, products: [] }) }));
    const page = await ctx.newPage();
    await page.addInitScript(() => { try { localStorage.setItem('skiri_customer_token', 'ct'); } catch (e) {} });
    await page.goto(BASE + '/index.html', { waitUntil: 'load' });
    await page.waitForFunction(() => typeof CustomerAuth !== 'undefined');
    const nav = await page.evaluate(() => {
      const link = document.getElementById('nav-signin-link');
      return { text: link.textContent, href: link.getAttribute('href') };
    });
    ok('home nav: customer sees "Account" -> dashboard', nav.text === 'Account' && nav.href === 'customer-dashboard.html', JSON.stringify(nav));
    await ctx.close();
  }

  await browser.close();
  let failed = 0;
  console.log('\n--- Phase 3: customer dashboard ---');
  for (const [st, n, e] of results) { if (st === 'FAIL') failed++; console.log(`${st}  ${n}${e ? '  [' + e + ']' : ''}`); }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
