// Browse-by-category page, the nav swap, and the header cart button.
const fs = require('fs');
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = 'http://127.0.0.1:8099';
const REPO = '/home/user/simple-kiri-shop/';
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e || '']);

// The new taxonomy's ids. 'rentals' is gone entirely - it became a listing
// type, not a category. 'handicrafts' sits next to 'agriculture' on purpose.
const CATS = ['food', 'fashion', 'electronics', 'home', 'building', 'vehicles',
  'fishing', 'agriculture', 'handicrafts', 'property', 'services', 'education', 'events', 'other'];
const mk = (cat, i) => ({
  productId: `${cat}-${i}`, name: `${cat} item ${i}`, category: cat, description: 'x',
  imageUrl: '', storeSlug: 'bong', storeName: 'Bong Store', island: 'South Tarawa', village: 'Bairiki',
  variants: [{ variantId: `v${cat}${i}`, label: '1kg', price: 5 + i }],
  rating: null, reviewCount: 0, views: i, createdAt: '2026-01-01'
});
// fashion has enough to page; services has none. Keyed by the NEW ids - keyed
// by the old ones, the first rail category returned nothing and the page
// rendered no tiles at all.
const BY_CAT = { food: 3, fashion: 20, home: 5, electronics: 2, vehicles: 1, services: 0 };
const line = { variantId: 'v1', productId: 'p1', label: 'Rice', unitPrice: 6, qty: 2 };

async function open(browser, path, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const asked = [];
  await ctx.route('**/macros/s/**', async (r) => {
    let a = ''; let cat = null;
    try { const u = new URL(r.request().url()); a = u.searchParams.get('action') || ''; cat = u.searchParams.get('category'); } catch (e) {}
    try { const j = r.request().postDataJSON(); if (!a && j) a = j.action; } catch (e) {}
    if (a === 'searchProducts') asked.push(cat);
    if (opts.delay) await new Promise((x) => setTimeout(x, opts.delay));
    const J = (o) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
    if (a === 'searchProducts') {
      if (opts.fail) return J({ ok: false, error: 'Boom' });
      const n = BY_CAT[cat] != null ? BY_CAT[cat] : 0;
      return J({ ok: true, products: Array.from({ length: n }, (_, i) => mk(cat, i)) });
    }
    if (a === 'listStores') return J({ ok: true, stores: [], hasMore: false, total: 0 });
    if (a === 'getHomePageData') return J({ ok: true, products: [], stores: [] });
    J({ ok: true });
  });
  const page = await ctx.newPage();
  await page.addInitScript((c) => {
    localStorage.setItem('skiri_cookie_consent', 'true');
    // Two stores: one with two lines of qty 2, one with a single line of qty 2.
    // The badge counts ITEMS, not lines or carts, so the answer is 6.
    if (c) { localStorage.setItem('skiri_cart_bong', JSON.stringify([c, c])); localStorage.setItem('skiri_cart_other', JSON.stringify([c])); }
  }, opts.seedCarts ? line : null);
  await page.goto(BASE + path, { waitUntil: 'load' });
  await page.waitForTimeout(opts.settle || 900);
  return { ctx, page, asked };
}

