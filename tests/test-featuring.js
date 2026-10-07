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
const purchase = { Reference: 'MWFABC234', Amount: 1.05, Days: 7 };
const today = new Date().toISOString().slice(0, 10);
const goodReceipt = `ANZ goMoney\nPayment successful\nTo: Nei Recharge 786149\nAmount $1.05\nReference to recipient MWFABC234\nDate ${today}`;
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
d = decide(goodReceipt.replace('786149', '906149'));
ok('wrong account is Rejected', d.status === 'Rejected' && /786149/.test(d.message), d.message);
d = decide(goodReceipt.replace('Payment successful', 'Payment'));
ok('no success word is Rejected', d.status === 'Rejected' && /successful/.test(d.message), d.message);
d = decide('Transfer Confirmation\nTo Nei Recharge 786149\n$1.05\nMWFABC234\nConfirm   Cancel');
ok('the pre-send Confirm/Cancel screen is Rejected with its own explanation', d.status === 'Rejected' && /before you press Confirm/.test(d.message), d.message);
d = decide(goodReceipt.replace(today, '2020-01-01'));
ok('an old receipt is Rejected', d.status === 'Rejected' && /recent date/.test(d.message), d.message);
ok('reference matching ignores spacing/case OCR noise', decide(goodReceipt.replace('MWFABC234', 'mwf abc 234')).status === 'Approved');

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

let f = 0;
console.log('\n--- paid featuring: price + payment decision ---');
for (const [s, n, e] of R) { if (s === 'FAIL') f++; console.log(`${s}  ${n}${e !== '' ? '  [' + e + ']' : ''}`); }
console.log(`\n${R.length - f}/${R.length} passed`);
process.exit(f ? 1 : 0);
