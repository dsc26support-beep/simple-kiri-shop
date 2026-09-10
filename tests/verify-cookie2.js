const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = 'http://127.0.0.1:8099';
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e || '']);
(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  async function probe(width) {
    const ctx = await browser.newContext({ viewport: { width, height: 800 } });
    await ctx.route('**/macros/s/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, products: [], stores: [] }) }));
    const page = await ctx.newPage();
    await page.goto(BASE + '/index.html', { waitUntil: 'load' });
    await page.waitForTimeout(200);
    const out = await page.evaluate(() => {
      const b = document.querySelector('.cookie-consent-banner');
      if (!b) return { present: false };
      const cs = getComputedStyle(b);
      const r = b.getBoundingClientRect();
      return { present: true, display: cs.display, visible: cs.display !== 'none' && r.height > 0, height: Math.round(r.height), z: cs.zIndex, bottom: Math.round(r.bottom) };
    });
    await ctx.close();
    return out;
  }

  for (const [label, w] of [['phone', 390], ['large phone', 430], ['tablet portrait', 768], ['tablet landscape', 1024]]) {
    const s = await probe(w);
    ok(`${label} (${w}px): banner not visible`, s.present && s.visible === false, JSON.stringify(s));
  }
  for (const [label, w] of [['desktop', 1025], ['wide desktop', 1440]]) {
    const s = await probe(w);
    ok(`${label} (${w}px): banner still shown`, s.visible === true, JSON.stringify(s));
    ok(`${label} (${w}px): flush to viewport bottom`, Math.abs(s.bottom - 800) <= 1, String(s.bottom));
    ok(`${label} (${w}px): z-index 1003`, s.z === '1003', s.z);
  }

  // still dismissible on desktop
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await ctx.route('**/macros/s/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, products: [], stores: [] }) }));
    const page = await ctx.newPage();
    await page.goto(BASE + '/index.html', { waitUntil: 'load' });
    await page.waitForSelector('.cookie-consent-banner');
    await page.click('#cookie-consent-accept');
    await page.waitForTimeout(80);
    const g = await page.evaluate(() => ({ removed: !document.querySelector('.cookie-consent-banner'), stored: localStorage.getItem('skiri_cookie_consent') }));
    ok('desktop: Accept still dismisses and persists', g.removed === true && g.stored === 'true', JSON.stringify(g));
    await ctx.close();
  }

  // no dead rule left behind
  const css = require('fs').readFileSync('/home/user/simple-kiri-shop/assets/css/styles.css', 'utf8');
  ok('no unreachable has-bottom-nav banner offset remains', !/has-bottom-nav\s+\.cookie-consent-banner/.test(css));

  await browser.close();
  let f = 0;
  console.log('\n--- Consent banner: desktop only ---');
  for (const [s, n, e] of R) { if (s === 'FAIL') f++; console.log(`${s}  ${n}${e ? '  [' + e + ']' : ''}`); }
  console.log(`\n${R.length - f}/${R.length} passed`);
  process.exit(f ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
