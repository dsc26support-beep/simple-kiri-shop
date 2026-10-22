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
