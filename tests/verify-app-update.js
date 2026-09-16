/**
 * Auto-update for the installed app.
 *
 * THE ASSERTION THAT MATTERS MOST is that the page is never refreshed out from
 * under someone who would lose something by it. A stale build is an
 * inconvenience; a reload that wipes a half-typed delivery address, an
 * unfinished chat message or a checkout in flight is a real cost, and the
 * person it happens to has no idea why. So every "unsafe" case is exercised
 * individually, and each one must produce the bar rather than a reload.
 *
 * The rest:
 *
 * - A FIRST install must not reload. Both a first registration and a genuine
 *   update fire controllerchange; reloading on the first would be a pointless
 *   refresh on someone's first ever visit.
 * - The check must actually happen on resume, which on an installed app is the
 *   only moment that reliably occurs - people switch back to it, they do not
 *   navigate.
 * - The version shown must come from the SERVICE WORKER, not from the page.
 *   The gap between the two IS the bug being supported.
 */
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const fs = require('fs');
const BASE = process.env.AUDIT_BASE || 'http://127.0.0.1:8099';
const REPO = '/home/user/simple-kiri-shop/';
let pass = 0, fail = 0;
const ok = (n, c, e) => {
  if (c) { pass++; console.log('PASS  ' + n + (e ? '  [' + e + ']' : '')); }
  else { fail++; console.log('FAIL  ' + n + (e ? '  [' + e + ']' : '')); }
};

/**
 * A real service worker cannot be driven to order in a test, so the parts of
 * navigator.serviceWorker this code uses are replaced before any page script
 * runs. Everything under test - the safety rules, the first-install guard, the
 * resume check, the version round trip - is page-side logic, and this exercises
 * exactly that.
 */
const STUB = (hasController) => `
  window.__updateCalls = 0;
  const listeners = {};
  const controller = ${hasController} ? {
    postMessage: (msg, ports) => {
      if (msg && msg.type === 'MWAKETE_GET_VERSION' && ports && ports[0]) {
        ports[0].postMessage({ type: 'MWAKETE_VERSION', version: 'mwakete-v72' });
      }
    }
  } : null;
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: {
      controller: controller,
      register: () => Promise.resolve({ update: () => { window.__updateCalls++; } }),
      addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); },
      // Drives the "a new build took over" moment from the test.
      __fire: (t) => (listeners[t] || []).forEach((fn) => fn({}))
    }
  });
`;

/*
 * Reloads are counted OUTSIDE the page, by watching navigations.
 *
 * Stubbing location.reload was the first attempt and Chromium refuses to let it
 * be redefined. Counting real navigations is better anyway: it observes the
 * thing that actually happens to the person holding the phone, rather than a
 * call to a function that has been replaced with a counter.
 */

