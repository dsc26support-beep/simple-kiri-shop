/**
 * Recent Views: opening a product or store page records it on this device;
 * recent.html lists them newest first in Products | Stores tabs; the home
 * quick-action row links to it; nothing is sent anywhere; hostile or broken
 * stored data cannot break the page.
 */
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = 'http://127.0.0.1:8099';
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e === undefined ? '' : e]);

const product = (i, name) => ({
  productId: 'p' + i, name: name || 'Solar Lamp ' + i, description: 'Bright', category: 'electronics',
  status: 'active', imageUrl: 'https://res.cloudinary.com/demo/image/upload/sample.jpg', listingType: i === 3 ? 'rental' : 'product',
  variants: [{ variantId: 'v' + i, label: 'One', price: 25, status: 'active', stockQty: 5 }]
});

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx.addInitScript(() => { try { localStorage.setItem('skiri_cookie_consent', 'true'); } catch (e) {} });
  const sent = [];
  await ctx.route('**/res.cloudinary.com/**', (r) => r.fulfill({ status: 200, contentType: 'image/png',
    body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64') }));
  await ctx.route('**/macros/s/**', (route) => {
    const req = route.request();
    const u = new URL(req.url());
    const a = u.searchParams.get('action') || (req.postData() || '').match(/"action":"(\w+)"/)?.[1];
    sent.push(a + ' ' + (req.postData() || u.search));
    const slug = u.searchParams.get('storeSlug');
    let body = { ok: true, products: [], stores: [], reviews: [] };
    if (a === 'listProducts') {
      body = {
        ok: true, storeName: slug === 'evil' ? '<img src=x onerror=alert(1)>' : 'Bong Store', storeLogoUrl: '',
        storeIsland: 'South Tarawa', storeVillage: 'Bairiki', storePhone: '73000000', storeOpen: true,
        products: [product(1), product(2), product(3), product(9, '"><script>alert(2)</script>')]
      };
    }
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  page.on('dialog', (d) => { if (/Clear your recently viewed/.test(d.message())) d.accept(); else { errs.push('DIALOG ' + d.message()); d.dismiss(); } });
  const go = async (path) => { await page.goto(BASE + path, { waitUntil: 'load' }); await page.waitForTimeout(500); };

  /* ---------- empty state ---------- */
  await go('/recent.html');
  ok('empty: products tab says nothing viewed yet, with a way out',
    /No products viewed yet/.test(await page.textContent('#recent-products'))
    && !!(await page.$('#recent-products a[href="categories.html"]')));
  ok('empty: no Clear history button', await page.$eval('#recent-clear', (b) => b.hidden));

  /* ---------- the home link ---------- */
  await go('/index.html');
  const quick = await page.$$eval('.quick-action-strip .quick-action-label', (els) => els.map((e) => e.textContent.trim()));
  // Renamed "Recents" (Oct 2026, owner request).
  ok('home quick actions: Recents is 5th, after Categories, Stores, Rentals, Services',
    quick.join('|') === 'Categories|Stores|Rentals|Services|Recents', quick.join('|'));
  ok('...and links to recent.html', await page.$eval('.quick-action-strip a:last-child', (a) => a.getAttribute('href')) === 'recent.html');
  const strip = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth > innerWidth + 1 }));
  ok('390px: the five-item row does not widen the page', !strip.overflow);

  /* ---------- recording ---------- */
  await go('/product.html?store=bong&product=p1');
  await go('/product.html?store=bong&product=p3');
  await go('/store.html?store=bong');
  await go('/product.html?store=bong&product=p1');    // viewed again: moves to the top, no duplicate
  await go('/product.html?store=evil&product=p9');    // hostile names

  await go('/recent.html');
  const rows = await page.$$eval('#recent-products .recent-item', (els) => els.map((e) => ({
    href: e.getAttribute('href'), name: e.querySelector('.recent-name').textContent,
    meta: e.querySelector('.recent-meta').textContent, when: e.querySelector('.recent-when').textContent
  })));
  ok('opened products are listed, newest first, no duplicates',
    rows.map((r) => r.href).join(' ') === 'product.html?store=evil&product=p9 product.html?store=bong&product=p1 product.html?store=bong&product=p3',
    rows.map((r) => r.href).join(' '));
  ok('a row shows the store and where it is', /Bong Store · Bairiki|Bong Store · South Tarawa/.test(rows[1].meta), rows[1].meta);
  ok('a rental is labelled as one', /^Rental · /.test(rows[2].meta), rows[2].meta);
  ok('and when it was viewed', rows[1].when === 'Just now', rows[1].when);
  ok('products are counted on the tab', /\(3\)/.test(await page.textContent('#recent-tab-products')));
  ok('no price is kept (it would go stale)', await page.evaluate(() => !/price/i.test(localStorage.getItem('skiri_recent_products'))));
  const xss = await page.evaluate(() => ({ imgs: document.querySelectorAll('.recent-list img:not(.recent-thumb)').length, scripts: document.querySelectorAll('.recent-list script').length }));
  ok('hostile product and store names are shown as text', xss.imgs === 0 && xss.scripts === 0
    && rows[0].name.indexOf('<script>') !== -1 && errs.every((e) => !/DIALOG/.test(e)), JSON.stringify(xss));
  ok('thumbnails have a fixed size (no layout jump)', await page.$eval('#recent-products .recent-thumb', (i) => i.getAttribute('width') === '64' && i.getAttribute('height') === '64'));

  /* ---------- stores tab + keyboard ---------- */
  ok('stores panel starts hidden', await page.$eval('#recent-panel-stores', (p) => p.hidden));
  await page.focus('#recent-tab-products');
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(100);
  const st = await page.evaluate(() => ({
    sel: document.getElementById('recent-tab-stores').getAttribute('aria-selected'),
    focus: document.activeElement.id,
    shown: !document.getElementById('recent-panel-stores').hidden,
    stores: Array.from(document.querySelectorAll('#recent-stores .recent-item')).map((a) => a.getAttribute('href'))
  }));
  ok('arrow keys move between tabs (ARIA tabs)', st.sel === 'true' && st.focus === 'recent-tab-stores' && st.shown, JSON.stringify(st));
  ok('an opened store is listed; a store only seen via its product is not',
    st.stores.join(' ') === 'store.html?store=bong', st.stores.join(' '));

  /* ---------- privacy: nothing about it reaches the backend ---------- */
  ok('the history is never sent to Mwakete', sent.every((s) => !/recent/i.test(s)), sent.filter((s) => /recent/i.test(s)).join(' | '));

  /* ---------- clear ---------- */
  await page.click('#recent-clear');
  await page.waitForTimeout(200);
  ok('Clear history empties both lists', /No stores viewed yet/.test(await page.textContent('#recent-stores'))
    && await page.evaluate(() => !localStorage.getItem('skiri_recent_products') && !localStorage.getItem('skiri_recent_stores')));

  /* ---------- cap + broken storage ---------- */
  await page.evaluate(() => {
    for (let i = 0; i < 40; i++) recordRecentProduct({ productId: 'x' + i, name: 'Item ' + i }, 'bong', {});
  });
  ok('keeps the newest 30', await page.evaluate(() => getRecentProducts().length === 30 && getRecentProducts()[0].id === 'x39'));
  await page.evaluate(() => { localStorage.setItem('skiri_recent_products', '{not json'); localStorage.setItem('skiri_recent_stores', '[null, 5, {"name":"no id"}]'); });
  await go('/recent.html');
  ok('broken stored data shows the empty state, not an error',
    /No products viewed yet/.test(await page.textContent('#recent-products')) && /No stores viewed yet/.test(await page.textContent('#recent-stores')));
  await go('/recent.html?tab=stores');
  ok('?tab=stores opens on stores', await page.$eval('#recent-tab-stores', (t) => t.getAttribute('aria-selected')) === 'true');

  for (const w of [320, 1280]) {
    await page.setViewportSize({ width: w, height: 800 });
    await page.evaluate(() => { for (let i = 0; i < 5; i++) recordRecentProduct({ productId: 'w' + i, name: 'A very long product name that keeps going and going ' + i }, 'bong', { storeName: 'Store with a long name', storeIsland: 'Kiritimati' }); });
    await go('/recent.html');
    ok(w + 'px: no sideways scroll', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  }
  ok('no JS errors anywhere', errs.length === 0, errs.join(' | '));

  await browser.close();
  let f = 0;
  console.log('\n--- Recent Views ---');
  for (const [s, n, e] of R) { if (s === 'FAIL') f++; console.log(`${s}  ${n}${e !== '' ? '  [' + e + ']' : ''}`); }
  console.log(`\n${R.length - f}/${R.length} passed`);
  process.exit(f ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
