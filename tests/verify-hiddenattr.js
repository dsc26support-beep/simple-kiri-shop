// el.hidden must actually hide.
//
// The browser's own [hidden] rule is `display: none` at the bottom of the
// cascade, so any class setting display outranks it and the element stays on
// screen doing nothing. That is how the "More..." pill sat in the corner of a
// two-product category: .btn made it a flex box.
//
// So the assertions are in pairs. Hiding a thing is easy; the risk of a
// blunt global rule is that something which SHOULD be visible now is not.
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = 'http://127.0.0.1:8099';

const mk = (n) => Array.from({ length: n }, (_, i) => ({
  productId: 'p' + i, name: 'Necklace ' + i, description: 'x', category: 'fashion',
  listingType: 'product', imageUrls: [], storeSlug: 'a', storeName: 'A',
  variants: [{ variantId: 'v' + i, label: 'One', price: 20 }],
  storeDeliveryTruck: true
}));

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e || '']);

  async function open(path, products, width = 390) {
    const ctx = await browser.newContext({ viewport: { width, height: 844 } });
    await ctx.route('**/macros/s/**', (r) => {
      let a = '';
      try { a = (r.request().postDataJSON() || {}).action; } catch (e) {}
      try { if (!a) a = new URL(r.request().url()).searchParams.get('action') || ''; } catch (e) {}
      let body = { ok: true, products: [], stores: [] };
      if (a === 'searchProducts') body = { ok: true, products };
      if (a === 'listProducts') body = { ok: true, storeName: 'A', storeSlug: 'a', storeOpen: true, products };
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });
    const page = await ctx.newPage();
    await page.goto(BASE + path, { waitUntil: 'load' });
    await page.waitForTimeout(900);
    return { ctx, page };
  }

  const box = (sel) => {
    const e = document.querySelector(sel);
    if (!e) return null;
    const r = e.getBoundingClientRect();
    return { hidden: e.hidden, display: getComputedStyle(e).display,
             w: Math.round(r.width), h: Math.round(r.height) };
  };

  // ---- the button in the screenshot: small category, nothing more to show ----
  {
    const { ctx, page } = await open('/categories.html?category=fashion', mk(2));
    const m = await page.evaluate(box, '#category-more');
    ok('small category: More... is marked hidden', m.hidden === true, JSON.stringify(m));
    ok('small category: and it really is gone, not just marked',
      m.display === 'none' && m.w === 0 && m.h === 0, JSON.stringify(m));
    await ctx.close();
  }

  // ---- big category: it must still appear, or paging is unreachable ----
  {
    const { ctx, page } = await open('/categories.html?category=fashion', mk(40));
    const m = await page.evaluate(box, '#category-more');
    ok('big category: More... is NOT hidden', m.hidden === false, JSON.stringify(m));
    ok('big category: and it is visible and tappable',
      m.display !== 'none' && m.w > 40 && m.h >= 30, JSON.stringify(m));

    const after = await page.evaluate(async () => {
      const before = document.querySelectorAll('#category-list .category-tile').length;
      document.getElementById('category-more').click();
      await new Promise((r) => setTimeout(r, 300));
      return { before, now: document.querySelectorAll('#category-list .category-tile').length };
    });
    ok('big category: clicking it still reveals more products',
      after.now > after.before, JSON.stringify(after));
    await ctx.close();
  }

  // ---- the two other pages this global rule also fixes ----
  {
    const { ctx, page } = await open('/search.html?category=fashion', mk(40));
    const tb = await page.evaluate(box, '#results-toolbar');
    ok('search: the results toolbar shows once there are results',
      tb.hidden === false && tb.display !== 'none', JSON.stringify(tb));

    const cnt = await page.evaluate(box, '#filters-count');
    ok('search: the filter count badge stays hidden at zero filters',
      cnt.hidden === true && cnt.display === 'none' && cnt.w === 0, JSON.stringify(cnt));

    const panel = await page.evaluate(box, '#filters-panel');
    ok('search: the filter panel is hidden until asked for',
      panel.hidden === true && panel.display === 'none', JSON.stringify(panel));

    // ...and opens properly when asked.
    await page.click('#filters-toggle');
    await page.waitForTimeout(250);
    const open2 = await page.evaluate(box, '#filters-panel');
    ok('search: and it opens on tap', open2.hidden === false && open2.display !== 'none',
      JSON.stringify(open2));

    const more = await page.evaluate(box, '#results-more');
    ok('search: the Load more row is visible with 40 results',
      more.hidden === false && more.display !== 'none', JSON.stringify(more));
    await ctx.close();
  }

  // ---- nothing that was visible went missing ----
  {
    const { ctx, page } = await open('/search.html?category=fashion', mk(2));
    const g = await page.evaluate(() => {
      const b = (s) => { const e = document.querySelector(s); if (!e) return null;
        const r = e.getBoundingClientRect();
        return { hidden: e.hidden, display: getComputedStyle(e).display, h: Math.round(r.height) }; };
      return { toolbar: b('#results-toolbar'), more: b('#results-more'),
               tiles: document.querySelectorAll('.product-card, .browse-card').length };
    });
    ok('search with 2 results: toolbar still shown', g.toolbar.display !== 'none', JSON.stringify(g.toolbar));
    ok('search with 2 results: Load more correctly hidden',
      g.more.hidden === true && g.more.display === 'none', JSON.stringify(g.more));
    await ctx.close();
  }

  // ---- desktop: the button lives in the page, not the nav slot ----
  {
    const { ctx, page } = await open('/categories.html?category=fashion', mk(40), 1280);
    const m = await page.evaluate(() => {
      const e = document.getElementById('category-more');
      return { parent: e.parentElement.className, display: getComputedStyle(e).display };
    });
    ok('desktop: More... sits in the page row and is visible',
      /load-more-row/.test(m.parent) && m.display !== 'none', JSON.stringify(m));
    await ctx.close();
  }

  await browser.close();
  console.log('\n--- [hidden] actually hides ---');
  let f = 0;
  for (const [s, n, e] of R) { if (s === 'FAIL') f++; console.log(`${s}  ${n}${e ? '  [' + e + ']' : ''}`); }
  console.log(`\n${R.length - f}/${R.length} passed`);
  process.exit(f ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
