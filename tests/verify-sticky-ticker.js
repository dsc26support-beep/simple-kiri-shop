/**
 * Homepage header adverts stay on screen while the page scrolls (owner
 * request, Oct 2026). Phones: the yellow strip sticks and the red header
 * scrolls away. Tablets and computers (no yellow strip - the adverts are in
 * the red header): the red header sticks, adverts and all. Backend mocked.
 */
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = process.env.AUDIT_BASE || 'http://127.0.0.1:8099';
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e === undefined ? '' : e]);
const SHOT = process.env.SHOT_DIR || '';

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const errors = [];
  for (const [w, h] of [[390, 844], [820, 1180], [1280, 900]]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, serviceWorkers: 'block' });
    await ctx.addInitScript(() => localStorage.setItem('skiri_cookie_consent', 'true'));
    await ctx.route('**/macros/s/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, products: [], stores: [], ads: [] }) }));
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(`${w}: ${e}`));
    await p.goto(BASE + '/index.html', { waitUntil: 'load' });
    await p.waitForTimeout(600);
    // Enough page to scroll, whatever the mocked backend returned.
    await p.evaluate(() => { const s = document.createElement('div'); s.style.height = '3000px'; document.getElementById('main').appendChild(s); });
    const phone = w <= 600;
    const before = await p.evaluate(() => ({ t: document.querySelector('.header-ticker').getBoundingClientRect().top, hb: document.querySelector('.site-header').getBoundingClientRect().bottom }));
    if (phone) ok(`${w}px: at the top, the strip sits right under the red header`, Math.abs(before.t - before.hb) <= 1, JSON.stringify(before));
    await p.evaluate(() => window.scrollTo(0, 900));
    await p.waitForTimeout(150);
    const after = await p.evaluate(() => {
      const t = document.querySelector('.header-ticker').getBoundingClientRect();
      const hd = document.querySelector('.site-header').getBoundingClientRect();
      const top = document.elementFromPoint(innerWidth / 2, 14);
      const line = document.querySelector('.header-ticker-item.is-current').getBoundingClientRect();
      return { top: t.top, h: t.height, headerTop: hd.top, headerBottom: hd.bottom, onTop: !!(top && top.closest('.header-ticker')),
        lineInHeader: line.top >= hd.top && line.bottom <= hd.bottom, scrollY };
    });
    if (phone) {
      ok(`${w}px: scrolled down, the yellow strip stays at the top of the screen`, after.top === 0 && after.h === 28 && after.onTop, JSON.stringify(after));
      ok(`${w}px: ...and the red header has scrolled away`, after.headerBottom <= 0, JSON.stringify(after));
    } else {
      ok(`${w}px: scrolled down, the red header stays at the top of the screen`, after.scrollY === 900 && after.headerTop === 0 && after.headerBottom >= 56, JSON.stringify(after));
      ok(`${w}px: ...with the advert lines still inside it`, after.lineInHeader, JSON.stringify(after));
      ok(`${w}px: ...and the logo still works`, await p.evaluate(() => { const r = document.querySelector('.header-logo-link').getBoundingClientRect(); const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !!(el && el.closest('.header-logo-link')); }));
    }
    if (SHOT) await p.screenshot({ path: `${SHOT}/sticky-${w}.png` });
    await p.evaluate(() => window.scrollTo(0, 0));
    await p.waitForTimeout(100);
    ok(`${w}px: back at the top, the page looks as before`, await p.evaluate((b) => Math.abs(document.querySelector('.header-ticker').getBoundingClientRect().top - b) <= 1, before.t));
    ok(`${w}px: no sideways scroll`, await p.evaluate(() => document.documentElement.scrollWidth - innerWidth <= 1));
    await ctx.close();
  }
  ok('no page errors', errors.length === 0, errors.join(' | ').slice(0, 300));
  await browser.close();
  let fails = 0;
  console.log('\n--- homepage adverts stay on screen while scrolling ---');
  for (const [s, n, x] of R) { if (s === 'FAIL') fails++; console.log(`${s}  ${n}${x !== '' ? '  [' + x + ']' : ''}`); }
  console.log(`\n${R.length - fails}/${R.length} passed`);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
