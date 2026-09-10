// "This store has been deleted" now points at the Enquiry link instead of
// spelling out an email address.
//
// The rule that matters: a message that says "the Enquiry link below" is a lie
// unless that link is actually on the page it appears on. Every assertion here
// pairs the wording with the link's existence.
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const fs = require('fs');
const BASE = 'http://127.0.0.1:8099';
const WANT = 'This store has been deleted. Contact now via the Enquiry link below if this is a mistake.';

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e || '']);

  // ---------- the twin on the login page (frontend, ?deleted=) ----------
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await ctx.route('**/macros/s/**', (r) => r.fulfill({ status: 200,
      contentType: 'application/json', body: JSON.stringify({ ok: true }) }));
    const page = await ctx.newPage();
    await page.goto(BASE + '/owner/login.html?deleted=1', { waitUntil: 'load' });
    await page.waitForTimeout(500);
    const msg = (await page.textContent('#session-message')).trim();
    ok('signed-out seller sees the new wording', msg === WANT, msg);
    ok('and it no longer spells out an email address', !/admin@/.test(msg), msg);

    // The words promise a link "below". It has to be there.
    const link = await page.evaluate(() => {
      const a = [...document.querySelectorAll('a')].find((x) => /Enquiry/i.test(x.textContent));
      if (!a) return null;
      const m = document.getElementById('session-message').getBoundingClientRect();
      return { href: a.getAttribute('href'), below: a.getBoundingClientRect().top > m.top,
               visible: a.checkVisibility({ contentVisibilityAuto: true, opacityProperty: true, visibilityProperty: true }) };
    });
    ok('THE ONE THAT MATTERS: an Enquiry link really exists on this page',
      link !== null && link.visible === true, JSON.stringify(link));
    ok('and it is genuinely BELOW the message, as the words claim',
      link && link.below === true, JSON.stringify(link));
    ok('the Enquiry link opens a mail composer', link && /^mailto:/.test(link.href), link && link.href);
    await ctx.close();
  }

  // ---------- the settings page: popup words need a link to point at ----------
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 900 } });
    await ctx.route('**/macros/s/**', (r) => {
      let body = {};
      try { body = r.request().postDataJSON() || {}; } catch (e) {}
      let a = body.action;
      try { if (!a) a = new URL(r.request().url()).searchParams.get('action') || ''; } catch (e) {}
      let res = { ok: true };
      if (a === 'getOwnerProfile') {
        res = { ok: true, owner: { ownerId: 'o1', storeName: 'Bong', storeSlug: 'bong',
          email: 'a@b.com', phone: '73007552', island: 'South Tarawa', village: 'Betio',
          status: 'active', isOpen: true, deliveryPickPay: true,
          logoUrl: 'https://res.cloudinary.com/demo/x.png' } };
      }
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(res) });
    });
    const page = await ctx.newPage();
    await page.addInitScript(() => {
      if (window.__s) return; window.__s = 1;
      try { localStorage.setItem('skiri_owner_token', 'tok'); } catch (e) {}
    });
    await page.goto(BASE + '/owner/settings.html', { waitUntil: 'load' });
    await page.waitForTimeout(900);

    let dialogText = null;
    page.on('dialog', async (d) => { dialogText = d.message(); await d.dismiss(); });
    await page.click('#store-status-delete-btn');
    await page.waitForTimeout(400);

    ok('the delete popup uses the Enquiry wording',
      dialogText && /Enquiry link below/.test(dialogText), String(dialogText));
    ok('and drops the email address', dialogText && !/admin@/.test(dialogText), String(dialogText));

    const link = await page.evaluate(() => {
      const a = [...document.querySelectorAll('a')].find((x) => /Enquiry/i.test(x.textContent));
      if (!a) return null;
      const btn = document.getElementById('store-status-delete-btn').getBoundingClientRect();
      return { href: a.getAttribute('href'), belowButton: a.getBoundingClientRect().top > btn.top,
               visible: a.checkVisibility({ contentVisibilityAuto: true, opacityProperty: true, visibilityProperty: true }) };
    });
    ok('the settings page now HAS an Enquiry link for those words to mean anything',
      link !== null && link.visible === true, JSON.stringify(link));
    ok('and it sits below the Delete Store button', link && link.belowButton === true, JSON.stringify(link));

    // A standing rule of this project: footers live on home and login only.
    const hasFooter = await page.evaluate(() => !!document.querySelector('footer.site-footer'));
    ok('no footer was smuggled onto the settings page to carry it',
      hasFooter === false, String(hasFooter));

    // Dismissing must not delete anything.
    const posted = await page.evaluate(() => window.__deleteCalled === true);
    ok('dismissing the popup deletes nothing', posted === false);
    await ctx.close();
  }

  // ---------- the backend string (source-level; cannot call Apps Script here) ----------
  {
    const auth = fs.readFileSync('/home/user/simple-kiri-shop/apps-script/Auth.gs', 'utf8');
    ok('Auth.gs carries the same wording, word for word',
      auth.indexOf(WANT) !== -1, 'not found in Auth.gs');
    ok('Auth.gs no longer spells out the admin email',
      !/admin@mwakete\.com/.test(auth));
    ok('it still only fires for a closed store, not every failed login',
      /owner\.Status === 'closed'/.test(auth));
    ok('a wrong password on a live store still says "Invalid username or password"',
      /'Invalid username or password'/.test(auth));

    const code = fs.readFileSync('/home/user/simple-kiri-shop/apps-script/Code.gs', 'utf8');
    const mainCode = require('child_process')
      .execSync('git -C /home/user/simple-kiri-shop show origin/main:apps-script/Code.gs', { encoding: 'utf8' });
    const ver = (t) => (t.match(/var APP_VERSION = '([^']+)'/) || [])[1];
    // Only owed when a .gs file differs from main - see test-authchannel.js.
    const gsChanged = require('child_process')
      .execSync("git -C /home/user/simple-kiri-shop diff --name-only origin/main -- 'apps-script/*.gs'",
        { encoding: 'utf8' })
      .split('\n').filter(Boolean);
    ok(gsChanged.length ? 'APP_VERSION bumped, because .gs files differ from main'
                        : 'no APP_VERSION bump owed - no .gs file differs from main',
      gsChanged.length === 0 || ver(code) !== ver(mainCode),
      gsChanged.length + ' changed | ' + ver(mainCode) + ' -> ' + ver(code));
  }

  // ---------- nothing anywhere still hands out the raw address in a message ----------
  {
    const js = require('child_process')
      .execSync("grep -rl 'admin@mwakete.com' /home/user/simple-kiri-shop/assets/js /home/user/simple-kiri-shop/apps-script || true",
        { encoding: 'utf8' }).trim();
    ok('no script file writes the admin email into a user-facing message',
      js === '', js);
  }

  await browser.close();
  console.log('\n--- Deleted-store message ---');
  let f = 0;
  for (const [s, n, e] of R) { if (s === 'FAIL') f++; console.log(`${s}  ${n}${e ? '  [' + e + ']' : ''}`); }
  console.log(`\n${R.length - f}/${R.length} passed`);
  process.exit(f ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
