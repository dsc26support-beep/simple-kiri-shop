/**
 * Two-panel sign-in (owner request, Oct 2026, Pagedone template as the
 * model): on a wide screen the form sits beside a purple Mwakete panel with
 * a framed picture; on phones only a small purple band shows above the form
 * and the picture is never downloaded. Shopper and seller sign-in and the
 * seller password reset; what each form does is unchanged.
 */
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = process.env.AUDIT_BASE || 'http://127.0.0.1:8099';
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e === undefined ? '' : e]);
const J = (x) => JSON.stringify(x);
const PAGES = [['customer-login.html', 'auth-shop.jpg'], ['owner/login.html', 'auth-seller.jpg'], ['owner/forgot-password.html', 'auth-seller.jpg']];

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const open = async (w, page) => {
    const ctx = await browser.newContext({ viewport: { width: w, height: 900 }, serviceWorkers: 'block' });
    await ctx.addInitScript(() => { localStorage.setItem('skiri_cookie_consent', 'true'); });
    await ctx.route('**/macros/s/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }));
    const imgs = [];
    ctx.on('request', (r) => { if (/auth-(shop|seller)\.jpg/.test(r.url())) imgs.push(r.url()); });
    const p = await ctx.newPage();
    const errors = [];
    p.on('pageerror', (e) => errors.push(String(e)));
    await p.goto(BASE + '/' + page, { waitUntil: 'load' });
    await p.waitForTimeout(400);
    return { ctx, p, errors, imgs };
  };
  const geo = (p) => p.evaluate(() => {
    const f = document.querySelector('.auth-split-form'), a = document.querySelector('.auth-split-panel');
    const img = a && a.querySelector('img'), shot = a && a.querySelector('.auth-panel-shot');
    const fr = f.getBoundingClientRect(), ar = a.getBoundingClientRect();
    return { fl: fr.left, fr: fr.right, ft: fr.top, al: ar.left, at: ar.top, ab: ar.bottom, ah: ar.height,
      bg: getComputedStyle(a).backgroundImage, shot: shot ? getComputedStyle(shot).display : null,
      loaded: !!(img && img.complete && img.naturalWidth > 0), title: (a.querySelector('.auth-panel-title') || {}).textContent,
      label: a.getAttribute('aria-label'), alt: img && img.getAttribute('alt'), hidden: shot && shot.getAttribute('aria-hidden'),
      over: document.documentElement.scrollWidth > window.innerWidth };
  });

  for (const [page, pic] of PAGES) {
    // wide: side by side
    {
      const { ctx, p, errors, imgs } = await open(1366, page);
      const g = await geo(p);
      ok(`${page} 1366px: form on the left, purple panel on the right, same row`, g.fr <= g.al && Math.abs(g.ft - g.at) < 200 && /gradient/.test(g.bg) && g.ah >= 540, J(g));
      ok(`${page} 1366px: framed picture shown and loaded (${pic})`, g.shot !== 'none' && g.loaded && imgs.some((u) => u.endsWith(pic)), J({ g, imgs }));
      ok(`${page}: panel is labelled, picture is decorative`, g.label === 'About Mwakete' && g.alt === '' && g.hidden === 'true' && !!g.title, J(g));
      ok(`${page} 1366px: no sideways scroll; no page errors`, !g.over && errors.length === 0, errors.join('; '));
      await ctx.close();
    }
    // phone: band on top, no picture
    {
      const { ctx, p, errors, imgs } = await open(390, page);
      const g = await geo(p);
      ok(`${page} 390px: purple band above the form, no picture`, g.ab <= g.ft + 1 && g.shot === 'none' && g.ah < 220, J(g));
      ok(`${page} 390px: the picture is not downloaded`, imgs.length === 0, J(imgs));
      ok(`${page} 390px: no sideways scroll; no page errors`, !g.over && errors.length === 0, errors.join('; '));
      await ctx.close();
    }
    for (const w of [360, 768, 1024, 1920]) {
      const { ctx, p } = await open(w, page);
      const g = await geo(p);
      ok(`${page} ${w}px: no sideways scroll, layout ${w >= 900 ? 'side by side' : 'stacked'}`, !g.over && (w >= 900 ? g.fr <= g.al : g.ab <= g.ft + 1), J(g));
      await ctx.close();
    }
  }

  // the forms still work as before
  {
    const { ctx, p } = await open(1366, 'customer-login.html');
    const v = await p.evaluate(() => ({ google: !!document.querySelector('#google-signin-btn, .google-btn, [id*="google"]'),
      guest: !!Array.from(document.querySelectorAll('a,button')).find((b) => /guest/i.test(b.textContent) && b.offsetParent) }));
    ok('Shopper page: Google and Guest are still offered beside the panel', v.google && v.guest, J(v));
    await ctx.close();
  }
  {
    const { ctx, p } = await open(1366, 'owner/login.html');
    const v = await p.evaluate(() => ({ user: !!document.querySelector('input[type="password"]'), focusable: !!document.querySelector('form button[type="submit"]') }));
    ok('Seller page: username/password form still there', v.user && v.focusable, J(v));
    await ctx.close();
  }

  await browser.close();
  let f = 0; console.log('\n--- two-panel sign-in ---');
  for (const [s, n, e] of R) { if (s === 'FAIL') f++; console.log(`${s}  ${n}${e && s === 'FAIL' ? '  [' + e + ']' : ''}`); }
  console.log(`\n${R.length - f}/${R.length} passed`);
  process.exit(f ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
