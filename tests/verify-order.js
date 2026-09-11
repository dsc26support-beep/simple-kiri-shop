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
      return { hero: t('.hero'), categories: t('.categories'), products: t('.trending-products') };
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
  // should not scroll past two rows of navigation to type it.
  ok('mobile: search above categories', mob.t.hero < mob.t.categories, JSON.stringify(mob.t));
  ok('mobile: search above products', mob.t.hero < mob.t.products, JSON.stringify(mob.t));

  const tab = await measure(900, 1200, 'tablet');
  ok('tablet: search above categories', tab.t.hero < tab.t.categories, JSON.stringify(tab.t));

  const desk = await measure(1280, 900, 'desktop');
  ok('desktop: search above categories (original)', desk.t.hero < desk.t.categories, JSON.stringify(desk.t));
  ok('desktop: categories above products', desk.t.categories < desk.t.products, JSON.stringify(desk.t));

  // Gap check: on mobile the space between search(hero) bottom and products top
  // should reflect the added row-gap. Compare mobile gap vs desktop gap between
  // the same two adjacent-in-flow sections is not apples-to-apples (order differs),
  // so just assert a positive, non-trivial gap exists on mobile between hero and products.
  const page = await ctx.newPage();
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto(BASE + '/index.html', { waitUntil: 'load' });
  await page.waitForSelector('#category-strip .chip-strip-item');
  const gaps = await page.evaluate(() => {
    const r = (s) => document.querySelector(s).getBoundingClientRect();
    const cat = r('.categories'), hero = r('.hero'), prod = r('.trending-products');
    // .listing-types held the [All|Products|Rentals|Services] strip and was
    // removed with it, so the hero's neighbour below is now the categories.
    return { heroToCat: Math.round(cat.top - hero.bottom),
             catToProd: Math.round(prod.top - cat.bottom) };
  });
  await page.close();
  // row-gap var(--space-4)=1.5rem=24px is added between flex items; both gaps should be >= ~24.
ok('mobile: extra spacer categories->products (>=24px)', gaps.catToProd >= 24, 'catToProd=' + gaps.catToProd);
  ok('mobile: extra spacer search->categories (>=24px)', gaps.heroToCat >= 24, 'heroToCat=' + gaps.heroToCat);

  await browser.close();
  console.log('\n--- home section order/spacing ---');
  let failed = 0;
  for (const [st, n, e] of results) { if (st === 'FAIL') failed++; console.log(`${st}  ${n}${e ? '  [' + e + ']' : ''}`); }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
