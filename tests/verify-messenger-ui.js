// Messages revamp: the two-pane inbox UI shared by the shopper
// (customer-messages.html) and the seller (owner/messages.html). Checks the
// responsive layout (single column at phone width, two panes at tablet and
// desktop), the Unread/All filter, in-inbox search, avatars and the image
// thumbnail affordance, and that opening a conversation shows it in-page -
// all with no console/page errors, no sideways scroll and no CSP violations.
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = 'http://127.0.0.1:8099';
const NOW = Date.now();
const iso = (ms) => new Date(NOW - ms).toISOString();
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e || '']);

// phone (single column), tablet and desktop (both two-pane, breakpoint 768px).
const WIDTHS = [['phone', 390], ['tablet', 820], ['desktop', 1200]];

function customerBackend(r) {
  let b = {}; try { b = r.request().postDataJSON() || {}; } catch (e) {}
  const a = b.action;
  let out = { ok: true };
  if (a === 'getCustomerInbox') out = { ok: true, conversations: [
    { conversationId: 'c1', storeSlug: 'bong', storeName: 'Bong Store', storeLogoUrl: '', lastMessagePreview: 'Thanks, see you then!', lastMessageAt: iso(60000), lastSenderType: 'customer', unreadCount: 0 },
    { conversationId: 'c2', storeSlug: 'kv', storeName: 'KV Rentals', storeLogoUrl: '', lastMessagePreview: 'Photo', lastMessageAt: iso(3600000), lastSenderType: 'vendor', unreadCount: 3 },
  ] };
  else if (a === 'getConversation') out = { ok: true, conversation: { conversationId: 'c2' }, messages: [
    { messageId: 'm1', senderType: 'vendor', body: 'Hello there', createdAt: iso(4000000), imageUrl: '' },
    { messageId: 'm2', senderType: 'customer', body: 'Hi!', createdAt: iso(3500000), imageUrl: '' },
  ], hasMoreBefore: false, otherPartyTyping: false };
  else if (a === 'sendMessage') out = { ok: true, message: { messageId: 'm9', createdAt: new Date().toISOString() } };
  r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(out) });
}

function sellerBackend(r) {
  let b = {}; try { b = r.request().postDataJSON() || {}; } catch (e) {}
  const a = b.action;
  let out = { ok: true };
  if (a === 'getOwnerProfile') out = { ok: true, owner: { ownerId: 'o1', storeName: 'Bong Store', storeType: 'retailer' } };
  else if (a === 'getVendorConversations') out = { ok: true, total: 2, hasMore: false, conversations: [
    { conversationId: 'v1', storeSlug: 'bong', customerName: 'Alice Teannaki', status: 'open', lastMessageAt: iso(50000), lastMessagePreview: 'Is it available?', lastSenderType: 'customer', unreadByVendor: true, unreadByCustomer: false },
    { conversationId: 'v2', storeSlug: 'bong', customerName: 'Bob', status: 'open', lastMessageAt: iso(7200000), lastMessagePreview: 'Photo', lastSenderType: 'customer', unreadByVendor: false, unreadByCustomer: false },
  ] };
  else if (a === 'getConversation') out = { ok: true, conversation: { conversationId: 'v1' }, messages: [
    { messageId: 'm1', senderType: 'customer', body: 'Is it available?', createdAt: iso(60000), imageUrl: '' },
  ], hasMoreBefore: false, otherPartyTyping: false };
  r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(out) });
}

const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