const railState = (page) => page.evaluate(() => ({
  items: [...document.querySelectorAll('.category-rail-item')].map((b) => b.dataset.category),
  labels: [...document.querySelectorAll('.category-rail-label')].map((s) => s.textContent),
  selected: (document.querySelector('.category-rail-item.is-selected') || {}).dataset?.category || null,
  pressed: [...document.querySelectorAll('.category-rail-item[aria-pressed="true"]')].length,
  // Geometry, not colour. The original bug was a chip inflating to fill the
  // rail and pushing labels out over the products - a colour assertion passes
  // happily through that, which is exactly what happened.
  railRight: Math.round(document.getElementById('category-rail').getBoundingClientRect().right),
  overflowing: [...document.querySelectorAll('#category-rail *')].filter((e) => {
    const r = e.getBoundingClientRect();
    const rail = document.getElementById('category-rail').getBoundingClientRect();
    return r.right > rail.right + 1 || r.left < rail.left - 1;
  }).map((e) => e.className),
  swatches: document.querySelectorAll('#category-rail .placeholder-swatch').length,
  cols: getComputedStyle(document.getElementById('category-list')).gridTemplateColumns.split(' ').length,
  tileText: (document.querySelector('.category-tile') || {}).textContent || '',
  tileCount: document.querySelectorAll('.category-tile').length,
  heading: document.getElementById('category-pane-heading').textContent,
  cards: document.querySelectorAll('#category-list .category-tile').length,
  status: document.getElementById('category-status').textContent,
  moreHidden: document.getElementById('category-more').hidden,
  url: location.search
}));

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

  /* --- rail --- */
  let { ctx, page, asked } = await open(browser, '/categories.html');
  let s = await railState(page);
  ok('rail lists every active category in display order', s.items.join(',') === CATS.join(','), s.items.join(','));
  ok('rail labels come from the shared taxonomy',
    s.labels[0] === 'Food & Groceries' && s.labels[s.labels.length - 1] === 'Other', s.labels.join('|'));
  ok('the rail is every category plus Other', s.labels.length === CATS.length, String(s.labels.length));
  ok('no retired category is offered',
    !s.items.some((id) => ['pantry', 'clothing', 'household', 'rentals', 'general'].includes(id)), s.items.join(','));
  ok('no rail content escapes the rail', s.overflowing.length === 0, s.overflowing.join(' | '));
  ok('rail carries no .placeholder-swatch (the class that broke it)', s.swatches === 0, String(s.swatches));
  ok('three tiles across on a phone', s.cols === 3, String(s.cols));
  ok('first category selected by default', s.selected === 'food', String(s.selected));
  ok('exactly one entry is aria-pressed', s.pressed === 1, String(s.pressed));
  ok('only the selected category was fetched', asked.join(',') === 'food', asked.join(','));
  ok('pane heading names the category', s.heading === 'Food & Groceries', s.heading);
  ok('pane shows that category\'s products', s.cards === 3, String(s.cards));
  ok('a tile carries the product name', /food item 0/.test(s.tileText), s.tileText);
  ok('a tile carries no price', !/\$/.test(s.tileText), s.tileText);
  ok('a tile carries no store name or phone',
    !/Bong Store/.test(s.tileText) && !/7300/.test(s.tileText), s.tileText);
  ok('a tile carries no delivery icons',
    await page.evaluate(() => !document.querySelector('.category-tile .delivery-icons')));
  const tileHref = await page.evaluate(() =>
    (document.querySelector('.category-tile') || {}).getAttribute('href') || '');
  ok('a tile links to the product page with store and product',
    /^product\.html\?store=bong&product=food-0$/.test(tileHref), tileHref);

  /* --- switching --- */
  await page.click('.category-rail-item[data-category="home"]');
  await page.waitForTimeout(700);
  s = await railState(page);
  ok('switching selects the new category', s.selected === 'home', String(s.selected));
  ok('switching swaps the products', s.cards === 5, String(s.cards));
  ok('switching updates the URL', s.url === '?category=home', s.url);
  ok('switching is not a page load', await page.evaluate(() => !!window.__criticalReady));
  ok('a second category was fetched', asked.join(',') === 'food,home', asked.join(','));

  // Going back to one already seen must not re-hit the backend.
  await page.click('.category-rail-item[data-category="food"]');
  await page.waitForTimeout(400);
  ok('a revisited category is served from memory', asked.join(',') === 'food,home', asked.join(','));
  ok('revisit still renders its products', (await railState(page)).cards === 3);
  await ctx.close();

  /* --- deep link --- */
  ({ ctx, page, asked } = await open(browser, '/categories.html?category=fashion'));
  s = await railState(page);
  ok('deep link selects the requested category', s.selected === 'fashion', String(s.selected));
  ok('deep link fetches only that category', asked.join(',') === 'fashion', asked.join(','));
  ok('paging caps the first page at 12', s.cards === 12, String(s.cards));
  ok('Show More offered when there is more', s.moreHidden === false);
  ok('status reports the split', /Showing 12 of 20 products\./.test(s.status), s.status);
  await page.click('#category-more');
  await page.waitForTimeout(200);
  s = await railState(page);
  ok('Show More reveals the rest', s.cards === 20, String(s.cards));
  ok('Show More hides itself at the end', s.moreHidden === true);
  ok('status drops the split when all are shown', s.status === '20 products.', s.status);
  await ctx.close();

  /* --- unknown slug, empty category, failure --- */
  ({ ctx, page, asked } = await open(browser, '/categories.html?category=not-a-real-category'));
  s = await railState(page);
  ok('unknown slug falls back to the first category', s.selected === 'food', String(s.selected));
  ok('unknown slug still fetches something', asked.join(',') === 'food', asked.join(','));
  await ctx.close();

  ({ ctx, page } = await open(browser, '/categories.html?category=services'));
  s = await railState(page);
  ok('empty category explains itself', /Nothing in this category yet/.test(s.status), s.status);
  ok('empty category renders no cards', s.cards === 0, String(s.cards));
  ok('empty category hides Show More', s.moreHidden === true);
  await ctx.close();

  ({ ctx, page } = await open(browser, '/categories.html', { fail: true }));
  s = await railState(page);
  ok('a failed load says so rather than showing nothing', s.status.length > 0 && !/Loading/.test(s.status), s.status);
  await ctx.close();

  /* --- bottom nav --- */
  ({ ctx, page } = await open(browser, '/index.html'));
  const nav = await page.evaluate(() => ({
    labels: [...document.querySelectorAll('.bottom-nav-label')].map((e) => e.textContent),
    hrefs: [...document.querySelectorAll('.bottom-nav-item')].map((a) => a.getAttribute('href')),
    cartBadge: !!document.querySelector('.bottom-nav-badge[data-badge="cart"]'),
    msgBadge: !!document.querySelector('.bottom-nav-badge[data-badge="messages"]')
  }));
