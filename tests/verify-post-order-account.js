/**
 * "Keep this order" - the account offer on the checkout confirmation screen.
 *
 * Two things are being protected here, and they pull in opposite directions.
 *
 * 1. The offer must never get in the way. This screen's job is CALL SELLER NOW:
 *    that phone call is how the order actually gets filled. So the offer is
 *    asserted to sit BELOW the seller contact buttons, and nothing about it may
 *    move or replace them.
 *
 * 2. The offer must not lie. It promises this order will appear in the new
 *    account. That only holds because orders are matched to a customer by email
 *    (Customers.gs, buildCustomerOrders) - so email is now required at checkout,
 *    and the address is carried into the sign-up form. Both are asserted, as is
 *    the case where the promise CANNOT hold: the fallback confirmation, shown
 *    when createOrder never reached the backend, offers nothing.
 *
 * Since Oct 2026 guests are viewers: checkout sends them to sign in first, so
 * nobody reaches this screen without an account and the offer is never made.
 * The guest-only checks were retired; what is left is asserted below.
 *
 * Google is never contacted. The Identity Services script is stubbed at the
 * network layer - the only way to test it from a sandbox that cannot reach
 * accounts.google.com anyway.
 */
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = process.env.AUDIT_BASE || 'http://127.0.0.1:8099';
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('PASS  ' + name + (detail ? '  [' + detail + ']' : '')); }
  else { fail++; console.log('FAIL  ' + name + (detail ? '  [' + detail + ']' : '')); }
};

const GSI = 'https://accounts.google.com/gsi/client';
const CLIENT_ID = 'test-client-id.apps.googleusercontent.com';

