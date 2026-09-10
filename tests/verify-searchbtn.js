const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = 'http://127.0.0.1:8099';

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const ctx = await browser.newContext();
  await ctx.route('**/macros/s/**', (route) => {
    let action = '';
    try { const u = new URL(route.request().url()); action = u.searchParams.get('action') || ''; } catch (e) {}
    let body = { ok: true, products: [], stores: [] };
    if (action === 'listProducts') body = { ok: true, storeName: 'X', storeSlug: 'x', products: [], storePhone: '' };
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });

  const results = [];
  const ok = (n, c, e) => results.push([c ? 'PASS' : 'FAIL', n, e || '']);

  const pages = [
    ['index.html', 'index.html'],
    ['search.html', 'search.html'],
    ['store.html?store=x', 'store.html'],
    ['stores.html', 'stores.html'],
  ];

  async function searchBtnState(page) {
    return page.evaluate(() => {
      const btn = document.querySelector('.search-box button[type="submit"]');
      if (!btn) return null;
      const cs = getComputedStyle(btn);
      const after = getComputedStyle(btn, '::after');
      const label = btn.querySelector('.search-submit-label');
      return { fontSize: cs.fontSize, afterContent: after.content, text: btn.textContent.trim(),
               // The label is clipped now rather than shrunk to font-size 0.
               labelClipped: label ? getComputedStyle(label).position === 'absolute' : null,
               iconShown: !!btn.querySelector('.search-submit-icon') &&
                 getComputedStyle(btn.querySelector('.search-submit-icon')).display !== 'none' };
    });
  }

  // Mobile
  for (const [path, label] of pages) {
    const page = await ctx.newPage();
    await page.setViewportSize({ width: 390, height: 800 });
    await page.goto(BASE + '/' + path, { waitUntil: 'load' });
    await page.waitForSelector('.search-box button[type="submit"]');
    // The font-size:0 + ">" pair is gone: the word is clipped with .sr-only
    // geometry and a magnifying glass is drawn instead. The a11y assertion -
    // the reason this suite exists - is unchanged and still the important one.
    await page.fill('.search-box input[type="search"]', 'r');
    await page.waitForTimeout(300);
    const s = await searchBtnState(page);
    ok(`mobile ${label}: label clipped, not shrunk to nothing`, s && s.labelClipped === true, s && s.fontSize);
    ok(`mobile ${label}: shows a magnifying glass`, s && s.iconShown === true, JSON.stringify(s));
    ok(`mobile ${label}: real "Search" text still in DOM (a11y)`, s && s.text === 'Search', s && s.text);
    await page.close();
  }

  // Desktop
  {
    const page = await ctx.newPage();
    await page.setViewportSize({ width: 900, height: 800 });
    await page.goto(BASE + '/index.html', { waitUntil: 'load' });
    await page.waitForSelector('.search-box button[type="submit"]');
    const s = await searchBtnState(page);
    ok('desktop: shows "Search" text', s && s.fontSize !== '0px', s && s.fontSize);
    ok('desktop: no ">" glyph', s && (s.afterContent === 'none' || s.afterContent === 'normal' || !/>/.test(s.afterContent)), s && s.afterContent);
    await page.close();
  }

  // Non-search submit button unaffected on mobile: the chat name-form "Continue"
  // button on store.html (always in the DOM, not inside .search-box).
  {
    const page = await ctx.newPage();
    await page.setViewportSize({ width: 390, height: 800 });
    await page.goto(BASE + '/store.html?store=x', { waitUntil: 'load' });
    const po = await page.evaluate(() => {
      const b = document.querySelector('.chat-name-form button[type="submit"]');
      if (!b) return null;
      return { fontSize: getComputedStyle(b).fontSize, text: b.textContent.trim() };
    });
    ok('mobile: non-search (chat Continue) unaffected', po && po.fontSize !== '0px' && /Continue/.test(po.text), JSON.stringify(po));
    await page.close();
  }

  await browser.close();
  console.log('\n--- search button label verification ---');
  let failed = 0;
  for (const [st, n, e] of results) { if (st === 'FAIL') failed++; console.log(`${st}  ${n}${e ? '  [' + e + ']' : ''}`); }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
