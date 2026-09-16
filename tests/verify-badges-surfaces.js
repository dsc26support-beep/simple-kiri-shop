/**
 * Badges on the customer-facing surfaces: cards, storefront, product page,
 * directory, tips.
 *
 * THE ASSERTIONS THAT MATTER MOST
 *
 * 1. NO <button> INSIDE A CARD. Every product and store card is a single <a>.
 *    A <button> in one is invalid HTML and navigates instead of explaining, so
 *    card badges are read-only and the page carries one legend panel instead.
 *    Asserted on every card surface, because this is the rule a later "just
 *    make them tappable everywhere" change would quietly break.
 *
 * 2. A SELLER WITH NO BADGES CHANGES NOTHING. Most sellers on a young
 *    marketplace have earned nothing yet. Their cards must be byte-for-byte the
 *    cards that existed before this feature - no empty row, no stray margin, no
 *    legend panel explaining badges that are not there.
 *
 * 3. THE STORE BADGES ARE NOT IN THE HEADER. The branding block sits above
 *    <main>, so anything added to it after the fetch pushes the whole page
 *    down - this page once measured 0.853 CLS from exactly that. Asserted
 *    structurally AND by measuring CLS.
 *
 * 4. THE PAGE DOES NOT SCROLL SIDEWAYS. Badge rows on a 390px phone wrap; they
 *    do not widen the page.
 */
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const fs = require('fs');
const BASE = process.env.AUDIT_BASE || 'http://127.0.0.1:8099';
const REPO = '/home/user/simple-kiri-shop/';
let pass = 0, fail = 0;
const ok = (n, c, e) => {
  if (c) { pass++; console.log('PASS  ' + n + (e ? '  [' + e + ']' : '')); }
  else { fail++; console.log('FAIL  ' + n + (e ? '  [' + e + ']' : '')); }
};

const prod = (i, badges) => ({
  productId: 'p' + i, name: 'Solar Lamp ' + i, description: 'Bright', category: 'food',
  status: 'active', imageUrl: '', listingType: 'product',
  storeSlug: 'bong', storeName: 'Bong Store', storeIsland: 'South Tarawa', storeVillage: 'Bairiki',
  variants: [{ variantId: 'v' + i, label: 'One', price: 25, status: 'active' }],
  rating: 4.5, reviewCount: 6, views: 10, sellerBadges: badges
});
const store = (i, badges) => ({
  storeSlug: 's' + i, storeName: 'Store ' + i, phone: '7301000' + i,
  island: 'South Tarawa', village: 'Bairiki', logoUrl: '', visits: i, sellerBadges: badges
});