function watchErrors(page) {
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  page.on('console', (m) => {
    const t = m.text();
    if (m.type() === 'error') errs.push('console:' + t);
    if (/Content Security Policy/i.test(t)) errs.push('csp:' + t);
  });
  return errs;
}

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

  /* ---------------- Shopper inbox ---------------- */
  for (const [label, w] of WIDTHS) {
    const ctx = await browser.newContext({ viewport: { width: w, height: 880 } });
    await ctx.route('**/macros/s/**', customerBackend);
    const page = await ctx.newPage();
    const errs = watchErrors(page);
    await page.addInitScript(() => {
      try {
        localStorage.setItem('skiri_cookie_consent', 'true');
        localStorage.setItem('skiri_chat_token_bong', 'tok-bong'); localStorage.setItem('skiri_chat_started_bong', '1');
        localStorage.setItem('skiri_chat_token_kv', 'tok-kv'); localStorage.setItem('skiri_chat_started_kv', '1');
        localStorage.setItem('skiri_customer_token', 'ct');
        localStorage.setItem('skiri_customer_profile', '{"customerId":"c1","name":"Tia","email":"a@b.com","emailVerified":true}');
      } catch (e) {}
    });
    await page.goto(BASE + '/customer-messages.html', { waitUntil: 'load' });
    await page.waitForSelector('.msgr-thread', { timeout: 6000 });

    const twoPane = w >= 768;
    ok(`shopper/${label}: two rows render`, (await page.$$('.msgr-thread')).length === 2);
    ok(`shopper/${label}: unread count badge is 3`, (await page.textContent('.msgr-thread[data-slug="kv"] .msgr-avatar-badge').catch(() => '')) === '3');
    ok(`shopper/${label}: image thumbnail affordance on a photo message`, !!(await page.$('.msgr-thread[data-slug="kv"] .msgr-thread-photo')));
    ok(`shopper/${label}: initial-circle avatar when no logo`, !!(await page.$('.msgr-thread[data-slug="bong"] .msgr-avatar-initials')));
    ok(`shopper/${label}: no horizontal scroll`, await noHScroll(page));
    ok(`shopper/${label}: ${twoPane ? 'two-pane (empty pane shown)' : 'single column (no empty pane)'}`,
      (await page.isVisible('#cmsg-empty')) === twoPane);

    await page.click('#cmsg-filter-unread');
    ok(`shopper/${label}: Unread filter narrows to unread only`,
      JSON.stringify(await page.$$eval('.msgr-thread', (e) => e.map((x) => x.dataset.slug))) === '["kv"]');
    await page.click('#cmsg-filter-all');
    await page.fill('#cmsg-search', 'rentals');
    ok(`shopper/${label}: search matches the other party's name`,
      JSON.stringify(await page.$$eval('.msgr-thread', (e) => e.map((x) => x.dataset.slug))) === '["kv"]');
    await page.fill('#cmsg-search', 'thanks');
    ok(`shopper/${label}: search matches message text`,
      JSON.stringify(await page.$$eval('.msgr-thread', (e) => e.map((x) => x.dataset.slug))) === '["bong"]');
    await page.fill('#cmsg-search', '');

    await page.click('.msgr-thread[data-slug="kv"]');
    await page.waitForSelector('#cmsg-messages .chat-message', { timeout: 5000 });
    ok(`shopper/${label}: opening shows the conversation in-page`,
      (await page.$$('#cmsg-messages .chat-message')).length === 2 &&
      await page.evaluate(() => document.getElementById('cmsg-layout').classList.contains('has-open')));
    if (!twoPane) {
      ok(`shopper/${label}: phone hides the list behind the open conversation`, !(await page.isVisible('.msgr-list')));
      await page.click('#cmsg-back');
      ok(`shopper/${label}: back arrow returns to the list`, await page.isVisible('.msgr-list'));
    } else {
      ok(`shopper/${label}: list and conversation sit side by side`,
        (await page.isVisible('.msgr-list')) && (await page.isVisible('#cmsg-detail')));
    }
    ok(`shopper/${label}: no horizontal scroll with a conversation open`, await noHScroll(page));
    ok(`shopper/${label}: no console/page errors or CSP violations`, errs.length === 0, errs.join(' | '));
    await ctx.close();
  }

  /* ---------------- Seller inbox ---------------- */
  for (const [label, w] of WIDTHS) {
    const ctx = await browser.newContext({ viewport: { width: w, height: 880 } });
    await ctx.route('**/macros/s/**', sellerBackend);
    const page = await ctx.newPage();
    const errs = watchErrors(page);
    await page.addInitScript(() => {
      try {
        localStorage.setItem('skiri_cookie_consent', 'true');
        localStorage.setItem('skiri_owner_token', 'otok');
        localStorage.setItem('skiri_owner_profile', '{"ownerId":"o1","storeName":"Bong Store","storeType":"retailer"}');
      } catch (e) {}
    });
    await page.goto(BASE + '/owner/messages.html', { waitUntil: 'load' });
    await page.waitForSelector('.msgr-thread', { timeout: 6000 });

    const twoPane = w >= 768;
    ok(`seller/${label}: two rows render`, (await page.$$('.msgr-thread')).length === 2);
    ok(`seller/${label}: unread row carries an avatar badge`, !!(await page.$('.msgr-thread[data-conversation-id="v1"] .msgr-avatar-badge')));
    ok(`seller/${label}: image thumbnail affordance on a photo message`, !!(await page.$('.msgr-thread[data-conversation-id="v2"] .msgr-thread-photo')));
    ok(`seller/${label}: initial-circle avatar for the customer`, !!(await page.$('.msgr-thread[data-conversation-id="v1"] .msgr-avatar-initials')));
    ok(`seller/${label}: no horizontal scroll`, await noHScroll(page));
    ok(`seller/${label}: ${twoPane ? 'two-pane (empty pane shown)' : 'single column (no empty pane)'}`,
      (await page.isVisible('#conversation-empty-state')) === twoPane);

    await page.click('#msg-filter-unread');
    ok(`seller/${label}: Unread filter narrows to unread only`,
      JSON.stringify(await page.$$eval('.msgr-thread', (e) => e.map((x) => x.dataset.conversationId))) === '["v1"]');
    await page.click('#msg-filter-all');
    await page.fill('#conversation-search', 'alice');
    ok(`seller/${label}: search matches the customer's name`,
      JSON.stringify(await page.$$eval('.msgr-thread', (e) => e.map((x) => x.dataset.conversationId))) === '["v1"]');
    await page.fill('#conversation-search', 'available');
    ok(`seller/${label}: search matches message text`,
      JSON.stringify(await page.$$eval('.msgr-thread', (e) => e.map((x) => x.dataset.conversationId))) === '["v1"]');
    await page.fill('#conversation-search', '');

    await page.click('.msgr-thread[data-conversation-id="v1"]');
    await page.waitForSelector('#conversation-messages .chat-message', { timeout: 5000 });
    ok(`seller/${label}: opening shows the conversation in-page`,
      (await page.$$('#conversation-messages .chat-message')).length === 1 &&
      await page.evaluate(() => document.getElementById('messages-layout').classList.contains('has-open')));
    ok(`seller/${label}: the detail header shows an avatar`, (await page.textContent('#detail-avatar').catch(() => '')) !== '');
    if (!twoPane) {
      await page.click('#back-to-list-btn');
      ok(`seller/${label}: back arrow returns to the list`, await page.isVisible('.msgr-list'));
    } else {
      ok(`seller/${label}: list and conversation sit side by side`,
        (await page.isVisible('.msgr-list')) && (await page.isVisible('#conversation-detail')));
    }
    ok(`seller/${label}: no horizontal scroll with a conversation open`, await noHScroll(page));
    ok(`seller/${label}: no console/page errors or CSP violations`, errs.length === 0, errs.join(' | '));
    await ctx.close();
  }

  await browser.close();
  let failed = 0;
  console.log('\n--- Messages revamp: two-pane inbox UI ---');
  for (const [s, n, e] of R) { if (s === 'FAIL') failed++; console.log(`${s}  ${n}${e ? '  [' + e + ']' : ''}`); }
  console.log(`\n${R.length - failed}/${R.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
