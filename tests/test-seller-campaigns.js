/**
 * Seller Campaign Studio on the REAL Apps Script sources (gas-harness):
 * drafts and ownership, validation, the MWC payment (pre-screen only, admin
 * verifies), content approval, Kiribati-day billing (idempotent, never while
 * pending / paused / stopped), exhaustion, extension, refunds, the engine link
 * and the email it sends - and the existing marketing and featuring flows
 * left alone.
 */
const { makeBox } = require('./lib/gas-harness.js');
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e === undefined ? '' : e]);
const J = (x) => JSON.stringify(x).slice(0, 300);
const DAY = 86400000;
const ago = (d) => new Date(Date.now() - d * DAY).toISOString();
const FUT = new Date(Date.now() + 30 * DAY).toISOString();

const H = {
  Campaigns: ['CampaignId', 'Name', 'Type', 'Status', 'Objective', 'AudienceType', 'AudienceFilterJson', 'ProductIdsJson', 'StoreSlugsJson', 'Subject', 'PreviewText', 'BodyHtml', 'BodyText', 'CTAUrl', 'CTAType', 'StartAt', 'EndAt', 'CreatedAt', 'UpdatedAt', 'CreatedBy', 'MaxRecipients', 'SentCount', 'FailedCount', 'LastRunAt', 'SourceKey'],
  CampaignEvents: ['EventId', 'CampaignId', 'CustomerId', 'Email', 'EventType', 'Status', 'CreatedAt', 'SentAt', 'FailureReason', 'MetadataJson', 'Attempts'],
  MarketingPreferences: ['CustomerId', 'Email', 'PromotionalEmailOptIn', 'FrequencyLimit', 'LastPromotionalEmailAt', 'UpdatedAt', 'OptInAt', 'UnsubscribeToken']
};

const box = makeBox({
  Owners: [['OwnerId', 'StoreSlug', 'StoreName', 'Status', 'Email', 'Phone', 'Island', 'Village'],
    ['own_a', 'ana', 'Ana Shop', 'active', 'ana@x.com', '73001111', 'South Tarawa', 'Bairiki'],
    ['own_b', 'bob', 'Bob Store', 'active', 'bob@x.com', '73002222', 'Abaiang', ''],
    ['own_adm', 'admin', 'ADMIN', 'active', 'boss@mwakete.com', '', '', '']],
  Sessions: [['Token', 'OwnerId', 'CreatedAt', 'ExpiresAt'], ['tok-a', 'own_a', '', FUT], ['tok-b', 'own_b', '', FUT], ['tok-adm', 'own_adm', '', FUT]],
  Products: [['ProductId', 'OwnerId', 'StoreSlug', 'Name', 'Status', 'Category', 'ListingType', 'ImageUrl', 'Views', 'CreatedAt'],
    ['p1', 'own_a', 'ana', 'Rice 25kg', 'active', 'home', 'product', 'https://res.cloudinary.com/x/rice.jpg', 50, ago(40)],
    ['p2', 'own_a', 'ana', 'Sugar 2kg', 'active', 'home', 'product', '', 30, ago(2)],
    ['p3', 'own_a', 'ana', 'Old bucket', 'inactive', 'home', 'product', '', 3, ago(9)],
    ['p4', 'own_b', 'bob', 'Fishing net', 'active', 'fishing', 'product', '', 10, ago(3)]],
  Variants: [['VariantId', 'ProductId', 'OwnerId', 'Label', 'Price', 'Status'], ['v1', 'p1', 'own_a', 'One', 30, 'active']],
  Customers: [['CustomerId', 'Name', 'Email', 'Phone', 'EmailVerified', 'CreatedAt', 'UpdatedAt'],
    ['c1', 'Tera Kum', 'tera@x.com', '7301', 'true', ago(100), ago(100)],
    ['c2', 'Bwena', 'bwena@x.com', '7302', 'true', ago(100), ago(100)]],
  Orders: [['OrderId', 'OwnerId', 'StoreSlug', 'CustomerName', 'CustomerEmail', 'ItemsJson', 'Status', 'CreatedAt', 'Total'],
    ['o1', 'own_a', 'ana', 'Tera', 'tera@x.com', JSON.stringify([{ productId: 'p1', variantId: 'v1', qty: 1 }]), 'Fulfilled', ago(5), 30]],
  Bookings: [['BookingId', 'OwnerId', 'StoreSlug', 'ProductId', 'CustomerEmail', 'Status', 'CreatedAt']],
  Reviews: [['ReviewId', 'ProductId', 'OwnerId', 'StoreSlug', 'CustomerId', 'Status', 'CreatedAt']],
  AbandonedCarts: [['Id', 'StoreSlug', 'OwnerId', 'Email', 'CartJson', 'CreatedAt', 'Reminded', 'ConvertedOrderId']],
  Campaigns: [H.Campaigns], CampaignEvents: [H.CampaignEvents], MarketingPreferences: [H.MarketingPreferences]
}, { guest: true });
box.__props.ADMIN_EMAILS = 'boss@mwakete.com';
box.__props.SITE_BASE_URL = 'https://mwakete.com';
box.__props.PEPPER = 'p';
box.MailApp.getRemainingDailyQuota = () => 100;
box.ContentService = { createTextOutput: (s) => ({ s, setMimeType() { return this; } }), MimeType: { JSON: 'json' } };
box.setMarketingOptIn({ CustomerId: 'c1', Email: 'tera@x.com' }, true);
box.setMarketingOptIn({ CustomerId: 'c2', Email: 'bwena@x.com' }, true);
let ocrText = null;
box.ocrPaymentImage = () => ocrText;
const png = (seed) => { const b = Buffer.alloc(20000); b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  b.writeUInt32BE(720, 16); b.writeUInt32BE(1600, 20); b.write(seed, 100); return b.toString('base64'); };

