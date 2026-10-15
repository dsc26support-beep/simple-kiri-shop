/**
 * Mwakete drivers END TO END in the browser: the real pages (driver.html,
 * owner/admin.html, order-room.html) against the REAL Apps Script sources in
 * gas-harness. Apply -> admin approves -> seller books a driver -> driver goes
 * online, accepts, shares location, collects, delivers with a photo -> buyer
 * confirms -> seller marks the driver paid. Plus privacy and phone layout.
 */
const zlib = require('zlib');
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const { makeBox } = require('./lib/gas-harness.js');
const BASE = process.env.TX_BASE || 'http://127.0.0.1:8099';
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e === undefined ? '' : e]);
const FUT = new Date(Date.now() + 9e8).toISOString();
const box = makeBox({
  Owners: [['OwnerId', 'StoreSlug', 'StoreName', 'Email', 'Phone', 'Status', 'Island', 'DeliveryPickPay', 'DeliveryTruck', 'DeliveryTruckCost', 'StoreType'],
    ['own_s', 'bong', 'Bong Store', 's@x.test', '73001111', 'active', 'South Tarawa', 'true', 'true', 5, 'retailer'],
    ['own_a', 'mwakete-admin', 'Admin', 'admin@x.test', '', 'active', 'South Tarawa', '', '', '', 'retailer']],
  Sessions: [['Token', 'OwnerId', 'CreatedAt', 'ExpiresAt'], ['tok-s', 'own_s', '', FUT], ['tok-a', 'own_a', '', FUT]],
  Customers: [['CustomerId', 'Name', 'Email', 'Phone', 'EmailVerified', 'CreatedAt', 'UpdatedAt'], ['cus_b', 'Tia', 'b@x.test', '73000001', 'yes', '', ''],
    ['cus_d', 'Dan Driver', 'd@x.test', '73000009', 'yes', '', '']],
  CustomerSessions: [['Token', 'CustomerId', 'CreatedAt', 'ExpiresAt'], ['c-b', 'cus_b', '', FUT], ['c-d', 'cus_d', '', FUT]],
  Products: [['ProductId', 'OwnerId', 'StoreSlug', 'Name', 'Description', 'Category', 'ListingType', 'Status', 'SortOrder', 'CreatedAt', 'UpdatedAt'], ['p1', 'own_s', 'bong', 'Rice', '10kg', 'food', 'product', 'active', 0, '', '']],
  Variants: [['VariantId', 'ProductId', 'OwnerId', 'Label', 'Price', 'SKU', 'StockQty', 'Status'], ['v1', 'p1', 'own_s', '10kg', 20, '', 500, 'active']],
  Orders: [['OrderId', 'OwnerId', 'StoreSlug', 'CustomerName', 'CustomerPhone', 'CustomerEmail', 'Island', 'Village', 'DeliveryAddress', 'DeliveryMethod', 'DeliveryCost', 'Notes',
    'PaymentMethod', 'PaymentReference', 'ItemsJson', 'ItemsSummary', 'Subtotal', 'Total', 'Status', 'CreatedAt', 'UpdatedAt']],
  AbandonedCarts: [['CartId', 'StoreSlug', 'Email', 'ConvertedOrderId']], Conversations: [['ConversationId', 'OwnerId']], Featured: [['FeaturedId', 'Type', 'RefId', 'SortOrder', 'CreatedAt']]
});
box.__props.ADMIN_EMAILS = 'admin@x.test';
box.__props.TX_ROOMS = 'on';
box.__props.DELIVERY_JOBS = 'on';
box.ContentService = { createTextOutput: (s) => ({ s, setMimeType() { return this; } }), MimeType: { JSON: 'json' } };
const backend = (b) => { Object.keys(box.__cache).filter((k) => k.indexOf('ratelimit') === 0 || k.indexOf('v1:dlv') === 0).forEach((k) => delete box.__cache[k]);
  try { return box.doPost({ postData: { contents: b } }).s; } catch (e) { return JSON.stringify({ ok: false, error: String(e.message || e) }); } };
const orderId = box.actionCreateOrder({ storeSlug: 'bong', items: [{ variantId: 'v1', qty: 1 }], customerName: 'Tia', customerPhone: '73000001', customerEmail: 'b@x.test',
  island: 'South Tarawa', village: 'Betio', deliveryMethod: 'truck' }).orderId;
box.actionTxVerifyPayment({ side: 'seller', token: 'tok-s', orderId, result: 'verified', checkedSource: true, method: 'cash', amountReceived: 25 });
box.actionTxChecklist({ side: 'seller', token: 'tok-s', orderId, checklist: { lines: [{ index: 0, ok: true }] } });
const job = () => (box.__sheets.DeliveryJobs ? box.__sheets.DeliveryJobs.objects().slice(-1)[0] : null);

