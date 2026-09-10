const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = 'http://127.0.0.1:8099';
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e || '']);

const mk = (i, over = {}) => Object.assign({
  productId: 'p' + i, name: 'Rice ' + i, description: 'tasty', category: 'pantry',
  imageUrl: '', storeSlug: 's' + (i % 3), storeName: 'Store ' + (i % 3),
  storePhone: '73001224', variants: [{ variantId: 'v' + i, label: '1kg', price: i * 10 }],
  views: i, createdAt: '2026-0' + ((i % 9) + 1) + '-01T00:00:00Z',
  storeDeliveryTruck: i % 2 === 0, storeDeliveryShip: false,
  storeDeliveryAirCargo: false, storeDeliveryPickPay: true,
}, over);
const PRODUCTS = Array.from({ length: 30 }, (_, k) => mk(k + 1));

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

  async function open(url, products = PRODUCTS) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 900 } });
    await ctx.route('**/macros/s/**', (r) => r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ ok: true, products }) }));
    const page = await ctx.newPage();
    await page.addInitScript(() => localStorage.setItem('skiri_cookie_consent', 'true'));
    await page.goto(BASE + url, { waitUntil: 'load' });
    await page.waitForTimeout(250);
    return { ctx, page };
  }
  const names = (page) => page.$$eval('#results-list .product-card-link, #results-list a', (a) => a.length);
  const shown = (page) => page.$$eval('#results-list > *', (e) => e.length);
  const status = (page) => page.textContent('#results-status').then((t) => t.replace(/\s+/g, ' ').trim());

  // Load More (§41)
  let { ctx, page } = await open('/search.html?q=rice');
  ok('first page capped at 24', await shown(page) === 24, String(await shown(page)));
  ok('Load More visible when more remain', !(await page.getAttribute('#results-more', 'hidden') !== null));
  await page.click('#load-more-btn');
  await page.waitForTimeout(120);
  ok('Load More reveals the rest', await shown(page) === 30, String(await shown(page)));
  ok('Load More hidden at the end', await page.getAttribute('#results-more', 'hidden') !== null);
  ok('shown depth recorded in URL', /shown=48/.test(page.url()), page.url());

  // Back restores the pre-Load-More state (§32)
  await page.goBack();
  await page.waitForTimeout(200);
  ok('Back returns to the first page', await shown(page) === 24, String(await shown(page)));
  await ctx.close();

  // Sorting (§10)
  ({ ctx, page } = await open('/search.html?q=rice'));
  await page.selectOption('#results-sort', 'cheapest');
  await page.waitForTimeout(150);
  let first = await page.textContent('#results-list');
  ok('cheapest puts $10 first', /Rice 1\b/.test(first.split('Rice')[1] ? 'Rice' + first.split('Rice')[1].slice(0, 3) : ''), 'first card');
  ok('sort persisted to URL', /sort=cheapest/.test(page.url()), page.url());
  const cheapFirstPrice = await page.$eval('#results-list', (el) => el.textContent.match(/\$[\d.,]+/)[0]);
  await page.selectOption('#results-sort', 'dearest');
  await page.waitForTimeout(150);
  const dearFirstPrice = await page.$eval('#results-list', (el) => el.textContent.match(/\$[\d.,]+/)[0]);
  ok('cheapest vs dearest differ', cheapFirstPrice !== dearFirstPrice, `${cheapFirstPrice} vs ${dearFirstPrice}`);
  await ctx.close();

  // Sort state restored from URL on load (§32)
  ({ ctx, page } = await open('/search.html?q=rice&sort=name'));
  ok('sort restored from URL', await page.inputValue('#results-sort') === 'name');
  await ctx.close();

  // Seller filter (§11)
  ({ ctx, page } = await open('/search.html?q=rice'));
  await page.click('#filters-toggle');
  await page.selectOption('#filter-store', 's1');
  await page.waitForTimeout(150);
  ok('seller filter narrows results', await shown(page) < 30 && await shown(page) > 0, String(await shown(page)));
  ok('filter count badge shows 1', await page.textContent('#filters-count') === '1');
  ok('filter persisted to URL', /store=s1/.test(page.url()), page.url());
  ok('status reports filtering', /matching product/.test(await status(page)), await status(page));
  await ctx.close();

  // Price filter (§12)
  ({ ctx, page } = await open('/search.html?q=rice&maxPrice=50'));
  ok('price filter applied from URL', await shown(page) === 5, String(await shown(page)));
  ok('price control reflects state', await page.inputValue('#filter-price-max') === '50');
  await ctx.close();

  // Delivery facet only offers what the data supports (§11)
  ({ ctx, page } = await open('/search.html?q=rice'));
  await page.click('#filters-toggle');
  const chips = await page.$$eval('#filter-delivery .filter-chip', (e) => e.map((x) => x.textContent.trim()));
  ok('only real delivery methods offered', chips.length === 2 && chips.join('|').includes('Truck') && chips.join('|').includes('Pick & Pay'), chips.join('|'));
  await ctx.close();

  // Availability facet hidden when no booking products present
  ({ ctx, page } = await open('/search.html?q=rice'));
  ok('availability facet hidden for goods-only results', await page.getAttribute('#filter-available-row', 'hidden') !== null);
  await ctx.close();

  // No-results: filtered vs genuinely empty (§13)
  ({ ctx, page } = await open('/search.html?q=rice&maxPrice=1'));
  let st = await status(page);
  ok('over-filtered explains itself', /No products match your filters/.test(st), st);
  ok('over-filtered offers Clear filters', await page.$('#no-results-clear') !== null);
  await page.click('#no-results-clear');
  await page.waitForTimeout(150);
  ok('Clear filters restores results', await shown(page) === 24, String(await shown(page)));
  await ctx.close();

  ({ ctx, page } = await open('/search.html?q=zzz', []));
  st = await status(page);
  ok('empty search says "No exact match"', /No exact match for "zzz"/.test(st), st);
  // Case-insensitive: the link now begins its own sentence ("See all
  // products.") because the advice that used to precede it was removed - it
  // contradicted the smart-search suggestion rendered underneath. What this
  // guard is for is that the escape hatch still EXISTS, not how it is capitalised.
  ok('empty search offers a way forward', /see all products/i.test(st), st);
  ok('toolbar hidden with no results at all', await page.getAttribute('#results-toolbar', 'hidden') !== null);
  await ctx.close();

  // Only one API call for all this client-side work (§40)
  {
    const ctx2 = await browser.newContext({ viewport: { width: 390, height: 900 } });
    let calls = 0;
    await ctx2.route('**/macros/s/**', (r) => {
      const u = r.request().url();
      if (/searchProducts/.test(u)) calls++;
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, products: PRODUCTS }) });
    });
    const p2 = await ctx2.newPage();
    await p2.addInitScript(() => localStorage.setItem('skiri_cookie_consent', 'true'));
    await p2.goto(BASE + '/search.html?q=rice', { waitUntil: 'load' });
    await p2.waitForTimeout(200);
    await p2.selectOption('#results-sort', 'cheapest');
    await p2.click('#filters-toggle');
    await p2.selectOption('#filter-store', 's1');
    await p2.click('#load-more-btn').catch(() => {});
    await p2.waitForTimeout(250);
    ok('sorting/filtering/paging cost no extra search requests', calls === 1, String(calls));
    await ctx2.close();
  }

  await browser.close();
  let f = 0;
  console.log('\n--- Search results: sort / filter / page / state ---');
  for (const [s, n, e] of R) { if (s === 'FAIL') f++; console.log(`${s}  ${n}${e ? '  [' + e + ']' : ''}`); }
  console.log(`\n${R.length - f}/${R.length} passed`);
  process.exit(f ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
