/**
 * Seller Campaign Studio in the browser, on the REAL backend (gas-harness
 * behind every API call): empty state, the six-step builder with its live
 * description and price, the block editor, the server preview, payment with
 * receipt upload (pending - not active), and the campaign page after an admin
 * verifies and approves. Phone and desktop widths.
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
  Sessions: [['Token', 'OwnerId', 'CreatedAt', 'ExpiresAt'], ['tok-a', 'own_a', '', FUT]],
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

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const errors = [];
  const open = async (w) => {
    const ctx = await browser.newContext({ viewport: { width: w, height: 900 }, serviceWorkers: 'block' });
    await ctx.addInitScript(() => {
      localStorage.setItem('skiri_cookie_consent', 'true');
      localStorage.setItem('skiri_owner_token', 'tok-a');
      localStorage.setItem('skiri_owner_profile', JSON.stringify({ ownerId: 'own_a', storeName: 'Ana Shop', storeSlug: 'ana' }));
    });
    await ctx.route('**/macros/s/**', (route) => {
      const b = route.request().postData();
      route.fulfill({ status: 200, contentType: 'application/json', body: b ? call(b) : '{"ok":true}' });
    });
    const p = await ctx.newPage();
    // Playwright injects its init script (and its service-worker block) into
    // every frame, including the preview's sandboxed one, where the browser
    // rightly refuses them. That is the test tooling, not the page.
    p.on('pageerror', (e) => { if (!/sandboxed and lacks the 'allow-same-origin' flag/.test(String(e))) errors.push(String(e)); });
    p.on('dialog', (d) => d.accept());
    return { ctx, p };
  };
  const shot = async (p, name) => { if (SHOTS) await p.screenshot({ path: SHOTS + '/cs-' + name + '.png', fullPage: true }); };

  /* ---------- empty state ---------- */
  let { ctx, p } = await open(1280);
  await p.goto(BASE + '/owner/campaigns.html', { waitUntil: 'load' });
  await p.waitForSelector('#cs-overview:not([hidden]) .cs-empty', { timeout: 10000 }).catch(() => {});
  ok('a seller with no campaigns sees a clear empty state', /No campaigns yet/.test(await p.textContent('#cs-list').catch(() => '')));
  ok('...with the price per day', /A\$0\.10 per active day/.test(await p.textContent('#cs-overview')));
  await shot(p, 'empty');

  /* ---------- builder ---------- */
  await p.click('.cs-empty .btn-primary');
  await p.waitForSelector('#cs-builder:not([hidden])');
  ok('step 1 offers the goals, with the unsupported ones marked coming soon',
    await p.locator('input[name="cs-goal"]').count() === 12 && await p.locator('.cs-card-opt.is-soon input:disabled').count() === 2);
  await p.click('#cs-next-btn');
  ok('Continue without a goal explains what is missing', /Choose what you want/.test(await p.textContent('#cs-step-error')));
  await p.check('input[name="cs-goal"][value="products"]');
  ok('choosing a goal fills a name and the summary updates at once', (await p.inputValue('#cs-name')) === 'Promote selected products'
    && /promotes your store/.test(await p.textContent('#cs-description')));
  await p.fill('#cs-name', 'Rice week');
  await p.click('#cs-next-btn');
  await p.waitForSelector('.cs-step[data-step="products"]:not([hidden])');
  ok('Continue saves the draft on the server', box.sheetToObjects(box.scCampaignsSheet()).some((c) => c.Name === 'Rice week' && c.Status === 'DRAFT'));
  await p.click('#cs-next-btn');
  ok('a goal that needs products says so', /at least one product/.test(await p.textContent('#cs-step-error')));
  await p.fill('#cs-product-search', 'rice');
  ok('search filters the seller\'s own products', await p.locator('.cs-product').count() === 1);
  await p.fill('#cs-product-search', '');
  await p.check('.cs-product input[value="p1"]');
  await p.check('.cs-product input[value="p2"]');
  ok('the count and the description follow the selection', /2 of 4 chosen/.test(await p.textContent('#cs-product-count')) && /promotes 2 selected products/.test(await p.textContent('#cs-description')));
  await shot(p, 'products');
  await p.click('#cs-next-btn');
  await p.waitForSelector('.cs-step[data-step="audience"]:not([hidden])');
  await p.check('input[name="cs-audience"][value="STORE_CUSTOMERS"]');
  await p.click('#cs-reach-btn');
  await p.waitForFunction(() => /customer/.test(document.getElementById('cs-reach').textContent), null, { timeout: 8000 }).catch(() => {});
  ok('reach is a count, never names', /About 1 customer/.test(await p.textContent('#cs-reach')) && !/tera@/.test(await p.textContent('#cs-reach')), await p.textContent('#cs-reach'));
  ok('...and the audience shows in the description', /your previous customers/.test(await p.textContent('#cs-description')));
  await p.click('#cs-next-btn');

  /* ---------- the editor ---------- */
  await p.waitForSelector('.cs-step[data-step="design"]:not([hidden])');
  ok('the goal\'s template is in the email already', await p.locator('#cs-email .cs-blk').count() >= 4 && await p.locator('.cs-template.is-on').count() === 1);
  ok('...three panels: blocks, the email, properties', await p.isVisible('.cs-palette') && await p.isVisible('#cs-email') && await p.isVisible('.cs-props'));
  ok('...with the store name filled in', /New in at Ana Shop/.test(await p.textContent('#cs-email')));
  await p.click('#cs-email .cs-blk[data-i="0"]');
  await p.fill('#cs-p-text', 'Rice is back at {{storeName}}');
  ok('editing a block updates the email immediately', /Rice is back at Ana Shop/.test(await p.textContent('#cs-email')));
  const before = await p.locator('#cs-email .cs-blk').count();
  await p.click('[data-add="divider"]');
  ok('a block can be added', await p.locator('#cs-email .cs-blk').count() === before + 1);
  await p.click('#cs-email .cs-blk.is-sel [data-act="del"]');
  ok('...and deleted', await p.locator('#cs-email .cs-blk').count() === before);
  await p.click('#cs-email .cs-blk[data-i="1"]');
  await p.click('#cs-email .cs-blk.is-sel [data-act="up"]');
  ok('blocks can be reordered with the keyboard-friendly arrows', /Hi Tera/.test(await p.textContent('#cs-email .cs-blk[data-i="0"]')));
  await p.click('#cs-email .cs-blk.is-sel [data-act="down"]');
  await p.click('[data-swatch="accent"][data-value="#ce1126"]');
  ok('an accent colour from the palette applies to the email', await p.evaluate(() => getComputedStyle(document.querySelector('#cs-email .cs-ebtn')).backgroundColor) === 'rgb(206, 17, 38)');
  await p.click('[data-device="mobile"]');
  ok('the mobile view narrows the canvas', await p.evaluate(() => document.getElementById('cs-canvas').getBoundingClientRect().width) <= 380);
  await p.click('[data-device="desktop"]');
  ok('the subject line sits at the top of the email, like an inbox', await p.isVisible('#cs-subject'));
  await shot(p, 'editor');
  await p.click('#cs-preview-btn');
  await p.waitForSelector('#cs-preview-dialog[open]', { timeout: 8000 }).catch(() => {});
  const srcdoc = await p.getAttribute('#cs-preview-frame', 'srcdoc');
  ok('Preview shows the email exactly as the server builds it', /Rice is back at Ana Shop/.test(srcdoc || '') && /Sent by Mwakete for Ana Shop/.test(srcdoc || ''));
  ok('...in a sandboxed frame', (await p.getAttribute('#cs-preview-frame', 'sandbox')) === '');
  await shot(p, 'preview');
  await p.click('#cs-preview-close');
  await p.click('#cs-next-btn');

  /* ---------- schedule and review ---------- */
  await p.waitForSelector('.cs-step[data-step="schedule"]:not([hidden])');
  ok('the schedule shows the price calculation (7 x A$0.10 = A$0.70)', /7 active days × A\$0\.10 = A\$0\.70/.test(await p.textContent('#cs-price-calc')));
  await p.fill('#cs-days', '10');
  ok('changing days updates the price and the summary at once', /A\$1\.00/.test(await p.textContent('#cs-price-calc')) && (await p.textContent('#cs-sum-total')) === 'A$1.00'
    && /10 active days/.test(await p.textContent('#cs-description')));
  await p.click('#cs-next-btn');
  await p.waitForSelector('.cs-step[data-step="review"]:not([hidden])');
  ok('the review lists everything, with the refund policy', /Rice 25kg, Sugar 2kg/.test(await p.textContent('#cs-review')) && /Unused paid days can be refunded on request/.test(await p.textContent('#cs-refund-policy')));
  ok('the description never says it is running', !/running now/.test(await p.textContent('#cs-description')));
  ok('the button leads to payment', (await p.textContent('#cs-next-btn')).trim() === 'Continue to payment');
  await shot(p, 'review');
  await p.click('#cs-next-btn');

  /* ---------- payment ---------- */
  await p.waitForSelector('#cs-pay:not([hidden])');
  await p.waitForFunction(() => /MWC/.test(document.getElementById('cs-pay-ref').textContent), null, { timeout: 8000 }).catch(() => {});
  ok('payment opens with the thank-you message', /Thank You for supporting this project!/.test(await p.textContent('#cs-thanks')));
  ok('...the exact amount, an MWC reference and the bank details', (await p.textContent('#cs-pay-amount')) === 'A$1.00 AUD' && /^MWC[A-Z0-9]{6}$/.test(await p.textContent('#cs-pay-ref'))
    && (await p.textContent('#cs-pay-number')) === box.FEATURE_PAY_ACCOUNT_NUMBER);
  await shot(p, 'pay');
  await p.setInputFiles('#cs-receipt', { name: 'receipt.png', mimeType: 'image/png', buffer: png() });
  await p.click('#cs-upload-btn');
  await p.waitForSelector('#cs-pay-done:not([hidden])', { timeout: 8000 }).catch(() => {});
  const c = box.sheetToObjects(box.scCampaignsSheet()).find((x) => x.Name === 'Rice week');
  ok('after upload: submitted and awaiting verification, with thanks', /Thank You for supporting this project!/.test(await p.textContent('#cs-pay-done')) && /verified/.test(await p.textContent('#cs-pay-done')));
  ok('...and the campaign is NOT active', c.Status === 'PAYMENT_REVIEW' && Number(c.PaidDays) === 0);
  await ctx.close();

  /* ---------- after Mwakete verifies and approves ---------- */
  const pay = box.sheetToObjects(box.scPaymentsSheet()).find((x) => x.CampaignId === c.CampaignId);
  box.actionAdminDecideCampaignPayment(ADM, { paymentId: pay.PaymentId, verify: true, confirm: true });
  box.actionAdminReviewCampaign(ADM, { campaignId: c.CampaignId, approve: true });
  box.runSellerCampaignSweep(box.marketingConfig(), Date.now());
  for (const w of [1280, 390]) {
    ({ ctx, p } = await open(w));
    await p.goto(BASE + '/owner/campaigns.html?id=' + encodeURIComponent(c.CampaignId), { waitUntil: 'load' });
    await p.waitForSelector('#cs-detail:not([hidden]) .cs-metric', { timeout: 10000 }).catch(() => {});
    ok(`${w}px: the campaign page shows Active and the verified thank-you`, (await p.textContent('#cs-detail-status')) === 'Active'
      && /Thank You for supporting this project! Your payment has been verified\. Your campaign is ready to go\./.test(await p.textContent('#cs-detail-thanks')));
    ok(`${w}px: metrics are only what is measured`, /Emails sent/.test(await p.textContent('#cs-metrics')) && /Not measured: Opens/.test(await p.textContent('#cs-metrics-note')));
    ok(`${w}px: payments and the day charge are listed`, /Verified/.test(await p.textContent('#cs-payments')) && /Active day/.test(await p.textContent('#cs-ledger')));
    ok(`${w}px: no sideways scroll`, await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    if (w === 1280) await shot(p, 'detail');
    if (w === 390) {
      await shot(p, 'detail-phone');
      await p.click('[data-op="pause"]');
      await p.waitForFunction(() => document.getElementById('cs-detail-status').textContent === 'Paused', null, { timeout: 8000 }).catch(() => {});
      ok('Pause works from the campaign page', (await p.textContent('#cs-detail-status')) === 'Paused');
      ok('...and Resume is offered', await p.isVisible('[data-op="resume"]'));
    }
    await ctx.close();
  }

  /* ---------- overview with campaigns ---------- */
  ({ ctx, p } = await open(390));
  await p.goto(BASE + '/owner/campaigns.html', { waitUntil: 'load' });
  await p.waitForSelector('.cs-card', { timeout: 10000 }).catch(() => {});
  ok('the overview lists the campaign with its status and days', /Rice week/.test(await p.textContent('#cs-list')) && /Paused/.test(await p.textContent('#cs-list')) && /1 of 10 paid days used/.test(await p.textContent('#cs-list')));
  await p.click('[data-filter="ACTIVE"]');
  ok('status filters work', /No campaigns with that status/.test(await p.textContent('#cs-list')));
  ok('phone: no sideways scroll', await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await shot(p, 'overview-phone');
  await ctx.close();

  ok('no page errors', errors.length === 0, errors.join(' | ').slice(0, 300));
  await browser.close();
  let fails = 0;
  console.log('\n--- campaign studio (browser, real backend) ---');
  for (const [s, n, x] of R) { if (s === 'FAIL') fails++; console.log(`${s}  ${n}${x !== '' ? '  [' + x + ']' : ''}`); }
  console.log(`\n${R.length - fails}/${R.length} passed`);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
