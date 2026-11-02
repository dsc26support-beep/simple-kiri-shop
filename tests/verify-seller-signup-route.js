/**
 * One sign-in for sellers (owner decision, 2 Nov 2026).
 *
 * A seller signs in with their Mwakete account (Google or email) and their
 * store opens - no store username, password or hint anywhere:
 *   - owner/login.html, signed in: straight on to the dashboard (or ?next=);
 *   - signed in with no store: the Register tab, which has no username /
 *     password / hint fields;
 *   - not signed in: one "Sign in with Google or email" link that comes back;
 *   - after Log out: a "Continue to my store" tap instead of reopening;
 *   - a seller page with no store session goes to login.html?next=that page;
 *   - the store's own page shows the photo buttons to its seller signed in
 *     with their account only, and asks the backend at most once a day for a
 *     shopper with no store.
 * The backend decides which store (ownerFromCustomer); it is mocked here.
 */
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = process.env.AUDIT_BASE || 'http://127.0.0.1:8099';
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('PASS  ' + name + (detail ? '  [' + detail + ']' : '')); }
  else { fail++; console.log('FAIL  ' + name + (detail ? '  [' + detail + ']' : '')); }
};

const CUSTOMER = { customerId: 'c1', name: 'Aroita', email: 'aroita@example.com', phone: '73012345' };
const OWNER = { ownerId: 'o1', storeName: 'Bong', storeSlug: 'bong', email: 'aroita@example.com', status: 'active' };

