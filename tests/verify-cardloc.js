// Homepage/search cards: location instead of store name, price beside the name.
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
    const name = c.querySelector('.product-name');
    const price = c.querySelector('.product-price');
    const meta = c.querySelector('.helper-text');
    const cs = name && price ? {
      nameSize: getComputedStyle(name).fontSize,
      priceSize: getComputedStyle(price).fontSize,
      nameWeight: getComputedStyle(name).fontWeight,
      priceWeight: getComputedStyle(price).fontWeight,
      priceFamily: getComputedStyle(price).fontFamily,
      nameFamily: getComputedStyle(name).fontFamily,
      priceInsideName: !!(price && name && name.contains(price)),
      inlineFontSize: price.style.fontSize || ''
    } : {};
    out.push(Object.assign({
      text: c.textContent.replace(/\s+/g, ' ').trim(),
      meta: meta ? meta.textContent.trim() : null,
      // Geometry, not just presence - the point of the change is that these
      // two now occupy a single line and still fit.
      iconsInMetaLine: !!(meta && meta.querySelector('.delivery-icons')),
      metaLines: meta ? Math.round(meta.getBoundingClientRect().height /
        parseFloat(getComputedStyle(meta).lineHeight || 16)) : null,
      metaScrollW: meta ? meta.scrollWidth : null,
      metaClientW: meta ? meta.clientWidth : null,
      metaTruncated: meta ? meta.scrollWidth > meta.clientWidth + 1 : null,
      iconW: (() => { const s = c.querySelector('.product-card-meta .delivery-icons svg');
        return s ? Math.round(s.getBoundingClientRect().width) : null; })(),
      iconH: (() => { const s = c.querySelector('.product-card-meta .delivery-icons svg');
        return s ? Math.round(s.getBoundingClientRect().height) : null; })(),
      hasPhoneRow: !!c.querySelector('.store-phone-row'),
      phone: !!c.querySelector('.store-phone'),
      delivery: !!c.querySelector('.delivery-icons'),
      aria: c.getAttribute('aria-label')
    }, cs));
  });
  return out;
}, sel);

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

  // Home only. The search row is gone with search.html: the browse page that
  // absorbed it renders renderCategoryTile - photo and name, no location line -
  // so there is nothing here to assert. store.html below still covers the full
  // card, which is where the location logic actually lives.
  for (const [path, sel, label] of [
    ['/index.html', '#trending-products-list', 'home']
  ]) {
    const { ctx, page } = await open(browser, path);
    const c = await cards(page, sel);
    ok(`${label}: four cards render`, c.length === 4, String(c.length));

    ok(`${label}: South Tarawa shows the VILLAGE`, c[0].meta === 'Bairiki', String(c[0].meta));
    ok(`${label}: elsewhere shows the ISLAND`, c[1].meta === 'Abaiang', String(c[1].meta));
    ok(`${label}: South Tarawa with no village falls back to the island`,
      c[2].meta === 'South Tarawa', String(c[2].meta));
    ok(`${label}: no location at all falls back to the store name`,
      c[3].meta === 'Bong Restaurant', String(c[3].meta));

    ok(`${label}: store name is gone from the visible card`,
      !c[0].text.includes('Bong Restaurant'), c[0].text);
    ok(`${label}: store name is still in the aria-label`,
      (c[0].aria || '').includes('Bong Restaurant'), String(c[0].aria));
    ok(`${label}: phone dropped`, c[0].phone === false);
    ok(`${label}: delivery icons kept`, c[0].delivery === true);
    ok(`${label}: icons share the location's line`, c[0].iconsInMetaLine === true);
    ok(`${label}: location and icons are on ONE line`, c[0].metaLines === 1, String(c[0].metaLines));
    ok(`${label}: icons shrunk to 13px so both fit`,
      c[0].iconW === 13 && c[0].iconH === 13, `${c[0].iconW}x${c[0].iconH}`);
    ok(`${label}: the place name is not truncated`, c[0].metaTruncated === false,
      `${c[0].metaScrollW} vs ${c[0].metaClientW}`);
    ok(`${label}: the old separate icon row is gone`, c[0].hasPhoneRow === false);

    ok(`${label}: price sits inside the heading, beside the name`, c[0].priceInsideName === true);
    ok(`${label}: price is the same size as the name`,
      c[0].priceSize === c[0].nameSize, `${c[0].priceSize} vs ${c[0].nameSize}`);
    ok(`${label}: price is the same weight as the name`,
      c[0].priceWeight === c[0].nameWeight, `${c[0].priceWeight} vs ${c[0].nameWeight}`);
    ok(`${label}: price is the same font as the name`,
      c[0].priceFamily === c[0].nameFamily, c[0].priceFamily);
    ok(`${label}: price still shows the range`, /7\.50/.test(c[0].text) && /40\.00/.test(c[0].text), c[0].text);
    // fitPriceLabels must not have shrunk it - it wraps instead.
    ok(`${label}: fitPriceLabels left the inline price alone`,
      c[0].inlineFontSize === '', c[0].inlineFontSize);
    ok(`${label}: a long name keeps its full price`,
      /8\.00|7\.50/.test(c[1].text) && /40\.00/.test(c[1].text), c[1].text);
    await ctx.close();
  }

  /* --- the surfaces that must NOT change --- */
  {
    const { ctx, page } = await open(browser, '/store.html?store=bong', { similar: true });
    const c = await cards(page, '#similar-products-list');
    if (c.length) {
      // The candidate comes from another store, and its name is what must
      // still be shown there - the location swap is homepage/search only.
      ok('similar products: still shows the store name', c[0].meta === 'Other Store', String(c[0].meta));
      ok('similar products: price is NOT inside the heading', c[0].priceInsideName === false);
      ok('similar products: price keeps its own larger size',
        c[0].priceSize !== c[0].nameSize, `${c[0].priceSize} vs ${c[0].nameSize}`);
      ok('similar products: icons stay on their own row', c[0].hasPhoneRow === true);
      ok('similar products: icons stay full size',
        c[0].iconW === null, String(c[0].iconW));
    } else {
      ok('similar products: rendered', false, 'no cards found');
    }
    await ctx.close();
  }

  /* --- narrow phone: icons step down, and nothing is ever clipped --- */
  {
    const { ctx, page } = await open(browser, '/index.html');
    await page.setViewportSize({ width: 320, height: 700 });
    await page.waitForTimeout(400);
    const narrow = await page.evaluate(() => {
      const m = document.querySelector('.product-card-meta');
      const svg = document.querySelector('.product-card-meta .delivery-icons svg');
      return {
        icon: svg ? Math.round(svg.getBoundingClientRect().width) : null,
        clipped: m ? m.scrollWidth > m.clientWidth + 1 : null,
        iconsStillInLine: !!(m && m.querySelector('.delivery-icons'))
      };
    });
    ok('320px: icons step down to 11px', narrow.icon === 11, String(narrow.icon));
    // Wrapping is the accepted fallback past that: below 11px the icons stop
    // being tellable apart, so a long name puts them on a second line rather
    // than shrinking further or truncating the place name.
    ok('320px: nothing is clipped even when it wraps', narrow.clipped === false);
    ok('320px: icons stay in the location element', narrow.iconsStillInLine === true);
    await ctx.close();
  }

  /* --- resize must not undo the inline price (fitPriceLabels runs globally) --- */
  {
    const { ctx, page } = await open(browser, '/index.html');
    await page.setViewportSize({ width: 320, height: 700 });
    await page.waitForTimeout(400);
    const after = await cards(page, '#trending-products-list');
    ok('resize does not shrink the inline price', after[0].inlineFontSize === '', after[0].inlineFontSize);
    ok('resize keeps price and name the same size',
      after[0].priceSize === after[0].nameSize, `${after[0].priceSize} vs ${after[0].nameSize}`);
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
