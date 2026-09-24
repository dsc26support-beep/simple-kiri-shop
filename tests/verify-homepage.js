// The new homepage structure across mobile, tablet and desktop.
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = 'http://127.0.0.1:8100';
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e || '']);

const PRODUCTS = Array.from({ length: 8 }, (_, i) => ({
  productId: 'p' + i, name: 'Product ' + i, category: i % 2 ? 'food' : 'pantry',
  listingType: 'product', description: 'x', imageUrl: '', storeSlug: 'bong',
  storeName: 'Bong', storeIsland: 'South Tarawa', storeVillage: 'Bairiki',
  variants: [{ variantId: 'v' + i, label: '1kg', price: 5 + i }], rating: 4.2, reviewCount: 3 }));

async function open(browser, path, w, h) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h || 900 } });
  await ctx.route('**/macros/s/**', (r) => r.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ ok: true, products: PRODUCTS, stores: [
      { storeSlug: 's1', storeName: 'Shop', island: 'South Tarawa', village: 'Bairiki', logoUrl: '' }],
      tips: [], conversations: [] }) }));
  const page = await ctx.newPage();
  await page.addInitScript(() => localStorage.setItem('skiri_cookie_consent', 'true'));
  await page.goto(BASE + path, { waitUntil: 'load' });
  await page.waitForTimeout(900);
  return { ctx, page };
}

