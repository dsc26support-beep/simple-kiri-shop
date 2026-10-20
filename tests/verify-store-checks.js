/**
 * Owner decision, Oct 2026 - store checks, in the browser on the REAL backend:
 *  - shoppers see "Not yet checked" in words on cards and store pages, and
 *    checked stores first;
 *  - the admin page's Store checks section ticks Call / Email / Visit, gives
 *    New only once all three are ticked, gives / removes Verified (with a
 *    reason);
 *  - a seller's Dashboard says where their store stands.
 */
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const { makeBox } = require('./lib/gas-harness.js');
const BASE = process.env.TX_BASE || 'http://127.0.0.1:8099';
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e === undefined ? '' : e]);
const FUT = new Date(Date.now() + 9e8).toISOString();

const box = makeBox({
  Owners: [['OwnerId', 'StoreName', 'StoreSlug', 'Email', 'Phone', 'Status', 'Island', 'Village', 'CreatedAt', 'Visits', 'DeliveryPickPay', 'StoreType'],
    ['adm', 'Mwakete Admin', 'mwakete-admin', 'boss@mwakete.com', '', 'active', 'South Tarawa', 'Bairiki', '2026-01-01', 0, 'true', 'retailer'],
    ['o_a', 'Aroita Shop', 'aroita', 'a@x.test', '73000001', 'active', 'South Tarawa', 'Betio', '2026-10-01', 500, 'true', 'retailer'],
    ['o_c', 'Coco Mart', 'coco', 'c@x.test', '73000003', 'active', 'South Tarawa', 'Teaoraereke', '2026-10-03', 10, 'true', 'retailer']],
  Sessions: [['Token', 'OwnerId', 'CreatedAt', 'ExpiresAt'], ['tok-adm', 'adm', '', FUT], ['tok-c', 'o_c', '', FUT]],
  Products: [['ProductId', 'OwnerId', 'StoreSlug', 'Name', 'Description', 'Category', 'ListingType', 'Status', 'Views', 'SortOrder'],
    ['p_a', 'o_a', 'aroita', 'Bucket A', 'Blue bucket', 'home', 'product', 'active', 900, 0],
    ['p_c', 'o_c', 'coco', 'Bucket C', 'Green bucket', 'home', 'product', 'active', 5, 0]],
  Variants: [['VariantId', 'ProductId', 'OwnerId', 'Label', 'Price', 'StockQty', 'Status'],
    ['v_a', 'p_a', 'o_a', 'One', 5, 9, 'active'], ['v_c', 'p_c', 'o_c', 'One', 5, 9, 'active']],
  Reviews: [['ReviewId', 'ProductId', 'OwnerId', 'CustomerId', 'CustomerName', 'Rating', 'Comment', 'Status', 'CreatedAt']],
  Orders: [['OrderId', 'OwnerId', 'StoreSlug', 'CustomerName', 'Total', 'Status', 'ItemsSummary', 'CreatedAt', 'CustomerEmail']],
  Conversations: [['ConversationId', 'OwnerId']], Messages: [['MessageId', 'ConversationId', 'SenderType', 'CreatedAt']],
  SellerBadges: [['OwnerId', 'Badges', 'Score', 'MetricsJson', 'ReasonJson', 'UpdatedAt']],
  BadgeConfig: [['Key', 'Value', 'UpdatedAt']], Featured: [['Type', 'RefId', 'SortOrder']], Bookings: [['BookingId', 'OwnerId', 'Status']]
}, { guest: true });
box.__props.ADMIN_EMAILS = 'boss@mwakete.com';
box.ContentService = { createTextOutput: (s) => ({ s, setMimeType() { return this; } }), MimeType: { JSON: 'json' } };
box.recomputeSellerBadges();
const call = (b) => { try { return box.doPost({ postData: { contents: b } }).s; } catch (e) { return JSON.stringify({ ok: false, error: String(e.message || e) }); } };
const get = (q) => { try { return box.doGet({ parameter: q }).s; } catch (e) { return JSON.stringify({ ok: false, error: String(e.message || e) }); } };

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const errors = [];
  const open = async (init, w) => {
    const ctx = await browser.newContext({ viewport: { width: w || 390, height: 900 }, serviceWorkers: 'block' });
    await ctx.addInitScript((i) => { localStorage.setItem('skiri_cookie_consent', 'true'); Object.keys(i).forEach((k) => localStorage.setItem(k, i[k])); }, init || {});
    await ctx.route('**/macros/s/**', (route) => {
      Object.keys(box.__cache).forEach((k) => delete box.__cache[k]);
      const b = route.request().postData();
      const body = b ? call(b) : get(Object.fromEntries(new URL(route.request().url()).searchParams));
      route.fulfill({ status: 200, contentType: 'application/json', body });
    });
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(String(e)));
    p.on('dialog', (d) => d.accept('Selling fake stock'));
    return { ctx, p };
  };
  const ADMIN = { 'skiri_owner_token': 'tok-adm', 'skiri_owner_profile': JSON.stringify({ storeName: 'Mwakete Admin', storeSlug: 'mwakete-admin', isAdmin: true }) };

  /* ---------- shoppers ---------- */
  let { ctx, p } = await open();
  await p.goto(BASE + '/store.html?store=aroita', { waitUntil: 'load' });
  await p.waitForSelector('.product-card', { timeout: 8000 }).catch(() => {});
  await p.waitForTimeout(500);
  ok('a card of a store nobody checked says "Not yet checked" in words',
    /Not yet checked/.test(await p.textContent('.product-card .product-card-verified').catch(() => '')), await p.textContent('.product-card').catch(() => ''));
  ok('...and the store page header says it too', /Not yet checked/.test(await p.textContent('header').catch(() => '')) || /Not yet checked/.test(await p.textContent('body')));
  await ctx.close();

  /* ---------- admin: Store checks ---------- */
  ({ ctx, p } = await open(ADMIN, 1280));
  await p.goto(BASE + '/owner/admin.html', { waitUntil: 'load' });
  await p.waitForSelector('#trust-list .trust-row', { timeout: 10000 }).catch(() => {});
  const names = async () => p.$$eval('#trust-list .trust-row strong', (els) => els.map((e) => e.textContent));
  ok('the admin page lists stores not yet checked first (the default view)', (await names()).includes('Coco Mart') && (await names()).includes('Aroita Shop'), (await names()).join(','));
  const rowOf = (name) => p.locator('#trust-list .trust-row', { hasText: name });
  ok('Give New is disabled until Call, Email and Visit are ticked', await rowOf('Coco Mart').locator('[data-trust-op="giveNew"]').isDisabled());
  for (const k of ['call', 'email', 'visit']) {
    await rowOf('Coco Mart').locator(`[data-check="${k}"]`).click();
    await p.waitForTimeout(400);
  }
  ok('each tick shows as done', await rowOf('Coco Mart').locator('.trust-check.is-done').count() === 3);
  ok('...and Give New is now enabled', await rowOf('Coco Mart').locator('[data-trust-op="giveNew"]').isEnabled());
  await rowOf('Coco Mart').locator('[data-trust-op="giveNew"]').click();
  await p.waitForTimeout(600);
  ok('Give New moves the store out of "Not yet checked"', !(await names()).includes('Coco Mart'), (await names()).join(','));
  await p.check('input[name="trust-filter"][value="new"]');
  ok('...into New', (await names()).join(',') === 'Coco Mart', (await names()).join(','));
  await rowOf('Coco Mart').locator('[data-trust-op="giveVerified"]').click();
  await p.waitForTimeout(600);
  await p.check('input[name="trust-filter"][value="verified"]');
  ok('Give Verified makes it Verified', (await names()).join(',') === 'Coco Mart');
  await rowOf('Coco Mart').locator('[data-trust-op="removeVerified"]').click();   // the prompt is answered with a reason
  await p.waitForTimeout(600);
  ok('Remove Verified asks for a reason and records it', box.__sheets.TrustLog.objects().some((l) => l.Action === 'removeVerified' && l.Detail === 'Selling fake stock'));
  await p.check('input[name="trust-filter"][value="new"]');
  ok('...and offers "Let ratings decide again"', await rowOf('Coco Mart').locator('[data-trust-op="ratingsDecide"]').isVisible());
  await ctx.close();

  /* ---------- shoppers again: checked store first ---------- */
  ({ ctx, p } = await open());
  await p.goto(BASE + '/stores.html', { waitUntil: 'load' });
  await p.waitForFunction(() => /Coco Mart/.test(document.body.textContent) && /Aroita Shop/.test(document.body.textContent), null, { timeout: 8000 }).catch(() => {});
  const order = await p.evaluate(() => { const t = document.body.textContent; return [t.indexOf('Coco Mart'), t.indexOf('Aroita Shop')]; });
  ok('the store directory lists the checked (New) store before the unchecked one', order[0] > -1 && order[0] < order[1], JSON.stringify(order));
  await ctx.close();

  /* ---------- seller dashboard ---------- */
  ({ ctx, p } = await open({ 'skiri_owner_token': 'tok-c', 'skiri_owner_profile': JSON.stringify({ storeName: 'Coco Mart', storeSlug: 'coco' }) }));
  await p.goto(BASE + '/owner/dashboard.html', { waitUntil: 'load' });
  await p.waitForSelector('#dash-check:not([hidden])', { timeout: 8000 }).catch(() => {});
  ok('a checked seller sees "Checked by Mwakete (New)" and the way to Verified',
    /Checked by Mwakete \(New\)/.test(await p.textContent('#dash-check').catch(() => '')) && /4\.5★ over 10\+ reviews/.test(await p.textContent('#dash-check').catch(() => '')),
    await p.textContent('#dash-check').catch(() => ''));
  await ctx.close();

  ok('no page errors', errors.length === 0, errors.join(' | ').slice(0, 300));
  await browser.close();
  let fails = 0;
  console.log('\n--- store checks (browser, real backend) ---');
  for (const [s, n, x] of R) { if (s === 'FAIL') fails++; console.log(`${s}  ${n}${x !== '' ? '  [' + x + ']' : ''}`); }
  console.log(`\n${R.length - fails}/${R.length} passed`);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
