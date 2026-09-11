/**
 * The ratings toggle and the store link, moved above Similar products and put
 * on one row.
 *
 * THE ASSERTION THAT MATTERS MOST is the one about the review score. The score
 * ("No reviews yet", or "* 4.5 - 12 reviews") is not in the HTML - it arrives
 * when listProductReviews answers, which is after the row has already painted.
 * If the row wrapped on content width, that text landing would change where it
 * wraps and shove the store link sideways and down. A horizontal shift counts
 * against CLS exactly as a vertical one does, so this test measures the store
 * link's box before and after the score arrives and requires it not to move.
 *
 * Everything else is the visible result: the row sits above Similar products,
 * the two halves share a line where there is room for both, the text is
 * smaller, and both halves are still big enough to tap.
 */
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = process.env.AUDIT_BASE || 'http://127.0.0.1:8099';
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('PASS  ' + name + (detail ? '  [' + detail + ']' : '')); }
  else { fail++; console.log('FAIL  ' + name + (detail ? '  [' + detail + ']' : '')); }
};

const PRODUCT = {
  productId: 'p1', name: 'Solar Lamp', description: 'Bright', category: 'electronics',
  status: 'active', imageUrl: '', listingType: 'product',
  variants: [{ variantId: 'v1', label: 'One size', price: 25, status: 'active' }]
};

/**
 * opts.reviewDelay: how long listProductReviews takes, so the score really does
 * land after paint rather than in the same task.
 * opts.reviews: what it answers with.
 */