const owner = (id) => box.sheetToObjects(box.getSheet('Owners')).find((o) => o.OwnerId === id);
const A = owner('own_a'), B = owner('own_b'), ADM = owner('own_adm');
const rows = (tab) => box.sheetToObjects(box.getSheet(tab));
const today = box.scToday();
const dayAfter = (n) => box.scToday(Date.now() + n * DAY);
const clearCache = () => Object.keys(box.__cache).forEach((k) => delete box.__cache[k]);
const live = () => { box.__props.MARKETING_ENABLED = 'true'; box.__props.MARKETING_DRY_RUN = 'false'; };
const sweep = (dayOffset) => { clearCache(); return box.runSellerCampaignSweep(box.marketingConfig(), Date.now() + (dayOffset || 0) * DAY); };
const camp = (id) => rows('SellerCampaigns').find((c) => c.CampaignId === id);
const ledger = (id) => box.sheetToObjects(box.scLedgerSheet()).filter((l) => l.CampaignId === id);
const post = (b) => JSON.parse(box.doPost({ postData: { contents: JSON.stringify(b) } }).s);
const full = (extra) => Object.assign({
  name: 'Rice week', goal: 'products', subject: 'Rice at {{storeName}}', previewText: 'Fresh stock',
  productIds: ['p1', 'p2'], audience: 'STORE_CUSTOMERS', startDate: today, days: 7, template: 'spotlight',
  style: { background: '#ffffff', accent: '#332d63', padding: 'normal' },
  blocks: [{ type: 'heading', text: 'New in at {{storeName}}', size: 24 }, { type: 'text', text: 'Hi {{customerName}}, rice is back.' },
    { type: 'image', productIndex: 0 }, { type: 'products', layout: 'list' }, { type: 'button', label: 'Shop now', target: 'store' }]
}, extra || {});
const newCampaign = (who, extra) => box.actionSaveCampaignDraft(who || A, full(extra)).campaign;
const payAndVerify = (c, seed) => {
  const s = box.actionStartCampaignPayment(A, { campaignId: c.campaignId });
  box.actionSubmitCampaignPayment(A, { paymentId: s.payment.paymentId, mimeType: 'image/png', imageBase64: png(seed || c.campaignId) });
  box.actionAdminDecideCampaignPayment(ADM, { paymentId: s.payment.paymentId, verify: true, confirm: true });
  return s;
};

/* ---------- drafts and ownership ---------- */
let r = box.actionSaveCampaignDraft(A, { name: 'Half done' });
ok('a seller can save an incomplete draft', r.ok && r.campaign.status === 'DRAFT' && r.campaign.missing.length > 3, J(r));
const draftId = r.campaign.campaignId;
r = box.actionSaveCampaignDraft(A, { campaignId: draftId, name: 'Half done, renamed' });
ok('...and edit it', r.ok && camp(draftId).Name === 'Half done, renamed');
ok('another seller cannot edit it', !box.actionSaveCampaignDraft(B, { campaignId: draftId, name: 'mine now' }).ok && camp(draftId).Name === 'Half done, renamed');
ok('...or open it', !box.actionGetCampaignDetail(B, { campaignId: draftId }).ok);
ok('...or see it in their studio', !box.actionGetCampaignStudio(B).campaigns.some((c) => c.campaignId === draftId));
ok('...or pause, stop or duplicate it', ['pause', 'stop', 'duplicate'].every((op) => !box.actionCampaignAction(B, { campaignId: draftId, op, confirm: true }).ok));

