/**
 * The customer sign-in page: Google, guest and email - all three the same size.
 * The "this is a shared device" box was removed (owner request, Oct 2026);
 * everyone gets the normal 60-day sign-in and can log out.
 *
 * The most important assertions here are the DEGRADED ones. This site is used
 * on slow and filtered connections, so "Google's script did not load" is an
 * ordinary Tuesday, not an edge case - and a shopper must never be left with a
 * broken page or no way in. So: unconfigured must hide the block cleanly, and
 * the email form and guest route must survive either way.
 *
 * Google is never contacted. The GIS script is stubbed at the network layer,
 * which is also the only way to test the configured path from a sandbox that
 * cannot reach accounts.google.com.
 */
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = process.env.AUDIT_BASE || 'http://127.0.0.1:8099';
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('PASS  ' + name + (detail ? '  [' + detail + ']' : '')); }
  else { fail++; console.log('FAIL  ' + name + (detail ? '  [' + detail + ']' : '')); }
};

const GSI = 'https://accounts.google.com/gsi/client';

// A stand-in for Google Identity Services. Renders a real button that fires the
// page's callback with whatever credential we hand it.
const FAKE_GSI = `
  window.google = { accounts: { id: {
    initialize: function (cfg) { window.__gsiConfig = cfg; },
    renderButton: function (el, opts) {
      window.__gsiButton = opts;
      var b = document.createElement('button');
      b.id = 'fake-google-btn';
      b.textContent = 'Continue with Google';
      // Like Google's own: as wide as asked, 40px tall for size "large".
      b.style.width = (opts && opts.width ? opts.width : 280) + 'px';
      b.style.height = '40px';
      b.addEventListener('click', function () {
        window.__gsiConfig.callback({ credential: 'FAKE.ID.TOKEN' });
      });
      el.appendChild(b);
    }
  } } };
`;