async function open(browser, width, opts) {
  opts = opts || {};
  const ctx = await browser.newContext({ viewport: { width: width, height: 900 } });
  await ctx.route('**/macros/s/**', async (route) => {
    const action = new URL(route.request().url()).searchParams.get('action');
    let body = { ok: true };
    if (action === 'listProducts') {
      if (opts.productDelay) await new Promise((r) => setTimeout(r, opts.productDelay));
      body = { ok: true, products: [PRODUCT], storeName: 'Tabon Store', storeOpen: true };
    } else if (action === 'listProductReviews') {
      if (opts.reviewDelay) await new Promise((r) => setTimeout(r, opts.reviewDelay));
      body = Object.assign({ ok: true, reviews: [], count: 0, average: 0 }, opts.reviews || {});
    } else if (action === 'searchProducts') {
      // Something to show, or loadRelated() hides the section again and the
      // "row sits above Similar products" check has nothing to compare with.
      body = { ok: true, products: [Object.assign({}, PRODUCT, {
        productId: 'p2', name: 'Solar Fan', storeSlug: 'tabon', storeName: 'Tabon Store'
      })] };
    }
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  const page = await ctx.newPage();
  await page.addInitScript(() => { try {
    localStorage.setItem('skiri_cookie_consent', 'true');
  } catch (e) {} });
  await page.goto(BASE + '/product.html?store=tabon&product=p1', { waitUntil: 'load' });
  return { ctx, page };
}

const box = (page, sel) => page.evaluate((s) => {
  const el = document.querySelector(s);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
}, sel);

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

  // ---- THE ONE THAT MATTERS: the score arriving must not move the link -----
  {
    const { ctx, page } = await open(browser, 390, { reviewDelay: 900 });
    // Product data is in; reviews are still out.
    await page.waitForSelector('#reviews-section:not([hidden])', { timeout: 5000 });
    const before = await box(page, '.view-store-row');
    ok('the score really is still empty at this point',
      (await page.textContent('#reviews-toggle-score')) === '',
      JSON.stringify(await page.textContent('#reviews-toggle-score')));

    await page.waitForFunction(() =>
      (document.getElementById('reviews-toggle-score') || {}).textContent === 'No reviews yet',
      null, { timeout: 5000 });
    await page.waitForTimeout(200);
    const after = await box(page, '.view-store-row');

    ok('the score text did arrive after the row had painted', !!before && !!after);
    ok('and the store link did not move sideways',
      before && after && before.x === after.x, JSON.stringify([before, after]));
    ok('nor down', before && after && before.y === after.y, JSON.stringify([before, after]));
    await ctx.close();
  }

  // ---- and not with a real score either -----------------------------------
  {
    const { ctx, page } = await open(browser, 390, {
      reviewDelay: 900,
      reviews: { count: 12, average: 4.5, distribution: [0, 0, 1, 4, 7], reviews: [] }
    });
    await page.waitForSelector('#reviews-section:not([hidden])', { timeout: 5000 });
    const before = await box(page, '.view-store-row');
    await page.waitForFunction(() =>
      /12 reviews/.test((document.getElementById('reviews-toggle-score') || {}).textContent || ''),
      null, { timeout: 5000 });
    await page.waitForTimeout(200);
    const after = await box(page, '.view-store-row');
    ok('a long score ("4.5 - 12 reviews") does not move the link either',
      before && after && before.x === after.x && before.y === after.y,
      JSON.stringify([before, after]));
    await ctx.close();
  }

  // ---- it is above Similar products now ------------------------------------
  {
    const { ctx, page } = await open(browser, 390);
    await page.waitForSelector('#related-section', { timeout: 5000 });
    await page.waitForTimeout(700);
    const row = await box(page, '.product-meta-row');
    const related = await box(page, '#related-section');
    const detail = await box(page, '#product-detail');
    ok('the row sits above Similar products', row && related && row.y < related.y,
      JSON.stringify([row, related]));
    ok('and below the product itself', row && detail && row.y >= detail.y + detail.h - 2,
      JSON.stringify([detail, row]));
    ok('the store link is inside that row, not loose below the page',
      await page.evaluate(() =>
        !!document.querySelector('.product-meta-row > .view-store-row')));
    ok('and so is the reviews section',
      await page.evaluate(() =>
        !!document.querySelector('.product-meta-row > #reviews-section')));
    await ctx.close();
  }

  // ---- smaller text --------------------------------------------------------
  {
    const { ctx, page } = await open(browser, 390);
    await page.waitForTimeout(900);
    const sizes = await page.evaluate(() => {
      const px = (s) => {
        const el = document.querySelector(s);
        return el ? parseFloat(getComputedStyle(el).fontSize) : null;
      };
      return {
        title: px('.reviews-toggle-title'),
        score: px('.reviews-toggle-score'),
        link: px('#view-store-link')
      };
    });
    ok('the heading is 14px', sizes.title === 14, String(sizes.title));
    ok('the score is 14px', sizes.score === 14, String(sizes.score));
    ok('the store link is 14px', sizes.link === 14, String(sizes.link));
    await ctx.close();
  }

  // ---- still tappable ------------------------------------------------------
  {
    const { ctx, page } = await open(browser, 390);
    await page.waitForTimeout(900);
    const t = await box(page, '.reviews-toggle');
    const l = await box(page, '.view-store-row');
    ok('the ratings toggle is still at least 44px tall', t && t.h >= 44, JSON.stringify(t));
    ok('and so is the store link row', l && l.h >= 44, JSON.stringify(l));
    await ctx.close();
  }

  // ---- side by side where there is room, stacked where there is not --------
  for (const w of [390, 768, 1280]) {
    const { ctx, page } = await open(browser, w);
    await page.waitForTimeout(900);
    const t = await box(page, '.reviews-toggle');
    const l = await box(page, '.view-store-row');
    const sameLine = t && l && Math.abs(t.y - l.y) < 10;
    if (w === 390) {
      ok('at 390px the two wrap onto separate lines', !sameLine, JSON.stringify([t, l]));
      ok('and the whole row is no taller than two lines', (await box(page, '.product-meta-row')).h <= 110);
    } else {
      ok('at ' + w + 'px they share one line', sameLine, JSON.stringify([t, l]));
      ok('at ' + w + 'px the link is on the right-hand side',
        l && t && l.x > t.x + t.w / 2, JSON.stringify([t, l]));
    }
    await ctx.close();
  }

  // ---- opening it still works and still shows the body ---------------------
  {
    const { ctx, page } = await open(browser, 1280);
    await page.waitForTimeout(900);
    ok('shut on arrival', await page.evaluate(() => !document.getElementById('reviews-section').open));
    await page.click('.reviews-toggle');
    await page.waitForTimeout(300);
    ok('tapping it opens', await page.evaluate(() => document.getElementById('reviews-section').open));
    ok('and the body is visible', await page.locator('.reviews-body').isVisible());
    const body = await box(page, '.reviews-body');
    const row = await box(page, '.product-meta-row');
    ok('the opened body uses the full width, not half a row',
      body && row && body.w > row.w * 0.9, JSON.stringify([row, body]));
    ok('the empty state still reads properly',
      /Be the first to review/.test(await page.textContent('#reviews-summary') || ''));
    await ctx.close();
  }

  // ---- the link still points at the store ---------------------------------
  {
    const { ctx, page } = await open(browser, 390);
    await page.waitForTimeout(900);
    ok('the store link still points at the store it came from',
      /store\.html\?store=tabon/.test(await page.getAttribute('#view-store-link', 'href') || ''),
      await page.getAttribute('#view-store-link', 'href'));
    await ctx.close();
  }

  // ---- hidden until the card renders, and CLS is the reason --------------
  //
  // Left visible from the start, the row sat above an empty #product-detail and
  // was then pushed down the whole height of the product card. That measured
  // 0.1137 at 390px - over the 0.1 target, and four times the 0.0262 of the
  // loose link it replaced. Revealed in the same task as the card, it is 0.
  {
    const { ctx, page } = await open(browser, 390, { productDelay: 2500 });
    ok('the row is still hidden while the product is loading',
      await page.evaluate(() => {
        const r = document.getElementById('product-meta-row');
        return !!r && r.hidden;
      }));
    await page.waitForSelector('#product-meta-row:not([hidden])', { timeout: 6000 });
    ok('and is shown once the product card is there',
      await page.evaluate(() => (document.getElementById('product-detail') || {}).children.length > 0));
    await ctx.close();
  }

  for (const w of [390, 768, 1280]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: 844 } });
    await ctx.route('**/macros/s/**', async (route) => {
      const a = new URL(route.request().url()).searchParams.get('action');
      await new Promise((r) => setTimeout(r, 600));   // so every fetch lands after paint
      let body = { ok: true };
      if (a === 'listProducts') body = { ok: true, products: [PRODUCT], storeName: 'Tabon Store', storeOpen: true };
      else if (a === 'listProductReviews') body = { ok: true, reviews: [], count: 0, average: 0 };
      else if (a === 'searchProducts') body = { ok: true, products: Array.from({ length: 6 }, (_, i) =>
        Object.assign({}, PRODUCT, { productId: 'r' + i, name: 'Item ' + i, storeSlug: 'tabon', storeName: 'Tabon Store' })) };
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });
    const page = await ctx.newPage();
    await page.addInitScript(() => { try { localStorage.setItem('skiri_cookie_consent', 'true'); } catch (e) {} });
    await page.addInitScript(() => {
      window.__cls = 0;
      new PerformanceObserver((l) => {
        for (const e of l.getEntries()) if (!e.hadRecentInput) window.__cls += e.value;
      }).observe({ type: 'layout-shift', buffered: true });
    });
    await page.goto(BASE + '/product.html?store=tabon&product=p1', { waitUntil: 'load' });
    await page.waitForTimeout(4500);
    const cls = await page.evaluate(() => +window.__cls.toFixed(4));
    // The measured baseline before this change was 0.0262 / 0.0274 / 0.0238.
    ok('CLS at ' + w + 'px is no worse than the 0.0274 this replaced',
      cls <= 0.0274, String(cls));
    await ctx.close();
  }

  await browser.close();
  console.log('\n' + pass + '/' + (pass + fail) + ' passed');
  process.exit(fail ? 1 : 0);
})();
