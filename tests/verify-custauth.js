const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = 'http://127.0.0.1:8099';

function mockAuth(ctx, posted) {
  return ctx.route('**/macros/s/**', (route) => {
    let action = '', body = {};
    try { body = route.request().postDataJSON() || {}; action = body.action; } catch (e) {}
    try { if (!action) action = new URL(route.request().url()).searchParams.get('action') || ''; } catch (e) {}
    if (action) posted.push({ action, body });
    let out = { ok: true };
    if (action === 'registerCustomer') out = { ok: true, pendingToken: 'ptok-signup', sentTo: 'd•••@x.com', resendAfterSeconds: 60 };
    else if (action === 'verifyCustomerEmail') out = { ok: true, token: 'sess-1', customer: { customerId: 'c1', name: body.__n || 'Debby', email: 'd@x.com', phone: '7301234', emailVerified: true } };
    else if (action === 'loginCustomer') out = { ok: true, pendingToken: 'ptok-login', sentTo: 'd•••@x.com', resendAfterSeconds: 60 };
    else if (action === 'verifyCustomerLogin') out = { ok: true, token: 'sess-2', customer: { customerId: 'c1', name: 'Debby', email: 'd@x.com', phone: '7301234', emailVerified: true } };
    else if (action === 'customerPasswordLogin') out = body.password === 'right-pass1'
      ? { ok: true, token: 'sess-3', customer: { customerId: 'c1', name: 'Debby', email: 'd@x.com', emailVerified: true } }
      : { ok: false, error: 'Email or password is incorrect' };
    else if (action === 'requestCustomerPasswordReset') out = { ok: true, pendingToken: 'ptok-reset', sentTo: 'd•••@x.com', resendAfterSeconds: 60 };
    else if (action === 'resetCustomerPassword') out = { ok: true, token: 'sess-4', customer: { customerId: 'c1', name: 'Debby', email: 'd@x.com', emailVerified: true } };
    else if (action === 'checkCustomerLink') out = { ok: true, purpose: 'reset', sentTo: 'd•••@x.com' };
    else if (action === 'resendCustomerCode') out = { ok: true, resendAfterSeconds: 60 };
    else if (action === 'listProducts' || action === 'getHomePageData' || action === 'listTopProducts' || action === 'listTopStores') out = { ok: true, products: [], stores: [] };
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(out) });
  });
}

