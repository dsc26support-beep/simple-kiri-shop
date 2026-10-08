/**
 * Free first featuring, on the REAL backend sources (gas-harness): a store's
 * first featuring of up to 3 products costs nothing and is approved at once;
 * once only; 4+ products is paid as normal; and paying goes to Mwakete's
 * own account.
 */
const { makeBox } = require('./lib/gas-harness.js');
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e === undefined ? '' : e]);

const products = [['ProductId', 'OwnerId', 'Name', 'Status', 'Views']];
for (let i = 1; i <= 5; i++) products.push(['pa' + i, 'own_a', 'A' + i, 'active', 10 * i]);
products.push(['pb1', 'own_b', 'B1', 'active', 0], ['pc1', 'own_c', 'C1', 'active', 0]);
for (let i = 1; i <= 4; i++) products.push(['pd' + i, 'own_d', 'D' + i, 'active', 0]);
for (let i = 1; i <= 3; i++) products.push(['pe' + i, 'own_e', 'E' + i, 'active', 0]);
products.push(['pf1', 'own_f', 'F1', 'active', 0], ['pg1', 'own_g', 'G1', 'active', 0]);
for (let i = 1; i <= 5; i++) products.push(['ph' + i, 'own_h', 'H' + i, 'active', 0]);
const ownerRows = [['OwnerId', 'StoreSlug', 'StoreName', 'Status', 'Phone'],
  ['own_a', 'a', 'A', 'active', '7300 0001'], ['own_b', 'b', 'B', 'active', '73000002'], ['own_c', 'c', 'C', 'active', '73000003'],
  ['own_d', 'd', 'D', 'active', '73000004'],
  ['own_e', 'e', 'E', 'active', '+686 7300 0001'],  // same person as A, second store
  ['own_f', 'f', 'F', 'active', ''], ['own_g', 'g', 'G', 'standby', '73000007'], ['own_h', 'h', 'H', 'active', '73000008']];
const box = makeBox({ Products: products, Owners: ownerRows });
const owner = (id) => { const r = ownerRows.find((x) => x[0] === id); return { OwnerId: r[0], StoreSlug: r[1], StoreName: r[2], Status: r[3], Phone: r[4] }; };
const A = owner('own_a'), B = owner('own_b'), C = owner('own_c'), D = owner('own_d'), E = owner('own_e'), F = owner('own_f'), G = owner('own_g'), H = owner('own_h');
const rows = () => box.__sheets.FeaturePurchases.objects();

/* ---------- pure rules ---------- */
ok('pure: free for 1-3 products when unused', box.featureIsFree([], A, 1) && box.featureIsFree([], A, 3));
ok('pure: never free for 0 or 4+ products', !box.featureIsFree([], A, 0) && !box.featureIsFree([], A, 4));
ok('pure: a paid row does not use up the free one', !box.featureFreeUsed([{ OwnerId: 'own_a', Amount: 0.35 }], A));
ok('pure: an Amount 0 row does', box.featureFreeUsed([{ OwnerId: 'own_a', Amount: 0 }], A));
ok('pure: matched by store slug too (same store, other owner id)', box.featureFreeUsed([{ OwnerId: 'x', StoreSlug: 'a', Amount: 0 }], A));
ok('pure: another store\'s free row does not count', !box.featureFreeUsed([{ OwnerId: 'own_b', StoreSlug: 'b', Amount: 0 }], A));
ok('pure: a blank Amount is not read as free', !box.featureFreeUsed([{ OwnerId: 'own_a', Amount: '' }], A));

ok('pure: phones compare without spaces or the +686 code', box.normalizeFeaturePhone('+686 7300 0001') === '73000001' && box.normalizeFeaturePhone('7300 0001') === '73000001');
ok('pure: another store with the same phone that had it -> used',
  box.featureFreeBlock([{ OwnerId: 'own_a', Amount: 0 }], E, { own_a: '7300 0001', own_e: '+686 7300 0001' }) === 'used');
ok('pure: no phone -> nophone; paused store -> inactive',
  box.featureFreeBlock([], F, {}) === 'nophone' && box.featureFreeBlock([], G, {}) === 'inactive');

/* ---------- list says the offer is there ---------- */
let res = box.actionListMyFeaturePurchases(A);
ok('list: freeAvailable true and freeMaxProducts 3 for a new store', res.ok && res.freeAvailable === true && res.freeMaxProducts === 3, JSON.stringify(res));
ok('list: pays Mwakete 906149', res.payment.accountName === 'Mwakete' && res.payment.accountNumber === '906149', JSON.stringify(res.payment));

