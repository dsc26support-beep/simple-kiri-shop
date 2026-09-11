// The behaviours the performance work must NOT have broken, plus the ones it
// was supposed to change. Real files over http.server; the API is mocked with
// a delay so ordering is observable.
const fs = require('fs');
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = 'http://127.0.0.1:8099';
const REPO = '/home/user/simple-kiri-shop/';
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e || '']);
const API_DELAY = 400;

const PRODUCTS = [{ productId: 'p1', name: 'Rice', category: 'pantry', description: 'x',
  imageUrl: 'https://res.cloudinary.com/demo/image/upload/sample.jpg', storeSlug: 'bong',
  storeName: 'Bong Store', island: 'South Tarawa', village: 'Bairiki',
  variants: [{ variantId: 'v1', label: '1kg', price: 6 }], rating: null, reviewCount: 0 }];
const STORE = { storeName: 'Bong Store', storeSlug: 'bong', phone: '73001224', messenger: '',
  logoUrl: 'https://res.cloudinary.com/demo/image/upload/logo.jpg', island: 'South Tarawa',
  village: 'Bairiki', isOpen: true, deliveryTruck: true, deliveryShip: true,
  deliveryAirCargo: false, deliveryPickPay: true, deliveryTruckCost: 5,
  deliveryShipCost: null, deliveryAirCargoCost: null };
const CART = [{ variantId: 'v1', productId: 'p1', label: 'Rice 1kg', unitPrice: 6, qty: 2 }];

