/**
 * Owner request, Oct 2026, in the browser against the REAL backend
 * (gas-harness behind every API call):
 *  - Register Store asks for a required password hint; the login page shows
 *    it after a wrong password; Settings changes it; the Dashboard reminds
 *    older stores that have none;
 *  - a seller opening Messages from an email while logged out logs in and
 *    lands back on Messages (not the Dashboard);
 *  - a customer opening Messages from an email signs in first, and then sees
 *    their account's chats on this phone.
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const { makeBox } = require('./lib/gas-harness.js');
const BASE = process.env.TX_BASE || 'http://127.0.0.1:8099';
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e === undefined ? '' : e]);
const FUT = new Date(Date.now() + 9e8).toISOString();

const box = makeBox({
  Owners: [['OwnerId', 'StoreName', 'StoreSlug', 'Username', 'PasswordHash', 'PasswordSalt', 'Email', 'Phone', 'Messenger', 'Status', 'CreatedAt', 'StoreType', 'Island', 'Village', 'DeliveryPickPay', 'LogoUrl']],
  Sessions: [['Token', 'OwnerId', 'CreatedAt', 'ExpiresAt']],
  Customers: [['CustomerId', 'Name', 'Email', 'Phone', 'EmailVerified', 'CreatedAt', 'UpdatedAt'], ['cus_t', 'Tia', 'tia@x.test', '73000001', 'yes', '', ''], ['cus_b', 'Bong', 'bong@x.test', '73001234', 'true', '', '']],
  CustomerSessions: [['Token', 'CustomerId', 'CreatedAt', 'ExpiresAt'], ['c-tia', 'cus_t', '', FUT], ['c-bong', 'cus_b', '', FUT]],
  Conversations: [['ConversationId', 'OwnerId', 'StoreSlug', 'CustomerToken', 'CustomerName', 'Status', 'CreatedAt', 'UpdatedAt', 'LastMessageAt', 'LastMessagePreview', 'LastSenderType', 'UnreadByVendor', 'UnreadByCustomer', 'CustomerId']],
  Messages: [['MessageId', 'ConversationId', 'OwnerId', 'StoreSlug', 'SenderType', 'Body', 'CreatedAt', 'ImageUrl', 'ImageFileId']],
  // So the seller dashboard summary loads (its attention list carries the reminder).
  Orders: [['OrderId', 'OwnerId', 'StoreSlug', 'CustomerName', 'Total', 'Status', 'ItemsSummary', 'CreatedAt']],
  Products: [['ProductId', 'OwnerId', 'Name', 'Status']],
  Variants: [['VariantId', 'ProductId', 'OwnerId', 'Label', 'StockQty', 'ReservedQty', 'ReorderLevel', 'Status']],
  Bookings: [['BookingId', 'OwnerId', 'Status']]
});
box.__props.PEPPER = 'test-pepper';
box.ContentService = { createTextOutput: (s) => ({ s, setMimeType() { return this; } }), MimeType: { JSON: 'json' } };
const call = (b) => { try { return box.doPost({ postData: { contents: b } }).s; } catch (e) { return JSON.stringify({ ok: false, error: String(e.message || e) }); } };

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const errors = [];
  const ctxFor = async (init) => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
    await ctx.addInitScript((i) => { localStorage.setItem('skiri_cookie_consent', 'true'); Object.keys(i || {}).forEach((k) => localStorage.setItem(k, i[k])); }, init || {});
    await ctx.route('**/macros/s/**', (route) => {
      const b = route.request().postData();
      let body;
      if (b) body = call(b);
      else { const q = Object.fromEntries(new URL(route.request().url()).searchParams); try { body = box.doGet({ parameter: q }).s; } catch (e) { body = JSON.stringify({ ok: true }); } }
      route.fulfill({ status: 200, contentType: 'application/json', body });
    });
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(String(e)));
    p.on('dialog', (d) => d.accept());
    return { ctx, p };
  };

  /* ---------- Register Store: hint required ---------- */
  // A store is an application from a signed-in shopper account (Oct 2026).
  let { ctx, p } = await ctxFor({ skiri_customer_token: 'c-bong', skiri_customer_profile: JSON.stringify({ customerId: 'cus_b', name: 'Bong', email: 'bong@x.test', emailVerified: true }) });
  await p.goto(BASE + '/owner/login.html?tab=register', { waitUntil: 'load' });
  await p.click('#tab-register');
  ok('Register Store has a required "Password hint" field', await p.evaluate(() => { const i = document.getElementById('register-password-hint'); return !!i && i.required && /Password hint/.test(document.querySelector('label[for="register-password-hint"]').textContent); }));
  const fill = async (hint) => {
    await p.fill('#register-store-name', 'Bong Store'); await p.fill('#register-username', 'bong'); await p.fill('#register-password', 'coconut99');
    await p.fill('#register-password-hint', hint); await p.fill('#register-about', 'Rice and flour'); await p.fill('#register-phone', '73001234');
    await p.fill('#register-messenger', 'bong.store');
    await p.evaluate(() => { const f = document.getElementById('register-form'); f.noValidate = true; });
    await p.click('#register-submit-btn');
    await p.waitForTimeout(500);
  };
  await fill('my coconut99');
  ok('a hint that contains the password is stopped before sending', /must not contain the password/.test(await p.textContent('#register-error')), await p.textContent('#register-error'));
  await fill('favourite fruit');
  await p.waitForSelector('#register-sent:not([hidden])', { timeout: 8000 }).catch(() => {});
  ok('a good hint registers the store', box.__sheets.Owners.objects()[0] && box.__sheets.Owners.objects()[0].PasswordHint === 'favourite fruit', p.url());
  // An admin approves it (SellerApplications.gs) before the seller can log in.
  { const g = box.__sheets.Owners.grid; g[1][g[0].indexOf('ApprovalStatus')] = 'approved'; }
  await ctx.close();

  /* ---------- Login: hint after a wrong password ---------- */
  ({ ctx, p } = await ctxFor());
  await p.goto(BASE + '/owner/login.html', { waitUntil: 'load' });
  ok('no hint shown before trying', await p.locator('#login-password-hint').isHidden());
  await p.fill('#login-username', 'bong'); await p.fill('#login-password', 'wrong-one');
  await p.click('#login-submit-btn');
  await p.waitForSelector('#login-password-hint:not([hidden])', { timeout: 6000 }).catch(() => {});
  ok('after a wrong password the seller sees their hint', (await p.textContent('#login-password-hint')).trim() === 'Your password hint: favourite fruit', await p.textContent('#login-password-hint'));
  await ctx.close();

  /* ---------- Seller email link: log in, back to Messages ---------- */
  ({ ctx, p } = await ctxFor());
  await p.goto(BASE + '/owner/messages.html?from=email', { waitUntil: 'load' });
  await p.waitForURL(/login\.html/, { timeout: 8000 });
  ok('logged out, the email link goes to Log In (not Register), remembering Messages', /login\.html\?next=messages\.html$/.test(p.url()) && await p.locator('#login-form').isVisible(), p.url());
  await p.fill('#login-username', 'bong'); await p.fill('#login-password', 'coconut99');
  await p.click('#login-submit-btn');
  await p.waitForURL(/\/owner\/messages\.html/, { timeout: 8000 }).catch(() => {});
  ok('after logging in the seller lands on Messages', /\/owner\/messages\.html$/.test(p.url()), p.url());
  const sellerToken = await p.evaluate(() => localStorage.getItem('skiri_owner_token'));
  await p.goto(BASE + '/owner/messages.html?from=email', { waitUntil: 'load' });
  await p.waitForTimeout(800);
  ok('already logged in, the email link opens Messages directly', /\/owner\/messages\.html\?from=email$/.test(p.url()), p.url());

  /* ---------- Dashboard reminder + Settings ---------- */
  await p.goto(BASE + '/owner/dashboard.html', { waitUntil: 'load' });
  await p.waitForTimeout(1500);
  ok('a store with a hint gets no reminder', !/Add a password hint/.test(await p.textContent('#dash-alerts')));
  const grid = box.__sheets.Owners.grid; grid[1][grid[0].indexOf('PasswordHint')] = '';
  await p.goto(BASE + '/owner/dashboard.html', { waitUntil: 'load' });
  await p.waitForFunction(() => /Add a password hint/.test(document.getElementById('dash-alerts').textContent), null, { timeout: 8000 }).catch(() => {});
  ok('an older store without a hint is reminded on the Dashboard', /Add a password hint/.test(await p.textContent('#dash-alerts')),
    JSON.stringify(await p.evaluate(() => [Auth.getOwner() && Auth.getOwner().hasPasswordHint, document.getElementById('dash-alerts').textContent.slice(0, 120)])));
  ok('...linking to the password part of Settings', await p.evaluate(() => !!document.querySelector('#dash-alerts a[href="settings.html#password-form"]')));
  await p.goto(BASE + '/owner/settings.html', { waitUntil: 'load' });
  await p.waitForSelector('#password-hint', { timeout: 8000 });
  await p.fill('#password-hint', 'my first boat');
  ok('typing only a hint asks for the current password', await p.locator('#hint-current-password').isVisible());
  await p.fill('#hint-current-password', 'coconut99');
  await p.click('#password-form button[type="submit"]');
  await p.waitForTimeout(800);
  ok('the hint is saved', box.__sheets.Owners.objects()[0].PasswordHint === 'my first boat' && /hint updated/i.test(await p.textContent('#password-success')), await p.textContent('#password-error'));
  await ctx.close();

  /* ---------- Customer email link ---------- */
  // A chat Tia started on another phone while signed in.
  call(JSON.stringify({ action: 'sendMessage', storeSlug: 'bong-store', customerToken: 'other-phone-tok', customerName: 'Tia', body: 'Rice please', customerSession: 'c-tia' }));
  call(JSON.stringify({ action: 'sendMessage', token: sellerToken, conversationId: box.__sheets.Conversations.objects()[0].ConversationId, body: 'We have 20 bags' }));
  ({ ctx, p } = await ctxFor());
  await p.goto(BASE + '/customer-messages.html?from=email', { waitUntil: 'load' });
  await p.waitForURL(/customer-login\.html/, { timeout: 8000 }).catch(() => {});
  ok('not signed in, the customer email link asks them to sign in first, then Messages', /customer-login\.html\?next=customer-messages\.html$/.test(p.url()), p.url());
  await ctx.close();
  ({ ctx, p } = await ctxFor({ skiri_customer_token: 'c-tia', skiri_customer_profile: JSON.stringify({ name: 'Tia', email: 'tia@x.test' }) }));
  await p.goto(BASE + '/customer-messages.html?from=email', { waitUntil: 'load' });
  await p.waitForFunction(() => /Bong Store/.test(document.getElementById('messages-list').textContent), null, { timeout: 8000 }).catch(() => {});
  ok('signed in on a new phone: their chat with Bong Store shows', /Bong Store/.test(await p.textContent('#messages-list')),
    (await p.textContent('#messages-list')) + ' | ' + (await p.textContent('#messages-status')) + ' | ' + JSON.stringify(box.__sheets.Conversations.objects().map((c) => [c.StoreSlug, c.CustomerToken, c.CustomerId])) + JSON.stringify(box.actionClaimCustomerChats({ customerSession: 'c-tia' })));
  ok('...because this phone was given that chat', await p.evaluate(() => localStorage.getItem('skiri_chat_token_bong-store')) === 'other-phone-tok');
  await ctx.close();

  const chatJs = fs.readFileSync(path.join(__dirname, '..', 'assets/js/chat-window.js'), 'utf8');
  ok('the chat window sends the customer\'s sign-in with a message (links the chat)', /customerSession/.test(chatJs));

  ok('no page errors', errors.length === 0, errors.join(' | ').slice(0, 300));
  await browser.close();
  let fails = 0;
  console.log('\n--- password hints + message email links (real backend) ---');
  for (const [s, n, x] of R) { if (s === 'FAIL') fails++; console.log(`${s}  ${n}${x !== '' ? '  [' + x + ']' : ''}`); }
  console.log(`\n${R.length - fails}/${R.length} passed`);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
