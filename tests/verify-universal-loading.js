/**
 * The universal loading message and busy buttons (owner request, Oct 2026),
 * on every page: "Loading" + the red/gold/purple moving dots from the first
 * paint, "Please wait" after 3 seconds; buttons show their word + dots, are
 * disabled while busy, say "Please wait" after 3 seconds and come back as
 * they were. Also POS and Integrations, which used to start blank.
 */
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const fs = require('fs');
const path = require('path');
const BASE = process.env.AUDIT_BASE || 'http://127.0.0.1:8099';
const ROOT = path.join(__dirname, '..');
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e === undefined ? '' : e]);
const J = (x) => JSON.stringify(x).slice(0, 300);

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  // A backend that answers only when told to.
  const stalled = async (opts) => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
    const waiting = [];
    await ctx.route('**/macros/s/**', (route) => {
      let b = {}; try { b = route.request().postDataJSON() || {}; } catch (e) {}
      const reply = (body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
      if (opts && opts.answer && opts.answer[b.action]) return reply(opts.answer[b.action]);
      waiting.push(() => reply((opts && opts.later && opts.later[b.action]) || { ok: false, error: 'Test answer.' }));
    });
    await ctx.route('**/accounts.google.com/**', (r) => r.abort());
    await ctx.addInitScript((o) => { localStorage.setItem('skiri_cookie_consent', 'true');
      if (o && o.driver) localStorage.setItem('skiri_customer_token', 'drv-tok');
      if (o && o.owner) { localStorage.setItem('skiri_owner_token', 'tok'); localStorage.setItem('skiri_owner_profile', JSON.stringify({ ownerId: 'o1', storeName: 'Bong Store', storeSlug: 'bong', status: 'active' })); } }, opts || {});
    const page = await ctx.newPage();
    const errors = []; page.on('pageerror', (e) => errors.push(String(e)));
    return { ctx, page, waiting, errors, release: () => waiting.splice(0).forEach((f) => f()) };
  };
  const msg = (page, sel) => page.$eval(sel, (el) => ({ text: el.textContent.trim(), dots: el.querySelectorAll('.loading-dots span').length,
    colour: el.querySelector('.loading-dots span') ? getComputedStyle(el.querySelector('.loading-dots span')).animationName : '' }));

  // ---- the helpers themselves ----
  {
    const { ctx, page } = await stalled();
    await page.goto(BASE + '/terms.html', { waitUntil: 'load' });
    const u = await page.evaluate(async () => {
      const box = document.createElement('div'); document.body.appendChild(box);
      box.innerHTML = loadingMessageHtml();
      const first = box.textContent;
      const gone = document.createElement('div'); document.body.appendChild(gone);
      gone.innerHTML = loadingMessageHtml('Uploading'); const word = gone.textContent; gone.innerHTML = 'Done';
      const b = document.createElement('button'); b.textContent = 'Save'; document.body.appendChild(b);
      const done = setButtonBusy(b, 'Saving');
      const busy = { text: b.textContent, disabled: b.disabled, aria: b.getAttribute('aria-busy'), dots: b.querySelectorAll('.btn-saving-dots span').length };
      const off = document.createElement('button'); off.textContent = 'Next'; off.disabled = true; document.body.appendChild(off);
      const offDone = setButtonBusy(off, 'Checking');
      await new Promise((r) => setTimeout(r, 3200));
      const later = { msg: box.textContent, gone: gone.textContent, btn: b.textContent };
      done(); offDone();
      return { first, word, busy, later, after: { text: b.textContent, disabled: b.disabled, aria: b.hasAttribute('aria-busy') }, offStill: off.disabled, offText: off.textContent,
        evil: (() => { const x = document.createElement('div'); x.innerHTML = loadingMessageHtml('<img src=x onerror=alert(1)>'); return !x.querySelector('img'); })() };
    });
    ok('loadingMessageHtml: "Loading" + moving dots, "Please wait" after 3 seconds', u.first === 'Loading' && u.later.msg === 'Please wait', J(u));
    ok('...its own word when given; once replaced, the timer changes nothing', u.word === 'Uploading' && u.later.gone === 'Done', J(u));
    ok('...the word is text, never markup', u.evil);
    ok('setButtonBusy: word + dots, disabled, aria-busy', u.busy.text === 'Saving' && u.busy.disabled && u.busy.aria === 'true' && u.busy.dots === 3, J(u.busy));
    ok('..."Please wait" after 3 seconds', u.later.btn === 'Please wait', J(u.later));
    ok('...done() puts it back exactly as it was', u.after.text === 'Save' && !u.after.disabled && !u.after.aria && u.offStill && u.offText === 'Next', J(u));
    await ctx.close();
  }

  // ---- placeholders in the HTML: from the first paint, then Please wait ----
  for (const [pagePath, sel, owner, driver] of [['/index.html', '#trending-stores-status'], ['/stores.html', '#stores-status'], ['/driver.html', '#drv-status', false, true],
    ['/owner/dashboard.html', '#recent-orders', true], ['/owner/pos.html', '#pos-status', true], ['/owner/integrations.html', '#hub-status', true]]) {
    const { ctx, page, release } = await stalled({ owner, driver, answer: { getOwnerProfile: { ok: true, owner: { ownerId: 'o1', storeName: 'Bong Store', storeSlug: 'bong', status: 'active' } } } });
    await page.goto(BASE + pagePath, { waitUntil: 'domcontentloaded' });
    const a = await msg(page, sel);
    await page.waitForTimeout(3400);
    const b = await msg(page, sel);
    ok(`${pagePath}: "Loading" with the coloured moving dots, then "Please wait"`, /^Loading/.test(a.text) && a.dots === 3 && /loading-dots/.test(a.colour) && /^Please wait/.test(b.text) && b.dots === 3, J({ a, b }));
    release();
    await ctx.close();
  }

  // ---- POS and Integrations no longer start blank, and clear it when loaded ----
  for (const [pagePath, sel, action, answer] of [['/owner/pos.html', '#pos-status', 'posGetSettings', { ok: true, settings: { maxDiscountPct: 10, taxPercent: 0 } }],
    ['/owner/integrations.html', '#hub-status', 'posHubStatus', { ok: true, enabled: false, connections: [] }]]) {
    const { ctx, page, release, errors } = await stalled({ owner: true, answer: { getOwnerProfile: { ok: true, owner: { ownerId: 'o1', storeName: 'Bong Store', storeSlug: 'bong', status: 'active' } } }, later: { [action]: answer } });
    await page.goto(BASE + pagePath, { waitUntil: 'load' });
    await page.waitForTimeout(400);
    release(); await page.waitForTimeout(500);
    const t = await page.$eval(sel, (el) => el.textContent.trim());
    ok(`${pagePath}: the Loading message goes once the page has loaded`, t === '' && errors.length === 0, J({ t, errors }));
    await ctx.close();
  }

  // ---- a converted button, end to end: shopper "Sign in" (password, Oct 2026) ----
  {
    const { ctx, page, release } = await stalled();
    await page.goto(BASE + '/customer-login.html', { waitUntil: 'load' });
    await page.fill('#login-email', 'a@example.com');
    await page.fill('#login-password', 'secret123');
    const btn = '#login-form button[type="submit"]';
    await page.click(btn); await page.waitForTimeout(300);
    const busy = await page.$eval(btn, (b) => ({ t: b.textContent.trim(), d: b.disabled, dots: b.querySelectorAll('.btn-saving-dots span').length }));
    await page.waitForTimeout(3100);
    const later = await page.$eval(btn, (b) => b.textContent.trim());
    release(); await page.waitForTimeout(300);
    const after = await page.$eval(btn, (b) => ({ t: b.textContent.trim(), d: b.disabled }));
    ok('Shopper "Sign in": "Signing in" + dots, disabled', busy.t === 'Signing in' && busy.d && busy.dots === 3, J(busy));
    ok('..."Please wait" after 3 seconds, then back to "Sign in"', later === 'Please wait' && after.t === 'Sign in' && !after.d, J({ later, after }));
    await ctx.close();
  }
  // ---- seller Log In (its own helper now uses the shared one) ----
  {
    const { ctx, page, release } = await stalled();
    await page.goto(BASE + '/owner/login.html', { waitUntil: 'load' });
    await page.fill('#login-username', 'bong'); await page.fill('#login-password', 'secret123');
    await page.click('#login-submit-btn'); await page.waitForTimeout(300);
    const busy = await page.$eval('#login-submit-btn', (b) => ({ t: b.textContent.trim(), d: b.disabled }));
    release(); await page.waitForTimeout(400);
    const after = await page.$eval('#login-submit-btn', (b) => ({ t: b.textContent.trim(), d: b.disabled }));
    ok('Seller "Log In": "Logging in" while busy, "Log In" again after a failed attempt', busy.t === 'Logging in' && busy.d && after.t === 'Log In' && !after.d, J({ busy, after }));
    await ctx.close();
  }

  // ---- nothing plain left behind ----
  const files = fs.readdirSync(path.join(ROOT, 'assets/js')).filter((f) => f.endsWith('.js') && !f.endsWith('.min.js') && f !== 'helpers.js').map((f) => 'assets/js/' + f)
    .concat(fs.readdirSync(ROOT).filter((f) => f.endsWith('.html')), fs.readdirSync(path.join(ROOT, 'owner')).filter((f) => f.endsWith('.html')).map((f) => 'owner/' + f));
  const plain = [];
  files.forEach((f) => fs.readFileSync(path.join(ROOT, f), 'utf8').split('\n').forEach((line, i) => {
    if (/(textContent = |>)'?(Loading|Saving|Sending|Uploading|Working|Checking|Syncing)( [a-z ]+)?…/.test(line) && !/<option/.test(line)) plain.push(`${f}:${i + 1}`);
  }));
  ok('no plain "Loading…" / "Saving…" text left in any page or script (a dropdown option aside)', plain.length === 0, plain.join(' '));
  const ownBusy = [];
  files.filter((f) => f.endsWith('.js')).forEach((f) => { if (/function setButtonBusy\b/.test(fs.readFileSync(path.join(ROOT, f), 'utf8'))) ownBusy.push(f); });
  ok('only helpers.js defines setButtonBusy (no page replaces the shared one)', ownBusy.length === 0, ownBusy.join(' '));

  await browser.close();
  let f = 0; console.log('\n--- universal loading and busy buttons ---');
  for (const [s, n, e] of R) { if (s === 'FAIL') f++; console.log(`${s}  ${n}${e && s === 'FAIL' ? '  [' + e + ']' : ''}`); }
  console.log(`\n${R.length - f}/${R.length} passed`);
  process.exit(f ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
