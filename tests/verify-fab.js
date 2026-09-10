// Install pill vs cookie consent banner.
//
// HISTORY, because this suite used to test the opposite thing. It was written
// when both could be on screen at once and the pill sat on top of the notice
// text; it asserted the banner's z-index won at eight sampled points.
//
// That overlap is now impossible BY DESIGN, and the two rules were written to
// be in step with each other:
//
//   .install-fab            display:none  at min-width: 1025px  (styles.css)
//   .cookie-consent-banner  display:none  at max-width: 1024px  (styles.css)
//
// So the suite sat crashing for months: it waited at 390px for a banner that
// is deliberately never shown at 390px, and timed out every run. A test that
// can only ever time out guards nothing.
//
// It now asserts the invariant that REPLACED the z-index fix - the two can
// never be visible together - plus the breakpoints staying in step, which is
// the thing that would quietly bring the original bug back.
const fs = require('fs');
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = 'http://127.0.0.1:8099';
const REPO = '/home/user/simple-kiri-shop/';
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e || '']);

async function at(browser, width, height) {
  const ctx = await browser.newContext({ viewport: { width, height } });
  await ctx.route('**/macros/s/**', (r) => r.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ ok: true, products: [], stores: [] }) }));
  const page = await ctx.newPage();
  await page.goto(BASE + '/index.html', { waitUntil: 'load' });
  await page.waitForTimeout(900);

  // The pill is only injected once beforeinstallprompt fires, which cannot
  // happen headlessly. Build the same element so the CSS rules are exercised.
  const seen = await page.evaluate(() => {
    let f = document.querySelector('.install-fab');
    if (!f) {
      f = document.createElement('button');
      f.className = 'install-fab is-visible';
      f.textContent = 'Install';
      document.body.appendChild(f);
    } else {
      f.classList.add('is-visible');
    }
    const b = document.querySelector('.cookie-consent-banner');
    const vis = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return getComputedStyle(el).display !== 'none' && r.width > 0 && r.height > 0;
    };
    return { pill: vis(f), banner: vis(b), bannerInDom: !!b };
  });
  await ctx.close();
  return seen;
}

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

  const phone = await at(browser, 390, 800);
  const tablet = await at(browser, 900, 1000);
  const desktop = await at(browser, 1280, 900);

  await browser.close();

  // The invariant. If both are ever visible at once the old overlap bug is
  // back, whatever the z-index happens to say.
  [['phone', phone], ['tablet', tablet], ['desktop', desktop]].forEach(([name, m]) => {
    ok(`${name}: the pill and the notice are never both on screen`,
      !(m.pill && m.banner), JSON.stringify(m));
  });

  ok('phone: the install pill is the one that shows', phone.pill && !phone.banner, JSON.stringify(phone));
  ok('tablet: still the pill, not the notice', tablet.pill && !tablet.banner, JSON.stringify(tablet));
  ok('desktop: the notice shows and the pill does not', desktop.banner && !desktop.pill,
    JSON.stringify(desktop));

  // The consent notice is still BUILT everywhere - it is hidden by CSS, not
  // skipped by JS. If that ever changes, hiding it becomes a JS decision and
  // this whole invariant moves somewhere harder to see.
  ok('the notice is in the DOM even where it is hidden', phone.bannerInDom, JSON.stringify(phone));

  // The two breakpoints must stay adjacent. 1024/1025 with nothing between
  // them is what makes "never both" true; drift by one and there is a window
  // where both show and the original bug returns.
  const css = fs.readFileSync(REPO + 'assets/css/styles.css', 'utf8');
  const pillHide = (css.match(/@media \(min-width: (\d+)px\)\s*\{\s*\.install-fab\s*\{\s*display: none/) || [])[1];
  const bannerHide = (css.match(/@media \(max-width: (\d+)px\)\s*\{\s*\.cookie-consent-banner\s*\{\s*display: none/) || [])[1];
  ok('both breakpoints are still declared', !!pillHide && !!bannerHide, `${bannerHide} / ${pillHide}`);
  ok('and they are adjacent, leaving no width where both show',
    Number(pillHide) === Number(bannerHide) + 1, `banner hidden <=${bannerHide}, pill hidden >=${pillHide}`);

  let pass = 0;
  for (const [s, n, e] of R) { if (s === 'PASS') pass++; console.log(`${s}  ${n}${e ? '  [' + e + ']' : ''}`); }
  console.log(`\n${pass}/${R.length} passed`);
  process.exit(pass === R.length ? 0 : 1);
})();
