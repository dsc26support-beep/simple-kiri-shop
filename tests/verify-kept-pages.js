/**
 * Pages show what this phone last saw at once, then the fresh answer
 * (Oct 2026: "home page, categories, dashboard feel very slow"). The backend
 * is made slow on purpose (SLOW ms per answer): a return visit must paint the
 * kept list long before that, then swap in what changed; a first visit and a
 * failed refresh still behave sensibly; a seller's kept summary leaves at
 * log-out.
 */
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const { makeBox } = require('./lib/gas-harness.js');
const BASE = process.env.TX_BASE || 'http://127.0.0.1:8099';
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e === undefined ? '' : e]);
const SLOW = 2500;
const FUT = new Date(Date.now() + 9e8).toISOString();
const card = (id, name) => ({ productId: id, name, storeSlug: 'alpha', storeName: 'Alpha', category: 'food', listingType: 'product', imageUrl: '',
  variants: [{ variantId: 'v' + id, label: 'Std', price: 5, stockQty: null }] });

const box = makeBox({
  Owners: [['OwnerId', 'StoreSlug', 'StoreName', 'Email', 'Status', 'StoreType'], ['own_a', 'alpha', 'Alpha Store', 'a@x.test', 'active', 'retailer']],
  Sessions: [['Token', 'OwnerId', 'CreatedAt', 'ExpiresAt'], ['tok', 'own_a', '', FUT]],
  Orders: [['OrderId', 'OwnerId', 'StoreSlug', 'CustomerName', 'Total', 'Status', 'ItemsSummary', 'CreatedAt'], ['A-1', 'own_a', 'alpha', 'Tia', 10, 'Paid', '1x Rice', new Date().toISOString()]],
  Products: [['ProductId', 'OwnerId', 'Name', 'Status'], ['p1', 'own_a', 'Rice', 'active']],
  Variants: [['VariantId', 'ProductId', 'OwnerId', 'Label', 'StockQty', 'ReservedQty', 'ReorderLevel', 'Status'], ['v1', 'p1', 'own_a', '10kg', 20, 0, 5, 'active']]
});
box.ContentService = { createTextOutput: (s) => ({ s, setMimeType() { return this; } }), MimeType: { JSON: 'json' } };

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const errors = [];
  let products = [card('a1', 'Rice First')];
  let fail = false;
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  await ctx.addInitScript(() => localStorage.setItem('skiri_cookie_consent', 'true'));
  await ctx.route('**/macros/s/**', async (route) => {
    const req = route.request();
    const b = req.postData();
    const action = b ? JSON.parse(b).action : new URL(req.url()).searchParams.get('action');
    let body;
    if (fail) body = JSON.stringify({ ok: false, error: 'Network error - please check your connection and try again.' });
    else if (action === 'getHomePageData') body = JSON.stringify({ ok: true, products, stores: [] });
    else if (action === 'searchProducts') body = JSON.stringify({ ok: true, products });
    else if (b) body = box.doPost({ postData: { contents: b } }).s;
    else body = JSON.stringify({ ok: true, products: [], stores: [], tips: [], ads: [] });
    if (['getHomePageData', 'searchProducts', 'getSellerDashboard'].indexOf(action) !== -1) await new Promise((r) => setTimeout(r, SLOW));
    route.fulfill({ status: 200, contentType: 'application/json', body });
  });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(String(e)));
  const textAt = (sel, ms) => p.waitForTimeout(ms).then(() => p.textContent(sel));

  /* ---------- homepage ---------- */
  await p.goto(BASE + '/index.html', { waitUntil: 'load' });
  ok('home, first visit: waits for the backend (nothing kept yet)', !/Rice First/.test(await textAt('#trending-products-list', 600)));
  await p.waitForFunction(() => /Rice First/.test(document.getElementById('trending-products-list').textContent), null, { timeout: 8000 });
  products = [card('a1', 'Rice First'), card('a2', 'Oil Second')];
  const t0 = Date.now();
  await p.goto(BASE + '/index.html', { waitUntil: 'load' });
  await p.waitForFunction(() => /Rice First/.test(document.getElementById('trending-products-list').textContent), null, { timeout: 8000 });
  const shownIn = Date.now() - t0;
  ok(`home, return visit: last products shown at once (${shownIn}ms, backend takes ${SLOW}ms)`, shownIn < SLOW - 500, String(shownIn));
  ok('...no "Loading" left on screen', !/Loading/i.test(await p.textContent('#trending-products-status')));
  await p.waitForFunction(() => /Oil Second/.test(document.getElementById('trending-products-list').textContent), null, { timeout: 8000 });
  ok('...then the fresh list replaces it when it arrives', true);
  fail = true;
  await p.goto(BASE + '/index.html', { waitUntil: 'load' });
  await p.waitForTimeout(SLOW + 600);
  ok('home, refresh fails: the kept list stays (no error over it)', /Oil Second/.test(await p.textContent('#trending-products-list')) && !/could not|try again/i.test(await p.textContent('#trending-products-status')));
  fail = false;

  /* ---------- categories ---------- */
  products = [card('c1', 'Tinned Fish')];
  await p.goto(BASE + '/categories.html?category=food', { waitUntil: 'load' });
  await p.waitForFunction(() => /Tinned Fish/.test(document.getElementById('category-list').textContent), null, { timeout: 8000 });
  products = [card('c1', 'Tinned Fish'), card('c2', 'Corned Beef')];
  const t1 = Date.now();
  await p.goto(BASE + '/categories.html?category=food', { waitUntil: 'load' });
  await p.waitForFunction(() => /Tinned Fish/.test(document.getElementById('category-list').textContent), null, { timeout: 8000 });
  const catIn = Date.now() - t1;
  ok(`categories, return visit: last list shown at once (${catIn}ms)`, catIn < SLOW - 500, String(catIn));
  await p.waitForFunction(() => /Corned Beef/.test(document.getElementById('category-list').textContent), null, { timeout: 8000 });
  ok('...then the fresh list replaces it', true);

  /* ---------- seller dashboard ---------- */
  await p.evaluate(() => { localStorage.setItem('skiri_owner_token', 'tok'); localStorage.setItem('skiri_owner_profile', JSON.stringify({ storeName: 'Alpha Store', storeSlug: 'alpha', storeType: 'retailer', status: 'active' })); });
  await p.goto(BASE + '/owner/dashboard.html', { waitUntil: 'load' });
  await p.waitForFunction(() => document.getElementById('kpi-orders-today').textContent.trim() === '1', null, { timeout: 10000 });
  const t2 = Date.now();
  await p.goto(BASE + '/owner/dashboard.html', { waitUntil: 'load' });
  await p.waitForFunction(() => document.getElementById('kpi-orders-today').textContent.trim() === '1', null, { timeout: 10000 });
  const dashIn = Date.now() - t2;
  ok(`dashboard, return visit: last figures shown at once (${dashIn}ms)`, dashIn < SLOW - 500, String(dashIn));
  ok('...saying it is updating', /Updating/.test(await p.textContent('#dash-status')));
  await p.waitForFunction(() => document.getElementById('dash-status').textContent.trim() === '', null, { timeout: 8000 });
  ok('...and the note goes when the fresh figures arrive', true);
  await p.evaluate(() => Auth.clearSession());
  ok('log-out removes the kept summary from this phone', await p.evaluate(() => Object.keys(localStorage).every((k) => k.indexOf('skiri_kept:seller:') !== 0)));
  ok('...shopper pages keep theirs', await p.evaluate(() => !!localStorage.getItem('skiri_kept:home')));

  ok('no page errors', errors.length === 0, errors.join(' | ').slice(0, 300));
  await browser.close();
  let fails = 0;
  console.log('\n--- pages show what this phone last saw, then refresh ---');
  for (const [s, n, x] of R) { if (s === 'FAIL') fails++; console.log(`${s}  ${n}${x !== '' ? '  [' + x + ']' : ''}`); }
  console.log(`\n${R.length - fails}/${R.length} passed`);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
