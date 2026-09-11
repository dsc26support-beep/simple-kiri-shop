/**
 * "Log out" on My Account.
 *
 * The bug this guards was NOT a broken handler - the handler was wired and
 * worked. It awaited the backend round trip before redirecting, with no pending
 * state on the button. On a cold Apps Script start over a weak mobile link that
 * round trip takes many seconds, so a tap produced no movement and no message
 * for as long as the network took, and read as a dead button.
 *
 * So the assertion that matters is the SLOW one. A suite that only tests logout
 * against an instant mock passes happily while the real thing looks broken -
 * which is how this shipped.
 */
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = process.env.AUDIT_BASE || 'http://127.0.0.1:8099';
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('PASS  ' + name + (detail ? '  [' + detail + ']' : '')); }
  else { fail++; console.log('FAIL  ' + name + (detail ? '  [' + detail + ']' : '')); }
};

const CUSTOMER = { customerId: 'c1', name: 'Aroita', email: 'a@example.com', phone: '73012345' };

// logoutMode: 'fast' | 'slow' (8s) | 'dead' (never answers)
async function openDashboard(browser, logoutMode) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const posted = [];
  await ctx.route('**/script.google.com/**', async (r) => {
    let body = {}; try { body = r.request().postDataJSON() || {}; } catch (e) {}
    if (body.action) posted.push(body.action);
    const J = (o) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
    if (body.action === 'getCustomerProfile') return J({ ok: true, customer: CUSTOMER });
    if (body.action === 'logoutCustomer') {
      if (logoutMode === 'dead') return;                 // hangs forever
      if (logoutMode === 'slow') await new Promise((res) => setTimeout(res, 8000));
      return J({ ok: true });
    }
    return J({ ok: true, orders: [], bookings: [] });
  });
  const page = await ctx.newPage();
  // Seeded once, on a different page. addInitScript would re-seed the token on
  // EVERY navigation, including the post-logout one - which made an early
  // version of this test report a cleared token as still present.
  await page.goto(BASE + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    try {
      localStorage.setItem('skiri_customer_token', 't');
      localStorage.setItem('skiri_cookie_consent', 'true');
    } catch (e) {}
  });
  await page.goto(BASE + '/customer-dashboard.html', { waitUntil: 'load' });
  await page.waitForTimeout(1400);
  return { ctx, page, posted };
}

