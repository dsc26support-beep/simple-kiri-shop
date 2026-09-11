// "Your Carts": the header cart's destination, per-store rows, and the
// ?store= slug that finally makes cart.html unambiguous.
const fs = require('fs');
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = 'http://127.0.0.1:8099';
const REPO = '/home/user/simple-kiri-shop/';
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e || '']);

const info = (slug) => ({ storeName: 'Store ' + slug.toUpperCase(), storeSlug: slug, phone: '730999',
  messenger: '', logoUrl: 'https://res.cloudinary.com/demo/image/upload/l.jpg', island: 'South Tarawa',
  village: 'Bairiki', isOpen: true, deliveryTruck: true, deliveryShip: false,
  deliveryAirCargo: false, deliveryPickPay: true, deliveryTruckCost: 5,
  deliveryShipCost: null, deliveryAirCargoCost: null });
const ln = (qty, price) => ({ variantId: 'v' + qty, productId: 'p' + qty, label: 'Item', unitPrice: price, qty });

async function open(browser, path, carts, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const asked = [];
  await ctx.route('**/macros/s/**', async (r) => {
    let a = ''; let slug = null;
    try { const u = new URL(r.request().url()); a = u.searchParams.get('action') || ''; slug = u.searchParams.get('storeSlug'); } catch (e) {}
    try { const j = r.request().postDataJSON(); if (!a && j) a = j.action; } catch (e) {}
    if (opts.delay) await new Promise((x) => setTimeout(x, opts.delay));
    const J = (o) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
    if (a === 'getStorePublicInfo') {
      asked.push(slug);
      if ((opts.failSlugs || []).indexOf(slug) !== -1) return J({ ok: false, error: 'Store not found' });
      return J({ ok: true, store: info(slug) });
    }
    if (a === 'listProducts') return J({ ok: true, storeName: 'S', storeOpen: true, products: [] });
    J({ ok: true });
  });
  await ctx.route('**res.cloudinary.com/**', (r) => r.fulfill({ status: 200, contentType: 'image/gif',
    body: Buffer.from('R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==', 'base64') }));
  const page = await ctx.newPage();
  await page.addInitScript((c) => {
    localStorage.setItem('skiri_cookie_consent', 'true');
    Object.keys(c).forEach((k) => localStorage.setItem('skiri_cart_' + k, JSON.stringify(c[k])));
  }, carts);
  await page.goto(BASE + path, { waitUntil: 'load' });
  await page.waitForTimeout(opts.settle || 900);
  return { ctx, page, asked };
}

