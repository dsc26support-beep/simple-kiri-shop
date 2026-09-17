/**
 * Getting a new vendor to the right form.
 *
 * Three routes onto owner/login.html, and until now two of them ended in a
 * dead stare at a Log In box:
 *
 *   1. A seller page opened with no session at all - a bookmark, a shared
 *      link, the installed app's icon. guardOwnerAuth redirected silently to
 *      the Log In tab with no message whatsoever.
 *   2. Create Store tapped by somebody already signed in as a SHOPPER. The
 *      form asks for a username and password for an account they believe they
 *      already have, and nothing said the two are separate.
 *   3. A username that is already taken, typed into Register by an owner who
 *      is on the wrong tab.
 *
 * THE SECURITY LINE THIS SUITE EXISTS TO HOLD. The log-in error must stay
 * vague. Auth.gs compares against a dummy hash precisely so this form cannot
 * be walked to learn which usernames exist, and "no account with that name,
 * go and register" would hand that back. So the help offered after a failed
 * log-in must say nothing at all about the account - only that Register is
 * there. Registration is the opposite case and may be plain: it has to refuse
 * a taken username, so it cannot hide that one is taken.
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

const CUSTOMER = { customerId: 'c1', name: 'Aroita', email: 'aroita@example.com', phone: '73012345' };

/** opts: { shopper, ownerToken, loginReply, registerReply } */
async function open(browser, path, opts) {
  opts = opts || {};
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const seen = [];
  await ctx.route('**/script.google.com/**', (r) => {
    let body = {}; try { body = r.request().postDataJSON() || {}; } catch (e) {}
    if (body.action) seen.push(body);
    const J = (o) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
    if (body.action === 'loginOwner') return J(opts.loginReply || { ok: false, error: 'Invalid username or password' });
    if (body.action === 'registerOwner') return J(opts.registerReply || { ok: false, error: 'That username is already taken' });
    if (body.action === 'getOwnerProfile') {
      return opts.ownerProfile
        ? J({ ok: true, owner: { ownerId: 'o1', storeName: 'Bong', storeSlug: 'bong', email: 'b@x.com', status: 'active' } })
        : J({ ok: false, error: 'Not authenticated' });
    }
    return J({ ok: true, products: [], orders: [] });
  });
  const page = await ctx.newPage();
  // Seed storage from the same origin before navigating to the page under test.
  await page.goto(BASE + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.evaluate((o) => { try {
    localStorage.setItem('skiri_cookie_consent', 'true');
    if (o.shopper) {
      localStorage.setItem('skiri_customer_token', 'ct');
      localStorage.setItem('skiri_customer_profile', JSON.stringify(o.customer));
    }
    if (o.ownerToken) localStorage.setItem('skiri_owner_token', o.ownerToken);
  } catch (e) {} }, { shopper: !!opts.shopper, ownerToken: opts.ownerToken || '', customer: CUSTOMER });
  await page.goto(BASE + path, { waitUntil: 'load' });
  await page.waitForTimeout(600);
  return { ctx, page, seen };
}

const tabState = (page) => page.evaluate(() => ({
  loginSelected: document.getElementById('tab-login').getAttribute('aria-selected') === 'true',
  registerSelected: document.getElementById('tab-register').getAttribute('aria-selected') === 'true',
  loginShown: !document.getElementById('login-form').classList.contains('hidden'),
  registerShown: !document.getElementById('register-form').classList.contains('hidden'),
  message: document.getElementById('session-message').textContent.trim()
}));

(async () => {
  // ---------- source: the two halves of the enumeration rule ---------------
  const auth = fs.readFileSync(REPO + 'apps-script/Auth.gs', 'utf8');
  ok('the backend still refuses to say whether a username exists',
    /Invalid username or password/.test(auth) && /dummy hash/i.test(auth));
  // The frontend matches this string to decide whether to offer the Log In
  // hand-off. Asserted here so a reworded backend fails a test rather than
  // silently dropping the route.
  ok('and it still says "already taken" for a username clash',
    /That username is already taken/.test(auth));
  const ownerLogin = fs.readFileSync(REPO + 'assets/js/owner-login.js', 'utf8');
  ok('the frontend never invents a "no such user" message of its own',
    !/no account with that|never registered|user not found/i.test(ownerLogin));
  ok('guardOwnerAuth sends a session-less visitor to the sign-up route',
    /needStore=1/.test(fs.readFileSync(REPO + 'assets/js/auth.js', 'utf8')));

  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

  // ---------- 1. a seller page opened with no account at all ---------------
  {
    const { ctx, page } = await open(browser, '/owner/dashboard.html');
    await page.waitForURL('**/owner/login.html*', { timeout: 6000 });
    ok('a seller page with no session lands on the login page',
      /owner\/login\.html/.test(page.url()), page.url());
    ok('carrying the sign-up marker', /needStore=1/.test(page.url()), page.url());
    await page.waitForTimeout(500);
    const t = await tabState(page);
    ok('and it opens on Register, not Log In', t.registerShown && !t.loginShown, JSON.stringify(t));
    ok('Register is the tab marked selected, for assistive tech too', t.registerSelected && !t.loginSelected);
    ok('with a message saying what is needed', /store account/i.test(t.message), t.message);
    // A seller on a new phone lands here too. The line must not tell them they
    // have no account, and Log In must still be one tap away.
    ok('the message never claims they have no account',
      !/no account|not registered|never/i.test(t.message), t.message);
    ok('and Log In is still one tap away', await page.evaluate(() => {
      const b = document.getElementById('tab-login');
      const r = b.getBoundingClientRect();
      return r.width > 0 && r.height >= 30;
    }));
    await page.click('#tab-login');
    const after = await tabState(page);
    ok('tapping it really does go back to Log In', after.loginShown && !after.registerShown);
    await ctx.close();
  }

  // An expired session is a DIFFERENT case: that person had an account.
  {
    const { ctx, page } = await open(browser, '/owner/login.html?expired=1');
    const t = await tabState(page);
    ok('an expired session still lands on Log In, not Register', t.loginShown && !t.registerShown,
      JSON.stringify(t));
    ok('with its own wording', /expired/i.test(t.message), t.message);
    await ctx.close();
  }

  // ---------- 2. a shopper taps Create Store -------------------------------
  {
    const { ctx, page, seen } = await open(browser, '/owner/login.html?tab=register', { shopper: true });
    const note = await page.evaluate(() => {
      const n = document.getElementById('shopper-note');
      return { hidden: n.hidden, text: n.textContent.trim() };
    });
    ok('a signed-in shopper is told a store account is separate',
      note.hidden === false && /separate account/i.test(note.text), note.text);
    ok('and it names the address they are signed in with',
      note.text.includes(CUSTOMER.email), note.text);
    ok('it explains the payoff for reusing that address',
      /My Account/.test(note.text), note.text);
    ok('the register form is the one on screen',
      (await tabState(page)).registerShown);
    // Nothing about the shopper session may leave this page.
    ok('their customer token is never sent anywhere from this page',
      !seen.some((b) => b.token === 'ct'), JSON.stringify(seen.map((b) => b.action)));
    ok('in fact no customer call is made at all',
      !seen.some((b) => /Customer/i.test(b.action || '')), JSON.stringify(seen.map((b) => b.action)));
    await ctx.close();
  }
  {
    const { ctx, page } = await open(browser, '/owner/login.html?tab=register');
    ok('somebody who is not signed in as a shopper sees no note',
      await page.evaluate(() => document.getElementById('shopper-note').hidden === true));
    await ctx.close();
  }

  // ---------- the failed log-in hint: a way out, and no more ---------------
  {
    const { ctx, page } = await open(browser, '/owner/login.html');
    ok('the hint is not there before anything is tried',
      await page.evaluate(() => document.getElementById('login-register-hint').hidden === true));

    await page.fill('#login-username', 'teretia');
    await page.fill('#login-password', 'wrongpass');
    await page.click('#login-submit-btn');
    await page.waitForFunction(() => !document.getElementById('login-register-hint').hidden,
      null, { timeout: 5000 });

    const err = await page.textContent('#login-error');
    ok('the error stays the vague one', /Invalid username or password/.test(err), err);
    ok('it does NOT say the account is missing',
      !/no account|not registered|does not exist|sign up first/i.test(err), err);
    const hint = await page.textContent('#login-register-hint');
    ok('but a way out appears', /New here/i.test(hint), hint.trim());
    ok('and the hint says nothing about the account either',
      !/no account|not registered|does not exist/i.test(hint), hint.trim());
    // Nothing moves on its own here: a person who simply mistyped their own
    // password must stay on the form they are using.
    ok('it does not switch tabs by itself', (await tabState(page)).loginShown);

    await page.click('#login-go-register');
    const t = await tabState(page);
    ok('tapping it opens Register', t.registerShown && !t.loginShown, JSON.stringify(t));
    ok('carrying the username across so it is not typed twice',
      (await page.inputValue('#register-username')) === 'teretia',
      await page.inputValue('#register-username'));
    ok('and the password is NOT carried across',
      (await page.inputValue('#register-password')) === '');
    ok('focus lands on the first field of the new form',
      await page.evaluate(() => document.activeElement.id === 'register-store-name'),
      await page.evaluate(() => document.activeElement.id));
    await ctx.close();
  }

  // ---------- 3. registering a username that already exists ----------------
  {
    const { ctx, page } = await open(browser, '/owner/login.html?tab=register');
    await page.fill('#register-store-name', 'Bong Store');
    await page.fill('#register-username', 'teretia');
    await page.fill('#register-password', 'longenough1');
    await page.fill('#register-email', 'bong@example.com');
    await page.fill('#register-phone', '73012345');
    await page.fill('#register-messenger', 'bong.store');
    await page.click('#register-submit-btn');

    await page.waitForFunction(() => /already taken/.test(document.getElementById('register-error').textContent),
      null, { timeout: 5000 });
    const err = await page.textContent('#register-error');
    ok('a taken username says so', /already taken/i.test(err), err);
    ok('and says where they are being sent', /log in instead/i.test(err), err);
    ok('it does not move immediately - the sentence has to be readable',
      (await tabState(page)).registerShown);

    await page.waitForFunction(() => !document.getElementById('login-form').classList.contains('hidden'),
      null, { timeout: 6000 });
    const t = await tabState(page);
    ok('then it opens Log In', t.loginShown && !t.registerShown, JSON.stringify(t));
    ok('with the username already filled in',
      (await page.inputValue('#login-username')) === 'teretia',
      await page.inputValue('#login-username'));
    ok('and the cursor in the password box', await page.evaluate(() =>
      document.activeElement.id === 'login-password'), await page.evaluate(() => document.activeElement.id));

    // Everything they typed is still there if they go back - the form is only
    // hidden, never cleared. Losing a filled registration form to an automatic
    // tab switch would be a far worse bug than the one this fixes.
    await page.click('#tab-register');
    const kept = await page.evaluate(() => ({
      storeName: document.getElementById('register-store-name').value,
      email: document.getElementById('register-email').value,
      phone: document.getElementById('register-phone').value,
      messenger: document.getElementById('register-messenger').value,
      password: document.getElementById('register-password').value
    }));
    ok('and nothing they typed into Register was lost',
      kept.storeName === 'Bong Store' && kept.email === 'bong@example.com'
      && kept.phone === '73012345' && kept.password === 'longenough1', JSON.stringify(kept));
    await ctx.close();
  }

  // Someone picking a DIFFERENT name instead must not be dragged away.
  {
    const { ctx, page } = await open(browser, '/owner/login.html?tab=register');
    await page.fill('#register-store-name', 'Bong Store');
    await page.fill('#register-username', 'teretia');
    await page.fill('#register-password', 'longenough1');
    await page.fill('#register-email', 'bong@example.com');
    await page.fill('#register-phone', '73012345');
    await page.fill('#register-messenger', 'bong.store');
    await page.click('#register-submit-btn');
    await page.waitForFunction(() => /already taken/.test(document.getElementById('register-error').textContent),
      null, { timeout: 5000 });
    await page.fill('#register-username', 'teretia2');   // they are fixing it
    await page.waitForTimeout(3200);                      // past the switch delay
    ok('editing the username cancels the move to Log In',
      (await tabState(page)).registerShown, JSON.stringify(await tabState(page)));
    ok('and what they typed is untouched',
      (await page.inputValue('#register-username')) === 'teretia2');
    await ctx.close();
  }

  // Any OTHER registration failure must not send them to Log In.
  {
    const { ctx, page } = await open(browser, '/owner/login.html?tab=register',
      { registerReply: { ok: false, error: 'Could not reach the store server' } });
    await page.fill('#register-store-name', 'Bong Store');
    await page.fill('#register-username', 'brandnew');
    await page.fill('#register-password', 'longenough1');
    await page.fill('#register-email', 'bong@example.com');
    await page.fill('#register-phone', '73012345');
    await page.fill('#register-messenger', 'bong.store');
    await page.click('#register-submit-btn');
    await page.waitForFunction(() => document.getElementById('register-error').textContent.length > 0,
      null, { timeout: 5000 });
    await page.waitForTimeout(3200);
    ok('an unrelated registration error leaves them on Register',
      (await tabState(page)).registerShown);
    ok('and does not tell them to log in',
      !/log in instead/i.test(await page.textContent('#register-error')));
    await ctx.close();
  }

  // ---------- an owner already signed in is not shown any of this ----------
  {
    const { ctx, page } = await open(browser, '/owner/login.html?needStore=1',
      { ownerToken: 'ot', ownerProfile: true });
    await page.waitForURL('**/owner/dashboard.html', { timeout: 6000 }).catch(() => {});
    ok('a signed-in owner is sent straight to their dashboard, whatever the query says',
      /owner\/dashboard\.html/.test(page.url()), page.url());
    await ctx.close();
  }
  // And a token the backend rejects goes round the loop to the EXPIRED wording,
  // never to the sign-up one - that person plainly had an account.
  {
    const { ctx, page } = await open(browser, '/owner/login.html?needStore=1', { ownerToken: 'stale' });
    await page.waitForURL('**/owner/login.html?expired=1', { timeout: 6000 }).catch(() => {});
    ok('a stale token ends on the expired message, not the sign-up one',
      /expired=1/.test(page.url()) && !/needStore/.test(page.url()), page.url());
    ok('and on the Log In tab', (await tabState(page)).loginShown);
    await ctx.close();
  }

  await browser.close();
  console.log('\n' + pass + '/' + (pass + fail) + ' passed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
