/**
 * Payment audit fixes (Oct 2026), on the REAL backend sources (gas-harness):
 *   A/C  the duplicate checks (screenshot, bank Reference Number, this order's
 *        status, the weekly total) are re-run under one lock right before the
 *        write - so an upload that lands while another is being read can't
 *        slip through. Simulated by letting the "OCR" step of one upload run a
 *        second, competing upload to completion first.
 *   D    a person approving a paid purchase must have seen it in the bank;
 *        auto-approved paid featuring stops after 7 days unless ticked, with
 *        emails to the admins 2 days and 1 day before.
 */
const { makeBox } = require('./lib/gas-harness.js');
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e === undefined ? '' : e]);

const products = [['ProductId', 'OwnerId', 'Name', 'Status', 'Views']];
for (let i = 1; i <= 8; i++) products.push(['p' + i, 'own_s', 'S' + i, 'active', 0]);
const box = makeBox({ Products: products,
  Owners: [['OwnerId', 'StoreSlug', 'StoreName', 'Status', 'Phone', 'TwoFAEnabled', 'Email'],
    ['own_s', 's', 'Shop', 'active', '73000001', 'false', 'shop@example.com']] });
const S = { OwnerId: 'own_s', StoreSlug: 's', StoreName: 'Shop', Status: 'active', Phone: '73000001', TwoFAEnabled: 'false', Email: 'shop@example.com' };
box.__props.FEATURE_STORE_WEEKLY_AUTO_MAX = '100';
box.__props.FEATURE_NEW_STORE_WEEKLY_AUTO_MAX = '100';
box.MailApp.getRemainingDailyQuota = () => 100;
box.saveFeatureScreenshot = () => 'https://drive.example/x';
box.notifyAdminsOfFeaturePayment = () => {};
const rows = () => box.__sheets.FeaturePurchases.objects();
const row = (id) => rows().find((r) => r.PurchaseId === id);

const day = box.featureLocalDay(Date.now()).split('-');
const receipt = (p, no) => `Transaction Status\nPosted\nAUD ${p.amount.toFixed(2)}\nRecipient Account Number 906149\n`
  + `Recipient Reference ${p.reference}\nDate ${day[2]}/${day[1]}/${day[0]}\nReference Number ${no}`;
const png = (seed) => { const b = Buffer.alloc(20000); b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  b.writeUInt32BE(720, 16); b.writeUInt32BE(1600, 20); b.write(seed, 100); return b.toString('base64'); };
let onOcr = null;
let ocrText = '';
box.ocrPaymentImage = () => { const mine = ocrText; if (onOcr) { const f = onOcr; onOcr = null; f(); } return mine; };
const start = (ids) => box.actionStartFeaturePurchase(S, { productIds: ids, days: 2 }).purchase;
const upload = (p, no, seed) => { ocrText = receipt(p, no); return box.actionSubmitFeaturePayment(S, { purchaseId: p.purchaseId, mimeType: 'image/png', imageBase64: png(seed || no + p.purchaseId) }); };

/* ---------- A/C: races ---------- */
const a = start(['p1']), b = start(['p2']);
// While A's receipt is being read, B uploads the SAME bank receipt and is approved first.
onOcr = () => { const rb = upload(b, 'AQC11111', 'b-shot'); ok('race setup: the competing upload is approved', rb.ok && rb.purchase.status === 'Approved', JSON.stringify(rb)); };
let res = upload(a, 'AQC11111', 'a-shot');
ok('C: same bank receipt landing during the read is caught under the lock -> Rejected', res.ok && res.purchase.status === 'Rejected'
  && /AQC11111\) has already been used/.test(res.message), JSON.stringify(res));
ok('C: ...only ONE purchase holds that receipt as approved/pending',
  rows().filter((r) => r.ReceiptNo === 'AQC11111' && (r.Status === 'Approved' || r.Status === 'Pending review')).length === 1);

const c = start(['p3']), d = start(['p4']);
// The same screenshot file uploaded to another order while this one is being read.
onOcr = () => { upload(d, 'AQC22222', 'same-file'); };
res = upload(c, 'AQC33333', 'same-file');
ok('A: same screenshot landing during the read is caught under the lock', !res.ok && /already been used for another payment/.test(res.error)
  && row(c.purchaseId).Status === 'Awaiting payment', JSON.stringify(res));

const e = start(['p5']);
// The same order uploaded twice at once: the first finishes while the second is being read.
onOcr = () => { upload(e, 'AQC44444', 'e-first'); };
res = upload(e, 'AQC55555', 'e-second');
ok('A: the same order uploaded twice at once - the second is refused, the first stands', !res.ok && /already paid and approved/.test(res.error)
  && row(e.purchaseId).ReceiptNo === 'AQC44444', JSON.stringify(res));

/* ---------- D: a person approving needs the bank tick ---------- */
box.isOwnerAdmin = () => true;
const f = start(['p6']);
ocrText = receipt(f, 'AQC66666').replace(/Reference Number \w+/, '');   // no receipt number -> Pending review
res = box.actionSubmitFeaturePayment(S, { purchaseId: f.purchaseId, mimeType: 'image/png', imageBase64: png('f') });
ok('setup: a payment waiting for review', res.purchase.status === 'Pending review', JSON.stringify(res.purchase));
res = box.actionSetFeaturePurchaseStatus({}, { purchaseId: f.purchaseId, approve: true });
ok('D: plain Approve on an unticked paid purchase is refused', !res.ok && /Seen in bank & approve/.test(res.error), JSON.stringify(res));
res = box.actionSetFeaturePurchaseStatus({}, { purchaseId: f.purchaseId, approve: true, bankSeen: true });
ok('D: "Seen in bank & approve" approves and records the bank tick', res.ok && row(f.purchaseId).Status === 'Approved' && !!row(f.purchaseId).BankMatchedAt, JSON.stringify(res));
const g = start(['p7']);
upload(g, 'AQC77777', 'g');
box.updateRowFromObject(box.__sheets.FeaturePurchases, box.findRowById(box.__sheets.FeaturePurchases, 'PurchaseId', g.purchaseId).__row, { Status: 'Rejected', ReceiptNo: 'AQC11111' });
res = box.actionSetFeaturePurchaseStatus({}, { purchaseId: g.purchaseId, approve: true, bankSeen: true });
ok('D: approving a purchase whose bank receipt another purchase already holds is refused', !res.ok && /already used by another purchase/.test(res.error), JSON.stringify(res));