/* ---------- validation ---------- */
const bad = (extra) => box.actionSaveCampaignDraft(A, Object.assign({ campaignId: draftId }, extra));
ok('a "coming soon" goal cannot be chosen', !bad({ goal: 'sale' }).ok);
ok('another seller\'s product is refused', /not an active listing/.test(bad({ productIds: ['p4'] }).error || ''));
ok('an unlisted product of their own is refused', !bad({ productIds: ['p3'] }).ok);
ok('a made-up product id is refused', !bad({ productIds: ['nope'] }).ok);
ok('more than 4 products is refused', !bad({ productIds: ['p1', 'p2', 'p1x', 'p2x', 'p5'] }).ok);
ok('HTML in text is refused', /plain text/.test(bad({ blocks: [{ type: 'text', text: '<script>alert(1)</script>' }] }).error || ''));
ok('an unknown block type is refused', !bad({ blocks: [{ type: 'html', html: '<b>x</b>' }] }).ok);
ok('an unknown audience is refused', !bad({ audience: 'EVERY_EMAIL_IN_THE_DB' }).ok);
ok('a start date in the past is refused', !bad({ startDate: '2020-01-01' }).ok);
ok('more than 60 days is refused', !bad({ days: 61 }).ok);
r = bad({ style: { background: 'url(javascript:x)', accent: 'red' } });
ok('colours outside the palette fall back to safe ones', r.ok && JSON.parse(camp(draftId).StyleJson).background === '#ffffff');
r = bad({ status: 'ACTIVE', PaidDays: 99, paidDays: 99 });
ok('a seller cannot set status or paid days through a draft', camp(draftId).Status === 'DRAFT' && Number(camp(draftId).PaidDays) === 0);

/* ---------- payment is closed until sending is live ---------- */
const c1 = newCampaign();
r = box.actionStartCampaignPayment(A, { campaignId: c1.campaignId });
ok('payment is refused while campaign emails are off (default)', !r.ok && /not switched on/.test(r.error), J(r));
live();
r = box.actionStartCampaignPayment(A, { campaignId: draftId });
ok('an incomplete campaign cannot be paid for, and says what is missing', !r.ok && /Before paying, add/.test(r.error), J(r));

/* ---------- the estimate and description follow edits ---------- */
r = box.actionSaveCampaignDraft(A, { campaignId: c1.campaignId, days: 10 });
ok('changing days updates the estimate (10 days = A$1.00)', r.campaign.estimatedCost === 1 && /10 active days at A\$0\.10 per day - an estimated total of A\$1\.00/.test(r.campaign.description), r.campaign.description);
r = box.actionSaveCampaignDraft(A, { campaignId: c1.campaignId, days: 7 });
ok('7 days = A$0.70, and the description says so', r.campaign.estimatedCost === 0.7 && /promotes 2 selected products/.test(r.campaign.description) && /A\$0\.70/.test(r.campaign.description), r.campaign.description);
ok('...and never claims it is running', !/running now/.test(r.campaign.description));

/* ---------- start payment ---------- */
const s1 = box.actionStartCampaignPayment(A, { campaignId: c1.campaignId });
ok('starting payment issues an MWC reference for the exact amount', s1.ok && /^MWC[A-HJ-NP-Z2-9]{6}$/.test(s1.payment.reference) && s1.payment.amount === 0.7 && s1.payment.currency === 'AUD', J(s1));
ok('...with the existing bank details and the thank-you', s1.instructions.accountNumber === box.FEATURE_PAY_ACCOUNT_NUMBER && /Thank You for supporting this project!/.test(s1.thanks));
const again = box.actionStartCampaignPayment(A, { campaignId: c1.campaignId });
ok('asking again returns the same reference (no duplicates)', again.payment.reference === s1.payment.reference && rows('CampaignPayments').filter((p) => p.CampaignId === c1.campaignId).length === 1);
ok('references never collide', box.scNewReference([{ Reference: s1.payment.reference }]) !== s1.payment.reference
  && (() => { const seen = new Set(); for (let i = 0; i < 300; i++) seen.add(box.scNewReference([])); return seen.size === 300; })());

