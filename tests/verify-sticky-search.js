// The search bar never scrolls out of sight (owner requests, Oct 2026,
// sticky-search.js): computers first, then phones and tablets too. Pinned
// under the red header on a computer, under the yellow strip on a phone or
// tablet home page, at the top where nothing stays on screen; nothing jumps.
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

  for (const [w, dev] of [[1280, 'computer'], [820, 'tablet'], [390, 'phone']]) for (const path of ['index.html', 'stores.html', 'store.html?store=s']) {
    const { ctx, p } = await open(w, path);
    const before = await box(p);
    const below = await p.evaluate(() => { const f = document.querySelector('form.search-box'); const n = [...document.querySelectorAll('main *')].find((el) => (f.compareDocumentPosition(el) & 4) && !f.contains(el) && !el.classList.contains('search-pin-spacer') && el.getBoundingClientRect().height > 0); return n ? n.getBoundingClientRect().top + scrollY : -1; });
    await p.evaluate(() => window.scrollTo(0, 1500)); await p.waitForTimeout(300);
    const after = await box(p);
    // The lowest bar that stays on screen: the red header, or the yellow strip.
    const hdr = await p.evaluate(() => Math.max(0, ...['header.site-header', '.header-ticker'].map((q) => document.querySelector(q))
      .filter((h) => h && getComputedStyle(h).position === 'sticky' && getComputedStyle(h).display !== 'none').map((h) => h.getBoundingClientRect().bottom)));
    ok(`${path}: ${dev} - the search bar stays on screen after scrolling`, after.pinned && after.top >= 0 && after.bottom <= 800, JSON.stringify(after));
    ok(`${path}: ...just below the bar that stays on screen (header or yellow strip), else at the top`, Math.abs(after.top - (hdr + 8)) <= 1, JSON.stringify({ after, hdr }));
    ok(`${path} ${w}px: ...same width as before`, Math.abs(after.w - before.w) <= 1, JSON.stringify({ before: before.w, after: after.w }));
    const belowNow = await p.evaluate(() => { const f = document.querySelector('form.search-box'); const n = [...document.querySelectorAll('main *')].find((el) => (f.compareDocumentPosition(el) & 4) && !f.contains(el) && !el.classList.contains('search-pin-spacer') && el.getBoundingClientRect().height > 0); return n ? n.getBoundingClientRect().top + scrollY : -1; });
    ok(`${path} ${w}px: ...and nothing below it jumps`, Math.abs(belowNow - below) <= 1, JSON.stringify({ below, belowNow }));
    await p.evaluate(() => window.scrollTo(0, 0)); await p.waitForTimeout(300);
    const back = await box(p);
    ok(`${path} ${w}px: back at the top it returns to its place`, !back.pinned && Math.abs(back.top - before.top) <= 1, JSON.stringify({ before, back }));
    await ctx.close();
  }
  // Phone home page: right under the yellow strip, not under it or over it.
  {
    const { ctx, p } = await open(390, 'index.html');
    await p.evaluate(() => window.scrollTo(0, 1500)); await p.waitForTimeout(300);
    const r = await p.evaluate(() => { const f = document.querySelector('form.search-box').getBoundingClientRect(), t = document.querySelector('.header-ticker').getBoundingClientRect();
      const el = document.elementFromPoint(f.left + 40, f.top + f.height / 2);
      return { tickerTop: t.top, tickerBottom: t.bottom, top: f.top, onTop: !!el && !!el.closest('form.search-box') }; });
    ok('390px home: the yellow strip stays at the top, the search box just beneath it', r.tickerTop === 0 && r.top >= r.tickerBottom && r.top - r.tickerBottom <= 9, JSON.stringify(r));
    ok('...and nothing covers the search box', r.onTop, JSON.stringify(r));
    await ctx.close();
  }
  await browser.close();
  let failed = 0;
  for (const [st, n, e] of R) { if (st === 'FAIL') failed++; console.log(`${st}  ${n}${e ? '  [' + e + ']' : ''}`); }
  console.log(`\n${R.length - failed}/${R.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
