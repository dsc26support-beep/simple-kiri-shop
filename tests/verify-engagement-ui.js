/**
 * CESN Stage 2 UI, driven against the REAL apps-script backend (gas-harness).
 * Store page Follow/Like/offers, the customer dashboard Favourite Stores +
 * Notification Centre, and the seller engagement panel - plus the graceful
 * pre-deploy degrade (an older backend leaves everything hidden).
 */
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const { makeBox, TEST_SHOPPER_TOKEN } = require('./lib/gas-harness.js');
const BASE = process.env.TX_BASE || 'http://127.0.0.1:8099';
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e === undefined ? '' : JSON.stringify(e).slice(0, 300)]);
const FUT = new Date(Date.now() + 30 * 86400000).toISOString();
const IMG = 'https://res.cloudinary.com/demo/image/upload/';

function build(seed) {
  seed = seed || {};
  const box = makeBox({
    Owners: [['OwnerId', 'StoreSlug', 'StoreName', 'Email', 'Phone', 'Status', 'Island', 'Village', 'StoreType', 'LogoUrl'],
      ['own_s', 'bong', 'Bong Store', 's@x.test', '73001111', 'active', 'South Tarawa', 'Bairiki', 'retailer', IMG + 'logo.png']],
    Sessions: [['Token', 'OwnerId', 'CreatedAt', 'ExpiresAt'], ['tok-s', 'own_s', '', FUT]],
    Products: [['ProductId', 'OwnerId', 'StoreSlug', 'Name', 'Description', 'Category', 'ListingType', 'ImageUrl', 'Status', 'SortOrder', 'CreatedAt', 'UpdatedAt'],
      ['p1', 'own_s', 'bong', 'Rice', '10kg', 'home', 'product', IMG + 'rice.jpg', 'active', 0, '', '']],
    Variants: [['VariantId', 'ProductId', 'OwnerId', 'Label', 'Price', 'SKU', 'StockQty', 'Status'],
      ['v1', 'p1', 'own_s', '10kg', 20, '', 50, 'active']],
    Orders: [['OrderId', 'OwnerId', 'StoreSlug', 'ItemsJson', 'Status', 'CreatedAt']].concat(seed.Orders || []),
    Conversations: [['ConversationId', 'OwnerId', 'CustomerId', 'Status', 'UpdatedAt']],
    Messages: [['MessageId', 'ConversationId', 'Sender', 'Body', 'ReadAt', 'CreatedAt']],
    StoreFollows: [['FollowId', 'CustomerId', 'StoreSlug', 'Status', 'NotifyOn', 'CreatedAt', 'UpdatedAt']].concat(seed.StoreFollows || []),
    StoreLikes: [['LikeId', 'CustomerId', 'StoreSlug', 'Status', 'NotifyOn', 'CreatedAt', 'UpdatedAt']].concat(seed.StoreLikes || []),
    StoreMarketingConsents: [['ConsentId', 'CustomerId', 'StoreSlug', 'Status', 'OptInAt', 'WithdrawnAt', 'CreatedAt', 'UpdatedAt']].concat(seed.StoreMarketingConsents || []),
    Notifications: [['NotificationId', 'CustomerId', 'StoreSlug', 'Category', 'Title', 'Body', 'ImageUrl', 'DeepLink', 'CampaignId', 'SourceKey', 'ReadAt', 'CreatedAt']].concat(seed.Notifications || []),
    PushSubscriptions: [['SubId', 'CustomerId', 'FcmToken', 'UserAgent', 'Platform', 'Status', 'LastSeenAt', 'CreatedAt']],
    ProductWatch: [['WatchId', 'ProductId', 'VariantId', 'StoreSlug', 'PriceType', 'LastPrice', 'PriceSince', 'LastStock', 'LastNotifiedPrice', 'FirstSeenAt', 'UpdatedAt']],
    CesnAudit: [['EventId', 'StoreSlug', 'Category', 'SourceKey', 'Audience', 'Queued', 'SkippedFreq', 'SkippedDup', 'CreatedAt']],
    EngagementCampaigns: [['CampaignId', 'OwnerId', 'StoreSlug', 'Category', 'Title', 'Body', 'DeepLink', 'ImageUrl', 'Status', 'ScheduleAt', 'CreatedAt', 'UpdatedAt', 'CreatedBy', 'Audience', 'Queued', 'SkippedFreq', 'SkippedDup', 'SentAt']].concat(seed.EngagementCampaigns || [])
  }, {});   // non-guest: a default shopper (cus_harness / TEST_SHOPPER_TOKEN) is signed in
  box.ContentService = { createTextOutput: (s) => ({ s, setMimeType() { return this; } }), MimeType: { JSON: 'json' } };
  return box;
}