async function open(browser, opts) {
  opts = opts || {};
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx.route('**/macros/s/**', (r) => {
    let b = {};
    try { b = r.request().postDataJSON() || {}; } catch (e) {}
    let body = { ok: true, products: [], stores: [], orders: [], bookings: [] };
    if (b.action === 'getCustomerProfile') {
      body = { ok: true, customer: { customerId: 'c1', name: 'Aroita', email: 'a@x.com', phone: '73012345' } };
    }
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  const page = await ctx.newPage();
  const errs = [];
  const nav = { count: 0 };
  page.on('pageerror', (e) => errs.push(String(e)));
  page.on('framenavigated', (f) => { if (f === page.mainFrame()) nav.count++; });
  await page.addInitScript(() => { try {
    localStorage.setItem('skiri_cookie_consent', 'true');
    localStorage.setItem('skiri_customer_token', 't');
    // checkout.html reads the active store from storage, not from ?store= - it
    // redirects to the cart without this, and that redirect was being counted
    // as the reload the test was trying to prove does NOT happen.
    localStorage.setItem('skiri_active_store', 'bong');
    localStorage.setItem('skiri_cart_bong', JSON.stringify(
      [{ variantId: 'v1', productId: 'p1', label: 'Rice', unitPrice: 10, qty: 1 }]));
  } catch (e) {} });
  await page.addInitScript(STUB(opts.hasController !== false));
  await page.goto(BASE + (opts.url || '/index.html'), { waitUntil: 'load' });
  await page.waitForTimeout(900);
  nav.count = 0;              // the first load is not a reload
  return { ctx, page, errs, nav };
}

const newVersionArrives = async (page) => {
  await page.evaluate(() => navigator.serviceWorker.__fire('controllerchange'));
  await page.waitForTimeout(250);
};
const state = async (page, nav) => {
  const inPage = await page.evaluate(() => ({
    updates: window.__updateCalls,
    bar: !!document.getElementById('app-update-bar')
  })).catch(() => ({ updates: 0, bar: false }));   // mid-reload
  return { reloads: nav.count, updates: inPage.updates, bar: inPage.bar };
};

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

  /* ---------- the happy path: nothing at stake, just refresh ---------- */
  {
    const { ctx, page, errs, nav } = await open(browser);
    ok('no JS errors', errs.length === 0, errs.join(' | '));
    let s = await state(page, nav);
    ok('it checks for a new version on launch', s.updates >= 1, String(s.updates));
    ok('and does not reload before one arrives', s.reloads === 0 && !s.bar);

    await newVersionArrives(page);
    s = await state(page, nav);
    ok('an idle page refreshes itself, with no bar to tap', s.reloads === 1 && !s.bar,
      JSON.stringify(s));
    await ctx.close();
  }

  /* ---------- a FIRST install must not reload ---------- */
  {
    const { ctx, page, nav } = await open(browser, { hasController: false });
    await newVersionArrives(page);
    const s = await state(page, nav);
    ok('the FIRST service worker taking control does NOT reload the page',
      s.reloads === 0 && !s.bar, JSON.stringify(s));
    await ctx.close();
  }

  /* ---------- checking on resume, which is the whole point ---------- */
  {
    const { ctx, page, nav } = await open(browser);
    const before = (await state(page, nav)).updates;
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForTimeout(200);
    const after = (await state(page, nav)).updates;
    ok('bringing the app back to the foreground checks again', after > before,
      before + ' -> ' + after);

    // An installed app on Android is often resumed via pageshow instead.
    await page.evaluate(() => window.dispatchEvent(
      Object.assign(new Event('pageshow'), { persisted: true })));
    await page.waitForTimeout(200);
    ok('and so does a restore from the back/forward cache',
      (await state(page, nav)).updates > after, String((await state(page, nav)).updates));

    // Going away must NOT count as coming back.
    const idle = (await state(page, nav)).updates;
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForTimeout(200);
    ok('leaving the app does not trigger a check', (await state(page, nav)).updates === idle);
    await ctx.close();
  }

  /* ---------- THE ONE THAT MATTERS: never refresh over someone's work ---- */

  // Money in flight.
  {
    const { ctx, page, nav } = await open(browser, { url: '/checkout.html?store=bong' });
    ok('the test is really ON checkout, not bounced to the cart',
      /checkout/.test(page.url()), page.url());
    await newVersionArrives(page);
    const s = await state(page, nav);
    ok('CHECKOUT is never auto-refreshed - an order in flight is not worth it',
      s.reloads === 0 && s.bar, JSON.stringify(s));
    await ctx.close();
  }

  // Someone typing, right now.
  {
    const { ctx, page, nav } = await open(browser);
    await page.evaluate(() => {
      const i = document.createElement('input');
      i.type = 'text';
      document.body.appendChild(i);
      i.focus();
    });
    await newVersionArrives(page);
    const s = await state(page, nav);
    ok('a cursor in a text field stops the refresh', s.reloads === 0 && s.bar, JSON.stringify(s));
    await ctx.close();
  }

  {
    const { ctx, page, nav } = await open(browser);
    await page.evaluate(() => {
      const t = document.createElement('textarea');
      document.body.appendChild(t);
      t.focus();
    });
    await newVersionArrives(page);
    ok('and so does a cursor in a textarea', (await state(page, nav)).reloads === 0);
    await ctx.close();
  }

  // A half-written chat message.
  {
    const { ctx, page, nav } = await open(browser);
    await page.evaluate(() => {
      const w = document.createElement('div');
      w.className = 'chat-window chat-window--open';
      document.body.appendChild(w);
    });
    await newVersionArrives(page);
    const s = await state(page, nav);
    ok('an open chat window stops the refresh', s.reloads === 0 && s.bar, JSON.stringify(s));
    await ctx.close();
  }

  // A form the unsaved-changes guard says is genuinely changed.
  {
    const { ctx, page, nav } = await open(browser, { url: '/customer-dashboard.html' });
    await page.waitForTimeout(700);
    await page.click('#profile-edit-btn');
    await page.waitForTimeout(200);
    await page.fill('#profile-phone-input', '73099999');
    await page.evaluate(() => document.activeElement.blur());
    await page.waitForTimeout(200);
    ok('the unsaved guard agrees the form is dirty',
      await page.evaluate(() => UnsavedGuard.isDirty()));
    await newVersionArrives(page);
    const s = await state(page, nav);
    ok('an UNSAVED FORM stops the refresh - the guard decides, not a second rule',
      s.reloads === 0 && s.bar, JSON.stringify(s));
    await ctx.close();
  }

  // A dialog waiting on an answer.
  {
    const { ctx, page, nav } = await open(browser);
    await page.evaluate(() => {
      const d = document.createElement('div');
      d.className = 'unsaved-overlay';
      document.body.appendChild(d);
    });
    await newVersionArrives(page);
    ok('a dialog waiting on an answer stops the refresh', (await state(page, nav)).reloads === 0);
    await ctx.close();
  }

  /* ---------- the bar ---------- */
  {
    const { ctx, page, nav } = await open(browser, { url: '/checkout.html?store=bong' });
    await newVersionArrives(page);
    const bar = await page.evaluate(() => {
      const b = document.getElementById('app-update-bar');
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { text: b.textContent.replace(/\s+/g, ' ').trim(), role: b.getAttribute('role'),
               bottom: Math.round(window.innerHeight - r.bottom), left: Math.round(r.left),
               right: Math.round(window.innerWidth - r.right), width: Math.round(r.width) };
    });
    ok('the bar says what it is in plain words', bar && /new version of Mwakete is ready/i.test(bar.text),
      bar && bar.text);
    ok('and is announced rather than shouted', bar && bar.role === 'status', bar && bar.role);
    ok('it sits fully on screen with a margin each side',
      bar && bar.left >= 8 && bar.right >= 8 && bar.width > 100, JSON.stringify(bar));
    ok('and clear of the bottom nav, not under it', bar && bar.bottom >= 56, JSON.stringify(bar));

    /*
     * THE REFRESH BUTTON MUST ACTUALLY BE TAPPABLE.
     *
     * The first version of this bar sat at z-index 60, full width, low on the
     * screen - directly underneath the floating chat button, which is fixed at
     * z-index 1001 in the lower right. The bar was perfectly visible and its
     * only useful control could not be pressed. A hit test says whether
     * something is on top of it; "is it visible" does not.
     */
    const onTop = await page.evaluate(() => {
      const b = document.getElementById('app-update-refresh');
      const r = b.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return { hit: hit ? hit.id || hit.className : null, inside: !!(hit && b.contains(hit)) };
    });
    ok('nothing is stacked on top of the Refresh button', onTop.inside, JSON.stringify(onTop));
    ok('and the install pill is hidden while the bar is up, since they share a slot',
      await page.evaluate(() => document.body.classList.contains('has-app-update')));

    await page.click('#app-update-refresh');
    await page.waitForTimeout(200);
    ok('tapping Refresh applies it', (await state(page, nav)).reloads === 1);
    await ctx.close();
  }

  {
    const { ctx, page, nav } = await open(browser, { url: '/checkout.html?store=bong' });
    await newVersionArrives(page);
    await page.click('#app-update-later');
    await page.waitForTimeout(200);
    const s = await state(page, nav);
    ok('it can be dismissed, and dismissing does NOT reload', !s.bar && s.reloads === 0,
      JSON.stringify(s));
    await ctx.close();
  }

  {
    const { ctx, page, nav } = await open(browser, { url: '/checkout.html?store=bong' });
    await newVersionArrives(page);
    await newVersionArrives(page);
    await newVersionArrives(page);
    ok('three updates in a row still leave exactly one bar',
      await page.evaluate(() => document.querySelectorAll('#app-update-bar').length) === 1);
    await ctx.close();
  }

  /* ---------- the version line ---------- */
  {
    const { ctx, page, nav } = await open(browser, { url: '/customer-dashboard.html' });
    await page.waitForTimeout(900);
    ok('the account page shows the build the PHONE is running',
      (await page.textContent('#app-version')).trim() === 'Mwakete mwakete-v72',
      await page.textContent('#app-version'));
    await ctx.close();
  }

  {
    // No worker at all - a browser with service workers unavailable or blocked.
    const { ctx, page, nav } = await open(browser, { url: '/customer-dashboard.html', hasController: false });
    await page.waitForTimeout(900);
    ok('with no service worker the line stays EMPTY, not "unknown"',
      (await page.textContent('#app-version')).trim() === '',
      JSON.stringify(await page.textContent('#app-version')));
    await ctx.close();
  }

  await browser.close();

  /* ---------- read from the source ---------- */
  const reg = fs.readFileSync(REPO + 'assets/js/register-sw.js', 'utf8');
  ok('update checks never answer from the HTTP cache, or they would report no change',
    /updateViaCache: 'none'/.test(reg));
  ok('the first-install guard is captured BEFORE registration can change it',
    reg.indexOf('hadController = !!navigator.serviceWorker.controller')
      < reg.indexOf('navigator.serviceWorker.register('));
  ok('a failed registration still cannot break the page',
    /\.catch\(function \(\) \{\}\)/.test(reg));

  const sw = fs.readFileSync(REPO + 'sw.js', 'utf8');
  ok('the worker answers only the version message and nothing else',
    /event\.data\.type !== 'MWAKETE_GET_VERSION'\) return;/.test(sw));
  ok('skipWaiting and clients.claim are still there - without them nothing activates',
    /skipWaiting\(\)/.test(sw) && /clients\.claim\(\)/.test(sw));

  console.log('\n' + pass + '/' + (pass + fail) + ' passed');
  process.exit(fail ? 1 : 0);
})();
