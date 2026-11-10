/**
 * Sign-in layout. Oct 2026: two panels, the form beside the owner's welcome
 * video. 10 Nov 2026 (owner): the video is gone from every sign-in page, so a
 * computer shows one centred column; phones keep the purple page (the shopper
 * page opens with the welcome screen, the seller pages with a short headline
 * band). Shopper and seller sign-in and the seller password reset; what each
 * form does is unchanged.
 */
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
// The email form waits behind "Continue with email" (Oct 2026).
const openEmail = async (pg) => { if (await pg.isVisible('#email-continue').catch(() => false)) await pg.click('#email-continue'); };
const BASE = process.env.AUDIT_BASE || 'http://127.0.0.1:8099';
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e === undefined ? '' : e]);
const J = (x) => JSON.stringify(x);
const PAGES = ['customer-login.html', 'owner/login.html', 'owner/forgot-password.html'];

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const open = async (w, page, still) => {
    const ctx = await browser.newContext({ viewport: { width: w, height: 900 }, serviceWorkers: 'block', reducedMotion: still ? 'reduce' : 'no-preference' });
    await ctx.addInitScript(() => { localStorage.setItem('skiri_cookie_consent', 'true'); });
    await ctx.route('**/macros/s/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }));
    const imgs = [];
    ctx.on('request', (r) => { if (/auth-welcome\.(webm|mp4|jpg)/.test(r.url())) imgs.push(r.url()); });
    const p = await ctx.newPage();
    const errors = [];
    p.on('pageerror', (e) => errors.push(String(e)));
    await p.goto(BASE + '/' + page, { waitUntil: 'load' });
    await p.waitForTimeout(400);
    return { ctx, p, errors, imgs };
  };
  const geo = (p) => p.evaluate(() => {
    const f = document.querySelector('.auth-split-form'), a = document.querySelector('.auth-split-panel');
    const card = document.querySelector('.auth-card').getBoundingClientRect();
    const ar = a ? a.getBoundingClientRect() : { top: 0, bottom: 0, height: 0 };
    const t = a && a.querySelector('.auth-panel-title');
    return { ft: f.getBoundingClientRect().top, ab: ar.bottom, ah: ar.height,
      panel: a ? getComputedStyle(a).display : 'absent', titleShown: !!t && t.getBoundingClientRect().height > 2,
      videos: document.querySelectorAll('video').length,
      centred: Math.abs((card.left + card.right) / 2 - window.innerWidth / 2) < 30,
      over: document.documentElement.scrollWidth > window.innerWidth };
  });

  for (const page of PAGES) {
    // wide: one centred column, no video (10 Nov 2026)
    {
      const { ctx, p, errors, imgs } = await open(1366, page);
      await p.waitForTimeout(1200);
      const g = await geo(p);
      ok(`${page} 1366px: one centred column, no side panel`, g.centred && (g.panel === 'none' || g.panel === 'absent'), J(g));
      ok(`${page} 1366px: no video on the page, none downloaded`, g.videos === 0 && !imgs.some((u) => /\.(webm|mp4)$/.test(u)), J(imgs));
      ok(`${page} 1366px: no sideways scroll; no page errors`, !g.over && errors.length === 0, errors.join('; '));
      await ctx.close();
    }
    // phone: band on top, no video
    {
      const { ctx, p, errors, imgs } = await open(390, page);
      await p.waitForTimeout(800);
      const g = await geo(p);
      if (page === 'customer-login.html') {
        // Nov 2026: the welcome screen (photo, headline, counts) replaces the band.
        const hero = await p.evaluate(() => document.getElementById('welcome-hero').getBoundingClientRect().height > 100);
        ok(`${page} 390px: the welcome screen, no band, no video`, hero && g.panel === 'absent' && g.videos === 0, J(g));
      } else {
        ok(`${page} 390px: purple band with the headline above the form, no video`, g.ab <= g.ft + 1 && g.videos === 0 && g.titleShown && g.ah < 220, J(g));
      }
      ok(`${page} 390px: the video and its poster are not downloaded`, imgs.length === 0, J(imgs));
      const ph = await p.evaluate(() => { const m = document.querySelector('main.auth-page'), a = document.querySelector('.auth-split-panel'), t = a && a.querySelector('.auth-panel-title');
        return { mainBg: m ? getComputedStyle(m).backgroundImage : '', mainH: m ? m.getBoundingClientRect().height : 0, panelBg: a ? getComputedStyle(a).backgroundImage : 'none',
          title: t ? t.textContent : '', size: t ? parseFloat(getComputedStyle(t).fontSize) : 0, extra: !!(a && a.querySelector('.auth-panel-text')) }; });
      ok(`${page} 390px: the whole page behind the card is purple, no separate band`, /gradient/.test(ph.mainBg) && ph.mainH >= 844 && ph.panelBg === 'none', J(ph));
      if (page !== 'customer-login.html') ok(`${page} 390px: one short headline, 1.5 times smaller, no second line`, ph.title.length <= 24 && Math.abs(ph.size - 18.4 / 1.5) < 0.6 && !ph.extra, J(ph));
      ok(`${page} 390px: no sideways scroll; no page errors`, !g.over && errors.length === 0, errors.join('; '));
      await ctx.close();
    }
    for (const w of [360, 768, 1024, 1920]) {
      const { ctx, p } = await open(w, page);
      const g = await geo(p);
      ok(`${page} ${w}px: no sideways scroll, one column`, !g.over && g.videos === 0 && (w >= 900 ? g.centred : g.ab <= g.ft + 1), J(g));
      await ctx.close();
    }
  }

  // phones: no grey card, words in white on the purple
  for (const page of PAGES) {
    const { ctx, p } = await open(390, page);
    const c = await p.evaluate(() => { const card = document.querySelector('.auth-card'), lab = card.querySelector('label'), inp = card.querySelector('input:not([type=hidden])');
      const tab = card.querySelector('.auth-tab.is-active, .auth-tab[aria-selected="true"]');
      // A page with no fields (the retired store-password reset page) only has the card to check.
      return { bg: getComputedStyle(card).backgroundColor, border: getComputedStyle(card).borderTopWidth, label: lab ? getComputedStyle(lab).color : 'rgb(255, 255, 255)',
        tab: tab ? getComputedStyle(tab).color : 'rgb(255, 255, 255)', input: inp ? getComputedStyle(inp).backgroundColor : 'rgb(255, 255, 255)' }; });
    ok(`${page} 390px: no grey card - the form stands on the purple, labels and tab in white, boxes white`,
      c.bg === 'rgba(0, 0, 0, 0)' && c.border === '0px' && c.label === 'rgb(255, 255, 255)' && c.tab === 'rgb(255, 255, 255)' && c.input === 'rgb(255, 255, 255)', J(c));
    await ctx.close();
  }

  // phones: a note box (seller Register Store, signed out) must not keep its
  // light grey fill under white words - it becomes a white tint on the purple.
  {
    const { ctx, p } = await open(390, 'owner/login.html?tab=register');
    const n = await p.evaluate(() => { const g = document.getElementById('register-account-gate');
      return { hidden: g.hidden, bg: getComputedStyle(g).backgroundColor, text: getComputedStyle(g.querySelector('p')).color }; });
    ok('owner/login.html 390px: "First, your Mwakete account" is readable - white words on a see-through tint, not on light grey',
      !n.hidden && n.text === 'rgb(255, 255, 255)' && /^rgba\(255, 255, 255, 0\.1/.test(n.bg), J(n));
    await ctx.close();
  }

  // shopper: "Sign in" / "Create account" and the Terms line wait for a correct entry
  {
    const { ctx, p } = await open(390, 'customer-login.html');
    const vis = () => p.evaluate(() => { const v = (el) => !!el && getComputedStyle(el).visibility === 'visible' && el.getBoundingClientRect().height > 20;
      return { code: v(document.querySelector('#login-form button[type=submit]')), signupCode: v(document.querySelector('#signup-form button[type=submit]')),
        terms: v(document.querySelector('.auth-terms-note')) }; });
    const a = await vis();
    // Welcome screen (Nov 2026, like Billdu): "Email me a sign-in link" is there
    // from the start; the Terms line still waits for a real email.
    ok('Shopper Sign In: the link button is there from the start; no Terms line yet', a.code && !a.terms, J(a));
    await openEmail(p);
    await p.fill('#login-email', 'aroita@exam'); await p.waitForTimeout(400);
    const b = await vis();
    ok('...Terms still waits for an unfinished email', b.code && !b.terms, J(b));
    await openEmail(p);
    await p.fill('#login-email', 'aroita@example.com'); await p.waitForTimeout(400);
    const c = await vis();
    // Nothing under Google on Sign in since 9 Nov 2026 (owner): no Terms line there.
    ok('...a good email: "Email me a sign-in link", and still no Terms line on Sign in', c.code && !c.terms
      && /sign-in link/.test(await p.textContent('#login-submit')), J(c));
    // Password mode now only comes up after Google finds an account with one.
    await p.evaluate(() => setLoginMode('password')); await p.waitForTimeout(400);
    const c1 = await vis();
    ok('...in password mode, Sign in waits for the password', !c1.code && !c1.terms, J(c1));
    await p.fill('#login-password', 'secret123'); await p.waitForTimeout(400);
    const c2 = await vis();
    ok('...and "Sign in" once a password is typed', c2.code && !c2.terms, J(c2));
    await p.evaluate(() => showTab('signup')); await p.waitForTimeout(400);
    const d = await vis();
    ok('Create Account: hidden until name, email and password are right', !d.signupCode && !d.terms, J(d));
    await p.fill('#signup-name', 'Aroita'); await p.fill('#signup-email', 'a@example.com'); await p.fill('#signup-password', 'short'); await p.waitForTimeout(400);
    const e = await vis();
    await p.fill('#signup-password', 'long-enough'); await p.waitForTimeout(400);
    const f = await vis();
    ok('...a short password keeps them hidden; a good one shows them', !e.signupCode && f.signupCode && f.terms, J({ e, f }));
    await ctx.close();
  }


  {
    const { ctx, p } = await open(1366, 'customer-login.html');
    const v = await p.evaluate(() => ({ google: !!document.querySelector('#google-signin-btn, .google-btn, [id*="google"]'),
      guest: !!Array.from(document.querySelectorAll('a,button')).find((b) => /guest/i.test(b.textContent) && b.offsetParent) }));
    // "Continue as guest" is back under Google (owner, 10 Nov 2026).
    ok('Shopper page: Google and "Continue as guest" are offered', v.google && v.guest, J(v));
    await ctx.close();
  }
  {
    const { ctx, p } = await open(1366, 'owner/login.html');
    const v = await p.evaluate(() => ({ password: !!document.querySelector('input[type="password"]'), signin: !!document.getElementById('login-signin-link') && !document.getElementById('login-signin').hidden }));
    ok('Seller page: one Mwakete-account sign-in, no store password field (2 Nov 2026)', !v.password && v.signin, J(v));
    await ctx.close();
  }

  await browser.close();
  let f = 0; console.log('\n--- sign-in layout ---');
  for (const [s, n, e] of R) { if (s === 'FAIL') f++; console.log(`${s}  ${n}${e && s === 'FAIL' ? '  [' + e + ']' : ''}`); }
  console.log(`\n${R.length - f}/${R.length} passed`);
  process.exit(f ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
