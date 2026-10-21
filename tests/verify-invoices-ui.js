/**
 * Invoices & receipts, seller and buyer screens, in the browser on the REAL
 * backend: the seller's design page (switch on, template, colours, VAT check,
 * live preview of invoice and receipt, save); checkout's "I need an invoice"
 * box (only for a store that offers it); the seller's Orders card (request
 * flag, Send invoice, the invoice link, the receipt link once Paid); and the
 * order room showing the buyer their invoice. Phone and desktop.
 */
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const { makeBox } = require('./lib/gas-harness.js');
const BASE = process.env.TX_BASE || 'http://127.0.0.1:8099';
const SHOTS = process.env.CS_SHOTS || '';
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e === undefined ? '' : e]);
const FUT = new Date(Date.now() + 30 * 86400000).toISOString();

const box = makeBox({
  Owners: [['OwnerId', 'StoreSlug', 'StoreName', 'Email', 'Phone', 'Status', 'Island', 'Village', 'DeliveryPickPay', 'DeliveryTruck', 'DeliveryTruckCost', 'StoreType', 'BrandColor', 'LogoUrl', 'PaymentMethods', 'Username'],
    ['own_s', 'bong', 'Bong Store', 's@x.test', '73001111', 'active', 'South Tarawa', 'Bairiki', 'true', 'true', 5, 'retailer', '#0b3d91', 'https://res.cloudinary.com/x/bong.png', 'ib,mpaisa', 'bong']],
  Sessions: [['Token', 'OwnerId', 'CreatedAt', 'ExpiresAt'], ['tok-s', 'own_s', '', FUT]],
  Customers: [['CustomerId', 'Name', 'Email', 'Phone', 'EmailVerified', 'CreatedAt', 'UpdatedAt'], ['cus_b', 'Tia', 'tia@x.test', '73000001', 'yes', '', '']],
  CustomerSessions: [['Token', 'CustomerId', 'CreatedAt', 'ExpiresAt'], ['ctok-b', 'cus_b', '', FUT]],
  Products: [['ProductId', 'OwnerId', 'StoreSlug', 'Name', 'Description', 'Category', 'ListingType', 'Status', 'SortOrder', 'CreatedAt', 'UpdatedAt'],
    ['p_rice', 'own_s', 'bong', 'Rice', '10kg bag', 'home', 'product', 'active', 0, '', '']],
  Variants: [['VariantId', 'ProductId', 'OwnerId', 'Label', 'Price', 'SKU', 'StockQty', 'Status'], ['v_rice', 'p_rice', 'own_s', '10kg', 20, '', 1000, 'active']],
  Orders: [['OrderId', 'OwnerId', 'StoreSlug', 'CustomerName', 'CustomerPhone', 'CustomerEmail', 'Island', 'Village', 'DeliveryAddress',
    'DeliveryMethod', 'DeliveryCost', 'Notes', 'PaymentMethod', 'PaymentReference', 'ItemsJson', 'ItemsSummary', 'Subtotal', 'Total', 'Status', 'CreatedAt', 'UpdatedAt']],
  AbandonedCarts: [['CartId', 'StoreSlug', 'Email', 'ConvertedOrderId']]
}, { guest: true });
box.__props.SITE_BASE_URL = 'https://mwakete.com';
box.ContentService = { createTextOutput: (s) => ({ s, setMimeType() { return this; } }), MimeType: { JSON: 'json' } };
const clear = () => Object.keys(box.__cache).forEach((k) => delete box.__cache[k]);
const call = (b) => { clear(); try { return box.doPost({ postData: { contents: b } }).s; } catch (e) { return JSON.stringify({ ok: false, error: String(e.message || e) }); } };
const callGet = (url) => { clear(); const u = new URL(url); const p = {}; u.searchParams.forEach((v, k) => { p[k] = v; });
  try { return box.doGet({ parameter: p }).s; } catch (e) { return JSON.stringify({ ok: false, error: String(e.message || e) }); } };
