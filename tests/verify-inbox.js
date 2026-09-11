const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = 'http://127.0.0.1:8099';
const results = [];
const ok = (n, c, e) => results.push([c ? 'PASS' : 'FAIL', n, e || '']);

const NOW = Date.now();
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

  // Inbox with two threads
  {
    const ctx = await browser.newContext({ viewport: { width: 500, height: 900 } });
    const posted = [];
    await ctx.route('**/macros/s/**', (r) => {
      let action = '', body = {};
      try { body = r.request().postDataJSON() || {}; action = body.action; } catch (e) {}
      if (action) posted.push({ action, body });
      let out = { ok: true };
      if (action === 'getCustomerInbox') out = { ok: true, conversations: [
        { storeSlug: 'bong', storeName: 'Bong', lastMessagePreview: 'Thanks!', lastMessageAt: new Date(NOW - 60000).toISOString(), lastSenderType: 'customer' },
        { storeSlug: 'kv', storeName: 'KV Rentals', lastMessagePreview: 'See you then', lastMessageAt: new Date(NOW - 3600000).toISOString(), lastSenderType: 'vendor' },
      ] };
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(out) });
    });
    const page = await ctx.newPage();
    await page.addInitScript(() => {
      try {
        localStorage.setItem('skiri_chat_token_bong', 'tok-bong');
        localStorage.setItem('skiri_chat_token_kv', 'tok-kv');
      } catch (e) {}
    });
    await page.goto(BASE + '/customer-messages.html', { waitUntil: 'load' });
    await page.waitForSelector('.inbox-thread');

    const st = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('.inbox-thread')];
      return {
        count: rows.length,
        order: rows.map(r => r.dataset.slug),
        // The unread dot became a count badge on the avatar. These fixtures
        // send no unreadCount, so this is also the fallback path in situ:
        // a device talking to a backend that has not been redeployed.
        firstUnread: !!rows[0].querySelector('.inbox-unread-badge'),
        secondUnread: !!rows[1].querySelector('.inbox-unread-badge'),
        secondBadgeText: (rows[1].querySelector('.inbox-unread-badge') || {}).textContent,
        sentStores: null,
      };
    });
    // sent stores list included both tokens
    const inboxCall = posted.find(p => p.action === 'getCustomerInbox');
    const slugsSent = (inboxCall.body.stores || []).map(s => s.storeSlug).sort();
    ok('inbox posts device chat tokens', JSON.stringify(slugsSent) === JSON.stringify(['bong', 'kv']), JSON.stringify(slugsSent));
    ok('renders 2 threads sorted newest-first', st.count === 2 && st.order[0] === 'bong' && st.order[1] === 'kv', JSON.stringify(st.order));
    // bong is customer-last -> not unread; kv is vendor-last, no seen -> unread
    ok('customer-last thread has no unread badge', st.firstUnread === false);
    ok('vendor-last thread shows an unread badge (no seen)', st.secondUnread === true);
    ok('fallback badge is 1, never an invented number', st.secondBadgeText === '1', st.secondBadgeText);

    // click kv -> sets seen + navigates with chat=open
    await page.click('.inbox-thread[data-slug="kv"]');
    await page.waitForURL('**/store.html?store=kv&chat=open', { timeout: 4000 }).catch(() => {});
    ok('click navigates to store chat deep-link', /store\.html\?store=kv&chat=open/.test(page.url()), page.url());
    await ctx.close();
  }

  // unread clears when seen >= lastMessageAt
  {
    const ctx = await browser.newContext();
    await ctx.route('**/macros/s/**', (r) => {
      let action = ''; try { action = (r.request().postDataJSON() || {}).action; } catch (e) {}
      let out = { ok: true };
      if (action === 'getCustomerInbox') out = { ok: true, conversations: [
        { storeSlug: 'kv', storeName: 'KV', lastMessagePreview: 'hi', lastMessageAt: new Date(NOW - 3600000).toISOString(), lastSenderType: 'vendor' },
      ] };
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(out) });
    });
    const page = await ctx.newPage();
    await page.addInitScript((now) => {
      try {
        localStorage.setItem('skiri_chat_token_kv', 'tok-kv');
        localStorage.setItem('skiri_inbox_seen_kv', new Date(now).toISOString()); // seen just now (>= lastMessageAt)
      } catch (e) {}
    }, NOW);
    await page.goto(BASE + '/customer-messages.html', { waitUntil: 'load' });
    await page.waitForSelector('.inbox-thread');
    const unread = await page.evaluate(() => !!document.querySelector('.inbox-unread-badge'));
    ok('seen timestamp clears the unread badge', unread === false);
    await ctx.close();
  }

  // empty + error
  {
    const ctx = await browser.newContext();
    await ctx.route('**/macros/s/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, conversations: [] }) }));
    const page = await ctx.newPage(); // no chat tokens seeded
    await page.goto(BASE + '/customer-messages.html', { waitUntil: 'load' });
    await page.waitForFunction(() => document.getElementById('messages-status').textContent.length > 0);
    ok('no chat tokens -> "No messages yet."', /No messages yet/.test(await page.textContent('#messages-status')));
    await ctx.close();
  }
  {
    const ctx = await browser.newContext();
    await ctx.route('**/macros/s/**', (r) => {
      let action = ''; try { action = (r.request().postDataJSON() || {}).action; } catch (e) {}
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(action === 'getCustomerInbox' ? { ok: false, error: 'boom' } : { ok: true }) });
    });
    const page = await ctx.newPage();
    await page.addInitScript(() => { try { localStorage.setItem('skiri_chat_token_kv', 'tok-kv'); } catch (e) {} });
    await page.goto(BASE + '/customer-messages.html', { waitUntil: 'load' });
    await page.waitForFunction(() => /refresh|Refresh/.test(document.getElementById('messages-status').textContent));
    ok('inbox error shows refresh state', /refresh|Refresh/.test(await page.textContent('#messages-status')));
    await ctx.close();
  }

  // chat auto-open on ?chat=open
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 800 } });
    await ctx.route('**/macros/s/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, storeName: 'Bong', products: [], store: { storeName: 'Bong' } }) }));
    const page = await ctx.newPage();
    await page.goto(BASE + '/store.html?store=bong&chat=open', { waitUntil: 'load' });
    await page.waitForFunction(() => { const w = document.getElementById('chat-window'); return w && w.classList.contains('chat-window--open'); }, null, { timeout: 4000 }).catch(() => {});
    const open = await page.evaluate(() => document.getElementById('chat-window').classList.contains('chat-window--open'));
    ok('?chat=open auto-opens the chat window', open === true);
    await ctx.close();
  }

  await browser.close();
  let failed = 0;
  console.log('\n--- Phase 3b: customer Messages inbox ---');
  for (const [s, n, e] of results) { if (s === 'FAIL') failed++; console.log(`${s}  ${n}${e ? '  [' + e + ']' : ''}`); }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
