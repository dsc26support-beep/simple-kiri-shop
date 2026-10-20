/**
 * Admin "Seller campaigns" queue in the browser, on the REAL backend
 * (gas-harness behind every API call): payments to check, search by MWC
 * reference, the receipt screenshot and check notes, verify / reject with a
 * reason, approve / request changes, pause, refund of unused days, stop,
 * billing and history. Admin-only. Phone and desktop widths.
 */
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const { makeBox } = require('./lib/gas-harness.js');
const BASE = process.env.TX_BASE || 'http://127.0.0.1:8099';
const SHOTS = process.env.CS_SHOTS || '';
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e === undefined ? '' : e]);
const DAY = 86400000;
const FUT = new Date(Date.now() + 30 * DAY).toISOString();
const ago = (d) => new Date(Date.now() - d * DAY).toISOString();

const box = makeBox({
  Owners: [['OwnerId', 'StoreSlug', 'StoreName', 'Status', 'Email', 'Phone', 'Island', 'Village', 'Username'],
    ['own_a', 'ana', 'Ana Shop', 'active', 'ana@x.com', '73001111', 'South Tarawa', 'Bairiki', 'ana'],
    ['own_adm', 'admin', 'ADMIN', 'active', 'boss@mwakete.com', '', '', '', 'boss']],
  Sessions: [['Token', 'OwnerId', 'CreatedAt', 'ExpiresAt'], ['tok-a', 'own_a', '', FUT], ['tok-adm', 'own_adm', '', FUT]],
  Products: [['ProductId', 'OwnerId', 'StoreSlug', 'Name', 'Status', 'Category', 'ListingType', 'ImageUrl', 'Views', 'CreatedAt'],
    ['p1', 'own_a', 'ana', 'Rice 25kg', 'active', 'home', 'product', '', 50, ago(40)],
    ['p2', 'own_a', 'ana', 'Sugar 2kg', 'active', 'home', 'product', '', 30, ago(2)],
    ['p3', 'own_a', 'ana', 'Canoe hire', 'active', 'fishing', 'rental', '', 3, ago(9)]],
  Variants: [['VariantId', 'ProductId', 'OwnerId', 'Label', 'Price', 'Status']],
  Customers: [['CustomerId', 'Name', 'Email', 'Phone', 'EmailVerified', 'CreatedAt', 'UpdatedAt'], ['c1', 'Tera', 'tera@x.com', '7301', 'true', ago(100), ago(100)]],
  Orders: [['OrderId', 'OwnerId', 'StoreSlug', 'CustomerName', 'CustomerEmail', 'ItemsJson', 'Status', 'CreatedAt', 'Total'],
    ['o1', 'own_a', 'ana', 'Tera', 'tera@x.com', '[]', 'Fulfilled', ago(5), 30]],
  Bookings: [['BookingId', 'OwnerId', 'StoreSlug', 'ProductId', 'CustomerEmail', 'Status', 'CreatedAt']],
  Reviews: [['ReviewId', 'ProductId', 'OwnerId', 'StoreSlug', 'CustomerId', 'Status', 'CreatedAt']],
  AbandonedCarts: [['Id', 'StoreSlug', 'OwnerId', 'Email', 'CartJson', 'CreatedAt', 'Reminded', 'ConvertedOrderId']],
  Campaigns: [['CampaignId', 'Name', 'Type', 'Status', 'Objective', 'AudienceType', 'AudienceFilterJson', 'ProductIdsJson', 'StoreSlugsJson', 'Subject', 'PreviewText', 'BodyHtml', 'BodyText', 'CTAUrl', 'CTAType', 'StartAt', 'EndAt', 'CreatedAt', 'UpdatedAt', 'CreatedBy', 'MaxRecipients', 'SentCount', 'FailedCount', 'LastRunAt', 'SourceKey']],
  CampaignEvents: [['EventId', 'CampaignId', 'CustomerId', 'Email', 'EventType', 'Status', 'CreatedAt', 'SentAt', 'FailureReason', 'MetadataJson', 'Attempts']],
  MarketingPreferences: [['CustomerId', 'Email', 'PromotionalEmailOptIn', 'FrequencyLimit', 'LastPromotionalEmailAt', 'UpdatedAt', 'OptInAt', 'UnsubscribeToken']]
}, { guest: true });
box.__props.ADMIN_EMAILS = 'boss@mwakete.com';
box.__props.SITE_BASE_URL = 'https://mwakete.com';
box.__props.MARKETING_ENABLED = 'true';
box.__props.MARKETING_DRY_RUN = 'false';
box.MailApp.getRemainingDailyQuota = () => 100;
box.ocrPaymentImage = () => null;
box.ContentService = { createTextOutput: (s) => ({ s, setMimeType() { return this; } }), MimeType: { JSON: 'json' } };
box.setMarketingOptIn({ CustomerId: 'c1', Email: 'tera@x.com' }, true);
const call = (b) => { Object.keys(box.__cache).forEach((k) => delete box.__cache[k]); try { return box.doPost({ postData: { contents: b } }).s; } catch (e) { return JSON.stringify({ ok: false, error: String(e.message || e) }); } };
const ADM = box.sheetToObjects(box.getSheet('Owners')).find((o) => o.OwnerId === 'own_adm');
const png = () => { const b = Buffer.alloc(20000); b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0); b.writeUInt32BE(720, 16); b.writeUInt32BE(1600, 20); b.write('receipt-' + Date.now(), 100); return b; };