// Cart is back in the 4th slot. Browse lost its permanent tab once the
  // homepage grew a category strip and a "View all categories" link, and Cart
  // is what a shopper reaches for mid-purchase.
  ok('bottom nav is Home/Tips/Messages/Cart/Account',
    nav.labels.join(',') === 'Home,Tips,Messages,Cart,Account', nav.labels.join(','));
  ok('the Cart tab points at the per-store cart list', nav.hrefs[3] === 'my-carts.html', nav.hrefs[3]);
  ok('the Cart tab carries its own count badge', nav.cartBadge === true);
  ok('messages badge untouched', nav.msgBadge === true);
  ok('still five tabs', nav.labels.length === 5, String(nav.labels.length));
  await ctx.close();

  /* --- header cart --- */
  ({ ctx, page } = await open(browser, '/index.html', { seedCarts: true }));
  const hc = await page.evaluate(() => {
    const a = document.getElementById('header-cart-link');
    const b = document.getElementById('header-cart-badge');
    return { present: !!a, href: a && a.getAttribute('href'),
             label: a && a.getAttribute('aria-label'),
             pos: a && getComputedStyle(a).position,
             badge: b && !b.hidden ? b.textContent : null,
             inHeader: !!(a && a.closest('header.site-header')) };
  });
  ok('header cart present', hc.present === true);
  ok('header cart sits inside the site header', hc.inHeader === true);
  // Points at the carts LIST now: carts are per-store, so cart.html alone had
  // no way to know which one was meant.
  ok('header cart links to the carts list', hc.href === 'my-carts.html', String(hc.href));
  ok('header cart is labelled for screen readers', hc.label === 'Your carts', String(hc.label));
  ok('header cart is out of flow (no layout shift)', hc.pos === 'absolute', String(hc.pos));
  ok('badge sums item quantities across per-store carts (4 + 2)', hc.badge === '6', String(hc.badge));
  await ctx.close();

  ({ ctx, page } = await open(browser, '/index.html'));
  const empty = await page.evaluate(() => {
    const b = document.getElementById('header-cart-badge');
    return b ? b.hidden : null;
  });
  ok('badge hidden when every cart is empty', empty === true, String(empty));
  await ctx.close();

  // It has to be on every customer page, or the cart becomes unreachable there.
  for (const p of ['/categories.html', '/search.html?q=x', '/stores.html', '/store.html?store=bong', '/customer-tips.html']) {
    const { ctx: c, page: pg } = await open(browser, p, { seedCarts: true, settle: 700 });
    ok(`header cart present on ${p.split('?')[0]}`, await pg.evaluate(() => !!document.getElementById('header-cart-link')));
    await c.close();
  }

  /* --- static guarantees --- */
  const nav2 = fs.readFileSync(REPO + 'assets/js/bottom-nav.js', 'utf8');
ok('bottom-nav counts the cart locally, with no request',
    nav2.indexOf('updateBottomNavCartBadge') !== -1 &&
    /function updateBottomNavCartBadge\(\)[\s\S]{0,400}totalCartItemCount\(\)/.test(nav2));
  ok('the cart scan lives in helpers', /function totalCartItemCount/.test(fs.readFileSync(REPO + 'assets/js/helpers.js', 'utf8')));
  const sw = fs.readFileSync(REPO + 'sw.js', 'utf8');
  ok('categories.html precached', sw.indexOf("'categories.html'") !== -1);
  ok('categories.js precached', sw.indexOf("'assets/js/categories.js'") !== -1);
  ok('header-cart.js precached', sw.indexOf("'assets/js/header-cart.js'") !== -1);
  // Version-agnostic: pinning a literal means every later release breaks this.
  const swMain = require('child_process')
    .execSync('git -C /home/user/simple-kiri-shop show origin/main:sw.js', { encoding: 'utf8' });
  const ver = (t) => Number((t.match(/var CACHE = 'mwakete-v(\d+)';/) || [])[1]);
  ok('CACHE bumped past main', ver(sw) > ver(swMain), ver(swMain) + ' -> ' + ver(sw));
  const cats = fs.readFileSync(REPO + 'categories.html', 'utf8');
  ok('category page preconnects to the backend', cats.indexOf('preconnect" href="https://script.google.com"') !== -1);
  // The opposite of every other list page, and measured rather than assumed:
  // a 100vh reservation overshoots a grid of small tiles, and releasing it is
  // itself the shift - 0.014 without it, 0.133 with.
  ok('category page does NOT reserve a viewport it cannot fill',
    !/id="category-status"[^>]*is-reserving-space/.test(cats));
  ok('category page has no undeferred script', !/<script src=/.test(cats));

  await browser.close();
  let f = 0;
  console.log('\n--- Browse by category ---');
  for (const [st, n, e] of R) { if (st === 'FAIL') f++; console.log(`${st}  ${n}${e ? '  [' + e + ']' : ''}`); }
  console.log(`\n${R.length - f}/${R.length} passed`);
  process.exit(f ? 1 : 0);
})();
