// Auth (Oct 2026), browser side with the backend mocked: My Account
// sign-in & security + Sell on Mwakete, the seller application form, and the
// admin Seller applications queue.
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = 'http://127.0.0.1:8099';
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e === undefined ? '' : e]);
const CUST = { customerId: 'c1', name: 'Tia', email: 'tia@x.com', phone: '', emailVerified: true, hasPassword: false };

function mock(ctx, calls, over) {
  return ctx.route('**/macros/s/**', (route) => {
    let body = {}; try { body = route.request().postDataJSON() || {}; } catch (e) {}
    const a = body.action || new URL(route.request().url()).searchParams.get('action');
    calls.push(Object.assign({ action: a }, body));
    let res = { ok: true };
    if (over[a]) res = typeof over[a] === 'function' ? over[a](body) : over[a];
    else if (a === 'listCustomerOrders') res = { ok: true, orders: [] };
    else if (a === 'listCustomerBookings') res = { ok: true, bookings: [] };
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(res) });
  });
}

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

  /* ---------- My Account ---------- */
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const calls = [];
    await mock(ctx, calls, {
      getCustomerProfile: { ok: true, customer: CUST, signInMethods: { password: false, emailCode: true, google: true, facebook: false } },
      getSellerApplication: { ok: true, emailVerified: true, application: { ownerId: 'o1', storeName: 'Tia Fish', status: 'rejected', reviewNote: 'Add a phone we can reach' } },
      unlinkProvider: { ok: true, signInMethods: { password: false, emailCode: true, google: false, facebook: false } },
      requestCustomerPasswordReset: { ok: true, pendingToken: 'pt', sentTo: 't•••@x.com' },
      resetCustomerPassword: { ok: true, token: 'new-sess', customer: CUST }
    });
    const page = await ctx.newPage();
    page.on('dialog', (d) => d.accept());
    const errors = []; page.on('pageerror', (e) => errors.push(String(e)));
    // Seeded once per tab, so signing out is not undone by the next page load.
    await page.addInitScript((c) => { try { if (sessionStorage.getItem('seeded')) return; sessionStorage.setItem('seeded', '1');
      localStorage.setItem('skiri_customer_token', 'sess'); localStorage.setItem('skiri_customer_profile', JSON.stringify(c)); } catch (e) {} }, CUST);
    await page.goto(BASE + '/customer-dashboard.html', { waitUntil: 'load' });
    await page.waitForSelector('#signin-methods li');
    const methods = await page.$$eval('#signin-methods li', (ls) => ls.map((l) => l.textContent));
    ok('sign-in methods listed', methods.some((t) => /Password: Off/.test(t)) && methods.some((t) => /Google: On/.test(t)), methods.join(' | '));
    ok('confirmed account: no confirm-email box', await page.$eval('#verify-email-box', (b) => b.hidden));
    await page.waitForFunction(() => { const t = document.getElementById('seller-app-status').textContent; return t && !/Checking/.test(t); });
    ok('a store closed by Mwakete shows the reason and Open it again', /Add a phone we can reach/.test(await page.textContent('#seller-app-status')) && /Open it again/.test(await page.textContent('#seller-app-action')));
    await page.click('#signin-methods button[data-action="unlink-google"]');
    await page.waitForFunction(() => /unlinked/.test(document.getElementById('security-status').textContent));
    ok('unlink Google calls the server and updates the list', calls.some((c) => c.action === 'unlinkProvider' && c.provider === 'google' && c.token === 'sess'));
    await page.click('#signin-methods button[data-action="password"]');
    await page.waitForSelector('#set-password-form:not(.hidden)');
    await page.fill('#set-password-code', '123456');
    await page.fill('#set-password-new', 'longenough1');
    await page.click('#set-password-form button[type="submit"]');
    await page.waitForFunction(() => /Password saved/.test(document.getElementById('security-status').textContent));
    ok('set a password: code + new password, new session kept', calls.some((c) => c.action === 'resetCustomerPassword' && c.code === '123456') &&
      (await page.evaluate(() => localStorage.getItem('skiri_customer_token'))) === 'new-sess');
    await page.click('#logout-all');
    await page.waitForURL('**/customer-login.html', { timeout: 4000 }).catch(() => {});
    ok('sign out of all devices', calls.some((c) => c.action === 'logoutAllCustomerSessions') && /customer-login\.html/.test(page.url()), page.url() + ' ' + calls.map((c) => c.action).join());
    ok('no page errors', errors.length === 0, errors.join(' | '));
    await ctx.close();
  }

  /* ---------- unconfirmed (Facebook) account ---------- */
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const calls = [];
    const fb = Object.assign({}, CUST, { email: '', pendingEmail: 'fb@x.com', emailVerified: false });
    await mock(ctx, calls, {
      getCustomerProfile: { ok: true, customer: fb, signInMethods: { password: false, emailCode: false, google: false, facebook: true } },
      getSellerApplication: { ok: true, emailVerified: false, application: null },
      requestCustomerEmailVerification: { ok: true, pendingToken: 'vp', sentTo: 'f•••@x.com' }
    });
    const page = await ctx.newPage();
    await page.addInitScript(() => { try { localStorage.setItem('skiri_customer_token', 'sess'); } catch (e) {} });
    await page.goto(BASE + '/customer-dashboard.html', { waitUntil: 'load' });
    await page.waitForSelector('#verify-email-box:not([hidden])');
    ok('unconfirmed account sees the confirm-email box with the pending address', (await page.inputValue('#verify-email-input')) === 'fb@x.com');
    await page.click('#verify-email-form button[type="submit"]');
    await page.waitForSelector('#verify-code-form:not(.hidden)');
    ok('...and gets a code', calls.some((c) => c.action === 'requestCustomerEmailVerification' && c.email === 'fb@x.com'));
    await page.waitForFunction(() => { const t = document.getElementById('seller-app-status').textContent; return t && !/Checking/.test(t); });
    ok('...cannot apply to sell until confirmed', await page.$eval('#seller-app-action', (a) => a.hidden));
    await ctx.close();
  }

  /* ---------- Register Store = an application ---------- */
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const calls = [];
    await mock(ctx, calls, { registerOwner: { ok: true, token: 'own-tok', owner: { ownerId: 'o1', storeName: 'Tia Fish', storeSlug: 'tia-fish' }, application: { storeName: 'Tia Fish', status: 'approved' } } });
    let page = await ctx.newPage();
    await page.goto(BASE + '/owner/login.html?tab=register', { waitUntil: 'load' });
    await page.waitForTimeout(300);
    ok('not signed in as a shopper: asked to sign in first, no form', await page.isVisible('#register-account-gate') && !(await page.isVisible('#register-store-name')));
    ok('...the button comes back here afterwards', /next=owner%2Flogin\.html%3Ftab%3Dregister/.test(await page.getAttribute('#register-gate-signin', 'href')));
    await page.close();
    page = await ctx.newPage();
    await page.addInitScript((c) => { try { localStorage.setItem('skiri_customer_token', 'sess'); localStorage.setItem('skiri_customer_profile', JSON.stringify(c)); } catch (e) {} }, CUST);
    await page.goto(BASE + '/owner/login.html?tab=register', { waitUntil: 'load' });
    await page.waitForSelector('#register-store-name', { state: 'visible' });
    ok('signed in: store email is the account email, read-only', (await page.inputValue('#register-email')) === 'tia@x.com' && (await page.getAttribute('#register-email', 'readonly')) !== null);
    await page.fill('#register-store-name', 'Tia Fish');
    await page.fill('#register-username', 'tiafish');
    await page.fill('#register-password', 'storepass1');
    await page.fill('#register-password-hint', 'the usual one');
    await page.fill('#register-phone', '73001234');
    await page.fill('#register-messenger', 'tia.fish');
    await page.click('#register-submit-btn');
    await page.waitForTimeout(200);
    ok('"What will you sell?" is required', !calls.some((c) => c.action === 'registerOwner'));
    await page.fill('#register-about', 'Fresh fish in Betio');
    await page.click('#register-submit-btn');
    await page.waitForURL('**/owner/settings.html', { timeout: 6000 }).catch(() => {});
    const sent = calls.find((c) => c.action === 'registerOwner') || {};
    ok('the application carries the shopper session and no typed email', sent.customerToken === 'sess' && !('email' in sent) && sent.about === 'Fresh fish in Betio', JSON.stringify(sent));
    ok('pre-approved: the store opens and the seller goes on to Settings, signed in', /settings\.html/.test(page.url()) &&
      (await page.evaluate(() => localStorage.getItem('skiri_owner_token'))) === 'own-tok', page.url());
    await ctx.close();
  }

  /* ---------- Admin: Seller applications ---------- */
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const calls = [];
    await mock(ctx, calls, {
      getOwnerProfile: { ok: true, owner: { ownerId: 'admin', storeName: 'Admin', storeSlug: 'adm', isAdmin: true } },
      adminListSellerApplications: (b) => ({ ok: true, applications: b.status === 'approved'
        ? [{ ownerId: 'o9', storeName: 'Tia <b>Fish</b>', storeType: 'retailer', status: 'approved', appliedAt: '2026-10-23T00:00:00Z', email: 'tia@x.com', phone: '73001234', messenger: 'https://m.me/tia.fish', about: 'Fish' }] : [] }),
      adminReviewSellerApplication: (b) => ({ ok: true, application: { storeName: 'Tia Fish', status: 'suspended' } })
    });
    const page = await ctx.newPage();
    page.on('dialog', (d) => d.accept());
    await page.addInitScript(() => { try { localStorage.setItem('skiri_owner_token', 'tok'); } catch (e) {} });
    await page.goto(BASE + '/owner/admin.html', { waitUntil: 'load' });
    await page.waitForSelector('#sa-list .sa-item');
    ok('new stores listed (already open), store name escaped', (await page.textContent('#sa-list h3')).includes('Tia <b>Fish</b>'));
    ok('...no Approve button - they are pre-approved', !(await page.$('#sa-list button[data-decision="approve"]')));
    await page.click('#sa-list button[data-decision="suspend"]');
    ok('suspend without a reason is stopped in the page', /reason/.test(await page.textContent('#sa-list .form-error')) && !calls.some((c) => c.action === 'adminReviewSellerApplication'));
    await page.fill('#sa-list .sa-note', 'Fake goods');
    await page.click('#sa-list button[data-decision="suspend"]');
    await page.waitForFunction(() => /suspended/.test(document.getElementById('sa-status').textContent));
    ok('suspend sends the decision and reason with the admin token', calls.some((c) => c.action === 'adminReviewSellerApplication' && c.decision === 'suspend' && c.note === 'Fake goods' && c.ownerId === 'o9' && c.token === 'tok'));
    ok('the section is in the admin menu', !!(await page.$('.admin-jump a[href="#sa-heading"]')));
    await ctx.close();
  }

  await browser.close();
  let failed = 0;
  console.log('\n--- auth: account page, seller applications ---');
  for (const [st, n, e] of R) { if (st === 'FAIL') failed++; console.log(`${st}  ${n}${e ? '  [' + e + ']' : ''}`); }
  console.log(`\n${R.length - failed}/${R.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
