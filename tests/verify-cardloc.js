// Product cards: where the store is (village on South Tarawa, else island) on the
// place row, before the delivery icons. Layout and cart button: verify-card-cart.js.
const fs = require('fs'), vm = require('vm');
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = 'http://127.0.0.1:8099';
const REPO = '/home/user/simple-kiri-shop/';
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e || '']);

const mk = (o) => Object.assign({
  productId: 'p1', name: 'Chop Syue', category: 'pantry', description: 'x', imageUrl: '',
  storeSlug: 'bong', storeName: 'Bong Restaurant', storePhone: '63011224',
  storeIsland: 'South Tarawa', storeVillage: 'Bairiki',
  variants: [{ variantId: 'v1', label: '1kg', price: 7.5 }, { variantId: 'v2', label: '5kg', price: 40 }],
  rating: null, reviewCount: 0, views: 1, createdAt: '2026-01-01',
  storeDeliveryTruck: true, storeDeliveryShip: true, storeDeliveryAirCargo: false,
  storeDeliveryPickPay: true, storeDeliveryTruckCost: 5, storeDeliveryShipCost: null,
  storeDeliveryAirCargoCost: null
}, o);

const PRODUCTS = [
  mk({}),
  mk({ productId: 'p2', name: 'Brocolli Chop with Beef and Vegetables', storeIsland: 'Abaiang', storeVillage: 'Tuarabu' }),
  mk({ productId: 'p3', name: 'Fried Rice', storeIsland: 'South Tarawa', storeVillage: '' }),
  mk({ productId: 'p4', name: 'No Location Item', storeIsland: '', storeVillage: '' })
];

// The similar-products row drops anything from the store being viewed and
// requires a shared word with its own product names, so that control case
// needs candidates from a DIFFERENT store.
const OTHER_STORE = [mk({ productId: 'x1', name: 'Chop Syue Special', storeSlug: 'other',
  storeName: 'Other Store', storeIsland: 'Abaiang', storeVillage: '' })];

async function open(browser, path, opts) {
  opts = opts || {};
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx.route('**/macros/s/**', (r) => {
    let a = ''; try { a = new URL(r.request().url()).searchParams.get('action') || ''; } catch (e) {}
    try { const j = r.request().postDataJSON(); if (!a && j) a = j.action; } catch (e) {}
    const J = (o) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
    if (a === 'getHomePageData') return J({ ok: true, products: PRODUCTS, stores: [] });
    if (a === 'searchProducts') return J({ ok: true, products: opts.similar ? OTHER_STORE : PRODUCTS });
    if (a === 'listProducts') return J({ ok: true, storeName: 'Bong Restaurant', storeOpen: true, products: PRODUCTS });
    if (a === 'getTips') return J({ ok: true, tips: [], products: PRODUCTS });
    J({ ok: true });
  });
  const page = await ctx.newPage();
  await page.addInitScript(() => localStorage.setItem('skiri_cookie_consent', 'true'));
  await page.goto(BASE + path, { waitUntil: 'load' });
  await page.waitForTimeout(900);
  return { ctx, page };
}