// Same stand-in as verify-signin-options: a real button that fires the page's
// callback. It also records WHEN renderButton ran, which is the point on this
// page - rendering into the still-hidden confirmation section is what
// GOOGLE_SIGNIN_DEFER exists to prevent.
const FAKE_GSI = `
  window.__gsiRenders = [];
  window.google = { accounts: { id: {
    initialize: function (cfg) { window.__gsiConfig = cfg; },
    renderButton: function (el) {
      window.__gsiRenders.push({ visible: !!(el.offsetWidth || el.offsetHeight) });
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

/**
 * A checkout page with one item in the cart and the backend mocked.
 * opts: { orderFails, token, clientId, gsiBlocked }
 */
async function makeCheckout(browser, opts) {
  opts = opts || {};
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const posted = [];
  await ctx.route('**/macros/s/**', (route) => {
    let body = {}, action = '';
    try { body = route.request().postDataJSON() || {}; action = body.action || ''; } catch (e) {}
    try { if (!action) action = new URL(route.request().url()).searchParams.get('action') || ''; } catch (e) {}
    posted.push(action);
    const J = (o) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
    if (action === 'getStorePublicInfo') {
      return J({ ok: true, store: { storeName: 'Bong', phone: '+68673007552', whatsapp: '+68673007552',
        email: 's@x.com', island: 'South Tarawa', deliveryPickPay: true } });
    }
    if (action === 'createOrder') {
      if (opts.orderFails) return J({ ok: false, error: 'server sad' });
      return J({ ok: true, orderId: 'SKS-bong-1', total: 6, deliveryMethod: 'pickPay', deliveryCost: 0,
        items: [{ label: 'Rice 1kg', unitPrice: 6, qty: 1 }], emailedSeller: false });
    }
    if (action === 'googleSignIn') {
      return J({ ok: true, token: 'sess-tok', customer: { customerId: 'c1', name: 'Aroita', email: 'a@example.com' } });
    }
    return J({ ok: true });
  });
  await ctx.route(GSI, (r) => opts.gsiBlocked
    ? r.abort()
    : r.fulfill({ status: 200, contentType: 'application/javascript', body: FAKE_GSI }));
  // config.js declares `const APP_CONFIG` at script scope, so it cannot be
  // patched from an init script - serve a modified file instead.
  await ctx.route('**/assets/js/config*.js', (r) => r.fulfill({
    status: 200, contentType: 'application/javascript',
    body: 'const APP_CONFIG={APPS_SCRIPT_URL:"https://script.google.com/macros/s/TEST/exec",'
      + 'CURRENCY_SYMBOL:"$",SITE_NAME:"Mwakete",GOOGLE_CLIENT_ID:'
      + JSON.stringify(opts.clientId === undefined ? CLIENT_ID : opts.clientId) + '};'
  }));
  // Signed in by default: guests never reach checkout (see the header).
  const token = opts.guest ? '' : (opts.token || 'tok-shopper');
  await ctx.addInitScript(`(() => { try {
    localStorage.setItem('skiri_cookie_consent', 'true');
    localStorage.setItem('skiri_active_store', 'bong');
    localStorage.setItem('skiri_cart_bong', JSON.stringify([{ variantId: 'v1', productId: 'p1', label: 'Rice 1kg', unitPrice: 6, qty: 1 }]));
    ${token ? `localStorage.setItem('skiri_customer_token', ${JSON.stringify(token)});
    localStorage.setItem('skiri_customer', JSON.stringify({ customerId: 'c9', name: 'Teretia', email: 't@example.com' }));` : ''}
  } catch (e) {} })();`);
  const page = await ctx.newPage();
  await page.goto(BASE + '/checkout.html', { waitUntil: 'load' });
  await page.waitForFunction(() => typeof storeInfo !== 'undefined' && storeInfo && storeInfo.phone, null, { timeout: 8000 });
  return { ctx, page, posted };
}

async function fillForm(page, email) {
  await page.fill('#customer-name', 'Debby Hakau');
  if (email !== null) await page.fill('#customer-email', email);
  await page.fill('#customer-phone', '7301234');
  await page.selectOption('#checkout-island', 'South Tarawa');
  await page.evaluate(() => {
    const vs = document.getElementById('checkout-village');
    for (const o of vs.options) { if (o.value && !/^Other/.test(o.value)) { vs.value = o.value; vs.dispatchEvent(new Event('change', { bubbles: true })); break; } }
  });
  await page.waitForSelector('input[name="deliveryMethod"]');
  await page.evaluate(() => { const r = document.querySelector('input[name="deliveryMethod"]'); r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); });
}

async function placeOrder(page, email) {
  await fillForm(page, email);
  await page.click('#place-order-btn');
  await page.waitForSelector('#confirmation-section:not(.hidden)', { timeout: 8000 });
  await page.waitForTimeout(400);
}

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

  // ---- email is required, because the offer depends on it --------------------
  {
    const { ctx, page, posted } = await makeCheckout(browser, {});
    await fillForm(page, null);
    await page.click('#place-order-btn');
    await page.waitForTimeout(300);
    let err = await page.textContent('#checkout-error');
    ok('no email: the order is blocked with a reason', /email/i.test(err || ''), err);
    ok('no email: nothing was sent to the backend', !posted.includes('createOrder'), posted.join(','));

    await page.fill('#customer-email', 'not-an-address');
    await page.click('#place-order-btn');
    await page.waitForTimeout(300);
    err = await page.textContent('#checkout-error');
    ok('malformed email: blocked too', /does not look right/i.test(err || ''), err);
    ok('malformed email: still nothing sent', !posted.includes('createOrder'), posted.join(','));

    // The field is marked up as required as well, for the sake of the label and
    // assistive tech - even though the form is novalidate and onSubmit is what
    // actually enforces it.
    ok('the field itself is marked required', await page.evaluate(() =>
      document.getElementById('customer-email').required === true));

    await page.fill('#customer-email', 'debby@example.com');
    await page.click('#place-order-btn');
    await page.waitForSelector('#confirmation-section:not(.hidden)', { timeout: 8000 });
    ok('with an email, the order goes through', posted.includes('createOrder'), posted.join(','));
    await ctx.close();
  }

  // ---- a guest never gets this far ----------------------------------------
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await ctx.route('**/macros/s/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }));
    await ctx.addInitScript(() => { try {
      localStorage.setItem('skiri_cookie_consent', 'true');
      localStorage.setItem('skiri_active_store', 'bong');
      localStorage.setItem('skiri_cart_bong', JSON.stringify([{ variantId: 'v1', productId: 'p1', label: 'Rice 1kg', unitPrice: 6, qty: 1 }]));
    } catch (e) {} });
    const page = await ctx.newPage();
    await page.goto(BASE + '/checkout.html', { waitUntil: 'load' });
    await page.waitForURL(/customer-login\.html/, { timeout: 6000 }).catch(() => {});
    ok('guest: checkout sends them to sign in first, then back to checkout',
      /customer-login\.html\?next=checkout\.html&reason=order$/.test(page.url()), page.url());
    await ctx.close();
  }

  // ---- someone already signed in is not asked ------------------------------
  {
    const { ctx, page } = await makeCheckout(browser, { token: 'already-in' });
    await placeOrder(page, 'debby@example.com');
    ok('signed in: the offer stays hidden', await page.locator('#post-order-account').isHidden());
    ok('signed in: and no sign-in hook is installed',
      await page.evaluate(() => typeof window.onCustomerSignedIn !== 'function'));
    ok('signed in: the seller contact buttons are there regardless',
      await page.locator('#order-contact a, #order-contact button').first().isVisible());
    await ctx.close();
  }

  // ---- the fallback confirmation promises nothing --------------------------
  {
    const { ctx, page } = await makeCheckout(browser, { orderFails: true });
    await fillForm(page, 'debby@example.com');
    await page.click('#place-order-btn');
    await page.waitForSelector('#confirmation-section:not(.hidden)', { timeout: 8000 });
    await page.waitForTimeout(400);
    const intro = await page.textContent('#confirmation-intro');
    ok('fallback: the page says the order system was unreachable',
      /couldn.t reach/i.test(intro || ''), intro);
    // There is no Orders row for an account to find, so "this order shows up in
    // My Account" would be untrue here.
    ok('fallback: no account offer is made', await page.locator('#post-order-account').isHidden());
    ok('fallback: the seller contact route is still there, which is what matters',
      await page.locator('#order-contact a, #order-contact button').first().isVisible());
    await ctx.close();
  }

  // ---- the other end: the sign-up form receives the address ----------------
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await ctx.route('**/macros/s/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }));
    await ctx.route(GSI, (r) => r.abort());
    await ctx.addInitScript(() => { try { localStorage.setItem('skiri_cookie_consent', 'true'); } catch (e) {} });
    const page = await ctx.newPage();

    await page.goto(BASE + '/customer-login.html?tab=signup&email=debby%2Bshop%40example.com', { waitUntil: 'load' });
    await page.waitForTimeout(700);
    ok('sign-up tab is the one shown', await page.locator('#panel-signup').isVisible());
    ok('the address from the order is filled in',
      (await page.inputValue('#signup-email')) === 'debby+shop@example.com',
      await page.inputValue('#signup-email'));

    // A hand-edited ?email= is only ever written into a field - it signs nobody
    // in - but junk still must not land in it.
    await page.goto(BASE + '/customer-login.html?tab=signup&email=%3Cscript%3Ealert(1)%3C%2Fscript%3E', { waitUntil: 'load' });
    await page.waitForTimeout(600);
    ok('junk in ?email= is ignored', (await page.inputValue('#signup-email')) === '',
      await page.inputValue('#signup-email'));
    ok('and nothing was injected into the page',
      await page.evaluate(() => !document.querySelector('#panel-signup script')));

    await page.goto(BASE + '/customer-login.html?tab=signup', { waitUntil: 'load' });
    await page.waitForTimeout(600);
    ok('no ?email= leaves the field empty', (await page.inputValue('#signup-email')) === '');
    // The sign-in page redirects on its own when a session exists - proof the
    // hook installed by checkout is not left lying around globally.
    ok('customer-login does not install the no-redirect hook',
      await page.evaluate(() => typeof window.onCustomerSignedIn !== 'function'));
    await ctx.close();
  }

  // ---- desktop geometry ----------------------------------------------------
  {
    const { ctx, page } = await makeCheckout(browser, {});
    await page.setViewportSize({ width: 1280, height: 900 });
    await placeOrder(page, 'debby@example.com');
    ok('desktop: signed in, no offer; the contact buttons are there', await page.evaluate(() =>
      document.getElementById('post-order-account').hidden && !!document.getElementById('order-contact')));
    ok('desktop: no sideways scrolling', await page.evaluate(() =>
      document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1));
    // It must read as the quiet option: not bigger type than the order details.
    ok('desktop: its heading is no louder than body copy', await page.evaluate(() => {
      const h = parseFloat(getComputedStyle(document.querySelector('#post-order-account h2')).fontSize);
      const b = parseFloat(getComputedStyle(document.body).fontSize);
      return h <= b * 1.15;
    }));
    await ctx.close();
  }

  await browser.close();
  console.log('\n' + pass + '/' + (pass + fail) + ' passed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