const layout = (page) => page.evaluate(() => {
  const r = (s) => { const e = document.querySelector(s); return e ? e.getBoundingClientRect() : null; };
  const search = r('.search-box');
  const promo = r('.home-promo');
  const quickActions = r('.home-quick-actions');
  const trust = r('.home-trust');
  const cats = r('#category-strip');
  const stores = r('#trending-stores-list');
  const trending = r('#trending-products-list');
  const nav = document.querySelector('.bottom-nav');
  const navCs = nav ? getComputedStyle(nav) : null;
  const strip = document.getElementById('category-strip');
  return {
    searchTop: search ? Math.round(search.top) : null,
    searchWidthPct: search ? Math.round((search.width / window.innerWidth) * 100) : null,
    promoTop: promo ? Math.round(promo.top) : null,
    quickActionsTop: quickActions ? Math.round(quickActions.top) : null,
    trustTop: trust ? Math.round(trust.top) : null,
    catsTop: cats ? Math.round(cats.top) : null,
    storesTop: stores ? Math.round(stores.top) : null,
    trendingTop: trending ? Math.round(trending.top) : null,
    // Alibaba-inspired order: brand/search -> promo -> quick actions -> trust
    // -> categories -> discovery (Popular Stores, moved up) -> product grid.
    orderOk: !!(search && promo && quickActions && trust && cats && stores && trending &&
      search.top < promo.top && promo.top <= quickActions.top && quickActions.top <= trust.top &&
      trust.top <= cats.top && cats.top < stores.top && stores.top < trending.top),
    stripScrolls: strip ? strip.scrollWidth > strip.clientWidth + 1 : null,
    stripOneRow: strip ? Math.round(strip.getBoundingClientRect().height) < 70 : null,
    chipCount: document.querySelectorAll('#category-strip .chip-strip-item').length,
    chipMinHeight: (() => { const c = document.querySelector('.chip-strip-item');
      return c ? Math.round(c.getBoundingClientRect().height) : null; })(),
    quickActionCount: document.querySelectorAll('.quick-action-item').length,
    quickActionStripScrolls: (() => { const q = document.querySelector('.quick-action-strip');
      return q ? q.scrollWidth > q.clientWidth + 1 : null; })(),
    navDisplay: navCs ? navCs.display : null,
    gridCols: (() => { const g = document.getElementById('trending-products-list');
      return g ? getComputedStyle(g).gridTemplateColumns.split(' ').length : null; })(),
    noHorizontalOverflow: document.documentElement.scrollWidth <= window.innerWidth
  };
});

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

  /* ---------- mobile ---------- */
  {
    const { ctx, page } = await open(browser, '/index.html', 390, 844);
    const m = await layout(page);
    ok('mobile: search sits at the top, above everything else', m.searchTop !== null && m.orderOk,
      JSON.stringify(m));
    ok('mobile: the search box is prominent (>80% of the width)', m.searchWidthPct >= 80,
      String(m.searchWidthPct) + '%');
    // This threshold moved from 844 (the full first screen) to 1000 with the
    // restructure: three new sections (promo, quick actions, trust strip) plus
    // the discovery carousel now sit above the grid ON PURPOSE - that is the
    // Alibaba-inspired information architecture this task asked for, not a
    // regression. 1000 keeps this a real guard against the grid drifting
    // arbitrarily far down, without re-litigating how many sections belong
    // above it.
    ok('mobile: products are reachable within a short scroll, not buried',
      m.trendingTop < 1000, String(m.trendingTop));
    // Discovery (Popular Stores, moved up) is the thing meant to replace the
    // old "reachable in one screen" promise - it goes first now.
    ok('mobile: the discovery row (Popular Stores) fits within the first screen',
      m.storesTop < 844, String(m.storesTop));
    ok('mobile: the promo strip is above the categories', m.promoTop < m.catsTop,
      JSON.stringify({ promoTop: m.promoTop, catsTop: m.catsTop }));
    ok('mobile: five quick actions are shown', m.quickActionCount === 5, String(m.quickActionCount));
    ok('mobile: the quick-action strip scrolls sideways rather than wrapping',
      m.quickActionStripScrolls === true, String(m.quickActionStripScrolls));
    ok('mobile: the trust strip is present', m.trustTop !== null, String(m.trustTop));
    ok('mobile: the category strip scrolls sideways', m.stripScrolls === true, String(m.stripScrolls));
    ok('mobile: and stays one row tall', m.stripOneRow === true, String(m.stripOneRow));
    ok('mobile: chips are a comfortable touch target (>=40px)', m.chipMinHeight >= 40, String(m.chipMinHeight));
    // Counted from the taxonomy rather than written down, so adding a popular
    // category is not a failing homepage test. What matters here is the two
    // assertions above - the strip scrolls sideways and stays ONE ROW tall -
    // which is why the count is free to grow: .chip-strip never wraps, so more
    // chips cost scroll distance, not page height.
    {
      const popular = (require('fs').readFileSync('/home/user/simple-kiri-shop/assets/js/helpers.js', 'utf8')
        .match(/const CATEGORIES = \[([\s\S]*?)\n\];/)[1].split('\n')
        .filter((l) => /popular:\s*true/.test(l))).length;
      ok('mobile: the popular categories plus View all, not every category',
        m.chipCount === popular + 1, `${m.chipCount} chips for ${popular} popular`);
    }
    ok('mobile: bottom nav is shown', m.navDisplay === 'grid', String(m.navDisplay));
    ok('mobile: nothing overflows sideways', m.noHorizontalOverflow === true);

    const last = await page.evaluate(() =>
      document.querySelector('#category-strip .chip-strip-item:last-child').textContent.trim());
    ok('mobile: the strip ends with View all categories', /View all categories/.test(last), last);
    await ctx.close();
  }

  /* ---------- tablet ---------- */
  {
    const { ctx, page } = await open(browser, '/index.html', 820, 1100);
    const t = await layout(page);
    ok('tablet: same hierarchy, not a stretched phone', t.orderOk === true, JSON.stringify(t));
    ok('tablet: uses the extra width - more product columns than a phone',
      t.gridCols >= 3, String(t.gridCols));
    ok('tablet: chips grow with the room', t.chipMinHeight >= 44, String(t.chipMinHeight));
    ok('tablet: bottom nav is hidden above 700px', t.navDisplay === 'none', String(t.navDisplay));
    ok('tablet: nothing overflows sideways', t.noHorizontalOverflow === true);
    await ctx.close();
  }

  /* ---------- desktop ---------- */
  {
    const { ctx, page } = await open(browser, '/index.html', 1366, 900);
    const d = await layout(page);
    ok('desktop: hierarchy preserved', d.orderOk === true, JSON.stringify(d));
    ok('desktop: existing sections still there', d.trendingTop !== null);
    ok('desktop: nothing overflows sideways', d.noHorizontalOverflow === true);
    const kept = await page.evaluate(() => ({
      trending: !!document.getElementById('trending-products-list'),
      stores: !!document.getElementById('trending-stores-list'),
      headerCart: (() => { const c = document.getElementById('header-cart-link');
        return !!c && getComputedStyle(c).display !== 'none'; })()
    }));
    ok('desktop: Trending Products kept', kept.trending);
    ok('desktop: Popular Stores kept', kept.stores);
    ok('desktop: header cart is the cart entry (no bottom bar here)', kept.headerCart === true);
    await ctx.close();
  }

  /* ---------- quick actions: only real destinations, nothing invented ---- */
  {
    const { ctx, page } = await open(browser, '/index.html', 390, 844);
    const hrefs = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.quick-action-item')).map((a) => a.getAttribute('href')));
    ok('quick actions link to categories.html', hrefs.indexOf('categories.html') !== -1, hrefs.join(', '));
    ok('quick actions link to stores.html', hrefs.indexOf('stores.html') !== -1, hrefs.join(', '));
    ok('quick actions link to customer-tips.html', hrefs.indexOf('customer-tips.html') !== -1, hrefs.join(', '));
    ok('quick actions link to a real rentals filter',
      hrefs.indexOf('categories.html?category=rental') !== -1, hrefs.join(', '));
    ok('quick actions link to a real services filter',
      hrefs.indexOf('categories.html?category=services') !== -1, hrefs.join(', '));
    // The two actions the reference brief suggested but Mwakete has no
    // destination for - guarded so nobody adds a dead link for them later
    // without deciding what it should point to.
    const labels = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.quick-action-label')).map((el) => el.textContent.trim()));
    ok('no "Request a Quote" quick action - no such feature exists',
      labels.indexOf('Request a Quote') === -1, labels.join(', '));
    ok('no "Hire" quick action - no dedicated Hire destination exists',
      labels.indexOf('Hire') === -1, labels.join(', '));
    await ctx.close();
  }

  /* ---------- the new sections make no network call of their own -------- */
  {
    const seen = [];
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await ctx.route('**/macros/s/**', (r) => {
      const req = r.request();
      // GET carries the action as a query param; POST carries it in the JSON
      // body (api.js sends text/plain to dodge a CORS preflight).
      const fromQuery = new URL(req.url()).searchParams.get('action');
      let action = fromQuery;
      if (!action && req.method() === 'POST') {
        try { action = JSON.parse(req.postData() || '{}').action || null; } catch (e) { action = null; }
      }
      seen.push(action);
      return r.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ ok: true, products: PRODUCTS, stores: [], tips: [], conversations: [] }) });
    });
    const page = await ctx.newPage();
    await page.addInitScript(() => localStorage.setItem('skiri_cookie_consent', 'true'));
    await page.goto(BASE + '/index.html', { waitUntil: 'load' });
    await page.waitForTimeout(900);
    ok('the homepage still makes exactly one backend call for its data',
      seen.filter((a) => a === 'getHomePageData').length === 1, JSON.stringify(seen));
    // recordProductViews already fired here before this task - it is
    // renderTrendingProducts' own view-tracking call, not something the new
    // sections introduced. The new sections themselves (promo, quick actions,
    // trust strip) are static: nothing else may appear in this list.
    ok('and no call for anything else - the new sections stay static',
      seen.every((a) => a === 'getHomePageData' || a === 'recordProductViews'),
      JSON.stringify(seen));
    await ctx.close();
  }

  /* ---------- the strips actually navigate ---------- */
  {
    const { ctx, page } = await open(browser, '/index.html', 390, 844);
    await page.click('#category-strip .chip-strip-item[data-category="food"]');
    await page.waitForTimeout(700);
    ok('tapping a category lands on a filtered search',
      /categories\.html\?category=food$/.test(page.url()), page.url());
    await ctx.close();
  }
  {
    // The [All|Products|Rentals|Services] strip was removed from the homepage
    // and the search page. ?type= still FILTERS - smart search builds those
    // links itself - there is simply no visible control for it any more, so
    // this now guards the removal instead of the tap it used to make.
    const { ctx, page } = await open(browser, '/index.html', 390, 844);
    const gone = await page.evaluate(() => ({
      strip: !!document.getElementById('listing-type-strip'),
      section: !!document.querySelector('.listing-types'),
      anyTypeLink: !!document.querySelector('a[href*="type=rental"], a[href*="type=service"]')
    }));
    ok('the listing-type strip is gone from the homepage', !gone.strip);
    ok('and so is the section that wrapped it', !gone.section);
    ok('no stray type= links are left behind', !gone.anyTypeLink);
    await ctx.close();
  }
  {
    const { ctx, page } = await open(browser, '/index.html', 390, 844);
    await page.click('#category-strip .chip-strip-item--more');
    await page.waitForTimeout(700);
    ok('View all categories opens the browse page',
      /categories\.html$/.test(page.url()), page.url());
    const n = await page.evaluate(() => document.querySelectorAll('.category-rail-item').length);
    // Counted from the taxonomy, not written down here: a hardcoded number
    // turns "we added a category" into a failing homepage test.
    const expected = (require('fs').readFileSync('/home/user/simple-kiri-shop/assets/js/helpers.js', 'utf8')
      .match(/const CATEGORIES = \[([\s\S]*?)\n\];/)[1].match(/id: '[a-z]+'/g) || []).length;
    // +1 for Featured, which heads the rail and is deliberately not a member of
    // CATEGORIES - see FEATURED_VIEW in helpers.js.
    ok('and shows Featured plus every category there', n === expected + 1, `${n} of ${expected + 1}`);
    await ctx.close();
  }

  await browser.close();
  let f = 0;
  console.log('\n--- Homepage structure: mobile / tablet / desktop ---');
  for (const [s, n, e] of R) { if (s === 'FAIL') f++; console.log(`${s}  ${n}${e ? '  [' + e + ']' : ''}`); }
  console.log(`\n${R.length - f}/${R.length} passed`);
  process.exit(f ? 1 : 0);
})();
