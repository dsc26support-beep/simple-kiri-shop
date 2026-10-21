/**
 * Invoices and receipts (Invoices.gs) on the REAL backend sources: settings
 * and their checks, the checkout request, store-prefixed numbering (unique
 * across stores, never repeating), the seller sending an invoice only when
 * asked, the automatic receipt when an order becomes Paid - from the status
 * dropdown and from the order room's payment check - the public document page
 * behind the QR code, VAT shown as included, the three templates, and escaping.
 */
const { makeBox } = require('./lib/gas-harness.js');
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e === undefined ? '' : e]);
const J = (x) => JSON.stringify(x).slice(0, 300);
const FUT = new Date(Date.now() + 30 * 86400000).toISOString();

const box = makeBox({
  Owners: [['OwnerId', 'StoreSlug', 'StoreName', 'Email', 'Phone', 'Status', 'Island', 'DeliveryPickPay', 'DeliveryTruck', 'DeliveryTruckCost', 'StoreType', 'BrandColor', 'LogoUrl', 'PaymentMethods'],
    ['own_s', 'bong', 'Bong Store', 's@x.test', '73001111', 'active', 'South Tarawa', 'true', 'true', 5, 'retailer', '#0b3d91', 'https://res.cloudinary.com/x/bong.png', 'ib,mpaisa'],
    ['own_b', 'bong-2', 'Bong Two', 'b2@x.test', '73002222', 'active', 'South Tarawa', 'true', 'true', 5, 'retailer', '', '', ''],
    ['own_o', 'other', 'Other Store', 'o@x.test', '73003333', 'active', 'South Tarawa', 'true', 'true', 5, 'retailer', '', '', '']],
  Sessions: [['Token', 'OwnerId', 'CreatedAt', 'ExpiresAt'], ['tok-s', 'own_s', '', FUT], ['tok-o', 'own_o', '', FUT]],
  Customers: [['CustomerId', 'Name', 'Email', 'Phone', 'EmailVerified', 'CreatedAt', 'UpdatedAt'], ['cus_b', 'Tia', 'tia@x.test', '73000001', 'yes', '', '']],
  CustomerSessions: [['Token', 'CustomerId', 'CreatedAt', 'ExpiresAt'], ['ctok-b', 'cus_b', '', FUT]],
  Products: [['ProductId', 'OwnerId', 'StoreSlug', 'Name', 'Description', 'Category', 'ListingType', 'Status', 'SortOrder', 'CreatedAt', 'UpdatedAt'],
    ['p_rice', 'own_s', 'bong', 'Rice', '10kg bag', 'home', 'product', 'active', 0, '', ''],
    ['p_b', 'own_b', 'bong-2', 'Soap', 'Bar', 'home', 'product', 'active', 0, '', ''],
    ['p_o', 'own_o', 'other', 'Soap', 'Bar', 'home', 'product', 'active', 0, '', '']],
  Variants: [['VariantId', 'ProductId', 'OwnerId', 'Label', 'Price', 'SKU', 'StockQty', 'Status'],
    ['v_rice', 'p_rice', 'own_s', '10kg', 20, '', 1000, 'active'], ['v_b', 'p_b', 'own_b', 'Bar', 2, '', 100, 'active'], ['v_o', 'p_o', 'own_o', 'Bar', 2, '', 100, 'active']],
  Orders: [['OrderId', 'OwnerId', 'StoreSlug', 'CustomerName', 'CustomerPhone', 'CustomerEmail', 'Island', 'Village', 'DeliveryAddress',
    'DeliveryMethod', 'DeliveryCost', 'Notes', 'PaymentMethod', 'PaymentReference', 'ItemsJson', 'ItemsSummary', 'Subtotal', 'Total', 'Status', 'CreatedAt', 'UpdatedAt']],
  AbandonedCarts: [['CartId', 'StoreSlug', 'Email', 'ConvertedOrderId']]
});   // the harness signs a shopper in: checkout needs one
box.__props.SITE_BASE_URL = 'https://mwakete.com';
box.ContentService = { createTextOutput: (s) => ({ s, setMimeType() { return this; } }), MimeType: { JSON: 'json' } };
const clear = () => Object.keys(box.__cache).forEach((k) => delete box.__cache[k]);
const owner = (id) => box.sheetToObjects(box.getSheet('Owners')).find((o) => o.OwnerId === id);
const orderRow = (id) => box.sheetToObjects(box.getSheet('Orders')).find((o) => o.OrderId === id);
const docs = () => (box.__sheets.Invoices ? box.__sheets.Invoices.objects() : []);
const mailsTo = (to) => box.__mail.filter((m) => m[0] === to);
const place = (slug, vid, extra) => { clear(); return box.actionCreateOrder(Object.assign({ storeSlug: slug, items: [{ variantId: vid, qty: 2 }], customerName: 'Tia <b>Ioane</b>',
  customerPhone: '73000001', customerEmail: 'tia@x.test', island: 'South Tarawa', village: 'Betio', deliveryMethod: 'truck', paymentMethod: '' }, extra || {})); };