/* ---------- D: 7-day auto-stop and reminders ---------- */
const H = 3600000, DAY = 24 * H, now = Date.now();
const mk = (id, startedAgoDays, extra) => Object.assign({ PurchaseId: id, OwnerId: 'own_s', Status: 'Approved', Amount: 1,
  StartsAt: new Date(now - startedAgoDays * DAY).toISOString(), Reference: 'MWF' + id }, extra);
let plan = box.featureBankMatchPlan([mk('x1', 4), mk('x2', 5.5), mk('x3', 6.5), mk('x4', 7.1), mk('x5', 8, { BankMatchedAt: 'y' }),
  mk('x6', 8, { Amount: 0 }), mk('x7', 8, { Status: 'Pending review' })], now, 7, {});
ok('plan: 4 days in -> nothing yet', !JSON.stringify(plan).includes('"x1"'));
ok('plan: 1.5 days left -> the 2-day reminder', plan.remind2.map((i) => i.row.PurchaseId).join() === 'x2', JSON.stringify(plan.remind2.map((i) => i.row.PurchaseId)));
ok('plan: 0.5 days left -> the 1-day reminder', plan.remind1.map((i) => i.row.PurchaseId).join() === 'x3');
ok('plan: past 7 days -> stop', plan.stop.map((i) => i.row.PurchaseId).join() === 'x4');
ok('plan: ticked, free and pending purchases are never reminded or stopped', !/x5|x6|x7/.test(JSON.stringify(plan)));
plan = box.featureBankMatchPlan([mk('x2', 5.5)], now, 7, { x2: { 2: 'sent' } });
ok('plan: each reminder goes once', plan.remind2.length === 0);

box.__props.ADMIN_EMAILS = 'boss@x.com';
ok('reminder emails default to the admins', box.featureBankReminderEmails().join() === 'boss@x.com');
box.__props.FEATURE_BANK_REMINDER_EMAILS = 'a@x.com, b@x.com, c@x.com';
ok('...and go to the Script Property list when the owner sets one', box.featureBankReminderEmails().join() === 'a@x.com,b@x.com,c@x.com');

// The sweep, end to end, on the real sheet.
const fp = box.__sheets.FeaturePurchases;
const setRow = (id, o) => box.updateRowFromObject(fp, box.findRowById(fp, 'PurchaseId', id).__row, o);
setRow(b.purchaseId, { StartsAt: new Date(now - 5.5 * DAY).toISOString() });   // 1.5 days left
setRow(e.purchaseId, { StartsAt: new Date(now - 7.5 * DAY).toISOString() });   // past the 7 days
box.__mail.length = 0;
box.sweepFeatureBankMatches();
const mails = box.__mail.map((m) => ({ to: m[0], subject: m[1], body: m[2] }));
const remind = mails.filter((m) => /to tick in the bank - stops in about 2 days/.test(m.subject));
ok('sweep: the 2-day reminder emails everyone on the list, naming the payment', remind.length === 3
  && remind.every((m) => m.body.includes(b.reference) && /Seen in bank/.test(m.body)), JSON.stringify(mails.map((m) => m.to + ': ' + m.subject)));
ok('sweep: the overdue one is Stopped, and leaves Tips', row(e.purchaseId).Status === 'Stopped' && /auto-stopped/.test(row(e.purchaseId).OcrNotes)
  && box.activePaidFeaturedProductIds().indexOf('p5') === -1);
ok('sweep: admins are told what stopped', mails.filter((m) => /featuring stopped - payment not seen in bank/.test(m.subject)).length === 3);
ok('sweep: the seller is told and how to get it restarted', mails.some((m) => m.to === 'shop@example.com' && /could not find your payment/.test(m.body) && /reply to this email/.test(m.body)));
box.__mail.length = 0;
box.sweepFeatureBankMatches();
ok('sweep: running again an hour later sends nothing new', box.__mail.length === 0, JSON.stringify(box.__mail.map((m) => m[1])));
ok('a stopped purchase keeps its bank receipt claimed', box.featureDecisionContext(rows(), { PurchaseId: 'new', OwnerId: 'own_s' }, now).usedReceiptNumbers.indexOf('AQC44444') !== -1);
res = box.actionSetFeaturePurchaseStatus({}, { purchaseId: e.purchaseId, approve: true, bankSeen: true });
ok('a stopped purchase that really was paid can be restarted with "Seen in bank & approve"', res.ok && row(e.purchaseId).Status === 'Approved', JSON.stringify(res));
setRow(b.purchaseId, { BankMatchedAt: new Date().toISOString() });
box.__mail.length = 0;
box.sweepFeatureBankMatches();
ok('once ticked, no more reminders', box.__mail.length === 0);

let fails = 0;
console.log('\n--- payment audit fixes ---');
for (const [s, n, x] of R) { if (s === 'FAIL') fails++; console.log(`${s}  ${n}${x !== '' ? '  [' + x + ']' : ''}`); }
console.log(`\n${R.length - fails}/${R.length} passed`);
process.exit(fails ? 1 : 0);