const cards = (page, sel) => page.evaluate((s) => {
  const out = [];
  document.querySelectorAll(s + ' .product-card').forEach((c) => {
    const meta = c.querySelector('.product-card-meta');
    out.push({
      text: c.textContent.replace(/\s+/g, ' ').trim(),
      place: meta && meta.querySelector('.product-card-place') ? meta.querySelector('.product-card-place').textContent.trim() : null,
      metaOrder: meta ? Array.from(meta.children).map((k) => k.className.split(' ')[0]) : [],
      metaSize: meta ? parseFloat(getComputedStyle(meta).fontSize) : null,
      metaClipped: meta ? meta.scrollWidth > meta.clientWidth + 1 : null,
      phone: !!c.querySelector('.store-phone'),
      aria: (c.querySelector('.product-card-link') || {}).getAttribute ? c.querySelector('.product-card-link').getAttribute('aria-label') : null
    });
  });
  return out;
}, sel);

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

  /* --- where the store is: every product card, home and similar products alike --- */
  const pages = [['/index.html', '#trending-products-list', 'home', {}], ['/store.html?store=bong', '#similar-products-list', 'similar products', { similar: true }]];
  for (const [path, sel, label, o] of pages) {
    const { ctx, page } = await open(browser, path, o);
    const c = await cards(page, sel);
    if (label === 'home') {
      ok(`${label}: four cards render`, c.length === 4, String(c.length));
      ok(`${label}: South Tarawa shows the VILLAGE`, c[0].place === 'Bairiki', String(c[0].place));
      ok(`${label}: elsewhere shows the ISLAND`, c[1].place === 'Abaiang', String(c[1].place));
      ok(`${label}: South Tarawa with no village falls back to the island`, c[2].place === 'South Tarawa', String(c[2].place));
      ok(`${label}: no location at all falls back to the store name`, c[3].place === 'Bong Restaurant', String(c[3].place));
      ok(`${label}: store name is gone from the visible card`, !c[0].text.includes('Bong Restaurant'), c[0].text);
    } else {
      ok(`${label}: rendered`, c.length > 0, 'no cards found');
      if (!c.length) { await ctx.close(); continue; }
      ok(`${label}: shows the place now, like every card`, c[0].place === 'Abaiang', String(c[0].place));
    }
    ok(`${label}: store name still in the link's accessible name`, /Bong Restaurant|Other Store/.test(c[0].aria || ''), String(c[0].aria));
    ok(`${label}: place row - place first, then the delivery icons`,
      c[0].metaOrder[0] === 'product-card-place' && c[0].metaOrder[1] === 'delivery-icons', c[0].metaOrder.join(','));
    ok(`${label}: place row in small type (0.75rem)`, c[0].metaSize === 12, String(c[0].metaSize));
    ok(`${label}: no phone number`, c[0].phone === false);
    await ctx.close();
  }

  /* --- narrow phones: nothing clipped, page never scrolls sideways --- */
  for (const w of [320, 360]) {
    const { ctx, page } = await open(browser, '/index.html');
    await page.setViewportSize({ width: w, height: 700 });
    await page.waitForTimeout(400);
    const c = await cards(page, '#trending-products-list');
    ok(`${w}px: place row is never clipped (it wraps instead)`, c.every((x) => x.metaClipped === false));
    ok(`${w}px: the page does not scroll sideways`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await ctx.close();
  }

  await browser.close();

  /* --- backend: the fields the card needs must be in both payloads --- */
  const prod = fs.readFileSync(REPO + 'apps-script/Products.gs', 'utf8');
  const grab = (name) => prod.match(new RegExp('function ' + name + '\\([\\s\\S]*?\\n}'))[0];
  for (const fn of ['getTopProductsCached', 'actionSearchProducts']) {
    const body = grab(fn);
    ok(`${fn} sends storeIsland`, /storeIsland: owner\.Island/.test(body));
    ok(`${fn} sends storeVillage`, /storeVillage: owner\.Village/.test(body));
  }
  const admin = fs.readFileSync(REPO + 'apps-script/Admin.gs', 'utf8');
  ok('Tips products send storeIsland and storeVillage too', /storeIsland: owner\.Island/.test(admin) && /storeVillage: owner\.Village/.test(admin));
  // Was pinned to the literal 'cardloc1-2026-09-04', which meant the NEXT
  // backend change broke this suite for no reason - the same literal-pinning
  // trap already removed from the other suites. The durable rule: if any .gs
  // differs from main, APP_VERSION must differ too, so the deploy probe never
  // reports a version that is already live.
  {
    const { execSync } = require('child_process');
    const verOf = (src) => (src.match(/APP_VERSION = '([^']+)'/) || [])[1];
    let anyGsChanged = false;
    for (const f of fs.readdirSync(REPO + 'apps-script')) {
      if (!f.endsWith('.gs')) continue;
      let base = '';
      try { base = execSync(`git -C ${REPO} show origin/main:apps-script/${f}`).toString(); } catch (e) { base = ''; }
      if (fs.readFileSync(REPO + 'apps-script/' + f, 'utf8') !== base) anyGsChanged = true;
    }
    const cur = verOf(fs.readFileSync(REPO + 'apps-script/Code.gs', 'utf8'));
    const mainVer = verOf(execSync(`git -C ${REPO} show origin/main:apps-script/Code.gs`).toString());
    ok('any Apps Script change bumps APP_VERSION for the redeploy',
      !anyGsChanged || cur !== mainVer, `${mainVer} -> ${cur}`);
  }

  /* --- storeLocationLabel, over the real source --- */
  const helpers = fs.readFileSync(REPO + 'assets/js/helpers.js', 'utf8');
  const box = {}; vm.createContext(box);
  vm.runInContext(helpers.match(/function storeLocationLabel[\s\S]*?\n}/)[0], box);
  for (const [i, v, want] of [
    ['South Tarawa', 'Bairiki', 'Bairiki'],
    ['South Tarawa', '', 'South Tarawa'],
    ['Abaiang', 'Tuarabu', 'Abaiang'],
    ['Abaiang', '', 'Abaiang'],
    ['', 'Bairiki', 'Bairiki'],
    ['', '', '']
  ]) {
    ok(`storeLocationLabel(${i || 'blank'}, ${v || 'blank'}) = ${want || 'blank'}`,
      box.storeLocationLabel(i, v) === want, box.storeLocationLabel(i, v));
  }

  let f = 0;
  console.log('\n--- Card location + inline price ---');
  for (const [st, n, e] of R) { if (st === 'FAIL') f++; console.log(`${st}  ${n}${e ? '  [' + e + ']' : ''}`); }
  console.log(`\n${R.length - f}/${R.length} passed`);
  process.exit(f ? 1 : 0);
})();
