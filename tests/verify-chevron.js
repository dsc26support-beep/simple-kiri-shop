const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = 'http://127.0.0.1:8099';
const rgb = s => s.replace(/\s+/g, '');

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const ctx = await browser.newContext();
  await ctx.route('**/macros/s/**', (route) => {
    let action = '';
    try { action = new URL(route.request().url()).searchParams.get('action') || ''; } catch (e) {}
    let body = { ok: true, products: [], stores: [] };
    if (action === 'listProducts') body = { ok: true, storeName: 'S', storeSlug: 'x', products: [], storePhone: '' };
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });

  const results = [];
  const ok = (n, c, e) => results.push([c ? 'PASS' : 'FAIL', n, e || '']);
  const pages = ['index.html', 'categories.html', 'store.html?store=x', 'stores.html'];

  // Written for a BLUE ::after chevron, which later became grey and has now
  // been replaced by a purple disc that only appears once the shopper types.
  // Repointed twice over rather than deleted: the invariant it exists to hold
  // is that the phone treatment never escapes .search-box onto desktop.
  async function state(page) {
    return page.evaluate(() => {
      const b = document.querySelector('.search-box button[type="submit"]');
      const cs = getComputedStyle(b);
      return { bg: cs.backgroundColor, radius: cs.borderTopLeftRadius,
               afterContent: getComputedStyle(b, '::after').content,
               w: Math.round(b.getBoundingClientRect().width) };
    });
  }

  for (const p of pages) {
    const page = await ctx.newPage();
    await page.setViewportSize({ width: 390, height: 800 });
    await page.goto(BASE + '/' + p, { waitUntil: 'load' });
    await page.waitForSelector('.search-box button[type="submit"]');
    await page.fill('.search-box input[type="search"]', 'r');
    await page.waitForTimeout(300);
    const s = await state(page);
    ok(`mobile ${p}: not the desktop blue pill`, rgb(s.bg) !== 'rgb(0,63,135)', s.bg);
    ok(`mobile ${p}: a round 44px purple disc`,
       rgb(s.bg) === 'rgb(51,45,99)' && s.radius === '999px' && s.w === 44, JSON.stringify(s));
    await page.close();
  }

  // Desktop keeps blue fill + "Search"
  {
    const page = await ctx.newPage();
    await page.setViewportSize({ width: 900, height: 800 });
    await page.goto(BASE + '/index.html', { waitUntil: 'load' });
    await page.waitForSelector('.search-box button[type="submit"]');
    const bgAndText = await page.evaluate(() => {
      const b = document.querySelector('.search-box button[type="submit"]');
      return { bg: getComputedStyle(b).backgroundColor, text: b.textContent.trim(), fs: getComputedStyle(b).fontSize, radius: getComputedStyle(b).borderTopLeftRadius };
    });
    ok('desktop: blue fill retained', rgb(bgAndText.bg) === 'rgb(0,63,135)', bgAndText.bg);
    ok('desktop: shows "Search"', bgAndText.text === 'Search' && bgAndText.fs !== '0px', JSON.stringify(bgAndText));
    ok('desktop: no disc radius leaked up from the phone rules',
       bgAndText.radius !== '999px', String(bgAndText.radius));
    await page.close();
  }

  await browser.close();
  console.log('\n--- search chevron background verification ---');
  let failed = 0;
  for (const [st, n, e] of results) { if (st === 'FAIL') failed++; console.log(`${st}  ${n}${e ? '  [' + e + ']' : ''}`); }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
