/**
 * Paid featuring's money rules, run against the REAL Featuring.gs source
 * (extracted with vm, same pattern as test-costwrite.js / test-meetings.js):
 * the price, and the screenshot decision - approve, hold for a human, or
 * reject - over sample OCR text from a bank receipt.
 */
const fs = require('fs');
const vm = require('vm');
const src = fs.readFileSync('/home/user/simple-kiri-shop/apps-script/Featuring.gs', 'utf8');
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e === undefined ? '' : e]);

const props = {};
const box = {
  PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k in props ? props[k] : null) }) },
  JSON, Math, Date, Number, String, parseInt, parseFloat, isNaN, Object, Array
};
vm.createContext(box);
vm.runInContext(src, box);

/* ---------- price ---------- */
ok('1 product x 1 day = $0.05', box.featureAmountFor(1, 1) === 0.05);
ok('3 products x 7 days = $1.05 exactly (no float noise)', box.featureAmountFor(3, 7) === 1.05, box.featureAmountFor(3, 7));
ok('30 products x 60 days = $90.00', box.featureAmountFor(30, 60) === 90);

/* ---------- references ---------- */
const refs = new Set();
for (let i = 0; i < 200; i++) refs.add(box.newFeatureReference([]));
ok('references look like MWF + 6 unambiguous characters', [...refs].every((r) => /^MWF[A-HJ-NP-Z2-9]{6}$/.test(r)), [...refs][0]);
ok('a reference already in the sheet is never reissued', (() => {
  const taken = [...refs].map((r) => ({ Reference: r }));
  for (let i = 0; i < 200; i++) if (refs.has(box.newFeatureReference(taken))) return false;
  return true;
})());

/* ---------- the screenshot decision ---------- */
const purchase = { Reference: 'MWFABC234', Amount: 1.05, Days: 7, CreatedAt: new Date().toISOString() };
// Receipts carry Kiribati (Tarawa) dates - which can already be tomorrow in UTC.
const today = box.featureLocalDay(Date.now());
// Shaped like a real ANZ goMoney "Transaction Status" screen.
const goodReceipt = `ANZ goMoney\nPayment successful\nTo: Mwakete 906149\nAmount $1.05\nReference to recipient MWFABC234\nDate ${today}\nReference Number AQC84078`;
const decide = (text, photo, p) => box.decideFeaturePayment(text, p || purchase, !!photo);

let d = decide(goodReceipt);
ok('a clean receipt with every detail is Approved', d.status === 'Approved', JSON.stringify(d));
ok('a camera-photo flag is recorded, not gating (as in topup)', decide(goodReceipt, true).status === 'Approved' && /photo:true/.test(decide(goodReceipt, true).notes));
ok('no OCR at all (Drive API off) -> Pending review, never Rejected', decide(null).status === 'Pending review');
ok('overpaying still counts', decide(goodReceipt.replace('$1.05', '$2.00')).status === 'Approved');

d = decide(goodReceipt.replace('$1.05', '$1.00'));
ok('5c short is Rejected - no underpayment tolerance on featuring', d.status === 'Rejected' && /full amount of \$1\.05/.test(d.message), d.message);
d = decide(goodReceipt.replace('MWFABC234', 'MWFZZZ999'));
ok('wrong reference is Rejected and says which', d.status === 'Rejected' && /reference MWFABC234/.test(d.message), d.message);
d = decide(goodReceipt.replace('906149', '786149'));
ok('wrong account (the old AM TOPUP one) is Rejected', d.status === 'Rejected' && /906149/.test(d.message), d.message);
d = decide(goodReceipt.replace('Payment successful', 'Payment'));
ok('no success word is Rejected', d.status === 'Rejected' && /successful/.test(d.message), d.message);
d = decide('Transfer Confirmation\nTo Mwakete 906149\n$1.05\nMWFABC234\nConfirm   Cancel');
ok('the pre-send Confirm/Cancel screen is Rejected with its own explanation', d.status === 'Rejected' && /before you press Confirm/.test(d.message), d.message);
d = decide(goodReceipt.replace(today, '2020-01-01'));
ok('an old receipt is Rejected', d.status === 'Rejected' && /recent date/.test(d.message), d.message);
ok('reference matching ignores spacing/case OCR noise', decide(goodReceipt.replace('MWFABC234', 'mwf abc 234')).status === 'Approved');