/* ---------- receipt upload is not payment ---------- */
r = box.actionSubmitCampaignPayment(B, { paymentId: s1.payment.paymentId, mimeType: 'image/png', imageBase64: png('b') });
ok('another seller cannot upload against this payment', !r.ok);
r = box.actionSubmitCampaignPayment(A, { paymentId: s1.payment.paymentId, mimeType: 'image/png', imageBase64: png('c1') });
ok('uploading a receipt puts it under review', r.ok && r.payment.status === 'Under review' && camp(c1.campaignId).Status === 'PAYMENT_REVIEW', J(r));
ok('UPLOADING A RECEIPT DOES NOT ACTIVATE OR CREDIT ANYTHING', Number(camp(c1.campaignId).PaidDays) === 0 && ledger(c1.campaignId).length === 0 && !camp(c1.campaignId).EngineCampaignId);
sweep();
ok('...even after the daily run', camp(c1.campaignId).Status === 'PAYMENT_REVIEW' && ledger(c1.campaignId).length === 0);
r = box.actionSubmitCampaignPayment(A, { paymentId: s1.payment.paymentId, mimeType: 'image/png', imageBase64: png('c1-again') });
ok('a second upload while under review is refused', !r.ok && /already waiting/.test(r.error));
const sOther = box.actionStartCampaignPayment(A, { campaignId: newCampaign().campaignId });
r = box.actionSubmitCampaignPayment(A, { paymentId: sOther.payment.paymentId, mimeType: 'image/png', imageBase64: png('c1') });
ok('the same screenshot cannot be used for another payment', !r.ok && /already been used/.test(r.error), J(r));
ocrText = 'Transfer successful 20 Oct 2026 To 999999 Amount AUD 0.70 Reference WRONGREF Reference Number AQC11111';
r = box.actionSubmitCampaignPayment(A, { paymentId: sOther.payment.paymentId, mimeType: 'image/png', imageBase64: png('other') });
ok('a receipt with the wrong reference/account is rejected by the pre-screen, and can be uploaded again', r.ok && r.payment.status === 'Rejected', J(r));
ocrText = null;

/* ---------- only an admin verifies ---------- */
ok('a seller cannot verify a payment', !box.actionAdminDecideCampaignPayment(A, { paymentId: s1.payment.paymentId, verify: true, confirm: true }).ok);
let forged = post({ action: 'adminDecideCampaignPayment', token: 'tok-a', paymentId: s1.payment.paymentId, verify: true, confirm: true });
ok('...not even by posting the admin action with their own session', !forged.ok && /Not authorized/.test(forged.error), J(forged));
forged = post({ action: 'adminReviewCampaign', token: 'tok-a', campaignId: c1.campaignId, approve: true });
ok('...nor approve their own campaign', !forged.ok);
ok('verifying needs an explicit confirmation', !box.actionAdminDecideCampaignPayment(ADM, { paymentId: s1.payment.paymentId, verify: true }).ok);
r = box.actionAdminDecideCampaignPayment(ADM, { paymentId: s1.payment.paymentId, verify: true, confirm: true });
ok('an admin verifies: 7 days credited once, the campaign waits for approval', r.ok && Number(camp(c1.campaignId).PaidDays) === 7 && camp(c1.campaignId).Status === 'AWAITING_APPROVAL'
  && ledger(c1.campaignId).filter((l) => l.EntryType === 'PAYMENT_VERIFIED').length === 1, J(r));
ok('...and records who and when', rows('CampaignPayments').find((p) => p.PaymentId === s1.payment.paymentId).DecidedBy === 'boss@mwakete.com');
ok('verifying twice is refused (no double credit)', !box.actionAdminDecideCampaignPayment(ADM, { paymentId: s1.payment.paymentId, verify: true, confirm: true }).ok && Number(camp(c1.campaignId).PaidDays) === 7);
sweep();
ok('verified but not approved: still not sending or charged', camp(c1.campaignId).Status === 'AWAITING_APPROVAL' && ledger(c1.campaignId).length === 1 && !camp(c1.campaignId).EngineCampaignId);

/* ---------- rejected payments ---------- */
const c2 = newCampaign();
const s2 = box.actionStartCampaignPayment(A, { campaignId: c2.campaignId });
box.actionSubmitCampaignPayment(A, { paymentId: s2.payment.paymentId, mimeType: 'image/png', imageBase64: png('c2') });
ok('rejecting needs a reason', !box.actionAdminDecideCampaignPayment(ADM, { paymentId: s2.payment.paymentId, verify: false, confirm: true }).ok);
r = box.actionAdminDecideCampaignPayment(ADM, { paymentId: s2.payment.paymentId, verify: false, reason: 'Not seen in the bank', confirm: true });
ok('a rejected payment leaves the campaign unpaid', r.ok && camp(c2.campaignId).Status === 'PAYMENT_REJECTED' && Number(camp(c2.campaignId).PaidDays) === 0);
ok('...and it cannot be approved or activated', !box.actionAdminReviewCampaign(ADM, { campaignId: c2.campaignId, approve: true }).ok && (sweep(), camp(c2.campaignId).Status === 'PAYMENT_REJECTED') && ledger(c2.campaignId).length === 0);
r = box.actionSubmitCampaignPayment(A, { paymentId: s2.payment.paymentId, mimeType: 'image/png', imageBase64: png('c2-fixed') });
ok('the seller can upload corrected evidence', r.ok && r.payment.status === 'Under review');

