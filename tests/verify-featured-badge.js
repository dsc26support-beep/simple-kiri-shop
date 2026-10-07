// "Featured" pill on paid-featured products, on each card renderer the
// storefront uses: browse cards (home/search/tips/similar), the store page's
// full card, and the categories tile. product.featured comes from
// markPaidFeatured (Featuring.gs) - tested in test-featuring.js.
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
  ok('tips: featured product shows the pill', tips.find((t) => /Rice/.test(t.name)).badge === true, JSON.stringify(tips));
  ok('tips: other product does not', tips.find((t) => /Flour/.test(t.name)).badge === false);
  const style = await page.$eval('.featured-badge', (b) => ({ text: b.textContent, w: b.getBoundingClientRect().width, fs: getComputedStyle(b).fontSize }));
  ok('pill says "Featured" and stays small', style.text === 'Featured' && style.w < 90 && parseFloat(style.fs) <= 12, JSON.stringify(style));
  await page.screenshot({ path: process.env.SHOT || '/dev/null', fullPage: false }).catch(() => {});

  // Store page full card.
  await page.goto(BASE + '/store.html?store=s', { waitUntil: 'load' });
  await page.waitForFunction(() => typeof renderProductCard === 'function', null, { timeout: 6000 });
  const store = await page.evaluate(([a, b]) => [renderProductCard(a, { storeSlug: 's' }), renderProductCard(b, { storeSlug: 's' })]
    .map((h) => h.includes('featured-badge')), [P(true), P(false)]);
  ok('store page card: pill only on the featured product', store[0] === true && store[1] === false, JSON.stringify(store));

  // Categories tile.
  await page.goto(BASE + '/categories.html', { waitUntil: 'load' });
  await page.waitForFunction(() => typeof renderCategoryTile === 'function', null, { timeout: 6000 });
  const tiles = await page.evaluate(([a, b]) => [renderCategoryTile(a), renderCategoryTile(b)].map((h) => h.includes('featured-badge')), [P(true), P(false)]);
  ok('categories tile: pill only on the featured product', tiles[0] === true && tiles[1] === false, JSON.stringify(tiles));
  ok('a product with no featured field (old cache) shows no pill', await page.evaluate(() => featuredBadgeHtml({ name: 'x' }) === ''));
  ok('no page errors', errors.length === 0, errors.join('; '));

  await browser.close();
  let f = 0; console.log('\n--- "Featured" pill on product cards ---');
  for (const [s, n, e] of R) { if (s === 'FAIL') f++; console.log(`${s}  ${n}${e ? '  [' + e + ']' : ''}`); }
  console.log(`\n${R.length - f}/${R.length} passed`);
  process.exit(f ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
