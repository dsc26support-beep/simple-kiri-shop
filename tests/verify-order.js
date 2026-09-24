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
        hero: t('.hero'), promo: t('.home-promo'), quickActions: t('.home-quick-actions'),
        trust: t('.home-trust'), categories: t('.categories'), stores: t('.trending-stores'),
        products: t('.trending-products')
      };
    });
  }

  async function measure(w, h, label) {
    const page = await ctx.newPage();
    await page.setViewportSize({ width: w, height: h });
    await page.goto(BASE + '/index.html', { waitUntil: 'load' });
    await page.waitForSelector('#category-strip .chip-strip-item');
    const t = await tops(page);
    await page.close();
    return { t, label };
  }

  const mob = await measure(390, 800, 'mobile');
  // Reversed on purpose: search leads now. Someone who knows what they want
  // should not scroll past two rows of navigation to type it. The full chain,
  // Alibaba-inspired: search -> promo -> quick actions -> trust -> categories
  // -> discovery (Popular Stores, moved up) -> product grid.
  ok('mobile: search above everything else', mob.t.hero < mob.t.categories, JSON.stringify(mob.t));
  ok('mobile: search above products', mob.t.hero < mob.t.products, JSON.stringify(mob.t));
  ok('mobile: full section chain is in order',
    mob.t.hero < mob.t.promo && mob.t.promo <= mob.t.quickActions &&
    mob.t.quickActions <= mob.t.trust && mob.t.trust <= mob.t.categories &&
    mob.t.categories < mob.t.stores && mob.t.stores < mob.t.products,
    JSON.stringify(mob.t));

  const tab = await measure(900, 1200, 'tablet');
  ok('tablet: search above categories', tab.t.hero < tab.t.categories, JSON.stringify(tab.t));

  const desk = await measure(1280, 900, 'desktop');
  ok('desktop: search above categories (original)', desk.t.hero < desk.t.categories, JSON.stringify(desk.t));
  ok('desktop: categories above discovery above products',
    desk.t.categories < desk.t.stores && desk.t.stores < desk.t.products, JSON.stringify(desk.t));

  // Gap check: every adjacent pair in the mobile flow should show the added
  // row-gap, not just hero->categories as before - there are more neighbours
  // now that the restructure added sections between them.
  const page = await ctx.newPage();
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto(BASE + '/index.html', { waitUntil: 'load' });
  await page.waitForSelector('#category-strip .chip-strip-item');
  const gaps = await page.evaluate(() => {
    const r = (s) => document.querySelector(s).getBoundingClientRect();
    const hero = r('.hero'), promo = r('.home-promo'), qa = r('.home-quick-actions'),
      trust = r('.home-trust'), cat = r('.categories'), stores = r('.trending-stores'),
      prod = r('.trending-products');
    return {
      heroToPromo: Math.round(promo.top - hero.bottom),
      promoToQa: Math.round(qa.top - promo.bottom),
      qaToTrust: Math.round(trust.top - qa.bottom),
      trustToCat: Math.round(cat.top - trust.bottom),
      catToStores: Math.round(stores.top - cat.bottom),
      storesToProd: Math.round(prod.top - stores.bottom)
    };
  });
  await page.close();
  // row-gap var(--space-4)=1.5rem=24px is added between flex items; every gap
  // should be >= ~24 (some sections zero their own top/bottom padding, so the
  // row-gap is the only spacer between them - exactly what this checks for).
  Object.keys(gaps).forEach((k) => {
    ok('mobile: extra spacer ' + k + ' (>=24px)', gaps[k] >= 24, k + '=' + gaps[k]);
  });

  await browser.close();
  console.log('\n--- home section order/spacing ---');
  let failed = 0;
  for (const [st, n, e] of results) { if (st === 'FAIL') failed++; console.log(`${st}  ${n}${e ? '  [' + e + ']' : ''}`); }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
