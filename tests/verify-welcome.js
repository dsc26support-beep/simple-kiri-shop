/**
 * Welcome screen (owner request, Nov 2026, inspired by Billdu's sign-up
 * page): customer-login.html opens with a photo (phones), headline, live
 * store/product counts and the email form first; English / Kiribati switch;
 * a first visit to the homepage is sent there once. Since 9 Nov 2026 (owner)
 * Sign in is just the email box, its button and Google - nothing between,
 * nothing below.
 */
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://127.0.0.1:8099';
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e === undefined ? '' : e]);
const J = (x) => JSON.stringify(x).slice(0, 300);
const PHONE = { width: 390, height: 844 };
const DESK = { width: 1366, height: 800 };

async function makeCtx(browser, opts) {
  opts = opts || {};
  const ctx = await browser.newContext({ viewport: opts.viewport || PHONE });
  const hits = [];
  await ctx.route('**/script.google.com/**', (r) => {
    const u = r.request().url();
    hits.push(u);
    if (/siteStats/.test(u)) {
      if (opts.statsFail) return r.abort();
      return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, stores: 124, products: 3180 }) });
    }
    return r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });
  // A stand-in for Google's script, so its button shows as on the live site.
  await ctx.route('**/accounts.google.com/gsi/client', (r) => r.fulfill({ contentType: 'text/javascript',
    body: "window.google={accounts:{id:{initialize:function(){},renderButton:function(h){var b=document.createElement('div');b.style.height='40px';h.appendChild(b);}}}};" }));
  await ctx.route(/gstatic|connect\.facebook/, (r) => r.abort());
  if (!opts.fresh) await ctx.addInitScript(() => { try { localStorage.setItem('skiri_cookie_consent', 'true'); } catch (e) {} });
  return { ctx, hits };
}

const state = (page) => page.evaluate(() => {
  const vis = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden' && Number(getComputedStyle(el).opacity) > 0;
  const q = (s) => document.querySelector(s);
  return {
    hero: vis(q('#welcome-hero')),
    photo: vis(q('.welcome-photo img')),
    title: (q('.welcome-title') || {}).textContent,
    stats: (q('#welcome-stats') || {}).textContent,
    statsH: q('#welcome-stats') ? q('#welcome-stats').getBoundingClientRect().height : 0,
    close: vis(q('.welcome-close')),
    send: vis(q('#login-submit')),
    sendText: (q('#login-submit') || {}).textContent,
    email: vis(q('#login-email')),
    band: vis(q('.auth-split-panel')),
    sideways: document.documentElement.scrollWidth > window.innerWidth + 1
  };
});

