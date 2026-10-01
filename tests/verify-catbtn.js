// This suite has been repointed three times, and the history is the point.
//
// 1. Originally: the amber/green colour-coding on the homepage's Rentals and
//    Services CATEGORY buttons.
// 2. Then those stopped being categories - they became listing types, and a
//    rental can sit in any category - so it was repointed onto the
//    [All|Products|Rentals|Services] strip that replaced them.
// 3. That strip was gone from the homepage and search page too, so this
//    moved onto the homepage's own Popular Categories strip instead.
// 4. Popular Categories was removed from the homepage entirely by request -
//    the only place a category is listed in the UI now is the browse page's
//    own rail (#category-rail), so that is what this checks today.
//
// What survives, across all four, is the assertion that outlived every
// rewrite: RENTALS AND SERVICES ARE NOT CATEGORIES. That is a taxonomy
// decision whatever UI lists categories could silently undo, and it is worth
// guarding regardless of which UI that is.
//
// The rest of the old file tested chips that no longer exist and is gone with
// them. ?type= still filters - smart search builds those links - there is just
// no visible control, which is asserted here and in verify-homepage.
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = 'http://127.0.0.1:8099';
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e || '']);

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx.route('**/macros/s/**', (route) => route.fulfill({ status: 200,
    contentType: 'application/json', body: JSON.stringify({ ok: true, products: [], stores: [] }) }));

  async function check(pageName, url) {
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForSelector('.category-rail-item');

    const cats = await page.evaluate(() =>
      [...document.querySelectorAll('.category-rail-item')].map((a) => a.textContent.trim()));
    ok(`${pageName}: the category rail is present`, cats.length > 0, JSON.stringify(cats));
    ok(`${pageName}: rentals are NOT offered as a category`,
      !cats.some((t) => t === 'Rentals'), JSON.stringify(cats));
    // Only Rentals is checked. "Services" IS a real category in the taxonomy -
    // a plumber is a service AND files under Services - so asserting its
    // absence would be wrong. Rentals is the one that must never reappear as a
    // category, because knowing a thing is rented says nothing about what it is.

    const strip = await page.evaluate(() => !!document.getElementById('listing-type-strip'));
    ok(`${pageName}: the listing-type strip is gone`, !strip);

    await page.close();
  }

  // The browse page's rail is the only place a category is listed in the UI
  // now - the homepage's Popular Categories strip that used to be checked
  // here was removed by request (see verify-homepage for that removal).
  await check('browse', BASE + '/categories.html');

  // The filter itself must still work when a link carries it - this is what
  // smart search relies on for "somewhere to stay" to reach rentals rather
  // than land for sale.
  {
    const asked = [];
    const ctx2 = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await ctx2.route('**/macros/s/**', (r) => {
      try {
        const u = new URL(r.request().url());
        if (u.searchParams.get('action') === 'searchProducts') asked.push(u.searchParams.get('type') || '');
      } catch (e) {}
      return r.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ ok: true, products: [], stores: [] }) });
    });
    const page = await ctx2.newPage();
    await page.goto(BASE + '/categories.html?category=property&type=rental', { waitUntil: 'load' });
    await page.waitForTimeout(900);
    ok('?type= still reaches the backend with the chips gone',
      asked.includes('rental'), JSON.stringify(asked));
    await ctx2.close();
  }

  await browser.close();
  let f = 0;
  console.log('\n--- Rentals/services are not categories; type filter survives ---');
  for (const [s, n, e] of R) { if (s === 'FAIL') f++; console.log(`${s}  ${n}${e ? '  [' + e + ']' : ''}`); }
  console.log(`\n${R.length - f}/${R.length} passed`);
  process.exit(f ? 1 : 0);
})();