const S = () => box.sheetToObjects(box.getSheet('Owners'))[0];
const orders = () => box.sheetToObjects(box.getSheet('Orders'));
const docs = () => (box.__sheets.Invoices ? box.__sheets.Invoices.objects() : []);
const settings = () => box.invSettings(S());

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const errors = [];
  const open = async (w, who) => {
    const ctx = await browser.newContext({ viewport: { width: w, height: 900 }, serviceWorkers: 'block' });
    await ctx.addInitScript((k) => {
      localStorage.setItem('skiri_cookie_consent', 'true');
      if (k === 'seller') {
        localStorage.setItem('skiri_owner_token', 'tok-s');
        localStorage.setItem('skiri_owner_profile', JSON.stringify({ ownerId: 'own_s', storeName: 'Bong Store', storeSlug: 'bong' }));
      }
      if (k === 'buyer') {
        localStorage.setItem('skiri_customer_token', 'ctok-b');
        localStorage.setItem('skiri_customer_profile', JSON.stringify({ name: 'Tia', email: 'tia@x.test' }));
        localStorage.setItem('skiri_active_store', 'bong');
        localStorage.setItem('skiri_cart_bong', JSON.stringify([{ variantId: 'v_rice', productId: 'p_rice', label: 'Rice', unitPrice: 20, qty: 2 }]));
      }
    }, who);
    await ctx.route('**/macros/s/**', (route) => { const req = route.request(); const b = req.postData(); route.fulfill({ status: 200, contentType: 'application/json', body: b ? call(b) : callGet(req.url()) }); });
    await ctx.route('https://res.cloudinary.com/**', (route) => route.fulfill({ status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="#0b3d91"/></svg>' }));
    const p = await ctx.newPage();
    p.on('pageerror', (e) => { if (!/sandboxed and lacks the 'allow-same-origin' flag/.test(String(e))) errors.push(String(e)); });
    p.on('dialog', (d) => d.accept());
    return { ctx, p };
  };
  const frameText = (p, sel) => p.evaluate((s) => { const d = document.querySelector(s).contentDocument; return d && d.body ? d.body.innerText : ''; }, sel);

  /* ---------- the seller's design page ---------- */
  let { ctx, p } = await open(1280, 'seller');
  await p.goto(BASE + '/owner/invoices.html', { waitUntil: 'load' });
  await p.waitForSelector('#iv-layout:not([hidden])', { timeout: 15000 });
  ok('the page opens off, Classic, in the store colour', !(await p.isChecked('#iv-enabled')) && await p.isChecked('input[name="iv-template"][value="classic"]') && (await p.inputValue('#iv-color')) === '#0b3d91');
  await p.waitForFunction(() => /INVOICE/.test((document.getElementById('iv-frame').srcdoc || '')), null, { timeout: 10000 });
  ok('a live preview of a sample invoice', /\(Sample\)/.test(await p.getAttribute('#iv-frame', 'srcdoc')) && (await p.getAttribute('#iv-frame', 'sandbox')) === '');
  ok('the seller menu links here', !!(await p.$('.seller-sidebar a[href="invoices.html"][aria-current="page"]')));
  await p.check('#iv-enabled');
  await p.check('input[name="iv-template"][value="modern"]');
  await p.evaluate(() => { const a = document.getElementById('iv-accent'); a.value = '#fcd116'; a.dispatchEvent(new Event('input', { bubbles: true })); });
  await p.waitForFunction(() => /border-radius:18px/.test(document.getElementById('iv-frame').srcdoc) && /#fcd116/.test(document.getElementById('iv-frame').srcdoc), null, { timeout: 10000 });
  ok('changing template and accent updates the preview at once', true);
  await p.click('.iv-tabs [data-kind="receipt"]');
  await p.waitForFunction(() => /RECEIPT/.test(document.getElementById('iv-frame').srcdoc), null, { timeout: 10000 });
  ok('...and it can show the receipt', /RCT-BONG-0001/.test(await p.getAttribute('#iv-frame', 'srcdoc')));
  await p.check('#iv-vat');
  ok('VAT fields appear when VAT is ticked', await p.isVisible('#iv-vatno'));
  await p.fill('#iv-bname', 'Bong Trading Ltd');
  await p.click('#iv-save');
  await p.waitForFunction(() => /VAT number/.test(document.getElementById('iv-error').textContent), null, { timeout: 10000 });
  ok('VAT without a VAT number is refused with a reason', !settings().enabled, settings().enabled);
  await p.fill('#iv-vatno', 'KV-12345');
  await p.fill('#iv-inote', 'Pay by MPaisa to 7300 1111.');
  await p.click('#iv-save');
  await p.waitForFunction(() => /Saved/.test(document.getElementById('iv-status').textContent), null, { timeout: 10000 });
  const s1 = settings();
  ok('Save stores everything on the server', s1.enabled && s1.template === 'modern' && s1.accent === '#fcd116' && s1.vatEnabled && s1.vatNumber === 'KV-12345' && s1.businessName === 'Bong Trading Ltd', JSON.stringify(s1));
  if (SHOTS) await p.screenshot({ path: SHOTS + '/iv-design.png', fullPage: false });
  await ctx.close();

  /* ---------- checkout ---------- */
  ({ ctx, p } = await open(390, 'buyer'));
  await p.goto(BASE + '/checkout.html', { waitUntil: 'load' });
  await p.waitForFunction(() => typeof storeInfo !== 'undefined' && storeInfo && storeInfo.storeName, null, { timeout: 15000 });
  ok('checkout offers "I need an invoice" for this store', await p.isVisible('#want-invoice'));
  await p.selectOption('#checkout-island', 'South Tarawa');
  await p.evaluate(() => { const vs = document.getElementById('checkout-village'); for (const o of vs.options) { if (o.value && o.value !== 'Other (please specify)') { vs.value = o.value; vs.dispatchEvent(new Event('change', { bubbles: true })); break; } } });
  await p.waitForSelector('input[name="deliveryMethod"]');
  await p.fill('#customer-name', 'Tia Ioane');
  await p.fill('#customer-phone', '7300001');
  await p.check('#want-invoice');
  if (SHOTS) await p.screenshot({ path: SHOTS + '/iv-checkout.png', fullPage: true });
  await p.click('#place-order-btn');
  await p.waitForFunction(() => document.getElementById('confirmation-section') && !document.getElementById('confirmation-section').classList.contains('hidden'), null, { timeout: 15000 }).catch(() => {});
  const placed = orders().slice(-1)[0];
  ok('the order is placed with the invoice request', placed && placed.InvoiceRequested === 'yes', JSON.stringify(placed && { id: placed.OrderId, req: placed.InvoiceRequested }));
  await ctx.close();

  /* ---------- the seller's Orders card ---------- */
  ({ ctx, p } = await open(390, 'seller'));
  await p.goto(BASE + '/owner/orders.html', { waitUntil: 'load' });
  await p.waitForSelector('.order-card', { timeout: 15000 });
  ok('the order shows the buyer asked for an invoice', /Buyer asked for an invoice/.test(await p.textContent('.order-card')));
  await p.click('[data-send-invoice]');
  await p.waitForSelector('.order-docs a[href*="invoice.html?d="]', { timeout: 15000 });
  ok('Send invoice issues INV-BONG-0001, linked from the card', /Invoice INV-BONG-0001/.test(await p.textContent('.order-docs')) && docs().some((d) => d.Number === 'INV-BONG-0001'));
  ok('...and emails the buyer', box.__mail.some((m) => m[0] === 'tia@x.test' && /Invoice INV-BONG-0001/.test(m[1])));
  ok('...and offers to send it again', /Send invoice again/.test(await p.textContent('.order-docs')));
  await p.selectOption('.order-status-select', 'Paid');
  await p.waitForFunction(() => /Receipt RCT-BONG-0001/.test(document.querySelector('.order-docs').textContent), null, { timeout: 15000 }).catch(() => {});
  ok('marking it Paid brings the receipt link (sent automatically)', /Receipt RCT-BONG-0001/.test(await p.textContent('.order-docs')) && box.__mail.some((m) => m[0] === 'tia@x.test' && /Receipt RCT-BONG-0001/.test(m[1])));
  const wide = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  ok('phone: no sideways scrolling', wide <= 1, wide);
  if (SHOTS) await p.screenshot({ path: SHOTS + '/iv-orders.png', fullPage: false });
  await ctx.close();

  /* ---------- the order room ---------- */
  box.__props.TX_ROOMS = 'on';
  clear();
  const roomOrder = box.actionCreateOrder({ storeSlug: 'bong', items: [{ variantId: 'v_rice', qty: 1 }], customerName: 'Tia', customerPhone: '73000001', customerEmail: 'tia@x.test',
    island: 'South Tarawa', village: 'Betio', deliveryMethod: 'pickPay', paymentMethod: '', wantInvoice: true, customerSession: 'ctok-b' });
  ({ ctx, p } = await open(390, 'buyer'));
  await p.goto(BASE + '/order-room.html?order=' + encodeURIComponent(roomOrder.orderId) + '&as=buyer', { waitUntil: 'load' });
  await p.waitForSelector('.tx-docs', { timeout: 15000 }).catch(() => {});
  ok('the buyer\'s order room says the invoice is coming', /You asked for an invoice/.test(await p.textContent('.tx-docs').catch(() => '')), roomOrder.orderId);
  box.actionSendInvoice(S(), { orderId: roomOrder.orderId });
  await p.reload({ waitUntil: 'load' });
  await p.waitForSelector('.tx-docs a[href*="invoice.html?d="]', { timeout: 15000 }).catch(() => {});
  ok('...and once sent, links to it', /Invoice INV-BONG-0002/.test(await p.textContent('.tx-docs').catch(() => '')));
  await ctx.close();

  ok('no page errors', errors.length === 0, errors.join(' | '));
  await browser.close();
  R.forEach((r) => console.log(r[0] + ' - ' + r[1] + (r[0] === 'FAIL' && r[2] !== '' ? ' :: ' + r[2] : '')));
  const failed = R.filter((r) => r[0] === 'FAIL').length;
  console.log(`\n${R.length - failed}/${R.length} passed`);
  process.exit(failed ? 1 : 0);
})();
