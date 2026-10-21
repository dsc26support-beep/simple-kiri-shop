/**
 * Invoices and receipts (owner decisions, Oct 2026).
 *
 * WHEN. A store switches them on in Settings. Checkout then offers the buyer a
 * tick box, "I need an invoice" (Orders.InvoiceRequested). An invoice is only
 * ever sent on that request: the seller sends it from the order, before the
 * buyer pays. When the order becomes Paid (the order room's payment check, or
 * the seller's status dropdown) a RECEIPT is issued and emailed automatically,
 * once - for every order of a store that has them switched on.
 *
 * CODES. Each store numbers its own: INV-<PREFIX>-0001, RCT-<PREFIX>-0001.
 * The prefix comes from the store's name (BONG for "bong"), is unique across
 * stores, and is kept once given. Every document also has a random token: the
 * QR code on it (with the store logo in the middle) opens invoice.html?d=<token>,
 * which shows the document as Mwakete holds it - so a buyer or anyone they
 * show it to can check it is genuine. The logo is printed faintly behind it.
 *
 * LOOK. Three templates (Classic, Modern, Minimal) in the store's colours: a
 * main colour (starting from the store colour picked from the logo) and an
 * accent. Text on either is always white or dark, whichever reads better.
 * Everything a seller types is plain text and escaped.
 *
 * SNAPSHOT. A document records what it said when it was issued - items, totals,
 * store details, template and colours - so later edits never change it.
 *
 * MONEY. Totals are the order's own (VAT-inclusive prices, as listed). With VAT
 * switched on, the document says how much of the total is VAT at the store's
 * rate; it never adds to what the buyer pays.
 *
 * Sheets, created on first use: Invoices. Owners gains InvoiceSettingsJson,
 * InvoicePrefix, InvoiceSeq, ReceiptSeq; Orders gains InvoiceRequested.
 */

var INV_TEMPLATES = { classic: 'Classic', modern: 'Modern', minimal: 'Minimal' };
var INV_HEADERS = ['DocId', 'Kind', 'Number', 'OwnerId', 'StoreSlug', 'OrderId', 'Token', 'IssuedAt', 'DueDate', 'ItemsJson',
  'Subtotal', 'DeliveryCost', 'DeliveryNote', 'VatRate', 'VatAmount', 'Total', 'Note', 'BuyerName', 'BuyerEmail', 'BuyerPhone',
  'PaymentNote', 'Template', 'StyleJson', 'StoreJson', 'InvoiceNumber', 'SentAt', 'SendCount', 'CreatedAt', 'UpdatedAt'];
var INV_DEFAULT_COLOR = '#332d63';
var INV_INK = '#1a1a1a';

function invSheet() { return getSheetCreating('Invoices', INV_HEADERS); }

/* ---------------------------------------------------------------------------
 * Settings
 * ------------------------------------------------------------------------- */

function invText(v, max) {
  var s = String(v === undefined || v === null ? '' : v).replace(/\s+$/g, '').replace(/^\s+/g, '');
  if (s.length > max) return { error: 'Keep it to ' + max + ' characters.' };
  if (/[<>]/.test(s)) return { error: 'Plain text only - no < or >.' };
  return { value: s };
}

/** The store's invoice settings, filled with defaults. The colour starts from the store colour. */
function invSettings(owner) {
  var raw = {};
  try { raw = JSON.parse(owner.InvoiceSettingsJson || '{}') || {}; } catch (e) { raw = {}; }
  var brand = scHex(owner.BrandColor);
  var color = scHex(raw.color) || brand || INV_DEFAULT_COLOR;
  return {
    enabled: raw.enabled === true,
    template: INV_TEMPLATES[raw.template] ? raw.template : 'classic',
    color: color,
    accent: scHex(raw.accent) || invMix(color, '#ffffff', 0.85),
    vatEnabled: raw.vatEnabled === true,
    vatNumber: String(raw.vatNumber || ''),
    vatRate: Number(raw.vatRate) >= 0 && Number(raw.vatRate) <= 30 ? Number(raw.vatRate) : 12.5,
    dueDays: Number(raw.dueDays) >= 0 && Number(raw.dueDays) <= 90 ? Math.round(Number(raw.dueDays)) : 7,
    invoiceNote: String(raw.invoiceNote || ''),
    receiptNote: String(raw.receiptNote || 'Thank you for shopping with us.'),
    businessName: String(raw.businessName || ''),
    businessAddress: String(raw.businessAddress || ''),
    businessPhone: String(raw.businessPhone || '')
  };
}