/** opts: { shopper, signedOut, fromCustomer (reply), ownerToken } */
async function open(browser, path, opts) {
  opts = opts || {};
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const seen = [];
  await ctx.route('**/accounts.google.com/**', (r) => r.fulfill({ status: 200, contentType: 'text/javascript', body: '' }));
  await ctx.route('**/script.google.com/**', (r) => {
    let body = {}; try { body = r.request().postDataJSON() || {}; } catch (e) {}
    if (body.action) seen.push(body);
    const J = (o) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
    if (body.action === 'ownerFromCustomer') return J(opts.fromCustomer || { ok: true, noStore: true });
    if (body.action === 'getOwnerProfile') return J({ ok: true, owner: OWNER });
    if (body.action === 'getStorePublicInfo') return J({ ok: true, store: { storeName: 'Bong', storeSlug: 'bong', status: 'active' } });
    return J({ ok: true, products: [], orders: [], items: [] });
  });
  const page = await ctx.newPage();
  await page.goto(BASE + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.evaluate((o) => { try {
    localStorage.setItem('skiri_cookie_consent', 'true');
    if (o.shopper) {
      localStorage.setItem('skiri_customer_token', 'ct');
      localStorage.setItem('skiri_customer_profile', JSON.stringify(o.customer));
    }
    if (o.signedOut) localStorage.setItem('mwk_seller_signed_out', '1');
    if (o.ownerToken) { localStorage.setItem('skiri_owner_token', o.ownerToken); localStorage.setItem('skiri_owner_profile', JSON.stringify(o.owner)); }
  } catch (e) {} }, { shopper: !!opts.shopper, signedOut: !!opts.signedOut, ownerToken: opts.ownerToken || '', customer: CUSTOMER, owner: OWNER });
  await page.goto(BASE + path, { waitUntil: 'load' });
  await page.waitForTimeout(900);
  return { ctx, page, seen };
}

(async () => {
  const browser = await chromium.launch();

  // 1. Not signed in: one way in, no store username/password anywhere.
  let t = await open(browser, '/owner/login.html');
  let st = await t.page.evaluate(() => ({
    fields: document.querySelectorAll('#login-username, #login-password, #register-username, #register-password, #register-password-hint').length,
    forgot: !!document.querySelector('a[href="forgot-password.html"]'),
    signinShown: !document.getElementById('login-signin').hidden,
    href: document.getElementById('login-signin-link').getAttribute('href')
  }));
  ok('no store username, password or hint field on the page', st.fields === 0 && !st.forgot, JSON.stringify(st));
  ok('not signed in: "Sign in with Google or email" is shown', st.signinShown);
  ok('...and it comes back to the seller area afterwards', /customer-login\.html\?next=owner%2Flogin\.html/.test(st.href), st.href);
  ok('...no backend call is made for nobody', !t.seen.some((b) => b.action === 'ownerFromCustomer'));
  await t.ctx.close();

  // 2. Signed in with a store: straight to the dashboard.
  t = await open(browser, '/owner/login.html', { shopper: true, fromCustomer: { ok: true, token: 'own-tok', owner: OWNER } });
  await t.page.waitForURL(/dashboard\.html/, { timeout: 5000 }).catch(() => {});
  ok('signed in with a store: straight to the dashboard', /dashboard\.html/.test(t.page.url()), t.page.url());
  ok('...the account session was what was sent', t.seen.some((b) => b.action === 'ownerFromCustomer' && b.customerToken === 'ct'));
  ok('...and the store session is saved', await t.page.evaluate(() => localStorage.getItem('skiri_owner_token')) === 'own-tok');
  await t.ctx.close();

  // 3. ?next= is honoured (e.g. from a seller page or an email).
  t = await open(browser, '/owner/login.html?next=messages.html', { shopper: true, fromCustomer: { ok: true, token: 'own-tok', owner: OWNER } });
  await t.page.waitForURL(/messages\.html/, { timeout: 5000 }).catch(() => {});
  ok('...or to the page that sent them (?next=)', /owner\/messages\.html/.test(t.page.url()), t.page.url());
  await t.ctx.close();

  // 4. Signed in, no store: the Register tab, ready to fill in.
  t = await open(browser, '/owner/login.html', { shopper: true, fromCustomer: { ok: true, noStore: true } });
  st = await t.page.evaluate(() => ({
    register: document.getElementById('tab-register').getAttribute('aria-selected') === 'true',
    fields: !document.getElementById('register-fields').hidden,
    email: document.getElementById('register-email').value,
    msg: document.getElementById('session-message').textContent
  }));
  ok('signed in, no store: the Register tab opens', st.register && st.fields, JSON.stringify(st));
  ok('...with the account email filled in and a line saying why', st.email === CUSTOMER.email && /no store yet/.test(st.msg), st.msg);
  await t.page.fill('#register-store-name', 'Aroita Fish');
  await t.page.fill('#register-phone', '73012345');
  await t.page.fill('#register-messenger', 'aroita.fish');
  await t.page.fill('#register-about', 'Fresh fish');
  await t.page.click('#register-submit-btn');
  await t.page.waitForTimeout(600);
  const reg = t.seen.find((b) => b.action === 'registerOwner');
  ok('opening a store sends no username, password or hint', !!reg && !('username' in reg) && !('password' in reg) && !('passwordHint' in reg), JSON.stringify(reg));
  await t.ctx.close();

  // 5. After Log out: wait for a tap.
  t = await open(browser, '/owner/login.html', { shopper: true, signedOut: true, fromCustomer: { ok: true, token: 'own-tok', owner: OWNER } });
  ok('after Log out the store is not reopened by itself', !t.seen.some((b) => b.action === 'ownerFromCustomer') && /login\.html/.test(t.page.url()));
  ok('..."Continue to my store" is offered', await t.page.isVisible('#login-continue'));
  await t.page.click('#login-continue');
  await t.page.waitForURL(/dashboard\.html/, { timeout: 5000 }).catch(() => {});
  ok('...and one tap opens it', /dashboard\.html/.test(t.page.url()), t.page.url());
  ok('...clearing the signed-out mark', await t.page.evaluate(() => localStorage.getItem('mwk_seller_signed_out')) === null);
  await t.ctx.close();

  // 6. A suspended store: told why, not bounced around.
  t = await open(browser, '/owner/login.html', { shopper: true, fromCustomer: { ok: false, storeBlocked: true, error: 'This store is suspended. Contact Mwakete via the Help and support link below.' } });
  ok('a suspended store: the reason is shown', /suspended/.test(await t.page.textContent('#login-error')));
  ok('...and no retry button (it would only fail again)', !(await t.page.isVisible('#login-continue')));
  await t.ctx.close();

  // 7. A seller page with no store session goes to the login page and back.
  t = await open(browser, '/owner/orders.html');
  await t.page.waitForURL(/login\.html/, { timeout: 5000 }).catch(() => {});
  ok('a seller page with no store session goes to login with ?next=', /owner\/login\.html\?next=orders\.html/.test(t.page.url()), t.page.url());
  await t.ctx.close();

  // 8. The store's own page: photo buttons for its seller, signed in with the account only.
  t = await open(browser, '/store.html?store=bong', { shopper: true, fromCustomer: { ok: true, token: 'own-tok', owner: OWNER } });
  await t.page.waitForTimeout(800);
  ok('store page: its seller (account only) gets the photo buttons', await t.page.isVisible('#sp-cam-cover'));
  await t.ctx.close();

  t = await open(browser, '/store.html?store=bong', { shopper: true, fromCustomer: { ok: true, noStore: true } });
  await t.page.waitForTimeout(800);
  ok('a shopper with no store: no photo buttons', !(await t.page.isVisible('#sp-cam-cover')));
  const calls1 = t.seen.filter((b) => b.action === 'ownerFromCustomer').length;
  await t.page.reload({ waitUntil: 'load' });
  await t.page.waitForTimeout(900);
  const calls2 = t.seen.filter((b) => b.action === 'ownerFromCustomer').length;
  ok('...asked once, then remembered for the day', calls1 === 1 && calls2 === 1, calls1 + ' then ' + calls2);
  await t.ctx.close();

  await browser.close();
  console.log(`\n${pass}/${pass + fail} passed`);
  process.exit(fail ? 1 : 0);
})();
