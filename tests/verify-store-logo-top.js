/**
 * Store logo top-left in the red header, level with Home and the menu (owner
 * request, Oct 2026), on every page with the store header: store, product,
 * cart and checkout. Same 64px round logo; name, phone and icons under it.
 */
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const fs = require('fs');

const BASE = process.env.AUDIT_BASE || 'http://127.0.0.1:8099';
const ROOT = __dirname + '/../';
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e]);
const LOGO = BASE + '/assets/img/app-icon-192.png';
const STORE = { ok: true, storeName: 'Teaube', storeIsland: 'Abaiang', storePhone: '+68673007552', storeLogoUrl: LOGO,
  storeDeliveryTruck: true, storeDeliveryShip: true, storeOpen: true,
  products: [{ productId: 'p1', name: 'Rice', description: 'x', category: 'food', listingType: 'product', imageUrls: [],
    storeSlug: 'teaube', storeName: 'Teaube', variants: [{ variantId: 'v1', label: '1kg', price: 8 }] }],
  store: { storeName: 'Teaube', storeSlug: 'teaube', logoUrl: LOGO, isOpen: true } };

(async () => {
  for (const f of ['store.html', 'product.html', 'cart.html', 'checkout.html']) {
    const html = fs.readFileSync(ROOT + f, 'utf8');
    const top = html.indexOf('header-top-row'), logo = html.indexOf('id="store-logo-img"'), brand = html.indexOf('store-branding"');
    ok(f + ': the logo is in the top header row, before the branding block', top !== -1 && logo > top && logo < brand);
    ok(f + ': exactly one store logo', html.split('id="store-logo-img"').length === 2);
  }

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx.route('**/script.google.com/**', (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify(STORE) }));
  const page = await ctx.newPage();
  await page.goto(BASE + '/index.html');
  await page.evaluate(() => { localStorage.setItem('skiri_cookie_consent', 'true'); localStorage.setItem('skiri_active_store', 'teaube'); });

  // Space is held from first paint, so the logo arriving later moves nothing.
  await page.route('**/script.google.com/**', () => {});   // never answers
  await page.goto(BASE + '/store.html?store=teaube', { waitUntil: 'load' });
  const before = await page.evaluate(() => document.querySelector('header .header-top-row').getBoundingClientRect().height);
  await page.unroute('**/script.google.com/**');

  await page.goto(BASE + '/store.html?store=teaube', { waitUntil: 'load' });
  await page.waitForFunction(() => !document.getElementById('store-logo-img').classList.contains('hidden'), null, { timeout: 5000 });
  await page.waitForTimeout(300);
  const g = await page.evaluate(() => {
    const box = (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, cy: r.y + r.height / 2 }; };
    const logo = box(document.getElementById('store-logo-img'));
    const home = box(document.querySelector('header .site-nav a'));
    const menu = document.querySelector('header .header-menu-btn');
    const name = box(document.getElementById('store-name-tagline'));
    const row = box(document.querySelector('header .header-top-row'));
    return { logo, home, menu: menu && box(menu), name, row, round: getComputedStyle(document.getElementById('store-logo-img')).borderRadius,
      scrollW: document.documentElement.scrollWidth };
  });
  ok('logo is top-left', g.logo.x <= 20 && g.logo.y <= 24, JSON.stringify(g.logo));
  ok('...same size and round (64px)', g.logo.w === 64 && g.logo.h === 64 && g.round === '50%', JSON.stringify([g.logo, g.round]));
  ok('...level with Home', Math.abs(g.logo.cy - g.home.cy) <= 4, JSON.stringify([g.logo.cy, g.home.cy]));
  ok('...and with the menu dots', g.menu && Math.abs(g.menu.cy - g.home.cy) <= 4, JSON.stringify(g.menu));
  ok('store name sits under the logo', g.name.y >= g.logo.y + g.logo.h, JSON.stringify([g.name, g.logo]));
  ok('the row was already that tall before the store loaded (no jump)', Math.abs(before - g.row.h) <= 1, JSON.stringify([before, g.row.h]));
  ok('no sideways scroll at 390px', g.scrollW <= 390, String(g.scrollW));

  await page.click('header .header-menu-btn');
  const panel = await page.evaluate(() => { const p = document.querySelector('header .header-menu-panel'); if (!p) return null; const r = p.getBoundingClientRect(); return { shown: getComputedStyle(p).display !== 'none' && !p.hidden && r.height > 0, right: r.right }; });
  ok('the menu still opens, on screen', panel && panel.shown && panel.right <= 390, JSON.stringify(panel));

  for (const pg of ['product.html?store=teaube&product=p1', 'cart.html', 'checkout.html']) {
    await page.goto(BASE + '/' + pg, { waitUntil: 'load' });
    await page.waitForTimeout(1200);
    const r = await page.evaluate(() => {
      const l = document.getElementById('store-logo-img'), h = document.querySelector('header .site-nav a');
      const a = l.getBoundingClientRect(), b = h.getBoundingClientRect();
      return { shown: !l.classList.contains('hidden'), x: a.x, y: a.y, level: Math.abs((a.y + a.height / 2) - (b.y + b.height / 2)), scrollW: document.documentElement.scrollWidth };
    });
    ok(pg.split('?')[0] + ': logo top-left, level with the links', r.shown && r.x <= 20 && r.y <= 24 && r.level <= 4 && r.scrollW <= 390, JSON.stringify(r));
  }

  await browser.close();
  let f = 0; console.log('\n--- store logo top-left ---');
  for (const [s, n, e] of R) { if (s === 'FAIL') f++; console.log(`${s}  ${n}${e && s === 'FAIL' ? '  [' + e + ']' : ''}`); }
  console.log(`\n${R.length - f}/${R.length} passed`);
  process.exit(f ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
