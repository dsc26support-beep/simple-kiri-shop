/**
 * The unsaved-changes guard.
 *
 * Two things here are load-bearing beyond "does it warn".
 *
 * FALSE ALARMS. A warning that fires when nothing really changed teaches
 * people to dismiss warnings without reading them, which makes the ones that
 * matter useless. So: typing a character and deleting it again must NOT warn,
 * and a saved form must NOT warn.
 *
 * BFCACHE. A registered beforeunload listener disables the browser's
 * back/forward cache, so pressing Back re-fetches and re-renders instead of
 * restoring instantly - a real cost on a slow connection, paid by every
 * visitor whether or not they ever edit anything. The listener must therefore
 * be absent until a form is genuinely dirty and gone again once it is clean.
 * That is asserted directly, not assumed.
 */
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = process.env.AUDIT_BASE || 'http://127.0.0.1:8099';
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('PASS  ' + name + (detail ? '  [' + detail + ']' : '')); }
  else { fail++; console.log('FAIL  ' + name + (detail ? '  [' + detail + ']' : '')); }
};

const CUST = { customerId: 'c1', name: 'Aroita', email: 'a@example.com', phone: '73012345' };

// Counts beforeunload registrations, since there is no way to read them back.
const COUNT_LISTENERS = () => {
  window.__bu = 0;
  const add = window.addEventListener.bind(window);
  const rm = window.removeEventListener.bind(window);
  window.addEventListener = function (t, f, o) {
    if (t === 'beforeunload') window.__bu++;
    return add(t, f, o);
  };
  window.removeEventListener = function (t, f, o) {
    if (t === 'beforeunload') window.__bu--;
    return rm(t, f, o);
  };
};

async function openDashboard(browser) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx.route('**/script.google.com/**', (r) => {
    let b = {}; try { b = r.request().postDataJSON() || {}; } catch (e) {}
    const J = (o) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
    if (b.action === 'getCustomerProfile') return J({ ok: true, customer: CUST });
    if (b.action === 'updateCustomerProfile') return J({ ok: true, customer: CUST });
    return J({ ok: true, orders: [], bookings: [], hasStore: false });
  });
  const page = await ctx.newPage();
  await page.addInitScript(COUNT_LISTENERS);
  await page.goto(BASE + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { try {
    localStorage.setItem('skiri_customer_token', 't');
    localStorage.setItem('skiri_cookie_consent', 'true');
  } catch (e) {} });
  await page.goto(BASE + '/customer-dashboard.html', { waitUntil: 'load' });
  await page.waitForTimeout(1600);
  return { ctx, page };
}