/** opts.badges false => every seller earns nothing, the common case today. */
async function open(browser, url, opts) {
  opts = opts || {};
  const on = opts.badges !== false;
  const B1 = on ? ['recommended', 'verified', 'delivery', 'new'] : undefined;
  const B2 = on ? ['top', 'responsive'] : undefined;
  const ctx = await browser.newContext({ viewport: { width: opts.width || 390, height: 900 } });
  await ctx.route('**/macros/s/**', async (route) => {
    const a = new URL(route.request().url()).searchParams.get('action');
    if (opts.latency) await new Promise((r) => setTimeout(r, opts.latency));
    const products = [prod(1, B1), prod(2, B2), prod(3, undefined)];
    let body = { ok: true };
    if (a === 'getHomePageData') body = { ok: true, products: products, stores: [store(1, B2), store(2, undefined)] };
    else if (a === 'searchProducts') body = { ok: true, products: products };
    else if (a === 'listStores') body = { ok: true, stores: [store(1, B1), store(2, undefined)], total: 2, hasMore: false };
    else if (a === 'listProducts') {
      body = { ok: true, products: products, storeName: 'Bong Store', storeOpen: true,
               storeIsland: 'South Tarawa', storeVillage: 'Bairiki' };
      if (on) body.sellerBadges = ['recommended', 'verified', 'delivery', 'responsive'];
    } else if (a === 'listProductReviews') body = { ok: true, reviews: [], count: 0, average: 0 };
    else if (a === 'getTips') body = { ok: true, products: products.slice(0, 2), stores: [store(1, B2)] };
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  await page.addInitScript(() => { try { localStorage.setItem('skiri_cookie_consent', 'true'); } catch (e) {} });
  await page.goto(BASE + url, { waitUntil: 'load' });
  await page.waitForTimeout((opts.latency || 0) * 3 + 1600);
  return { ctx, page, errs };
}

const snap = (page) => page.evaluate(() => ({
  badgeRows: document.querySelectorAll('.seller-badges').length,
  badges: document.querySelectorAll('.seller-badge').length,
  labels: Array.from(document.querySelectorAll('.seller-badge-label')).map((e) => e.textContent.trim()),
  buttonsInLinks: document.querySelectorAll('a button').length,
  buttonsInCards: document.querySelectorAll('.product-card button, .store-card button').length,
  legend: document.querySelectorAll('.badge-legend-panel').length,
  overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
  headerBadges: document.querySelectorAll('.store-branding .seller-badge').length
}));

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

  /* ---------- the card surfaces ---------- */
  for (const [name, url] of [['home', '/index.html'], ['search', '/categories.html?category=food'],
                             ['directory', '/stores.html'], ['tips', '/customer-tips.html']]) {
    const { ctx, page, errs } = await open(browser, url);
    const r = await snap(page);
    ok(name + ': no JS errors', errs.length === 0, errs.join(' | '));
    ok(name + ': cards carry badges', r.badges > 0, String(r.badges));
    ok(name + ': NO button inside a link - a card is an <a>, and a button in one navigates',
      r.buttonsInLinks === 0 && r.buttonsInCards === 0, r.buttonsInLinks + '/' + r.buttonsInCards);
    ok(name + ': the page explains them once', r.legend === 1, String(r.legend));
    ok(name + ': and does not scroll sideways at 390px', !r.overflow);
    await ctx.close();
  }

  /* ---------- a seller with nothing changes nothing ---------- */
  for (const [name, url] of [['home', '/index.html'], ['search', '/categories.html?category=food'],
                             ['directory', '/stores.html'], ['tips', '/customer-tips.html'],
                             ['storefront', '/store.html?store=bong'],
                             ['product page', '/product.html?store=bong&product=p1']]) {
    const { ctx, page, errs } = await open(browser, url, { badges: false });
    const r = await snap(page);
    ok(name + ' with no badges anywhere: renders NO badge markup at all',
      r.badges === 0 && r.badgeRows === 0, r.badges + '/' + r.badgeRows);
    ok(name + ' with no badges anywhere: and no panel explaining badges that are not there',
      r.legend === 0, String(r.legend));
    ok(name + ' with no badges anywhere: still no JS errors', errs.length === 0, errs.join(' | '));
    await ctx.close();
  }

  /* ---------- priority and the cap ---------- */
  {
    const { ctx, page } = await open(browser, '/index.html');
    const cards = await page.evaluate(() =>
      Array.from(document.querySelectorAll('#trending-products-list .product-card')).map((c) => ({
        labels: Array.from(c.querySelectorAll('.seller-badge-label')).map((e) => e.textContent.trim()),
        more: (c.querySelector('.seller-badge--more') || {}).getAttribute
          ? c.querySelector('.seller-badge--more').getAttribute('aria-label') : null
      })));
    ok('a card shows the HIGHEST-priority badges first, not the first ones sent',
      cards[0].labels[0] === 'Mwakete Recommended' && cards[0].labels[1] === 'Verified Seller',
      cards[0].labels.join(' | '));
    ok('and caps a dense card at two plus a counter',
      cards[0].labels.length === 3 && cards[0].labels[2] === '+2', cards[0].labels.join(' | '));
    ok('the counter names what is behind it for a screen reader',
      /2 more seller badges: Reliable Delivery, New Seller/.test(cards[0].more || ''), cards[0].more);
    ok('a seller with exactly two shows both and no counter',
      cards[1].labels.join(',') === 'Top Seller,Responsive Seller', cards[1].labels.join(','));
    ok('and a seller with none shows nothing', cards[2].labels.length === 0, cards[2].labels.join(','));
    await ctx.close();
  }

  /* ---------- the storefront ---------- */
  {
    const { ctx, page } = await open(browser, '/store.html?store=bong');
    const r = await snap(page);
    ok('storefront: the seller\'s badges are shown', r.badges >= 4, String(r.badges));
    ok('storefront: NOT in the header branding block, which sits above <main>',
      r.headerBadges === 0, String(r.headerBadges));
    const pos = await page.evaluate(() => {
      const row = document.querySelector('#store-seller-badges');
      const grid = document.querySelector('#product-list');
      const form = document.querySelector('#products-search-form');
      const box = (e) => (e ? Math.round(e.getBoundingClientRect().top + window.scrollY) : null);
      return { row: box(row), grid: box(grid), form: box(form) };
    });
    ok('storefront: the row sits below the search box and above the grid',
      pos.row > pos.form && pos.row < pos.grid, JSON.stringify(pos));

    // These are NOT inside a link, so here they do get their own explanations.
    ok('storefront: each badge is its own button with a panel',
      await page.evaluate(() => document.querySelectorAll('#store-seller-badges button.seller-badge').length >= 4));
    await page.click('#store-seller-badges button.seller-badge >> nth=0');
    await page.waitForTimeout(200);
    const popped = await page.evaluate(() => {
      const p = Array.from(document.querySelectorAll('.seller-badge-pop')).find((x) => !x.hidden);
      if (!p) return null;
      const b = p.getBoundingClientRect();
      return { text: p.textContent, left: Math.round(b.left), right: Math.round(b.right), vw: window.innerWidth };
    });
    ok('storefront: tapping one explains it', popped
      && popped.text === 'Recommended by Mwakete based on seller performance and customer experience.',
      popped && popped.text);
    ok('storefront: and the panel opens fully on screen',
      popped && popped.left >= 0 && popped.right <= popped.vw, JSON.stringify(popped));
    await ctx.close();
  }

  /* ---------- the product page ---------- */
  {
    const { ctx, page } = await open(browser, '/product.html?store=bong&product=p1');
    const r = await snap(page);
    ok('product page: the seller\'s badges are shown', r.badges >= 4, String(r.badges));
    ok('product page: NOT in the header branding block', r.headerBadges === 0, String(r.headerBadges));
    ok('product page: they sit in the meta row, which is already CLS-gated',
      await page.evaluate(() => !!document.querySelector('#product-meta-row #product-seller-badges .seller-badge')));
    const pos = await page.evaluate(() => {
      const box = (s) => {
        const e = document.querySelector(s);
        return e ? Math.round(e.getBoundingClientRect().top + window.scrollY) : null;
      };
      return { detail: box('#product-detail'), badges: box('#product-seller-badges'),
               reviews: box('#reviews-section'), related: box('#related-section') };
    });
    ok('product page: below the buy box and above Similar products',
      pos.badges > pos.detail && pos.badges < pos.related, JSON.stringify(pos));
    ok('product page: and above the ratings toggle in the same row',
      pos.badges <= pos.reviews, JSON.stringify(pos));
    await ctx.close();
  }

  /* ---------- CLS: the whole point of where they were put ----------
   *
   * MEASURED AS A DIFFERENCE, AND AS THE MINIMUM OF SEVERAL RUNS.
   *
   * Both of those are there because a plain threshold lied. The home page read
   * 0.0539 on roughly one run in five and 0.0001 on the rest, always the same
   * magnitude and always the same nodes - the header shrinking about 32px
   * during the first frames and pulling <main> up with it. Running it 16 times
   * with badges and 16 without settled what it is: it fired 3/16 WITHOUT badges
   * and 1/16 with. A pre-existing race on that page, nothing to do with this
   * feature, and one a fixed ceiling would have blamed on whatever happened to
   * be under test.
   *
   * So: each page is loaded with badges and without, and what is asserted is
   * the difference - the thing actually claimed. And each side is the MINIMUM
   * of three runs, because a race only ever ADDS shift, so the minimum is the
   * race-free floor. A badge that really moved the page would raise that floor
   * and still fail this.
   */
  const RUNS_PER_SIDE = 3;

  for (const [name, url] of [
    ['home', '/index.html'],
    ['storefront', '/store.html?store=bong'],
    ['product page', '/product.html?store=bong&product=p1'],
    ['directory', '/stores.html']
  ]) {
    const measureOnce = async (withBadges) => {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
      await ctx.route('**/macros/s/**', async (route) => {
        const a = new URL(route.request().url()).searchParams.get('action');
        await new Promise((r) => setTimeout(r, 600));   // every fetch lands after paint
        const B = withBadges ? ['recommended', 'verified', 'delivery', 'new'] : undefined;
        const products = Array.from({ length: 8 }, (_, i) => prod(i, B));
        let body = { ok: true };
        if (a === 'getHomePageData') body = { ok: true, products: products, stores: Array.from({ length: 6 }, (_, i) => store(i, B)) };
        else if (a === 'listStores') body = { ok: true, stores: Array.from({ length: 8 }, (_, i) => store(i, B)), total: 8, hasMore: false };
        else if (a === 'listProducts') {
          body = { ok: true, products: products, storeName: 'Bong Store', storeOpen: true };
          if (withBadges) body.sellerBadges = B;
        } else if (a === 'listProductReviews') body = { ok: true, reviews: [], count: 0, average: 0 };
        else if (a === 'searchProducts') body = { ok: true, products: products };
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
      });
      const page = await ctx.newPage();
      await page.addInitScript(() => { try { localStorage.setItem('skiri_cookie_consent', 'true'); } catch (e) {} });
      await page.addInitScript(() => {
        window.__cls = 0; window.__src = [];
        const path = (n) => {
          if (!n || !n.tagName) return String(n);
          return n.tagName.toLowerCase() + (n.id ? '#' + n.id : '');
        };
        new PerformanceObserver((l) => {
          for (const e of l.getEntries()) {
            if (e.hadRecentInput) continue;
            window.__cls += e.value;
            (e.sources || []).forEach((s) => window.__src.push(path(s.node)));
          }
        }).observe({ type: 'layout-shift', buffered: true });
      });
      await page.goto(BASE + url, { waitUntil: 'load' });
      await page.waitForTimeout(2800);
      const out = await page.evaluate(() => ({ cls: +window.__cls.toFixed(4),
        src: Array.from(new Set(window.__src)).join(',') }));
      await ctx.close();
      return out;
    };

    const best = async (withBadges) => {
      let lowest = null;
      for (let i = 0; i < RUNS_PER_SIDE; i++) {
        const r = await measureOnce(withBadges);
        if (!lowest || r.cls < lowest.cls) lowest = r;
        if (lowest.cls === 0) break;        // cannot do better than nothing
      }
      return lowest;
    };

    const withBadges = await best(true);
    const without = await best(false);
    ok(name + ': badges add no layout shift of their own',
      withBadges.cls - without.cls <= 0.01,
      'with ' + withBadges.cls + ' vs without ' + without.cls
      + (withBadges.cls - without.cls > 0.01 ? '  MOVED: ' + withBadges.src : ''));
  }

  await browser.close();

  /* ---------- read from the source ---------- */
  const helpers = fs.readFileSync(REPO + 'assets/js/helpers.js', 'utf8');
  ok('the card badge row is capped at two and read-only, in one place',
    /renderSellerBadges\(product\.sellerBadges, \{ size: 'chip', max: 2, interactive: false \}\)/.test(helpers));
  ok('and guarded, so a page without badges.js renders the card it always did',
    /typeof renderSellerBadges !== 'function'\) return ''/.test(helpers));

  // Every page that renders a badge must actually load the module.
  ['index.html', 'categories.html', 'stores.html', 'customer-tips.html',
   'store.html', 'product.html'].forEach((f) => {
    const src = fs.readFileSync(REPO + f, 'utf8');
    ok(f + ' loads the badge module', /assets\/js\/badges\.min\.js/.test(src));
    ok(f + ' loads it after helpers.js, which it calls into',
      src.indexOf('helpers.min.js') < src.indexOf('badges.min.js'));
  });

  // The header trap, asserted in the markup as well as in the measurement.
  ['store.html', 'product.html'].forEach((f) => {
    const src = fs.readFileSync(REPO + f, 'utf8');
    const header = src.slice(src.indexOf('<header'), src.indexOf('</header>'));
    ok(f + ': no badge slot in the header - that block is above <main>',
      !/seller-badges/.test(header));
  });

  console.log('\n' + pass + '/' + (pass + fail) + ' passed');
  process.exit(fail ? 1 : 0);
})();