/* ---------- screenshots that are not bank receipts (found Oct 2026) ---------- */
const payPage = 'Pay and upload your receipt\nRice, Flour - 7 days.\nCopy/Paste the following onto your Kiribati Banking App\n'
  + 'Account name Mwakete Copy\nAccount number 906149 Copy\nReference to Recipient MWFABC234 Copy\nAmount $1.05 Copy\n'
  + 'SCREENSHOT PAYMENT RECEIPT\nPayment screenshot\nUpload payment screenshot\n' + today;
d = decide(payPage);
ok('a screenshot of our own pay page is Rejected, with its own explanation', d.status === 'Rejected' && /Mwakete page or the example/.test(d.message), d.message);
const exampleShot = 'EXAMPLE\nKiribati Banking App\nPayment successful\nStatus: Posted\nTo account Mwakete 906149\nAmount $1.05\n'
  + 'Reference to Recipient MWFABC234\nDate ' + today;
ok('a screenshot of the drawn example (watermarked EXAMPLE) is Rejected', decide(exampleShot).status === 'Rejected');
ok('"Ex ample" split by OCR still caught', decide(exampleShot.replace('EXAMPLE', 'E X A M P L E')).status === 'Rejected');
ok('"receipt" alone no longer counts as a success word', decide(goodReceipt.replace('Payment successful', 'Receipt')).status === 'Rejected');
d = decide(goodReceipt.replace('Date ' + today, ''));
ok('no readable date -> Pending review (a human looks), never auto-approved', d.status === 'Pending review' && /no date read/.test(d.notes), JSON.stringify(d));
// Today in Kiribati, which after midday UTC is already tomorrow in UTC terms.
const [tY, tM, tD] = today.split('-').map(Number);
const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][tM - 1];
ok('"8 Oct 2026" style dates are read (ANZ)', decide(goodReceipt.replace(today, `${tD} ${mon} ${tY}`)).status === 'Approved');
ok('"Oct 8, 2026" style dates are read', decide(goodReceipt.replace(today, `${mon} ${tD}, ${tY}`)).status === 'Approved');
ok('"08/10/2026" style dates are read', decide(goodReceipt.replace(today, `${String(tD).padStart(2, '0')}/${String(tM).padStart(2, '0')}/${tY}`)).status === 'Approved');
ok('an old "3 Jan 2020" receipt is Rejected', decide(goodReceipt.replace(today, '3 Jan 2020')).status === 'Rejected');

/* ---------- anti-fraud rules 1, 2 and 4 (Oct 2026) ---------- */
const anz = (date, extra) => `Transaction Status\nPosted\nANZ to ANZ Transfer\nAUD 1.05\nFrom Account Name Access Everyday\n`
  + `Recipient Name Other ANZ Account\nRecipient Account Number 906149\nRecipient Reference MWFABC234\nDate ${date}\nReference Number AQC84078${extra || ''}\nBack to Transfer`;
const [ty, tm, tdd] = today.split('-');
const anzToday = `${tdd}/${tm}/${ty}`;
d = decide(anz(anzToday));
ok('a real-layout ANZ receipt (Posted, AUD, dd/mm/yyyy, Reference Number) is Approved', d.status === 'Approved' && d.receiptNo === 'AQC84078', JSON.stringify(d));
ok('approval says when featuring starts (2 hour delay)', /within 2 hours/.test(d.message), d.message);
props.FEATURE_START_DELAY_HOURS = '0';
ok('FEATURE_START_DELAY_HOURS=0 -> "featured now"', /featured now/.test(decide(anz(anzToday)).message));
delete props.FEATURE_START_DELAY_HOURS;
ok('receipt number read when OCR splits labels from values',
  box.ocrReceiptNumber('Recipient Reference\nDate\nReference Number\nMWFABC234\n23/09/2026\nAQC84078', purchase) === 'AQC84078');
ok('receipt number is never the MWF reference, the account number or an AUD amount',
  box.ocrReceiptNumber('Reference Number MWFABC234 906149 AUD1234', purchase) === '');
// 1. paid on or after the order's day
const yesterday = box.featureLocalDay(Date.now() - 86400000).split('-');
d = decide(anz(`${yesterday[2]}/${yesterday[1]}/${yesterday[0]}`));
ok('1: a receipt dated the day before the order was started is Rejected', d.status === 'Rejected' && /dated before you started this order/.test(d.message), JSON.stringify(d));
ok('1: an order started yesterday, paid today, is fine',
  decide(anz(anzToday), false, Object.assign({}, purchase, { CreatedAt: new Date(Date.now() - 86400000).toISOString() })).status === 'Approved');
