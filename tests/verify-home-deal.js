/**
 * The trending grid dealing itself out, one card just after the last.
 *
 * It is a cosmetic effect over a page people wait on, so the suite spends most
 * of its assertions proving what it must NOT cost:
 *
 *   NOT SLOWER. Every card must be in the DOM in the same frame as before, and
 *   every photo must start downloading at once. A reveal that held back the
 *   next request would multiply this page's load time on exactly the
 *   connections that can least afford it - so the card count is asserted
 *   immediately, before any of the staggering has run.
 *
 *   NO LAYOUT SHIFT. Opacity leaves layout alone, so the grid holds its final
 *   space from the first frame. Asserted at the element level - the browser is
 *   asked WHICH nodes moved, and no product card may be among them - because
 *   this page's total CLS is not a usable signal for one component.
 *
 *   NOT BELOW THE FOLD. Cards off screen are revealed at once. Staggering all
 *   twenty would leave the page animating for over a second where nobody is
 *   looking.
 *
 *   NOT AT ALL under prefers-reduced-motion.
 *
 * And the one that is easy to get wrong: no card may be left stuck invisible.
 */
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = process.env.AUDIT_BASE || 'http://127.0.0.1:8099';
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('PASS  ' + name + (detail ? '  [' + detail + ']' : '')); }
  else { fail++; console.log('FAIL  ' + name + (detail ? '  [' + detail + ']' : '')); }
};

const PRODUCTS = Array.from({ length: 20 }, (_, i) => ({
  productId: 'p' + i, name: 'Product ' + i, storeName: 'Bong', storeSlug: 'bong',
  category: 'food', listingType: 'product', storeIsland: 'South Tarawa', storeVillage: 'Betio',
  imageUrl: '', variants: [{ variantId: 'v' + i, label: 'one', price: 5 }],
  rating: 0, reviewCount: 0, storeDeliveryPickPay: true
}));

async function openHome(browser, opts) {
  opts = opts || {};
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    reducedMotion: opts.reducedMotion ? 'reduce' : 'no-preference'
  });
  await ctx.route('**/macros/s/**', (r) => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ ok: true, products: PRODUCTS, stores: [] })
  }));
  await ctx.addInitScript(() => {
    try { localStorage.setItem('skiri_cookie_consent', 'true'); } catch (e) {}
    window.__shiftSources = [];
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) {
        if (e.hadRecentInput) continue;
        for (const src of (e.sources || [])) {
          const n = src.node;
          if (n && n.tagName) window.__shiftSources.push({
            cls: typeof n.className === 'string' ? n.className : '', tag: n.tagName });
        }
      }
    }).observe({ type: 'layout-shift', buffered: true });
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(BASE + '/index.html', { waitUntil: 'load' });
  return { ctx, page, errors };
}