function actionGetInvoiceSettings(owner) {
  var s = invSettings(owner);
  return ok({ settings: s, templates: INV_TEMPLATES, prefix: owner.InvoicePrefix || invSuggestPrefix(owner),
    storeColor: scHex(owner.BrandColor), logoUrl: invHttps(owner.LogoUrl) });
}

/** body: any of the settings fields. Unknown fields are ignored; every value is checked. */
function actionSaveInvoiceSettings(owner, body) {
  var cur = invSettings(owner);
  var next = Object.assign({}, cur);
  if (body.enabled !== undefined) next.enabled = body.enabled === true;
  if (body.template !== undefined) {
    if (!INV_TEMPLATES[body.template]) return fail('Choose Classic, Modern or Minimal.');
    next.template = body.template;
  }
  if (body.color !== undefined) { if (!scHex(body.color)) return fail('Choose a main colour.'); next.color = scHex(body.color); }
  if (body.accent !== undefined) { if (!scHex(body.accent)) return fail('Choose an accent colour.'); next.accent = scHex(body.accent); }
  if (body.vatEnabled !== undefined) next.vatEnabled = body.vatEnabled === true;
  if (body.vatRate !== undefined) {
    var rate = Number(body.vatRate);
    if (!isFinite(rate) || rate < 0 || rate > 30) return fail('Enter a VAT rate between 0 and 30%.');
    next.vatRate = Math.round(rate * 100) / 100;
  }
  if (body.dueDays !== undefined) {
    var due = Number(body.dueDays);
    if (!isFinite(due) || due < 0 || due > 90) return fail('Enter 0 to 90 days to pay (0 = no due date).');
    next.dueDays = Math.round(due);
  }
  var texts = { vatNumber: 30, invoiceNote: 300, receiptNote: 300, businessName: 80, businessAddress: 200, businessPhone: 30 };
  for (var k in texts) {
    if (body[k] === undefined) continue;
    var t = invText(body[k], texts[k]);
    if (t.error) return fail(t.error);
    next[k] = t.value;
  }
  if (next.vatEnabled && !next.vatNumber) return fail('Add your VAT number to show VAT on invoices.');
  var sheet = getSheet('Owners');
  ensureColumn(sheet, 'InvoiceSettingsJson');
  var row = findRowById(sheet, 'OwnerId', owner.OwnerId);
  if (!row) return fail('Store account not found');
  updateRowFromObject(sheet, row.__row, { InvoiceSettingsJson: JSON.stringify(next) });
  invalidateCache(storeCacheKeys(owner.StoreSlug));
  return ok({ settings: next });
}