const S = () => owner('own_s');

/* ---------- settings ---------- */
let st = box.actionGetInvoiceSettings(S()).settings;
ok('off until the store switches it on', st.enabled === false);
ok('the colour starts from the store colour picked from the logo', st.color === '#0b3d91', st.color);
ok('Classic is the default template; 7 days to pay; VAT off', st.template === 'classic' && st.dueDays === 7 && st.vatEnabled === false);
const bad = (b) => box.actionSaveInvoiceSettings(S(), b);
ok('only the three templates', !bad({ template: 'fancy' }).ok);
ok('colours must be real colours', !bad({ color: 'red' }).ok && !bad({ accent: 'url(x)' }).ok);
ok('VAT rate 0-30%', !bad({ vatRate: 40 }).ok && !bad({ vatRate: -1 }).ok);
ok('VAT needs a VAT number', /VAT number/.test(bad({ vatEnabled: true, vatNumber: '' }).error || ''));
ok('notes and business details are plain text, length-capped', !bad({ invoiceNote: '<script>x</script>' }).ok && !bad({ businessName: 'x'.repeat(81) }).ok);
ok('days to pay 0-90', !bad({ dueDays: 120 }).ok);
clear();
ok('checkout does not offer invoices yet', box.actionGetStorePublicInfo({ storeSlug: 'bong' }).store.invoicesOffered === false);
let r = box.actionSaveInvoiceSettings(S(), { enabled: true, template: 'modern', accent: '#fcd116', businessName: 'Bong Trading Ltd', businessAddress: 'Bairiki, Tarawa',
  vatEnabled: true, vatNumber: 'KV-12345', vatRate: 12.5, invoiceNote: 'Pay to ANZ 1234 ref your order', dueDays: 5 });
ok('the seller saves their design and details', r.ok && r.settings.template === 'modern' && r.settings.accent === '#fcd116', J(r));
clear();
ok('...and checkout now offers the invoice tick box', box.actionGetStorePublicInfo({ storeSlug: 'bong' }).store.invoicesOffered === true);

/* ---------- checkout request ---------- */
const o1 = place('bong', 'v_rice', { wantInvoice: true });
ok('a buyer ticks "I need an invoice" at checkout', o1.ok && orderRow(o1.orderId).InvoiceRequested === 'yes', J(o1));
ok('...and the seller is told in the new-order email', mailsTo('s@x.test').some((m) => m[2].includes(o1.orderId) && /asked for an INVOICE/.test(m[2])));
const o2 = place('bong', 'v_rice');
ok('no tick, no request', o2.ok && orderRow(o2.orderId).InvoiceRequested !== 'yes');
const oo = place('other', 'v_o', { wantInvoice: true });
ok('a store without invoices ignores the tick', oo.ok && orderRow(oo.orderId).InvoiceRequested !== 'yes');

