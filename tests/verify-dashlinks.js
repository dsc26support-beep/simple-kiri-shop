/**
 * My Account: the "My Messages" and "Create Store" / "My Store" buttons.
 *
 * Two things are load-bearing here.
 *
 * SECURITY. The backend answers "does this person own a store" for the
 * AUTHENTICATED customer's own address only. Written the obvious way - taking
 * an email in the body - it would be an enumeration endpoint anyone could walk
 * to learn which addresses belong to vendors. Asserted at the source, because
 * it is the kind of thing a later refactor makes "more flexible" by accident.
 *
 * NO MOVEMENT. The label swap happens after first paint, so the button's box is
 * sized to the wider of its two labels. A width change would shift the row
 * sideways, and horizontal shifts count towards CLS exactly as vertical ones do.
 */
const fs = require('fs');
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const REPO = '/home/user/simple-kiri-shop/';
const BASE = process.env.AUDIT_BASE || 'http://127.0.0.1:8099';
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('PASS  ' + name + (detail ? '  [' + detail + ']' : '')); }
  else { fail++; console.log('FAIL  ' + name + (detail ? '  [' + detail + ']' : '')); }
};

const CUST = { customerId: 'c1', name: 'Aroita', email: 'a@example.com', phone: '73012345' };
const PURPLE = 'rgb(51, 45, 99)'; // --color-purple #332d63

async function openDash(browser, storeReply, delayMs) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const seen = [];
  await ctx.route('**/script.google.com/**', async (r) => {
    let body = {}; try { body = r.request().postDataJSON() || {}; } catch (e) {}
    if (body.action) seen.push(body);
    const J = (o) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
    if (body.action === 'getCustomerProfile') return J({ ok: true, customer: CUST });
    if (body.action === 'getCustomerStore') {
      if (delayMs) await new Promise((s) => setTimeout(s, delayMs));
      if (storeReply === 'error') return r.fulfill({ status: 500, body: 'boom' });
      return J(storeReply);
    }
    return J({ ok: true, orders: [], bookings: [] });
  });
  const page = await ctx.newPage();
  await page.goto(BASE + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { try {
    localStorage.setItem('skiri_customer_token', 't');
    localStorage.setItem('skiri_cookie_consent', 'true');
  } catch (e) {} });
  await page.addInitScript(() => {
    window.__cls = 0;
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) if (!e.hadRecentInput) window.__cls += e.value;
    }).observe({ type: 'layout-shift', buffered: true });
  });
  await page.goto(BASE + '/customer-dashboard.html', { waitUntil: 'load' });
  await page.waitForTimeout(2400);
  return { ctx, page, seen };
}

const linkInfo = (page) => page.evaluate(() => {
  const l = document.getElementById('store-link');
  const cs = getComputedStyle(l);
  return { label: l.textContent.trim(), href: l.getAttribute('href'),
    width: Math.round(l.getBoundingClientRect().width),
    color: cs.color, borderColor: cs.borderTopColor, borderWidth: cs.borderTopWidth,
    bg: cs.backgroundColor };
});

(async () => {
  // ---------- source: the endpoint must not be an enumeration oracle --------
  const customers = fs.readFileSync(REPO + 'apps-script/Customers.gs', 'utf8');
  const fn = (customers.match(/function actionGetCustomerStore[\s\S]*?\n}/) || [''])[0];
  ok('the store lookup exists', fn.length > 0);
  ok('it authenticates the caller', /requireCustomerAuth\(body\.token\)/.test(fn));
  ok('it reads the email from the AUTHENTICATED customer, not the request body',
    /normalizeEmail\(customer\.Email\)/.test(fn) && !/body\.email/.test(fn));
  ok('a closed or deleted store does not count as having one', /isStoreBrowsable/.test(fn));
  const code = fs.readFileSync(REPO + 'apps-script/Code.gs', 'utf8');
  ok('the action is routed', /case 'getCustomerStore'/.test(code));

  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

  // ---------- no store: the default, and the honest one --------------------
  {
    const { ctx, page } = await openDash(browser, { ok: true, hasStore: false });
    const i = await linkInfo(page);
    ok('with no store it offers Create Store', i.label === 'Create Store', i.label);
    ok('pointing at vendor registration', /owner\/login\.html\?tab=register/.test(i.href), i.href);
    ok('outline only - transparent fill', i.bg === 'rgba(0, 0, 0, 0)', i.bg);
    ok('purple border', i.borderColor === PURPLE && i.borderWidth === '1px', i.borderColor + ' ' + i.borderWidth);
    ok('purple text', i.color === PURPLE, i.color);
    await ctx.close();
  }

  // ---------- has a store ---------------------------------------------------
  let widthNoStore, widthStore;
  {
    const { ctx, page } = await openDash(browser, { ok: true, hasStore: false });
    widthNoStore = (await linkInfo(page)).width;
    await ctx.close();
  }
  {
    const { ctx, page, seen } = await openDash(browser,
      { ok: true, hasStore: true, storeSlug: 'bong', storeName: 'Bong Store' });
    const i = await linkInfo(page);
    widthStore = i.width;
    ok('with a store it becomes My Store', i.label === 'My Store', i.label);
    ok('pointing at the seller dashboard', i.href === 'owner/dashboard.html', i.href);
    ok('still outline only', i.bg === 'rgba(0, 0, 0, 0)' && i.borderColor === PURPLE);
    ok('the lookup sent the session token, not an email',
      seen.some((b) => b.action === 'getCustomerStore' && b.token === 't' && !b.email),
      JSON.stringify(seen.find((b) => b.action === 'getCustomerStore') || {}));
    await ctx.close();
  }

  ok('the button is the SAME width either way, so the swap moves nothing',
    widthNoStore === widthStore, widthNoStore + 'px vs ' + widthStore + 'px');

  // ---------- a slow or broken lookup must not break the page --------------
  {
    const { ctx, page } = await openDash(browser, { ok: true, hasStore: true }, 3000);
    const i = await linkInfo(page);
    ok('a slow lookup just leaves Create Store standing', i.label === 'Create Store', i.label);
    await ctx.close();
  }
  {
    const { ctx, page } = await openDash(browser, 'error');
    const i = await linkInfo(page);
    ok('a failed lookup leaves Create Store rather than guessing', i.label === 'Create Store', i.label);
    await ctx.close();
  }

  // ---------- My Messages is the same kind of button ------------------------
  {
    const { ctx, page } = await openDash(browser, { ok: true, hasStore: false });
    const msgs = await page.evaluate(() => {
      const a = document.querySelector('.dash-links a[href="customer-messages.html"]');
      if (!a) return null;
      const cs = getComputedStyle(a);
      return { text: a.textContent.trim(), bg: cs.backgroundColor, border: cs.borderTopColor };
    });
    ok('My Messages sits alongside it', msgs && /My Messages/.test(msgs.text), JSON.stringify(msgs));
    ok('and is the same outline button', msgs && msgs.bg === 'rgba(0, 0, 0, 0)' && msgs.border === PURPLE,
      JSON.stringify(msgs));
    await ctx.close();
  }

  await browser.close();
  console.log('\n' + pass + '/' + (pass + fail) + ' passed');
  process.exit(fail ? 1 : 0);
})();