(async () => {
  const browser = await chromium.launch();

  // ---- a plain visit, phone ----
  {
    const { ctx, hits } = await makeCtx(browser);
    const page = await ctx.newPage();
    const errs = []; page.on('pageerror', (e) => errs.push(e.message));
    await page.goto(BASE + '/customer-login.html', { waitUntil: 'load' });
    await page.waitForTimeout(800);
    const s = await state(page);
    ok('phone: the welcome shows with its photo', s.hero && s.photo, J(s));
    ok('phone: headline', s.title === 'Shop Kiribati’s stores', J(s.title));
    ok('phone: live counts from siteStats', s.stats === '124 stores · 3,180 products' && hits.some((u) => /action=siteStats/.test(u)), J(s.stats));
    ok('phone: the email box and "Email me a sign-in link" are there from the start', s.email && s.send && /sign-in link/.test(s.sendText), J(s));
    const gap = await page.evaluate(() => {
      const send = document.getElementById('login-submit').getBoundingClientRect();
      const g = document.querySelector('#google-signin-wrap .auth-provider-btn').getBoundingClientRect();
      const email = document.getElementById('login-email').getBoundingClientRect();
      // Every visible text block on the card between the email box and the bottom.
      const extra = [...document.querySelectorAll('.auth-card--customer p, .auth-card--customer a, .auth-card--customer button')]
        .filter((el) => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden' && el.getBoundingClientRect().top > email.bottom
          && !el.closest('#google-signin-wrap') && el.id !== 'login-submit' && el.textContent.trim())
        .map((el) => el.textContent.trim().slice(0, 40));
      return { sendTop: send.top, googleTop: g.top, emailBottom: email.bottom, extra };
    });
    ok('phone: email box, then "Email me a sign-in link", then Google', gap.emailBottom < gap.sendTop && gap.sendTop < gap.googleTop, J(gap));
    ok('phone: nothing else between the email box and Google, nor below it', gap.extra.length === 0, J(gap.extra));
    ok('phone: the old purple band is replaced', !s.band, J(s));
    ok('phone: no close X on a normal visit (the header has Home)', !s.close, J(s));
    ok('phone: no sideways scroll, no page errors', !s.sideways && errs.length === 0, errs.join(' | '));

    // Empty email: a message, not a request.
    const before = hits.length;
    await page.click('#login-submit');
    await page.waitForTimeout(300);
    ok('tapping the link button with no email asks for one', /email/i.test(await page.textContent('#login-error')) && !hits.slice(before).some((u) => /loginCustomer/.test(u)));

    // English / Kiribati
    await page.click('.welcome-lang button[data-lang="gil"]');
    const k = await state(page);
    ok('Kiribati: the welcome text switches', k.title !== 'Shop Kiribati’s stores' && /titoa/.test(k.stats) && await page.getAttribute('#welcome-hero', 'lang') === 'gil', J(k));
    ok('Kiribati: the switch says which is on', await page.getAttribute('.welcome-lang button[data-lang="gil"]', 'aria-pressed') === 'true');
    await page.reload({ waitUntil: 'load' });
    await page.waitForTimeout(500);
    ok('Kiribati is remembered on this phone', (await state(page)).title !== 'Shop Kiribati’s stores');
    await page.click('.welcome-lang button[data-lang="en"]');
    ok('...and English comes back', (await state(page)).title === 'Shop Kiribati’s stores');
    await ctx.close();
  }

  // ---- counts fail: nothing made up, nothing moves ----
  {
    const { ctx } = await makeCtx(browser, { statsFail: true });
    const page = await ctx.newPage();
    await page.goto(BASE + '/customer-login.html', { waitUntil: 'load' });
    await page.waitForTimeout(800);
    const s = await state(page);
    ok('counts unavailable: the line stays empty (no made-up number)', s.stats === '' && s.hero, J(s));
    ok('...but its space is kept, so nothing jumps when counts do arrive', s.statsH >= 20, J(s.statsH));
    await ctx.close();
  }

  // ---- first visit: a close X back to the homepage ----
  {
    const { ctx } = await makeCtx(browser);
    const page = await ctx.newPage();
    await page.goto(BASE + '/customer-login.html?welcome=1', { waitUntil: 'load' });
    await page.waitForTimeout(400);
    const s = await state(page);
    ok('first visit: a close X that goes to the homepage', s.close && /index\.html$/.test(await page.getAttribute('.welcome-close', 'href')), J(s));
    await ctx.close();
  }

  // ---- not on the screens with a job to do ----
  for (const [q, why] of [['?reason=order&next=checkout.html', 'sent to order'], ['?tab=signup', 'Create account'], ['?reason=meeting', 'requesting a meeting']]) {
    const { ctx } = await makeCtx(browser);
    const page = await ctx.newPage();
    await page.goto(BASE + '/customer-login.html' + q, { waitUntil: 'load' });
    await page.waitForTimeout(400);
    const s = await state(page);
    ok(why + ': no welcome', !s.hero, J(s));
    await ctx.close();
  }

  // ---- computer: the video panel stays, the phone photo is never loaded ----
  {
    const { ctx } = await makeCtx(browser, { viewport: DESK });
    const page = await ctx.newPage();
    const imgs = []; page.on('request', (r) => { if (/welcome-phone\.jpg/.test(r.url())) imgs.push(r.url()); });
    await page.goto(BASE + '/customer-login.html', { waitUntil: 'load' });
    await page.waitForTimeout(800);
    const s = await state(page);
    ok('computer: welcome text and counts beside the video panel', s.hero && s.band && s.stats === '124 stores · 3,180 products', J(s));
    ok('computer: the phone photo is not shown or downloaded', !s.photo && imgs.length === 0, J(imgs));
    ok('computer: no sideways scroll', !s.sideways);
    await ctx.close();
  }

  // ---- the homepage sends a brand-new visitor here once ----
  {
    const { ctx } = await makeCtx(browser, { fresh: true });
    // Automated browsers are skipped on purpose; pretend to be a person.
    await ctx.addInitScript(() => { Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false }); });
    const page = await ctx.newPage();
    await page.goto(BASE + '/index.html', { waitUntil: 'load' });
    await page.waitForTimeout(500);
    ok('first visit to the homepage opens the welcome', /customer-login\.html\?welcome=1$/.test(page.url()), page.url());
    ok('...and remembers it was shown', await page.evaluate(() => localStorage.getItem('mwk_welcomed') === '1'));
    await page.goto(BASE + '/index.html', { waitUntil: 'load' });
    await page.waitForTimeout(300);
    ok('second visit: the homepage, no welcome', /index\.html$/.test(page.url()), page.url());
    await ctx.close();
  }
  for (const [path, why] of [['/index.html?q=rice', 'a link with a search'], ['/index.html#stores', 'a link to a section']]) {
    const { ctx } = await makeCtx(browser, { fresh: true });
    await ctx.addInitScript(() => { Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false }); });
    const page = await ctx.newPage();
    await page.goto(BASE + path, { waitUntil: 'load' });
    await page.waitForTimeout(300);
    ok(why + ': straight to the homepage', /index\.html/.test(page.url()), page.url());
    await ctx.close();
  }
  {
    const { ctx } = await makeCtx(browser, { fresh: true });
    await ctx.addInitScript(() => { Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false }); try { if (!sessionStorage.getItem('x')) { localStorage.setItem('skiri_customer_token', 't'); sessionStorage.setItem('x', '1'); } } catch (e) {} });
    const page = await ctx.newPage();
    await page.goto(BASE + '/index.html', { waitUntil: 'load' });
    await page.waitForTimeout(300);
    ok('a signed-in shopper: straight to the homepage', /index\.html$/.test(page.url()), page.url());
    await ctx.close();
  }
  {
    const { ctx } = await makeCtx(browser, { fresh: true });
    const page = await ctx.newPage();
    await page.goto(BASE + '/index.html', { waitUntil: 'load' });
    await page.waitForTimeout(300);
    ok('automated browsers (search engines, test tools) get the homepage', /index\.html$/.test(page.url()), page.url());
    await ctx.close();
  }

  await browser.close();
  R.forEach(([s, n, e]) => console.log(s + '  ' + n + (e && s === 'FAIL' ? '  [' + e + ']' : '')));
  const failed = R.filter((r) => r[0] === 'FAIL').length;
  console.log('\n' + (R.length - failed) + '/' + R.length + ' passed');
  process.exit(failed ? 1 : 0);
})();
