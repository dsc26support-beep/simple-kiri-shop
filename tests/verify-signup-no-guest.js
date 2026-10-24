/**
 * Customer sign-in page (owner requests, Oct 2026): no Sign In / Create
 * Account tabs. The email form stays hidden until "Continue with email";
 * "New to Mwakete? Create an account" sits under that button. Create Account
 * shows no Guest button and no "or" line, just Google then the form, and
 * "Already have an account? Sign in" goes back. Also when the page is opened
 * straight on Create Account. Password boxes show an eye icon, not "Show".
 */
const { chromium } = require('/opt/node22/lib/node_modules/playwright');

const BASE = process.env.AUDIT_BASE || 'http://127.0.0.1:8099';
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e]);
const FAKE_GSI = `window.google = { accounts: { id: { initialize: function () {},
  renderButton: function (h) { var b = document.createElement('div'); b.style.height = '40px'; b.textContent = 'Continue as'; h.appendChild(b); } } } };`;

const seen = (page) => page.evaluate(() => {
  const vis = (el) => !!el && getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().height > 0;
  const g = document.getElementById('google-signin-wrap'), f = document.getElementById('signup-form');
  return { guest: vis(document.getElementById('guest-continue')), divider: vis(document.querySelector('.auth-divider')),
    google: vis(g), googleAboveForm: g.getBoundingClientRect().bottom <= f.getBoundingClientRect().top,
    tabs: !!document.querySelector('.auth-tabs, .auth-tab'),
    emailBtn: vis(document.getElementById('email-continue')), loginForm: vis(document.getElementById('login-form')),
    createLine: vis(document.getElementById('auth-create-line')),
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
  ok('no Sign In / Create Account tabs', !s.tabs, JSON.stringify(s));
  ok('email box, password and their links hidden until "Continue with email"', s.emailBtn && !s.loginForm, JSON.stringify(s));
  const under = await page.evaluate(() => {
    const b = document.getElementById('email-continue').getBoundingClientRect(), l = document.getElementById('auth-create-line').getBoundingClientRect();
    return { gap: l.top - b.bottom, text: document.getElementById('auth-create-line').textContent.trim() };
  });
  ok('"New to Mwakete? Create an account" sits right under "Continue with email"', s.createLine && under.gap >= 0 && under.gap < 40
    && under.text === 'New to Mwakete? Create an account', JSON.stringify(under));

  await page.click('#email-continue');
  s = await seen(page);
  ok('"Continue with email" opens the form; the create link stays, under it', s.loginForm && !s.emailBtn && s.createLine, JSON.stringify(s));
  const below = await page.evaluate(() => document.getElementById('auth-create-line').getBoundingClientRect().top
    >= document.getElementById('login-form').getBoundingClientRect().bottom);
  ok('...below the Sign in form', below);

  const eye = await page.evaluate(() => { const b = document.querySelector('.password-toggle[data-for="login-password"]');
    return { text: b.textContent.trim(), svg: !!b.querySelector('svg'), label: b.getAttribute('aria-label') }; });
  ok('password box: an eye icon, not the word "Show"', eye.text === '' && eye.svg && eye.label === 'Show password', JSON.stringify(eye));
  await page.fill('#login-password', 'secret123');
  await page.click('.password-toggle[data-for="login-password"]');
  const eye2 = await page.evaluate(() => ({ type: document.getElementById('login-password').type,
    label: document.querySelector('.password-toggle[data-for="login-password"]').getAttribute('aria-label'),
    svg: !!document.querySelector('.password-toggle[data-for="login-password"] svg') }));
  ok('...tapping it shows the password (eye with a line through it)', eye2.type === 'text' && eye2.label === 'Hide password' && eye2.svg, JSON.stringify(eye2));

  await page.click('#show-signup');
  s = await seen(page);
  ok('Create Account: no Guest', !s.guest && s.signup, JSON.stringify(s));
  ok('...no "or" line, no create link, no sign-in form', !s.divider && !s.createLine && !s.loginForm, JSON.stringify(s));
  ok('...Google still there, above the form', s.google && s.googleAboveForm, JSON.stringify(s));
  ok('...title "Create your Mwakete account"', s.title === 'Create your Mwakete account', s.title);
  ok('...the name box has focus', await page.evaluate(() => document.activeElement && document.activeElement.id === 'signup-name'));

  await page.click('#show-signin');
  s = await seen(page);
  ok('"Already have an account? Sign in" goes back: Guest, the "or" line and the create link return', s.guest && s.divider && s.createLine && !s.signup, JSON.stringify(s));

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