/* ---------- sending the invoice ---------- */
ok('another seller cannot send it', !box.actionSendInvoice(owner('own_o'), { orderId: o1.orderId }).ok);
ok('UPON REQUEST ONLY: no invoice for an order that did not ask', /did not ask/.test(box.actionSendInvoice(S(), { orderId: o2.orderId }).error || ''));
box.__mail.length = 0;
r = box.actionSendInvoice(S(), { orderId: o1.orderId });
const inv = docs().find((d) => d.Kind === 'invoice');
ok('the seller sends it: INV-BONG-0001', r.ok && r.document.number === 'INV-BONG-0001' && inv.Number === 'INV-BONG-0001', J(r));
ok('...with a long random token for its QR code and link', /^[a-f0-9]{40}$/.test(inv.Token) && r.document.link === 'https://mwakete.com/invoice.html?d=' + inv.Token);
const im = mailsTo('tia@x.test')[0];
ok('...emailed to the buyer, designed, with the link', im && /Invoice INV-BONG-0001 from Bong Trading Ltd/.test(im[1]) && /invoice\.html\?d=/.test(im[2]) && im[3] && /INVOICE/.test(im[3].htmlBody || im[3]));
const html = (im[3] && im[3].htmlBody) || '';
ok('...items, totals, due date, payment options, VAT and the note', /Rice/.test(html) && /\$45\.00/.test(html) && /Pay by/.test(html) && /We accept:<\/strong> IB, MPaisa/.test(html)
  && /Includes VAT \(12\.5%\)/.test(html) && /\$5\.00<\/td>/.test(html) && /Pay to ANZ 1234/.test(html), html.slice(0, 200));
