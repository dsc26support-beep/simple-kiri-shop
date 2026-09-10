// Tips: header link on desktop, bottom-nav tab on phone and tablet - never
// both, and never neither.
//
// Neither is the failure that matters. The bottom nav is display:none above
// 700px, so dropping the header link outright orphaned customer-tips.html on
// desktop: a page with no way in.
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = 'http://127.0.0.1:8099';

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e || '']);

  const probe = () => {
    const vis = (e) => {
      if (!e) return false;
      const r = e.getBoundingClientRect();
      return getComputedStyle(e).display !== 'none' && r.width > 0 && r.height > 0;
    };
    const headerTips = [...document.querySelectorAll('.site-nav a')]
      .find((a) => /customer-tips/.test(a.getAttribute('href') || ''));
    const navTips = [...document.querySelectorAll('.bottom-nav a')]
      .find((a) => /customer-tips/.test(a.getAttribute('href') || ''));
    return {
      headerPresent: !!headerTips, headerVisible: vis(headerTips && headerTips.closest('li')),
      navPresent: !!navTips, navVisible: vis(navTips),
      navBarVisible: vis(document.querySelector('.bottom-nav'))
    };
  };

  for (const [width, label] of [[390, 'phone'], [700, 'tablet edge'], [900, 'desktop'], [1280, 'wide']]) {
    const ctx = await browser.newContext({ viewport: { width, height: 844 } });
    await ctx.route('**/macros/s/**', (r) => r.fulfill({ status: 200,
      contentType: 'application/json', body: JSON.stringify({ ok: true, products: [], stores: [] }) }));
    const page = await ctx.newPage();
    await page.goto(BASE + '/index.html', { waitUntil: 'load' });
    await page.waitForTimeout(500);
    const g = await page.evaluate(probe);

    ok(`${label} (${width}px): exactly one Tips link is visible`,
      (g.headerVisible ? 1 : 0) + (g.navVisible ? 1 : 0) === 1, JSON.stringify(g));

    if (width <= 700) {
      ok(`${label}: Tips is the bottom-nav tab, not the header`,
        g.navVisible && !g.headerVisible, JSON.stringify(g));
    } else {
      ok(`${label}: bottom nav is gone, so Tips is in the header`,
        !g.navBarVisible && g.headerVisible, JSON.stringify(g));
    }
    // The link must stay in the markup at every width - hidden, not deleted -
    // so nothing has to rebuild it on resize.
    ok(`${label}: the header link exists in the DOM either way`, g.headerPresent, String(g.headerPresent));
    await ctx.close();
  }

  // It has to actually go somewhere.
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 844 } });
    await ctx.route('**/macros/s/**', (r) => r.fulfill({ status: 200,
      contentType: 'application/json', body: JSON.stringify({ ok: true, products: [], stores: [] }) }));
    const page = await ctx.newPage();
    await page.goto(BASE + '/index.html', { waitUntil: 'load' });
    await page.click('.site-nav .nav-tips a');
    await page.waitForURL(/customer-tips/, { timeout: 6000 }).catch(() => {});
    ok('desktop: the header link reaches the Tips page', /customer-tips/.test(page.url()), page.url());
    await ctx.close();
  }

  await browser.close();
  console.log('\n--- Tips link placement ---');
  let f = 0;
  for (const [s, n, e] of R) { if (s === 'FAIL') f++; console.log(`${s}  ${n}${e ? '  [' + e + ']' : ''}`); }
  console.log(`\n${R.length - f}/${R.length} passed`);
  process.exit(f ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
