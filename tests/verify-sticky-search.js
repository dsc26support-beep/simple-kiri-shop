// Computers: the search bar never scrolls out of sight (owner request, Oct
// 2026, sticky-search.js). Pinned under the red header on the home page, at
// the top elsewhere; nothing jumps; phones and tablets unchanged.
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = 'http://127.0.0.1:8099';
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e === undefined ? '' : e]);
const prods = Array.from({ length: 40 }, (_, i) => ({ productId: 'p' + i, name: 'Product ' + i, storeSlug: 's', storeName: 'Store', variants: [{ variantId: 'v' + i, price: 5, label: 'One' }] }));
const stores = Array.from({ length: 30 }, (_, i) => ({ storeSlug: 's' + i, storeName: 'Store ' + i, status: 'active' }));
const BODY = JSON.stringify({ ok: true, products: prods, stores, topProducts: prods, topStores: stores, store: { storeSlug: 's', storeName: 'Store', status: 'active' }, owner: { storeSlug: 's', storeName: 'Store', status: 'active' } });

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const open = async (w, path) => {
    const ctx = await browser.newContext({ viewport: { width: w, height: 800 } });
    await ctx.addInitScript(() => localStorage.setItem('skiri_cookie_consent', 'true'));
    await ctx.route('**/macros/s/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: BODY }));
    const p = await ctx.newPage();
    await p.goto(BASE + '/' + path, { waitUntil: 'load' });
    await p.waitForTimeout(1000);
    // Room to scroll whatever the mock data drew.
    await p.evaluate(() => { const d = document.createElement('div'); d.style.height = '3000px'; document.body.appendChild(d); });
    return { ctx, p };
  };
  const box = (p) => p.$eval('form.search-box', (f) => { const b = f.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, w: b.width, pinned: f.classList.contains('is-pinned') }; });

  // Categories scrolls inside its own panels (the page itself never scrolls),
  // so its search - in the header - is already always on screen.
  {
    const { ctx, p } = await open(1280, 'categories.html');
    const before = await box(p);
    const moved = await p.evaluate(() => {
      const panes = [...document.querySelectorAll('main *')].filter((el) => /auto|scroll/.test(getComputedStyle(el).overflowY));
      panes.forEach((el) => { el.scrollTop = 1500; });
      return panes.length;
    });
    await p.waitForTimeout(300);
    const after = await box(p);
    ok('categories.html: computer - the search bar stays on screen while the lists scroll', after.top === before.top && after.bottom <= 800 && moved > 0, JSON.stringify({ before, after, moved }));
    await ctx.close();
  }

  for (const path of ['index.html', 'stores.html', 'store.html?store=s']) {
    const { ctx, p } = await open(1280, path);
    const before = await box(p);
    const below = await p.evaluate(() => { const f = document.querySelector('form.search-box'); const n = [...document.querySelectorAll('main *')].find((el) => (f.compareDocumentPosition(el) & 4) && !f.contains(el) && !el.classList.contains('search-pin-spacer') && el.getBoundingClientRect().height > 0); return n ? n.getBoundingClientRect().top + scrollY : -1; });
    await p.evaluate(() => window.scrollTo(0, 1500)); await p.waitForTimeout(300);
    const after = await box(p);
    const hdr = await p.evaluate(() => { const h = document.querySelector('header.site-header'); return getComputedStyle(h).position === 'sticky' ? h.getBoundingClientRect().bottom : 0; });
    ok(`${path}: computer - the search bar stays on screen after scrolling`, after.pinned && after.top >= 0 && after.bottom <= 800, JSON.stringify(after));
    ok(`${path}: ...just below the red header when it stays, else at the top`, Math.abs(after.top - (hdr + 8)) <= 1, JSON.stringify({ after, hdr }));
    ok(`${path}: ...same width as before`, Math.abs(after.w - before.w) <= 1, JSON.stringify({ before: before.w, after: after.w }));
    const belowNow = await p.evaluate(() => { const f = document.querySelector('form.search-box'); const n = [...document.querySelectorAll('main *')].find((el) => (f.compareDocumentPosition(el) & 4) && !f.contains(el) && !el.classList.contains('search-pin-spacer') && el.getBoundingClientRect().height > 0); return n ? n.getBoundingClientRect().top + scrollY : -1; });
    ok(`${path}: ...and nothing below it jumps`, Math.abs(belowNow - below) <= 1, JSON.stringify({ below, belowNow }));
    await p.evaluate(() => window.scrollTo(0, 0)); await p.waitForTimeout(300);
    const back = await box(p);
    ok(`${path}: back at the top it returns to its place`, !back.pinned && Math.abs(back.top - before.top) <= 1, JSON.stringify({ before, back }));
    await ctx.close();
  }
  for (const w of [390, 820]) {
    const { ctx, p } = await open(w, 'index.html');
    await p.evaluate(() => window.scrollTo(0, 1500)); await p.waitForTimeout(300);
    const r = await box(p);
    ok(`${w}px: phones and tablets scroll as before (not pinned)`, !r.pinned && r.bottom < 0, JSON.stringify(r));
    await ctx.close();
  }
  await browser.close();
  let failed = 0;
  for (const [st, n, e] of R) { if (st === 'FAIL') failed++; console.log(`${st}  ${n}${e ? '  [' + e + ']' : ''}`); }
  console.log(`\n${R.length - failed}/${R.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
