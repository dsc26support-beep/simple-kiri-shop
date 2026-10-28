/**
 * Drive with Mwakete, application waiting (owner request, Oct 2026): a "Call
 * Mwakete Admin" button that dials 7300 7552 (+686), with "Tai raraoma akea
 * ana bwi." under it.
 */
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = process.env.AUDIT_BASE || 'http://127.0.0.1:8099';
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e === undefined ? '' : e]);

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx.addInitScript(() => {
    localStorage.setItem('skiri_cookie_consent', 'true');
    localStorage.setItem('skiri_customer_token', 'c');
    localStorage.setItem('skiri_customer_profile', '{"customerId":"c1","name":"T","email":"t@x.com","emailVerified":true}');
  });
  await ctx.route('**/macros/s/**', (r) => r.fulfill({ contentType: 'application/json',
    body: JSON.stringify({ ok: true, enabled: true, driver: { status: 'pending' }, mine: [], open: [], earnings: {} }) }));
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(BASE + '/driver.html', { waitUntil: 'load' });
  await page.waitForTimeout(1000);
  ok('waiting screen shows', await page.isVisible('#drv-wait'));
  const b = await page.evaluate(() => { const a = document.getElementById('drv-call-admin'), n = document.querySelector('.drv-call-note');
    const ra = a.getBoundingClientRect(), rn = n.getBoundingClientRect();
    return { text: a.textContent.trim(), href: a.getAttribute('href'), note: n.textContent.trim(), below: rn.top >= ra.bottom, visible: ra.height > 0 }; });
  ok('a "Call Mwakete Admin" button', b.visible && b.text === 'Call Mwakete Admin', JSON.stringify(b));
  ok('...that dials the admin, 7300 7552 (+686)', b.href === 'tel:+68673007552', b.href);
  ok('..."Tai raraoma akea ana bwi." right under it', b.note === 'Tai raraoma akea ana bwi.' && b.below, JSON.stringify(b));
  ok('no page errors', errors.length === 0, errors.join('; '));
  await browser.close();
  let f = 0; console.log('\n--- Driver waiting: call the admin ---');
  for (const [st, n, e] of R) { if (st === 'FAIL') f++; console.log(`${st}  ${n}${e && st === 'FAIL' ? '  [' + e + ']' : ''}`); }
  console.log(`\n${R.length - f}/${R.length} passed`);
  process.exit(f ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
