/**
 * The contact-email section of owner/settings.html.
 *
 * The backend rules are covered by test-emailchange.js. This is about what the
 * seller sees, and three things matter:
 *
 *   1. The address is NOT an editable box any more, and Save Settings must not
 *      carry it. Leaving the old input in place would keep the unverified path
 *      alive from the page even though the backend has closed it.
 *   2. Saving everything else must still work. A seller changing their phone or
 *      their delivery fees cannot be made to pay for a security fix elsewhere
 *      on the same form.
 *   3. The page must be honest during the wait: the live address is still the
 *      old one, and it must say so - including after a reload, since a seller
 *      who closed the page would otherwise have no idea a request is open.
 */
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = process.env.AUDIT_BASE || 'http://127.0.0.1:8099';

const OWNER = {
  ownerId: 'own_1', storeName: 'Bong', storeSlug: 'bong', email: 'old@example.com',
  phone: '73007552', island: 'South Tarawa', village: 'Betio', status: 'active',
  isOpen: true, deliveryPickPay: true, logoUrl: 'https://res.cloudinary.com/demo/x.png',
  pendingEmail: ''
};

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e || '']);

  /** opts: { ownerOverrides, requestReply, confirmReply } */
  async function open(opts) {
    opts = opts || {};
    const ctx = await browser.newContext({ viewport: { width: 390, height: 900 } });
    const posted = [];
    await ctx.route('**/macros/s/**', (r) => {
      let body = {};
      try { body = r.request().postDataJSON() || {}; } catch (e) {}
      let a = body.action;
      try { if (!a) a = new URL(r.request().url()).searchParams.get('action') || ''; } catch (e) {}
      posted.push(body);
      let res = { ok: true };
      const owner = Object.assign({}, OWNER, opts.ownerOverrides);
      if (a === 'getOwnerProfile') res = { ok: true, owner };
      else if (a === 'updateOwnerProfile') res = { ok: true, owner };
      else if (a === 'requestEmailChange') {
        res = opts.requestReply || { ok: true, verifyToken: 'tok-email', sentTo: 'new@example.com' };
      } else if (a === 'confirmEmailChange') {
        res = opts.confirmReply || { ok: true, email: 'new@example.com' };
      }
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(res) });
    });
    const page = await ctx.newPage();
    await page.addInitScript(() => {
      if (window.__s) return; window.__s = 1;
      try { localStorage.setItem('skiri_owner_token', 'tok'); } catch (e) {}
    });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(BASE + '/owner/settings.html', { waitUntil: 'load' });
    await page.waitForTimeout(900);
    return { ctx, page, errors, posted };
  }

  // ---- the address is shown, not edited -----------------------------------
  {
    const { ctx, page, errors } = await open();
    ok('the current address is displayed',
      (await page.textContent('#contact-email-current')).trim() === 'old@example.com',
      await page.textContent('#contact-email-current'));
    ok('there is no editable email box on the settings form',
      await page.evaluate(() => !document.querySelector('#contact-email')));
    ok('the change button is offered',
      await page.locator('#email-change-btn').isVisible());
    ok('and neither step is open yet', await page.evaluate(() =>
      document.getElementById('email-change-block').hidden
      && document.getElementById('email-confirm-block').hidden));
    ok('nothing says a change is pending',
      await page.evaluate(() => document.getElementById('contact-email-pending').hidden === true));
    ok('no page errors', errors.length === 0, errors.join('; '));
    await ctx.close();
  }

  // ---- saving the rest of the form still works, and carries no email ------
  {
    const { ctx, page, posted } = await open();
    await page.fill('#contact-phone', '73011111');
    await page.click('#save-settings-btn');
    await page.waitForTimeout(600);
    const save = posted.filter((b) => b.action === 'updateOwnerProfile')[0];
    ok('Save Settings still saves', !!save, JSON.stringify(posted.map((b) => b.action)));
    ok('and the phone it sent is the one typed', save && save.phone === '73011111', save && save.phone);
    ok('but it carries NO email field at all', save && !('email' in save),
      save && JSON.stringify(Object.keys(save)));
    await ctx.close();
  }

  // ---- the two-step change -------------------------------------------------
  {
    const { ctx, page, posted } = await open();
    await page.click('#email-change-btn');
    ok('step one opens', await page.locator('#email-change-block').isVisible());
    ok('and asks for a password', await page.evaluate(() =>
      document.getElementById('email-change-password').type === 'password'));

    // Neither field may be skipped, and neither check may cost a round trip.
    await page.click('#email-change-send');
    await page.waitForTimeout(200);
    ok('an empty address is caught in the page', /Enter the new email/i.test(
      await page.textContent('#email-change-error')));
    await page.fill('#email-change-new', 'new@example.com');
    await page.click('#email-change-send');
    await page.waitForTimeout(200);
    ok('a missing password is caught too', /Enter your password/i.test(
      await page.textContent('#email-change-error')));
    ok('and neither reached the backend',
      !posted.some((b) => b.action === 'requestEmailChange'));

    await page.fill('#email-change-password', 'hunter2hunter2');
    await page.click('#email-change-send');
    await page.waitForSelector('#email-confirm-block:not([hidden])', { timeout: 5000 });

    const req = posted.filter((b) => b.action === 'requestEmailChange')[0];
    ok('the request carries the new address and the password',
      req && req.email === 'new@example.com' && req.password === 'hunter2hunter2',
      req && JSON.stringify({ email: req.email, hasPassword: !!req.password }));
    ok('step one closes when step two opens',
      await page.evaluate(() => document.getElementById('email-change-block').hidden === true));
    const hint = await page.textContent('#email-confirm-hint');
    ok('it says where the code went', /new@example\.com/.test(hint), hint);
    ok('and promises nothing has changed yet', /keeps using its current/i.test(hint), hint);
    ok('the displayed address is STILL the old one',
      (await page.textContent('#contact-email-current')).trim() === 'old@example.com');

    await page.click('#email-confirm-send');
    await page.waitForTimeout(200);
    ok('an empty code is caught in the page', /Enter the 6-digit code/i.test(
      await page.textContent('#email-confirm-error')));

    await page.fill('#email-confirm-code', '123456');
    await page.click('#email-confirm-send');
    await page.waitForTimeout(600);
    const conf = posted.filter((b) => b.action === 'confirmEmailChange')[0];
    ok('the code goes up with the token from step one',
      conf && conf.code === '123456' && conf.verifyToken === 'tok-email', JSON.stringify(conf));
    ok('the displayed address is now the new one',
      (await page.textContent('#contact-email-current')).trim() === 'new@example.com',
      await page.textContent('#contact-email-current'));
    ok('and it says what that means', /Orders and login codes go there/i.test(
      await page.textContent('#email-change-success')));
    ok('both steps are closed again', await page.evaluate(() =>
      document.getElementById('email-change-block').hidden
      && document.getElementById('email-confirm-block').hidden));
    // The stored profile feeds the 2FA copy and the dashboard.
    ok('the saved session profile was updated too', await page.evaluate(() => {
      try { return JSON.parse(localStorage.getItem('skiri_owner_profile')).email === 'new@example.com'; }
      catch (e) { return false; }
    }));
    await ctx.close();
  }

  // ---- the backend refusing is shown, and changes nothing -----------------
  {
    const { ctx, page } = await open({ requestReply: { ok: false, error: 'That password is not right' } });
    await page.click('#email-change-btn');
    await page.fill('#email-change-new', 'new@example.com');
    await page.fill('#email-change-password', 'wrong');
    await page.click('#email-change-send');
    await page.waitForTimeout(600);
    ok('a refused password is shown to the seller',
      /not right/.test(await page.textContent('#email-change-error')),
      await page.textContent('#email-change-error'));
    ok('and step two never opens',
      await page.evaluate(() => document.getElementById('email-confirm-block').hidden === true));
    ok('the address is unchanged',
      (await page.textContent('#contact-email-current')).trim() === 'old@example.com');
    await ctx.close();
  }
  {
    const { ctx, page } = await open({ confirmReply: { ok: false, error: 'That code is not right' } });
    await page.click('#email-change-btn');
    await page.fill('#email-change-new', 'new@example.com');
    await page.fill('#email-change-password', 'hunter2hunter2');
    await page.click('#email-change-send');
    await page.waitForSelector('#email-confirm-block:not([hidden])', { timeout: 5000 });
    await page.fill('#email-confirm-code', '000000');
    await page.click('#email-confirm-send');
    await page.waitForTimeout(600);
    ok('a refused code is shown', /not right/.test(await page.textContent('#email-confirm-error')));
    ok('the step stays open so they can retype it',
      await page.evaluate(() => document.getElementById('email-confirm-block').hidden === false));
    ok('and the address is unchanged',
      (await page.textContent('#contact-email-current')).trim() === 'old@example.com');
    await ctx.close();
  }

  // ---- cancelling clears what was typed ------------------------------------
  {
    const { ctx, page } = await open();
    await page.click('#email-change-btn');
    await page.fill('#email-change-new', 'new@example.com');
    await page.fill('#email-change-password', 'hunter2hunter2');
    await page.click('#email-change-cancel');
    ok('cancel closes the block', await page.evaluate(() =>
      document.getElementById('email-change-block').hidden === true));
    ok('the change button comes back', await page.locator('#email-change-btn').isVisible());
    await page.click('#email-change-btn');
    ok('and the password is not left sitting in the form', await page.evaluate(() =>
      document.getElementById('email-change-password').value === ''
      && document.getElementById('email-change-new').value === ''));
    await ctx.close();
  }

  // ---- an outstanding request survives a reload ---------------------------
  {
    const { ctx, page } = await open({ ownerOverrides: { pendingEmail: 'waiting@example.com' } });
    const note = await page.textContent('#contact-email-pending');
    ok('a reload still shows the outstanding request', /waiting@example\.com/.test(note), note);
    ok('and says the store is still on the old address',
      /keeps using the address above/i.test(note), note);
    ok('while the live address shown is the old one',
      (await page.textContent('#contact-email-current')).trim() === 'old@example.com');
    await ctx.close();
  }

  // ---- desktop ------------------------------------------------------------
  {
    const { ctx, page } = await open();
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.click('#email-change-btn');
    ok('no sideways scrolling with the block open at 1280px', await page.evaluate(() =>
      document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1));
    await ctx.close();
  }

  await browser.close();
  let f = 0;
  console.log('\n--- Changing the contact email (settings UI) ---');
  for (const [s, n, e] of R) { if (s === 'FAIL') f++; console.log(`${s}  ${n}${e ? '  [' + e + ']' : ''}`); }
  console.log(`\n${R.length - f}/${R.length} passed`);
  process.exit(f ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