async function open(browser, path, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const calls = [];
  await ctx.route('**/macros/s/**', async (r) => {
    let a = ''; let b = null;
    try { a = new URL(r.request().url()).searchParams.get('action') || ''; } catch (e) {}
    try { b = r.request().postDataJSON(); if (!a && b) a = b.action; } catch (e) {}
    calls.push(a);
    await new Promise((x) => setTimeout(x, API_DELAY));
    const J = (o) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
    if (a === 'listProducts') return J({ ok: true, storeName: 'Bong Store', storePhone: '73001224',
      storeLogoUrl: 'https://res.cloudinary.com/demo/image/upload/logo.jpg', storeOpen: true, products: PRODUCTS });
    if (a === 'getStorePublicInfo') return J({ ok: true, store: STORE });
    if (a === 'getHomePageData') return J({ ok: true, products: PRODUCTS, stores: [] });
    if (a === 'getConversation') return J({ ok: true, conversation: null, messages: [], hasMoreBefore: false });
    if (a === 'getCustomerInbox') return J({ ok: true, conversations: [] });
    if (a === 'searchProducts') return J({ ok: true, products: PRODUCTS, hasMore: false, total: 1 });
    if (a === 'listProductReviews') return J({ ok: true, reviews: [], average: null, count: 0, distribution: [0,0,0,0,0] });
    J({ ok: true });
  });
  await ctx.route('**res.cloudinary.com/**', (r) => r.fulfill({ status: 200, contentType: 'image/gif',
    body: Buffer.from('R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==', 'base64') }));
  const page = await ctx.newPage();
  await page.addInitScript((cart) => {
    localStorage.setItem('skiri_cookie_consent', 'true');
    localStorage.setItem('skiri_active_store', 'bong');
    localStorage.setItem('skiri_cart_bong', JSON.stringify(cart));
    if (window.__seedChat) localStorage.setItem('skiri_chat_token_bong', 'tok');
  }, CART);
  if (opts.chatted) await page.addInitScript(() => { localStorage.setItem('skiri_chat_token_bong', 'tok'); });
  await page.goto(BASE + path, { waitUntil: 'load' });
  await page.waitForTimeout(opts.settle || 2200);
  return { ctx, page, calls };
}

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

  /* --- The render-critical request must go first, and alone --- */
  let { ctx, page, calls } = await open(browser, '/store.html?store=bong', { chatted: true });
  ok('store: listProducts is the first request', calls[0] === 'listProducts', calls.join(','));
  ok('store: chat no longer duplicates the store lookup',
    calls.filter((c) => c === 'getStorePublicInfo').length === 0, calls.join(','));
  ok('store: products still render', await page.evaluate(() => !!document.querySelector('.product-card, .product-item, [data-product-id]')));
  // The deferred work must still actually happen.
  ok('store: unread check still ran (deferred)', calls.indexOf('getConversation') !== -1, calls.join(','));
  ok('store: store-visit beacon still ran (deferred)', calls.indexOf('recordStoreVisit') !== -1, calls.join(','));
  ok('store: inbox badge still ran (deferred)', calls.indexOf('getCustomerInbox') !== -1, calls.join(','));
  // Chat header must still be populated - now from the page's own fetch.
  const chat = await page.evaluate(async () => {
    const f = document.getElementById('chat-fab'); if (f) f.click();
    await new Promise((r) => setTimeout(r, 300));
    return { name: (document.getElementById('chat-window-vendor-name') || {}).textContent || '',
             avatar: !!document.querySelector('img.chat-vendor-avatar'),
             status: (document.querySelector('.chat-vendor-status') || {}).textContent || '' };
  });
  ok('store: chat header name came from the page fetch', chat.name === 'Bong Store', chat.name);
  ok('store: chat header logo rendered', chat.avatar === true);
  ok('store: chat availability still Online', chat.status.trim() === 'Online', chat.status);
  await ctx.close();

  /* --- cart/checkout: the duplicate getStorePublicInfo is gone --- */
  for (const path of ['/cart.html', '/checkout.html']) {
    ({ ctx, page, calls } = await open(browser, path, { chatted: true }));
    ok(`${path}: getStorePublicInfo fetched exactly once`,
      calls.filter((c) => c === 'getStorePublicInfo').length === 1, calls.join(','));
    ok(`${path}: it is the first request`, calls[0] === 'getStorePublicInfo', calls.join(','));
    const nm = await page.evaluate(async () => {
      const f = document.getElementById('chat-fab'); if (f) f.click();
      await new Promise((r) => setTimeout(r, 300));
      return (document.getElementById('chat-window-vendor-name') || {}).textContent || '';
    });
    ok(`${path}: chat header still names the store`, nm === 'Bong Store', nm);
    await ctx.close();
  }

  /* --- chat-window still works standalone (no page publishes store info) --- */
  {
    const c = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const seen = [];
    await c.route('**/macros/s/**', async (r) => {
      let a = ''; try { a = new URL(r.request().url()).searchParams.get('action') || ''; } catch (e) {}
      try { const j = r.request().postDataJSON(); if (!a && j) a = j.action; } catch (e) {}
      seen.push(a);
      const J = (o) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
      if (a === 'getStorePublicInfo') return J({ ok: true, store: STORE });
      if (a === 'getConversation') return J({ ok: true, conversation: null, messages: [], hasMoreBefore: false });
      J({ ok: true });
    });
    // Stub out the host page's own script entirely, so nothing publishes
    // __storeInfoPromise and chat-window.js is genuinely on its own - which is
    // the case its header comment promises still works.
    // Matches the built copy too - the page loads store.min.js, and without
    // the glob covering it the real script runs, publishes __storeInfoPromise,
    // and the fallback this block exists to test never fires.
    await c.route(/assets\/js\/store(\.min)?\.js/, (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: '' }));
    const p = await c.newPage();
    await p.goto(BASE + '/store.html?store=bong');
    await p.waitForTimeout(1500);
    ok('chat falls back to its own fetch when no page publishes one',
      seen.indexOf('getStorePublicInfo') !== -1, seen.join(','));
    await c.close();
  }

  /* --- Service worker: second visit renders with the network down --- */
  {
    const c = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await c.route('**/macros/s/**', (r) => r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ ok: true, products: PRODUCTS, stores: [], storeName: 'Bong Store', storeOpen: true }) }));
    const p = await c.newPage();
    await p.goto(BASE + '/index.html', { waitUntil: 'load' });
    await p.evaluate(() => navigator.serviceWorker.ready);
    await p.waitForTimeout(1500); // let install() finish precaching
    const controlled = await p.evaluate(() => !!navigator.serviceWorker.controller);
    ok('service worker took control', controlled);
    const cached = await p.evaluate(async () => {
      const keys = await caches.keys();
      const c = await caches.open(keys.find((k) => k.startsWith('mwakete-v')) || keys[0]);
      const reqs = await c.keys();
      return reqs.map((r) => new URL(r.url).pathname);
    });
    for (const want of ['/store.html', '/assets/js/store.js', '/checkout.html', '/assets/js/chat-window.js']) {
      const alt = want.replace(/\.js$/, '.min.js');
      ok(`precached ${want}`, cached.some((u) => u.endsWith(want) || u.endsWith(alt)), '');
    }
    await c.setOffline(true);
    const resp = await p.goto(BASE + '/store.html?store=bong', { waitUntil: 'domcontentloaded' }).catch(() => null);
    const shell = await p.evaluate(() => !!document.getElementById('products-status'));
    ok('offline navigation to an unvisited page still renders the shell', !!resp && shell);
    await c.setOffline(false);
    await c.close();
  }

  /* --- Static guarantees --- */
  const pages = fs.readdirSync(REPO).filter((f) => f.endsWith('.html') && f !== 'offline.html');
  const missingPre = pages.filter((f) => !fs.readFileSync(REPO + f, 'utf8').includes('preconnect" href="https://script.google.com"'));
  ok('every customer page preconnects to the backend', missingPre.length === 0, missingPre.join(','));
  const allHtml = pages.concat(fs.readdirSync(REPO + 'owner').filter((f) => f.endsWith('.html')).map((f) => 'owner/' + f));
  const undeferred = allHtml.filter((f) => /<script src=/.test(fs.readFileSync(REPO + f, 'utf8')));
  ok('no undeferred <script src> left', undeferred.length === 0, undeferred.join(','));
  const sw = fs.readFileSync(REPO + 'sw.js', 'utf8');
  const swMain = require('child_process')
    .execSync('git -C /home/user/simple-kiri-shop show origin/main:sw.js', { encoding: 'utf8' });
  const ver = (t) => (t.match(/var CACHE = 'mwakete-v(\d+)';/) || [])[1];
  // The bump is only OWED when the frontend actually differs from main. Written
  // as an unconditional "must be ahead", this fired the moment the branch
  // merged - tree and main both at v27, nothing left to bump - which is a
  // false alarm, not a regression. Same shape as the APP_VERSION guard in
  // test-publicstore.js.
  const frontendChanged = require('child_process')
    .execSync("git -C /home/user/simple-kiri-shop diff --name-only origin/main -- '*.html' '*.css' '*.js'",
      { encoding: 'utf8' })
    .split('\n').filter(Boolean);
  ok(frontendChanged.length ? 'sw CACHE bumped, because frontend files differ from main'
                            : 'no sw CACHE bump owed - frontend matches main',
    frontendChanged.length === 0 || Number(ver(sw)) > Number(ver(swMain)),
    frontendChanged.length + ' changed | v' + ver(swMain) + ' -> v' + ver(sw));
  ok('sw never caches the backend', sw.indexOf("origin !== self.location.origin") !== -1);
  const helpers = fs.readFileSync(REPO + 'assets/js/helpers.js', 'utf8');
  ok('whenIdle waits on the critical request', /__criticalReady/.test(helpers));
  const navPages = allHtml.filter((f) => fs.readFileSync(REPO + f, 'utf8').includes('bottom-nav.js'));
  const noClass = navPages.filter((f) => !/<body class="[^"]*has-bottom-nav/.test(fs.readFileSync(REPO + f, 'utf8')));
  ok('bottom-nav space reserved in markup on every page that injects it', noClass.length === 0, noClass.join(','));

  await browser.close();
  let f = 0;
  console.log('\n--- Mobile performance ---');
  for (const [s, n, e] of R) { if (s === 'FAIL') f++; console.log(`${s}  ${n}${e ? '  [' + e + ']' : ''}`); }
  console.log(`\n${R.length - f}/${R.length} passed`);
  process.exit(f ? 1 : 0);
})();