ok('1: compares in Kiribati time (UTC+12): 23:30 UTC on the 7th is the 8th in Tarawa',
  box.featureLocalDay(Date.UTC(2026, 9, 7, 23, 30)) === '2026-10-08');
// 2. receipt number once only
d = box.decideFeaturePayment(anz(anzToday), purchase, false, { usedReceiptNumbers: ['AQC84078'] });
ok('2: a bank Reference Number already used is Rejected', d.status === 'Rejected' && /AQC84078\) has already been used/.test(d.message), JSON.stringify(d));
d = decide(anz(anzToday).replace('Reference Number AQC84078', ''));
ok('2: no bank Reference Number readable -> Pending review, never auto-approved', d.status === 'Pending review' && /no receipt number read/.test(d.notes), JSON.stringify(d));
// 4. weekly caps
d = box.decideFeaturePayment(anz(anzToday), purchase, false, { weekApproved: 4.5, paidApprovedCount: 0 });
ok('4: a new store over its $5 weekly auto limit waits for a human', d.status === 'Pending review' && /weekly auto limit \$5/.test(d.notes), d.notes);
ok('4: a new store under $5 is approved', box.decideFeaturePayment(anz(anzToday), purchase, false, { weekApproved: 3.9, paidApprovedCount: 0 }).status === 'Approved');
ok('4: an established store (3+ paid) gets $20 a week',
  box.decideFeaturePayment(anz(anzToday), purchase, false, { weekApproved: 18, paidApprovedCount: 3 }).status === 'Approved'
  && box.decideFeaturePayment(anz(anzToday), purchase, false, { weekApproved: 19, paidApprovedCount: 3 }).status === 'Pending review');
const ctxRows = [
  { PurchaseId: 'x1', OwnerId: 'o1', Status: 'Approved', Amount: 2, CreatedAt: new Date(Date.now() - 2 * 86400000).toISOString(), ReceiptNo: 'AAA11111' },
  { PurchaseId: 'x2', OwnerId: 'o1', Status: 'Approved', Amount: 3, CreatedAt: new Date(Date.now() - 9 * 86400000).toISOString() },
  { PurchaseId: 'x3', OwnerId: 'o1', Status: 'Approved', Amount: 0, CreatedAt: new Date().toISOString() },
  { PurchaseId: 'x4', OwnerId: 'o2', Status: 'Pending review', Amount: 1, CreatedAt: new Date().toISOString(), ReceiptNo: 'bbb22222' },
  { PurchaseId: 'x5', OwnerId: 'o2', Status: 'Rejected', Amount: 1, CreatedAt: new Date().toISOString(), ReceiptNo: 'CCC33333' },
  { PurchaseId: 'me', OwnerId: 'o1', Status: 'Awaiting payment', Amount: 1, CreatedAt: new Date().toISOString(), ReceiptNo: 'DDD44444' }];
const ctx = box.featureDecisionContext(ctxRows, { PurchaseId: 'me', OwnerId: 'o1' }, Date.now());
ok('context: this week\'s paid approvals only ($2; not the 9-day-old $3, not the free one)', ctx.weekApproved === 2, JSON.stringify(ctx));
ok('context: counts all paid approvals for "established"', ctx.paidApprovedCount === 2, JSON.stringify(ctx));
ok('context: used receipt numbers come from Approved/Pending rows, not Rejected or this one',
  ctx.usedReceiptNumbers.join() === 'AAA11111,BBB22222', JSON.stringify(ctx));

