// No "Featured" pill on any product card (owner's call, Oct 2026). Featuring
// itself stays - product.featured still comes from markPaidFeatured
// (Featuring.gs, tested in test-featuring.js) - only the label is gone, on
// every card renderer: browse cards (home/search/tips/similar), the store
// page's full card, and the categories tile.
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = 'http://127.0.0.1:8099';
const P = (featured) => ({ productId: featured ? 'p1' : 'p2', name: featured ? 'Rice' : 'Flour', storeSlug: 's', storeName: 'Store',
  category: 'food', listingType: 'product', imageUrl: '', variants: [{ variantId: 'v1', label: '1kg', price: 2, status: 'active' }],
  featured, rating: null, reviewCount: 0 });

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e || '']);
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  await ctx.route('**/macros/s/**', (route) => {
    const a = new URL(route.request().url()).searchParams.get('action') || '';
    const res = a === 'getTips' ? { ok: true, stores: [], products: [P(true), P(false)] } : { ok: true, products: [], stores: [] };
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(res) });
  });
  const errors = [];
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));

  // Tips page end to end: getTips -> renderBrowseProductCard.
  await page.goto(BASE + '/customer-tips.html', { waitUntil: 'load' });
  await page.waitForSelector('#tips-products .product-card', { timeout: 6000 });
  const tips = await page.$$eval('#tips-products .product-card', (cards) => cards.map((c) => ({
    name: c.querySelector('.product-name').textContent.trim(), badge: !!c.querySelector('.featured-badge') })));
  ok('tips: featured product still shows', tips.some((t) => /Rice/.test(t.name)), JSON.stringify(tips));
  ok('tips: no card has a pill', tips.every((t) => t.badge === false), JSON.stringify(tips));
  ok('tips: no "Featured" text on any card', await page.$$eval('#tips-products .product-card', (cs) => cs.every((c) => !/Featured/.test(c.textContent))));
  await page.screenshot({ path: process.env.SHOT || '/dev/null', fullPage: false }).catch(() => {});

  // Store page full card.
  await page.goto(BASE + '/store.html?store=s', { waitUntil: 'load' });
  await page.waitForFunction(() => typeof renderProductCard === 'function', null, { timeout: 6000 });
  const store = await page.evaluate(([a, b]) => [renderProductCard(a, { storeSlug: 's' }), renderProductCard(b, { storeSlug: 's' })]
    .map((h) => h.includes('featured-badge')), [P(true), P(false)]);
  ok('store page card: no pill, featured or not', store[0] === false && store[1] === false, JSON.stringify(store));
  const kinds = await page.evaluate((p) => ['service', 'rental'].map((t) => renderProductCard(Object.assign({}, p, { listingType: t }), { storeSlug: 's' }).includes('featured-badge')), P(true));
  ok('store page service and rental cards: no pill', kinds.every((k) => k === false), JSON.stringify(kinds));

  // Categories tile.
  await page.goto(BASE + '/categories.html', { waitUntil: 'load' });
  await page.waitForFunction(() => typeof renderCategoryTile === 'function', null, { timeout: 6000 });
  const tiles = await page.evaluate(([a, b]) => [renderCategoryTile(a), renderCategoryTile(b)].map((h) => h.includes('featured-badge')), [P(true), P(false)]);
  ok('categories tile: no pill, featured or not', tiles[0] === false && tiles[1] === false, JSON.stringify(tiles));
  const browse = await page.evaluate((p) => ['product', 'service', 'rental'].map((t) => renderBrowseProductCard(Object.assign({}, p, { listingType: t, sellerBadges: ['verified'] })).includes('featured-badge')), P(true));
  ok('browse cards (product, service, rental, verified seller): no pill', browse.every((k) => k === false), JSON.stringify(browse));
  ok('the old pill helper is gone', await page.evaluate(() => typeof featuredBadgeHtml === 'undefined'));
  ok('no page errors', errors.length === 0, errors.join('; '));

  await browser.close();
  let f = 0; console.log('\n--- No "Featured" pill on product cards ---');
  for (const [s, n, e] of R) { if (s === 'FAIL') f++; console.log(`${s}  ${n}${e ? '  [' + e + ']' : ''}`); }
  console.log(`\n${R.length - f}/${R.length} passed`);
  process.exit(f ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
