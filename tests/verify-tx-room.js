/**
 * Order rooms in the browser, END TO END: the real pages (order-room.html,
 * owner/orders.html, customer-dashboard.html, owner/admin.html) talking to the
 * REAL Apps Script sources running in gas-harness - every Api.post is routed
 * into doPost, so nothing in between is mocked. Journeys A (delivery),
 * B (collection), C (problem + admin decision) and D (security), plus upload
 * and message retry after a dropped connection, and the phone layout.
 */
const zlib = require('zlib');
const path = require('path');
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const { makeBox } = require('./lib/gas-harness.js');
const BASE = process.env.TX_BASE || 'http://127.0.0.1:8099';
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e === undefined ? '' : e]);
const J = (x) => JSON.stringify(x).slice(0, 300);
const FUTURE = new Date(Date.now() + 86400000 * 30).toISOString();

/* ---------- a real backend ---------- */
const ownerCols = ['OwnerId', 'StoreSlug', 'StoreName', 'Email', 'Status', 'Island', 'DeliveryPickPay', 'DeliveryTruck', 'DeliveryTruckCost', 'StoreType'];
const box = makeBox({
  Owners: [ownerCols, ['own_s', 'bong', 'Bong Store', 's@x.test', 'active', 'South Tarawa', 'true', 'true', 5, 'retailer'],
    ['own_a', 'mwakete-admin', 'Admin', 'admin@x.test', 'active', 'South Tarawa', '', '', '', 'retailer']],
  Sessions: [['Token', 'OwnerId', 'CreatedAt', 'ExpiresAt'], ['tok-seller', 'own_s', '', FUTURE], ['tok-admin', 'own_a', '', FUTURE]],
  Customers: [['CustomerId', 'Name', 'Email', 'Phone', 'EmailVerified', 'CreatedAt', 'UpdatedAt'], ['cus_b', 'Tia', 'b@x.test', '73000001', 'yes', '', ''],
    ['cus_z', 'Zed', 'z@x.test', '73000002', 'yes', '', '']],
  CustomerSessions: [['Token', 'CustomerId', 'CreatedAt', 'ExpiresAt'], ['ctok-b', 'cus_b', '', FUTURE], ['ctok-z', 'cus_z', '', FUTURE]],
  Products: [['ProductId', 'OwnerId', 'StoreSlug', 'Name', 'Description', 'Category', 'ListingType', 'Status', 'SortOrder', 'CreatedAt', 'UpdatedAt'],
    ['p_rice', 'own_s', 'bong', 'Rice', '10kg bag', 'food', 'product', 'active', 0, '', ''], ['p_phone', 'own_s', 'bong', 'Phone', 'Smartphone', 'electronics', 'product', 'active', 1, '', '']],
  Variants: [['VariantId', 'ProductId', 'OwnerId', 'Label', 'Price', 'SKU', 'StockQty', 'Status'],
    ['v_rice', 'p_rice', 'own_s', '10kg', 20, '', 500, 'active'], ['v_phone', 'p_phone', 'own_s', 'Black', 150, '', 50, 'active']],
  Orders: [['OrderId', 'OwnerId', 'StoreSlug', 'CustomerName', 'CustomerPhone', 'CustomerEmail', 'Island', 'Village', 'DeliveryAddress',
    'DeliveryMethod', 'DeliveryCost', 'Notes', 'PaymentMethod', 'PaymentReference', 'ItemsJson', 'ItemsSummary', 'Subtotal', 'Total', 'Status', 'CreatedAt', 'UpdatedAt']],
  AbandonedCarts: [['CartId', 'StoreSlug', 'Email', 'ConvertedOrderId']]
});
box.__props.ADMIN_EMAILS = 'admin@x.test';
box.__props.TX_ROOMS = 'on';
box.ContentService = { createTextOutput: (s) => ({ s, setMimeType() { return this; } }), MimeType: { JSON: 'json' } };
const backend = (body) => { Object.keys(box.__cache).filter((k) => k.indexOf('ratelimit') === 0).forEach((k) => delete box.__cache[k]); return JSON.parse(box.doPost({ postData: { contents: body } }).s); };
const order = (extra) => box.actionCreateOrder(Object.assign({ storeSlug: 'bong', items: [{ variantId: 'v_rice', qty: 1 }], customerName: 'Tia', customerPhone: '73000001',
  customerEmail: 'b@x.test', island: 'South Tarawa', village: 'Betio', deliveryMethod: 'truck' }, extra || {})).orderId;