/** A sample invoice or receipt in the given (unsaved) design, for the settings preview. */
function actionPreviewInvoiceDesign(owner, body) {
  var s = Object.assign({}, invSettings(owner));
  ['template', 'color', 'accent', 'vatEnabled', 'vatRate', 'vatNumber', 'dueDays', 'invoiceNote', 'receiptNote', 'businessName', 'businessAddress', 'businessPhone']
    .forEach(function (k) { if (body[k] !== undefined) s[k] = body[k]; });
  if (!INV_TEMPLATES[s.template]) s.template = 'classic';
  s.color = scHex(s.color) || INV_DEFAULT_COLOR;
  s.accent = scHex(s.accent) || invMix(s.color, '#ffffff', 0.85);
  s.vatEnabled = s.vatEnabled === true;
  ['vatNumber', 'invoiceNote', 'receiptNote', 'businessName', 'businessAddress', 'businessPhone'].forEach(function (k) {
    var t = invText(s[k], 300); s[k] = t.error ? '' : t.value;
  });
  var kind = body.kind === 'receipt' ? 'receipt' : 'invoice';
  var prefix = owner.InvoicePrefix || invSuggestPrefix(owner);
  var items = [{ label: 'Rice 10kg', qty: 2, unitPrice: 20, lineTotal: 40 }, { label: 'Cooking oil 2L', qty: 1, unitPrice: 12.5, lineTotal: 12.5 }];
  var doc = invBuildDoc(owner, s, kind, {
    OrderId: 'SKS-' + owner.StoreSlug + '-20261021-1234', CustomerName: 'Tia Ioane', CustomerEmail: 'tia@example.com', CustomerPhone: '73000001',
    Subtotal: 52.5, Total: 57.5, DeliveryCost: 5, DeliveryMethod: 'truck', ItemsJson: JSON.stringify(items), PaymentMethod: 'MPaisa'
  }, (kind === 'invoice' ? 'INV-' : 'RCT-') + prefix + '-0001', 'preview');
  return ok({ html: invRender(doc, { preview: true }), number: doc.Number });
}

/* ---------------------------------------------------------------------------
 * Numbers and tokens
 * ------------------------------------------------------------------------- */

function invSuggestPrefix(owner) {
  var p = String(owner.StoreSlug || owner.StoreName || 'STORE').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  return p || 'STORE';
}

/** The store's prefix, given once and unique across stores (BONG, BONG2, ...). Caller holds the lock. */
function invPrefixFor(sheet, owner) {
  if (owner.InvoicePrefix) return String(owner.InvoicePrefix);
  ensureColumn(sheet, 'InvoicePrefix');
  var taken = {};
  sheetToObjects(sheet).forEach(function (o) { if (o.InvoicePrefix && o.OwnerId !== owner.OwnerId) taken[String(o.InvoicePrefix)] = true; });
  var base = invSuggestPrefix(owner), p = base, n = 2;
  while (taken[p]) p = base.slice(0, 5) + n++;
  updateRowFromObject(sheet, owner.__row, { InvoicePrefix: p });
  owner.InvoicePrefix = p;
  return p;
}

/** INV-BONG-0001 / RCT-BONG-0001: the store's next number. Caller holds the lock. */
function invNextNumber(owner, kind) {
  var sheet = getSheet('Owners');
  var row = findRowById(sheet, 'OwnerId', owner.OwnerId);
  var prefix = invPrefixFor(sheet, row);
  var col = kind === 'invoice' ? 'InvoiceSeq' : 'ReceiptSeq';
  ensureColumn(sheet, col);
  row = findRowById(sheet, 'OwnerId', owner.OwnerId);
  var seq = (Number(row[col]) || 0) + 1;
  updateRowFromObject(sheet, row.__row, (function () { var o = {}; o[col] = seq; return o; })());
  var pad = String(seq);
  while (pad.length < 4) pad = '0' + pad;
  return (kind === 'invoice' ? 'INV-' : 'RCT-') + prefix + '-' + pad;
}

/* ---------------------------------------------------------------------------
 * Building and issuing
 * ------------------------------------------------------------------------- */