const clearCache = (box) => Object.keys(box.__cache || {}).forEach((k) => delete box.__cache[k]);
const call = (box, b) => { clearCache(box); try { return box.doPost({ postData: { contents: b } }).s; } catch (e) { return JSON.stringify({ ok: false, error: String(e.message || e) }); } };
const callGet = (box, url) => { clearCache(box); const u = new URL(url); const p = {}; u.searchParams.forEach((v, k) => { p[k] = v; }); try { return box.doGet({ parameter: p }).s; } catch (e) { return JSON.stringify({ ok: false, error: String(e.message || e) }); } };

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const errors = [];

  // opts.block: a set of actions to answer with {ok:false} (simulates an older
  // backend). opts.owner / opts.customer: which token to put in localStorage.
  const open = async (box, page, opts) => {
    opts = opts || {};
    const ctx = await browser.newContext({ viewport: { width: opts.w || 390, height: 900 }, serviceWorkers: 'block' });
    await ctx.addInitScript((o) => {
      localStorage.setItem('skiri_cookie_consent', 'true');
      if (o.customer) localStorage.setItem('skiri_customer_token', o.customer);
      if (o.owner) { localStorage.setItem('skiri_owner_token', 'tok-s'); localStorage.setItem('skiri_owner_profile', JSON.stringify({ ownerId: 'own_s', storeName: 'Bong Store', storeSlug: 'bong' })); }
    }, { customer: opts.customer || '', owner: opts.owner || false });
    await ctx.route('**/macros/s/**', (route) => {
      const req = route.request(); const b = req.postData();
      if (b && opts.block) { try { const j = JSON.parse(b); if (opts.block.indexOf(j.action) !== -1) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'Unknown action: ' + j.action }) }); } catch (e) {} }
      route.fulfill({ status: 200, contentType: 'application/json', body: b ? call(box, b) : callGet(box, req.url()) });
    });
    await ctx.route('https://res.cloudinary.com/**', (route) => route.fulfill({ status: 200, contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="#6a61b8"/></svg>' }));
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(page + ' ' + String(e)));
    await p.goto(BASE + '/' + page, { waitUntil: 'load' });
    await p.waitForTimeout(500);
    return { ctx, p };
  };

  /* ---- A. Store page: follow / like / offers, signed in, real backend ---- */
  {
    const box = build();
    const { ctx, p } = await open(box, 'store.html?store=bong', { customer: TEST_SHOPPER_TOKEN });
    await p.waitForTimeout(400);
    const engState = () => p.evaluate(() => {
      const row = document.getElementById('sp-engage');
      const fb = document.getElementById('sp-follow'), lb = document.getElementById('sp-like');
      return {
        rowShown: row && !row.hidden,
        twoButtons: !!fb && !!lb && fb !== lb,
        followPressed: fb && fb.getAttribute('aria-pressed') === 'true',
        followLabel: document.getElementById('sp-follow-label').textContent,
        likePressed: lb && lb.getAttribute('aria-pressed') === 'true',
        likeCount: document.getElementById('sp-like-count').textContent,
        meta: document.getElementById('sp-follow-count').textContent,
        offersShown: !document.getElementById('sp-offers').hidden,
        offersChecked: document.getElementById('sp-offers-box').checked
      };
    });
    let s = await engState();
    ok('store: engagement row shows with two distinct buttons', s.rowShown && s.twoButtons, s);
    ok('store: starts not-following / not-liked, 0 followers', !s.followPressed && !s.likePressed && /0 followers/.test(s.meta) && s.likeCount === '0', s);
    ok('store: offers opt-in shown to a signed-in shopper, unchecked', s.offersShown && !s.offersChecked, s);

    await p.click('#sp-follow'); await p.waitForTimeout(300);
    s = await engState();
    ok('store: Follow -> pressed, label "Following", 1 follower', s.followPressed && s.followLabel === 'Following' && /1 follower/.test(s.meta), s);
    ok('store: following did NOT also set Like', !s.likePressed, s);

    await p.click('#sp-like'); await p.waitForTimeout(300);
    s = await engState();
    ok('store: Like -> pressed, count 1, still following', s.likePressed && s.likeCount === '1' && s.followPressed, s);

    await p.click('#sp-offers-box'); await p.waitForTimeout(300);
    s = await engState();
    ok('store: offers opt-in persists (checked after save)', s.offersChecked, s);
    // confirm it really hit the backend
    const consent = JSON.parse(call(box, JSON.stringify({ action: 'getStoreEngagement', storeSlug: 'bong', token: TEST_SHOPPER_TOKEN })));
    ok('store: backend recorded follow + like + consent', consent.following === true && consent.liked === true && consent.consent === true, consent);

    await p.click('#sp-follow'); await p.waitForTimeout(300);
    s = await engState();
    ok('store: Unfollow -> not pressed, 0 followers', !s.followPressed && /0 followers/.test(s.meta), s);
    await ctx.close();
  }

  /* ---- B. Store page: graceful degrade when the backend lacks the action ---- */
  {
    const box = build();
    const { ctx, p } = await open(box, 'store.html?store=bong', { customer: TEST_SHOPPER_TOKEN, block: ['getStoreEngagement'] });
    await p.waitForTimeout(400);
    const hidden = await p.evaluate(() => document.getElementById('sp-engage').hidden);
    const storeOk = await p.evaluate(() => !!document.getElementById('product-list') && document.querySelectorAll('#product-list .product-card, #product-list li, #product-list article').length >= 0);
    ok('store: older backend -> engagement row stays hidden (page still works)', hidden === true && storeOk, { hidden });
    await ctx.close();
  }

  /* ---- C. Customer dashboard: Favourite Stores + Notification Centre ---- */
  {
    const box = build({
      StoreFollows: [['flw1', 'cus_harness', 'bong', 'active', 'true', FUT, FUT]],
      Notifications: [['ntf1', 'cus_harness', 'bong', 'store_follow', 'You’re following Bong Store', 'New arrivals will show here.', '', 'store.html?store=bong', '', '', '', FUT]]
    });
    const { ctx, p } = await open(box, 'customer-dashboard.html', { customer: TEST_SHOPPER_TOKEN });
    await p.waitForTimeout(700);
    const d = await p.evaluate(() => ({
      favShown: !document.getElementById('fav-stores').hidden,
      favItems: document.querySelectorAll('#fav-list .fav-item').length,
      favName: (document.querySelector('#fav-list .fav-name') || {}).textContent,
      notifShown: !document.getElementById('notif-centre').hidden,
      notifItems: document.querySelectorAll('#notif-list .notif-item').length,
      unread: (document.getElementById('notif-unread') || {}).textContent,
      markAllShown: !document.getElementById('notif-mark-all').hidden,
      pushHidden: document.getElementById('notif-enable-push').hidden,
      pushSupported: (typeof window.MwaketePush !== 'undefined') ? window.MwaketePush.supported() : null
    }));
    ok('dashboard: Favourite Stores shows the followed store', d.favShown && d.favItems === 1 && /Bong Store/.test(d.favName || ''), d);
    ok('dashboard: Notification Centre shows the unread note + mark-all', d.notifShown && d.notifItems === 1 && /1 new/.test(d.unread || '') && d.markAllShown, d);
    // Push is dormant by default (PUSH_CONFIG null): button hidden, SDK not loaded.
    ok('dashboard: Web Push stays dormant - button hidden, MwaketePush.supported() false', d.pushHidden === true && d.pushSupported === false, d);

    await p.click('#notif-mark-all'); await p.waitForTimeout(300);
    const afterRead = await p.evaluate(() => ({ unreadHidden: document.getElementById('notif-unread').hidden, stillOne: document.querySelectorAll('#notif-list .notif-item').length }));
    ok('dashboard: mark-all clears the unread badge, keeps the item', afterRead.unreadHidden && afterRead.stillOne === 1, afterRead);

    await p.click('#fav-list .fav-unfollow'); await p.waitForTimeout(400);
    const afterUnfollow = await p.evaluate(() => document.querySelectorAll('#fav-list .fav-item').length);
    ok('dashboard: Unfollow removes the store from Favourites', afterUnfollow === 0, { afterUnfollow });
    await ctx.close();
  }

  /* ---- D. Seller dashboard: Customer engagement panel, own store only ---- */
  {
    const box = build({
      StoreFollows: [['flw1', 'cus_harness', 'bong', 'active', 'true', FUT, FUT]],
      StoreLikes: [['lik1', 'cus_harness', 'bong', 'active', 'true', FUT, FUT]],
      StoreMarketingConsents: [['cns1', 'cus_harness', 'bong', 'active', FUT, '', FUT, FUT]]
    });
    const { ctx, p } = await open(box, 'owner/dashboard.html', { owner: true, w: 900 });
    await p.waitForTimeout(900);
    const e = await p.evaluate(() => {
      const panel = document.getElementById('dash-engagement');
      const facts = document.getElementById('dash-engagement-counts');
      const rows = document.querySelectorAll('#dash-engagement-list .engage-row');
      return {
        shown: panel && !panel.hidden,
        factsText: facts ? facts.textContent.replace(/\s+/g, ' ').trim() : '',
        rowCount: rows.length,
        chips: rows.length ? rows[0].querySelector('.engage-chips').textContent.replace(/\s+/g, '') : '',
        hasToken: /FcmToken|token/i.test((document.getElementById('dash-engagement-list') || {}).innerHTML || '')
      };
    });
    ok('seller: engagement panel shows with the four audience counts', e.shown && /Followers/.test(e.factsText) && /Marketing subscribers/.test(e.factsText), e);
    ok('seller: the one engaged customer is one row with follower+liker+subscriber chips', e.rowCount === 1 && /Follower/.test(e.chips) && /Liker/.test(e.chips) && /Subscriber/.test(e.chips), e);
    ok('seller: no push token / device data leaked into the audience', e.hasToken === false, e);
    await ctx.close();
  }

  /* ---- E. Seller campaign page: compose + preview + send (real backend) ---- */
  {
    const box = build({ StoreMarketingConsents: [['c1', 'cus_harness', 'bong', 'active', FUT, '', FUT, FUT]] });
    const { ctx, p } = await open(box, 'owner/engagement.html', { owner: true, w: 900 });
    p.on('dialog', (d) => d.accept());   // accept the "send now?" confirm
    await p.waitForTimeout(600);
    const cats = await p.evaluate(() => Array.from(document.getElementById('ec-category').options).map((o) => o.value));
    ok('campaigns: the type picker offers manual categories only (no price_drop)', cats.indexOf('flash_sale') !== -1 && cats.indexOf('price_drop') === -1, cats);
    await p.selectOption('#ec-category', 'flash_sale');
    await p.fill('#ec-title', 'Weekend sale');
    await p.fill('#ec-body', '20% off everything');
    await p.click('#ec-preview'); await p.waitForTimeout(300);
    ok('campaigns: preview shows the eligible audience (1 subscriber)', /1 eligible/.test(await p.textContent('#ec-audience-hint') || ''));
    await p.click('#ec-send'); await p.waitForTimeout(600);
    const after = await p.evaluate(() => ({
      items: document.querySelectorAll('#ec-list .ec-item').length,
      status: (document.querySelector('#ec-list .ec-status') || {}).textContent,
      delivered: (document.querySelector('#ec-list .ec-stat') || {}).textContent
    }));
    ok('campaigns: after Send now it is listed as sent with delivery stats', after.items === 1 && /sent/i.test(after.status || '') && /1 delivered/.test(after.delivered || ''), after);
    const notes = box.__sheets.Notifications.objects().filter((n) => n.Category === 'flash_sale');
    ok('campaigns: the engine delivered the in-app notification to the subscriber', notes.length === 1 && notes[0].CustomerId === 'cus_harness', notes.length);
    await ctx.close();
  }

  await browser.close();
  let fails = 0;
  R.forEach(([s, n, e]) => { if (s === 'FAIL') fails++; console.log(`${s}  ${n}${e && s === 'FAIL' ? '  [' + e + ']' : ''}`); });
  if (errors.length) console.log('PAGE ERRORS:\n' + errors.join('\n'));
  console.log(`\n${R.length - fails}/${R.length} passed`);
  process.exit(fails || errors.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