const status = (id) => box.__sheets.Orders.objects().find((o) => o.OrderId === id).Status;
const stateOf = (id) => box.__sheets.TxState.objects().find((s) => s.OrderId === id);

/* ---------- real image files ---------- */
const CRC = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function realPng(w, h, seed) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = y * (w * 3 + 1) + 1 + x * 3; raw[i] = (x + seed) & 255; raw[i + 1] = (y * 2) & 255; raw[i + 2] = (x * y + seed) & 255; }
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
let seed = 0;
const file = (name) => ({ name: name || 'photo.png', mimeType: 'image/png', buffer: realPng(640, 480, ++seed * 17) });

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const errors = [];
  let failNext = {};
  let calls = [];
  async function ctxFor(storage, viewport) {
    const ctx = await browser.newContext({ viewport: viewport || { width: 390, height: 844 }, serviceWorkers: 'block' });
    await ctx.addInitScript((s) => { Object.entries(s).forEach(([k, v]) => localStorage.setItem(k, v)); }, storage);
    await ctx.route('**/macros/s/**', async (route) => {
      const req = route.request();
      if (req.method() !== 'POST') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, products: [], stores: [] }) });
      const body = req.postData();
      const action = JSON.parse(body).action;
      calls.push(action);
      if (failNext[action]) { failNext[action]--; return route.abort('failed'); }
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(backend(body)) });
    });
    return ctx;
  }
  const page = async (ctx, url) => {
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(String(e)));
    p.on('dialog', (d) => d.accept(d.type() === 'prompt' ? 'Shows the full account number' : undefined));
    await p.goto(BASE + '/' + url, { waitUntil: 'load' });
    return p;
  };
  const BUYER = { skiri_customer_token: 'ctok-b', skiri_customer_profile: JSON.stringify({ name: 'Tia', email: 'b@x.test' }) };
  const SELLER = { skiri_owner_token: 'tok-seller', skiri_owner_profile: JSON.stringify({ storeName: 'Bong Store', storeSlug: 'bong' }) };
  const ADMIN = { skiri_owner_token: 'tok-admin', skiri_owner_profile: JSON.stringify({ storeName: 'Admin', storeSlug: 'mwakete-admin' }) };
  const buyerCtx = await ctxFor(BUYER), sellerCtx = await ctxFor(SELLER), adminCtx = await ctxFor(ADMIN, { width: 1280, height: 900 });
  const action = (p, name) => p.click(`#tx-action-buttons [data-action="${name}"]`);
  const save = async (p) => { await p.click('#tx-form button[type="submit"]'); await p.waitForFunction(() => !document.querySelector('#tx-form') || document.querySelector('#tx-form-error').textContent, null, { timeout: 8000 }); };
  const uploadIn = async (p, sel, files) => { await p.setInputFiles(sel, files); await p.waitForFunction((n) => document.querySelectorAll('.tx-upload.is-saved').length >= n, files.length, { timeout: 10000 }); };
  const stage = (p) => p.$eval('.tx-stage', (e) => e.textContent.trim());
  const reopen = async (p) => { await p.reload({ waitUntil: 'load' }); await p.waitForSelector('#tx-body:not([hidden])', { timeout: 8000 }); };

  /* ===== Journey A: delivery ===== */
  const a = order({ items: [{ variantId: 'v_phone', qty: 1 }] });
  let bp = await page(buyerCtx, `order-room.html?order=${a}&as=buyer`);
  await bp.waitForSelector('#tx-body:not([hidden])', { timeout: 8000 });
  ok('A: buyer opens the linked room: ref, item, quantity, stage', (await bp.textContent('#tx-title')) === 'Order ' + a && /1 ×\s*Phone/.test(await bp.textContent('.tx-items'))
    && /Payment not yet confirmed/.test(await stage(bp)));
  ok('A: the payment prompt is shown as an automatic message', await bp.$$eval('.tx-event.is-system', (els) => els.some((e) => /hide sensitive banking information/.test(e.textContent) && /Automatic message/.test(e.textContent))));
  ok('A: status is written out, not colour only', /Payment not yet confirmed/.test(await bp.textContent('.tx-states')) && /Receipt not confirmed/.test(await bp.textContent('.tx-states')));
  await action(bp, 'submitPayment');
  await bp.fill('#f-reference', 'TRF-555');
  await bp.fill('#f-amount', '155');
  failNext.uploadTxEvidence = 1;
  await bp.setInputFiles('#f-files-input', [file('receipt.png')]);
  await bp.waitForSelector('.tx-upload.is-failed', { timeout: 8000 });
  ok('upload: a dropped connection shows "Not uploaded" with Retry - nothing claimed', /Not uploaded/.test(await bp.textContent('#f-files')) && !!(await bp.$('#f-files [data-retry]')));
  await bp.click('#tx-form button[type="submit"]');
  ok('upload: the form will not submit with a failed file', /did not upload/.test(await bp.textContent('#tx-form-error')));
  await bp.click('#f-files [data-retry]');
  await bp.waitForSelector('.tx-upload.is-saved', { timeout: 8000 });
  ok('upload: Retry succeeds and shows Saved only after the server confirmed', /Saved/.test(await bp.textContent('#f-files')));
  ok('upload: the retry made one record, not two', box.__sheets.TxEvidence.objects().filter((e) => e.OrderId === a).length === 1);
  const stored = box.__sheets.TxEvidence.objects().find((e) => e.OrderId === a);
  ok('upload: the phone sent a thumbnail and the server kept the file privately', !!stored.ThumbFileId && Object.values(box.__drive.files).every((f) => f.sharing === null));
  await save(bp);
  await bp.waitForFunction(() => /Payment details sent/.test(document.querySelector('.tx-stage').textContent), null, { timeout: 8000 });
  ok('A: buyer sends payment details; the order is NOT marked paid', status(a) === 'Pending Payment' && stateOf(a).PaymentState === 'submitted');
  await bp.waitForSelector('img[data-thumb][src^="blob:"]', { timeout: 8000 });
  ok('A: the receipt preview loads through the signed-in file request (thumbnail)', calls.filter((c) => c === 'getTxEvidence').length >= 1);

  let sp = await page(sellerCtx, `order-room.html?order=${a}&as=seller`);
  await sp.waitForSelector('#tx-body:not([hidden])', { timeout: 8000 });
  ok('A: seller sees the payment details and is told to check their own account', /TRF-555/.test(await sp.textContent('#tx-summary')) && /Check your own bank/.test(await sp.textContent('#tx-next-hint')));
  await action(sp, 'verifyPayment');
  await sp.check('#f-res-v');
  await sp.fill('#f-reference', 'TRF-555');
  await sp.fill('#f-amount', '155');
  await save(sp);
  ok('A: verifying without ticking "I checked my own account" is refused', /checking your own bank/.test(await sp.textContent('#tx-form-error')) && status(a) === 'Pending Payment');
  await sp.check('#f-checked');
  await save(sp);
  await sp.waitForFunction(() => /Payment confirmed/.test(document.querySelector('.tx-states').textContent), null, { timeout: 8000 });
  ok('A: seller verifies -> Paid', status(a) === 'Paid');
  await action(sp, 'checklist');
  await sp.check('#f-line-0');
  await save(sp);
  ok('A: electronics need a goods photo - the server says so and nothing is saved', /photo of the actual goods/.test(await sp.textContent('#tx-form-error')) && stateOf(a).FulfilmentState === '');
  ok('A: the requirement was shown before saving', /Required/.test(await sp.textContent('.tx-reqs')));
  await uploadIn(sp, '#f-files-input', [file('goods.png')]);
  await save(sp);
  await sp.waitForFunction(() => /Being prepared/.test(document.querySelector('.tx-states').textContent), null, { timeout: 8000 });
  ok('A: checklist with photo recorded', stateOf(a).FulfilmentState === 'preparing');
  await action(sp, 'dispatch');
  await sp.fill('#f-provider', 'Island Freight');
  await save(sp);
  await sp.waitForFunction(() => /Sent by the seller/.test(document.querySelector('.tx-states').textContent), null, { timeout: 8000 });
  ok('A: dispatch recorded (photo recommended, not required, for this value)', stateOf(a).FulfilmentState === 'dispatched' && status(a) === 'Paid');
  await reopen(bp);
  ok('A: buyer is asked to confirm receipt', !!(await bp.$('#tx-action-buttons [data-action="confirmReceipt"]')) && /does not by itself confirm delivery/.test(await bp.textContent('#tx-timeline')));
  await action(bp, 'confirmReceipt');
  await bp.check('#f-ch-ok');
  await save(bp);
  await bp.waitForFunction(() => /Completed/.test(document.querySelector('.tx-stage').textContent), null, { timeout: 8000 });
  ok('A: buyer confirms receipt -> Completed', status(a) === 'Fulfilled');

  /* ===== Journey B: collection ===== */
  const b = order({ deliveryMethod: 'pickPay' });
  sp = await page(sellerCtx, `order-room.html?order=${b}&as=seller`);
  await sp.waitForSelector('#tx-body:not([hidden])', { timeout: 8000 });
  await action(sp, 'checklist');
  await sp.check('#f-line-0');
  await save(sp);
  await sp.waitForSelector('.tx-warn', { timeout: 8000 });
  ok('B: low-value checklist saves without a photo, with a "recommended" note', /Recommended/.test(await sp.textContent('#tx-action-panel')) && stateOf(b).FulfilmentState === 'preparing');
  await action(sp, 'markReady');
  await sp.fill('#f-instructions', 'Collect at the Bairiki counter');
  await save(sp);
  await sp.waitForFunction(() => /Ready for collection/.test(document.querySelector('.tx-states').textContent), null, { timeout: 8000 });
  bp = await page(buyerCtx, `order-room.html?order=${b}&as=buyer`);
  await bp.waitForSelector('#tx-body:not([hidden])', { timeout: 8000 });
  ok('B: buyer sees the collection instructions and the collection prompt', /Bairiki counter/.test(await bp.textContent('#tx-summary')) && /ready for collection/i.test(await bp.textContent('#tx-timeline')));
  failNext.sendTxMessage = 1;
  await bp.fill('#tx-message', 'I will come at 11 on Friday');
  await bp.click('#tx-composer button[type="submit"]');
  await bp.waitForSelector('.tx-event.is-pending [data-retry-msg]', { timeout: 8000 });
  ok('messages: a message that did not go is marked "Not sent" with Retry', /Not sent/.test(await bp.textContent('.tx-event.is-pending')));
  await bp.click('[data-retry-msg]');
  await bp.waitForFunction(() => !document.querySelector('.tx-event.is-pending') && /11 on Friday/.test(document.querySelector('#tx-timeline').textContent), null, { timeout: 8000 });
  ok('messages: Retry sends it once', box.__sheets.TxEvents.objects().filter((e) => e.OrderId === b && /11 on Friday/.test(e.Body)).length === 1);
  await reopen(sp);
  ok('B: the seller sees the buyer\'s message', /11 on Friday/.test(await sp.textContent('#tx-timeline')));
  await action(sp, 'handover');
  await sp.check('#f-cash');
  await sp.fill('#f-amount', '20');
  await save(sp);
  await sp.waitForFunction(() => /Handed over/.test(document.querySelector('.tx-states').textContent), null, { timeout: 8000 });
  ok('B: handover with cash records payment and handover', stateOf(b).PaymentState === 'verified' && stateOf(b).FulfilmentState === 'handed_over');
  await reopen(bp);
  await action(bp, 'confirmReceipt');
  await bp.check('#f-ch-ok');
  await save(bp);
  await bp.waitForFunction(() => /Completed/.test(document.querySelector('.tx-stage').textContent), null, { timeout: 8000 });
  ok('B: buyer confirms collection -> Completed', status(b) === 'Fulfilled');

  /* ===== Journey C: problem and decision ===== */
  const c = order();
  box.actionTxSubmitPayment({ side: 'buyer', token: 'ctok-b', orderId: c, method: 'bank_transfer', reference: 'TRF-C' });
  box.actionTxVerifyPayment({ side: 'seller', token: 'tok-seller', orderId: c, result: 'verified', checkedSource: true, method: 'bank_transfer', reference: 'TRF-C', amountReceived: 25 });
  box.actionTxChecklist({ side: 'seller', token: 'tok-seller', orderId: c, checklist: { lines: [{ index: 0, ok: true }] } });
  box.actionTxDispatch({ side: 'seller', token: 'tok-seller', orderId: c, dispatch: { date: new Date().toISOString().slice(0, 10) } });
  bp = await page(buyerCtx, `order-room.html?order=${c}&as=buyer`);
  await bp.waitForSelector('#tx-body:not([hidden])', { timeout: 8000 });
  await action(bp, 'confirmReceipt');
  await bp.check('#f-ch-problem');
  ok('C: choosing "there is a problem" reveals the problem type', await bp.isVisible('#f-category'));
  await bp.selectOption('#f-category', 'damaged');
  await bp.fill('#f-note', 'The bag was torn open and rice spilled.');
  await save(bp);
  ok('C: a damage report without a photo is refused', /at least one photo/.test(await bp.textContent('#tx-form-error')));
  await uploadIn(bp, '#f-files-input', [file('damage.png')]);
  await save(bp);
  await bp.waitForSelector('#tx-dispute:not([hidden])', { timeout: 8000 });
  ok('C: the problem is shown at the top of the room', /Goods damaged/.test(await bp.textContent('#tx-dispute')) && status(c) === 'Paid');
  sp = await page(sellerCtx, `order-room.html?order=${c}&as=seller`);
  await sp.waitForSelector('#tx-dispute:not([hidden])', { timeout: 8000 });
  ok('C: the seller sees it and cannot cancel while it is open', !(await sp.$('#tx-action-buttons [data-action="cancel"]')));
  await action(sp, 'respondDispute');
  await sp.fill('#f-text', 'Packed in a double bag - see photo.');
  await uploadIn(sp, '#f-files-input', [file('packing.png')]);
  await save(sp);
  await sp.waitForFunction(() => /Being reviewed/.test(document.querySelector('#tx-dispute').textContent), null, { timeout: 8000 });
  ok('C: seller replies with a photo -> under review', box.__sheets.TxDisputes.objects().find((d) => d.OrderId === c).Status === 'under_review');
  const ap = await page(adminCtx, 'owner/admin.html');
  await ap.waitForSelector('#txa-list li', { timeout: 10000 });
  ok('C: the admin page lists the open problem with a link to its room', (await ap.$eval('#txa-list', (e) => e.textContent)).includes(c) && !!(await ap.$(`#txa-list a[href*="as=admin"]`)));
  await ap.click('#txc-details summary');
  await ap.waitForSelector('#txc-fields .field', { timeout: 8000 });
  ok('settings: the admin sees the evidence rules, limits and retention settings', (await ap.$$('#txc-fields .field')).length === Object.keys(box.TX_CONFIG_SPEC).length);
  const arp = await page(adminCtx, `order-room.html?order=${c}&as=admin`);
  await arp.waitForSelector('#tx-body:not([hidden])', { timeout: 8000 });
  ok('C: admin room shows both sides, the buyer details and every photo', /Tia/.test(await arp.textContent('#tx-summary')) && (await arp.$$('.tx-file')).length >= 2);
  await action(arp, 'adminDispute');
  await arp.selectOption('#f-act', 'resolve');
  await arp.selectOption('#f-outcome', 'no_fault');
  await arp.fill('#f-note', 'Carrier confirmed the damage happened in transit; nobody at fault.');
  await save(arp);
  await arp.waitForFunction(() => /Problem resolved/.test(document.querySelector('#tx-dispute').textContent), null, { timeout: 8000 });
  ok('C: admin records the decision with reasons; both sides see it', /No fault found/.test(await arp.textContent('#tx-dispute')) && (await reopen(bp), /No fault found/.test(await bp.textContent('#tx-dispute'))));
  await arp.click('[data-redact]');
  await arp.waitForFunction(() => /removed/.test(document.querySelector('#tx-timeline').textContent), null, { timeout: 8000 });
  ok('C: admin can remove a file that shows too much (record kept)', box.__sheets.TxEvidence.objects().some((e) => e.OrderId === c && e.DeletedAt));

  /* ===== Journey D: security ===== */
  const strangerCtx = await ctxFor({ skiri_customer_token: 'ctok-z' });
  const zp = await page(strangerCtx, `order-room.html?order=${a}&as=buyer`);
  await zp.waitForFunction(() => /Order not found/.test(document.querySelector('#tx-status').textContent), null, { timeout: 8000 });
  ok('D: another customer gets "Order not found" and sees nothing', await zp.$eval('#tx-body', (e) => e.hidden) && !(await zp.textContent('body')).includes('TRF-555'));
  const anonCtx = await ctxFor({});
  const np = await page(anonCtx, `order-room.html?order=${a}&as=buyer`);
  await np.waitForSelector('#tx-signin:not([hidden])', { timeout: 8000 });
  ok('D: signed out -> asked to sign in with the order\'s email, returning here after', (await np.getAttribute('#tx-signin-link', 'href')).startsWith('customer-login.html?next=order-room.html'));
  const sellerAsAdmin = await ctxFor(SELLER);
  const sap = await page(sellerAsAdmin, `order-room.html?order=${c}&as=admin`);
  await sap.waitForFunction(() => /Not authorized/.test(document.querySelector('#tx-status').textContent), null, { timeout: 8000 });
  ok('D: a seller cannot open the admin view', await sap.$eval('#tx-body', (e) => e.hidden));

  /* ===== lists ===== */
  const ol = await page(sellerCtx, 'owner/orders.html');
  await ol.waitForSelector('.order-card', { timeout: 10000 });
  const card = await ol.$eval(`.order-card[data-order-id="${a}"]`, (el) => ({ link: !!el.querySelector('a.order-room-link[href*="as=seller"]'), select: !!el.querySelector('select'), stage: el.textContent }));
  ok('lists: seller Orders page links each order to its room; no dropdown for a room order', card.link && !card.select && /Completed/.test(card.stage), J(card));
  const dash = await page(buyerCtx, 'customer-dashboard.html');
  await dash.waitForSelector(`.dash-item[data-order-id="${a}"] .order-room-link`, { timeout: 10000 });
  ok('lists: the buyer\'s account links each order to its room', true);

  /* ===== phone layout and low bandwidth ===== */
  await reopen(bp);
  const overflow = await bp.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  ok('phone: no sideways scrolling at 390px', overflow <= 1, String(overflow));
  const small = await bp.$$eval('#tx-action-buttons .btn', (bs) => bs.filter((b) => b.getBoundingClientRect().height < 44).length);
  ok('phone: step buttons are at least 44px tall', small === 0, String(small));
  calls = [];
  await bp.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await bp.waitForTimeout(500);
  ok('polling: a quiet room costs one small request', calls.filter((x) => x === 'getTxRoom').length === 1);
  ok('privacy: nothing about the order is kept in localStorage', await bp.evaluate(() => !Object.keys(localStorage).some((k) => /tx|order/i.test(k) && !/token|profile/.test(k))));

  if (process.env.SHOT_DIR) {
    await bp.screenshot({ path: process.env.SHOT_DIR + '/tx-buyer-phone.png', fullPage: true });
    await arp.screenshot({ path: process.env.SHOT_DIR + '/tx-admin-desktop.png', fullPage: true });
    const sp2 = await page(sellerCtx, `order-room.html?order=${order({ items: [{ variantId: 'v_phone', qty: 1 }] })}&as=seller`);
    await sp2.waitForSelector('#tx-body:not([hidden])', { timeout: 8000 });
    await sp2.click('#tx-action-buttons [data-action="checklist"]');
    await sp2.screenshot({ path: process.env.SHOT_DIR + '/tx-seller-checklist-phone.png', fullPage: true });
  }
  ok('no page errors', errors.length === 0, errors.join(' | ').slice(0, 300));
  await browser.close();
  let fails = 0;
  console.log('\n--- order rooms in the browser (real backend) ---');
  for (const [s, n, x] of R) { if (s === 'FAIL') fails++; console.log(`${s}  ${n}${x !== '' ? '  [' + x + ']' : ''}`); }
  console.log(`\n${R.length - fails}/${R.length} passed`);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
