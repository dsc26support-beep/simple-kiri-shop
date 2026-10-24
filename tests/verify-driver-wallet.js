/**
 * Driver wallet END TO END in the browser: the real pages (driver.html,
 * owner/admin.html, order-room.html) against the REAL Apps Script sources.
 * Fee chat and agreement -> seller pays Mwakete -> admin confirms the bank
 * statement -> driver collects (details unlock) -> delivers -> buyer confirms
 * -> credit and hold -> payout details and claim -> admin pays the claim.
 * Also: no sideways scroll on a phone, no page errors.
 */
const zlib = require('zlib');
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const { makeBox, driverDocs } = require('./lib/gas-harness.js');
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
  Products: [['ProductId', 'OwnerId', 'StoreSlug', 'Name', 'Description', 'Category', 'ListingType', 'Status', 'SortOrder', 'CreatedAt', 'UpdatedAt'], ['p1', 'own_s', 'bong', 'Rice', '10kg', 'home', 'product', 'active', 0, '', '']],
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

box.__props.DELIVERY_PAYMENTS = 'pilot';
box.__props.MWAKETE_BANK_DETAILS = 'ANZ Bank, Mwakete Ltd, account 000111222';
const BUYER_PHONE = '73000001';
const HOUR = 3600000;
const ledger = () => (box.__sheets.DriverLedger ? box.__sheets.DriverLedger.objects() : []);

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const errors = [];
  // Prompts in the admin page: answer by what they ask.
  const answer = (d) => {
    const m = d.message();
    if (d.type() !== 'prompt') return d.accept();
    if (/Bank reference of the transfer/.test(m)) return d.accept('ANZ-PAYOUT-77');
    if (/Amount that arrived/.test(m)) return d.accept(d.defaultValue());
    return d.accept('Because it is right');
  };
  const ctxFor = async (storage, opts) => {
    const ctx = await browser.newContext(Object.assign({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' }, opts || {}));
    await ctx.addInitScript((s) => { Object.entries(s).forEach(([k, v]) => localStorage.setItem(k, v)); localStorage.setItem('skiri_cookie_consent', 'accepted'); }, storage);
    await ctx.route('**/macros/s/**', (route) => { const b = route.request().postData(); route.fulfill({ status: 200, contentType: 'application/json', body: b ? backend(b) : '{"ok":true}' }); });
    return ctx;
  };
  const page = async (ctx, url) => { const p = await ctx.newPage(); p.on('pageerror', (e) => errors.push(url + ': ' + String(e))); p.on('dialog', answer); await p.goto(BASE + '/' + url, { waitUntil: 'load' }); return p; };
  const driverCtx = await ctxFor({ skiri_customer_token: 'c-d', skiri_customer_profile: JSON.stringify({ name: 'Dan Driver', email: 'd@x.test', phone: '73000009' }) });
  const sellerCtx = await ctxFor({ skiri_owner_token: 'tok-s', skiri_owner_profile: JSON.stringify({ storeName: 'Bong Store', storeSlug: 'bong' }) });
  const adminCtx = await ctxFor({ skiri_owner_token: 'tok-a', skiri_owner_profile: JSON.stringify({ storeName: 'Admin', storeSlug: 'mwakete-admin', isAdmin: true }) }, { viewport: { width: 1280, height: 900 } });
  const buyerCtx = await ctxFor({ skiri_customer_token: 'c-b', skiri_customer_profile: JSON.stringify({ name: 'Tia', email: 'b@x.test' }) });

  // Setup through the backend: the driver applies and is approved and online (the apply/approve screens are covered by verify-deliveries.js).
  const dct = { token: 'c-d' };
  box.actionDriverApply(Object.assign(driverDocs(), { name: 'Dan Driver', phone: '73000009', vehicle: 'motorbike', area: 'South Tarawa', agree: true }, dct));
  const driverId = box.__sheets.Drivers.objects()[0].DriverId;
  box.actionAdminSetDriverStatus(box.__sheets.Owners.objects()[1], { driverId, status: 'approved' });
  box.actionDriverSetAvailable(Object.assign({ available: true }, dct));
  box.__props.DELIVERY_PAYMENTS_DRIVERS = driverId;

  // 1. seller books the driver; the driver accepts
  const sp = await page(sellerCtx, `order-room.html?order=${orderId}&as=seller`);
  await sp.waitForSelector('#tx-action-buttons [data-action="requestDriver"]', { timeout: 8000 });
  ok('seller\'s request form describes the money flow (no "Mwakete does not handle the money")', await (async () => { await sp.click('#tx-action-buttons [data-action="requestDriver"]'); const t = await sp.textContent('#tx-form'); return /you pay it to Mwakete/.test(t) && !/does not handle the money/.test(t); })());
  await sp.fill('#f-fee', '5');
  await sp.fill('#f-pickup', 'Back door of the Bong shop, Betio');
  await sp.fill('#f-notes', 'Fragile');
  await sp.click('#tx-form button[type="submit"]');
  await sp.waitForSelector('.tx-delivery', { timeout: 8000 });
  ok('seller books a driver at $5', /Waiting for a driver/.test(await sp.textContent('.tx-delivery')) && job().Fee === 5);

  const dp = await page(driverCtx, 'driver.html');
  await dp.waitForSelector('[data-accept]', { timeout: 8000 });
  await dp.click('[data-accept]');
  await dp.waitForSelector('.drv-job.is-mine', { timeout: 8000 });
  ok('the driver\'s balance panel appears (wallet covers them) and starts at zero', await dp.isVisible('#drv-wallet') && /\$0\.00/.test(await dp.textContent('#drv-wallet-body')));
  ok('chat panel shows the seller\'s $5 offer, with an Agree button', /Delivery fee \$5\.00/.test(await dp.textContent('.tx-jobchat')) && !!(await dp.$('.tx-jobchat [data-jc="agree"]')));

  // 2. chat and fee: driver messages and proposes $6, seller agrees
  await dp.fill('[data-chat-input]', 'It is a long way, can we say $6?');
  await dp.click('.tx-jobchat [data-jc="message"]');
  await dp.waitForFunction(() => /can we say \$6/.test(document.querySelector('.tx-jobchat').textContent), null, { timeout: 8000 });
  ok('driver\'s message appears in their chat and is cleared from the box', (await dp.inputValue('[data-chat-input]')) === '');
  await dp.fill('[id^="jcfee-"]', '6');
  await dp.click('.tx-jobchat [data-jc="propose"]');
  await dp.waitForFunction(() => /Delivery fee \$6\.00/.test(document.querySelector('.tx-jobchat').textContent), null, { timeout: 8000 });
  ok('driver proposes $6; waiting for the seller', /Waiting for the seller to agree/.test(await dp.textContent('.tx-jobchat')) && job().Fee === 6);
  await sp.reload({ waitUntil: 'load' });
  await sp.waitForSelector('.tx-jobchat', { timeout: 8000 });
  ok('seller sees the message and the $6 proposal', /can we say \$6/.test(await sp.textContent('.tx-jobchat')) && !!(await sp.$('.tx-jobchat [data-jc="agree"]')));
  const bp = await page(buyerCtx, `order-room.html?order=${orderId}&as=buyer`);
  await bp.waitForSelector('.tx-delivery', { timeout: 8000 });
  ok('the buyer sees the driver panel but NO chat, fee talk or bank details', !(await bp.$('.tx-jobchat')) && !/can we say|ANZ Bank|MWK-|\$6/.test(await bp.textContent('body')));
  await sp.fill('#jc-text', 'OK, $6 it is.');
  await sp.click('.tx-jc-form[data-jc-form="message"] button[type="submit"]');
  await sp.waitForFunction(() => /OK, \$6 it is/.test(document.querySelector('.tx-jobchat').textContent), null, { timeout: 8000 });
  await sp.click('.tx-jobchat [data-jc="agree"]');
  await sp.waitForFunction(() => /Agreed and locked/.test(document.querySelector('.tx-jobchat').textContent), null, { timeout: 8000 });
  ok('seller agrees: the fee is locked at $6', job().FeeLocked === 'yes' && job().Fee === 6 && !(await sp.$('.tx-jobchat [data-jc="agree"]')) && !(await sp.$('#jc-fee')));

  // 3. the seller pays Mwakete
  ok('seller sees the amount, the reference and the bank details', /MWK-[A-Z0-9]{8}/.test(await sp.textContent('.tx-jc-pay')) && /ANZ Bank, Mwakete Ltd, account 000111222/.test(await sp.textContent('.tx-jc-pay')) && /\$6\.00/.test(await sp.textContent('.tx-jc-pay')));
  await dp.reload({ waitUntil: 'load' });
  await dp.waitForSelector('.drv-job.is-mine', { timeout: 8000 });
  const mineText = await dp.textContent('#drv-mine');
  ok('driver: pickup place, store phone and buyer details are hidden; a clear notice says why', /once Mwakete confirms the seller.s payment/.test(mineText) && !/Back door|Tia|73001111/.test(mineText) && !(await dp.$('#drv-mine a[href="tel:' + BUYER_PHONE + '"]')) );
  await dp.click('[data-act="picked_up"]');
  await dp.waitForFunction(() => /not confirmed the seller/.test((document.querySelector('[id^="err-"]') || {}).textContent || ''), null, { timeout: 8000 });
  ok('driver tapping "collected" early is refused with a clear message, and nothing changes', job().Status === 'accepted');
  ok('driver: never sees bank details or the reference', !/ANZ Bank|MWK-/.test(await dp.textContent('body')));
  await sp.fill('#jc-bankref', 'ANZ-TRANSFER-9911');
  await sp.click('.tx-jc-form[data-jc-form="pay"] button[type="submit"]');
  await sp.waitForFunction(() => /Mwakete is checking its bank account/.test(document.querySelector('.tx-jc-pay').textContent), null, { timeout: 8000 });
  ok('seller says they paid: status submitted with the bank reference', job().PayStatus === 'submitted' && job().PayBankRef === 'ANZ-TRANSFER-9911');

  // 4. admin checks the statement and confirms
  const ap = await page(adminCtx, 'owner/admin.html');
  await ap.waitForSelector('#dlv-counts', { timeout: 10000 });
  await ap.waitForFunction(() => /Payments to check/.test(document.getElementById('dlv-counts').textContent), null, { timeout: 8000 });
  ok('admin sees "Payments to check: 1"', /Payments to check\s*1/.test((await ap.textContent('#dlv-counts')).replace(/\s+/g, ' ')));
  await ap.selectOption('#dlv-filter', 'payments');
  await ap.waitForSelector('[data-pay="confirm"]', { timeout: 8000 });
  const row = await ap.textContent('#dlv-jobs');
  ok('the admin row shows the reference, the seller\'s bank reference and the amount', new RegExp(job().PayRef).test(row) && /ANZ-TRANSFER-9911/.test(row) && /\$6\.00/.test(row));
  await ap.click('[data-pay="confirm"]');
  await ap.waitForFunction(() => !document.querySelector('[data-pay="confirm"]'), null, { timeout: 8000 });
  ok('admin confirms: payment received', job().PayStatus === 'received' && job().PayCheckedBy === 'own_a');

  // 5. the driver collects (details unlocked), delivers
  await dp.reload({ waitUntil: 'load' });
  await dp.waitForSelector('[data-act="picked_up"]', { timeout: 8000 });
  const unlocked = await dp.textContent('#drv-mine');
  ok('driver: pickup, store phone and buyer details now show', /Back door of the Bong shop/.test(unlocked) && /Tia/.test(unlocked) && !!(await dp.$('#drv-mine a[href="tel:73000001"]')) && /Fragile/.test(unlocked));
  await dp.click('[data-act="picked_up"]');
  await dp.waitForSelector('[data-proof]', { timeout: 8000 });
  await dp.setInputFiles('[data-proof]', { name: 'proof.png', mimeType: 'image/png', buffer: realPng(640, 480) });
  await dp.waitForFunction(() => /Photo saved/.test((document.querySelector('[id^="proof-"]') || {}).textContent || ''), null, { timeout: 10000 });
  await dp.fill('[id^="rcpt-"]', 'Tia');
  await dp.click('[data-act="delivered"]');
  await dp.waitForFunction(() => /Driver reports delivered/.test(document.getElementById('drv-hist').textContent), null, { timeout: 8000 });
  ok('driver delivers with a photo; nothing is credited yet', job().Status === 'delivered' && ledger().length === 0);

  // 6. the buyer confirms: the driver is credited, in the hold
  await bp.reload({ waitUntil: 'load' });
  await bp.waitForSelector('#tx-action-buttons [data-action="confirmReceipt"]', { timeout: 8000 });
  await bp.click('#tx-action-buttons [data-action="confirmReceipt"]');
  await bp.check('#f-ch-ok');
  await bp.click('#tx-form button[type="submit"]');
  await bp.waitForFunction(() => /Completed/.test(document.querySelector('.tx-stage').textContent), null, { timeout: 8000 });
  ok('buyer confirms: the order completes and the driver is credited $6', ledger().length === 1 && ledger()[0].Amount === 6 && job().PayStatus === 'credited');
  await dp.reload({ waitUntil: 'load' });
  await dp.waitForSelector('#drv-wallet-body .kpi-card', { timeout: 8000 });
  let w = (await dp.innerText('#drv-wallet-body')).replace(/\s+/g, ' ');
  ok('driver\'s balance: $6.00 in the 48-hour hold, nothing to claim yet, the credit listed', /In the 48-hour hold \$6\.00/i.test(w) && /Available to claim \$0\.00/i.test(w) && /Delivery fee/.test(w) && await dp.isDisabled('[data-wallet="claim"]'), w);

  // 7. time passes; the driver saves payout details and claims
  box.sheetToObjects(box.getSheet('DriverLedger')).forEach((e) => box.updateRowFromObject(box.getSheet('DriverLedger'), e.__row, { AvailableAt: new Date(Date.now() - HOUR).toISOString() }));
  // $6 is below the $20 minimum: make it twenty by two more credits through the real flow? Use the owner-approved minimum setting instead.
  box.__props.DRIVER_MIN_PAYOUT = '5';
  await dp.reload({ waitUntil: 'load' });
  await dp.waitForSelector('[data-wallet="save"]', { timeout: 8000 });
  w = (await dp.innerText('#drv-wallet-body')).replace(/\s+/g, ' ');
  ok('after the hold: $6.00 available, but Claim stays off until payout details are saved', /Available to claim \$6\.00/i.test(w) && await dp.isDisabled('[data-wallet="claim"]'), w);
  await dp.fill('#drv-payout-input', 'ANZ Bank, Dan Driver, account 123456789');
  await dp.click('[data-wallet="save"]');
  await dp.waitForFunction(() => { const b = document.querySelector('[data-wallet="claim"]'); return b && !b.disabled; }, null, { timeout: 8000 });
  ok('saving payout details turns Claim on', box.sheetToObjects(box.getSheet('Drivers'))[0].PayoutDetails === 'ANZ Bank, Dan Driver, account 123456789');
  await dp.click('[data-wallet="claim"]');
  await dp.waitForFunction(() => /waiting to be paid/.test(document.getElementById('drv-wallet-body').textContent), null, { timeout: 8000 });
  ok('claiming asks for the whole $6.00; it now shows as waiting to be paid', ledger().filter((e) => e.EntryType === 'CLAIM').length === 1 && ledger().find((e) => e.EntryType === 'CLAIM').Amount === -6);

  // 8. admin pays the claim
  await ap.reload({ waitUntil: 'load' });
  await ap.waitForSelector('[data-payout="paid"]', { timeout: 10000 });
  const pay = (await ap.innerText('#dlv-payouts')).replace(/\s+/g, ' ');
  const hold = (await ap.innerText('#dlv-holding')).replace(/\s+/g, ' ');
  ok('admin sees the claim with the driver\'s bank details', /Dan Driver/.test(pay) && /\$6\.00/.test(pay) && /account 123456789/.test(pay));
  ok('admin sees what Mwakete should hold: $6.00 (the claim still to pay)', /Mwakete should hold \$6\.00/.test(hold) && /Claims to pay \$6\.00/.test(hold), hold);
  await ap.click('[data-payout="paid"]');
  await ap.waitForFunction(() => !document.querySelector('[data-payout="paid"]'), null, { timeout: 8000 });
  ok('admin pays it with a bank reference; Mwakete should now hold $0.00', ledger().some((e) => e.EntryType === 'PAYOUT_PAID' && e.Reference === 'ANZ-PAYOUT-77') && /Mwakete should hold \$0\.00/i.test((await ap.innerText('#dlv-holding')).replace(/\s+/g, ' ')), (await ap.innerText('#dlv-holding')).replace(/\s+/g, ' '));
  await dp.reload({ waitUntil: 'load' });
  await dp.waitForSelector('#drv-wallet-body .kpi-card', { timeout: 8000 });
  w = (await dp.innerText('#drv-wallet-body')).replace(/\s+/g, ' ');
  ok('the driver sees it paid, with the reference, and $6.00 paid so far', /Paid to you so far \$6\.00/i.test(w) && /paid/.test(w) && /ANZ-PAYOUT-77/.test(w), w);

  // 8b. the screens after everything is settled (found by looking at screenshots)
  await sp.reload({ waitUntil: 'load' });
  await sp.waitForSelector('.tx-jobchat', { timeout: 8000 });
  const sellerEnd = (await sp.innerText('.tx-delivery')).replace(/\s+/g, ' ');
  ok('seller, after the driver is credited: no payment instructions are repeated', !/Pay exactly|put MWK-/.test(sellerEnd) && /nothing more for you to do/.test(sellerEnd), sellerEnd.slice(0, 300));
  ok('seller: no "I paid the driver" step for a job paid through Mwakete; the fee line says so', !(await sp.$('#tx-action-buttons [data-action="markDriverPaid"]')) && /paid through Mwakete/.test(sellerEnd));
  ok('seller: the chat opens at the newest message', await sp.evaluate(() => { const l = document.querySelector('.tx-jc-list'); return l.scrollTop + l.clientHeight >= l.scrollHeight - 2; }));
  ok('seller: the whole history is in the chat (lock, payment, confirmation, credit)', /agreed and locked/.test(sellerEnd) && /sent to Mwakete/.test(sellerEnd) && /confirmed the payment/.test(sellerEnd) && /credited/.test(sellerEnd));
  await dp.reload({ waitUntil: 'load' });
  await dp.waitForSelector('#drv-wallet-body .kpi-card', { timeout: 8000 });
  const kp = (await dp.innerText('.kpi-grid')).replace(/\s+/g, ' ');
  ok('driver: the old "Marked paid by sellers" card is now "Paid out by Mwakete $6.00"', /Paid out by Mwakete \$6\.00/.test(kp) && !/Marked paid by sellers/.test(kp), kp);
  ok('driver: the balance history is a readable list (not a squashed table)', !!(await dp.$('#drv-wallet-body .drv-ledger li')) && !(await dp.$('#drv-wallet-body table')));
  ok('driver: past jobs say the fee was credited, not "Not marked paid yet"', /Credited to your balance/.test(await dp.innerText('#drv-hist')) && !/Not marked paid yet/.test(await dp.innerText('#drv-hist')));

  // 9. layout and errors
  for (const [ctx, url, who] of [[driverCtx, 'driver.html', 'driver'], [sellerCtx, `order-room.html?order=${orderId}&as=seller`, 'seller order room'], [buyerCtx, `order-room.html?order=${orderId}&as=buyer`, 'buyer order room']]) {
    const p = await page(ctx, url);
    await p.waitForTimeout(900);
    for (const wd of [320, 375, 430]) {
      await p.setViewportSize({ width: wd, height: 800 });
      const over = await p.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      ok(`${who}: no sideways scroll at ${wd}px`, over <= 1, String(over));
    }
    if (process.env.SHOT_DIR) { await p.setViewportSize({ width: 390, height: 844 }); await p.screenshot({ path: `${process.env.SHOT_DIR}/wallet-${who.replace(/ /g, '-')}.png`, fullPage: true }); }
  }
  if (process.env.SHOT_DIR) { await ap.screenshot({ path: process.env.SHOT_DIR + '/wallet-admin.png', fullPage: true }); }
  ok('no page errors', errors.length === 0, errors.join(' | ').slice(0, 400));
  await browser.close();
  let fails = 0;
  console.log('\n--- driver wallet end to end in the browser (real backend) ---');
  for (const [s, n, x] of R) { if (s === 'FAIL') fails++; console.log(`${s}  ${n}${x !== '' ? '  [' + x + ']' : ''}`); }
  console.log(`\n${R.length - fails}/${R.length} passed`);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
