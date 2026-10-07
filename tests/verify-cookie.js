// Cookie notice vs the bottom nav / install pill.
//
// The notice is desktop-only now (styles.css, @media max-width 1024px:
// display none): on phones and tablets it competed with the bottom nav, the
// chat button and the install pill for very little space, and the site's
// storage is purely functional. So: at phone and tablet widths it must be
// hidden and never block anything; on desktop it shows, flush to the bottom,
// above the install pill, and Accept dismisses it for good.
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = 'http://127.0.0.1:8099';
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e || '']);

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

  async function open(width) {
    const ctx = await browser.newContext({ viewport: { width, height: 800 } });
    await ctx.route('**/macros/s/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, products: [], stores: [] }) }));
    const page = await ctx.newPage();
    await page.addInitScript(() => { window.__forceInstall = true; });
    await page.goto(BASE + '/index.html', { waitUntil: 'load' });
    await page.waitForSelector('.cookie-consent-banner', { state: 'attached' });
    await page.evaluate(() => {
      const f = document.querySelector('.install-fab');
      if (f) f.classList.add('is-visible');
    });
    await page.waitForTimeout(120);
    return { ctx, page };
  }

  // ---- phone and tablet: hidden, never in the way ----
  for (const [label, width] of [['phone', 390], ['tablet', 1000]]) {
    const { ctx, page } = await open(width);
    const s = await page.evaluate(() => {
      const b = document.querySelector('.cookie-consent-banner');
      const nav = document.querySelector('.bottom-nav');
      const navShown = nav && getComputedStyle(nav).display !== 'none';
      let navTapHitsNav = null;
      if (navShown) {
        const r = nav.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        navTapHitsNav = nav.contains(hit);
      }
      return { display: getComputedStyle(b).display, navShown, navTapHitsNav };
    });
    ok(`${label}: notice is hidden (desktop-only by design)`, s.display === 'none', s.display);
    if (s.navShown) ok(`${label}: a tap on the bottom nav reaches the nav`, s.navTapHitsNav === true);
    await ctx.close();
  }

  // ---- desktop: shown, flush to the bottom, Accept works ----
  const { ctx, page } = await open(1280);
  const d = await page.evaluate(() => {
    const b = document.querySelector('.cookie-consent-banner');
    const btn = document.getElementById('cookie-consent-accept');
    const fab = document.querySelector('.install-fab');
    const nav = document.querySelector('.bottom-nav');
    const cr = btn.getBoundingClientRect();
    const hit = document.elementFromPoint(cr.left + cr.width / 2, cr.top + cr.height / 2);
    return {
      display: getComputedStyle(b).display,
      bannerBottom: Math.round(b.getBoundingClientRect().bottom),
      viewportH: window.innerHeight,
      navShown: nav ? getComputedStyle(nav).display !== 'none' : false,
      hitIsAccept: hit === btn || btn.contains(hit),
      fabAboveBanner: fab && getComputedStyle(fab).display !== 'none'
        ? Number(getComputedStyle(fab).zIndex) > Number(getComputedStyle(b).zIndex) : false,
    };
  });
  ok('desktop: notice is shown', d.display !== 'none', d.display);
  ok('desktop: no bottom nav', d.navShown === false);
  ok('desktop: notice flush to the viewport bottom', Math.abs(d.bannerBottom - d.viewportH) <= 1, `${d.bannerBottom} vs ${d.viewportH}`);
  ok('desktop: a click at Accept hits Accept', d.hitIsAccept === true);
  ok('desktop: install pill does not paint over the notice', d.fabAboveBanner === false);

  await page.click('#cookie-consent-accept');
  await page.waitForTimeout(80);
  const gone = await page.evaluate(() => ({
    removed: !document.querySelector('.cookie-consent-banner'),
    stored: localStorage.getItem('skiri_cookie_consent'),
  }));
  ok('desktop: Accept dismisses the notice', gone.removed === true);
  ok('desktop: consent remembered', gone.stored === 'true', String(gone.stored));
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(150);
  ok('desktop: not shown again after reload', !(await page.$('.cookie-consent-banner')));
  await ctx.close();

  await browser.close();
  let f = 0;
  console.log('\n--- Cookie notice vs bottom nav / install pill ---');
  for (const [s, n, e] of R) { if (s === 'FAIL') f++; console.log(`${s}  ${n}${e ? '  [' + e + ']' : ''}`); }
  console.log(`\n${R.length - f}/${R.length} passed`);
  process.exit(f ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
