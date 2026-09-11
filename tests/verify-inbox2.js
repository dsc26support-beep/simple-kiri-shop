// Messages inbox in the Alibaba shape, and a real unread count on the nav tab.
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = 'http://127.0.0.1:8099';
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e || '']);

const CONVS = [
  { conversationId: 'c1', storeSlug: 'bong', storeName: 'Bong Restaurant',
    storeLogoUrl: 'https://res.cloudinary.com/demo/image/upload/sample.jpg',
    lastMessagePreview: 'Yes we still have the fried rice available today, come anytime before six',
    lastMessageAt: new Date(Date.now() - 2 * 86400000).toISOString(), lastSenderType: 'vendor', unreadCount: 17 },
  { conversationId: 'c2', storeSlug: 'teaube', storeName: 'Teaube Store', storeLogoUrl: '',
    lastMessagePreview: 'Thanks!', lastMessageAt: new Date(Date.now() - 20 * 86400000).toISOString(),
    lastSenderType: 'customer', unreadCount: 0 },
  { conversationId: 'c3', storeSlug: 'burabonita', storeName: 'Burabonita', storeLogoUrl: '',
    lastMessagePreview: 'New stock in', lastMessageAt: new Date(Date.now() - 3 * 86400000).toISOString(),
    lastSenderType: 'vendor', unreadCount: 120 }
];

let lastInboxPost = null;

async function open(browser, path, conversations, seed) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 800 } });
  await ctx.route('**/macros/s/**', async (r) => {
    let action = '';
    try { action = new URL(r.request().url()).searchParams.get('action') || ''; } catch (e) {}
    try { const j = r.request().postDataJSON(); if (j) { action = action || j.action; if (j.stores) lastInboxPost = j; } } catch (e) {}
    const J = (o) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
    if (action === 'getCustomerInbox' || (lastInboxPost && !action)) return J({ ok: true, conversations });
    return J({ ok: true, products: [], stores: [], tips: [], conversations });
  });
  const page = await ctx.newPage();
  // addInitScript runs on EVERY navigation in this context, so an unguarded
  // seed would re-write these keys after a click navigated away - silently
  // undoing the very write the click was supposed to make. Seed once.
  await page.addInitScript((s) => {
    localStorage.setItem('skiri_cookie_consent', 'true');
    if (localStorage.getItem('__seeded')) return;
    localStorage.setItem('__seeded', '1');
    for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v);
  }, seed || {});
  await page.goto(BASE + '/' + path, { waitUntil: 'load' });
  await page.waitForTimeout(900);
  return { ctx, page };
}

