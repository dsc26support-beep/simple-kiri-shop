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
  const quickActions = r('.home-quick-actions');
  const stores = r('#trending-stores-list');
  const trending = r('#trending-products-list');
  const nav = document.querySelector('.bottom-nav');
  const navCs = nav ? getComputedStyle(nav) : null;
  return {
    searchTop: search ? Math.round(search.top) : null,
    searchWidthPct: search ? Math.round((search.width / window.innerWidth) * 100) : null,
    quickActionsTop: quickActions ? Math.round(quickActions.top) : null,
    storesTop: stores ? Math.round(stores.top) : null,
    trendingTop: trending ? Math.round(trending.top) : null,
    // Alibaba-inspired order: search -> quick actions -> discovery (Popular
    // Stores, moved up) -> product grid. Popular Categories, the Tips pill and
    // the trust strip were removed from the homepage by request - the trust
    // lines live in the header ticker now.
    orderOk: !!(search && quickActions && stores && trending &&
      search.top < quickActions.top &&
      quickActions.top < stores.top && stores.top < trending.top),
    quickActionCount: document.querySelectorAll('.quick-action-item').length,
    // Count-independent: all tiles share one row rather than wrapping,
    // regardless of whether that row happens to need horizontal scroll at
    // this width for however many tiles exist today.
    quickActionsOneRow: (() => {
      const items = [...document.querySelectorAll('.quick-action-item')];
      if (items.length < 2) return null;
      const tops = items.map((el) => Math.round(el.getBoundingClientRect().top));
      return tops.every((t) => Math.abs(t - tops[0]) <= 1);
    })(),
    navDisplay: navCs ? navCs.display : null,
    gridCols: (() => { const g = document.getElementById('trending-products-list');
      return g ? getComputedStyle(g).gridTemplateColumns.split(' ').length : null; })(),
    trustGone: !document.querySelector('.home-trust'),
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
    // restructure: the quick actions and Popular Stores sit above the
    // grid ON PURPOSE - that is the Alibaba-inspired information architecture
    // this task asked for, not a regression. 1000 keeps this a real guard
    // against the grid drifting arbitrarily far down, without re-litigating
    // how many sections belong above it.
    ok('mobile: products are reachable within a short scroll, not buried',
      m.trendingTop < 1000, String(m.trendingTop));
    // Discovery (Popular Stores, moved up) is the thing meant to replace the
    // old "reachable in one screen" promise - it goes first now.
    ok('mobile: the discovery row (Popular Stores) fits within the first screen',
      m.storesTop < 844, String(m.storesTop));
    // Tips is not a quick action - it lives in the bottom nav and header menu
    // - so five: Categories, Stores, Rentals, Services, Recent Views.
    ok('mobile: five quick actions are shown', m.quickActionCount === 5, String(m.quickActionCount));
    ok('mobile: the quick-action tiles stay on one row, not wrapping',
      m.quickActionsOneRow === true, String(m.quickActionsOneRow));
    // The same three lines are in the header ticker (#64); a second copy
    // under search would show them twice.
    ok('mobile: no separate trust strip duplicates the header ticker',
      m.trustGone === true, String(m.trustGone));
    ok('mobile: bottom nav is shown', m.navDisplay === 'grid', String(m.navDisplay));
    ok('mobile: nothing overflows sideways', m.noHorizontalOverflow === true);

    const gone = await page.evaluate(() => ({
      categoriesSection: !!document.querySelector('.categories'),
      categoryStrip: !!document.getElementById('category-strip'),
      homePromo: !!document.querySelector('.home-promo'),
      headerTagline: !!document.querySelector('.header-tagline'),
      tipsPill: !!document.querySelector('.home-tips-link')
    }));
    ok('mobile: Popular Categories is gone from the homepage', !gone.categoriesSection && !gone.categoryStrip,
      JSON.stringify(gone));
    ok('mobile: the old promo strip is gone', !gone.homePromo);
    // Both removed by request: the header shows the logo alone, and Tips is
    // reached from the bottom nav and header menu instead.
    ok('mobile: the header tagline is gone', !gone.headerTagline);
    ok('mobile: the Tips pill under search is gone', !gone.tipsPill);
    await ctx.close();
  }

  /* ---------- tablet ---------- */
  {
    const { ctx, page } = await open(browser, '/index.html', 820, 1100);
    const t = await layout(page);
    ok('tablet: same hierarchy, not a stretched phone', t.orderOk === true, JSON.stringify(t));
    ok('tablet: uses the extra width - more product columns than a phone',
      t.gridCols >= 3, String(t.gridCols));
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
    const tipsInNav = await page.evaluate(() =>
      !!document.querySelector('.bottom-nav a[href="customer-tips.html"]'));
    ok('Tips stays reachable from the bottom nav, not the quick-action strip',
      tipsInNav && hrefs.indexOf('customer-tips.html') === -1, String(tipsInNav));
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
    // header ticker) are static: nothing else may appear in this list -
    // except getHeaderAds (Oct 2026, owner request): the header strip became
    // admin-set adverts, fetched ONCE, when the page is idle, cached 5 minutes
    // on the server. Exactly one, never before the page's own data.
    ok('and no call for anything else - only the one idle header-adverts call',
      seen.every((a) => a === 'getHomePageData' || a === 'recordProductViews' || a === 'getHeaderAds')
        && seen.filter((a) => a === 'getHeaderAds').length <= 1 && seen.indexOf('getHeaderAds') !== 0,
      JSON.stringify(seen));
    await ctx.close();
  }

  /* ---------- the strips actually navigate ---------- */
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

  await browser.close();
  let f = 0;
  console.log('\n--- Homepage structure: mobile / tablet / desktop ---');
  for (const [s, n, e] of R) { if (s === 'FAIL') f++; console.log(`${s}  ${n}${e ? '  [' + e + ']' : ''}`); }
  console.log(`\n${R.length - f}/${R.length} passed`);
  process.exit(f ? 1 : 0);
})();
