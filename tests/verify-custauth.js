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
      await page.click('#header-menu-btn');
      await page.click('#header-menu-panel [data-login-chooser]').catch(() => {});
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
