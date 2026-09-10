const { chromium, devices } = require('/opt/node22/lib/node_modules/playwright');
const BASE = 'http://127.0.0.1:8099';

const prod = (id, name) => ({ productId: id, name, storeSlug: 'x', storeName: 'S', category: 'pantry', variants: [{ variantId: 'v', label: '1kg', price: 5 }], imageUrl: '', storeDeliveryTruck: false });

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const results = [];
  const ok = (n, c, e) => results.push([c ? 'PASS' : 'FAIL', n, e || '']);

  async function ctxWith(n, opts) {
    const ctx = await browser.newContext(opts);
    await ctx.route('**/macros/s/**', (route) => {
      let action = '';
      try { const u = new URL(route.request().url()); action = u.searchParams.get('action') || ''; } catch (e) {}
      const products = Array.from({ length: n }, (_, i) => prod('p' + i, 'Item ' + i));
      let body = { ok: true, products, stores: [] };
      if (action === 'listProducts') body = { ok: true, storeName: 'S', storeSlug: 'x', storePhone: '', products };
      else if (action === 'searchProducts') body = { ok: true, products };
      else if (action === 'getHomePageData') body = { ok: true, products, stores: [] };
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });
    return ctx;
  }

  // ---------- Install button ----------
  // 1. Not installed + beforeinstallprompt => shows
  {
    const ctx = await ctxWith(0, { viewport: { width: 390, height: 800 } });
    const page = await ctx.newPage();
    await page.goto(BASE + '/index.html', { waitUntil: 'load' });
    await page.evaluate(() => { const e = new Event('beforeinstallprompt'); e.prompt = () => { window.__p = 1; }; e.userChoice = Promise.resolve({ outcome: 'dismissed' }); window.dispatchEvent(e); });
    const shown = await page.waitForSelector('.install-fab.is-visible', { timeout: 2000 }).then(() => true).catch(() => false);
    ok('install: shows on beforeinstallprompt (not installed)', shown);
    await ctx.close();
  }
  // 2. Installed flag set, no event => hidden
  {
    const ctx = await ctxWith(0, { viewport: { width: 390, height: 800 } });
    const page = await ctx.newPage();
    await page.addInitScript(() => { try { localStorage.setItem('skiri_pwa_installed', '1'); } catch (e) {} });
    await page.goto(BASE + '/index.html', { waitUntil: 'load' });
    await page.waitForTimeout(300);
    const vis = await page.$('.install-fab.is-visible');
    ok('install: hidden when installed flag set (browser reload)', !vis);
    await ctx.close();
  }
  // 3. appinstalled sets flag + hides; reload stays hidden
  {
    const ctx = await ctxWith(0, { viewport: { width: 390, height: 800 } });
    const page = await ctx.newPage();
    await page.goto(BASE + '/index.html', { waitUntil: 'load' });
    await page.evaluate(() => { const e = new Event('beforeinstallprompt'); e.prompt = () => {}; e.userChoice = Promise.resolve({ outcome: 'accepted' }); window.dispatchEvent(e); });
    await page.waitForSelector('.install-fab.is-visible', { timeout: 2000 });
    await page.evaluate(() => window.dispatchEvent(new Event('appinstalled')));
    await page.waitForTimeout(100);
    const flag = await page.evaluate(() => { try { return localStorage.getItem('skiri_pwa_installed'); } catch (e) { return null; } });
    const hiddenNow = await page.$eval('.install-fab', el => !el.classList.contains('is-visible')).catch(() => true);
    ok('install: appinstalled sets flag + hides', flag === '1' && hiddenNow, 'flag=' + flag);
    await page.reload({ waitUntil: 'load' });
    await page.waitForTimeout(300);
    const stillHidden = !(await page.$('.install-fab.is-visible'));
    ok('install: stays hidden after reload post-install', stillHidden);
    await ctx.close();
  }
  // 4. iOS: shows on load without event
  {
    const ctx = await ctxWith(0, Object.assign({}, devices['iPhone 12']));
    const page = await ctx.newPage();
    await page.goto(BASE + '/index.html', { waitUntil: 'load' });
    const shown = await page.waitForSelector('.install-fab.is-visible', { timeout: 2000 }).then(() => true).catch(() => false);
    ok('install: iOS shows on load (no event)', shown);
    await ctx.close();
  }
  // 5. Self-heal: stale flag then beforeinstallprompt => shows + flag cleared
  {
    const ctx = await ctxWith(0, { viewport: { width: 390, height: 800 } });
    const page = await ctx.newPage();
    await page.addInitScript(() => { try { localStorage.setItem('skiri_pwa_installed', '1'); } catch (e) {} });
    await page.goto(BASE + '/index.html', { waitUntil: 'load' });
    await page.evaluate(() => { const e = new Event('beforeinstallprompt'); e.prompt = () => {}; e.userChoice = Promise.resolve({ outcome: 'dismissed' }); window.dispatchEvent(e); });
    const shown = await page.waitForSelector('.install-fab.is-visible', { timeout: 2000 }).then(() => true).catch(() => false);
    const flag = await page.evaluate(() => { try { return localStorage.getItem('skiri_pwa_installed'); } catch (e) { return 'err'; } });
    ok('install: self-heal on beforeinstallprompt (shows + flag cleared)', shown && flag === null, 'shown=' + shown + ' flag=' + flag);
    await ctx.close();
  }

  // ---------- Content hug ----------
  //
  // This measured the gap between the last product and the footer, because the
  // bug it guards - main inflated to a 60vh floor, leaving dead space below the
  // products - showed up as the footer being pushed down the page.
  //
  // search.html and store.html no longer HAVE a footer, so that anchor is gone.
  // The bug is not: main can still be inflated. Measure to main's own bottom
  // edge instead, which is what the footer was standing in for, and fall back
  // to the footer on the pages that still have one so the same function serves
  // both.
  function gapFn() {
    return (() => {
      const cards = document.querySelectorAll('.product-grid .product-card, #results-list .product-card, #product-list .product-card');
      const last = cards[cards.length - 1];
      const footer = document.querySelector('footer.site-footer');
      const main = document.querySelector('main');
      const below = footer || main;
      const edge = footer
        ? footer.getBoundingClientRect().top
        : main.getBoundingClientRect().bottom;
      return {
        anchor: footer ? 'footer' : 'main-bottom',
        gap: Math.round(edge - last.getBoundingClientRect().bottom),
        mainH: Math.round(main.getBoundingClientRect().height),
        vh: window.innerHeight,
      };
    })();
  }
  // 6. search.html short list on a TALL viewport so 60vh (900px) exceeds the
  // content - this is exactly the case where the old floor created the gap.
  // With the fix, main hugs content and the footer sits just after the products.
  {
    const ctx = await ctxWith(2, { viewport: { width: 390, height: 1500 } });
    const page = await ctx.newPage();
    await page.goto(BASE + '/search.html', { waitUntil: 'load' });
    await page.waitForSelector('#results-list .product-card');
    const g = await page.evaluate(gapFn);
    const floor = Math.round(g.vh * 0.6); // 900px
    ok('hug: small gap below a short list', g.gap < 80, JSON.stringify(g));
    ok('hug: main hugs content, NOT inflated to 60vh floor', g.mainH < floor, JSON.stringify(g) + ' floor=' + floor);
    await ctx.close();
  }
  // 7. store.html with 10 products, mobile: footer directly after grid
  {
    const ctx = await ctxWith(10, { viewport: { width: 390, height: 800 } });
    const page = await ctx.newPage();
    await page.goto(BASE + '/store.html?store=x', { waitUntil: 'load' });
    await page.waitForSelector('#product-list .product-card');
    const g = await page.evaluate(gapFn);
    // store.html has an (empty) #cart-feedback <p> after the grid, so the gap is
    // section padding + that p's line-box - normal spacing, no 60vh floor.
    ok('hug: store 10 products - content ends close to the grid (no floor gap)', g.gap < 120, JSON.stringify(g));
    await ctx.close();
  }
  // 8. Desktop: main keeps 60vh floor (page-products override is <=1024 only)
  {
    const ctx = await ctxWith(2, { viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(BASE + '/search.html', { waitUntil: 'load' });
    await page.waitForSelector('#results-list .product-card');
    const mh = await page.evaluate(() => Math.round(document.querySelector('main').getBoundingClientRect().height));
    ok('hug: desktop main still >= ~60vh', mh >= 900 * 0.6 - 5, 'mainH=' + mh);
    await ctx.close();
  }

  await browser.close();
  console.log('\n--- install + content-hug verification ---');
  let failed = 0;
  for (const [st, n, e] of results) { if (st === 'FAIL') failed++; console.log(`${st}  ${n}${e ? '  [' + e + ']' : ''}`); }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