const CRC = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function realPng(w, h) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = y * (w * 3 + 1) + 1 + x * 3; raw[i] = x & 255; raw[i + 1] = y & 255; raw[i + 2] = (x * y) & 255; }
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const errors = [];
  const ctxFor = async (storage, opts) => {
    const ctx = await browser.newContext(Object.assign({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' }, opts || {}));
    await ctx.addInitScript((s) => { Object.entries(s).forEach(([k, v]) => localStorage.setItem(k, v)); localStorage.setItem('skiri_cookie_consent', 'accepted'); }, storage);
    await ctx.route('**/macros/s/**', (route) => { const b = route.request().postData(); route.fulfill({ status: 200, contentType: 'application/json', body: b ? backend(b) : '{"ok":true}' }); });
    return ctx;
  };
  const page = async (ctx, url) => { const p = await ctx.newPage(); p.on('pageerror', (e) => errors.push(String(e))); p.on('dialog', (d) => d.accept()); await p.goto(BASE + '/' + url, { waitUntil: 'load' }); return p; };
  const driverCtx = await ctxFor({ skiri_customer_token: 'c-d', skiri_customer_profile: JSON.stringify({ name: 'Dan Driver', email: 'd@x.test', phone: '73000009' }) },
    { geolocation: { latitude: 1.3521, longitude: 172.9784, accuracy: 15 }, permissions: ['geolocation'] });
  const sellerCtx = await ctxFor({ skiri_owner_token: 'tok-s', skiri_owner_profile: JSON.stringify({ storeName: 'Bong Store', storeSlug: 'bong' }) });
  const adminCtx = await ctxFor({ skiri_owner_token: 'tok-a', skiri_owner_profile: JSON.stringify({ storeName: 'Admin', storeSlug: 'mwakete-admin', isAdmin: true }) }, { viewport: { width: 1280, height: 900 } });
  const buyerCtx = await ctxFor({ skiri_customer_token: 'c-b', skiri_customer_profile: JSON.stringify({ name: 'Tia', email: 'b@x.test' }) });

  // 1. apply
  let dp = await page(driverCtx, 'driver.html');
  await dp.waitForSelector('#drv-apply:not([hidden])', { timeout: 8000 });
  ok('a signed-in customer sees the apply form, name and phone filled in', (await dp.inputValue('#drv-name')) === 'Dan Driver' && (await dp.inputValue('#drv-phone')) === '73000009');
  await dp.click('#drv-apply-form button[type="submit"]');
  await dp.waitForFunction(() => document.getElementById('drv-apply-error').textContent, null, { timeout: 8000 });
  ok('the rules must be agreed first', /agree/.test(await dp.textContent('#drv-apply-error')));
  await dp.check('#drv-agree');
  await dp.click('#drv-apply-form button[type="submit"]');
  await dp.waitForSelector('#drv-wait:not([hidden])', { timeout: 8000 });
  ok('applied -> waiting for approval', /waiting for a Mwakete admin/.test(await dp.textContent('#drv-wait')));

  // 2. admin approves
  const ap = await page(adminCtx, 'owner/admin.html');
  await ap.waitForSelector('#dlv-drivers [data-set="approved"]', { timeout: 10000 });
  ok('admin sees the application in Deliveries & drivers', /Dan Driver/.test(await ap.textContent('#dlv-drivers')) && /1 waiting for approval/.test(await ap.textContent('#dlv-counts')));
  await ap.click('#dlv-drivers [data-set="approved"]');
  await ap.waitForFunction(() => /approved/.test(document.getElementById('dlv-drivers').textContent), null, { timeout: 8000 });
  ok('admin approves the driver', box.__sheets.Drivers.objects()[0].Status === 'approved');

  // 3. seller books a driver
  const sp = await page(sellerCtx, `order-room.html?order=${orderId}&as=seller`);
  await sp.waitForSelector('#tx-action-buttons [data-action="requestDriver"]', { timeout: 8000 });
  await sp.click('#tx-action-buttons [data-action="requestDriver"]');
  await sp.fill('#f-fee', '5');
  await sp.fill('#f-pickup', 'Back door of the Bong shop, Betio');
  await sp.click('#tx-form button[type="submit"]');
  await sp.waitForSelector('.tx-delivery', { timeout: 8000 });
  ok('seller books a driver from the order room; the panel says it is waiting', /Waiting for a driver/.test(await sp.textContent('.tx-delivery')) && job().Status === 'open');
  ok('while booked, the seller is not offered "record sending"', !(await sp.$('#tx-action-buttons [data-action="dispatch"]')));

  // 4. driver goes online, accepts, shares location, collects, delivers
  await dp.reload({ waitUntil: 'load' });
  await dp.waitForSelector('#drv-app:not([hidden])', { timeout: 8000 });
  await dp.click('#drv-online');
  await dp.waitForSelector('[data-accept]', { timeout: 8000 });
  ok('online driver sees the job: area and fee, no buyer name or phone', /Betio, South Tarawa/.test(await dp.textContent('#drv-open')) && !/73000001|Tia/.test(await dp.textContent('#drv-open')));
  await dp.click('[data-accept]');
  await dp.waitForSelector('.drv-job.is-mine', { timeout: 8000 });
  ok('after accepting, the buyer\'s name and phone appear with a map link', /Tia/.test(await dp.textContent('#drv-mine')) && !!(await dp.$('#drv-mine a[href="tel:73000001"]')) && !!(await dp.$('#drv-mine a[href*="openstreetmap.org/search"]')));
  await dp.check('[data-share]');
  await dp.waitForFunction(() => true, null, { timeout: 500 });
  await new Promise((r) => setTimeout(r, 800));
  ok('location sharing (opt-in) sends the phone\'s position', job().Sharing === 'yes' && job().LastLat === '1.35210', JSON.stringify([job().Sharing, job().LastLat]));
  const bp = await page(buyerCtx, `order-room.html?order=${orderId}&as=buyer`);
  await bp.waitForSelector('.tx-delivery', { timeout: 8000 });
  ok('the buyer sees the driver, their phone and a map link to the live location', /Dan Driver/.test(await bp.textContent('.tx-delivery')) && !!(await bp.$('.tx-delivery a[href*="openstreetmap.org/?mlat=1.35210"]'))
    && !/Fee/.test(await bp.textContent('.tx-delivery')));
  await dp.click('[data-act="picked_up"]');
  await dp.waitForSelector('[data-proof]', { timeout: 8000 });
  ok('collecting the goods records the order as sent (by the driver)', box.__sheets.TxState.objects().find((s) => s.OrderId === orderId).FulfilmentState === 'dispatched');
  await dp.fill('[id^="rcpt-"]', 'Tia');
  await dp.click('[data-act="delivered"]');
  await dp.waitForFunction(() => /photo/i.test((document.querySelector('[id^="err-"]') || {}).textContent || ''), null, { timeout: 8000 });
  ok('"Delivered" without a photo is refused', true);
  await dp.setInputFiles('[data-proof]', { name: 'proof.png', mimeType: 'image/png', buffer: realPng(640, 480) });
  await dp.waitForFunction(() => /Photo saved/.test((document.querySelector('[id^="proof-"]') || {}).textContent || ''), null, { timeout: 10000 });
  await dp.fill('[id^="rcpt-"]', 'Tia');
  await dp.click('[data-act="delivered"]');
  await dp.waitForFunction(() => /Driver reports delivered/.test(document.getElementById('drv-hist').textContent), null, { timeout: 8000 });
  ok('delivered with a photo -> job in history, location wiped', job().Status === 'delivered' && job().LastLat === '' && /\$5\.00/.test(await dp.textContent('#drv-k-fees')));

  // 5. buyer confirms, seller pays driver
  await bp.reload({ waitUntil: 'load' });
  await bp.waitForSelector('#tx-action-buttons [data-action="confirmReceipt"]', { timeout: 8000 });
  ok('the buyer sees the driver\'s delivery photo in the room', /Driver/.test(await bp.textContent('#tx-timeline')) && (await bp.$$('.tx-file')).length >= 1);
  await bp.click('#tx-action-buttons [data-action="confirmReceipt"]');
  await bp.check('#f-ch-ok');
  await bp.click('#tx-form button[type="submit"]');
  await bp.waitForFunction(() => /Completed/.test(document.querySelector('.tx-stage').textContent), null, { timeout: 8000 });
  ok('buyer confirms -> order completed', box.__sheets.Orders.objects().find((o) => o.OrderId === orderId).Status === 'Fulfilled');
  await sp.reload({ waitUntil: 'load' });
  await sp.waitForSelector('#tx-action-buttons [data-action="markDriverPaid"]', { timeout: 8000 });
  await sp.click('#tx-action-buttons [data-action="markDriverPaid"]');
  await sp.check('#f-paid');
  await sp.click('#tx-form button[type="submit"]');
  await sp.waitForFunction(() => /marked paid/.test(document.querySelector('.tx-delivery').textContent), null, { timeout: 8000 });
  await dp.reload({ waitUntil: 'load' });
  await dp.waitForSelector('#drv-app:not([hidden])', { timeout: 8000 });
  ok('seller marks the driver paid; the driver sees it', (await dp.textContent('#drv-k-paid')).trim() === '$5.00');

  // 6. layout
  for (const [ctx, url] of [[driverCtx, 'driver.html'], [buyerCtx, `order-room.html?order=${orderId}&as=buyer`]]) {
    const p = await page(ctx, url);
    await p.waitForTimeout(800);
    for (const w of [320, 375, 430]) {
      await p.setViewportSize({ width: w, height: 800 });
      const over = await p.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      ok(`${url.split('?')[0]}: no sideways scroll at ${w}px`, over <= 1, String(over));
    }
    if (process.env.SHOT_DIR && url === 'driver.html') { await p.setViewportSize({ width: 390, height: 844 }); await p.screenshot({ path: process.env.SHOT_DIR + '/driver-phone.png', fullPage: true }); }
  }
  ok('no page errors', errors.length === 0, errors.join(' | ').slice(0, 300));
  await browser.close();
  let fails = 0;
  console.log('\n--- drivers end to end (real backend) ---');
  for (const [s, n, x] of R) { if (s === 'FAIL') fails++; console.log(`${s}  ${n}${x !== '' ? '  [' + x + ']' : ''}`); }
  console.log(`\n${R.length - fails}/${R.length} passed`);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
