// Seller and admin pages: the purple top bar stays at the top while the page
// scrolls (owner request, Oct 2026), on phones and computers, and the admin
// section menu sticks just below it rather than under it.
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = 'http://127.0.0.1:8099';
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e === undefined ? '' : e]);
const OWNER = { ownerId: 'o1', storeName: 'ADMIN', storeSlug: 'adm', status: 'active', isAdmin: true, storeType: 'retailer' };

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  for (const [w, h] of [[390, 844], [1280, 800]]) {
    for (const page of ['dashboard.html', 'orders.html', 'products.html', 'settings.html', 'admin.html']) {
      const ctx = await browser.newContext({ viewport: { width: w, height: h } });
      await ctx.addInitScript((o) => { localStorage.setItem('skiri_cookie_consent', 'true'); localStorage.setItem('skiri_owner_token', 'tok'); localStorage.setItem('skiri_owner_profile', JSON.stringify(o)); }, OWNER);
      await ctx.route('**/macros/s/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, owner: OWNER, products: [], orders: [] }) }));
      const p = await ctx.newPage();
      p.on('dialog', (d) => d.dismiss());
      await p.goto(BASE + '/owner/' + page, { waitUntil: 'load' });
      await p.waitForTimeout(900);
      await p.evaluate(() => { const d = document.createElement('div'); d.style.height = '4000px'; (document.getElementById('main') || document.body).appendChild(d); });
      const before = await p.$eval('.owner-topbar', (t) => t.getBoundingClientRect().height);
      await p.evaluate(() => window.scrollTo(0, 2500)); await p.waitForTimeout(250);
      const r = await p.evaluate(() => { const t = document.querySelector('.owner-topbar').getBoundingClientRect();
        const j = document.querySelector('.admin-jump'); const jr = j && j.getBoundingClientRect();
        return { scrollY, top: Math.round(t.top), bottom: Math.round(t.bottom), h: Math.round(t.height),
          jumpTop: jr ? Math.round(jr.top) : null, varH: getComputedStyle(document.documentElement).getPropertyValue('--owner-topbar-h') }; });
      ok(`${w}px ${page}: the purple bar stays at the top after scrolling`, r.scrollY > 1000 && r.top === 0 && r.h === Math.round(before), JSON.stringify(r));
      if (page === 'admin.html') ok(`${w}px admin: the section menu sticks just below the bar`, r.jumpTop !== null && Math.abs(r.jumpTop - r.bottom) <= 1, JSON.stringify(r));
      await ctx.close();
    }
  }
  await browser.close();
  let failed = 0;
  for (const [st, n, e] of R) { if (st === 'FAIL') failed++; console.log(`${st}  ${n}${e ? '  [' + e + ']' : ''}`); }
  console.log(`\n${R.length - failed}/${R.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
