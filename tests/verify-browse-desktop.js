/**
 * Featured as the default category, and the browse page filling a real screen.
 *
 * THE ASSERTION THAT MATTERS MOST is the fallback. Featured holds only what an
 * admin has hand-picked, so the day the sheet is empty - which is today - a
 * Featured default means Browse opens blank and a shopper backs straight out.
 * So: open on Featured, and when the curated list comes back with nothing,
 * move to the first real category instead. Both halves are driven here, with
 * the curated request deliberately slow so the switch is observable rather
 * than inferred.
 *
 * Second: the page must actually fill the window. .category-browser is a flex
 * item of #main, and auto side margins on a flex item stop it stretching - the
 * same trap .home-main hit on the tips page - so it collapsed to 427px in a
 * 1920px window the moment the tiles were free to size themselves. Measured at
 * eight widths rather than asserted from the CSS.
 */
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = 'http://127.0.0.1:8099';
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('PASS  ' + name + (detail ? '  [' + detail + ']' : '')); }
  else { fail++; console.log('FAIL  ' + name + (detail ? '  [' + detail + ']' : '')); }
};

const P = (id, cat, name) => ({ productId: id, name: name || ('Item ' + id), description: 'x',
  category: cat, status: 'active', imageUrl: '', listingType: 'product', storeSlug: 'bong',
  storeName: 'Bong Store', island: 'Tarawa', village: 'Bairiki',
  variants: [{ variantId: 'v' + id, label: 'one', price: 5 }],
  rating: null, reviewCount: 0, views: 1, createdAt: '2026-01-01' });

async function open(browser, path, opts) {
  opts = opts || {};
  const ctx = await browser.newContext({ viewport: { width: opts.width || 390, height: opts.height || 900 } });
  const asked = [];
  await ctx.route('**/macros/s/**', async (r) => {
    let a = '', cat = null;
    try { const u = new URL(r.request().url()); a = u.searchParams.get('action') || ''; cat = u.searchParams.get('category'); } catch (e) {}
    asked.push({ action: a, category: cat });
    const J = (o) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
    if (a === 'getTips') {
      // Slow on purpose: the fallback happens after this answers, so an
      // instant reply would make the switch unobservable.
      if (opts.tipsDelay) await new Promise((x) => setTimeout(x, opts.tipsDelay));
      return J({ ok: true, products: opts.featured || [], stores: [], tips: [] });
    }
    if (a === 'searchProducts') {
      return J({ ok: true, products: Array.from({ length: opts.count || 24 }, (_, i) => P('p' + i, cat)) });
    }
    J({ ok: true });
  });
  const page = await ctx.newPage();
  await page.addInitScript(() => { try { localStorage.setItem('skiri_cookie_consent', 'true'); } catch (e) {} });
  await page.goto(BASE + path, { waitUntil: 'load' });
  await page.waitForTimeout(opts.settle || 1100);
  return { ctx, page, asked };
}

