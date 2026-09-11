const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = 'http://127.0.0.1:8099';

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const ctx = await browser.newContext({ viewport: { width: 900, height: 800 } });
  const posted = [];
  await ctx.route('**/macros/s/**', (route) => {
    let action = '', body = {};
    try { body = route.request().postDataJSON() || {}; action = body.action; } catch (e) {}
    try { if (!action) action = new URL(route.request().url()).searchParams.get('action') || ''; } catch (e) {}
    posted.push({ action, status: body.status });
    let out = { ok: true };
    if (action === 'getOwnerProfile') out = { ok: true, owner: { storeName: 'Bong', storeSlug: 'bong', status: 'active' } };
    else if (action === 'listOwnerProducts') out = { ok: true, products: [] };
    else if (action === 'listOwnerOrders') out = { ok: true, orders: [], total: 0 };
    else if (action === 'listOwnerBookings') out = { ok: true, bookings: [] };
    else if (action === 'getUnreadCount') out = { ok: true, count: 0 };
    else if (action === 'setStoreStatus') out = { ok: true };
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(out) });
  });
  const page = await ctx.newPage();
  await page.addInitScript(() => { try { localStorage.setItem('skiri_owner_token', 't'); } catch (e) {} });
  await page.goto(BASE + '/owner/dashboard.html', { waitUntil: 'load' });
  await page.waitForSelector('#store-status-toggle');
  await page.waitForFunction(() => document.getElementById('store-status-toggle').getAttribute('aria-checked') !== null);

  const results = [];
  const ok = (n, c, e) => results.push([c ? 'PASS' : 'FAIL', n, e || '']);

  // §20 initial state = OPEN (active)
  let s = await page.evaluate(() => {
    const t = document.getElementById('store-status-toggle');
    return { checked: t.getAttribute('aria-checked'), open: t.classList.contains('is-open'),
      openActive: document.getElementById('store-status-open-label').classList.contains('active'),
      hint: document.getElementById('store-status-toggle-hint').textContent };
  });
  ok('§20 initial OPEN: aria-checked true + is-open', s.checked === 'true' && s.open, JSON.stringify(s));
  ok('§20 initial hint says OPEN', /OPEN/.test(s.hint), s.hint);

  // Toggle -> CLOSED (standby)
  await page.click('#store-status-toggle');
  await page.waitForFunction(() => document.getElementById('store-status-toggle').getAttribute('aria-checked') === 'false');
  s = await page.evaluate(() => {
    const t = document.getElementById('store-status-toggle');
    return { checked: t.getAttribute('aria-checked'), open: t.classList.contains('is-open'),
      closedActive: document.getElementById('store-status-closed-label').classList.contains('active'),
      hint: document.getElementById('store-status-toggle-hint').textContent };
  });
  const lastPost = posted.filter(p => p.action === 'setStoreStatus').slice(-1)[0];
  ok('§20 toggle CLOSED sends standby', lastPost && lastPost.status === 'standby', JSON.stringify(lastPost));
  ok('§20 CLOSED: aria false, is-open off, CLOSED label active', s.checked === 'false' && !s.open && s.closedActive, JSON.stringify(s));
  ok('§20 CLOSED hint says CLOSED + stay logged in', /CLOSED/.test(s.hint) && /logged in/i.test(s.hint), s.hint);

  // Toggle back -> OPEN (active)
  await page.click('#store-status-toggle');
  await page.waitForFunction(() => document.getElementById('store-status-toggle').getAttribute('aria-checked') === 'true');
  const backPost = posted.filter(p => p.action === 'setStoreStatus').slice(-1)[0];
  ok('§20 toggle back sends active', backPost && backPost.status === 'active', JSON.stringify(backPost));

  // §22 pageshow guard: a disabled quick-link becomes enabled on pageshow
  const guard = await page.evaluate(() => {
    const btn = document.querySelector('.dashboard-quick-links .btn');
    btn.disabled = true;
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    return btn.disabled;
  });
  ok('§22 pageshow re-enables a stuck button', guard === false);

  // §22 clicking a quick-link applies NO fake loading state (checked synchronously,
  // before navigation) then navigates.
  const clickState = await page.evaluate(() => {
    const btn = document.querySelector('.dashboard-quick-links .btn'); // Products
    btn.click(); // sets window.location.href synchronously; DOM not mutated by handler
    return { disabled: btn.disabled, hasDots: !!btn.querySelector('.btn-saving-dots') };
  });
  ok('§22 click adds no disabled state', clickState.disabled === false, JSON.stringify(clickState));
  ok('§22 click adds no spinner dots', clickState.hasDots === false);
  await page.waitForURL('**/owner/products.html', { timeout: 5000 }).catch(() => {});
  ok('§22 quick-link navigates to target', /products\.html$/.test(page.url()), page.url());

  await browser.close();
  let failed = 0;
  console.log('\n--- Dashboard: spinner fix (§22) + open/closed toggle (§20) ---');
  for (const [st, n, e] of results) { if (st === 'FAIL') failed++; console.log(`${st}  ${n}${e ? '  [' + e + ']' : ''}`); }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
