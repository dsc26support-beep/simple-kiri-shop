// Browse product cards (Oct 2026): row 1 price left + 15-character description right;
// row 2 place, delivery icons, Verified, other badges. Name kept for screen readers only.
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
    const top = c.querySelector('.product-card-top');
    const price = c.querySelector('.product-price');
    const blurb = c.querySelector('.product-card-blurb');
    const meta = c.querySelector('.product-card-meta');
    const name = c.querySelector('.product-name');
    const kids = meta ? Array.from(meta.children).map((k) => k.className.split(' ')[0]) : [];
    const pr = price && price.getBoundingClientRect(), br = blurb && blurb.getBoundingClientRect(), tr = top && top.getBoundingClientRect();
    out.push({
      text: c.textContent.replace(/\s+/g, ' ').trim(),
      visibleName: name ? getComputedStyle(name).position === 'absolute' && name.getBoundingClientRect().width <= 1 : null,
      nameText: name ? name.textContent.trim() : null,
      price: price ? price.textContent.trim() : null,
      blurb: blurb ? blurb.textContent.trim() : null,
      priceAtLeft: pr && tr ? Math.abs(pr.left - tr.left) < 1 : null,
      blurbAtRight: br && tr ? Math.abs(br.right - tr.right) < 1 : null,
      blurbAlign: blurb ? getComputedStyle(blurb).textAlign : null,
      place: meta && meta.querySelector('.product-card-place') ? meta.querySelector('.product-card-place').textContent.trim() : null,
      metaOrder: kids,
      firstBadge: (() => { const b = meta && meta.querySelector('.seller-badge'); return b ? (Array.from(b.classList).find((k) => /^seller-badge--(recommended|top|verified|responsive|delivery|favourite|popular|new)$/.test(k)) || '').slice(14) : null; })(),
      starsBeforeMeta: !!(c.querySelector('.rating') && meta && (c.querySelector('.rating').compareDocumentPosition(meta) & 4)),
      priceSize: price ? parseFloat(getComputedStyle(price).fontSize) : null,
      blurbSize: blurb ? parseFloat(getComputedStyle(blurb).fontSize) : null,
      metaSize: meta ? parseFloat(getComputedStyle(meta).fontSize) : null,
      inlineFontSize: price ? price.style.fontSize || '' : '',
      metaClipped: meta ? meta.scrollWidth > meta.clientWidth + 1 : null,
      phone: !!c.querySelector('.store-phone'),
      aria: c.getAttribute('aria-label')
    });
  });
  return out;
}, sel);

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

  /* --- the new card (Oct 2026): every browse card, so home and similar products alike --- */
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
      ok(`${label}: price shows the range`, c[0].price === '$7.50-40.00', String(c[0].price));
    } else {
      ok(`${label}: rendered`, c.length > 0, 'no cards found');
      if (!c.length) { await ctx.close(); continue; }
      ok(`${label}: shows the place now, like every card`, c[0].place === 'Abaiang', String(c[0].place));
    }
    ok(`${label}: product name is not shown`, c[0].visibleName === true);
    ok(`${label}: ...but is still the heading for a screen reader and in the link label`,
      !!c[0].nameText && (c[0].aria || '').indexOf(c[0].nameText) === 0, String(c[0].aria));
    ok(`${label}: store name is gone from the visible card, still in the aria-label`,
      (label !== 'home' || !c[0].text.includes('Bong Restaurant')) && /Bong Restaurant|Other Store/.test(c[0].aria || ''), c[0].text);
    ok(`${label}: row 1 - price at the far left`, c[0].priceAtLeft === true);
    ok(`${label}: row 1 - description at the far right, right-aligned`, c[0].blurbAtRight === true && c[0].blurbAlign === 'right');
    ok(`${label}: row 2 order - place, delivery icons, badges`,
      c[0].metaOrder[0] === 'product-card-place' && c[0].metaOrder[1] === 'delivery-icons', c[0].metaOrder.join(','));
    ok(`${label}: smaller type - price 0.9rem, text 0.78rem, row 2 0.75rem`,
      c[0].priceSize === 14.4 && Math.abs(c[0].blurbSize - 12.48) < 0.01 && c[0].metaSize === 12, `${c[0].priceSize}/${c[0].blurbSize}/${c[0].metaSize}`);
    ok(`${label}: fitPriceLabels leaves the card price alone`, c[0].inlineFontSize === '', c[0].inlineFontSize);
    ok(`${label}: no phone number`, c[0].phone === false);
    await ctx.close();
  }

  /* --- blurb rules, badges, stars, featured --- */
  {
    const { ctx, page } = await open(browser, '/index.html');
    const b = await page.evaluate(() => [
      cardBlurb({ description: 'Gold necklace with green stones', name: 'Necklace' }),
      cardBlurb({ description: '   ', name: 'Fried Rice Special Plate' }),
      cardBlurb({ description: 'Short', name: 'x' }),
      cardBlurb({ description: '😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀', name: 'x' }),
      cardBlurb({ description: 'Line one\nline two here', name: 'x' })
    ]);
    ok('blurb: the first 15 characters of the description, then …', b[0] === 'Gold necklace w…', b[0]);
    ok('blurb: no description -> the name, same 15-character rule', b[1] === 'Fried Rice Spec…', b[1]);
    ok('blurb: short text is left as is', b[2] === 'Short', b[2]);
    ok('blurb: counts characters, never cuts an emoji in half', Array.from(b[3]).length === 16 && b[3].endsWith('…'), b[3]);
    ok('blurb: line breaks become spaces', b[4] === 'Line one line t…', b[4]);
    const html = await page.evaluate(() => {
      const card = renderBrowseProductCard({ productId: 'z', name: 'N', description: 'd', storeSlug: 's', storeName: 'S',
        storeIsland: 'Abaiang', variants: [{ variantId: 'v', label: 'a', price: 1 }], rating: 4.5, reviewCount: 2,
        storeDeliveryTruck: true, sellerBadges: ['recommended', 'top', 'verified'], featured: true });
      const box = document.createElement('div'); box.innerHTML = card; document.body.appendChild(box);
      const meta = box.querySelector('.product-card-meta');
      const order = Array.from(meta.querySelectorAll('.product-card-place, .delivery-icons, .seller-badge, .featured-badge'))
        .map((e) => e.classList.contains('product-card-place') ? 'place' : e.classList.contains('delivery-icons') ? 'delivery'
          : e.classList.contains('featured-badge') ? 'featured' : e.classList.contains('seller-badge--more') ? 'more'
          : (Array.from(e.classList).find((k) => /^seller-badge--(recommended|top|verified)$/.test(k)) || '').slice(14));
      const stars = box.querySelector('.rating');
      const r = { order, starsOwnRow: !!stars && stars.parentElement.classList.contains('product-card-body'),
        starsBetween: !!stars && !!(stars.compareDocumentPosition(meta) & 4) && !!(box.querySelector('.product-card-top').compareDocumentPosition(stars) & 4) };
      box.remove();
      return r;
    });
    ok('row 2: place, delivery, Verified, then the other badges, then Featured',
      html.order.join(',') === 'place,delivery,verified,recommended,more,featured', html.order.join(','));
    ok('stars: their own small row between row 1 and row 2', html.starsOwnRow && html.starsBetween);
    await ctx.close();
  }

  /* --- narrow phones: nothing clipped, page never scrolls sideways --- */
  for (const w of [320, 360]) {
    const { ctx, page } = await open(browser, '/index.html');
    await page.setViewportSize({ width: w, height: 700 });
    await page.waitForTimeout(400);
    const c = await cards(page, '#trending-products-list');
    ok(`${w}px: row 2 is never clipped (it wraps instead)`, c.every((x) => x.metaClipped === false));
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