async function makeContext(browser, opts) {
  opts = opts || {};
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const posted = [];
  await ctx.route('**/script.google.com/**', async (r) => {
    let body = {};
    try { body = r.request().postDataJSON() || {}; } catch (e) {}
    posted.push(body);
    const J = (o) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
    if (body.action === 'googleSignIn') {
      return J({ ok: true, token: 'sess-tok', customer: { customerId: 'c1', name: 'Aroita', email: 'a@example.com' } });
    }
    if (body.action === 'loginCustomer') return J({ ok: true, pendingToken: 'pend' });
    if (body.action === 'verifyCustomerLogin') {
      return J({ ok: true, token: 'sess-tok', customer: { customerId: 'c1', name: 'Aroita', email: 'a@example.com' } });
    }
    return J({ ok: true });
  });

  const gsiHits = [];
  await ctx.route(GSI, (r) => {
    gsiHits.push(r.request().url());
    if (opts.gsiBlocked) return r.abort();
    return r.fulfill({ status: 200, contentType: 'application/javascript', body: FAKE_GSI });
  });

  // config.js declares `const APP_CONFIG` at top level, which is a script-scope
  // binding and NOT a window property - so it cannot be patched from an init
  // script. Serving a modified config.min.js is both simpler and closer to what
  // a real deployment does: edit the file, ship it.
  if (opts.clientId !== undefined) {
    await ctx.route('**/assets/js/config*.js', (r) => r.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body: 'const APP_CONFIG={APPS_SCRIPT_URL:"https://script.google.com/macros/s/TEST/exec",'
        + 'CURRENCY_SYMBOL:"$",SITE_NAME:"Mwakete",GOOGLE_CLIENT_ID:'
        + JSON.stringify(opts.clientId) + '};'
    }));
  }
  await ctx.addInitScript(() => { try { localStorage.setItem('skiri_cookie_consent', 'true'); } catch (e) {} });
  return { ctx, posted, gsiHits };
}

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

  // ---- unconfigured: the whole block stays away, cleanly ----
  {
    // Explicitly EMPTY, not "whatever the shipped config happens to say". The
    // site now ships a real client id, and leaving this implicit meant the
    // degraded path this block exists to test quietly stopped being tested.
    const { ctx, gsiHits } = await makeContext(browser, { clientId: '' });
    const page = await ctx.newPage();
    await page.goto(BASE + '/customer-login.html', { waitUntil: 'load' });
    await page.waitForTimeout(900);
    const wrapHidden = await page.locator('#google-signin-wrap').isHidden();
    ok('with no client id, the Google block is hidden', wrapHidden);
    ok('and Google is never contacted at all', gsiHits.length === 0, gsiHits.join(','));
    // The divider used to live INSIDE the Google wrapper and vanish with it,
    // because with no Google button there was nothing above it to divide from.
    // Guest now sits above it and is always present, so "or" is still doing its
    // job - separating the guest route from the email form - and belongs here.
    ok('the "or" divider stays, because guest is above it',
      await page.locator('.auth-divider').isVisible());
    ok('and it sits between guest and the email form', await page.evaluate(() => {
      const y = (sel) => document.querySelector(sel).getBoundingClientRect().top;
      return y('#guest-continue') < y('.auth-divider') && y('.auth-divider') < y('#login-form');
    }));
    ok('the email form still works', await page.locator('#login-form').isVisible());
    ok('and the guest route is still offered', await page.locator('#guest-continue').isVisible());
    await ctx.close();
  }

  // ---- Google's script blocked: same graceful outcome ----
  {
    const { ctx, gsiHits } = await makeContext(browser, { clientId: 'test-client', gsiBlocked: true });
    const page = await ctx.newPage();
    await page.goto(BASE + '/customer-login.html', { waitUntil: 'load' });
    await page.waitForTimeout(1200);
    ok('a blocked Google script was at least attempted', gsiHits.length === 1);
    ok('but the block stays hidden rather than half-rendered',
      await page.locator('#google-signin-wrap').isHidden());
    ok('and the email form is untouched', await page.locator('#login-form').isVisible());
    await ctx.close();
  }

  // ---- configured and loading: the button appears ----
  {
    const { ctx } = await makeContext(browser, { clientId: 'test-client' });
    const page = await ctx.newPage();
    await page.goto(BASE + '/customer-login.html', { waitUntil: 'load' });
    await page.waitForSelector('#fake-google-btn', { timeout: 5000 }).catch(() => {});
    ok('with a client id, the Google button renders',
      await page.locator('#fake-google-btn').isVisible());
    const cfg = await page.evaluate(() => window.__gsiConfig || {});
    ok('it is initialised with that client id', cfg.client_id === 'test-client', cfg.client_id);
    ok('One Tap auto-select is OFF - it would sign in as whoever used the phone last',
      cfg.auto_select === false, String(cfg.auto_select));
    await ctx.close();
  }

  // ---- signing in with Google posts the credential and stores the session ----
  {
    const { ctx, posted } = await makeContext(browser, { clientId: 'test-client' });
    const page = await ctx.newPage();
    await page.goto(BASE + '/customer-login.html', { waitUntil: 'load' });
    await page.waitForSelector('#fake-google-btn', { timeout: 5000 });
    await page.click('#fake-google-btn');
    await page.waitForTimeout(900);
    const call = posted.find((b) => b.action === 'googleSignIn');
    ok('the credential is posted to googleSignIn', !!call && call.credential === 'FAKE.ID.TOKEN',
      JSON.stringify(call || {}));
    ok('no shared-device flag is sent any more (normal sign-in length)', call && !('sharedDevice' in call),
      JSON.stringify(call || {}));
    const token = await page.evaluate(() => { try { return localStorage.getItem('skiri_customer_token'); } catch (e) { return null; } });
    ok('the session is saved on the device', token === 'sess-tok', String(token));
    await ctx.close();
  }

  // ---- email-code path: normal sign-in, no shared-device flag ----
  {
    const { ctx, posted } = await makeContext(browser, { clientId: '' });
    const page = await ctx.newPage();
    await page.goto(BASE + '/customer-login.html', { waitUntil: 'load' });
    await page.waitForTimeout(600);
    await page.fill('#login-email', 'a@example.com');
    await page.click('#login-form button[type="submit"]');
    await page.waitForTimeout(700);
    await page.fill('#login-code', '123456');
    await page.click('#login-code-form button[type="submit"]');
    await page.waitForTimeout(900);
    const call = posted.find((b) => b.action === 'verifyCustomerLogin');
    ok('the email-code sign-in sends no shared-device flag either',
      !!call && !('sharedDevice' in call), JSON.stringify(call || {}));
    await ctx.close();
  }

  // ---- all three ways in are the same size (owner request, Oct 2026) ----
  for (const w of [320, 390, 1280]) {
    const { ctx } = await makeContext(browser, { clientId: 'test-client' });
    const page = await ctx.newPage();
    await page.setViewportSize({ width: w, height: 844 });
    await page.goto(BASE + '/customer-login.html', { waitUntil: 'load' });
    await page.waitForSelector('#fake-google-btn', { timeout: 5000 });
    // The purple box around Google's button is what shows, so that is measured.
    const g = await page.evaluate(() => ['#google-signin-btn', '#guest-continue', '#login-form button[type="submit"]'].map((sel) => {
      const r = document.querySelector(sel).getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; }));
    ok(`${w}px: Google, guest and "Send me a code" are the same width`, Math.abs(g[0][0] - g[1][0]) <= 1 && Math.abs(g[1][0] - g[2][0]) <= 1, JSON.stringify(g));
    ok(`${w}px: ...and the same height (40px)`, g.every((x) => x[1] === 40), JSON.stringify(g));
    // 16px wider than the purple box (GSI_TUCK), so Google's own grey edge
    // is tucked under the purple line (owner request, Oct 2026).
    ok(`${w}px: Google was asked for that width plus 16px (within its 200-400px limits)`, await page.evaluate(() => window.__gsiButton.width) === Math.max(200, Math.min(400, g[1][0] + 16)));
    const tuck = await page.evaluate(() => {
      const box = document.getElementById('google-signin-btn').getBoundingClientRect();
      const btn = document.getElementById('fake-google-btn').getBoundingClientRect();
      const cs = getComputedStyle(document.getElementById('google-signin-btn'));
      return { l: btn.left - box.left, r: box.right - btn.right, border: cs.borderTopColor, radius: cs.borderTopLeftRadius, clip: cs.overflow };
    });
    ok(`${w}px: Google's button overhangs both sides evenly, under the purple line`, tuck.l < -1 && Math.abs(tuck.l - tuck.r) <= 1 && tuck.clip === 'hidden', JSON.stringify(tuck));
    ok(`${w}px: Google's box has the same purple outline`, await page.evaluate(() => {
      const cs = getComputedStyle(document.getElementById('google-signin-btn'));
      return cs.borderTopColor === 'rgb(51, 45, 99)' && cs.borderTopWidth === '2px';
    }));
    ok(`${w}px: no sideways scroll`, await page.evaluate(() => document.documentElement.scrollWidth - innerWidth <= 1));
    await ctx.close();
  }

  // ---- guest ----
  {
    const { ctx } = await makeContext(browser, { clientId: '' });
    const page = await ctx.newPage();
    await page.goto(BASE + '/customer-login.html', { waitUntil: 'load' });
    await page.waitForTimeout(600);
    const href = await page.getAttribute('#guest-continue', 'href');
    ok('the guest button leaves the sign-in page', href === 'index.html', String(href));
    await page.click('#guest-continue');
    await page.waitForTimeout(700);
    ok('and lands on the homepage with no account', /index\.html$/.test(page.url()), page.url());
    const token = await page.evaluate(() => { try { return localStorage.getItem('skiri_customer_token'); } catch (e) { return null; } });
    ok('a guest holds no session token', !token, String(token));
    await page.goto(BASE + '/customer-login.html', { waitUntil: 'load' });
    ok('the guest button just says Guest', (await page.textContent('#guest-continue')).trim() === 'Guest');
    ok('...with no extra note under it', (await page.$('.auth-guest-note')) === null);
    ok('every button on the card is an outline (purple, or white on the purple phone page) on a see-through fill', await page.evaluate(() =>
      [...document.querySelectorAll('.auth-card--customer .btn')].every((b) => {
        const cs = getComputedStyle(b);
        // Purple outline - white on the all-purple phone page (Oct 2026).
        return cs.backgroundColor === 'rgba(0, 0, 0, 0)' && ['rgb(51, 45, 99)', 'rgb(255, 255, 255)'].includes(cs.borderTopColor) && cs.borderTopWidth === '2px';
      })));
    // Sent here from checkout: guests can't order, so there is no guest route.
    await page.goto(BASE + '/customer-login.html?next=checkout.html&reason=order', { waitUntil: 'load' });
    ok('sent from checkout: says why, and hides the guest route',
      /sign in to place your order/i.test(await page.textContent('#auth-reason')) && await page.locator('#guest-continue').isHidden());
    await ctx.close();
  }

  // ---- checkout: guests are sent to sign in; the device still remembers ----
  {
    const cart = () => {
      try {
        localStorage.setItem('skiri_checkout_profile', JSON.stringify({
          customerName: 'Aroita', customerPhone: '73012345', customerEmail: 'a@example.com',
          island: 'Tarawa', village: 'Betio'
        }));
        localStorage.setItem('skiri_active_store', 'bong');
        localStorage.setItem('skiri_cart_bong', JSON.stringify(
          [{ variantId: 'v0', productId: 'p0', label: 'Rice 1kg', unitPrice: 5, qty: 1 }]));
      } catch (e) {}
    };
    let { ctx } = await makeContext(browser, { clientId: '' });
    await ctx.addInitScript(cart);
    let page = await ctx.newPage();
    await page.goto(BASE + '/checkout.html', { waitUntil: 'load' });
    await page.waitForURL(/customer-login\.html/, { timeout: 5000 }).catch(() => {});
    ok('a guest at checkout is sent to sign in, then back to checkout',
      /customer-login\.html\?next=checkout\.html&reason=order$/.test(page.url()), page.url());
    ok('...and their cart is kept meanwhile', await page.evaluate(() => JSON.parse(localStorage.getItem('skiri_cart_bong')).length === 1));
    await ctx.close();

    ({ ctx } = await makeContext(browser, { clientId: '' }));
    await ctx.addInitScript(cart);
    await ctx.addInitScript(() => {
      localStorage.setItem('skiri_customer_token', 'tok-aroita');
      localStorage.setItem('skiri_customer_profile', JSON.stringify({ name: 'Aroita T', email: 'aroita@example.com' }));
    });
    page = await ctx.newPage();
    await page.goto(BASE + '/checkout.html', { waitUntil: 'load' });
    await page.waitForTimeout(1200);
    const name = await page.inputValue('#customer-name').catch(() => '');
    const phone = await page.inputValue('#customer-phone').catch(() => '');
    ok('signed in, a returning shopper gets their saved name back', name === 'Aroita', name);
    ok('and their phone number', phone === '73012345', phone);
    ok('the email is the account\'s, and cannot be changed here', await page.evaluate(() => {
      const e = document.getElementById('customer-email'); return e.value === 'aroita@example.com' && e.readOnly;
    }));
    await ctx.close();
  }

  // ---- order, and the guest route surviving Google's absence -------------
  for (const [label, opts] of [['Google available', { clientId: 'test-client' }],
                               ['Google blocked', { clientId: 'test-client', gsiBlocked: true }],
                               ['Google unconfigured', { clientId: '' }]]) {
    const { ctx } = await makeContext(browser, opts);
    const page = await ctx.newPage();
    await page.goto(BASE + '/customer-login.html', { waitUntil: 'load' });
    await page.waitForTimeout(1300);

    const order = await page.$$eval('.auth-quick > *, .auth-tabs',
      (els) => els.map((e) => e.id || e.className.split(' ')[0]));
    ok(label + ': the tabs, then Google, then guest, then the divider',
      JSON.stringify(order) === JSON.stringify(
        ['auth-tabs', 'google-signin-wrap', 'auth-guest-row', 'auth-divider']), JSON.stringify(order));

    // The one that matters. The guest button is the fallback for exactly the
    // person who cannot use Google, so it must never be hidden along with it.
    ok(label + ': "Continue as guest" is visible', await page.locator('#guest-continue').isVisible());
    ok(label + ': and it is styled as a button, not bare text',
      await page.$eval('#guest-continue', (el) => {
        const cs = getComputedStyle(el);
        // .btn's default background equals the card's, so a plain .btn here is
        // invisible as a button. Outline gives it a visible edge.
        return cs.borderTopWidth !== '0px' && cs.borderTopColor !== cs.backgroundColor;
      }));
    await ctx.close();
  }

  // ---- guest has no info dot any more - just the button, plainly ----------
  {
    const { ctx } = await makeContext(browser, { clientId: 'test-client' });
    const page = await ctx.newPage();
    await page.goto(BASE + '/customer-login.html', { waitUntil: 'load' });
    await page.waitForTimeout(1300);

    ok('Continue as guest is still there', await page.locator('#guest-continue').isVisible());
    ok('its info dot and popup are gone, not just hidden',
      await page.evaluate(() => !document.getElementById('guest-info-btn') && !document.getElementById('guest-info')));
    await ctx.close();
  }

  // ---- the shared-device box and its info button are gone ----------------
  {
    const { ctx } = await makeContext(browser, { clientId: 'test-client' });
    const page = await ctx.newPage();
    await page.goto(BASE + '/customer-login.html', { waitUntil: 'load' });
    await page.waitForTimeout(1000);
    ok('no "This is a shared device" box or its info button', await page.evaluate(() =>
      !document.getElementById('shared-device') && !document.getElementById('shared-info-btn') && !document.querySelector('.auth-shared-row')
      && !/shared device/i.test(document.body.textContent)));
    await ctx.close();
    const fs = require('fs'), path = require('path');
    const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    ok('Help Centre, Privacy Policy and Terms no longer mention the removed box',
      ['help.html', 'privacy.html', 'terms.html', 'assets/js/help-content.js'].every((f) => !/This is a shared device/i.test(read(f))));
    ok('...and still tell people to log out on a shared phone',
      /shared phone, log out/i.test(read('terms.html')) && /Log out<\/strong> when you are finished/.test(read('privacy.html')));
  }

  // ---- the static "we'll email a code" line moved to the code step --------
  {
    const { ctx } = await makeContext(browser, { clientId: 'test-client' });
    const page = await ctx.newPage();
    await page.goto(BASE + '/customer-login.html', { waitUntil: 'load' });
    await page.waitForTimeout(1300);

    ok('the always-visible helper line is gone from the email step',
      !/We'll email you a 6-digit code/i.test(await page.textContent('#login-form') || ''));

    await page.fill('#login-email', 'aroita@example.com');
    await page.click('#login-form button[type="submit"]');
    await page.waitForTimeout(300);
    ok('it reappears as a confirmation on the code step instead',
      /we emailed a 6-digit code to aroita@example\.com/i.test(await page.textContent('#login-code-hint') || ''),
      await page.textContent('#login-code-hint'));
    await ctx.close();
  }

  await browser.close();
  console.log('\n' + pass + '/' + (pass + fail) + ' passed');
  process.exit(fail ? 1 : 0);
})();