/* ---------- first featuring of 3: free ---------- */
box.__cache['v3:tips'] = 'stale';
res = box.actionStartFeaturePurchase(A, { productIds: ['pa1', 'pa2', 'pa3'], days: 14 });
let p = res.purchase;
ok('3 products: free, Approved straight away, amount 0', res.ok && res.free === true && p.status === 'Approved' && p.amount === 0, JSON.stringify(res));
ok('...runs for the chosen days', Math.abs(new Date(p.endsAt) - new Date(p.startsAt) - 14 * 86400000) < 5000, p.startsAt + ' ' + p.endsAt);
const r0 = rows()[0];
ok('...records the views snapshot so results work', r0.ViewsAtStartJson === '{"pa1":10,"pa2":20,"pa3":30}', r0.ViewsAtStartJson);
ok('...noted as the free one, no screenshot', r0.OcrNotes === 'free: first featuring' && r0.ScreenshotUrl === '');
ok('...Tips cache is cleared so it shows at once', !('v3:tips' in box.__cache));
ok('...is live on Tips right away (in the paid-featured list)', box.activePaidFeaturedProductIds().sort().join() === 'pa1,pa2,pa3', box.activePaidFeaturedProductIds().join());
ok('list: offer now gone', box.actionListMyFeaturePurchases(A).freeAvailable === false);

/* ---------- once only ---------- */
res = box.actionStartFeaturePurchase(A, { productIds: ['pa4'], days: 7 });
ok('second featuring (even 1 product) is paid: Awaiting payment, $0.35', res.ok && res.free === false
  && res.purchase.status === 'Awaiting payment' && res.purchase.amount === 0.35, JSON.stringify(res.purchase));
ok('uploading a payment for the free one is refused (already approved)',
  /already paid and approved/.test(box.actionSubmitFeaturePayment(A, { purchaseId: p.purchaseId }).error || ''));

/* ---------- other stores ---------- */
res = box.actionStartFeaturePurchase(B, { productIds: ['pb1'], days: 60 });
ok('another store still gets its own free one', res.free === true && res.purchase.amount === 0 && res.purchase.status === 'Approved');
res = box.actionStartFeaturePurchase(D, { productIds: ['pd1', 'pd2', 'pd3', 'pd4'], days: 2 });
ok('4 products is paid in full ($0.40), not partly free', res.free === false && res.purchase.amount === 0.4 && res.purchase.status === 'Awaiting payment', JSON.stringify(res.purchase));
ok('...and the store keeps its free offer for later', box.actionListMyFeaturePurchases(D).freeAvailable === true);
res = box.actionStartFeaturePurchase(C, { productIds: ['pa1'], days: 1 });
ok('cannot get a free featuring of another store\'s product', !res.ok && /not an active listing/.test(res.error));
ok('...and the failed try did not use C\'s free one', box.actionListMyFeaturePurchases(C).freeAvailable === true);

/* ---------- item 6: one free featuring per person, active stores with a phone ---------- */
res = box.actionListMyFeaturePurchases(E);
ok('6: a second store with the same phone as A has no free offer', res.freeAvailable === false && res.freeBlockedBecause === 'used', JSON.stringify(res));
res = box.actionStartFeaturePurchase(E, { productIds: ['pe1'], days: 1 });
ok('6: ...and is charged normally', res.ok && res.free === false && res.purchase.amount === 0.05, JSON.stringify(res.purchase));
res = box.actionListMyFeaturePurchases(F);
ok('6: a store with no phone is told why', res.freeAvailable === false && res.freeBlockedBecause === 'nophone');
ok('6: ...and pays', box.actionStartFeaturePurchase(F, { productIds: ['pf1'], days: 1 }).free === false);
ok('6: a paused (standby) store gets no free featuring', box.actionStartFeaturePurchase(G, { productIds: ['pg1'], days: 1 }).free === false
  && box.actionListMyFeaturePurchases(G).freeBlockedBecause === 'inactive');

/* ---------- the upload flow (OCR and Drive stubbed) ---------- */
let ocr = '';
box.ocrPaymentImage = () => ocr;
box.saveFeatureScreenshot = () => 'https://drive.example/x';
box.notifyAdminsOfFeaturePayment = () => {};
const png = (w, h, seed) => { const b = Buffer.alloc(20000); b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); b.write(seed, 100); return b.toString('base64'); };
const localDay = box.featureLocalDay(Date.now()).split('-');
const anz = (ref, amount, receiptNo) => `Transaction Status\nPosted\nANZ to ANZ Transfer\nAUD ${amount}\nRecipient Account Number 906149\n`
  + `Recipient Reference ${ref}\nDate ${localDay[2]}/${localDay[1]}/${localDay[0]}\nReference Number ${receiptNo}`;
const pay = (who, p, receiptNo, opts) => {
  ocr = anz(p.reference, p.amount.toFixed(2), receiptNo);
  return box.actionSubmitFeaturePayment(who, { purchaseId: p.purchaseId, mimeType: 'image/png',
    imageBase64: (opts && opts.image) || png(720, 1600, receiptNo + p.purchaseId) });
};
ok('flow: store H uses its free featuring first', box.actionStartFeaturePurchase(H, { productIds: ['ph5'], days: 1 }).free === true);
const dP1 = box.actionStartFeaturePurchase(H, { productIds: ['ph1'], days: 20 }).purchase;   // $1.00
let sub = pay(H, dP1, 'AQC84078');
const r1 = rows().find((r) => r.PurchaseId === dP1.purchaseId);
ok('flow: a good receipt is Approved and the bank Reference Number stored', sub.ok && sub.purchase.status === 'Approved' && r1.ReceiptNo === 'AQC84078', JSON.stringify(sub));
const startIn = new Date(r1.StartsAt).getTime() - Date.now();
ok('5: featuring starts ~2 hours later, and runs the full days from then',
  startIn > 1.9 * 3600000 && startIn <= 2 * 3600000 && Math.abs(new Date(r1.EndsAt) - new Date(r1.StartsAt) - 20 * 86400000) < 1000, r1.StartsAt);