function invHttps(u) { return /^https:\/\/[^\s"'<>]+$/.test(String(u || '')) ? String(u) : ''; }
function invMoney(n) { return Math.round((Number(n) || 0) * 100) / 100; }

/** A document row (not yet saved) from an order, in the store's current design. */
function invBuildDoc(owner, s, kind, order, number, token) {
  var items = [];
  try { items = JSON.parse(order.ItemsJson || '[]'); } catch (e) { items = []; }
  items = items.map(function (it) {
    return { label: String(it.label || ''), qty: Number(it.qty) || 0, unitPrice: invMoney(it.unitPrice), lineTotal: invMoney(it.lineTotal) };
  });
  var total = invMoney(order.Total);
  var negotiated = String(order.DeliveryMethod || '') !== 'pickPay' && (order.DeliveryCost === '' || order.DeliveryCost === null || order.DeliveryCost === undefined);
  var vatAmount = s.vatEnabled && s.vatRate > 0 ? invMoney(total - total / (1 + s.vatRate / 100)) : 0;
  var now = new Date();
  var due = kind === 'invoice' && s.dueDays > 0 ? new Date(now.getTime() + s.dueDays * 86400000).toISOString() : '';
  return {
    DocId: newId(kind === 'invoice' ? 'inv' : 'rct'), Kind: kind, Number: number, OwnerId: owner.OwnerId, StoreSlug: owner.StoreSlug,
    OrderId: order.OrderId, Token: token, IssuedAt: now.toISOString(), DueDate: due, ItemsJson: JSON.stringify(items),
    Subtotal: invMoney(order.Subtotal), DeliveryCost: invMoney(order.DeliveryCost), DeliveryNote: negotiated ? 'To be agreed' : '',
    VatRate: s.vatEnabled ? s.vatRate : '', VatAmount: s.vatEnabled ? vatAmount : '', Total: total,
    Note: kind === 'invoice' ? s.invoiceNote : s.receiptNote,
    BuyerName: String(order.CustomerName || ''), BuyerEmail: String(order.CustomerEmail || ''), BuyerPhone: String(order.CustomerPhone || ''),
    PaymentNote: kind === 'receipt' ? String(order.PaymentMethod || '') : '',
    Template: s.template, StyleJson: JSON.stringify({ color: s.color, accent: s.accent }),
    StoreJson: JSON.stringify({
      name: owner.StoreName || '', businessName: s.businessName, address: s.businessAddress,
      phone: s.businessPhone || owner.Phone || '', vatNumber: s.vatEnabled ? s.vatNumber : '',
      logoUrl: invHttps(owner.LogoUrl), payments: kind === 'invoice' && typeof paymentOptionsOf === 'function' ? paymentOptionsOf(owner).labels : []
    }),
    InvoiceNumber: '', SentAt: '', SendCount: 0, CreatedAt: now.toISOString(), UpdatedAt: now.toISOString()
  };
}

function invDocsForOrder(orderId) {
  var s = SpreadsheetApp.getActive().getSheetByName('Invoices');
  if (!s) return [];
  return sheetToObjects(s).filter(function (d) { return d.OrderId === orderId; });
}

function invToken() { return Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '').slice(0, 8); }

/**
 * The seller sends the invoice the buyer asked for at checkout. body.orderId.
 * The first send issues it (number, snapshot); later sends email the same one.
 */
function actionSendInvoice(owner, body) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  var doc, order;
  try {
    order = findRowById(getSheet('Orders'), 'OrderId', String(body.orderId || ''));
    if (!order || order.OwnerId !== owner.OwnerId) return fail('Order not found');
    if (String(order.InvoiceRequested) !== 'yes') return fail('The buyer did not ask for an invoice for this order.');
    if (order.Status === 'Cancelled') return fail('This order is cancelled.');
    var existing = invDocsForOrder(order.OrderId).filter(function (d) { return d.Kind === 'invoice'; })[0];
    if (existing) {
      doc = existing;
    } else {
      var fresh = findRowById(getSheet('Owners'), 'OwnerId', owner.OwnerId);
      doc = invBuildDoc(fresh, invSettings(fresh), 'invoice', order, invNextNumber(fresh, 'invoice'), invToken());
      appendRowFromObject(invSheet(), doc);
    }
  } finally {
    lock.releaseLock();
  }
  var sent = invEmail(doc);
  invMarkSent(doc);
  return ok({ document: invPublic(doc), emailed: sent });
}

