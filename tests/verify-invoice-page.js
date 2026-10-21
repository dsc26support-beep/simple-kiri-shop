/**
 * The invoice / receipt page (invoice.html) in the browser, on the REAL
 * backend: a document issued by the store opens from its token with the
 * "genuine" banner, the document in a script-free frame, the QR code (with the
 * store logo in its middle) pointing back at this page, the faint logo
 * watermark, and Print / save as PDF. A wrong token says it may be a fake.
 * All three templates, phone and desktop.
 */
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const { makeBox } = require('./lib/gas-harness.js');
const BASE = process.env.TX_BASE || 'http://127.0.0.1:8099';
const SHOTS = process.env.CS_SHOTS || '';
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e === undefined ? '' : e]);
const LOGO = 'https://res.cloudinary.com/x/bong.png';

const box = makeBox({
  Owners: [['OwnerId', 'StoreSlug', 'StoreName', 'Email', 'Phone', 'Status', 'Island', 'DeliveryPickPay', 'DeliveryTruck', 'DeliveryTruckCost', 'StoreType', 'BrandColor', 'LogoUrl', 'PaymentMethods'],
    ['own_s', 'bong', 'Bong Store', 's@x.test', '73001111', 'active', 'South Tarawa', 'true', 'true', 5, 'retailer', '#0b3d91', LOGO, 'ib,mpaisa,cash']],
  Products: [['ProductId', 'OwnerId', 'StoreSlug', 'Name', 'Description', 'Category', 'ListingType', 'Status', 'SortOrder', 'CreatedAt', 'UpdatedAt'],
    ['p_rice', 'own_s', 'bong', 'Rice', '10kg bag', 'home', 'product', 'active', 0, '', '']],
  Variants: [['VariantId', 'ProductId', 'OwnerId', 'Label', 'Price', 'SKU', 'StockQty', 'Status'], ['v_rice', 'p_rice', 'own_s', '10kg', 20, '', 1000, 'active']],
  Orders: [['OrderId', 'OwnerId', 'StoreSlug', 'CustomerName', 'CustomerPhone', 'CustomerEmail', 'Island', 'Village', 'DeliveryAddress',
    'DeliveryMethod', 'DeliveryCost', 'Notes', 'PaymentMethod', 'PaymentReference', 'ItemsJson', 'ItemsSummary', 'Subtotal', 'Total', 'Status', 'CreatedAt', 'UpdatedAt']],
  AbandonedCarts: [['CartId', 'StoreSlug', 'Email', 'ConvertedOrderId']]
});
box.__props.SITE_BASE_URL = 'https://mwakete.com';
box.ContentService = { createTextOutput: (s) => ({ s, setMimeType() { return this; } }), MimeType: { JSON: 'json' } };
const S = () => box.sheetToObjects(box.getSheet('Owners'))[0];
const tokens = {};
for (const t of ['classic', 'modern', 'minimal']) {
  box.actionSaveInvoiceSettings(S(), { enabled: true, template: t, accent: '#fcd116', businessName: 'Bong Trading Ltd', businessAddress: 'Bairiki, Tarawa',
    vatEnabled: true, vatNumber: 'KV-12345', vatRate: 12.5, invoiceNote: 'Thank you - pay by MPaisa to 7300 1111 with your order number.' });
  Object.keys(box.__cache).forEach((k) => delete box.__cache[k]);
  const o = box.actionCreateOrder({ storeSlug: 'bong', items: [{ variantId: 'v_rice', qty: 2 }], customerName: 'Tia Ioane', customerPhone: '73000001',
    customerEmail: 'tia@x.test', island: 'South Tarawa', village: 'Betio', deliveryMethod: 'truck', paymentMethod: '', wantInvoice: true });
  tokens[t] = box.actionSendInvoice(S(), { orderId: o.orderId }).document.token;
  if (t === 'modern') { box.actionUpdateOrderStatus(S(), { orderId: o.orderId, status: 'Paid' }); tokens.receipt = box.sheetToObjects(box.getSheet('Invoices')).find((d) => d.Kind === 'receipt').Token; }
}
const callGet = (url) => {
  const u = new URL(url); const p = {}; u.searchParams.forEach((v, k) => { p[k] = v; });
  try { return box.doGet({ parameter: p }).s; } catch (e) { return JSON.stringify({ ok: false, error: String(e.message || e) }); }
};
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const errors = [];
  const open = async (w) => {
    const ctx = await browser.newContext({ viewport: { width: w, height: 900 }, serviceWorkers: 'block' });
    await ctx.addInitScript(() => { localStorage.setItem('skiri_cookie_consent', 'true'); });
    await ctx.route('**/macros/s/**', (route) => {
      const req = route.request(); const b = req.postData();
      route.fulfill({ status: 200, contentType: 'application/json', body: b ? '{"ok":false}' : callGet(req.url()) });
    });
    await ctx.route('https://res.cloudinary.com/**', (route) => route.fulfill({ status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="60" height="60"><rect width="60" height="60" rx="12" fill="#0b3d91"/><circle cx="30" cy="30" r="14" fill="#fcd116"/></svg>' }));
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(String(e)));
    return { ctx, p };
  };
  const frameText = (p) => p.evaluate(() => document.getElementById('inv-frame').contentDocument.body.innerText);

  let { ctx, p } = await open(1280);
  await p.goto(BASE + '/invoice.html?d=' + tokens.classic, { waitUntil: 'load' });
  await p.waitForSelector('#inv-genuine:not([hidden])', { timeout: 15000 });
  ok('the genuine banner names the document and the store', /Genuine Mwakete invoice.*INV-BONG-0001.*Bong Trading Ltd/.test(await p.textContent('#inv-genuine')), await p.textContent('#inv-genuine'));
  await p.waitForFunction(() => { const d = document.getElementById('inv-frame').contentDocument; return d && d.querySelector('.inv-qr svg'); }, null, { timeout: 10000 });
  const t = await frameText(p);
  ok('the invoice: number, items, total, VAT, due date, payment options, note', /INV-BONG-0001/.test(t) && /Rice/.test(t) && /\$45\.00/.test(t) && /Includes VAT \(12\.5%\)/.test(t)
    && /Pay by/.test(t) && /IB, MPaisa, Cash/.test(t) && /pay by MPaisa/.test(t), t.slice(0, 300));
  ok('the frame runs no scripts (sandboxed)', (await p.getAttribute('#inv-frame', 'sandbox')) === 'allow-same-origin');
  const qr = await p.evaluate(() => { const d = document.getElementById('inv-frame').contentDocument; const s = d.querySelector('.inv-qr svg'); const logo = d.querySelector('.inv-qr img');
    return { rects: s ? s.querySelectorAll('rect, path').length : 0, logo: logo && logo.src, mark: d.querySelector('.inv-watermark') && d.querySelector('.inv-watermark').style.backgroundImage }; });
  ok('a QR code is drawn, with the store logo in the middle', qr.rects > 0 && qr.logo === LOGO, JSON.stringify(qr));
  ok('the store logo is printed faintly behind the document', /bong\.png/.test(qr.mark || ''), qr.mark);
  ok('Print or save as PDF is offered', await p.isVisible('#inv-print'));
  if (SHOTS) await p.screenshot({ path: SHOTS + '/inv-classic.png', fullPage: true });
  await ctx.close();

  for (const t2 of ['modern', 'minimal', 'receipt']) {
    ({ ctx, p } = await open(1280));
    await p.goto(BASE + '/invoice.html?d=' + tokens[t2], { waitUntil: 'load' });
    await p.waitForFunction(() => { const d = document.getElementById('inv-frame').contentDocument; return d && d.querySelector('.inv-qr svg'); }, null, { timeout: 15000 });
    const txt = await frameText(p);
    if (t2 === 'receipt') ok('the receipt: RCT number, PAID, total paid, its invoice', /RCT-BONG-0001/.test(txt) && /PAID/.test(txt) && /Total paid/.test(txt) && /INV-BONG-0002/.test(txt), txt.slice(0, 300));
    else ok(`${t2} template opens`, new RegExp('inv-' + t2).test(await p.evaluate(() => document.getElementById('inv-frame').contentDocument.querySelector('.inv-doc').className)));
    if (SHOTS) await p.screenshot({ path: SHOTS + '/inv-' + t2 + '.png', fullPage: true });
    await ctx.close();
  }

  /* ---------- the QR points back at this page ---------- */
  ({ ctx, p } = await open(390));
  await p.goto(BASE + '/invoice.html?d=' + tokens.minimal, { waitUntil: 'load' });
  await p.waitForFunction(() => { const d = document.getElementById('inv-frame').contentDocument; return d && d.querySelector('.inv-qr svg'); }, null, { timeout: 15000 });
  const wide = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  ok('phone: no sideways scrolling', wide <= 1, wide);
  if (SHOTS) await p.screenshot({ path: SHOTS + '/inv-phone.png', fullPage: true });
  await ctx.close();

  ({ ctx, p } = await open(390));
  await p.goto(BASE + '/invoice.html?d=' + 'f'.repeat(40), { waitUntil: 'load' });
  await p.waitForFunction(() => /fake|not complete|Could not/.test(document.getElementById('inv-status').textContent), null, { timeout: 10000 });
  ok('an unknown code says it may be a fake, and shows nothing', /may be a fake/.test(await p.textContent('#inv-status')) && await p.isHidden('#inv-frame'));
  await p.goto(BASE + '/invoice.html', { waitUntil: 'load' });
  ok('no code at all: asks to open the link again', /not complete/.test(await p.textContent('#inv-status')));
  await ctx.close();

  ok('no page errors', errors.length === 0, errors.join(' | '));
  await browser.close();
  R.forEach((r) => console.log(r[0] + ' - ' + r[1] + (r[0] === 'FAIL' && r[2] !== '' ? ' :: ' + r[2] : '')));
  const failed = R.filter((r) => r[0] === 'FAIL').length;
  console.log(`\n${R.length - failed}/${R.length} passed`);
  process.exit(failed ? 1 : 0);
})();
