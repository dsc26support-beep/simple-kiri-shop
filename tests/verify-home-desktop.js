/**
 * Home page, owner requests:
 *  1. Desktop (1025px+): everything centred - quick actions, headings,
 *     store logos, product rows (including a short last row).
 *  2. Tablet and desktop (601px+): the three changing lines sit INSIDE the
 *     red header, between logo and icons; the yellow strip is gone. Phones
 *     keep the yellow strip.
 */
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = 'http://127.0.0.1:8099';
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e === undefined ? '' : e]);
const prod = (i) => ({ productId: 'p' + i, name: 'Product ' + i, category: 'food', listingType: 'product', imageUrl: '', storeSlug: 's1', storeName: 'Store', storeIsland: 'South Tarawa', storeVillage: 'Bairiki', variants: [{ variantId: 'v' + i, label: 'One', price: 10, status: 'active', stockQty: 5 }], views: 1 });
const store = (i) => ({ storeSlug: 's' + i, storeName: 'Store ' + i, logoUrl: '', island: 'South Tarawa', village: 'Bairiki' });

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  async function open(w) {
    const ctx = await browser.newContext({ viewport: { width: w, height: 1000 } });
    await ctx.addInitScript(() => { try { localStorage.setItem('skiri_cookie_consent', 'true'); } catch (e) {} });
    await ctx.route('**/macros/s/**', (r) => r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ ok: true, products: [1, 2, 3, 4, 5, 6, 7].map(prod), stores: [1, 2, 3].map(store) }) }));
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    await page.goto(BASE + '/index.html', { waitUntil: 'load' });
    await page.waitForSelector('#trending-products-list .product-card');
    await page.waitForTimeout(300);
    return { ctx, page, errs };
  }
  const centreOff = (r, cx) => Math.abs((r.left + r.right) / 2 - cx);

  for (const w of [1280, 1440]) {
    const { ctx, page, errs } = await open(w);
    const m = await page.evaluate(() => {
      const cx = document.querySelector('.home-main .container').getBoundingClientRect();
      const box = (sel) => { const els = Array.from(document.querySelectorAll(sel)).map((e) => e.getBoundingClientRect()); return { left: Math.min(...els.map((r) => r.left)), right: Math.max(...els.map((r) => r.right)) }; };
      const cards = Array.from(document.querySelectorAll('#trending-products-list > *')).map((e) => e.getBoundingClientRect());
      const lastTop = Math.max(...cards.map((r) => r.top));
      const lastRow = cards.filter((r) => r.top === lastTop);
      const range = (rs) => ({ left: Math.min(...rs.map((r) => r.left)), right: Math.max(...rs.map((r) => r.right)) });
      return {
        cx: (cx.left + cx.right) / 2,
        quick: box('.quick-action-item'), logos: box('.logo-carousel-item'),
        firstRow: range(cards.filter((r) => r.top === cards[0].top)), lastRow: range(lastRow),
        perRow: cards.filter((r) => r.top === cards[0].top).length,
        h2: Array.from(document.querySelectorAll('.home-main h2')).map((h) => getComputedStyle(h).textAlign)
      };
    });
    ok(w + 'px: quick actions centred', centreOff(m.quick, m.cx) < 3, centreOff(m.quick, m.cx));
    ok(w + 'px: store logos centred', centreOff(m.logos, m.cx) < 3, centreOff(m.logos, m.cx));
    ok(w + 'px: product rows centred', centreOff(m.firstRow, m.cx) < 3, centreOff(m.firstRow, m.cx));
    ok(w + 'px: a short last row is centred too', centreOff(m.lastRow, m.cx) < 3, centreOff(m.lastRow, m.cx));
    ok(w + 'px: still five products across', m.perRow === 5, m.perRow);
    ok(w + 'px: section headings centred', m.h2.every((a) => a === 'center'), m.h2.join(','));
    ok(w + 'px: no errors', errs.length === 0, errs.join(' | '));
    await ctx.close();
  }

  for (const w of [601, 768, 1024, 1280, 1440]) {
    const { ctx, page } = await open(w);
    const t = await page.evaluate(() => {
      const h = document.querySelector('header.site-header').getBoundingClientRect();
      const tk = document.querySelector('.header-ticker');
      const r = tk.getBoundingClientRect();
      const item = document.querySelector('.header-ticker-item');
      const logo = document.querySelector('.header-logo-link').getBoundingClientRect();
      const menu = document.getElementById('header-menu-btn').getBoundingClientRect();
      const hero = document.querySelector('.home-main').getBoundingClientRect();
      const hit = (x) => document.elementFromPoint(x.left + x.width / 2, x.top + x.height / 2);
      return {
        inside: r.top >= h.top && r.bottom <= h.bottom - 4,
        flowGone: hero.top <= h.bottom + 1,
        colour: getComputedStyle(item).color,
        bg: getComputedStyle(tk).backgroundColor,
        logoHit: document.querySelector('.header-logo-link').contains(hit(logo)),
        menuHit: document.getElementById('header-menu-btn').contains(hit(menu)),
        textMid: (r.top + r.bottom) / 2, logoMid: (logo.top + logo.bottom) / 2
      };
    });
    ok(w + 'px: the changing lines sit inside the red header', t.inside);
    ok(w + 'px: the yellow strip no longer takes space', t.flowGone);
    ok(w + 'px: white text on the red, no yellow behind it', t.colour === 'rgb(255, 255, 255)' && /rgba\(0, 0, 0, 0\)|transparent/.test(t.bg), t.colour + ' / ' + t.bg);
    ok(w + 'px: logo and menu still take taps', t.logoHit && t.menuHit);
    ok(w + 'px: lines up with the logo', Math.abs(t.textMid - t.logoMid) <= 4, Math.round(t.textMid) + ' vs ' + Math.round(t.logoMid));
    await ctx.close();
  }

  {
    const { ctx, page } = await open(1024);
    const a = await page.evaluate(() => getComputedStyle(document.querySelector('.home-main h2')).textAlign);
    ok('tablet (1024px): layout not centred (desktop only)', a !== 'center', a);
    await ctx.close();
  }

  for (const w of [390, 600]) {
    const { ctx, page } = await open(w);
    const p = await page.evaluate(() => {
      const tk = document.querySelector('.header-ticker');
      return { pos: getComputedStyle(tk).position, bg: getComputedStyle(tk).backgroundColor, h: tk.getBoundingClientRect().height };
    });
    ok(w + 'px: phones keep the yellow strip', p.pos === 'relative' && p.bg === 'rgb(252, 209, 22)' && p.h === 28, JSON.stringify(p));
    await ctx.close();
  }

  await browser.close();
  let f = 0;
  console.log('\n--- Home: desktop centring + header lines ---');
  for (const [s, n, e] of R) { if (s === 'FAIL') f++; console.log(`${s}  ${n}${e !== '' ? '  [' + e + ']' : ''}`); }
  console.log(`\n${R.length - f}/${R.length} passed`);
  process.exit(f ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