/**
 * Issues the order's receipt when it has just become Paid (or Fulfilled
 * without one). Once per order, only for stores with invoices switched on.
 * The CALLER holds the script lock and emails the returned doc afterwards
 * (invEmail), so the slow send never holds the lock. Never throws.
 */
function invIssueReceipt(order) {
  try {
    if (!order || !order.OrderId) return null;
    var owner = findRowById(getSheet('Owners'), 'OwnerId', order.OwnerId);
    if (!owner || !invSettings(owner).enabled) return null;
    var docs = invDocsForOrder(order.OrderId);
    if (docs.some(function (d) { return d.Kind === 'receipt'; })) return null;
    var fresh = findRowById(getSheet('Orders'), 'OrderId', order.OrderId) || order;
    var doc = invBuildDoc(owner, invSettings(owner), 'receipt', fresh, invNextNumber(owner, 'receipt'), invToken());
    var inv = docs.filter(function (d) { return d.Kind === 'invoice'; })[0];
    if (inv) doc.InvoiceNumber = inv.Number;
    appendRowFromObject(invSheet(), doc);
    return doc;
  } catch (e) {
    Logger.log('receipt not issued for ' + (order && order.OrderId) + ': ' + e);
    return null;
  }
}

/** Emails a receipt issued inside a lock, after the lock is released. */
function invSendIssued(doc) {
  if (!doc) return;
  try { invEmail(doc); invMarkSent(doc); } catch (e) { Logger.log('receipt email failed: ' + e); }
}

function invMarkSent(doc) {
  try {
    var sheet = invSheet();
    var row = findRowById(sheet, 'DocId', doc.DocId);
    if (row) updateRowFromObject(sheet, row.__row, { SentAt: nowIso(), SendCount: (Number(row.SendCount) || 0) + 1, UpdatedAt: nowIso() });
  } catch (e) { /* best effort */ }
}

function invLink(doc) {
  var base = siteBaseUrl();
  return base ? base + '/invoice.html?d=' + encodeURIComponent(doc.Token) : '';
}

function invEmail(doc) {
  if (!doc.BuyerEmail) return false;
  var store = invJson(doc.StoreJson);
  var link = invLink(doc);
  var what = doc.Kind === 'invoice' ? 'Invoice' : 'Receipt';
  var subject = what + ' ' + doc.Number + ' from ' + (store.businessName || store.name);
  var text = what + ' ' + doc.Number + ' from ' + (store.businessName || store.name) + ' for order ' + doc.OrderId + '.\n' +
    'Total: $' + invMoney(doc.Total).toFixed(2) + (doc.Kind === 'invoice' && doc.DueDate ? '\nPlease pay by ' + invDate(doc.DueDate) + '.' : '') +
    (link ? '\n\nView, print, save as PDF or check it is genuine: ' + link : '');
  return sendAppEmail(doc.BuyerEmail, subject, text, invRender(doc, { link: link }));
}

function invJson(s) { try { return JSON.parse(s || '{}') || {}; } catch (e) { return {}; } }

function invPublic(doc) {
  return { docId: doc.DocId, kind: doc.Kind, number: doc.Number, orderId: doc.OrderId, issuedAt: doc.IssuedAt, dueDate: doc.DueDate || '',
    total: invMoney(doc.Total), sentAt: doc.SentAt || '', token: doc.Token, link: invLink(doc) };
}

/** The seller's documents for one order. */
function actionListOrderDocuments(owner, body) {
  var order = findRowById(getSheet('Orders'), 'OrderId', String(body.orderId || ''));
  if (!order || order.OwnerId !== owner.OwnerId) return fail('Order not found');
  return ok({ invoiceRequested: String(order.InvoiceRequested) === 'yes', documents: invDocsForOrder(order.OrderId).map(invPublic) });
}

