/**
 * Seller dashboard + seller shell in the browser, against the REAL backend
 * (gas-harness behind every Api.post): the KPI cards show the server's real
 * numbers, the sidebar on a computer, the tab bar + drawer on phones, no
 * sideways scroll from 320px to desktop, a retry state when the summary
 * fails, and the elements older pages and tests rely on still in place.
 */
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const { makeBox } = require('./lib/gas-harness.js');
const BASE = process.env.TX_BASE || 'http://127.0.0.1:8099';
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e === undefined ? '' : e]);
const FUT = new Date(Date.now() + 9e8).toISOString();
const iso = (d) => new Date(Date.now() - d * 86400000).toISOString();
const box = makeBox({
  Owners: [['OwnerId', 'StoreSlug', 'StoreName', 'Email', 'Status', 'StoreType'], ['own_a', 'alpha', 'Alpha Store', 'a@x.test', 'active', 'retailer'],
    ['own_b', 'beta', 'Beta', 'b@x.test', 'active', 'retailer']],
  Sessions: [['Token', 'OwnerId', 'CreatedAt', 'ExpiresAt'], ['tok', 'own_a', '', FUT]],
  Orders: [['OrderId', 'OwnerId', 'StoreSlug', 'CustomerName', 'Total', 'Status', 'ItemsSummary', 'CreatedAt'],
    ['A-1', 'own_a', 'alpha', 'Tia <b>', 10, 'Paid', '1x Rice', iso(0)], ['A-2', 'own_a', 'alpha', 'Ben', 5, 'Pending Payment', '1x Oil', iso(0)],
    ['A-3', 'own_a', 'alpha', 'Kat', 8, 'Fulfilled', '1x Fan', iso(1)], ['B-1', 'own_b', 'beta', 'Other', 999, 'Paid', 'x', iso(0)]],
  Products: [['ProductId', 'OwnerId', 'Name', 'Status'], ['p1', 'own_a', 'Rice', 'active']],
  Variants: [['VariantId', 'ProductId', 'OwnerId', 'Label', 'StockQty', 'ReservedQty', 'ReorderLevel', 'Status'], ['v1', 'p1', 'own_a', '10kg', 2, 0, 5, 'active']]
});
box.ContentService = { createTextOutput: (s) => ({ s, setMimeType() { return this; } }), MimeType: { JSON: 'json' } };

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const errors = [];
  let failSummary = 0;
  const open = async (w, h, url, signedOut) => {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, serviceWorkers: 'block' });
    if (!signedOut) await ctx.addInitScript(() => { localStorage.setItem('skiri_owner_token', 'tok'); localStorage.setItem('skiri_owner_profile', JSON.stringify({ storeName: 'Alpha Store', storeSlug: 'alpha', storeType: 'retailer', status: 'active' })); });
    await ctx.route('**/macros/s/**', (route) => {
      const b = route.request().postData();
      if (b && failSummary && JSON.parse(b).action === 'getSellerDashboard') { failSummary--; return route.abort('failed'); }
      route.fulfill({ status: 200, contentType: 'application/json', body: b ? box.doPost({ postData: { contents: b } }).s : '{"ok":true}' });
    });
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(String(e)));
    await p.goto(BASE + '/owner/' + (url || 'dashboard.html'), { waitUntil: 'load' });
    return { ctx, p };
  };

  let { ctx, p } = await open(1280, 900);
  await p.waitForSelector('.dash-table', { timeout: 10000 });
  const kpi = await p.evaluate(() => ['kpi-orders-today', 'kpi-sales-today', 'kpi-low-stock', 'kpi-needs-action'].map((id) => document.getElementById(id).textContent.trim()));
  ok('KPI cards show the server\'s numbers (2 orders, $10.00 confirmed, 1 low, 1 to act on)', kpi.join('|') === '2|$10.00|1|1', kpi.join('|'));
  ok('another store\'s order never appears', !(await p.textContent('#recent-orders')).includes('B-1'));
  ok('customer names are shown as text, not markup', (await p.textContent('#recent-orders')).includes('Tia <b>'));
  ok('attention list names the low-stock item and the order to confirm', /Low stock: Rice/.test(await p.textContent('#dash-alerts')) && /confirm payment/.test(await p.textContent('#dash-alerts')));
  ok('the chart and its accessible table are drawn from the series', !!(await p.$('#sales-chart svg path.line')) && (await p.$$('#sales-table tbody tr')).length === 7);
  const side = await p.evaluate(() => { const s = document.querySelector('.seller-sidebar'); const r = s.getBoundingClientRect(); return { x: r.left, w: r.width, color: getComputedStyle(s).backgroundColor, active: s.querySelector('[aria-current="page"]').textContent.trim() }; });
  ok('computer: the sidebar is visible in Mwakete purple with Dashboard marked current', side.x === 0 && side.w === 240 && side.color === 'rgb(51, 45, 99)' && side.active === 'Dashboard', JSON.stringify(side));
  ok('computer: no tab bar', await p.evaluate(() => getComputedStyle(document.querySelector('.seller-tabbar')).display === 'none'));
  await p.click('.seller-sidebar-collapse');
  await p.waitForTimeout(350);
  ok('the sidebar collapses to icons and remembers it', await p.evaluate(() => document.querySelector('.seller-sidebar').getBoundingClientRect().width === 76 && localStorage.getItem('skiri_seller_sidebar_collapsed') === '1'));
  await p.click('.seller-sidebar-collapse');
  ok('kept for older code and tests: store toggle, quick links, badges, admin link', !!(await p.$('#store-status-toggle')) && (await p.$$('.dashboard-quick-links .btn')).length === 6
    && !!(await p.$('#nav-orders-badge')) && !!(await p.$('#admin-link-wrap')));
  await p.selectOption('#dash-period', '30');
  await p.waitForFunction(() => document.querySelectorAll('#sales-table tbody tr').length === 30, null, { timeout: 8000 });
  ok('switching to 30 days reloads real figures', true);
  await ctx.close();

  failSummary = 1;
  ({ ctx, p } = await open(390, 844));
  await p.waitForSelector('#dash-retry', { timeout: 10000 });
  ok('a failed summary shows a Try again button, no made-up numbers', (await p.textContent('#kpi-orders-today')).trim() === '–');
  await p.click('#dash-retry');
  await p.waitForSelector('.dash-table', { timeout: 10000 });
  ok('Try again loads the real summary', (await p.textContent('#kpi-orders-today')).trim() === '2');
  const tab = await p.evaluate(() => { const t = document.querySelector('.seller-tabbar'); const r = t.getBoundingClientRect(); return { bottom: Math.round(r.bottom), h: innerHeight, items: t.querySelectorAll('.seller-tab').length }; });
  ok('phone: bottom tab bar with 5 tabs', tab.bottom === tab.h && tab.items === 5, JSON.stringify(tab));
  ok('phone: sidebar hidden off screen', await p.evaluate(() => document.querySelector('.seller-sidebar').getBoundingClientRect().right <= 0));
  await p.click('.seller-tab-more');
  await p.waitForTimeout(350);
  ok('phone: More opens the full menu as a drawer', await p.evaluate(() => document.querySelector('.seller-sidebar').getBoundingClientRect().left === 0 && document.querySelector('.seller-tab-more').getAttribute('aria-expanded') === 'true'));
  await p.keyboard.press('Escape');
  ok('phone: Escape closes the drawer', await p.evaluate(() => !document.body.classList.contains('seller-drawer-open')));
  ok('phone: recent orders become cards (table header hidden)', await p.evaluate(() => document.querySelector('.dash-table thead').getBoundingClientRect().height <= 1));
  const small = await p.$$eval('.seller-tab', (els) => els.filter((e) => e.getBoundingClientRect().height < 44).length);
  ok('phone: tabs are at least 44px tall', small === 0);
  await ctx.close();

  for (const w of [320, 375, 390, 430, 768, 1024, 1440]) {
    ({ ctx, p } = await open(w, 900));
    await p.waitForSelector('.dash-table', { timeout: 10000 });
    const over = await p.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    ok(`no sideways scroll at ${w}px`, over <= 1, String(over));
    await ctx.close();
  }
  for (const page of ['orders.html', 'products.html', 'inventory.html', 'settings.html', 'admin.html']) {
    ({ ctx, p } = await open(1280, 900, page));
    await p.waitForSelector('.seller-sidebar', { timeout: 10000 });
    const cur = await p.evaluate(() => (document.querySelector('.seller-sidebar [aria-current="page"]') || {}).textContent || '');
    ok(`${page}: same sidebar, current page marked`, page === 'admin.html' ? cur === '' || /Admin/.test(cur) : cur.trim().toLowerCase().startsWith(page.split('.')[0].slice(0, 5)), cur);
    await ctx.close();
  }
  ({ ctx, p } = await open(1280, 900, 'login.html', true));
  await p.waitForTimeout(300);
  ok('the login page gets no sidebar', !(await p.$('.seller-sidebar')));
  await ctx.close();

  ok('no page errors', errors.length === 0, errors.join(' | ').slice(0, 300));
  await browser.close();
  let fails = 0;
  console.log('\n--- seller dashboard + shell (real backend) ---');
  for (const [s, n, x] of R) { if (s === 'FAIL') fails++; console.log(`${s}  ${n}${x !== '' ? '  [' + x + ']' : ''}`); }
  console.log(`\n${R.length - fails}/${R.length} passed`);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
