// The 2FA copy on owner/settings.html must name the channel a code will
// ACTUALLY arrive on, not the one the vendor asked for.
//
// A vendor whose stored preference is 'sms' still gets email while no SMS
// sender exists. Telling them to check their phone would send them looking in
// the wrong place for a code that is sitting in their inbox.
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = 'http://127.0.0.1:8099';

const OWNER = {
  ownerId: 'own_1', storeName: 'Bong', storeSlug: 'bong', email: 'a@b.com',
  phone: '73007552', island: 'South Tarawa', village: 'Betio', status: 'active',
  isOpen: true, deliveryPickPay: true, logoUrl: 'https://res.cloudinary.com/demo/x.png'
};

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e || '']);

  async function open(ownerOverrides) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 900 } });
    let saved = null;
    await ctx.route('**/macros/s/**', (r) => {
      let body = {};
      try { body = r.request().postDataJSON() || {}; } catch (e) {}
      let a = body.action;
      try { if (!a) a = new URL(r.request().url()).searchParams.get('action') || ''; } catch (e) {}
      let res = { ok: true };
      if (a === 'getOwnerProfile') res = { ok: true, owner: Object.assign({}, OWNER, ownerOverrides) };
      else if (a === 'updateOwnerProfile') { saved = body; res = { ok: true, owner: Object.assign({}, OWNER, ownerOverrides) }; }
      else if (a === 'enable2FARequest') res = { ok: true, verifyToken: 'tok-2fa' };
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
    return { ctx, page, errors, saved: () => saved };
  }

  // 2FA on, no channel preference -> "emailed"
  {
    const { ctx, page, errors } = await open({ twoFAEnabled: true, authChannel: 'email', authChannelEffective: 'email' });
    const t = await page.textContent('#twofa-status');
    ok('2FA on, email channel: status says emailed', /emailed a code/.test(t), t);
    ok('no page errors', errors.length === 0, errors.join('; '));
    await ctx.close();
  }

  // 2FA on, vendor CHOSE sms but no sender exists -> must still say emailed.
  {
    const { ctx, page } = await open({ twoFAEnabled: true, authChannel: 'sms', authChannelEffective: 'email' });
    const t = await page.textContent('#twofa-status');
    ok('THE ONE THAT MATTERS: sms chosen but email actually used -> copy says emailed',
      /emailed a code/.test(t) && !/texted/.test(t), t);
    await ctx.close();
  }

  // The day a sender exists, the copy follows without another code change.
  {
    const { ctx, page } = await open({ twoFAEnabled: true, authChannel: 'sms', authChannelEffective: 'sms' });
    const t = await page.textContent('#twofa-status');
    ok('when SMS really is the channel, the copy says texted',
      /texted a code/.test(t) && !/emailed/.test(t), t);
    await ctx.close();
  }

  // The enable-2FA confirm hint follows the same rule.
  {
    const { ctx, page } = await open({ twoFAEnabled: false, authChannel: 'email', authChannelEffective: 'email' });
    await page.click('#twofa-enable-btn');
    await page.waitForSelector('#twofa-confirm-form:not(.hidden)', { timeout: 4000 });
    const hint = await page.textContent('#twofa-confirm-hint');
    ok('enable-2FA hint says emailed on the email channel', /We emailed you/.test(hint), hint);
    await ctx.close();
  }
  {
    const { ctx, page } = await open({ twoFAEnabled: false, authChannel: 'sms', authChannelEffective: 'sms' });
    await page.click('#twofa-enable-btn');
    await page.waitForSelector('#twofa-confirm-form:not(.hidden)', { timeout: 4000 });
    const hint = await page.textContent('#twofa-confirm-hint');
    ok('enable-2FA hint says texted on the sms channel', /We texted you/.test(hint), hint);
    await ctx.close();
  }

  // Nothing else on the page moved: an older backend sends no authChannel at
  // all, and the page must not break or invent a channel.
  {
    const { ctx, page, errors } = await open({ twoFAEnabled: true });
    const t = await page.textContent('#twofa-status');
    ok('a backend with no authChannel field degrades to "emailed"',
      /emailed a code/.test(t), t);
    ok('and throws nothing', errors.length === 0, errors.join('; '));
    const enableHidden = await page.evaluate(() =>
      document.getElementById('twofa-enable-btn').classList.contains('hidden'));
    ok('the 2FA enable/disable flow still renders', enableHidden === true, String(enableHidden));
    await ctx.close();
  }

  // Saving settings must not disturb the other contact fields.
  {
    const h = await open({ twoFAEnabled: false, authChannel: 'email', authChannelEffective: 'email' });
    await h.page.click('#save-settings-btn');
    await h.page.waitForTimeout(1200);
    const saved = h.saved();
    ok('saving still sends the existing contact fields',
      saved && saved.phone === '73007552' && saved.email === 'a@b.com', JSON.stringify(saved));
    ok('and does not invent an authChannel the vendor never chose',
      saved && saved.authChannel === undefined, JSON.stringify(saved && saved.authChannel));
    await h.ctx.close();
  }

  await browser.close();
  console.log('\n--- 2FA channel copy ---');
  let f = 0;
  for (const [s, n, e] of R) { if (s === 'FAIL') f++; console.log(`${s}  ${n}${e ? '  [' + e + ']' : ''}`); }
  console.log(`\n${R.length - f}/${R.length} passed`);
  process.exit(f ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