/* ---------- rule 3: the image file ---------- */
const pngOf = (w, h, extra) => { const b = Buffer.alloc(40); b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); return Array.from(extra ? Buffer.concat([b, Buffer.from(extra, 'latin1')]) : b); };
const jpgOf = (w, h, extra) => { const app = extra ? [0xff, 0xe1, 0, extra.length + 2, ...Buffer.from(extra, 'latin1')] : [];
  return [0xff, 0xd8, ...app, 0xff, 0xc0, 0, 17, 8, h >> 8, h & 255, w >> 8, w & 255, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
    .map((x) => (x > 127 ? x - 256 : x)); };
let info = box.imageInfo(pngOf(720, 1600));
ok('3: PNG size read (720x1600, the ANZ screenshot)', info.width === 720 && info.height === 1600, JSON.stringify(info));
info = box.imageInfo(jpgOf(1080, 2400, 'Exif\0\0 Samsung SM-A515F'));
ok('3: JPEG size read past an EXIF block, signed bytes', info.width === 1080 && info.height === 2400 && info.editor === '', JSON.stringify(info));
const webp = Buffer.alloc(40); webp.write('RIFF', 0); webp.write('WEBP', 8); webp.write('VP8X', 12);
webp.writeUIntLE(1080 - 1, 24, 3); webp.writeUIntLE(2340 - 1, 27, 3);
info = box.imageInfo(Array.from(webp));
ok('3: WebP (VP8X) size read', info.width === 1080 && info.height === 2340, JSON.stringify(info));
ok('3: an untouched phone screenshot passes', box.featureImageProblem(box.imageInfo(pngOf(720, 1600))) === '');
ok('3: Photoshop in the metadata is refused', /photo editor \(Photoshop\)/.test(box.featureImageProblem(box.imageInfo(jpgOf(1080, 2400, '<xmp:CreatorTool>Adobe Photoshop 25.0</xmp:CreatorTool>')))));
ok('3: PicsArt / Snapseed / Canva refused too', ['PicsArt', 'Snapseed', 'Canva'].every((t) => box.featureImageProblem(box.imageInfo(pngOf(720, 1600, 'tEXtSoftware\0' + t))) !== ''));
ok('3: a cropped (wide) image is refused', /full phone screenshot/.test(box.featureImageProblem(box.imageInfo(pngOf(720, 500)))));
ok('3: a landscape image is refused', box.featureImageProblem(box.imageInfo(pngOf(1600, 720))) !== '');
ok('3: a tiny image is refused', box.featureImageProblem(box.imageInfo(pngOf(200, 400))) !== '');
ok('3: tablet portrait (3:4) and tall 21:9 phones pass', box.featureImageProblem(box.imageInfo(pngOf(1200, 1600))) === '' && box.featureImageProblem(box.imageInfo(pngOf(1080, 2520))) === '');
ok('3: unreadable size -> left to the other checks', box.featureImageProblem({ width: 0, height: 0, editor: '' }) === '');

props.FEATURE_AUTO_APPROVE_MAX = '1';
ok('above FEATURE_AUTO_APPROVE_MAX it waits for a human even when every check passes', decide(goodReceipt).status === 'Pending review');
delete props.FEATURE_AUTO_APPROVE_MAX;

/* ---------- image checks ---------- */
const png = [0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0];
const jpg = [0xff, 0xd8, 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0].map((b) => (b > 127 ? b - 256 : b)); // signed, as Utilities.base64Decode returns
ok('a PNG passes the magic-byte check', box.isValidPaymentImage(png, 'image/png'));
ok('a JPEG passes even as signed bytes', box.isValidPaymentImage(jpg, 'image/jpeg'));
ok('a PDF claiming to be an image fails', !box.isValidPaymentImage([0x25, 0x50, 0x44, 0x46, 0, 0, 0, 0, 0, 0, 0, 0], 'image/png'));
ok('EXIF is detected (camera photo)', box.imageHasExif([0, 0, 0x45, 0x78, 0x69, 0x66, 0]) && !box.imageHasExif(png));

/* ---------- renewal reminders ---------- */
const H = 3600 * 1000, now = Date.now();
const row = (o) => Object.assign({ PurchaseId: 'a', OwnerId: 'o1', Status: 'Approved', ProductIdsJson: '["p1","p2"]',
  Days: 7, CreatedAt: '2026-10-01T00:00:00Z', EndsAt: new Date(now + 20 * H).toISOString() }, o);
const due = (rows, sent) => box.featureRenewalsDue(rows, now, sent || {}).map((r) => r.PurchaseId);
ok('renewal: ends in 20h -> due', due([row()]).join() === 'a');
ok('renewal: ends in 30h -> not yet', due([row({ EndsAt: new Date(now + 30 * H).toISOString() })]).length === 0);
ok('renewal: already ended -> never', due([row({ EndsAt: new Date(now - H).toISOString() })]).length === 0);
ok('renewal: already reminded -> not again', due([row()], { a: 'x' }).length === 0);
ok('renewal: pending/rejected purchases are never reminded', due([row({ Status: 'Pending review' }), row({ PurchaseId: 'b', Status: 'Rejected' })]).length === 0);
ok('renewal: already renewed (later purchase covering the same products) -> skipped',
  due([row(), row({ PurchaseId: 'b', Status: 'Pending review', CreatedAt: '2026-10-05T00:00:00Z', ProductIdsJson: '["p2","p1","p9"]' })]).length === 0);
ok('renewal: a later purchase covering only SOME products still reminds',
  due([row(), row({ PurchaseId: 'b', CreatedAt: '2026-10-05T00:00:00Z', ProductIdsJson: '["p1"]', EndsAt: new Date(now + 99 * H).toISOString() })]).join() === 'a');
ok('renewal: another store renewing the same ids does not count',
  due([row(), row({ PurchaseId: 'b', OwnerId: 'o2', CreatedAt: '2026-10-05T00:00:00Z', EndsAt: new Date(now + 99 * H).toISOString() })]).join() === 'a');
box.siteBaseUrl = () => 'https://mwakete.com';
const mail = box.featureRenewalEmailBody({ StoreName: 'Bong' }, { purchaseId: 'fp 1', productIds: ['p1', 'p2'], productNames: ['Rice', 'Flour'],
  days: 7, endsAt: new Date(now + 20 * H).toISOString() });
ok('renewal email links to the renew page with the purchase id', mail.includes('https://mwakete.com/owner/feature.html?renew=fp%201'), mail);
ok('renewal email names the products and the renewal price', /- Rice\n- Flour/.test(mail) && mail.includes('$0.70'));
box.siteBaseUrl = () => '';
ok('renewal email without SITE_BASE_URL says where to go instead of a broken link',
  /open Feature products from your store dashboard/.test(box.featureRenewalEmailBody({ StoreName: 'B' }, { purchaseId: 'x', productIds: ['p1'], productNames: ['R'], days: 1, endsAt: new Date().toISOString() })));

/* ---------- results: views while featured ---------- */
const g = (r, cur) => box.featureViewsGained(r, cur || {});
ok('results: no start snapshot -> null (shown as nothing)', g({}) === null);
ok('results: live window uses the current count', JSON.stringify(g({ ViewsAtStartJson: '{"p1":10,"p2":0}' }, { p1: 25, p2: 3 })) === '{"p1":15,"p2":3}');
ok('results: ended window uses the frozen end count, not later views',
  JSON.stringify(g({ ViewsAtStartJson: '{"p1":10}', ViewsAtEndJson: '{"p1":14}' }, { p1: 99 })) === '{"p1":4}');
ok('results: a deleted product counts 0, never negative', JSON.stringify(g({ ViewsAtStartJson: '{"p1":10}' }, {})) === '{"p1":0}');
ok('results: malformed JSON -> null, no crash', g({ ViewsAtStartJson: '{oops' }) === null);

/* ---------- "Featured" badge marker ---------- */
const cacheStore = {};
box.CacheService = { getScriptCache: () => ({ get: (k) => cacheStore[k] || null, put: (k, v) => { cacheStore[k] = v; } }) };
let builds = 0;
box.activePaidFeaturedProductIds = () => { builds++; return ['p1']; };
const listRes = { ok: true, products: [{ productId: 'p1' }, { productId: 'p2' }] };
box.markPaidFeatured(listRes);
ok('badge: a paid-featured product is marked, others explicitly not', listRes.products[0].featured === true && listRes.products[1].featured === false);
box.markPaidFeatured({ ok: true, products: [{ productId: 'p1' }] });
ok('badge: the featured-id list is cached, not rebuilt per request', builds === 1, builds);
const failRes = { ok: false, error: 'x' };
ok('badge: errors and non-list responses pass through untouched', box.markPaidFeatured(failRes) === failRes && box.markPaidFeatured({ ok: true, stores: [] }).products === undefined);

let f = 0;
console.log('\n--- paid featuring: price + payment decision ---');
for (const [s, n, e] of R) { if (s === 'FAIL') f++; console.log(`${s}  ${n}${e !== '' ? '  [' + e + ']' : ''}`); }
console.log(`\n${R.length - f}/${R.length} passed`);
process.exit(f ? 1 : 0);