ok('5: not on Tips yet', box.activePaidFeaturedProductIds().indexOf('ph1') === -1);
ok('5: the seller is told it starts within 2 hours', /within 2 hours/.test(sub.message), sub.message);
const dP2 = box.actionStartFeaturePurchase(H, { productIds: ['ph2'], days: 20 }).purchase;
sub = pay(H, dP2, 'AQC84078');
ok('2: the same bank receipt on another order is Rejected', sub.ok && sub.purchase.status === 'Rejected' && /already been used/.test(sub.message), JSON.stringify(sub));
sub = pay(H, dP2, 'AQC99999', { image: png(720, 500, 'crop') });
ok('3: a cropped screenshot is refused before any checking; order unchanged',
  !sub.ok && /full phone screenshot/.test(sub.error) && rows().find((r) => r.PurchaseId === dP2.purchaseId).Status === 'Rejected', JSON.stringify(sub));
const edited = Buffer.from(png(720, 1600, 'x'), 'base64'); edited.write('tEXtSoftware\0Snapseed', 60);
sub = pay(H, dP2, 'AQC99999', { image: edited.toString('base64') });
ok('3: a Snapseed-edited image is refused', !sub.ok && /photo editor \(Snapseed\)/.test(sub.error), JSON.stringify(sub));
sub = pay(H, dP2, 'AQC99999');
ok('flow: the right receipt for order 2 is Approved ($2 this week for H)', sub.ok && sub.purchase.status === 'Approved', JSON.stringify(sub));
const dP3 = box.actionStartFeaturePurchase(H, { productIds: ['ph3', 'ph4'], days: 40 }).purchase;   // $4.00 -> week $6 > $5
sub = pay(H, dP3, 'AQC77777');
ok('4: a new store going over $5 in a week waits for a human', sub.purchase.status === 'Pending review'
  && /weekly auto limit/.test(rows().find((r) => r.PurchaseId === dP3.purchaseId).OcrNotes), JSON.stringify(sub));

/* ---------- admin list shows it ---------- */
box.isOwnerAdmin = () => true;
const admin = box.actionListFeaturePurchases({ OwnerId: 'admin' });
ok('admin list includes the free ones as Approved $0 (A, B, H)', admin.ok && admin.purchases.filter((x) => x.amount === 0 && x.status === 'Approved').length === 3, JSON.stringify(admin).slice(0, 300));

/* ---------- admin "Seen in bank" tick ---------- */
const paidRow = rows().find((r) => Number(r.Amount) === 0.35);
const freeRow = rows().find((r) => r.OwnerId === 'own_a' && Number(r.Amount) === 0);
ok('bank tick: not allowed while still Awaiting payment', /No payment has been uploaded/.test(box.actionSetFeatureBankMatched({}, { purchaseId: paidRow.PurchaseId, matched: true }).error || ''));
box.updateRowFromObject(box.__sheets.FeaturePurchases, box.findRowById(box.__sheets.FeaturePurchases, 'PurchaseId', paidRow.PurchaseId).__row, { Status: 'Approved' });
res = box.actionSetFeatureBankMatched({}, { purchaseId: paidRow.PurchaseId, matched: true });
ok('bank tick: an approved paid purchase can be ticked; the time is stored', res.ok && !!res.bankMatchedAt
  && rows().find((r) => r.PurchaseId === paidRow.PurchaseId).BankMatchedAt === res.bankMatchedAt, JSON.stringify(res));
ok('bank tick: shows in the admin list', box.actionListFeaturePurchases({}).purchases.find((x) => x.purchaseId === paidRow.PurchaseId).bankMatchedAt === res.bankMatchedAt);
res = box.actionSetFeatureBankMatched({}, { purchaseId: paidRow.PurchaseId, matched: false });
ok('bank tick: can be undone', res.ok && rows().find((r) => r.PurchaseId === paidRow.PurchaseId).BankMatchedAt === '');
ok('bank tick: refused on a free featuring', /nothing to match/.test(box.actionSetFeatureBankMatched({}, { purchaseId: freeRow.PurchaseId, matched: true }).error || ''));
box.isOwnerAdmin = () => false;
ok('bank tick: admins only', box.actionSetFeatureBankMatched({}, { purchaseId: paidRow.PurchaseId, matched: true }).error === 'Not authorized');

let f = 0;
console.log('\n--- free first featuring ---');
for (const [s, n, e] of R) { if (s === 'FAIL') f++; console.log(`${s}  ${n}${e !== '' ? '  [' + e + ']' : ''}`); }
console.log(`\n${R.length - f}/${R.length} passed`);
process.exit(f ? 1 : 0);
