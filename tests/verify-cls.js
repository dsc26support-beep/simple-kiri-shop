// Layout stability on the product page.
//
// This exists because the similar-products carousel was added with no reserved
// height and pushed everything below it 628px - measured as 0.0388 of a 0.0727
// CLS. The fix was a skeleton built from the same .related-card box, so the
// reservation tracks the card width instead of being a fixed pixel height that
// is right at one viewport and wrong at every other.
//
// It asserts the METRIC, not the implementation, so a future refactor is free
// to reserve the space some other way - it just cannot go back to not
// reserving it.
const fs = require('fs');
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = 'http://127.0.0.1:8099';
const REPO = '/home/user/simple-kiri-shop/';
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e || '']);

// Comfortably under the 0.1 "good" threshold, and above the 0.0246 measured
// after the fix - so ordinary noise does not fail the build, but losing the
// reservation (which cost 0.0388 on its own) does.
const BUDGET = 0.05;

const mk = (id) => ({
  productId: id, name: 'Item ' + id, category: 'food', description: 'tasty',
  listingType: 'product', imageUrl: '', storeSlug: 'bong', storeName: 'Bong Store',
  storeIsland: 'South Tarawa', storeVillage: 'Bairiki',
  variants: [{ variantId: 'v' + id, label: 'small', price: 8 }],
  rating: null, reviewCount: 0, views: 1, createdAt: '2026-01-01'
});

async function load(browser, width, relatedCount) {
  const ctx = await browser.newContext({ viewport: { width, height: 844 } });
  await ctx.route('**/macros/s/**', async (r) => {
    let a = ''; try { a = new URL(r.request().url()).searchParams.get('action') || ''; } catch (e) {}
    try { const j = r.request().postDataJSON(); if (!a && j) a = j.action; } catch (e) {}
    // Real latency. With an instant backend the content lands before the
    // browser has painted anything, and every shift measures as zero - the bug
    // this guards would sail straight through.
    await new Promise((x) => setTimeout(x, 600));
    const J = (o) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
    if (a === 'listProducts') {
      return J({ ok: true, storeName: 'Bong Store', storeOpen: true, storePhone: '73007552',
        storeDeliveryPickPay: true, products: [mk('p1')] });
    }
    if (a === 'searchProducts') {
      return J({ ok: true, products: [mk('p1')].concat(Array.from({ length: relatedCount }, (_, i) => mk('r' + i))) });
    }
    if (a === 'listProductReviews') return J({ ok: true, reviews: [], average: null, count: 0, distribution: [0,0,0,0,0] });
    return J({ ok: true });
  });
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    localStorage.setItem('skiri_cookie_consent', 'true');
    window.__cls = 0;
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) if (!e.hadRecentInput) window.__cls += e.value;
    }).observe({ type: 'layout-shift', buffered: true });
  });
  await page.goto(BASE + '/product.html?store=bong&product=p1', { waitUntil: 'load' });
  await page.waitForTimeout(3000);
  return { ctx, page };
}

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

  // The case that matters: a category with other products in it.
  for (const w of [390, 768, 1280]) {
    const { ctx, page } = await load(browser, w, 8);
    const cls = await page.evaluate(() => window.__cls || 0);
    ok(`${w}px: CLS within budget with similar products present`,
      cls < BUDGET, cls.toFixed(4) + ' (budget ' + BUDGET + ')');
    const cards = await page.locator('#related-list .related-card:not(.related-card--skeleton)').count();
    ok(`${w}px: and the carousel really did fill`, cards === 8, String(cards));
    await ctx.close();
  }

  // The skeleton has to be up BEFORE the response lands, or it reserves
  // nothing. Checked at 300ms against a 600ms backend.
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await ctx.route('**/macros/s/**', async (r) => {
      let a = ''; try { a = new URL(r.request().url()).searchParams.get('action') || ''; } catch (e) {}
      try { const j = r.request().postDataJSON(); if (!a && j) a = j.action; } catch (e) {}
      const J = (o) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
      if (a === 'listProducts') {
        return J({ ok: true, storeName: 'Bong', storeOpen: true, products: [mk('p1')] });
      }
      await new Promise((x) => setTimeout(x, 2500));   // similar products: slow
      if (a === 'searchProducts') {
        return J({ ok: true, products: Array.from({ length: 8 }, (_, i) => mk('r' + i)) });
      }
      return J({ ok: true });
    });
    const page = await ctx.newPage();
    await page.addInitScript(() => localStorage.setItem('skiri_cookie_consent', 'true'));
    await page.goto(BASE + '/product.html?store=bong&product=p1', { waitUntil: 'load' });
    await page.waitForTimeout(1200);
    const m = await page.evaluate(() => {
      const sec = document.getElementById('related-section');
      const skel = document.querySelectorAll('.related-card--skeleton').length;
      return { visible: !sec.hidden, skeletons: skel, h: Math.round(sec.getBoundingClientRect().height) };
    });
    ok('the shelf is reserved while the request is still out', m.visible, 'section hidden');
    ok('with skeleton cards holding the height', m.skeletons === 3, String(m.skeletons));
    ok('and the reserved height is a real row, not a sliver', m.h > 150, m.h + 'px');
    await ctx.close();
  }

  // A category with nothing else in it must not leave grey boxes up forever.
  {
    const { ctx, page } = await load(browser, 390, 0);
    const hidden = await page.locator('#related-section').isHidden();
    const skel = await page.locator('.related-card--skeleton').count();
    ok('an empty category takes the shelf back down', hidden, 'still showing');
    ok('and leaves no skeletons behind', skel === 0, String(skel));
    await ctx.close();
  }

  await browser.close();

  // The skeleton must track the card width, not a hardcoded height.
  const css = fs.readFileSync(REPO + 'assets/css/styles.css', 'utf8');
  const block = (css.match(/\.related-card--skeleton \.related-skeleton-image \{[\s\S]*?\}/) || [''])[0];
  ok('the skeleton image uses aspect-ratio, like the real one',
    /aspect-ratio: 1 \/ 1/.test(block), block.slice(0, 60));
  ok('and no fixed pixel height is baked into the shelf',
    !/\.related-(section|carousel)[^{]*\{[^}]*min-height: *\d+px/.test(css));
  // No shimmer: it would burn CPU on the phones this is meant to help.
  ok('the skeleton does not animate', !/related-skeleton[^{]*\{[^}]*animation/.test(css));

  let pass = 0;
  for (const [s, n, e] of R) { if (s === 'PASS') pass++; console.log(`${s}  ${n}${e ? '  [' + e + ']' : ''}`); }
  console.log(`\n${pass}/${R.length} passed`);
  process.exit(pass === R.length ? 0 : 1);
})();
