const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = 'http://127.0.0.1:8099';
const results = [];
const ok = (n, c, e) => results.push([c ? 'PASS' : 'FAIL', n, e || '']);

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 800 } });
  await ctx.route('**/macros/s/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, products: [], stores: [] }) }));
  const page = await ctx.newPage();
  // index.html, not cart.html: the Cart tab became Browse, so cart.html has no
  // matching tab any more - same as checkout/product/store/search always have.
  await page.goto(BASE + '/index.html', { waitUntil: 'load' });
  await page.waitForFunction(() => !!document.querySelector('.bottom-nav'));

  const st = await page.evaluate(() => {
    const nav = document.querySelector('.bottom-nav');
    const active = nav.querySelector('.bottom-nav-item.is-active'); // Home on index.html
    const activeColor = getComputedStyle(active).color;
    const svg = nav.querySelector('.bottom-nav-icon svg');
    const r = svg.getBoundingClientRect();
    return {
      activeColor,
      iconW: Math.round(r.width), iconH: Math.round(r.height),
      svgHasWidthAttr: svg.hasAttribute('width'),
      biggestIcon: Math.max(...[...nav.querySelectorAll('.bottom-nav-icon svg')].map(s => s.getBoundingClientRect().width)),
      display: getComputedStyle(nav).display,
    };
  });

  ok('active tab color is theme purple #332d63', st.activeColor === 'rgb(51, 45, 99)', st.activeColor);

  // A page with no matching tab must simply have none highlighted, not crash
  // or mark the wrong one.
  const cartPage = await ctx.newPage();
  await cartPage.goto(BASE + '/cart.html', { waitUntil: 'load' });
  await cartPage.waitForFunction(() => !!document.querySelector('.bottom-nav'));
  const cartActive = await cartPage.evaluate(() =>
    document.querySelectorAll('.bottom-nav-item.is-active').length);
  ok('cart.html highlights the Cart tab again', cartActive === 1, String(cartActive));
  const cartLabel = await cartPage.evaluate(() => {
    const el = document.querySelector('.bottom-nav-item.is-active .bottom-nav-label');
    return el ? el.textContent.trim() : null;
  });
  ok('and the highlighted tab is Cart', cartLabel === 'Cart', String(cartLabel));
  await cartPage.close();
  ok('icons are 24px (not ballooned)', st.iconW === 24 && st.iconH === 24, `${st.iconW}x${st.iconH}`);
  ok('no icon exceeds 24px', st.biggestIcon <= 25, String(st.biggestIcon));
  ok('SVG carries explicit width attr (stale-CSS safe)', st.svgHasWidthAttr === true);
  ok('nav still renders as 5-col grid on mobile', st.display === 'grid', st.display);

  await browser.close();
  let failed = 0;
  console.log('\n--- Bottom nav restyle (purple + bounded icons) ---');
  for (const [s, n, e] of results) { if (s === 'FAIL') failed++; console.log(`${s}  ${n}${e ? '  [' + e + ']' : ''}`); }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