const listeners = (page) => page.evaluate(() => window.__bu || 0);
const dirty = (page) => page.evaluate(() => UnsavedGuard.isDirty());

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

  // ---- bfcache: nothing registered until something is actually edited -----
  {
    const { ctx, page } = await openDashboard(browser);
    ok('a freshly loaded page registers NO beforeunload listener',
      (await listeners(page)) === 0, String(await listeners(page)));

    await page.click('#profile-edit-btn');
    await page.waitForTimeout(300);
    ok('opening the edit form alone still registers none',
      (await listeners(page)) === 0 && (await dirty(page)) === false);

    await page.fill('#profile-name-input', 'Aroita Teuea');
    await page.waitForTimeout(250);
    ok('editing a field marks it dirty', (await dirty(page)) === true);
    ok('and only NOW is a beforeunload listener registered',
      (await listeners(page)) === 1, String(await listeners(page)));

    // The false-alarm case that matters most.
    await page.fill('#profile-name-input', 'Aroita');
    await page.waitForTimeout(250);
    ok('typing then undoing it is NOT dirty - dirty means different, not touched',
      (await dirty(page)) === false);
    ok('and the listener is removed again, so bfcache comes back',
      (await listeners(page)) === 0, String(await listeners(page)));
    await ctx.close();
  }

  // ---- leaving by a link ---------------------------------------------------
  {
    const { ctx, page } = await openDashboard(browser);
    await page.click('#profile-edit-btn');
    await page.waitForTimeout(250);
    await page.fill('#profile-phone-input', '73099999');
    await page.waitForTimeout(250);

    await page.click('.dash-links a[href="customer-messages.html"]');
    await page.waitForTimeout(400);
    ok('tapping a link with unsaved edits asks first',
      await page.locator('#unsaved-dialog').isVisible());
    ok('and the page has not moved yet', /customer-dashboard/.test(page.url()), page.url());

    await page.click('#unsaved-stay');
    await page.waitForTimeout(300);
    ok('"Stay" keeps you on the page', /customer-dashboard/.test(page.url())
      && await page.locator('#unsaved-dialog').count() === 0);
    ok('and the edit is still there', (await page.inputValue('#profile-phone-input')) === '73099999');

    await page.click('.dash-links a[href="customer-messages.html"]');
    await page.waitForTimeout(400);
    await page.click('#unsaved-leave');
    await page.waitForTimeout(900);
    ok('"Leave without saving" goes', /customer-messages/.test(page.url()), page.url());
    await ctx.close();
  }

  // ---- saving clears it ----------------------------------------------------
  {
    const { ctx, page } = await openDashboard(browser);
    await page.click('#profile-edit-btn');
    await page.waitForTimeout(250);
    await page.fill('#profile-phone-input', '73088888');
    await page.waitForTimeout(250);
    ok('dirty before saving', (await dirty(page)) === true);

    await page.click('#profile-form button[type="submit"]');
    await page.waitForTimeout(900);
    ok('saving clears it', (await dirty(page)) === false);
    ok('and releases the beforeunload listener', (await listeners(page)) === 0);

    await page.click('.dash-links a[href="customer-messages.html"]');
    await page.waitForTimeout(700);
    ok('so leaving afterwards asks nothing', /customer-messages/.test(page.url()), page.url());
    await ctx.close();
  }

  // ---- cancelling is a decision, not an abandonment ------------------------
  {
    const { ctx, page } = await openDashboard(browser);
    await page.click('#profile-edit-btn');
    await page.waitForTimeout(250);
    await page.fill('#profile-name-input', 'Something else');
    await page.waitForTimeout(250);
    await page.click('#profile-cancel');
    await page.waitForTimeout(300);
    ok('pressing Cancel stops the warning', (await dirty(page)) === false);
    ok('and takes the listener with it', (await listeners(page)) === 0);
    await ctx.close();
  }

  // ---- links that must NOT be intercepted ---------------------------------
  {
    const { ctx, page } = await openDashboard(browser);
    await page.click('#profile-edit-btn');
    await page.waitForTimeout(250);
    await page.fill('#profile-name-input', 'Edited');
    await page.waitForTimeout(250);

    const guarded = await page.evaluate(() => {
      // Exercise the real decision function through synthetic clicks.
      const make = (href, attrs) => {
        const a = document.createElement('a');
        a.href = href;
        Object.keys(attrs || {}).forEach((k) => a.setAttribute(k, attrs[k]));
        a.textContent = 'x';
        document.body.appendChild(a);
        return a;
      };
      const results = {};
      const cases = {
        offsite: make('https://m.me/someone'),
        mailto: make('mailto:admin@mwakete.com'),
        tel: make('tel:73012345'),
        newTab: make('customer-messages.html', { target: '_blank' }),
        download: make('customer-messages.html', { download: '' }),
        hash: make('#main')
      };
      Object.keys(cases).forEach((k) => {
        const ev = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
        cases[k].dispatchEvent(ev);
        results[k] = ev.defaultPrevented;   // true would mean the guard grabbed it
        cases[k].remove();
      });
      const dlg = document.getElementById('unsaved-dialog');
      if (dlg) dlg.remove();
      return results;
    });
    for (const k of Object.keys(guarded)) {
      ok('a ' + k + ' link is left alone', guarded[k] === false, String(guarded[k]));
    }
    await ctx.close();
  }

  // ---- the search boxes and sign-in forms are deliberately NOT watched -----
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await ctx.route('**/script.google.com/**', (r) => r.fulfill({ status: 200,
      contentType: 'application/json', body: JSON.stringify({ ok: true, products: [], stores: [] }) }));
    const page = await ctx.newPage();
    await page.addInitScript(COUNT_LISTENERS);
    await page.goto(BASE + '/index.html', { waitUntil: 'load' });
    await page.evaluate(() => { try { localStorage.setItem('skiri_cookie_consent', 'true'); } catch (e) {} });
    await page.reload({ waitUntil: 'load' });
    await page.waitForTimeout(1200);
    const box = await page.$('#search-form input[type="search"], #search-form input');
    if (box) { await box.fill('rice'); await page.waitForTimeout(300); }
    ok('typing in the homepage search registers no beforeunload listener',
      (await listeners(page)) === 0, String(await listeners(page)));
    ok('and the guard is not even loaded on the homepage',
      await page.evaluate(() => typeof UnsavedGuard === 'undefined'));
    await ctx.close();
  }

  await browser.close();
  console.log('\n' + pass + '/' + (pass + fail) + ' passed');
  process.exit(fail ? 1 : 0);
})();