const selected = (page) => page.evaluate(() =>
  (document.querySelector('.category-rail-item.is-selected') || {}).dataset?.category || null);

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

  /* ---- Featured is the default ------------------------------------------ */
  {
    const { ctx, page } = await open(browser, '/categories.html',
      { featured: [P('f1', 'solar', 'Solar Panel'), P('f2', 'food', 'Local Rice')] });
    ok('with items curated, Browse opens on Featured', (await selected(page)) === 'featured',
      String(await selected(page)));
    const names = await page.$$eval('#category-list a', (els) => els.map((e) => e.textContent.trim()));
    ok('and shows them', names.length === 2 && /Solar Panel/.test(names.join('|')), names.join(' | '));
    ok('the heading says Featured',
      (await page.$eval('#category-pane-heading', (e) => e.textContent.trim())) === 'Featured');
    await ctx.close();
  }

  /* ---- ...with a floor under it ----------------------------------------- */
  {
    const { ctx, page, asked } = await open(browser, '/categories.html',
      { featured: [], tipsDelay: 400, settle: 1800 });
    const sel = await selected(page);
    ok('NOTHING CURATED: it does not leave the shopper on a blank Featured page',
      sel !== 'featured', String(sel));
    ok('...it falls back to the first real category', sel === 'food', String(sel));
    ok('and that category actually loaded',
      (await page.$$eval('#category-list a', (els) => els.length)) > 0);
    ok('the heading followed it',
      (await page.$eval('#category-pane-heading', (e) => e.textContent.trim())) === 'Food & Groceries',
      await page.$eval('#category-pane-heading', (e) => e.textContent.trim()));
    // It must not have asked the backend for a category called "featured".
    ok('no request was made for a category that does not exist',
      !asked.some((c) => c.action === 'searchProducts' && c.category === 'featured'),
      JSON.stringify(asked.filter((c) => c.action === 'searchProducts').map((c) => c.category)));
    await ctx.close();
  }

  /* ---- a tap during the wait wins over the fallback ---------------------- */
  {
    const { ctx, page } = await open(browser, '/categories.html',
      { featured: [], tipsDelay: 900, settle: 150 });
    await page.click('.category-rail-item[data-category="fishing"]');
    await page.waitForTimeout(1400);
    ok('a category tapped while the curated list was loading is not overridden',
      (await selected(page)) === 'fishing', String(await selected(page)));
    await ctx.close();
  }

  /* ---- an explicit link still wins --------------------------------------- */
  {
    const { ctx, page } = await open(browser, '/categories.html?category=vehicles',
      { featured: [P('f1', 'solar', 'Solar Panel')] });
    ok('?category= in the URL beats the Featured default',
      (await selected(page)) === 'vehicles', String(await selected(page)));
    await ctx.close();
  }
  {
    const { ctx, page } = await open(browser, '/categories.html?category=featured', { featured: [] });
    ok('an explicit ?category=featured is respected even when empty',
      (await selected(page)) === 'featured', String(await selected(page)));
    ok('and says so rather than showing nothing',
      /Nothing featured right now/.test(await page.$eval('#category-status', (e) => e.textContent)),
      await page.$eval('#category-status', (e) => e.textContent));
    await ctx.close();
  }

  /* ---- the page fills the window ----------------------------------------- */
  const rows = [];
  for (const width of [320, 390, 600, 768, 1024, 1280, 1440, 1920]) {
    const { ctx, page } = await open(browser, '/categories.html?category=food', { width: width });
    const g = await page.evaluate(() => {
      const br = document.querySelector('.category-browser').getBoundingClientRect();
      const tiles = [...document.getElementById('category-list').children];
      const top = tiles.length ? Math.round(tiles[0].getBoundingClientRect().top) : 0;
      return {
        browserW: Math.round(br.width),
        perRow: tiles.filter((t) => Math.round(t.getBoundingClientRect().top) === top).length,
        tileW: tiles.length ? Math.round(tiles[0].getBoundingClientRect().width) : 0,
        vw: window.innerWidth,
        overflow: document.documentElement.scrollWidth > window.innerWidth + 1
      };
    });
    rows.push({ width, ...g });
    // Up to the 1600 ceiling the panes take the whole window.
    const expected = Math.min(width, 1600);
    ok('the browser fills the window @' + width,
      Math.abs(g.browserW - expected) <= 2, g.browserW + ' of ' + expected);
    ok('and nothing scrolls sideways @' + width, g.overflow === false);
    ok('tiles are a usable size @' + width, g.tileW >= 78, g.tileW + 'px');
    await ctx.close();
  }
  // The point of letting them size themselves: more room must never mean fewer.
  ok('tiles per row never decreases as the window grows',
    rows.every((r, i) => i === 0 || r.perRow >= rows[i - 1].perRow),
    rows.map((r) => r.width + ':' + r.perRow).join(' '));
  ok('a wide screen shows meaningfully more than a phone',
    rows[rows.length - 1].perRow >= rows[1].perRow * 2,
    rows.map((r) => r.width + ':' + r.perRow).join(' '));
  ok('and it stops widening at the ceiling rather than running on forever',
    rows[rows.length - 1].browserW === 1600, String(rows[rows.length - 1].browserW));

  /* ---- the header title ---------------------------------------------------- */
  for (const width of [320, 390, 768, 1366]) {
    const ctx = await browser.newContext({ viewport: { width: width, height: 844 } });
    await ctx.route('**/macros/s/**', (r) => r.fulfill({
      status: 200, contentType: 'application/json', body: '{"ok":true,"products":[],"stores":[]}' }));
    const page = await ctx.newPage();
    await page.addInitScript(() => { try {
      localStorage.setItem('skiri_cookie_consent', 'true');
      localStorage.setItem('skiri_cart_bong', JSON.stringify([{ productId: 'p', qty: 2 }]));
    } catch (e) {} });
    await page.goto(BASE + '/index.html', { waitUntil: 'load' });
    await page.waitForTimeout(700);
    const h = await page.evaluate(() => {
      const box = (s) => {
        const e = document.querySelector(s);
        if (!e || getComputedStyle(e).display === 'none') return null;
        const b = e.getBoundingClientRect();
        return { l: Math.round(b.left), r: Math.round(b.right) };
      };
      const t = box('.header-title');
      return {
        title: t, logo: box('.header-logo-link'), cart: box('#header-cart-link'), menu: box('#header-menu-btn'),
        centre: t ? Math.round((t.l + t.r) / 2) : null,
        vw: window.innerWidth,
        rows: document.querySelectorAll('header.site-header > .container').length,
        clickable: getComputedStyle(document.querySelector('.header-title')).pointerEvents
      };
    });
    ok('the title is centred on the page @' + width,
      Math.abs(h.centre - h.vw / 2) <= 1, h.centre + ' vs ' + h.vw / 2);
    ok('it clears the logo @' + width, h.title.l > h.logo.r, h.logo.r + ' -> ' + h.title.l);
    const rightEdge = (h.cart || h.menu).l;
    ok('and clears the cart and the menu @' + width, h.title.r < rightEdge, h.title.r + ' -> ' + rightEdge);
    // It sits over the corner controls' row, so it must not eat their taps.
    ok('and cannot swallow a tap meant for them @' + width, h.clickable === 'none', h.clickable);
    ok('the header is one row now, not two @' + width, h.rows === 1, String(h.rows));
    await ctx.close();
  }

  await browser.close();
  console.log('\n' + rows.map((r) => r.width + 'px: ' + r.perRow + ' tiles @' + r.tileW + 'px').join('\n'));
  console.log('\n' + pass + '/' + (pass + fail) + ' passed');
  process.exit(fail ? 1 : 0);
})();
