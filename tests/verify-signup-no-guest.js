/**
 * Customer sign-in page: Create Account shows no Guest button and no "or"
 * line, just Google then the form (owner request, Oct 2026). Sign In shows
 * both again. Also when the page is opened straight on Create Account.
 */
const { chromium } = require('/opt/node22/lib/node_modules/playwright');

const BASE = process.env.AUDIT_BASE || 'http://127.0.0.1:8099';
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e]);
const FAKE_GSI = `window.google = { accounts: { id: { initialize: function () {},
  renderButton: function (h) { var b = document.createElement('div'); b.style.height = '40px'; b.textContent = 'Continue as'; h.appendChild(b); } } } };`;

const seen = (page) => page.evaluate(() => {
  const vis = (el) => !!el && getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().height > 0;
  const g = document.getElementById('google-signin-wrap'), t = document.querySelector('.auth-tabs');
  return { guest: vis(document.getElementById('guest-continue')), divider: vis(document.querySelector('.auth-divider')),
    google: vis(g), googleAboveTabs: g.getBoundingClientRect().bottom <= t.getBoundingClientRect().top,
    title: document.getElementById('auth-title').textContent.trim(),
    signup: !document.getElementById('panel-signup').classList.contains('hidden') };
});

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx.route('**/accounts.google.com/gsi/client', (r) => r.fulfill({ contentType: 'text/javascript', body: FAKE_GSI }));
  await ctx.route('**/script.google.com/**', (r) => r.fulfill({ contentType: 'application/json', body: '{"ok":false,"error":"offline"}' }));
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(BASE + '/index.html');
  await page.evaluate(() => localStorage.setItem('skiri_cookie_consent', 'true'));

  await page.goto(BASE + '/customer-login.html', { waitUntil: 'load' });
  await page.waitForTimeout(500);
  let s = await seen(page);
  ok('Sign In: Guest and the "or" line are there', s.guest && s.divider, JSON.stringify(s));

  await page.click('#tab-signup');
  s = await seen(page);
  ok('Create Account: no Guest', !s.guest && s.signup, JSON.stringify(s));
  ok('...no "or" line', !s.divider, JSON.stringify(s));
  ok('...Google still there, above the tabs', s.google && s.googleAboveTabs, JSON.stringify(s));
  ok('...title "Create your Mwakete account"', s.title === 'Create your Mwakete account', s.title);

  await page.click('#tab-signin');
  s = await seen(page);
  ok('back to Sign In: Guest and the "or" line return', s.guest && s.divider, JSON.stringify(s));

  // Opened straight on Create Account: hidden from the first paint.
  const ctx2 = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx2.route('**/accounts.google.com/gsi/client', (r) => r.abort());
  await ctx2.route('**/script.google.com/**', (r) => r.fulfill({ contentType: 'application/json', body: '{"ok":false,"error":"offline"}' }));
  const p2 = await ctx2.newPage();
  await p2.goto(BASE + '/customer-login.html?tab=signup', { waitUntil: 'commit' });
  await p2.waitForSelector('#guest-continue', { state: 'attached' });
  const early = await p2.evaluate(() => getComputedStyle(document.getElementById('guest-continue')).display === 'none'
    || getComputedStyle(document.querySelector('.auth-guest-row')).display === 'none');
  ok('?tab=signup: Guest hidden from first paint', early);
  await p2.waitForLoadState('load');
  s = await seen(p2);
  ok('?tab=signup: no Guest, no "or" line, even with Google blocked', !s.guest && !s.divider && s.signup, JSON.stringify(s));

  ok('no page errors', errors.length === 0, errors.join('; '));
  await browser.close();
  let f = 0; console.log('\n--- Create Account without Guest ---');
  for (const [st, n, e] of R) { if (st === 'FAIL') f++; console.log(`${st}  ${n}${e && st === 'FAIL' ? '  [' + e + ']' : ''}`); }
  console.log(`\n${R.length - f}/${R.length} passed`);
  process.exit(f ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