/** Public: a document by its token (the QR code / emailed link). Answers a wrong token like a missing one. */
function actionGetInvoiceDocument(params) {
  var token = String((params && params.d) || '');
  if (!/^[a-f0-9]{40}$/.test(token)) return fail('Document not found');
  var s = SpreadsheetApp.getActive().getSheetByName('Invoices');
  var doc = s ? findRowById(s, 'Token', token) : null;
  if (!doc) return fail('Document not found');
  var store = invJson(doc.StoreJson);
  return ok({ kind: doc.Kind, number: doc.Number, issuedAt: doc.IssuedAt, storeName: store.businessName || store.name,
    logoUrl: store.logoUrl || '', color: invJson(doc.StyleJson).color || INV_DEFAULT_COLOR, link: invLink(doc), html: invRender(doc, {}) });
}

/* ---------------------------------------------------------------------------
 * Rendering: three templates, one table-based, email-safe layout
 * ------------------------------------------------------------------------- */

function invMix(a, b, t) {
  var x = scRgb(scHex(a) || INV_DEFAULT_COLOR), y = scRgb(scHex(b) || '#ffffff');
  return scToHex(x.map(function (v, i) { return v + (y[i] - v) * t; }));
}
function invOn(bg) { return scContrast(bg, '#ffffff') >= scContrast(bg, INV_INK) ? '#ffffff' : INV_INK; }
/** The colour darkened until it reads as text on white (4.5:1). */
function invTextColor(c) {
  var rgb = scRgb(c), out = c, guard = 0;
  while (scContrast(out, '#ffffff') < 4.5 && guard++ < 60) { rgb = rgb.map(function (v) { return v * 0.92; }); out = scToHex(rgb); }
  return out;
}

function invDate(iso) {
  var d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  var k = new Date(d.getTime() + 12 * 3600000);   // Kiribati (UTC+12), the day the buyer sees
  var m = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][k.getUTCMonth()];
  return k.getUTCDate() + ' ' + m + ' ' + k.getUTCFullYear();
}

