/**
 * Browse page ☰ (owner request, 31 Oct 2026): on phones and tablets it sits at
 * the far left of the heading line, beside "Featured" - not in the red header.
 * Hidden on a computer, where the category column always shows.
 */
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = process.env.TX_BASE || 'http://127.0.0.1:8099';
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e === undefined ? '' : JSON.stringify(e)]);

(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  for (const w of [390, 820, 1280]) {
    const ctx = await b.newContext({ viewport: { width: w, height: 800 }, serviceWorkers: 'block' });
    await ctx.addInitScript(() => localStorage.setItem('skiri_cookie_consent', 'true'));
    await ctx.route('**/macros/s/**', (r) => r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ ok: true, products: [], featured: [], stores: [], total: 0 }) }));
    const p = await ctx.newPage();
    await p.goto(BASE + '/categories.html', { waitUntil: 'load' });
    await p.waitForFunction(() => document.getElementById('category-pane-heading').textContent !== 'Browse', null, { timeout: 10000 });
    // With nothing featured the page opens on the first category; the heading line is the same either way.
    const g = await p.evaluate(() => {
      const btn = document.getElementById('browse-menu-btn');
      const r = btn.getBoundingClientRect();
      const h = document.getElementById('category-pane-heading').getBoundingClientRect();
      return { shown: getComputedStyle(btn).display !== 'none', inHeader: !!btn.closest('header'), left: r.left, mid: r.top + r.height / 2,
        headLeft: h.left, headMid: h.top + h.height / 2, color: getComputedStyle(btn).color,
        paneLeft: document.getElementById('category-status').getBoundingClientRect().left,
        firstInPane: document.querySelector('.category-pane').firstElementChild.contains(btn) };
    });
    if (w < 1024) {
      ok(`${w}px: ☰ is out of the red header, at the far left of the heading line`, g.shown && !g.inHeader && g.firstInPane && g.left <= g.paneLeft && g.left < g.headLeft && Math.abs(g.mid - g.headMid) < 6, g);
      ok(`${w}px: ...drawn dark on the white page`, g.color !== 'rgb(255, 255, 255)', g);
      await p.click('#browse-menu-btn');
      await p.waitForTimeout(350);
      ok(`${w}px: tapping it opens the categories`, await p.evaluate(() => document.body.classList.contains('browse-rail-open') && document.getElementById('browse-menu-btn').getAttribute('aria-expanded') === 'true'));
    } else {
      ok(`${w}px: no ☰ on a computer (the column always shows)`, !g.shown, g);
    }
    await ctx.close();
  }
  await b.close();
  R.forEach((r) => console.log(r[0] + '  ' + r[1] + (r[0] === 'FAIL' ? '  [' + r[2] + ']' : '')));
  const f = R.filter((r) => r[0] === 'FAIL').length;
  console.log(`\n${R.length - f}/${R.length} passed`);
  process.exit(f ? 1 : 0);
})();