/* ---------- approval, activation and billing ---------- */
ok('requesting changes needs a reason', !box.actionAdminReviewCampaign(ADM, { campaignId: c1.campaignId, approve: false }).ok);
r = box.actionAdminReviewCampaign(ADM, { campaignId: c1.campaignId, approve: true });
ok('approved with today\'s start date: active', r.ok && camp(c1.campaignId).Status === 'ACTIVE', J(r));
sweep();
let cc = camp(c1.campaignId);
const eng = rows('Campaigns').find((x) => x.CampaignId === cc.EngineCampaignId);
ok('the first run charges one day (A$0.10) and links an engine campaign', Number(cc.UsedDays) === 1 && ledger(c1.campaignId).filter((l) => l.EntryType === 'DAY_CHARGE').length === 1
  && eng && eng.Type === 'SELLER_PROMOTION' && eng.Status === 'SCHEDULED' && eng.CreatedBy === 'seller:own_a', J(eng));
ok('the charge is recorded against the Kiribati day', ledger(c1.campaignId).find((l) => l.EntryType === 'DAY_CHARGE').BillingDay === today && Number(ledger(c1.campaignId).find((l) => l.EntryType === 'DAY_CHARGE').Amount) === -0.1);
sweep(); sweep();
ok('REPEATED RUNS ON THE SAME DAY NEVER CHARGE TWICE', Number(camp(c1.campaignId).UsedDays) === 1 && ledger(c1.campaignId).filter((l) => l.EntryType === 'DAY_CHARGE').length === 1);
ok('an admin cannot hand-approve the engine row behind it', /seller/.test(box.actionSetMarketingCampaignStatus(ADM, { campaignId: eng.CampaignId, op: 'cancel' }).error || ''));