const SEED = {
  'skiri_chat_token_bong': 'tok-a',
  'skiri_chat_token_teaube': 'tok-b',
  'skiri_chat_token_burabonita': 'tok-c',
  'skiri_inbox_seen_bong': '2026-09-01T00:00:00Z'
};

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

  // ---------- the inbox page ----------
  {
    lastInboxPost = null;
    const { ctx, page } = await open(browser, 'customer-messages.html', CONVS, SEED);
    await page.waitForSelector('.inbox-thread');

    ok('this device\'s read-marks are sent to the backend',
      !!lastInboxPost && lastInboxPost.stores.some((s) => s.storeSlug === 'bong' && s.seenAt === '2026-09-01T00:00:00Z'),
      JSON.stringify(lastInboxPost && lastInboxPost.stores));
    ok('a never-opened thread sends an empty seenAt, not a missing key',
      !!lastInboxPost && lastInboxPost.stores.every((s) => 'seenAt' in s),
      JSON.stringify(lastInboxPost && lastInboxPost.stores));

    const rows = await page.evaluate(() => [...document.querySelectorAll('.inbox-thread')].map((t) => {
      const badge = t.querySelector('.inbox-unread-badge');
      const img = t.querySelector('.inbox-avatar-img');
      const ini = t.querySelector('.inbox-avatar-initials');
      const name = t.querySelector('.inbox-thread-name');
      const prev = t.querySelector('.inbox-thread-preview');
      const date = t.querySelector('.inbox-thread-date');
      const r = t.getBoundingClientRect();
      const av = t.querySelector('.inbox-avatar').getBoundingClientRect();
      const bb = badge ? badge.getBoundingClientRect() : null;
      return {
        slug: t.dataset.slug,
        badge: badge ? badge.textContent : null,
        hasImg: !!img, hasInitials: !!ini, initials: ini ? ini.textContent : '',
        name: name ? name.textContent.replace(/\d+ unread messages?/, '').trim() : null,
        prevText: prev ? prev.textContent : '',
        prevW: prev ? Math.round(prev.getBoundingClientRect().width) : 0,
        prevScrollW: prev ? prev.scrollWidth : 0,
        date: date ? date.textContent : '',
        rowW: Math.round(r.width), rowH: Math.round(r.height),
        avatarW: Math.round(av.width), avatarH: Math.round(av.height),
        // Badge must overlap the avatar's top-left corner, not float beside it.
        badgeOnAvatar: bb ? (bb.left < av.left + av.width / 2 && bb.top < av.top + av.height / 2) : null,
        srUnread: t.textContent.indexOf('unread') !== -1
      };
    }));

    ok('one row per conversation', rows.length === 3, String(rows.length));
    ok('unread count shown as a number', rows[0].badge === '17', rows[0].badge);
    ok('a read thread has no badge at all', rows[1].badge === null, JSON.stringify(rows[1].badge));
    ok('counts over 99 are capped', rows[2].badge === '99+', rows[2].badge);
    ok('badge sits on the avatar\'s corner', rows.filter((r) => r.badge).every((r) => r.badgeOnAvatar),
      JSON.stringify(rows.map((r) => r.badgeOnAvatar)));
    ok('unread count is announced to screen readers', rows[0].srUnread);

    ok('store logo used when there is one', rows[0].hasImg && !rows[0].hasInitials, JSON.stringify(rows[0]));
    ok('initials stand in when there is no logo', rows[1].hasInitials && !rows[1].hasImg, JSON.stringify(rows[1]));
    ok('initials come from the store name', rows[1].initials.toUpperCase().indexOf('T') === 0, rows[1].initials);
    ok('logo and initials are the same size, so the row cannot jump',
      rows.every((r) => r.avatarW === rows[0].avatarW && r.avatarH === rows[0].avatarH),
      JSON.stringify(rows.map((r) => [r.avatarW, r.avatarH])));

    ok('store name on the first line', rows[0].name === 'Bong Restaurant', rows[0].name);
    ok('last message on the second line', /fried rice/.test(rows[0].prevText), rows[0].prevText.slice(0, 40));
    ok('a long message is truncated, not wrapped past the row',
      rows[0].prevScrollW > rows[0].prevW && rows[0].prevW < rows[0].rowW,
      JSON.stringify({ w: rows[0].prevW, scroll: rows[0].prevScrollW, row: rows[0].rowW }));
    ok('the date sits on the row', rows[0].date.length > 0, rows[0].date);
    ok('rows stay one row tall on a 390px phone', rows.every((r) => r.rowH <= 96),
      JSON.stringify(rows.map((r) => r.rowH)));
    ok('nothing overflows the viewport',
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));

    // Opening a thread marks it seen, which is what the next count is measured from.
    await page.click('.inbox-thread[data-slug="bong"]');
    await page.waitForTimeout(600);
    const seen = await page.evaluate(() => localStorage.getItem('skiri_inbox_seen_bong'));
    ok('opening a thread advances this device\'s read-mark', seen === CONVS[0].lastMessageAt, `${seen}`);
    ok('and lands in that store\'s chat', /store\.html\?store=bong&chat=open/.test(page.url()), page.url());
    await ctx.close();
  }

  // ---------- the nav tab badge ----------
  {
    const { ctx, page } = await open(browser, 'index.html', CONVS, SEED);
    const nav = await page.evaluate(() => {
      const b = document.querySelector('.bottom-nav-badge[data-badge="messages"]');
      return b ? { text: b.textContent, hidden: b.hidden, label: b.getAttribute('aria-label'), dot: b.classList.contains('is-dot') } : null;
    });
    ok('Messages tab shows the total across every store', nav && nav.text === '99+', JSON.stringify(nav));
    ok('badge is visible', nav && nav.hidden === false, JSON.stringify(nav));
    ok('count is announced, not just drawn', nav && /unread/.test(nav.label || ''), JSON.stringify(nav));
    ok('the old bare dot is gone', nav && nav.dot === false, JSON.stringify(nav));
    await ctx.close();
  }

  // Smaller total, to prove it is a sum and not the cap every time.
  {
    const two = [Object.assign({}, CONVS[0], { unreadCount: 2 }), Object.assign({}, CONVS[2], { unreadCount: 3 })];
    const { ctx, page } = await open(browser, 'index.html', two, SEED);
    const text = await page.evaluate(() => {
      const b = document.querySelector('.bottom-nav-badge[data-badge="messages"]');
      return b ? b.textContent : null;
    });
    ok('the tab sums the stores (2 + 3 = 5)', text === '5', String(text));
    await ctx.close();
  }

  // Nothing unread -> no badge anywhere.
  {
    const read = CONVS.map((c) => Object.assign({}, c, { unreadCount: 0 }));
    const { ctx, page } = await open(browser, 'index.html', read, SEED);
    const hidden = await page.evaluate(() => {
      const b = document.querySelector('.bottom-nav-badge[data-badge="messages"]');
      return !b || b.hidden;
    });
    ok('no badge when everything is read', hidden);
    await ctx.close();
  }

  // A backend that has not been redeployed sends no unreadCount.
  {
    const legacy = CONVS.map((c) => { const x = Object.assign({}, c); delete x.unreadCount; return x; });
    const { ctx, page } = await open(browser, 'customer-messages.html', legacy, SEED);
    await page.waitForSelector('.inbox-thread');
    const badges = await page.evaluate(() =>
      [...document.querySelectorAll('.inbox-thread')].map((t) => {
        const b = t.querySelector('.inbox-unread-badge');
        return b ? b.textContent : null;
      }));
    ok('old backend falls back to 1-per-unread-thread, never a wrong number',
      badges[0] === '1' && badges[1] === null, JSON.stringify(badges));
    await ctx.close();
  }

  await browser.close();

  let f = 0;
  console.log('\n--- Messages inbox + nav unread count ---');
  for (const [st, n, e] of R) { if (st === 'FAIL') f++; console.log(`${st}  ${n}${e ? '  [' + e + ']' : ''}`); }
  console.log(`\n${R.length - f}/${R.length} passed`);
  process.exit(f ? 1 : 0);
})();
