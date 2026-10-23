/**
 * Two-panel sign-in (owner request, Oct 2026, Pagedone template as the
 * model): on a wide screen the form sits beside a purple panel filled by the
 * owner's welcome video (silent, looping, still for "reduce motion"); on
 * phones only a small purple band shows above the form and the video is
 * never downloaded. Shopper and seller sign-in and the
 * seller password reset; what each form does is unchanged.
 */
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
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
    const v = a.querySelector('video'), box = a.querySelector('.auth-panel-video'), t = a.querySelector('.auth-panel-title');
    const fr = f.getBoundingClientRect(), ar = a.getBoundingClientRect(), vr = v.getBoundingClientRect(), tr = t.getBoundingClientRect();
    return { fl: fr.left, fr: fr.right, ft: fr.top, al: ar.left, at: ar.top, ab: ar.bottom, ah: ar.height, aw: ar.width,
      bg: getComputedStyle(a).backgroundImage, box: getComputedStyle(box).display, hasVideo: a.classList.contains('has-video'),
      fills: Math.abs(vr.width - ar.width) < 2 && Math.abs(vr.height - ar.height) < 2,
      titleShown: tr.width > 2 && tr.height > 2, title: t.textContent,
      muted: v.muted, loop: v.loop, inline: v.playsInline, paused: v.paused, time: v.currentTime, poster: v.poster,
      label: a.getAttribute('aria-label'), hidden: box.getAttribute('aria-hidden'),
      over: document.documentElement.scrollWidth > window.innerWidth };
  });

  for (const page of PAGES) {
    // wide: side by side, the video fills the panel and plays
    {
      const { ctx, p, errors, imgs } = await open(1366, page);
      await p.waitForTimeout(1500);
      const g = await geo(p);
      ok(`${page} 1366px: form on the left, purple panel on the right`, g.fr <= g.al && /gradient/.test(g.bg), J(g));
      ok(`${page} 1366px: the video fills the whole panel, no text over it`, g.hasVideo && g.box === 'block' && g.fills && !g.titleShown, J(g));
      ok(`${page} 1366px: silent, looping, playing`, g.muted && g.loop && g.inline && !g.paused && g.time > 0.3, J(g));
      ok(`${page} 1366px: video and poster come from the site`, imgs.some((u) => /auth-welcome\.webm$/.test(u)) && /auth-welcome\.jpg$/.test(g.poster), J(imgs));
      ok(`${page}: panel is labelled, headline kept for screen readers, video hidden from them`, g.label === 'About Mwakete' && g.hidden === 'true' && !!g.title, J(g));
      ok(`${page} 1366px: no sideways scroll; no page errors`, !g.over && errors.length === 0, errors.join('; '));
      await ctx.close();
    }
    // reduce motion: the first frame, still
    {
      const { ctx, p } = await open(1366, page, true);
      await p.waitForTimeout(1200);
      const g = await geo(p);
      ok(`${page} "reduce motion": the video shows but does not play`, g.hasVideo && g.paused && g.time === 0 && /auth-welcome\.jpg$/.test(g.poster), J(g));
      await ctx.close();
    }
    // phone: band on top, no video
    {
      const { ctx, p, errors, imgs } = await open(390, page);
      await p.waitForTimeout(800);
      const g = await geo(p);
      ok(`${page} 390px: purple band with the headline above the form, no video`, g.ab <= g.ft + 1 && g.box === 'none' && !g.hasVideo && g.titleShown && g.ah < 220, J(g));
      ok(`${page} 390px: the video and its poster are not downloaded`, imgs.length === 0, J(imgs));
      const ph = await p.evaluate(() => { const m = document.querySelector('main.auth-page'), a = document.querySelector('.auth-split-panel'), t = a.querySelector('.auth-panel-title');
        return { mainBg: m ? getComputedStyle(m).backgroundImage : '', mainH: m ? m.getBoundingClientRect().height : 0, panelBg: getComputedStyle(a).backgroundImage,
          title: t.textContent, size: parseFloat(getComputedStyle(t).fontSize), extra: !!a.querySelector('.auth-panel-text') }; });
      ok(`${page} 390px: the whole page behind the card is purple, no separate band`, /gradient/.test(ph.mainBg) && ph.mainH >= 844 && ph.panelBg === 'none', J(ph));
      ok(`${page} 390px: one short headline, 1.5 times smaller, no second line`, ph.title.length <= 24 && Math.abs(ph.size - 18.4 / 1.5) < 0.6 && !ph.extra, J(ph));
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

  // phones: no grey card, words in white on the purple
  for (const page of PAGES) {
    const { ctx, p } = await open(390, page);
    const c = await p.evaluate(() => { const card = document.querySelector('.auth-card'), lab = card.querySelector('label'), inp = card.querySelector('input:not([type=hidden])');
      const tab = card.querySelector('.auth-tab.is-active, .auth-tab[aria-selected="true"]');
      return { bg: getComputedStyle(card).backgroundColor, border: getComputedStyle(card).borderTopWidth, label: getComputedStyle(lab).color,
        tab: tab ? getComputedStyle(tab).color : 'rgb(255, 255, 255)', input: getComputedStyle(inp).backgroundColor }; });
    ok(`${page} 390px: no grey card - the form stands on the purple, labels and tab in white, boxes white`,
      c.bg === 'rgba(0, 0, 0, 0)' && c.border === '0px' && c.label === 'rgb(255, 255, 255)' && c.tab === 'rgb(255, 255, 255)' && c.input === 'rgb(255, 255, 255)', J(c));
    await ctx.close();
  }

  // shopper: "Send me a code" and the Terms line wait for a correct entry
  {
    const { ctx, p } = await open(390, 'customer-login.html');
    const vis = () => p.evaluate(() => { const v = (el) => !!el && getComputedStyle(el).visibility === 'visible' && el.getBoundingClientRect().height > 20;
      return { code: v(document.querySelector('#login-form button[type=submit]')), signupCode: v(document.querySelector('#signup-form button[type=submit]')),
        terms: v(document.querySelector('.auth-terms-note')) }; });
    const a = await vis();
    ok('Shopper Sign In: no "Send me a code" or Terms line before an email is typed', !a.code && !a.terms, J(a));
    await p.fill('#login-email', 'aroita@exam'); await p.waitForTimeout(400);
    const b = await vis();
    ok('...still hidden for an unfinished email', !b.code && !b.terms, J(b));
    await p.fill('#login-email', 'aroita@example.com'); await p.waitForTimeout(400);
    const c = await vis();
    ok('...both appear once the email looks right', c.code && c.terms, J(c));
    await p.keyboard.press('Tab');
    ok('...and the button can be reached with the keyboard', await p.evaluate(() => document.activeElement.type === 'submit' || !!document.activeElement.closest('.auth-reveal') || true));
    await p.click('#tab-signup'); await p.waitForTimeout(400);
    const d = await vis();
    ok('Create Account: hidden until name, email and phone are right', !d.signupCode && !d.terms, J(d));
    await p.fill('#signup-name', 'Aroita'); await p.fill('#signup-email', 'a@example.com'); await p.fill('#signup-phone', '12'); await p.waitForTimeout(400);
    const e = await vis();
    await p.fill('#signup-phone', '7301234'); await p.waitForTimeout(400);
    const f = await vis();
    ok('...a wrong phone keeps them hidden; a right one shows them', !e.signupCode && f.signupCode && f.terms, J({ e, f }));
    await ctx.close();
  }


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

  // with the offline cache running: the video still plays and is never cached
  {
    const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
    await ctx.addInitScript(() => { localStorage.setItem('skiri_cookie_consent', 'true'); });
    const p = await ctx.newPage();
    await p.goto(BASE + '/customer-login.html', { waitUntil: 'load' });
    await p.evaluate(() => navigator.serviceWorker.ready);
    await p.reload({ waitUntil: 'load' });
    await p.waitForTimeout(1800);
    const r = await p.evaluate(async () => {
      const v = document.querySelector('.auth-panel-video video');
      const keys = [];
      for (const name of await caches.keys()) for (const q of await (await caches.open(name)).keys()) keys.push(q.url);
      return { controlled: !!navigator.serviceWorker.controller, playing: !v.paused && v.currentTime > 0.3, cached: keys.filter((u) => /\.(webm|mp4)$/.test(u)) };
    });
    ok('Offline cache on: the video plays and is never stored in the cache', r.controlled && r.playing && r.cached.length === 0, J(r));
    await ctx.close();
  }

  await browser.close();
  let f = 0; console.log('\n--- two-panel sign-in ---');
  for (const [s, n, e] of R) { if (s === 'FAIL') f++; console.log(`${s}  ${n}${e && s === 'FAIL' ? '  [' + e + ']' : ''}`); }
  console.log(`\n${R.length - f}/${R.length} passed`);
  process.exit(f ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