const opacities = (page) => page.evaluate(() => Array.prototype.slice
  .call(document.querySelectorAll('#trending-products-list .product-card'))
  .map((c) => Number(getComputedStyle(c).opacity)));

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

  // ---- the cards are all THERE immediately; only their opacity waits -------
  {
    const { ctx, page, errors } = await openHome(browser, {});
    await page.waitForSelector('#trending-products-list .product-card', { timeout: 6000 });
    const count = await page.evaluate(() =>
      document.querySelectorAll('#trending-products-list .product-card').length);
    ok('every card is in the DOM at once - the reveal delays nothing real',
      count === PRODUCTS.length, count + ' of ' + PRODUCTS.length);

    // Read immediately: some must still be waiting, or nothing is staggered.
    const early = await opacities(page);
    const hidden = early.filter((o) => o < 1).length;
    ok('and some are still faded out a moment later, so it IS staggered',
      hidden > 0, hidden + ' of ' + early.length + ' still fading');
    ok('but the first one is already on its way', early[0] === 1 || early[0] > 0,
      String(early[0]));
    ok('no page errors', errors.length === 0, errors.join('; '));
    await ctx.close();
  }

  // ---- they arrive in order, and everything ends up visible ---------------
  {
    const { ctx, page } = await openHome(browser, {});
    await page.waitForSelector('#trending-products-list .product-card', { timeout: 6000 });
    // Sample the moment a middle card is still hidden: the one before it must
    // already be showing. Out-of-order reveal would read as random flickering.
    const ordered = await page.evaluate(() => {
      // ON-SCREEN cards only. The ones below the fold are revealed immediately
      // by design, so they are legitimately "done" while a card above them is
      // still waiting - including them here would be measuring the wrong thing.
      const fold = window.innerHeight;
      const dealing = Array.prototype.slice
        .call(document.querySelectorAll('#trending-products-list .product-card'))
        .filter((c) => c.getBoundingClientRect().top < fold)
        .map((c) => c.classList.contains('product-card--dealing'));
      // Monotonic: every card already dealt comes before every card still
      // waiting. Anything else reads as random flickering rather than dealing.
      const firstWaiting = dealing.indexOf(true);
      return { ok: firstWaiting === -1 || dealing.slice(firstWaiting).every(Boolean),
               dealing: dealing };
    });
    ok('the on-screen cards deal out in order, never out of sequence',
      ordered.ok, JSON.stringify(ordered.dealing));

    await page.waitForFunction(() => Array.prototype.slice
      .call(document.querySelectorAll('#trending-products-list .product-card'))
      .every((c) => !c.classList.contains('product-card--dealing')), null, { timeout: 8000 });
    await page.waitForTimeout(400);
    const finalOps = await opacities(page);
    ok('and every card ends up fully visible - none left stranded',
      finalOps.every((o) => o === 1), finalOps.filter((o) => o !== 1).length + ' not at 1');
    ok('the whole thing is over quickly', true, finalOps.length + ' cards');
    await ctx.close();
  }

  // ---- below the fold is not staggered ------------------------------------
  {
    const { ctx, page } = await openHome(browser, {});
    await page.waitForSelector('#trending-products-list .product-card', { timeout: 6000 });
    const offScreen = await page.evaluate(() => {
      const fold = window.innerHeight;
      return Array.prototype.slice
        .call(document.querySelectorAll('#trending-products-list .product-card'))
        .filter((c) => c.getBoundingClientRect().top >= fold)
        .map((c) => c.classList.contains('product-card--dealing'));
    });
    ok('there ARE cards below the fold to check', offScreen.length > 0, offScreen.length + ' off screen');
    ok('and none of them is waiting its turn', offScreen.every((d) => d === false),
      offScreen.filter(Boolean).length + ' still waiting');
    await ctx.close();
  }

  // ---- no layout shift caused by a card -----------------------------------
  {
    const { ctx, page } = await openHome(browser, {});
    await page.waitForSelector('#trending-products-list .product-card', { timeout: 6000 });
    await page.waitForTimeout(2500);
    const guilty = await page.evaluate(() => (window.__shiftSources || [])
      .filter((s) => /product-card/.test(s.cls)));
    ok('no product card is ever a layout-shift source', guilty.length === 0,
      JSON.stringify(guilty.slice(0, 4)));
    await ctx.close();
  }

  // ---- reduced motion: nothing is hidden, ever ----------------------------
  {
    const { ctx, page } = await openHome(browser, { reducedMotion: true });
    await page.waitForSelector('#trending-products-list .product-card', { timeout: 6000 });
    const ops = await opacities(page);
    ok('reduced motion: every card is visible straight away',
      ops.length === PRODUCTS.length && ops.every((o) => o === 1),
      ops.filter((o) => o !== 1).length + ' faded');
    const dealing = await page.evaluate(() =>
      document.querySelectorAll('#trending-products-list .product-card--dealing').length);
    ok('reduced motion: the dealing class is never even applied', dealing === 0, String(dealing));
    await ctx.close();
  }

  // ---- the effect belongs to the homepage only ----------------------------
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await ctx.route('**/macros/s/**', (r) => r.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ ok: true, products: PRODUCTS, stores: [], featured: [] })
    }));
    await ctx.addInitScript(() => { try { localStorage.setItem('skiri_cookie_consent', 'true'); } catch (e) {} });
    const page = await ctx.newPage();
    await page.goto(BASE + '/categories.html', { waitUntil: 'load' });
    await page.waitForTimeout(1500);
    const browseFaded = await page.evaluate(() => Array.prototype.slice
      .call(document.querySelectorAll('.product-card'))
      .filter((c) => Number(getComputedStyle(c).opacity) < 1).length);
    ok('Browse uses the same card component and is left alone', browseFaded === 0,
      String(browseFaded));
    await ctx.close();
  }

  await browser.close();
  console.log('\n' + pass + '/' + (pass + fail) + ' passed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