ok('VAT is shown as included - the total is what the buyer pays', /\$45\.00/.test(html) && Math.abs(Number(inv.VatAmount) - 5) < 0.01, inv.VatAmount);
ok('the buyer\'s name is escaped', html.includes('Tia &lt;b&gt;Ioane&lt;/b&gt;') && !html.includes('<b>Ioane'));
ok('Modern template in the store colours, text readable on the gold accent', /background:#0b3d91;color:#ffffff/.test(html) && /border-radius:18px/.test(html));
box.__mail.length = 0;
r = box.actionSendInvoice(S(), { orderId: o1.orderId });
ok('sending again emails the SAME invoice - no new number', r.ok && r.document.number === 'INV-BONG-0001' && docs().filter((d) => d.Kind === 'invoice').length === 1
  && Number(docs()[0].SendCount) === 2 && mailsTo('tia@x.test').length === 1);
const o3 = place('bong', 'v_rice', { wantInvoice: true });
ok('the next invoice is INV-BONG-0002', box.actionSendInvoice(S(), { orderId: o3.orderId }).document.number === 'INV-BONG-0002');

/* ---------- store prefixes are unique ---------- */
box.actionSaveInvoiceSettings(owner('own_b'), { enabled: true });
const ob = place('bong-2', 'v_b', { wantInvoice: true });
r = box.actionSendInvoice(owner('own_b'), { orderId: ob.orderId });
ok('a second store whose name also gives "BONG" gets its own prefix', r.ok && /^INV-BONG2-0001$/.test(r.document.number), r.document && r.document.number);
ok('...and keeps it', owner('own_b').InvoicePrefix === 'BONG2' && owner('own_s').InvoicePrefix === 'BONG');

/* ---------- receipts: status dropdown ---------- */
box.__mail.length = 0;
r = box.actionUpdateOrderStatus(S(), { orderId: o1.orderId, status: 'Paid' });
let rc = docs().find((d) => d.Kind === 'receipt' && d.OrderId === o1.orderId);
ok('PAID -> the receipt is issued automatically: RCT-BONG-0001', r.ok && rc && rc.Number === 'RCT-BONG-0001', J(rc && rc.Number));
ok('...pointing at its invoice', rc.InvoiceNumber === 'INV-BONG-0001');
const rm = mailsTo('tia@x.test').find((m) => /Receipt RCT-BONG-0001/.test(m[1]));
ok('...and emailed to the buyer with a PAID stamp', rm && /PAID/.test(rm[3].htmlBody) && /Total paid/.test(rm[3].htmlBody));
box.actionUpdateOrderStatus(S(), { orderId: o1.orderId, status: 'Fulfilled' });
ok('only once per order (Paid -> Fulfilled issues nothing more)', docs().filter((d) => d.Kind === 'receipt' && d.OrderId === o1.orderId).length === 1);
box.actionUpdateOrderStatus(S(), { orderId: o2.orderId, status: 'Fulfilled' });
ok('orders without an invoice get a receipt too (RCT-BONG-0002)', docs().some((d) => d.OrderId === o2.orderId && d.Number === 'RCT-BONG-0002'));
box.actionUpdateOrderStatus(owner('own_o'), { orderId: oo.orderId, status: 'Paid' });
ok('a store with invoices off issues no receipts', !docs().some((d) => d.OrderId === oo.orderId));

/* ---------- receipts: order room payment check ---------- */
box.__props.TX_ROOMS = 'on';
const ot = place('bong', 'v_rice');
const buyer = (fn, b) => { clear(); return box[fn](Object.assign({ side: 'buyer', token: 'ctok-b' }, b)); };
const seller = (fn, b) => { clear(); return box[fn](Object.assign({ side: 'seller', token: 'tok-s' }, b)); };
buyer('actionTxSubmitPayment', { orderId: ot.orderId, method: 'cash', note: 'At the shop', reference: 'cash' });
r = seller('actionTxVerifyPayment', { orderId: ot.orderId, result: 'verified', checkedSource: true, method: 'cash', amountReceived: Number(orderRow(ot.orderId).Total) });
ok('the order room\'s payment check (-> Paid) issues the receipt too', r.ok && orderRow(ot.orderId).Status === 'Paid' && docs().some((d) => d.OrderId === ot.orderId && d.Kind === 'receipt'), J(r));
box.__props.TX_ROOMS = 'off';

/* ---------- the page behind the QR code ---------- */
const get = (d) => JSON.parse(box.doGet({ parameter: { action: 'getInvoiceDocument', d } }).s);
let g = get(inv.Token);
ok('the token opens the document as Mwakete holds it', g.ok && g.number === 'INV-BONG-0001' && g.storeName === 'Bong Trading Ltd' && /INVOICE/.test(g.html) && g.logoUrl === 'https://res.cloudinary.com/x/bong.png');
ok('a wrong or made-up token finds nothing', !get('0'.repeat(40)).ok && !get('abc').ok && !get('').ok);
ok('it has a slot for the QR code', /class="inv-qr"/.test(g.html));

/* ---------- the snapshot does not change ---------- */
box.actionSaveInvoiceSettings(S(), { template: 'minimal', color: '#1f8a70', businessName: 'Renamed Ltd' });
g = get(inv.Token);
ok('an issued invoice keeps its design and details after the seller edits settings', /border-radius:18px/.test(g.html) && /Bong Trading Ltd/.test(g.html) && !/Renamed Ltd/.test(g.html));

/* ---------- templates and preview ---------- */
const prev = (t, kind) => box.actionPreviewInvoiceDesign(S(), { template: t, color: '#fcd116', accent: '#0b3d91', kind }).html;
ok('three different templates', new Set(['classic', 'modern', 'minimal'].map((t) => prev(t).replace(/inv-(classic|modern|minimal)/, ''))).size === 3);
ok('dark text on a light (gold) main colour, white on a dark accent', /background:#fcd116;color:#1a1a1a/.test(prev('classic')) && /background:#0b3d91;color:#ffffff/.test(prev('classic')));
ok('the preview is marked as a sample, for both invoice and receipt', /\(Sample\)/.test(prev('minimal')) && /RECEIPT/.test(prev('minimal', 'receipt')) && /RCT-BONG-0001/.test(prev('minimal', 'receipt')));
ok('the routes are owner-only', /Not authenticated/.test(JSON.parse(box.doPost({ postData: { contents: JSON.stringify({ action: 'sendInvoice', orderId: o1.orderId }) } }).s).error || ''));

let fails = 0;
console.log('\n--- invoices and receipts (real backend) ---');
for (const [s2, n, x] of R) { if (s2 === 'FAIL') fails++; console.log(`${s2}  ${n}${x !== '' ? '  [' + x + ']' : ''}`); }
console.log(`\n${R.length - fails}/${R.length} passed`);
process.exit(fails ? 1 : 0);
