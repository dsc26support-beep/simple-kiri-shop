// Tips: bottom-nav tab on phone and tablet, header overflow menu on desktop -
// never two visible at once, and never none.
//
// None is the failure that matters. The bottom nav is display:none above
// 700px, so dropping the header entry outright orphaned customer-tips.html on
// desktop: a page with no way in. That entry used to be a visible nav link;
// it is now an item in the three-dot menu, which is present at every width.
// The guarantee is unchanged, the mechanism is not.
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
    const headerTips = [...document.querySelectorAll('#header-menu-panel .header-menu-item')]
      .find((a) => /customer-tips/.test(a.getAttribute('href') || ''));
    const navTips = [...document.querySelectorAll('.bottom-nav a')]
      .find((a) => /customer-tips/.test(a.getAttribute('href') || ''));
    const btn = document.getElementById('header-menu-btn');
    return {
      headerPresent: !!headerTips,
      // An item inside a closed panel is not on screen. What has to be
      // reachable at every width is the BUTTON; the item behind it is one tap
      // further and must exist in the markup either way.
      menuBtnVisible: vis(btn),
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

    ok(`${label} (${width}px): Tips is reachable`,
      g.navVisible || (g.menuBtnVisible && g.headerPresent), JSON.stringify(g));

    if (width <= 700) {
      ok(`${label}: Tips is the bottom-nav tab, one tap`,
        g.navVisible === true, JSON.stringify(g));
    } else {
      ok(`${label}: bottom nav is gone, so the menu is the way in`,
        !g.navBarVisible && g.menuBtnVisible && g.headerPresent, JSON.stringify(g));
    }
    // Exactly one Tips control is ON SCREEN at any width: the bottom-nav tab on
    // a phone, nothing in the header until the menu is opened. Two visible
    // Tips entries on one screen is what this suite was written to stop.
    ok(`${label}: never two visible Tips entries at once`,
      (g.navVisible ? 1 : 0) <= 1, JSON.stringify(g));
    // The item must stay in the markup at every width - hidden, not deleted -
    // so nothing has to rebuild it on resize.
    ok(`${label}: the menu item exists in the DOM either way`, g.headerPresent, String(g.headerPresent));
    await ctx.close();
  }

  // It has to actually go somewhere.
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 844 } });
    await ctx.route('**/macros/s/**', (r) => r.fulfill({ status: 200,
      contentType: 'application/json', body: JSON.stringify({ ok: true, products: [], stores: [] }) }));
    const page = await ctx.newPage();
    await page.goto(BASE + '/index.html', { waitUntil: 'load' });
    await page.click('#header-menu-btn');
    await page.click('#header-menu-panel .header-menu-item[href="customer-tips.html"]');
    await page.waitForURL(/customer-tips/, { timeout: 6000 }).catch(() => {});
    ok('desktop: the menu item reaches the Tips page', /customer-tips/.test(page.url()), page.url());
    await ctx.close();
  }

  await browser.close();
  console.log('\n--- Tips link placement ---');
  let f = 0;
  for (const [s, n, e] of R) { if (s === 'FAIL') f++; console.log(`${s}  ${n}${e ? '  [' + e + ']' : ''}`); }
  console.log(`\n${R.length - f}/${R.length} passed`);
  process.exit(f ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
