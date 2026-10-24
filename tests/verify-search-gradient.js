/**
 * Search boxes (owner request, Oct 2026): while typing, a thin red -> purple
 * -> yellow gradient outline replaces the thick blue focus ring. At rest the
 * thin purple line stays. The box must not change size when focused.
 */
const { chromium } = require('/opt/node22/lib/node_modules/playwright');

const BASE = process.env.AUDIT_BASE || 'http://127.0.0.1:8099';
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e]);
const look = (page) => page.$eval('form.search-box input', (e) => {
  const r = e.getBoundingClientRect(), c = getComputedStyle(e), t = e.getBoundingClientRect();
  return { w: r.width, h: r.height, outline: c.outlineStyle, border: c.borderTopWidth, borderColor: c.borderTopColor,
    bg: c.backgroundImage, textLeft: t.left + parseFloat(c.paddingLeft) + parseFloat(c.borderLeftWidth) };
});

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 390, height: 800 } });
  await page.route('**/script.google.com/**', (r) => r.fulfill({ contentType: 'application/json', body: '{"ok":false,"error":"offline"}' }));
  for (const pg of ['index.html', 'stores.html', 'categories.html']) {
    await page.goto(BASE + '/' + pg, { waitUntil: 'load' });
    await page.waitForTimeout(400);
    const a = await look(page);
    ok(`${pg}: at rest a thin purple line, no gradient`, a.border === '1px' && a.borderColor === 'rgb(51, 45, 99)' && a.bg === 'none', JSON.stringify(a));
    await page.focus('form.search-box input');
    const b = await look(page);
    ok(`${pg}: typing - no thick blue ring, a 2px border`, b.outline === 'none' && b.border === '2px', JSON.stringify(b));
    ok(`${pg}: ...drawn as a red -> purple -> yellow gradient`,
      /linear-gradient\(90deg, rgb\(206, 17, 38\), rgb\(51, 45, 99\), rgb\(252, 209, 22\)\)/.test(b.bg), b.bg);
    ok(`${pg}: ...and the box and its text do not move`, a.w === b.w && a.h === b.h && Math.abs(a.textLeft - b.textLeft) < 0.5, JSON.stringify({ a, b }));
  }
  await browser.close();
  let f = 0; console.log('\n--- Search box gradient outline ---');
  for (const [st, n, e] of R) { if (st === 'FAIL') f++; console.log(`${st}  ${n}${e && st === 'FAIL' ? '  [' + e + ']' : ''}`); }
  console.log(`\n${R.length - f}/${R.length} passed`);
  process.exit(f ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
