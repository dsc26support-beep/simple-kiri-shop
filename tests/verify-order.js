const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = 'http://127.0.0.1:8099';

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const ctx = await browser.newContext({ serviceWorkers: 'block' });
  await ctx.route('**/macros/s/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, products: [], stores: [] }) }));

  const results = [];
  const ok = (n, c, e) => results.push([c ? 'PASS' : 'FAIL', n, e || '']);

  async function tops(page) {
    return page.evaluate(() => {
      const t = (s) => { const el = document.querySelector(s); return el ? Math.round(el.getBoundingClientRect().top) : null; };
      return {
        hero: t('.hero'), quickActions: t('.home-quick-actions'),
        stores: t('.trending-stores'),
        products: t('.trending-products')
      };
    });
  }

  async function measure(w, h, label) {
    const page = await ctx.newPage();
    await page.setViewportSize({ width: w, height: h });
    await page.goto(BASE + '/index.html', { waitUntil: 'load' });
    await page.waitForSelector('.quick-action-item');
    const t = await tops(page);
    await page.close();
    return { t, label };
  }

  const mob = await measure(390, 800, 'mobile');
  // Reversed on purpose: search leads now. Someone who knows what they want
  // should not scroll past two rows of navigation to type it. The full chain,
  // Alibaba-inspired: search -> quick actions -> discovery (Popular Stores,
  // moved up) -> product grid. Popular Categories, the Tips pill and the
  // trust strip were removed from the homepage by request (the trust lines
  // live in the header ticker now).
  // Owner request, 28 Oct 2026, every screen size: tabs (quick actions)
  // right under the yellow strip, then search, Popular Stores, products.
  const chain = (t) => t.quickActions < t.hero && t.hero < t.stores && t.stores < t.products;
  ok('mobile: search above products', mob.t.hero < mob.t.products, JSON.stringify(mob.t));
  ok('mobile: tabs, search, Popular Stores, products', chain(mob.t), JSON.stringify(mob.t));

  const tab = await measure(900, 1200, 'tablet');
  // Wider than a phone (Oct 2026, owner request): Popular Stores right under
  // the header, above the search. Phones keep search first (checked above).
  ok('tablet: tabs, search, Popular Stores, products', chain(tab.t), JSON.stringify(tab.t));

  const desk = await measure(1280, 900, 'desktop');
  ok('desktop: tabs, search, Popular Stores, products', chain(desk.t), JSON.stringify(desk.t));
  ok('desktop: discovery above products',
    desk.t.stores < desk.t.products, JSON.stringify(desk.t));

  // Gap check: every adjacent pair in the mobile flow should show the added
  // row-gap, not just the first pair - the restructure added sections between
  // search and the product grid.
  const page = await ctx.newPage();
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto(BASE + '/index.html', { waitUntil: 'load' });
  await page.waitForSelector('.quick-action-item');
  const gaps = await page.evaluate(() => {
    const r = (s) => document.querySelector(s).getBoundingClientRect();
    const hero = r('.hero'), qa = r('.home-quick-actions'),
      stores = r('.trending-stores'),
      prod = r('.trending-products');
    return {
      qaToHero: Math.round(hero.top - qa.bottom),
      heroToStores: Math.round(stores.top - hero.bottom),
      storesToProd: Math.round(prod.top - stores.bottom)
    };
  });
  await page.close();
  // The app-style layout (28 Oct 2026) is tighter: row-gap var(--space-3)
  // = 12px between flex items, the only spacer where a section zeroes its own
  // padding - so every pair keeps at least that.
  Object.keys(gaps).forEach((k) => {
    ok('mobile: spacer ' + k + ' (>=12px)', gaps[k] >= 12, k + '=' + gaps[k]);
  });

  await browser.close();
  console.log('\n--- home section order/spacing ---');
  let failed = 0;
  for (const [st, n, e] of results) { if (st === 'FAIL') failed++; console.log(`${st}  ${n}${e ? '  [' + e + ']' : ''}`); }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