const tokenOf = (page) => page.evaluate(() => {
  try { return localStorage.getItem('skiri_customer_token'); } catch (e) { return 'ERR'; }
});

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

  // --- the button is there and wired ---------------------------------------
  {
    const { ctx, page, posted } = await openDashboard(browser, 'fast');
    ok('the Log out button exists and is enabled', await page.isEnabled('#customer-logout'));
    await page.click('#customer-logout');
    await page.waitForTimeout(1200);
    ok('it signs out and lands on the homepage', /index\.html$/.test(page.url()), page.url());
    ok('the device token is cleared', (await tokenOf(page)) === null);
    ok('and the backend was told', posted.indexOf('logoutCustomer') !== -1, posted.join(','));
    await ctx.close();
  }

  // --- THE REGRESSION: a slow backend must not freeze the button -----------
  {
    const { ctx, page } = await openDashboard(browser, 'slow');
    const t0 = Date.now();
    await page.click('#customer-logout');
    await page.waitForTimeout(400);
    const label = await page.textContent('#customer-logout').catch(() => '');
    ok('it says something on the first tap, before the network answers',
      /logging out/i.test(label || ''), label);
    await page.waitForURL(/index\.html/, { timeout: 4000 }).catch(() => {});
    const elapsed = Date.now() - t0;
    ok('an 8s backend still redirects in under 3.5s', /index\.html$/.test(page.url()) && elapsed < 3500,
      elapsed + 'ms -> ' + page.url());
    ok('and the token is gone regardless', (await tokenOf(page)) === null);
    await ctx.close();
  }

  // --- a backend that never answers at all --------------------------------
  {
    const { ctx, page } = await openDashboard(browser, 'dead');
    const t0 = Date.now();
    await page.click('#customer-logout');
    await page.waitForURL(/index\.html/, { timeout: 5000 }).catch(() => {});
    ok('a backend that never answers still signs you out and moves on',
      /index\.html$/.test(page.url()), (Date.now() - t0) + 'ms -> ' + page.url());
    ok('token cleared', (await tokenOf(page)) === null);
    await ctx.close();
  }

  // --- and being signed out actually sticks -------------------------------
  {
    const { ctx, page } = await openDashboard(browser, 'fast');
    await page.click('#customer-logout');
    await page.waitForTimeout(1200);
    await page.goto(BASE + '/customer-dashboard.html', { waitUntil: 'load' });
    await page.waitForTimeout(1200);
    ok('going back to My Account now sends you to sign in',
      /customer-login\.html/.test(page.url()), page.url());
    await ctx.close();
  }

  // --- the address is remembered for next time -----------------------------
  {
    const { ctx, page } = await openDashboard(browser, 'fast');
    await page.click('#customer-logout');
    await page.waitForTimeout(1200);
    const remembered = await page.evaluate(() => {
      try { return localStorage.getItem('skiri_last_email'); } catch (e) { return 'ERR'; }
    });
    ok('signing out remembers the email address', remembered === 'a@example.com', String(remembered));
    ok('but NOT the session token', (await tokenOf(page)) === null);

    await page.goto(BASE + '/customer-login.html', { waitUntil: 'load' });
    await page.waitForTimeout(1000);
    ok('the sign-in page pre-fills it',
      (await page.inputValue('#login-email')) === 'a@example.com');
    ok('and says whose address it is',
      /a@example\.com/.test(await page.textContent('#login-remembered') || ''));

    // The escape hatch that makes this safe on a borrowed phone.
    await page.click('#login-not-you');
    await page.waitForTimeout(300);
    ok('"Not you?" clears the box', (await page.inputValue('#login-email')) === '');
    ok('and forgets it on the device', await page.evaluate(() => {
      try { return localStorage.getItem('skiri_last_email') === null; } catch (e) { return false; }
    }));
    ok('and the line goes away', await page.locator('#login-remembered').isHidden());
    await ctx.close();
  }

  // --- and remembering it must not move the page ---------------------------
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await ctx.route('**/script.google.com/**', (r) => r.fulfill({ status: 200,
      contentType: 'application/json', body: JSON.stringify({ ok: true }) }));
    const page = await ctx.newPage();
    await page.goto(BASE + '/index.html', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => { try {
      localStorage.setItem('skiri_cookie_consent', 'true');
      localStorage.setItem('skiri_last_email', 'aroita@example.com');
    } catch (e) {} });
    await page.addInitScript(() => {
      window.__cls = 0;
      new PerformanceObserver((l) => {
        for (const e of l.getEntries()) if (!e.hadRecentInput) window.__cls += e.value;
      }).observe({ type: 'layout-shift', buffered: true });
    });
    await page.goto(BASE + '/customer-login.html', { waitUntil: 'load' });
    await page.waitForTimeout(2000);
    const cls = await page.evaluate(() => window.__cls || 0);
    // Decided before first paint by the inline script in the head, and the note's
    // two children are block-level so filling the address in cannot shove the
    // button sideways. Both of those were real measured shifts on the way here:
    // 0.0124 from a deferred un-hide, then 0.0027 horizontal from the text fill.
    ok('pre-filling shifts nothing at all', cls === 0, 'CLS ' + cls.toFixed(4));

    const inlineGuard = require('fs')
      .readFileSync('/home/user/simple-kiri-shop/customer-login.html', 'utf8');
    ok('the pre-paint decision is still made inline in the head',
      /has-remembered-email/.test(inlineGuard) && inlineGuard.indexOf('has-remembered-email')
        < inlineGuard.indexOf('</head>'));
    await ctx.close();
  }

  await browser.close();
  console.log('\n' + pass + '/' + (pass + fail) + ' passed');
  process.exit(fail ? 1 : 0);
})();