const results = [];
const ok = (n, c, e) => results.push([c ? 'PASS' : 'FAIL', n, e || '']);

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

  // ---- Signup flow ----
  {
    const posted = [];
    const ctx = await browser.newContext({ viewport: { width: 390, height: 800 } });
    await mockAuth(ctx, posted);
    const page = await ctx.newPage();
    await page.goto(BASE + '/customer-login.html?tab=signup', { waitUntil: 'load' });
    await page.waitForFunction(() => typeof CustomerAuth !== 'undefined');
    // Name, email, password (Oct 2026: no phone at sign-up - it is asked at checkout for delivery).
    ok('sign-up asks for no phone', !(await page.$('#signup-phone')));
    await page.fill('#signup-name', 'Debby');
    await page.fill('#signup-email', 'd@x.com');
    await page.fill('#signup-password', 'short');
    await page.keyboard.press('Tab');
    await page.waitForTimeout(100);
    ok('short password: Create account stays hidden', await page.$eval('#signup-form button[type="submit"]', (b) => getComputedStyle(b).visibility === 'hidden'));
    ok('short password: explained on leaving the box', /at least 8/.test(await page.textContent('#signup-error')));
    await page.fill('#signup-password', 'good-pass1');
    ok('Show reveals the password', await (async () => { await page.click('.password-toggle[data-for="signup-password"]'); return (await page.getAttribute('#signup-password', 'type')) === 'text'; })());
    await page.click('#signup-form button[type="submit"]');
    await page.waitForSelector('#signup-code-form:not(.hidden)');
    ok('registerCustomer sent name, email and password', posted.some(p => p.action === 'registerCustomer' && p.body.name === 'Debby' && p.body.password === 'good-pass1' && !('phone' in p.body)));
    ok('code step names the masked address and the spam folder', /d•••@x\.com/.test(await page.textContent('#signup-code-hint')) && /spam/i.test(await page.textContent('#signup-code-hint')));
    ok('resend waits out its cooldown', await page.$eval('.resend-btn[data-for="signup"]', (b) => b.disabled && /\d+s/.test(b.textContent)));
    // enter code -> verify -> session saved + redirect to the customer's account
    // (customer-login.js nextDest: My Account by default, ?next= when given)
    await page.fill('#signup-code', '123456');
    await page.click('#signup-code-form button[type="submit"]');
    await page.waitForURL('**/customer-dashboard.html', { timeout: 4000 }).catch(() => {});
    const tok = await page.evaluate(() => { try { return localStorage.getItem('skiri_customer_token'); } catch (e) { return null; } });
    ok('signup verify saved customer session', tok === 'sess-1', String(tok));
    ok('signup lands on My Account', /customer-dashboard\.html$/.test(page.url()), page.url());
    await ctx.close();
  }

  // ---- Login flow ----
  {
    const posted = [];
    const ctx = await browser.newContext({ viewport: { width: 390, height: 800 } });
    await mockAuth(ctx, posted);
    const page = await ctx.newPage();
    await page.goto(BASE + '/customer-login.html', { waitUntil: 'load' });
    await page.waitForFunction(() => typeof CustomerAuth !== 'undefined');
    await page.fill('#login-email', 'd@x.com');
    ok('Sign in waits for a password', await page.$eval('#login-form button[type="submit"]', (b) => getComputedStyle(b).visibility === 'hidden'));
    await page.fill('#login-password', 'wrong-pass');
    await page.click('#login-form button[type="submit"]');
    await page.waitForFunction(() => /incorrect/.test(document.getElementById('login-error').textContent));
    ok('wrong password: one plain message', (await page.textContent('#login-error')) === 'Email or password is incorrect');
    await page.fill('#login-password', 'right-pass1');
    await page.click('#login-form button[type="submit"]');
    await page.waitForURL('**/customer-dashboard.html', { timeout: 4000 }).catch(() => {});
    ok('password sign-in saved the session', (await page.evaluate(() => localStorage.getItem('skiri_customer_token'))) === 'sess-3');
    await page.evaluate(() => localStorage.removeItem('skiri_customer_token'));

    await page.goto(BASE + '/customer-login.html', { waitUntil: 'load' });
    await page.fill('#login-email', 'd@x.com');
    await page.click('#login-use-code');
    await page.waitForSelector('#login-code-form:not(.hidden)');
    ok('"Email me a code instead" calls loginCustomer', posted.some(p => p.action === 'loginCustomer' && p.body.email === 'd@x.com'));
    await page.fill('#login-code', '654321');
    await page.click('#login-code-form button[type="submit"]');
    await page.waitForURL('**/customer-dashboard.html', { timeout: 4000 }).catch(() => {});
    const tok = await page.evaluate(() => { try { return localStorage.getItem('skiri_customer_token'); } catch (e) { return null; } });
    ok('login verify saved customer session', tok === 'sess-2', String(tok));
    await page.evaluate(() => localStorage.removeItem('skiri_customer_token'));

    // Forgot password by code.
    await page.goto(BASE + '/customer-login.html', { waitUntil: 'load' });
    await page.fill('#login-email', 'd@x.com');
    await page.click('#login-forgot');
    ok('Forgot password opens the reset step with the email filled in', await page.isVisible('#reset-request-form') && (await page.inputValue('#reset-email')) === 'd@x.com');
    await page.click('#reset-request-form button[type="submit"]');
    await page.waitForSelector('#reset-form:not(.hidden)');
    await page.fill('#reset-code', '111222');
    await page.fill('#reset-password', 'new-pass12');
    await page.click('#reset-form button[type="submit"]');
    await page.waitForURL('**/customer-dashboard.html', { timeout: 4000 }).catch(() => {});
    ok('reset by code sends code + new password', posted.some(p => p.action === 'resetCustomerPassword' && p.body.token === 'ptok-reset' && p.body.code === '111222' && p.body.newPassword === 'new-pass12'));
    await page.evaluate(() => localStorage.removeItem('skiri_customer_token'));

    // Reset by the emailed link: the token leaves the address bar at once.
    await page.goto(BASE + '/customer-login.html?reset=LINKTOKEN123', { waitUntil: 'load' });
    ok('the link token is taken out of the address bar', !page.url().includes('LINKTOKEN123'), page.url());
    ok('the page sends no Referer', (await page.getAttribute('meta[name="referrer"]', 'content')) === 'no-referrer');
    await page.waitForSelector('#reset-form:not(.hidden)');
    ok('by link: no code box', !(await page.isVisible('#reset-code')));
    await page.fill('#reset-password', 'new-pass34');
    await page.click('#reset-form button[type="submit"]');
    await page.waitForURL('**/customer-dashboard.html', { timeout: 4000 }).catch(() => {});
    ok('reset by link sends the link token', posted.some(p => p.action === 'resetCustomerPassword' && p.body.linkToken === 'LINKTOKEN123' && p.body.newPassword === 'new-pass34'));
    await page.evaluate(() => localStorage.removeItem('skiri_customer_token'));

    // Confirm-email link.
    await page.goto(BASE + '/customer-login.html?verify=VERIFYTOK9', { waitUntil: 'load' });
    await page.waitForURL('**/customer-dashboard.html', { timeout: 4000 }).catch(() => {});
    ok('the confirm link signs in', posted.some(p => p.action === 'verifyCustomerEmail' && p.body.linkToken === 'VERIFYTOK9'));
    await page.evaluate(() => localStorage.removeItem('skiri_customer_token'));

    // Google/Facebook found an existing account: prove it, then it links.
    await page.goto(BASE + '/customer-login.html', { waitUntil: 'load' });
    await page.evaluate(() => window.onProviderLinkRequired({ provider: 'google', providerLinkToken: 'PLT', sentTo: 'd•••@x.com', email: 'd@x.com', hasPassword: true }));
    ok('link-required explains what to do', /already have a Mwakete account/.test(await page.textContent('#provider-link-note')));
    await page.fill('#login-password', 'right-pass1');
    await page.click('#login-form button[type="submit"]');
    await page.waitForURL('**/customer-dashboard.html', { timeout: 4000 }).catch(() => {});
    ok('...and the password sign-in carries the link token', posted.some(p => p.action === 'customerPasswordLogin' && p.body.providerLinkToken === 'PLT'));
    await page.evaluate(() => localStorage.removeItem('skiri_customer_token'));

    await page.goto(BASE + '/customer-login.html', { waitUntil: 'load' });
    ok('no Facebook button while FACEBOOK_APP_ID is empty', await page.$eval('#facebook-signin-wrap', (w) => w.hidden));
    await ctx.close();
  }

  // ---- Homepage visibility matrix + routing ----
  async function homeState(seed) {
    const posted = [];
    const ctx = await browser.newContext({ viewport: { width: 900, height: 800 } });
    await mockAuth(ctx, posted);
    const page = await ctx.newPage();
    await page.addInitScript((s) => {
      try {
        if (s.owner) localStorage.setItem('skiri_owner_token', 't-owner');
        if (s.customer) localStorage.setItem('skiri_customer_token', 't-cust');
      } catch (e) {}
    }, seed);
    await page.goto(BASE + '/index.html', { waitUntil: 'load' });
    await page.waitForFunction(() => typeof CustomerAuth !== 'undefined');
    // These two rules used to live in the homepage nav row; they now live in
    // the header overflow menu, which is the only place on the homepage that
    // offers either destination. Same four session states, same two rules.
    await page.waitForSelector('#header-menu-btn');
    const st = await page.evaluate(() => {
      const items = Array.prototype.map.call(
        document.querySelectorAll('#header-menu-panel .header-menu-item'),
        (a) => ({ label: a.querySelector('.header-menu-label').textContent.trim(),
                  href: a.getAttribute('href'),
                  chooser: a.hasAttribute('data-login-chooser') })
      );
      const account = items.filter((i) => i.label === 'My Account')[0] || null;
      return {
        createShown: items.some((i) => i.label === 'Create Store'),
        accountHref: account && account.href,
        accountChooser: !!(account && account.chooser)
      };
    });
    // The chooser is a claim about behaviour, so click it rather than trust the
    // attribute that says it will happen.
    let chooser = false;
    if (st.accountChooser) {
      // My Account is in the menu on phones and a header word above 700px
      // (Oct 2026): click whichever one this screen shows.
      await page.click('#header-menu-btn');
      await page.locator('#header-menu-panel [data-login-chooser], .header-bar-links [data-login-chooser]').locator('visible=true').first().click().catch(() => {});
      chooser = await page.evaluate(() => !!document.getElementById('login-chooser'));
    }
    await ctx.close();
    return { ...st, chooser };
  }

  const none = await homeState({});
  ok('none: Create Store offered', none.createShown, JSON.stringify(none));
  ok('none: My Account routes to customer-login', none.accountHref === 'customer-login.html', none.accountHref);
  ok('none: no chooser (navigates directly)', none.chooser === false);

  const cust = await homeState({ customer: true });
  ok('customer: My Account is the dashboard, Create Store still offered',
    cust.accountHref === 'customer-dashboard.html' && cust.createShown, JSON.stringify(cust));
  ok('customer: no chooser', cust.chooser === false);

  const owner = await homeState({ owner: true });
  ok('owner: Create Store gone', !owner.createShown, JSON.stringify(owner));
  ok('owner: My Account shows Customer/Seller chooser', owner.chooser === true, JSON.stringify(owner));

  const both = await homeState({ owner: true, customer: true });
  ok('both: Create Store gone, My Account is the dashboard',
    !both.createShown && both.accountHref === 'customer-dashboard.html', JSON.stringify(both));
  ok('both: no chooser - the customer account settles it', both.chooser === false);

  await browser.close();
  let failed = 0;
  console.log('\n--- Phase 2: customer auth + header menu links ---');
  for (const [st, n, e] of results) { if (st === 'FAIL') failed++; console.log(`${st}  ${n}${e ? '  [' + e + ']' : ''}`); }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
