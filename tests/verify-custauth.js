const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = 'http://127.0.0.1:8099';

function mockAuth(ctx, posted) {
  return ctx.route('**/macros/s/**', (route) => {
    let action = '', body = {};
    try { body = route.request().postDataJSON() || {}; action = body.action; } catch (e) {}
    try { if (!action) action = new URL(route.request().url()).searchParams.get('action') || ''; } catch (e) {}
    if (action) posted.push({ action, body });
    let out = { ok: true };
    if (action === 'registerCustomer') out = { ok: true, pendingToken: 'ptok-signup' };
    else if (action === 'verifyCustomerEmail') out = { ok: true, token: 'sess-1', customer: { customerId: 'c1', name: body.__n || 'Debby', email: 'd@x.com', phone: '7301234', emailVerified: true } };
    else if (action === 'loginCustomer') out = { ok: true, pendingToken: 'ptok-login' };
    else if (action === 'verifyCustomerLogin') out = { ok: true, token: 'sess-2', customer: { customerId: 'c1', name: 'Debby', email: 'd@x.com', phone: '7301234', emailVerified: true } };
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
    // bad local phone blocks
    await page.fill('#signup-name', 'Debby');
    await page.fill('#signup-email', 'd@x.com');
    await page.fill('#signup-phone', '7201234');
    await page.click('#signup-form button[type="submit"]');
    await page.waitForTimeout(100);
    ok('signup bad phone blocked (no registerCustomer)', !posted.some(p => p.action === 'registerCustomer'));
    ok('signup bad phone shows 730/630 error', /730 or 630/.test(await page.textContent('#signup-error')));
    // good phone -> code step
    await page.fill('#signup-phone', '7301234');
    await page.click('#signup-form button[type="submit"]');
    await page.waitForSelector('#signup-code-form:not(.hidden)');
    ok('signup registerCustomer called w/ name+email+phone', posted.some(p => p.action === 'registerCustomer' && p.body.name === 'Debby' && p.body.phone === '7301234'));
    // enter code -> verify -> session saved + redirect to index
    await page.fill('#signup-code', '123456');
    await page.click('#signup-code-form button[type="submit"]');
    await page.waitForURL('**/index.html', { timeout: 4000 }).catch(() => {});
    const tok = await page.evaluate(() => { try { return localStorage.getItem('skiri_customer_token'); } catch (e) { return null; } });
    ok('signup verify saved customer session', tok === 'sess-1', String(tok));
    ok('signup redirected to home', /index\.html$/.test(page.url()), page.url());
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
    await page.click('#login-form button[type="submit"]');
    await page.waitForSelector('#login-code-form:not(.hidden)');
    ok('login loginCustomer called', posted.some(p => p.action === 'loginCustomer' && p.body.email === 'd@x.com'));
    await page.fill('#login-code', '654321');
    await page.click('#login-code-form button[type="submit"]');
    await page.waitForURL('**/index.html', { timeout: 4000 }).catch(() => {});
    const tok = await page.evaluate(() => { try { return localStorage.getItem('skiri_customer_token'); } catch (e) { return null; } });
    ok('login verify saved customer session', tok === 'sess-2', String(tok));
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
    const st = await page.evaluate(() => {
      const cs = document.getElementById('nav-create-store');
      const si = document.getElementById('nav-signin');
      const link = document.getElementById('nav-signin-link');
      return { createHidden: cs.hidden, signinHidden: si.hidden, signinHref: link.getAttribute('href') };
    });
    // routing: click sign in when owner-only should show chooser
    let chooser = false;
    if (!st.signinHidden) {
      await page.click('#nav-signin-link').catch(() => {});
      chooser = await page.evaluate(() => !!document.getElementById('login-chooser'));
    }
    await ctx.close();
    return { ...st, chooser };
  }

  const none = await homeState({});
  ok('none: both links visible', !none.createHidden && !none.signinHidden, JSON.stringify(none));
  ok('none: Sign In routes to customer-login', none.signinHref === 'customer-login.html', none.signinHref);
  ok('none: no chooser (navigates directly)', none.chooser === false);

  const cust = await homeState({ customer: true });
  ok('customer: Sign In hidden, Create Store shown', cust.signinHidden && !cust.createHidden, JSON.stringify(cust));

  const owner = await homeState({ owner: true });
  ok('owner: Create Store hidden, Sign In shown', owner.createHidden && !owner.signinHidden, JSON.stringify(owner));
  ok('owner: Sign In shows Customer/Seller chooser', owner.chooser === true, JSON.stringify(owner));

  const both = await homeState({ owner: true, customer: true });
  ok('both: both links hidden', both.createHidden && both.signinHidden, JSON.stringify(both));

  await browser.close();
  let failed = 0;
  console.log('\n--- Phase 2: customer auth + homepage links ---');
  for (const [st, n, e] of results) { if (st === 'FAIL') failed++; console.log(`${st}  ${n}${e ? '  [' + e + ']' : ''}`); }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