const rows = (page) => page.evaluate(() => ({
  count: document.querySelectorAll('.my-cart-row').length,
  slugs: [...document.querySelectorAll('.my-cart-row')].map((r) => r.dataset.storeSlug),
  names: [...document.querySelectorAll('.my-cart-name')].map((e) => e.textContent),
  metas: [...document.querySelectorAll('.my-cart-meta')].map((e) => e.textContent),
  viewHrefs: [...document.querySelectorAll('.my-cart-actions a:first-child')].map((a) => a.getAttribute('href')),
  shopHrefs: [...document.querySelectorAll('.my-cart-actions a:last-child')].map((a) => a.getAttribute('href')),
  logos: document.querySelectorAll('img.my-cart-logo').length,
  status: document.getElementById('my-carts-status').textContent,
  url: location.pathname + location.search
}));

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

  /* --- several carts --- */
  // bong: 2x$6 + 1x$10 = 3 items, $22.   tab: 1x$4 = 1 item, $4.
  let { ctx, page, asked } = await open(browser, '/my-carts.html',
    { bong: [ln(2, 6), ln(1, 10)], tab: [ln(1, 4)] });
  let s = await rows(page);
  ok('a row per cart store', s.count === 2, String(s.count));
  ok('both cart stores listed', s.slugs.sort().join(',') === 'bong,tab', s.slugs.join(','));
  ok('item count and subtotal are shown', s.metas.some((m) => /3 items · \$22\.00/.test(m)), s.metas.join(' | '));
  ok('singular item is not pluralised', s.metas.some((m) => /1 item · \$4\.00/.test(m)), s.metas.join(' | '));
  ok('real store names replace the slug', s.names.every((n) => /^Store /.test(n)), s.names.join(','));
  ok('store logos hydrate in', s.logos === 2, String(s.logos));
  ok('View Cart names the store', s.viewHrefs.includes('cart.html?store=bong'), s.viewHrefs.join(','));
  ok('Keep Shopping goes to that store', s.shopHrefs.includes('store.html?store=bong'), s.shopHrefs.join(','));
  ok('two actions on every row', s.viewHrefs.length === 2 && s.shopHrefs.length === 2);
  ok('status counts the stores', /carts with 2 stores/.test(s.status), s.status);
  ok('one lookup per cart store', asked.sort().join(',') === 'bong,tab', asked.join(','));
  await ctx.close();

  /* --- exactly one cart: skip the list --- */
  ({ ctx, page } = await open(browser, '/my-carts.html', { bong: [ln(2, 6)] }));
  // We are on cart.html now, so read the location rather than the list markup.
  const landed = await page.evaluate(() => ({ path: location.pathname, search: location.search,
    onList: !!document.getElementById('my-carts-status') }));
  ok('a single cart skips the list entirely', /cart\.html$/.test(landed.path) && landed.onList === false, landed.path);
  ok('the single-cart redirect names the store', landed.search === '?store=bong', landed.search);
  await ctx.close();

  /* --- no carts --- */
  ({ ctx, page, asked } = await open(browser, '/my-carts.html', {}));
  const empty = await page.evaluate(() => ({
    text: document.querySelector('.empty-state') ? document.querySelector('.empty-state').textContent : null,
    cta: document.querySelector('.empty-state a') ? document.querySelector('.empty-state a').getAttribute('href') : null,
    rows: document.querySelectorAll('.my-cart-row').length
  }));
  ok('no carts shows an empty state', /no carts yet/i.test(empty.text || ''), String(empty.text));
  ok('empty state offers a way out', empty.cta === 'categories.html', String(empty.cta));
  ok('no carts means no rows', empty.rows === 0);
  ok('no carts issues no lookups', asked.length === 0, asked.join(','));
  await ctx.close();

  /* --- an empty cart array is not a cart --- */
  ({ ctx, page } = await open(browser, '/my-carts.html', { bong: [], tab: [] }));
  ok('emptied carts do not count as carts',
    await page.evaluate(() => !!document.querySelector('.empty-state')));
  await ctx.close();

  /* --- a failed lookup must not lose the row or the cart --- */
  ({ ctx, page } = await open(browser, '/my-carts.html',
    { bong: [ln(2, 6)], tab: [ln(1, 4)] }, { failSlugs: ['tab'] }));
  s = await rows(page);
  ok('failed lookup keeps its row', s.count === 2, String(s.count));
  ok('failed lookup falls back to the slug', s.names.includes('tab'), s.names.join(','));
  ok('failed lookup keeps its actions working', s.viewHrefs.includes('cart.html?store=tab'), s.viewHrefs.join(','));
  const kept = await page.evaluate(() => localStorage.getItem('skiri_cart_tab'));
  ok('failed lookup does NOT clear the cart', !!kept && JSON.parse(kept).length === 1, String(kept));
  await ctx.close();

  /* --- cart.html?store= is what makes the rows honest --- */
  ({ ctx, page } = await open(browser, '/cart.html?store=tab', { bong: [ln(2, 6)], tab: [ln(1, 4)] }));
  const shown = await page.evaluate(() => ({
    tagline: document.getElementById('store-name-tagline').textContent,
    active: localStorage.getItem('skiri_active_store'),
    lines: document.querySelectorAll('#cart-items .cart-line, #cart-items [data-variant-id]').length
  }));
  ok('cart.html?store= opens THAT store, not the last one', /TAB/.test(shown.tagline), shown.tagline);
  ok('cart.html?store= updates the remembered store for checkout', shown.active === 'tab', String(shown.active));
  await ctx.close();

  // Without a param it must still behave exactly as before.
  ({ ctx, page } = await open(browser, '/cart.html', { bong: [ln(2, 6)] }, { settle: 700 }));
  await page.evaluate(() => localStorage.setItem('skiri_active_store', 'bong'));
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(700);
  ok('cart.html with no param still uses the remembered store',
    /BONG/.test(await page.evaluate(() => document.getElementById('store-name-tagline').textContent)),
    await page.evaluate(() => document.getElementById('store-name-tagline').textContent));
  await ctx.close();

  /* --- header button --- */
  ({ ctx, page } = await open(browser, '/index.html', { bong: [ln(2, 6)], tab: [ln(1, 4)] }));
  const hc = await page.evaluate(() => {
    const a = document.getElementById('header-cart-link');
    const b = document.getElementById('header-cart-badge');
    return { href: a && a.getAttribute('href'), label: a && a.getAttribute('aria-label'),
             badge: b && !b.hidden ? b.textContent : null };
  });
  ok('header cart points at the carts list', hc.href === 'my-carts.html', String(hc.href));
  ok('header cart is relabelled', hc.label === 'Your carts', String(hc.label));
  // bong holds one line of qty 2, tab one line of qty 1 - the badge counts
  // ITEMS across every store's cart, so 3.
  ok('header badge sums item quantities across every cart (2 + 1)', hc.badge === '3', String(hc.badge));
  await ctx.close();

  /* --- static --- */
  const sw = fs.readFileSync(REPO + 'sw.js', 'utf8');
  ok('my-carts.html precached', sw.indexOf("'my-carts.html'") !== -1);
  ok('my-carts.js precached', /'assets\/js\/my-carts(\.min)?\.js'/.test(sw));
  // Version-agnostic: pinning a literal breaks on every later release.
  const swMain = require('child_process')
    .execSync('git -C /home/user/simple-kiri-shop show origin/main:sw.js', { encoding: 'utf8' });
  const ver = (t) => Number((t.match(/var CACHE = 'mwakete-v(\d+)';/) || [])[1]);
  // The bump is only OWED when the frontend actually differs from main. Written
  // as an unconditional "must be ahead", this fired the moment the branch
  // merged - tree and main both at v27, nothing left to bump - which is a
  // false alarm, not a regression. Same shape as the APP_VERSION guard in
  // test-publicstore.js.
  const frontendChanged = require('child_process')
    .execSync("git -C /home/user/simple-kiri-shop diff --name-only origin/main -- '*.html' '*.css' '*.js'",
      { encoding: 'utf8' })
    .split('\n').filter(Boolean);
  ok(frontendChanged.length ? 'CACHE bumped, because frontend files differ from main'
                            : 'no CACHE bump owed - frontend matches main',
    frontendChanged.length === 0 || ver(sw) > ver(swMain),
    frontendChanged.length + ' changed | v' + ver(swMain) + ' -> v' + ver(sw));
  const helpers = fs.readFileSync(REPO + 'assets/js/helpers.js', 'utf8');
  ok('cartStoreSlugs consolidated into helpers', /function cartStoreSlugs/.test(helpers));
  ok('directory.js no longer defines its own copy',
    !/function cartStoreSlugs/.test(fs.readFileSync(REPO + 'assets/js/directory.js', 'utf8')));
  const mc = fs.readFileSync(REPO + 'my-carts.html', 'utf8');
  ok('page preconnects to the backend', mc.indexOf('preconnect" href="https://script.google.com"') !== -1);
  ok('page has no undeferred script', !/<script src=/.test(mc));

  await browser.close();
  let f = 0;
  console.log('\n--- Your Carts ---');
  for (const [st, n, e] of R) { if (st === 'FAIL') f++; console.log(`${st}  ${n}${e ? '  [' + e + ']' : ''}`); }
  console.log(`\n${R.length - f}/${R.length} passed`);
  process.exit(f ? 1 : 0);
})();
