const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = 'http://127.0.0.1:8099';

const CLD = 'https://res.cloudinary.com/demo/image/upload/v9/prod.jpg';
const DRIVE_LOGO = 'https://lh3.googleusercontent.com/d/LOGOID';

const product = (id, name, imageUrl) => ({
  productId: id, name, storeSlug: 'teststore', storeName: 'Test Store',
  category: 'pantry', variants: [{ variantId: 'v1', label: '1kg', price: 5 }],
  imageUrl, storePhone: '', storeDeliveryTruck: false
});

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const ctx = await browser.newContext({ serviceWorkers: 'block' });

  await ctx.route('**/macros/s/**', (route) => {
    let action = '';
    try {
      const u = new URL(route.request().url());
      action = u.searchParams.get('action') || (route.request().postDataJSON() || {}).action || '';
    } catch (e) {}
    let body = { ok: true };
    if (action === 'getHomePageData') {
      body = { ok: true, products: [product('p1', 'Rice', CLD), product('p2', 'NoPhoto', '')], stores: [{ storeSlug: 'teststore', storeName: 'Test Store', logoUrl: DRIVE_LOGO }] };
    } else if (action === 'searchProducts') {
      body = { ok: true, products: [product('p1', 'Rice', CLD)] };
    } else if (action === 'listProducts') {
      body = { ok: true, storeName: 'Test Store', storeSlug: 'teststore', storeLogoUrl: DRIVE_LOGO, storePhone: '', products: [{ productId: 'p1', name: 'Rice', category: 'pantry', variants: [{ variantId: 'v1', label: '1kg', price: 5 }], imageUrl: CLD }] };
    }
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });

  const results = [];
  const ok = (n, c, e) => results.push([c ? 'PASS' : 'FAIL', n, e || '']);

  // --- Home page ---
  const home = await ctx.newPage();
  await home.goto(BASE + '/index.html', { waitUntil: 'load' });
  await home.waitForSelector('.product-image');
  const homeImg = await home.$eval('.product-image', el => ({ src: el.getAttribute('src'), loading: el.loading, decoding: el.decoding }));
  ok('home product img resized (w_520)', homeImg.src.includes('/image/upload/f_auto,q_auto,c_limit,w_520/'), homeImg.src);
  ok('home product img lazy+async', homeImg.loading === 'lazy' && homeImg.decoding === 'async');
  const homeLogo = await home.$eval('.logo-carousel-logo', el => el.getAttribute('src'));
  ok('home carousel logo resized (=w160)', homeLogo.endsWith('=w160'), homeLogo);
  const swatch = await home.$('.placeholder-swatch');
  ok('no-image product still shows placeholder', !!swatch);
  const pc = await home.$$eval('head link[rel="preconnect"]', els => els.map(e => e.href));
  ok('home preconnect present', pc.some(h => h.includes('res.cloudinary.com')) && pc.some(h => h.includes('lh3.googleusercontent.com')), JSON.stringify(pc));
  await home.close();

  // --- Search page ---
  const search = await ctx.newPage();
  await search.goto(BASE + '/search.html', { waitUntil: 'load' });
  await search.waitForSelector('.product-image');
  const sImg = await search.$eval('.product-image', el => el.getAttribute('src'));
  ok('search product img resized', sImg.includes('c_limit,w_520/'), sImg);
  await search.close();

  // --- Store page ---
  const store = await ctx.newPage();
  await store.goto(BASE + '/store.html?store=teststore', { waitUntil: 'load' });
  await store.waitForSelector('.product-image');
  const stImg = await store.$eval('.product-image', el => ({ src: el.getAttribute('src'), decoding: el.decoding }));
  ok('store product img resized+async', stImg.src.includes('c_limit,w_520/') && stImg.decoding === 'async', stImg.src);
  const stLogo = await store.$eval('#store-logo-img', el => el.getAttribute('src'));
  ok('store header logo resized (=w160)', stLogo.endsWith('=w160'), stLogo);
  await store.close();

  await browser.close();
  console.log('\n--- image optimization verification ---');
  let failed = 0;
  for (const [st, n, e] of results) { if (st === 'FAIL') failed++; console.log(`${st}  ${n}${e ? '  [' + e + ']' : ''}`); }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
