/**
 * Seller sign-up: the wholesaler "verification call" note is a pale yellow box,
 * so its text must be dark purple, not the white the purple phone screen gives
 * the rest of the form (owner request, 2 Nov 2026). Phone and computer.
 */
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = process.env.TX_BASE || 'http://127.0.0.1:8099';
const SHOTS = process.env.CS_SHOTS || '';
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e === undefined ? '' : JSON.stringify(e)]);

(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  for (const w of [390, 1280]) {
    const ctx = await b.newContext({ viewport: { width: w, height: 844 }, serviceWorkers: 'block' });
    await ctx.addInitScript(() => {
      localStorage.setItem('skiri_cookie_consent', 'true');
      localStorage.setItem('skiri_customer_token', 'ct');
      localStorage.setItem('skiri_customer_profile', JSON.stringify({ name: 'Tebby', email: 't@x.test', emailVerified: true }));
    });
    await ctx.route('https://accounts.google.com/**', (r) => r.abort());
    await ctx.route('**/macros/s/**', (r) => r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ ok: true, customer: { customerId: 'c', name: 'Tebby', email: 't@x.test', emailVerified: true } }) }));
    const p = await ctx.newPage();
    await p.goto(BASE + '/owner/login.html?tab=register', { waitUntil: 'load' });
    await p.waitForTimeout(1000);
    await p.evaluate(() => { const r = document.querySelector('input[name="storeType"][value="wholesaler"]'); if (r) r.click(); });
    await p.waitForTimeout(200);
    const r = await p.evaluate(() => { const n = document.getElementById('wholesaler-note'); const c = getComputedStyle(n); return { shown: !n.hidden, color: c.color, bg: c.backgroundColor }; });
    ok(`${w}px: the verification-call note is dark purple on its yellow box`, r.shown && r.color === 'rgb(51, 45, 99)' && r.bg === 'rgb(255, 248, 214)', r);
    if (SHOTS) { await p.evaluate(() => document.getElementById('wholesaler-note').scrollIntoView({ block: 'center' })); await p.screenshot({ path: SHOTS + '/wholesaler-note-' + w + '.png' }); }
    await ctx.close();
  }
  await b.close();
  R.forEach((x) => console.log(x[0] + '  ' + x[1] + (x[0] === 'FAIL' ? '  [' + x[2] + ']' : '')));
  const f = R.filter((x) => x[0] === 'FAIL').length;
  console.log(`\n${R.length - f}/${R.length} passed`);
  process.exit(f ? 1 : 0);
})();
