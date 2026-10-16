/**
 * Above 700px the shopper header carries Tips and My Account as words, and
 * the menu button is a three-line icon (bottom line half length, right) -
 * owner request, Oct 2026. On every page with the menu, at tablet and
 * computer widths: nothing in the header overlaps, each control can be
 * clicked, no sideways scroll. Backend mocked.
 */
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = process.env.AUDIT_BASE || 'http://127.0.0.1:8099';
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e === undefined ? '' : e]);
const SHOT = process.env.SHOT_DIR || '';
const PAGES = ['index.html', 'store.html?store=bong', 'product.html?store=bong&product=p1', 'categories.html', 'stores.html', 'customer-tips.html', 'help.html', 'recent.html'];

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const errors = [];
  for (const w of [701, 820, 1024, 1366]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: 800 }, serviceWorkers: 'block' });
    await ctx.addInitScript(() => localStorage.setItem('skiri_cookie_consent', 'true'));
    await ctx.route('**/macros/s/**', (r) => r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ ok: true, storeName: 'Bong General Store Betio', storeSlug: 'bong', products: [], stores: [], tips: [], ads: [], store: { storeName: 'Bong General Store Betio', storeSlug: 'bong' } }) }));
    for (const path of PAGES) {
      const p = await ctx.newPage();
      p.on('pageerror', (e) => errors.push(`${w} ${path}: ${e}`));
      await p.goto(BASE + '/' + path, { waitUntil: 'load' });
      await p.waitForSelector('.header-bar-links a', { timeout: 8000 }).catch(() => {});
      await p.waitForTimeout(300);
      const g = await p.evaluate(() => {
        const vis = (el) => el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
        const box = (el) => { const r = el.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom }; };
        const parts = [];
        const add = (name, el) => { if (vis(el)) parts.push([name, box(el)]); };
        add('logo', document.querySelector('.header-logo-link'));
        document.querySelectorAll('.header-bar-link').forEach((a) => add(a.textContent.trim(), a));
        add('cart', document.getElementById('header-cart-link'));
        add('menu', document.getElementById('header-menu-btn'));
        // Anything else the page itself puts in the header row (store name, nav).
        document.querySelectorAll('header.site-header .container > *:not(.header-logo-link):not(.header-menu):not(.header-bar-links):not(#header-cart-link)').forEach((el, i) => add('own' + i, el));
        const line = document.querySelector('.header-ticker-item.is-current .header-ticker-link, .header-ticker-item.is-current');
        if (line && getComputedStyle(document.querySelector('.header-ticker')).background.indexOf('rgba(0, 0, 0, 0)') !== -1 || (line && innerWidth > 600)) {
          // The advert's text itself (not its full-width box).
          const range = document.createRange(); range.selectNodeContents(line);
          const r = range.getBoundingClientRect(); if (r.width) parts.push(['advert', { l: r.left, r: r.right, t: r.top, b: r.bottom }]);
        }
        const hits = [];
        for (let i = 0; i < parts.length; i++) for (let j = i + 1; j < parts.length; j++) {
          const [a, A] = parts[i], [b, B] = parts[j];
          if (A.l < B.r - 1 && B.l < A.r - 1 && A.t < B.b - 1 && B.t < A.b - 1) hits.push(a + '×' + b);
        }
        const links = Array.from(document.querySelectorAll('.header-bar-link')).map((a) => {
          const r = a.getBoundingClientRect(); const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          return [a.textContent.trim(), !!(el && el.closest('.header-bar-link') === a)];
        });
        const half = (() => { const ps = document.querySelectorAll('.header-menu-lines path'); return ps.length === 3 && ps[2].getAttribute('d') === 'M12 18h8'; })();
        return { hits, links, half, lines: vis(document.querySelector('.header-menu-lines')), dots: vis(document.querySelector('.header-menu-dots')),
          over: document.documentElement.scrollWidth - innerWidth, parts: parts.map((x) => x[0]) };
      });
      const tag = `${w}px ${path.split('?')[0]}`;
      ok(`${tag}: Tips and My Account in the header, clickable`, g.links.length === 2 && g.links[0][0] === 'Tips' && g.links[1][0] === 'My Account' && g.links.every((x) => x[1]), JSON.stringify(g.links));
      ok(`${tag}: three-line icon (half bottom line, right), no dots`, g.lines && !g.dots && g.half);
      ok(`${tag}: nothing in the header overlaps`, g.hits.length === 0, g.hits.join(', ') + ' | ' + g.parts.join(','));
      ok(`${tag}: no sideways scroll`, g.over <= 1, String(g.over));
      if (SHOT && (w === 820 || w === 1366) && (path === 'index.html' || path.startsWith('store.html'))) {
        await p.locator('header.site-header').screenshot({ path: `${SHOT}/hdr-${w}-${path.split('.')[0]}.png` });
      }
      await p.close();
    }
    await ctx.close();
  }
  ok('no page errors', errors.length === 0, errors.join(' | ').slice(0, 400));
  await browser.close();
  let fails = 0;
  console.log('\n--- header: Tips / My Account words + three-line menu icon (above 700px) ---');
  for (const [s, n, x] of R) { if (s === 'FAIL') fails++; if (s === 'FAIL' || process.env.VERBOSE) console.log(`${s}  ${n}${x !== '' ? '  [' + x + ']' : ''}`); }
  console.log(`\n${R.length - fails}/${R.length} passed`);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
