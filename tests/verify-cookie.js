const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = 'http://127.0.0.1:8099';
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e || '']);

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

  async function open(width) {
    const ctx = await browser.newContext({ viewport: { width, height: 800 } });
    await ctx.route('**/macros/s/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, products: [], stores: [] }) }));
    const page = await ctx.newPage();
    // force the install pill visible so we reproduce the reported overlap
    await page.addInitScript(() => { window.__forceInstall = true; });
    await page.goto(BASE + '/index.html', { waitUntil: 'load' });
    await page.waitForSelector('.cookie-consent-banner');
    await page.evaluate(() => {
      const f = document.querySelector('.install-fab');
      if (f) f.classList.add('is-visible');
    });
    await page.waitForTimeout(120);
    return { ctx, page };
  }

  // ---- mobile ----
  let { ctx, page } = await open(390);
  const m = await page.evaluate(() => {
    const b = document.querySelector('.cookie-consent-banner');
    const btn = document.getElementById('cookie-consent-accept');
    const nav = document.querySelector('.bottom-nav');
    const fab = document.querySelector('.install-fab');
    const br = b.getBoundingClientRect(), cr = btn.getBoundingClientRect();
    const nr = nav ? nav.getBoundingClientRect() : null;
    const fr = fab && getComputedStyle(fab).display !== 'none' ? fab.getBoundingClientRect() : null;
    // what actually receives a click at the button's centre?
    const hit = document.elementFromPoint(cr.left + cr.width / 2, cr.top + cr.height / 2);
    return {
      navTop: nr ? Math.round(nr.top) : null,
      bannerBottom: Math.round(br.bottom),
      btnBottom: Math.round(cr.bottom), btnTop: Math.round(cr.top),
      viewportH: window.innerHeight,
      hitIsAccept: hit === btn || btn.contains(hit),
      bannerZ: getComputedStyle(b).zIndex,
      fabZ: fr ? getComputedStyle(fab).zIndex : null,
      fabOverlapsText: fr ? !(fr.right < br.left || fr.left > br.right || fr.bottom < br.top || fr.top > br.bottom) : false,
      fabAboveBanner: fr ? Number(getComputedStyle(fab).zIndex) > Number(getComputedStyle(b).zIndex) : false,
    };
  });

  ok('mobile: banner sits above the bottom nav', m.bannerBottom <= m.navTop + 1, `banner ${m.bannerBottom} vs nav ${m.navTop}`);
  ok('mobile: Accept button fully on screen', m.btnBottom <= m.viewportH && m.btnTop >= 0, `${m.btnTop}-${m.btnBottom} of ${m.viewportH}`);
  ok('mobile: Accept is not covered by the nav', m.btnBottom <= m.navTop + 1, `btn ${m.btnBottom} vs nav ${m.navTop}`);
  ok('mobile: a tap at Accept hits Accept', m.hitIsAccept === true);
  ok('mobile: install pill no longer paints over the notice', m.fabAboveBanner === false, `fab z=${m.fabZ} banner z=${m.bannerZ}`);

  // clicking it really dismisses and persists
  await page.click('#cookie-consent-accept');
  await page.waitForTimeout(80);
  const gone = await page.evaluate(() => ({
    removed: !document.querySelector('.cookie-consent-banner'),
    stored: localStorage.getItem('skiri_cookie_consent'),
  }));
  ok('mobile: Accept dismisses the banner', gone.removed === true);
  ok('mobile: consent persisted', gone.stored === 'true', String(gone.stored));
  await ctx.close();

  // ---- desktop: unchanged, still flush to the bottom ----
  ({ ctx, page } = await open(1000));
  const d = await page.evaluate(() => {
    const b = document.querySelector('.cookie-consent-banner');
    const nav = document.querySelector('.bottom-nav');
    return {
      bannerBottom: Math.round(b.getBoundingClientRect().bottom),
      viewportH: window.innerHeight,
      navShown: nav ? getComputedStyle(nav).display !== 'none' : false,
    };
  });
  ok('desktop: no bottom nav', d.navShown === false);
  ok('desktop: banner still flush to viewport bottom', Math.abs(d.bannerBottom - d.viewportH) <= 1, `${d.bannerBottom} vs ${d.viewportH}`);
  await ctx.close();

  await browser.close();
  let f = 0;
  console.log('\n--- Cookie banner vs bottom nav / install pill ---');
  for (const [s, n, e] of R) { if (s === 'FAIL') f++; console.log(`${s}  ${n}${e ? '  [' + e + ']' : ''}`); }
  console.log(`\n${R.length - f}/${R.length} passed`);
  process.exit(f ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