const A = box.sheetToObjects(box.getSheet('Owners')).find((o) => o.OwnerId === 'own_a');
const today = box.scToday();
const full = (extra) => Object.assign({
  name: 'Rice week', goal: 'products', subject: 'Rice at {{storeName}}', previewText: 'Fresh stock',
  productIds: ['p1', 'p2'], audience: 'STORE_CUSTOMERS', startDate: today, days: 7, template: 'spotlight',
  style: { background: '#ffffff', accent: '#332d63', padding: 'normal' },
  blocks: [{ type: 'heading', text: 'New in at {{storeName}}', size: 24 }, { type: 'text', text: 'Hi {{customerName}}, rice is back.' },
    { type: 'products', layout: 'list' }, { type: 'button', label: 'Shop now', target: 'store' }]
}, extra || {});
const submit = (name) => {
  const c = box.actionSaveCampaignDraft(A, full({ name })).campaign;
  const s = box.actionStartCampaignPayment(A, { campaignId: c.campaignId });
  box.actionSubmitCampaignPayment(A, { paymentId: s.payment.paymentId, mimeType: 'image/png', imageBase64: png().toString('base64') });
  return { id: c.campaignId, ref: s.payment.reference, paymentId: s.payment.paymentId };
};
const one = submit('Rice week');
const two = submit('Sugar sale');
const camp = (id) => box.sheetToObjects(box.scCampaignsSheet()).find((c) => c.CampaignId === id);
const pay = (id) => box.sheetToObjects(box.scPaymentsSheet()).find((p) => p.PaymentId === id);

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const errors = [];
  const answers = [];
  const open = async (w, token, profile) => {
    const ctx = await browser.newContext({ viewport: { width: w, height: 900 }, serviceWorkers: 'block' });
    await ctx.addInitScript(([t, pr]) => {
      localStorage.setItem('skiri_cookie_consent', 'true');
      localStorage.setItem('skiri_owner_token', t);
      localStorage.setItem('skiri_owner_profile', pr);
    }, [token, JSON.stringify(profile)]);
    await ctx.route('**/macros/s/**', (route) => {
      const b = route.request().postData();
      route.fulfill({ status: 200, contentType: 'application/json', body: b ? call(b) : '{"ok":true}' });
    });
    const p = await ctx.newPage();
    // Playwright's init script is refused inside the sandboxed preview frame - tooling, not the page.
    p.on('pageerror', (e) => { if (!/sandboxed and lacks the 'allow-same-origin' flag/.test(String(e))) errors.push(String(e)); });
    p.on('dialog', (d) => d.accept(d.type() === 'prompt' ? (answers.shift() || '') : undefined));
    await p.goto(BASE + '/owner/admin.html', { waitUntil: 'load' });
    return { ctx, p };
  };
  const shot = async (p, name) => { if (SHOTS) await (await p.$('#seller-campaigns')).screenshot({ path: SHOTS + '/scad-' + name + '.png' }); };
  const ADMIN = { ownerId: 'own_adm', storeName: 'ADMIN', storeSlug: 'admin', isAdmin: true };
  const rowsShown = (p) => p.$$eval('#scad-list tbody tr', (trs) => trs.map((t) => t.textContent.replace(/\s+/g, ' ')));
  const waitMsg = (p, re) => p.waitForFunction((s) => new RegExp(s).test((document.getElementById('scad-msg') || {}).textContent || ''), re, { timeout: 10000 });

  let { ctx, p } = await open(1280, 'tok-adm', ADMIN);
  await p.waitForSelector('#scad-list tbody tr', { timeout: 15000 });
  let shown = await rowsShown(p);
  ok('the queue opens on payments to check, both waiting', shown.length === 2 && shown.some((t) => /Rice week/.test(t)) && shown.some((t) => /Sugar sale/.test(t)), shown.join(' | '));
  ok('...with their MWC references and status', shown.every((t) => /MWC/.test(t) && /Payment under review/.test(t)));
  ok('the section is in the admin jump menu', !!(await p.$('.admin-jump a[href="#scad-heading"]')));

  await p.fill('#scad-q', two.ref);
  await p.click('#scad-search button[type=submit]');
  await p.waitForFunction(() => document.querySelectorAll('#scad-list tbody tr').length === 1, null, { timeout: 8000 });
  shown = await rowsShown(p);
  ok('search by MWC reference finds just that campaign', shown.length === 1 && /Sugar sale/.test(shown[0]), shown.join(' | '));
  await p.fill('#scad-q', '');
  await p.click('#scad-search button[type=submit]');
  await p.waitForFunction(() => document.querySelectorAll('#scad-list tbody tr').length === 2, null, { timeout: 8000 });

  /* ---------- reject one with a reason ---------- */
  await p.click(`[data-open="${two.id}"]`);
  await p.waitForSelector(`[data-pay="${two.paymentId}"][data-verify="0"]`, { timeout: 10000 });
  ok('the payment shows the receipt screenshot link', !!(await p.$('#scad-detail a[href^="https://"][target=_blank]')));
  ok('...and the pre-screen notice: the admin checks the bank', /only a pre-screen/.test(await p.textContent('#scad-detail')));
  answers.push('No money in the bank with this reference');
  await p.click(`[data-pay="${two.paymentId}"][data-verify="0"]`);
  await waitMsg(p, 'Payment rejected');
  ok('reject: payment Rejected, campaign Payment rejected, with the reason', pay(two.paymentId).Status === 'Rejected' && camp(two.id).Status === 'PAYMENT_REJECTED'
    && /No money in the bank/.test(pay(two.paymentId).AdminNote));
  ok('...and the seller is emailed the reason', box.__mail.some((m) => m[0] === 'ana@x.com' && /not verified/.test(m[1]) && /No money in the bank/.test(m[2])));

  /* ---------- verify, then approve ---------- */
  await p.click(`[data-open="${one.id}"]`);
  await p.waitForSelector(`[data-pay="${one.paymentId}"][data-verify="1"]`, { timeout: 10000 });
  const frame = await p.$eval('#scad-preview', (f) => ({ sandbox: f.getAttribute('sandbox'), doc: f.srcdoc }));
  ok('the email preview is shown in a no-permission sandbox', frame.sandbox === '' && /New in at Ana Shop/.test(frame.doc), frame.sandbox);
  await shot(p, 'review');
  ok('approve is not offered before the payment is verified', !(await p.$('[data-act="approve"]')));
  await p.click(`[data-pay="${one.paymentId}"][data-verify="1"]`);
  await waitMsg(p, 'Payment verified');
  ok('verify: payment Verified, campaign Awaiting approval, 7 paid days in the ledger', pay(one.paymentId).Status === 'Verified' && camp(one.id).Status === 'AWAITING_APPROVAL'
    && Number(camp(one.id).PaidDays) === 7 && /PAYMENT_VERIFIED/.test(await p.textContent('#scad-detail')));
  await p.click('[data-act="approve"]');
  await waitMsg(p, 'Approved');
  ok('approve: the campaign is Active (starts today)', camp(one.id).Status === 'ACTIVE', camp(one.id).Status);

  /* ---------- pause, refund, stop ---------- */
  answers.push('Customer complaint, checking it');
  await p.click('[data-act="pause"]');
  await waitMsg(p, 'Paused');
  ok('pause with a reason', camp(one.id).Status === 'PAUSED' && /Customer complaint/.test(camp(one.id).StatusNote));
  await p.waitForSelector('#scad-refund', { timeout: 5000 });
  ok('the refund form offers only the unused days', (await p.getAttribute('#scad-refund-days', 'max')) === '7');
  await p.fill('#scad-refund-days', '2');
  await p.fill('#scad-refund-reason', 'Seller asked, paid back by ANZ');
  await p.click('#scad-refund button[type=submit]');
  await waitMsg(p, 'Refund recorded');
  const led = box.sheetToObjects(box.scLedgerSheet()).filter((l) => l.CampaignId === one.id && l.EntryType === 'REFUND');
  ok('refund: 2 days, -A$0.20 in the ledger, paid days 5', led.length === 1 && Number(led[0].Days) === -2 && Math.abs(Number(led[0].Amount) + 0.2) < 1e-9 && Number(camp(one.id).PaidDays) === 5);
  ok('...shown in Billing as -A$0.20', /-A\$0\.20/.test(await p.textContent('#scad-detail')));
  answers.push('Policy breach confirmed');
  await p.click('[data-act="stop"]');
  await waitMsg(p, 'Stopped');
  ok('stop with a reason', camp(one.id).Status === 'STOPPED');
  const hist = await p.textContent('.scad-history');
  ok('history lists every admin step with who did it', ['payment_verified', 'approved', 'admin_pause', 'refund', 'admin_stop'].every((a) => hist.includes(a)) && hist.includes('boss@mwakete.com'), hist.slice(0, 300));
  ok('no pause or stop offered once stopped', !(await p.$('[data-act="stop"]')) && !(await p.$('[data-act="pause"]')));
  await p.selectOption('#scad-filter', 'all');
  await p.waitForFunction(() => document.querySelectorAll('#scad-list tbody tr').length === 2, null, { timeout: 8000 });
  ok('"All campaigns" lists both', true);
  await ctx.close();

  /* ---------- phone ---------- */
  ({ ctx, p } = await open(390, 'tok-adm', ADMIN));
  await p.selectOption('#scad-filter', 'all');
  await p.waitForSelector('#scad-list tbody tr', { timeout: 15000 });
  await p.click(`[data-open="${one.id}"]`);
  await p.waitForSelector('#scad-preview', { timeout: 10000 });
  const wide = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  ok('phone: no sideways scrolling with a campaign open', wide <= 1, wide);
  await shot(p, 'phone');
  await ctx.close();

  /* ---------- not an admin ---------- */
  ({ ctx, p } = await open(1280, 'tok-a', { ownerId: 'own_a', storeName: 'Ana Shop', storeSlug: 'ana' }));
  await p.waitForTimeout(1500);
  ok('a seller does not get the campaign queue', !(await p.isVisible('#seller-campaigns')));
  ok('...and the server refuses them anyway', /Not authorized/.test(call(JSON.stringify({ action: 'adminListCampaigns', token: 'tok-a' }))));
  await ctx.close();

  /* ---------- seller menu link ---------- */
  ({ ctx, p } = await open(1280, 'tok-a', { ownerId: 'own_a', storeName: 'Ana Shop', storeSlug: 'ana' }));
  await p.goto(BASE + '/owner/dashboard.html', { waitUntil: 'load' });
  await p.waitForSelector('.seller-sidebar', { timeout: 10000 });
  ok('the seller menu links to My Campaigns', !!(await p.$('.seller-sidebar a[href="campaigns.html"]')));
  await p.goto(BASE + '/owner/campaigns.html', { waitUntil: 'load' });
  await p.waitForSelector('.seller-sidebar', { timeout: 10000 });
  ok('...marked as the current page there', (await p.getAttribute('.seller-sidebar a[href="campaigns.html"]', 'aria-current')) === 'page');
  await ctx.close();

  ok('no page errors', errors.length === 0, errors.join(' | '));
  await browser.close();
  R.forEach((r) => console.log(r[0] + ' - ' + r[1] + (r[0] === 'FAIL' && r[2] !== '' ? ' :: ' + r[2] : '')));
  const failed = R.filter((r) => r[0] === 'FAIL').length;
  console.log(`\n${R.length - failed}/${R.length} passed`);
  process.exit(failed ? 1 : 0);
})();
