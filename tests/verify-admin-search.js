// Admin dashboard: "Find a store or product" search and the store analytics
// panel it opens. Backend numbers are covered by test-admin-analytics.js.
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = 'http://127.0.0.1:8099';
const ANALYTICS = {
  store: { ownerId: 'o1', storeName: 'Bong <Store>', storeSlug: 'bong', email: 'b@x.com', phone: '+686 7300', island: 'Tarawa', village: 'Betio',
    status: 'active', storeType: 'wholesaler', wholesaleVerified: false, createdAt: '2026-01-01T00:00:00Z', visits: 41, adminFeatured: true },
  products: [{ productId: 'p2', name: 'Flour', status: 'archived', views: 50, minPrice: 3, stock: null },
    { productId: 'p1', name: 'Rice', status: 'active', views: 10, minPrice: 7.5, stock: 8 }],
  totals: { products: 2, activeProducts: 1, views: 60 },
  orders: { count: 4, byStatus: { Paid: 1, Cancelled: 3 }, sales: 15.3 },
  bookings: { count: 0, byStatus: {} },
  reviews: { count: 2, average: 4.5 },
  featuring: { purchases: 1, spent: 0.7, activeNow: true, recent: [{ reference: 'MWFA', status: 'Approved', amount: 0.7, days: 7, endsAt: '2026-10-10T00:00:00Z' }] }
};

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e || '']);
  const calls = [];
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx.route('**/macros/s/**', (route) => {
    let body = {}; try { body = route.request().postDataJSON() || {}; } catch (e) {}
    const a = body.action || new URL(route.request().url()).searchParams.get('action');
    calls.push(Object.assign({ action: a }, body));
    let res = { ok: true };
    if (a === 'getOwnerProfile') res = { ok: true, owner: { ownerId: 'admin', storeName: 'Admin', storeSlug: 'adm', isAdmin: true } };
    else if (a === 'adminSearch') res = body.q === 'zzz' ? { ok: true, stores: [], products: [] } : { ok: true,
      stores: [{ ownerId: 'o1', storeName: 'Bong <Store>', storeSlug: 'bong', status: 'active' }],
      products: [{ productId: 'p1', name: 'Rice', status: 'active', ownerId: 'o1', storeName: 'Bong <Store>' }] };
    else if (a === 'adminStoreAnalytics') res = { ok: true, analytics: ANALYTICS };
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(res) });
  });
  const page = await ctx.newPage();
  await page.addInitScript(() => { try { localStorage.setItem('skiri_owner_token', 'tok'); } catch (e) {} });
  const errors = []; page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(BASE + '/owner/admin.html', { waitUntil: 'load' });
  await page.waitForSelector('#admin-search-input', { state: 'visible', timeout: 6000 });

  await page.fill('#admin-search-input', 'b');
  await page.waitForTimeout(600);
  ok('one letter does not search', !calls.some((c) => c.action === 'adminSearch'));
  await page.fill('#admin-search-input', 'bo');
  await page.waitForSelector('.admin-search-hit', { timeout: 4000 }).catch(() => {});
  const searches = calls.filter((c) => c.action === 'adminSearch');
  ok('two letters search once (debounced)', searches.length === 1 && searches[0].q === 'bo', JSON.stringify(searches));
  ok('results list stores and products', (await page.$$('.admin-search-hit')).length === 2);
  ok('store names are escaped, not HTML', /Bong <Store>/.test(await page.textContent('#admin-search-results')));

  await page.click('.admin-search-hit[data-product-id="p1"]');
  await page.waitForSelector('.admin-stats', { timeout: 4000 }).catch(() => {});
  const req = calls.find((c) => c.action === 'adminStoreAnalytics');
  ok('picking a product loads its store', req && req.ownerId === 'o1', JSON.stringify(req));
  const text = await page.textContent('#admin-analytics');
  ok('basics: type, status, contact, place', /Wholesaler \(call pending\)/.test(text) && /featured by admin/.test(text) && /b@x\.com/.test(text) && /Betio, Tarawa/.test(text), text.slice(0, 200));
  ok('stats: visits, views, orders, sales, rating, featuring spend',
    ['41', '60', '$15.30', '4.5 ★ (2)', '$0.70'].every((v) => text.includes(v)), text);
  ok('order statuses listed', /Paid 1 · Cancelled 3/.test(text));
  ok('no bookings says "none yet"', /Bookings:\s*none yet/.test(text));
  const tableRows = await page.$$eval('.admin-table tbody tr', (rows) => rows.map((r) => r.textContent.replace(/\s+/g, ' ').trim()));
  ok('product table: most viewed first, price/stock/views, untracked stock "-"',
    /^Flour \(archived\) \$3\.00 - 50$/.test(tableRows[0]) && /^Rice \$7\.50 8 10$/.test(tableRows[1]), JSON.stringify(tableRows));
  ok('the product picked from search is highlighted', await page.$eval('.admin-table tr.is-picked', (r) => /Rice/.test(r.textContent)).catch(() => false));
  ok('"featured now" badge and featuring history shown', /featured now/.test(text) && /MWFA · Approved · \$0\.70 for 7 days/.test(text));
  ok('"View store" links to the store page', await page.$eval('.admin-analytics-head a', (a) => a.getAttribute('href')) === '../store.html?store=bong');
  ok('no horizontal page scroll at 390px', !(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)));

  await page.fill('#admin-search-input', 'zzz');
  await page.waitForTimeout(800);
  ok('no matches says so', /Nothing matches "zzz"/.test(await page.textContent('#admin-search-status')));
  ok('no page errors', errors.length === 0, errors.join('; '));

  await browser.close();
  let f = 0; console.log('\n--- admin search + store analytics ---');
  for (const [s, n, e] of R) { if (s === 'FAIL') f++; console.log(`${s}  ${n}${e ? '  [' + e + ']' : ''}`); }
  console.log(`\n${R.length - f}/${R.length} passed`);
  process.exit(f ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