// The email it sends - in Ana's own store colour, with her logo (set before the send).
const ownersSheet = box.getSheet('Owners');
box.ensureColumn(ownersSheet, 'LogoUrl');
box.updateRowFromObject(ownersSheet, box.findRowById(ownersSheet, 'OwnerId', 'own_a').__row, { LogoUrl: 'https://res.cloudinary.com/x/ana-logo.png' });
ok('a seller can save their store colour', box.actionSetStoreBrandColor(owner('own_a'), { color: '#1F8A70' }).ok && owner('own_a').BrandColor === '#1f8a70');
const sent = [];
const realSend = box.MailApp.sendEmail;
box.MailApp.sendEmail = (to, subject, body, opts) => { sent.push({ to, subject, body, html: opts && opts.htmlBody }); };
clearCache();
box.processMarketingQueue(box.marketingConfig(), Date.now());
const mail = sent.find((m) => m.to === 'tera@x.com');
ok('the engine emails the store\'s opted-in customer, once', !!mail && !sent.some((m) => m.to === 'bwena@x.com'), J(sent.map((m) => m.to)));
ok('...with the seller\'s blocks, filled in and escaped', mail && /New in at Ana Shop/.test(mail.html) && /Hi Tera, rice is back/.test(mail.body) && mail.subject === 'Rice at Ana Shop', mail && mail.subject);
ok('...their own product photo, and only https links to Mwakete', mail && /res\.cloudinary\.com\/x\/rice\.jpg/.test(mail.html) && !/href="(?!https:\/\/mwakete\.com)/.test(mail.html));
ok('...and an unsubscribe link and who sent it', mail && /unsubscribe\.html\?t=/.test(mail.html) && /Sent by Mwakete for Ana Shop/.test(mail.html));
const anaBrand = box.scBrand(owner('own_a'));
ok('STORE COLOUR: the top bar is the store colour with its logo and name, not Mwakete red', mail && mail.html.includes('background:' + anaBrand.fill + ';padding:12px 16px;color:' + anaBrand.onFill)
  && mail.html.includes('ana-logo.png') && !/#ce1126/i.test(mail.html) && !/>Mwakete<\/div>/.test(mail.html), anaBrand.accent);
ok('...buttons and headings in it, a pale tint behind, a line above the footer', mail && mail.html.includes('color:' + anaBrand.accent + ';text-align') && mail.html.includes('background:' + anaBrand.tint)
  && mail.html.includes('border-top:3px solid ' + anaBrand.fill) && mail.html.includes('background:' + anaBrand.fill + ';color:' + anaBrand.onFill + ';padding:12px 22px'));
ok('...locked: the campaign\'s own saved colour is not used', mail && !mail.html.includes('#332d63'));
ok('...and Mwakete only small in the footer', mail && (mail.html.match(/Mwakete/g) || []).length === 2 && /Sent by Mwakete for Ana Shop/.test(mail.html));
ok('the plain-text email opens with the store name', mail && /^Ana Shop\n/.test(mail.body));
sent.length = 0;
clearCache();
box.processMarketingQueue(box.marketingConfig(), Date.now());
ok('a second run does not email the same customer again', !sent.some((m) => m.to === 'tera@x.com'));
box.MailApp.sendEmail = realSend;

/* ---------- future start ---------- */
const c3 = newCampaign(A, { startDate: dayAfter(2), days: 3 });
payAndVerify(c3, 'c3');
box.actionAdminReviewCampaign(ADM, { campaignId: c3.campaignId, approve: true });
ok('a future start date is SCHEDULED after approval', camp(c3.campaignId).Status === 'SCHEDULED');
sweep(0); sweep(1);
ok('...and stays scheduled, uncharged, until that day', camp(c3.campaignId).Status === 'SCHEDULED' && ledger(c3.campaignId).filter((l) => l.EntryType === 'DAY_CHARGE').length === 0);
sweep(2);
ok('...then starts and is charged from its start day', camp(c3.campaignId).Status === 'ACTIVE' && ledger(c3.campaignId).filter((l) => l.EntryType === 'DAY_CHARGE').map((l) => l.BillingDay).join() === dayAfter(2));

/* ---------- pause, resume, stop ---------- */
r = box.actionCampaignAction(A, { campaignId: c3.campaignId, op: 'pause' });
ok('pausing works', r.ok && camp(c3.campaignId).Status === 'PAUSED' && rows('Campaigns').find((x) => x.CampaignId === camp(c3.campaignId).EngineCampaignId).Status === 'PAUSED');
sweep(3); sweep(4);
ok('PAUSED DAYS ARE NOT CHARGED', ledger(c3.campaignId).filter((l) => l.EntryType === 'DAY_CHARGE').length === 1);
box.actionCampaignAction(A, { campaignId: c3.campaignId, op: 'resume' });
sweep(5);
ok('resuming charges again from that day', camp(c3.campaignId).Status === 'ACTIVE' && ledger(c3.campaignId).filter((l) => l.EntryType === 'DAY_CHARGE').length === 2);
ok('stopping needs confirmation', !box.actionCampaignAction(A, { campaignId: c3.campaignId, op: 'stop' }).ok);
box.actionCampaignAction(A, { campaignId: c3.campaignId, op: 'stop', confirm: true });
sweep(6); sweep(7);
ok('STOPPED CAMPAIGNS ARE NOT CHARGED', camp(c3.campaignId).Status === 'STOPPED' && ledger(c3.campaignId).filter((l) => l.EntryType === 'DAY_CHARGE').length === 2);
ok('...and cannot be resumed', !box.actionCampaignAction(A, { campaignId: c3.campaignId, op: 'resume' }).ok);
ok('...or edited', !box.actionSaveCampaignDraft(A, { campaignId: c3.campaignId, name: 'again' }).ok);

/* ---------- running out ---------- */
const c4 = newCampaign(A, { days: 2 });
payAndVerify(c4, 'c4');
box.actionAdminReviewCampaign(ADM, { campaignId: c4.campaignId, approve: true });
sweep(0); sweep(1);
ok('two paid days: charged on two days', Number(camp(c4.campaignId).UsedDays) === 2 && camp(c4.campaignId).Status === 'ACTIVE');
sweep(2);
const e4 = () => rows('Campaigns').find((x) => x.CampaignId === camp(c4.campaignId).EngineCampaignId);
ok('EXHAUSTED: day 3 is not charged and delivery stops', camp(c4.campaignId).Status === 'EXHAUSTED' && ledger(c4.campaignId).filter((l) => l.EntryType === 'DAY_CHARGE').length === 2 && e4().Status === 'PAUSED');
sweep(3);
ok('...and it does not start again on its own', camp(c4.campaignId).Status === 'EXHAUSTED');
ok('the seller was told on the last day and when it ran out', box.__mail.some((m) => m[0] === 'ana@x.com' && /Last paid day/.test(m[1])) && box.__mail.some((m) => m[0] === 'ana@x.com' && /used its paid days/.test(m[1])));
const ext = box.actionExtendCampaign(A, { campaignId: c4.campaignId, days: 3 });
ok('extending issues a new reference for the new days', ext.ok && ext.payment.amount === 0.3 && ext.payment.kind === 'extension' && ext.payment.reference !== c4.reference);
box.actionSubmitCampaignPayment(A, { paymentId: ext.payment.paymentId, mimeType: 'image/png', imageBase64: png('ext4') });
box.actionAdminDecideCampaignPayment(ADM, { paymentId: ext.payment.paymentId, verify: true, confirm: true });
ok('a verified extension adds days but leaves it paused for the seller to resume', Number(camp(c4.campaignId).PaidDays) === 5 && camp(c4.campaignId).Status === 'PAUSED');

/* ---------- editing a paid campaign ---------- */
r = box.actionSaveCampaignDraft(A, { campaignId: c4.campaignId, subject: 'New subject' });
ok('editing a paid campaign asks for confirmation first', !r.ok && r.needsConfirmation === true);
r = box.actionSaveCampaignDraft(A, { campaignId: c4.campaignId, subject: 'New subject', confirmReapproval: true });
ok('...then goes back for approval and does not send meanwhile', r.ok && camp(c4.campaignId).Status === 'AWAITING_APPROVAL');
ok('days on a paid campaign change only through Extend', !box.actionSaveCampaignDraft(A, { campaignId: c4.campaignId, days: 30, confirmReapproval: true }).ok);

/* ---------- refunds ---------- */
box.actionAdminReviewCampaign(ADM, { campaignId: c4.campaignId, approve: true });
box.actionCampaignAction(A, { campaignId: c4.campaignId, op: 'stop', confirm: true });
ok('a refund cannot exceed the unused days', !box.actionAdminRecordCampaignRefund(ADM, { campaignId: c4.campaignId, days: 4, reason: 'Stopped early', confirm: true }).ok);
r = box.actionAdminRecordCampaignRefund(ADM, { campaignId: c4.campaignId, days: 3, reason: 'Stopped early', confirm: true });
ok('a refund of unused days is recorded in the ledger', r.ok && ledger(c4.campaignId).some((l) => l.EntryType === 'REFUND' && Number(l.Amount) === -0.3) && Number(camp(c4.campaignId).PaidDays) === 2);
ok('a seller cannot record a refund', !box.actionAdminRecordCampaignRefund(A, { campaignId: c4.campaignId, days: 1, reason: 'please', confirm: true }).ok);

/* ---------- finishing: everyone reached ---------- */
const before = Number(camp(c1.campaignId).UsedDays);
const e1 = rows('Campaigns').find((x) => x.CampaignId === camp(c1.campaignId).EngineCampaignId);
const eRow = box.findRowById(box.getSheet('Campaigns'), 'CampaignId', e1.CampaignId);
box.updateRowFromObject(box.getSheet('Campaigns'), eRow.__row, { Status: 'SENT' });
sweep(1);
ok('once everyone eligible has it, the campaign completes and stops charging', camp(c1.campaignId).Status === 'COMPLETED' && Number(camp(c1.campaignId).UsedDays) === before);

/* ---------- seller detail: metrics and no admin identities ---------- */
const d = box.actionGetCampaignDetail(A, { campaignId: c1.campaignId });
ok('the seller sees sent, clicks, spend and remaining days', d.ok && d.metrics.sent === 1 && d.metrics.spent === 0.1 && d.metrics.remainingDays === 6, J(d.metrics));
ok('...and is told what is not measured', d.metrics.unavailable.some((u) => /Opens/.test(u)));
ok('...and never sees which admin decided', !JSON.stringify(d).includes('boss@mwakete.com'));
ok('the history records every change', d.history.map((h) => h.action).join(',').includes('payment_verified,approved'));

/* ---------- dry run and engine off: nothing starts or is charged ---------- */
const c5 = newCampaign();
payAndVerify(c5, 'c5');
box.actionAdminReviewCampaign(ADM, { campaignId: c5.campaignId, approve: true });
box.__props.MARKETING_DRY_RUN = 'true';
sweep(8);
ok('in dry run nothing is charged', ledger(c5.campaignId).filter((l) => l.EntryType === 'DAY_CHARGE').length === 0);
box.__props.MARKETING_DRY_RUN = 'false';
box.__props.MARKETING_ENABLED = 'false';
const rs = box.runMarketingSweep();
ok('with emails switched off the hourly run does nothing at all', /MARKETING_ENABLED/.test(rs.skipped) && ledger(c5.campaignId).filter((l) => l.EntryType === 'DAY_CHARGE').length === 0);

/* ---------- admin pause / stop need a reason ---------- */
live();
ok('an admin pause needs a reason and confirmation', !box.actionAdminCampaignAction(ADM, { campaignId: c5.campaignId, op: 'pause', confirm: true }).ok
  && !box.actionAdminCampaignAction(ADM, { campaignId: c5.campaignId, op: 'pause', reason: 'Policy check' }).ok);
r = box.actionAdminCampaignAction(ADM, { campaignId: c5.campaignId, op: 'pause', reason: 'Policy check', confirm: true });
ok('...and is recorded with the reason', r.ok && camp(c5.campaignId).Status === 'PAUSED' && /Policy check/.test(camp(c5.campaignId).StatusNote));
const list = box.actionAdminListCampaigns(ADM, { q: s2.payment.reference, filter: 'all' });
ok('admins can find a campaign by payment reference', list.ok && list.campaigns.length === 1 && list.campaigns[0].campaignId === c2.campaignId, J(list.campaigns && list.campaigns.map((c) => c.campaignId)));
ok('sellers cannot list the admin queue', !box.actionAdminListCampaigns(A, {}).ok);

/* ---------- store colour rules ---------- */
const brandOf = (c) => box.scBrand({ BrandColor: c, BrandColorSetAt: c ? ago(0) : '' });
ok('no colour yet: Mwakete purple', brandOf('').accent === '#332d63' && brandOf('').source === 'default');
ok('a colour too pale to show falls back to purple, and says so', brandOf('#fafafa').accent === '#332d63' && brandOf('#fafafa').tooPale
  && /too pale/.test(box.actionSetStoreBrandColor(owner('own_b'), { color: '#fbfbfb' }).note));
const gold = brandOf('#fcd116');
ok('Kiribati gold is used as it is for the bar and buttons, with dark text on it', gold.source === 'store' && gold.fill === '#fcd116' && gold.onFill === '#1a1a1a');
ok('...and darkened for headings until they read on white (4.5:1)', box.scContrast(gold.accent, '#ffffff') >= 4.5 && gold.accent !== '#fcd116', gold.accent);
ok('a dark colour gets white text', brandOf('#0b3d91').onFill === '#ffffff');
ok('a dark colour is used as it is', brandOf('#0b3d91').accent === '#0b3d91');
ok('only a real colour can be saved', ['red', '#12345', 'url(x)', '#zzzzzz', ''].every((c) => !box.actionSetStoreBrandColor(owner('own_b'), { color: c }).ok));
ok('the studio sends the store colour and logo', (() => { const st = box.actionGetCampaignStudio(owner('own_a')); return st.brand.accent === anaBrand.accent && st.brand.confirmed && /ana-logo/.test(st.brand.logoUrl); })());
ok('the preview the admin approves shows the same colours', box.actionAdminGetCampaign(ADM, { campaignId: c1.campaignId }).preview.html.includes('background:' + anaBrand.fill));
ok('a logo that is not https is never put in an email', box.scBrand({ LogoUrl: 'http://x/logo.png' }).logoUrl === '' && box.scBrand({ LogoUrl: 'javascript:alert(1)' }).logoUrl === '');
// The logo's own pixels for the colour picker: from Drive, for the signed-in seller only.
const logoFile = box.DriveApp.createFolder('logos').createFile(box.Utilities.newBlob([1, 2, 3, 4], 'image/png', 'logo'));
box.ensureColumn(ownersSheet, 'LogoFileId');
box.updateRowFromObject(ownersSheet, box.findRowById(ownersSheet, 'OwnerId', 'own_b').__row, { LogoUrl: 'https://lh3.googleusercontent.com/d/' + logoFile.getId(), LogoFileId: logoFile.getId() });
const ld = box.actionGetStoreLogoData(owner('own_b'));
ok('the colour picker gets the seller\'s own logo as image data', ld.ok && ld.readable && ld.mimeType === 'image/png' && ld.imageBase64 === Buffer.from([1, 2, 3, 4]).toString('base64'));
ok('...through the signed-in session only', /Not authenticated/.test(post({ action: 'getStoreLogoData', token: 'nope' }).error || '') && post({ action: 'getStoreLogoData', token: 'tok-b' }).imageBase64 === ld.imageBase64);
ok('a store with no logo is told so', box.actionGetStoreLogoData(ADM).hasLogo === false);

let fails = 0;
console.log('\n--- seller campaign studio (real backend) ---');
for (const [s, n, x] of R) { if (s === 'FAIL') fails++; console.log(`${s}  ${n}${x !== '' ? '  [' + x + ']' : ''}`); }
console.log(`\n${R.length - fails}/${R.length} passed`);
process.exit(fails ? 1 : 0);