function invRender(doc, opts) {
  opts = opts || {};
  var e = escapeHtmlForEmail;
  var st = invJson(doc.StyleJson), store = invJson(doc.StoreJson);
  var c = scHex(st.color) || INV_DEFAULT_COLOR, a = scHex(st.accent) || invMix(c, '#ffffff', 0.85);
  var onC = invOn(c), onA = invOn(a), txt = invTextColor(c);
  var tpl = INV_TEMPLATES[doc.Template] ? doc.Template : 'classic';
  var isInv = doc.Kind === 'invoice';
  var title = isInv ? 'INVOICE' : 'RECEIPT';
  var money = function (n) { return '$' + invMoney(n).toFixed(2); };
  var items = [];
  try { items = JSON.parse(doc.ItemsJson || '[]') || []; } catch (err) { items = []; }
  var name = store.businessName || store.name || '';
  var logo = store.logoUrl ? '<img src="' + e(store.logoUrl) + '" alt="" width="48" height="48" style="width:48px;height:48px;border-radius:10px;background:#fff;object-fit:contain;vertical-align:middle">' : '';
  var storeLines = [store.businessName && store.name && store.businessName !== store.name ? store.name : '', store.address, store.phone,
    store.vatNumber ? 'VAT no. ' + store.vatNumber : ''].filter(Boolean).map(e).join('<br>');
  var meta = [[isInv ? 'Invoice no.' : 'Receipt no.', doc.Number], ['Date', invDate(doc.IssuedAt)],
    isInv && doc.DueDate ? ['Pay by', invDate(doc.DueDate)] : null, ['Order', doc.OrderId],
    !isInv && doc.InvoiceNumber ? ['For invoice', doc.InvoiceNumber] : null]
    .filter(Boolean).map(function (r) { return '<tr><td style="padding:2px 12px 2px 0;color:#5f6368">' + e(r[0]) + '</td><td style="padding:2px 0;font-weight:bold">' + e(r[1]) + '</td></tr>'; }).join('');
  var buyer = [doc.BuyerName, doc.BuyerEmail, doc.BuyerPhone].filter(Boolean).map(e).join('<br>');
  var cellPad = tpl === 'minimal' ? '10px 6px' : '8px 10px';
  var rowLine = tpl === 'minimal' ? 'border-bottom:1px solid ' + a : 'border-bottom:1px solid #e3e1ee';
  var head = '<tr style="background:' + (tpl === 'minimal' ? '#ffffff' : a) + ';color:' + (tpl === 'minimal' ? txt : onA) + '">' +
    ['Item', 'Qty', 'Price', 'Amount'].map(function (h, i) { return '<th style="text-align:' + (i ? 'right' : 'left') + ';padding:' + cellPad + ';font-size:12px;text-transform:uppercase;letter-spacing:.04em' + (tpl === 'minimal' ? ';border-bottom:2px solid ' + c : '') + '">' + h + '</th>'; }).join('') + '</tr>';
  var rows = items.map(function (it) {
    return '<tr><td style="padding:' + cellPad + ';' + rowLine + '">' + e(it.label) + '</td><td style="padding:' + cellPad + ';' + rowLine + ';text-align:right">' + e(it.qty) +
      '</td><td style="padding:' + cellPad + ';' + rowLine + ';text-align:right">' + money(it.unitPrice) + '</td><td style="padding:' + cellPad + ';' + rowLine + ';text-align:right">' + money(it.lineTotal) + '</td></tr>';
  }).join('');
  var tot = [['Subtotal', money(doc.Subtotal)], ['Delivery', doc.DeliveryNote ? e(doc.DeliveryNote) : money(doc.DeliveryCost)]];
  if (doc.VatRate !== '' && doc.VatRate !== undefined && Number(doc.VatAmount) > 0) tot.push(['Includes VAT (' + Number(doc.VatRate) + '%)', money(doc.VatAmount)]);
  var totalRow = tpl === 'modern'
    ? '<tr><td colspan="2" style="padding-top:10px"><div style="background:' + c + ';color:' + onC + ';border-radius:999px;padding:10px 18px;font-weight:bold;font-size:18px;text-align:right">' + (isInv ? 'Total due ' : 'Total paid ') + money(doc.Total) + '</div></td></tr>'
    : '<tr><td style="padding:8px 10px 0;font-weight:bold;font-size:16px;' + (tpl === 'classic' ? 'border-top:2px solid ' + c : '') + '">' + (isInv ? 'Total due' : 'Total paid') + '</td><td style="padding:8px 10px 0;text-align:right;font-weight:bold;font-size:18px;color:' + txt + ';' + (tpl === 'classic' ? 'border-top:2px solid ' + c : '') + '">' + money(doc.Total) + '</td></tr>';
  var totals = '<table role="presentation" cellpadding="0" cellspacing="0" style="margin-left:auto;min-width:240px">' +
    tot.map(function (r) { return '<tr><td style="padding:3px 10px;color:#5f6368">' + e(r[0]) + '</td><td style="padding:3px 10px;text-align:right">' + r[1] + '</td></tr>'; }).join('') + totalRow + '</table>';
  var paidStamp = !isInv ? '<p style="margin:16px 0 0;text-align:right"><span style="display:inline-block;border:2px solid ' + txt + ';color:' + txt + ';border-radius:999px;padding:4px 16px;font-weight:bold;letter-spacing:.1em">PAID</span>' +
    (doc.PaymentNote ? '<br><span style="color:#5f6368;font-size:12px">' + e(doc.PaymentNote) + '</span>' : '') + '</p>' : '';
  var pays = isInv && store.payments && store.payments.length ? '<p style="margin:16px 0 0"><strong>We accept:</strong> ' + store.payments.map(e).join(', ') + '</p>' : '';
  var note = doc.Note ? '<p style="margin:12px 0 0;white-space:pre-line">' + e(doc.Note) + '</p>' : '';
  var link = opts.link ? '<p style="margin:16px 0 0"><a href="' + e(opts.link) + '" style="color:' + txt + '">View, print, save as PDF or check it is genuine</a></p>' : '';
  var qrSlot = '<div class="inv-qr" style="margin-top:16px"></div>';
  var foot = '<div style="margin-top:20px;padding-top:10px;border-top:1px solid #e3e1ee;color:#5f6368;font-size:12px">' +
    e(title.charAt(0) + title.slice(1).toLowerCase()) + ' ' + e(doc.Number) + ' issued through Mwakete for ' + e(name) + '. Scan the code to check it is genuine.' + (opts.preview ? ' (Sample)' : '') + '</div>';
  var header;
  if (tpl === 'classic') {
    header = '<div style="background:' + c + ';color:' + onC + ';padding:16px 20px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>' +
      '<td style="vertical-align:middle">' + logo + ' <span style="font-size:20px;font-weight:bold;vertical-align:middle;margin-left:8px">' + e(name) + '</span></td>' +
      '<td style="text-align:right;font-size:22px;font-weight:bold;letter-spacing:.12em">' + title + '</td></tr></table></div>';
  } else if (tpl === 'modern') {
    header = '<div style="background:' + c + ';color:' + onC + ';padding:24px;border-radius:18px"><div>' + logo + '</div>' +
      '<div style="font-size:30px;font-weight:bold;margin-top:12px">' + title + '</div><div style="font-size:16px;opacity:.9">' + e(doc.Number) + ' · ' + e(name) + '</div></div>';
  } else {
    header = '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-bottom:3px solid ' + c + '"><tr>' +
      '<td style="padding:8px 0 12px">' + logo + ' <span style="font-size:18px;font-weight:bold;vertical-align:middle;margin-left:8px">' + e(name) + '</span></td>' +
      '<td style="padding:8px 0 12px;text-align:right;color:' + txt + ';font-size:24px;font-weight:300;letter-spacing:.2em">' + title + '</td></tr></table>';
  }
  var box = function (inner) { return tpl === 'modern' ? '<div style="background:' + invMix(a, '#ffffff', 0.8) + ';border-radius:14px;padding:14px 16px;margin-top:14px">' + inner + '</div>' : '<div style="margin-top:16px">' + inner + '</div>'; };
  var parties = '<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>' +
    '<td style="vertical-align:top;padding-right:12px;width:50%"><div style="font-size:12px;color:#5f6368;text-transform:uppercase;letter-spacing:.04em">From</div><strong>' + e(name) + '</strong>' + (storeLines ? '<br><span style="color:#3c3c3c">' + storeLines + '</span>' : '') + '</td>' +
    '<td style="vertical-align:top;width:50%"><div style="font-size:12px;color:#5f6368;text-transform:uppercase;letter-spacing:.04em">' + (isInv ? 'Bill to' : 'Received from') + '</div>' + (buyer || '-') + '</td></tr></table>';
  var body = header + '<div style="padding:' + (tpl === 'minimal' ? '8px 0' : '16px 20px') + '">' + box(parties) + box('<table role="presentation" cellpadding="0" cellspacing="0">' + meta + '</table>') +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:18px;border-collapse:collapse;' + (tpl === 'classic' ? 'border:1px solid #e3e1ee' : '') + '">' + head + rows + '</table>' +
    '<div style="margin-top:12px">' + totals + '</div>' + paidStamp + pays + note + link + qrSlot + foot + '</div>';
  return '<div class="inv-doc inv-' + tpl + '" style="font-family:Arial,Helvetica,sans-serif;max-width:680px;margin:0 auto;color:#1a1a1a;background:#ffffff;font-size:14px;line-height:1.45' +
    (tpl === 'classic' ? ';border:1px solid #e3e1ee' : '') + (tpl === 'minimal' ? ';padding:8px 4px' : '') + '">' + body + '</div>';
}
