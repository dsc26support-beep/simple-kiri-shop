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
  const types = r('#listing-type-strip');
  const cats = r('#category-strip');
  const trending = r('#trending-products-list');
  const nav = document.querySelector('.bottom-nav');
  const navCs = nav ? getComputedStyle(nav) : null;
  const strip = document.getElementById('category-strip');
  return {
    searchTop: search ? Math.round(search.top) : null,
    searchWidthPct: search ? Math.round((search.width / window.innerWidth) * 100) : null,
    typesTop: types ? Math.round(types.top) : null,
    catsTop: cats ? Math.round(cats.top) : null,
    trendingTop: trending ? Math.round(trending.top) : null,
    // Order matters: brand/search -> type strip -> categories -> discovery.
    orderOk: !!(search && types && cats && trending &&
      search.top < types.top && types.top < cats.top && cats.top < trending.top),
    stripScrolls: strip ? strip.scrollWidth > strip.clientWidth + 1 : null,
    stripOneRow: strip ? Math.round(strip.getBoundingClientRect().height) < 70 : null,
    chipCount: document.querySelectorAll('#category-strip .chip-strip-item').length,
    chipMinHeight: (() => { const c = document.querySelector('.chip-strip-item');
      return c ? Math.round(c.getBoundingClientRect().height) : null; })(),
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
    ok('mobile: type strip is above the category strip', m.typesTop < m.catsTop, `${m.typesTop} < ${m.catsTop}`);
    ok('mobile: products are reachable without scrolling past a wall of categories',
      m.trendingTop < 844, String(m.trendingTop));
    ok('mobile: the category strip scrolls sideways', m.stripScrolls === true, String(m.stripScrolls));
    ok('mobile: and stays one row tall', m.stripOneRow === true, String(m.stripOneRow));
    ok('mobile: chips are a comfortable touch target (>=40px)', m.chipMinHeight >= 40, String(m.chipMinHeight));
    ok('mobile: 6 popular categories + View all, not all twelve', m.chipCount === 7, String(m.chipCount));
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

  /* ---------- the strips actually navigate ---------- */
  {
    const { ctx, page } = await open(browser, '/index.html', 390, 844);
    await page.click('#category-strip .chip-strip-item[data-category="food"]');
    await page.waitForTimeout(700);
    ok('tapping a category lands on a filtered search',
      /search\.html\?category=food$/.test(page.url()), page.url());
    await ctx.close();
  }
  {
    const { ctx, page } = await open(browser, '/index.html', 390, 844);
    await page.click('#listing-type-strip .chip-strip-item:nth-child(3)');
    await page.waitForTimeout(700);
    ok('tapping Rentals lands on a type-filtered search',
      /search\.html\?type=rental$/.test(page.url()), page.url());
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
    ok('and shows every category there', n === expected, `${n} of ${expected}`);
    await ctx.close();
  }

  await browser.close();
  let f = 0;
  console.log('\n--- Homepage structure: mobile / tablet / desktop ---');
  for (const [s, n, e] of R) { if (s === 'FAIL') f++; console.log(`${s}  ${n}${e ? '  [' + e + ']' : ''}`); }
  console.log(`\n${R.length - f}/${R.length} passed`);
  process.exit(f ? 1 : 0);
})();
