/**
 * The customer sign-in page: Google, guest, and "this is a shared device".
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
    renderButton: function (el) {
      var b = document.createElement('button');
      b.id = 'fake-google-btn';
      b.textContent = 'Continue with Google';
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
  if (opts.clientId) {
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
    const { ctx, gsiHits } = await makeContext(browser, {});
    const page = await ctx.newPage();
    await page.goto(BASE + '/customer-login.html', { waitUntil: 'load' });
    await page.waitForTimeout(900);
    const wrapHidden = await page.locator('#google-signin-wrap').isHidden();
    ok('with no client id, the Google block is hidden', wrapHidden);
    ok('and Google is never contacted at all', gsiHits.length === 0, gsiHits.join(','));
    const dividerVisible = await page.locator('.auth-divider').isVisible();
    ok('and no stray "or" divider is left behind', dividerVisible === false);
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
    ok('sharedDevice defaults to false when the box is unticked', call && call.sharedDevice === false,
      String(call && call.sharedDevice));
    const token = await page.evaluate(() => { try { return localStorage.getItem('skiri_customer_token'); } catch (e) { return null; } });
    ok('the session is saved on the device', token === 'sess-tok', String(token));
    await ctx.close();
  }

  // ---- the shared-device box reaches the backend, on BOTH paths ----
  {
    const { ctx, posted } = await makeContext(browser, { clientId: 'test-client' });
    const page = await ctx.newPage();
    await page.goto(BASE + '/customer-login.html', { waitUntil: 'load' });
    await page.waitForSelector('#fake-google-btn', { timeout: 5000 });
    await page.check('#shared-device');
    await page.click('#fake-google-btn');
    await page.waitForTimeout(900);
    const call = posted.find((b) => b.action === 'googleSignIn');
    ok('ticking shared device sends sharedDevice:true on the Google path',
      call && call.sharedDevice === true, String(call && call.sharedDevice));
    await ctx.close();
  }
  {
    const { ctx, posted } = await makeContext(browser, {});
    const page = await ctx.newPage();
    await page.goto(BASE + '/customer-login.html', { waitUntil: 'load' });
    await page.waitForTimeout(600);
    await page.check('#shared-device');
    await page.fill('#login-email', 'a@example.com');
    await page.click('#login-form button[type="submit"]');
    await page.waitForTimeout(700);
    await page.fill('#login-code', '123456');
    await page.click('#login-code-form button[type="submit"]');
    await page.waitForTimeout(900);
    const call = posted.find((b) => b.action === 'verifyCustomerLogin');
    ok('and sharedDevice:true on the email-code path too',
      call && call.sharedDevice === true, JSON.stringify(call || {}));
    await ctx.close();
  }

  // ---- guest ----
  {
    const { ctx } = await makeContext(browser, {});
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
    await ctx.close();
  }

  // ---- guest checkout still remembers the device, which is the point ----
  {
    const { ctx } = await makeContext(browser, {});
    await ctx.addInitScript(() => {
      try {
        localStorage.setItem('skiri_checkout_profile', JSON.stringify({
          customerName: 'Aroita', customerPhone: '73012345', customerEmail: 'a@example.com',
          island: 'Tarawa', village: 'Betio'
        }));
        localStorage.setItem('skiri_active_store', 'bong');
        localStorage.setItem('skiri_cart_bong', JSON.stringify(
          [{ variantId: 'v0', productId: 'p0', label: 'Rice 1kg', unitPrice: 5, qty: 1 }]));
      } catch (e) {}
    });
    const page = await ctx.newPage();
    await page.goto(BASE + '/checkout.html', { waitUntil: 'load' });
    await page.waitForTimeout(1200);
    const name = await page.inputValue('#customer-name').catch(() => '');
    const phone = await page.inputValue('#customer-phone').catch(() => '');
    ok('a returning guest gets their name back without signing in', name === 'Aroita', name);
    ok('and their phone number', phone === '73012345', phone);
    await ctx.close();
  }

  await browser.close();
  console.log('\n' + pass + '/' + (pass + fail) + ' passed');
  process.exit(fail ? 1 : 0);
})();
