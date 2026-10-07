/**
 * Marketing in the browser, against the REAL backend (gas-harness):
 * the admin Marketing section, the customer opt-in on the account page, the
 * unsubscribe page, and email-link clicks. Also: no public page loads any
 * marketing code, and nothing the browser receives carries a customer email.
 */
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const { makeBox } = require('./lib/gas-harness.js');
const BASE = 'http://127.0.0.1:8099';
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e === undefined ? '' : e]);
const DAY = 86400000;
const ago = (d) => new Date(Date.now() - d * DAY).toISOString();

const box = makeBox({
  Owners: [['OwnerId', 'StoreSlug', 'StoreName', 'Status', 'Email', 'Island', 'Village'],
    ['own_a', 'ana', 'Ana Shop', 'active', 'ana@x.com', 'South Tarawa', 'Bairiki'],
    ['own_adm', 'admin', 'ADMIN', 'active', 'boss@mwakete.com', '', '']],
  Products: [['ProductId', 'OwnerId', 'StoreSlug', 'Name', 'Status', 'Category', 'ListingType', 'ImageUrl', 'Views', 'CreatedAt'],
    ['p1', 'own_a', 'ana', 'Rice 25kg', 'active', 'food', 'product', '', 50, ago(2)],
    ['p2', 'own_a', 'ana', 'Sugar 2kg', 'active', 'food', 'product', '', 30, ago(2)],
    ['p3', 'own_a', 'ana', 'Flour 1kg', 'active', 'food', 'product', '', 20, ago(1)]],
  Variants: [['VariantId', 'ProductId', 'OwnerId', 'Label', 'Price', 'Status', 'StockQty'],
    ['v1', 'p1', 'own_a', 'One', 30, 'active', 5], ['v2', 'p2', 'own_a', 'One', 3, 'active', 5], ['v3', 'p3', 'own_a', 'One', 2, 'active', 5]],
  Customers: [['CustomerId', 'Name', 'Email', 'Phone', 'EmailVerified', 'CreatedAt', 'UpdatedAt'],
    ['c1', 'Tera Kum', 'tera@x.com', '7301', 'true', ago(100), ago(100)]],
  CustomerSessions: [['Token', 'CustomerId', 'CreatedAt', 'ExpiresAt'], ['tok_c1', 'c1', ago(1), new Date(Date.now() + DAY).toISOString()]],
  Orders: [['OrderId', 'OwnerId', 'StoreSlug', 'CustomerName', 'CustomerEmail', 'ItemsJson', 'Status', 'CreatedAt', 'Total'],
    ['o1', 'own_a', 'ana', 'Tera', 'tera@x.com', JSON.stringify([{ productId: 'p1', variantId: 'v1', qty: 1 }]), 'Fulfilled', ago(5), 30]],
  Bookings: [['BookingId', 'OwnerId', 'StoreSlug', 'ProductId', 'CustomerEmail', 'Status', 'CreatedAt']],
  Reviews: [['ReviewId', 'ProductId', 'OwnerId', 'StoreSlug', 'CustomerId', 'Status', 'CreatedAt', 'Rating', 'Comment', 'CustomerName', 'VerifiedPurchase', 'UpdatedAt']],
  AbandonedCarts: [['Id', 'StoreSlug', 'OwnerId', 'Email', 'CartJson', 'CreatedAt', 'Reminded', 'ConvertedOrderId']],
  SellerBadges: [['OwnerId', 'Badges', 'Score', 'MetricsJson', 'ReasonJson', 'UpdatedAt']],
  Campaigns: [['CampaignId', 'Name', 'Type', 'Status', 'Objective', 'AudienceType', 'AudienceFilterJson', 'ProductIdsJson', 'StoreSlugsJson', 'Subject', 'PreviewText', 'BodyHtml', 'BodyText', 'CTAUrl', 'CTAType', 'StartAt', 'EndAt', 'CreatedAt', 'UpdatedAt', 'CreatedBy', 'MaxRecipients', 'SentCount', 'FailedCount', 'LastRunAt', 'SourceKey']],
  CampaignEvents: [['EventId', 'CampaignId', 'CustomerId', 'Email', 'EventType', 'Status', 'CreatedAt', 'SentAt', 'FailureReason', 'MetadataJson', 'Attempts']],
  MarketingPreferences: [['CustomerId', 'Email', 'PromotionalEmailOptIn', 'FrequencyLimit', 'LastPromotionalEmailAt', 'UpdatedAt', 'OptInAt', 'UnsubscribeToken']]
});
box.__props.ADMIN_EMAILS = 'boss@mwakete.com';
box.__props.SITE_BASE_URL = 'https://mwakete.com';
box.MailApp.getRemainingDailyQuota = () => 100;
const ADMIN = { OwnerId: 'own_adm', Email: 'boss@mwakete.com', StoreSlug: 'admin' };
const rows = (tab) => box.sheetToObjects(box.getSheet(tab));

const ADMIN_ACTIONS = {
  getMarketingOverview: (b) => box.actionGetMarketingOverview(ADMIN),
  getMarketingStats: (b) => box.actionGetMarketingStats(ADMIN),
  createMarketingCampaign: (b) => box.actionCreateMarketingCampaign(ADMIN, b),
  setMarketingCampaignStatus: (b) => box.actionSetMarketingCampaignStatus(ADMIN, b),
  setMarketingPaused: (b) => box.actionSetMarketingPaused(ADMIN, b),
  previewMarketingCampaign: (b) => box.actionPreviewMarketingCampaign(ADMIN, b),
  runMarketingGeneration: (b) => box.actionRunMarketingGeneration(ADMIN)
};
const responses = [];

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const calls = [];
  await ctx.route('**/macros/s/**', (route) => {
    let body = {}; try { body = route.request().postDataJSON() || {}; } catch (e) {}
    const u = new URL(route.request().url());
    const a = body.action || u.searchParams.get('action');
    calls.push(a);
    let res = { ok: true };
    if (a === 'getOwnerProfile') res = { ok: true, owner: { ownerId: 'own_adm', storeName: 'ADMIN', storeSlug: 'admin', isAdmin: true } };
    else if (ADMIN_ACTIONS[a]) res = ADMIN_ACTIONS[a](body);
    else if (a === 'listStores') res = box.actionListStores({});
    else if (a === 'listProducts') res = box.actionListProducts({ storeSlug: u.searchParams.get('storeSlug') });
    else if (a === 'getCustomerProfile') res = box.actionGetCustomerProfile(body);
    else if (a === 'getMarketingPreference') res = box.actionGetMarketingPreference(body);
    else if (a === 'setMarketingPreference') res = box.actionSetMarketingPreference(body);
    else if (a === 'unsubscribeMarketing') res = box.actionUnsubscribeMarketing(body);
    else if (a === 'recordMarketingClick') res = box.actionRecordMarketingClick(body);
    else if (a === 'listCustomerOrders' || a === 'listCustomerBookings') res = { ok: true, orders: [], bookings: [] };
    else if (/^list|^get/.test(a || '')) res = { ok: true, items: [], featured: [], stores: [], products: [], purchases: [], wholesalers: [], badges: [], rows: [] };
    const json = JSON.stringify(res);
    // getCustomerProfile is the signed-in customer reading their OWN account.
    if (a !== 'getCustomerProfile') responses.push(json);
    route.fulfill({ status: 200, contentType: 'application/json', body: json });
  });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  page.on('dialog', (d) => d.accept());

  /* ---------- customer opts in on their account page ---------- */
  await page.addInitScript(() => {
    try {
      localStorage.setItem('skiri_cookie_consent', 'true');
      localStorage.setItem('skiri_customer_token', 'tok_c1');
      localStorage.setItem('skiri_owner_token', 'tok_owner');
    } catch (e) {}
  });
  await page.goto(BASE + '/customer-dashboard.html', { waitUntil: 'load' });
  await page.waitForSelector('#marketing-optin:not([hidden])', { timeout: 6000 });
  ok('account page: promotional emails start unticked (no consent yet)', !(await page.isChecked('#marketing-optin-box')));
  await page.click('#marketing-optin-box');
  await page.waitForTimeout(400);
  ok('ticking it saves consent for THIS customer', rows('MarketingPreferences').find((p) => p.CustomerId === 'c1').PromotionalEmailOptIn === 'true');
  ok('...and says so', /Done/.test(await page.textContent('#marketing-optin-status')));

  /* ---------- admin: overview, generate, preview, approve ---------- */
  await page.goto(BASE + '/owner/admin.html', { waitUntil: 'load' });
  await page.waitForSelector('#mkt-totals .admin-stat', { timeout: 6000 });
  ok('admin: status explains the engine is off', /Off\./.test(await page.textContent('#mkt-status')));
  ok('admin: opted-in count shown', /1Customers opted in/.test(await page.textContent('#mkt-totals')));
  await page.click('#mkt-generate-btn');
  await page.waitForTimeout(500);
  ok('admin: "Check for opportunities" adds drafts for approval', /new campaign\(s\) added/.test(await page.textContent('#mkt-msg')), await page.textContent('#mkt-msg'));
  const firstRow = await page.$('#mkt-campaigns tbody tr');
  ok('admin: campaigns listed as DRAFT', /DRAFT/.test(await firstRow.textContent()));
  await page.click('#mkt-campaigns [data-mkt-preview]');
  await page.waitForSelector('#mkt-preview:not([hidden]) .mkt-sample', { timeout: 6000 });
  const pv = await page.textContent('#mkt-preview');
  ok('preview: audience size and why they qualify', /would get it now/.test(pv) && /Why they qualify/.test(pv));
  ok('preview: shows the email text, no address', /Hi Tera/.test(pv) && !/tera@x\.com/.test(pv));
  await page.click('#mkt-campaigns [data-mkt-op="approve"]');
  await page.waitForTimeout(400);
  ok('approve moves it to SCHEDULED', /scheduled/.test(await page.textContent('#mkt-msg')));

  // create a seller promotion through the form
  await page.click('.mkt-create summary');
  await page.fill('#mkt-name', 'Ana week');
  await page.selectOption('#mkt-store', 'ana');
  await page.waitForSelector('#mkt-products input');
  await page.check('#mkt-products input[value="p2"]');
  await page.fill('#mkt-subject', 'Hello {{customerName}}');
  await page.fill('#mkt-message', 'New at <b>{{storeName}}</b>');
  await page.click('#mkt-form button[type="submit"]');
  await page.waitForTimeout(300);
  ok('the form refuses HTML in a message', /Plain text only/.test(await page.textContent('#mkt-form-error')));
  await page.fill('#mkt-message', 'New stock at {{storeName}}.');
  await page.click('#mkt-form button[type="submit"]');
  await page.waitForTimeout(400);
  ok('a valid campaign saves as a draft', /Saved as a draft/.test(await page.textContent('#mkt-msg'))
    && rows('Campaigns').some((c) => c.Name === 'Ana week' && c.Status === 'DRAFT' && c.ProductIdsJson === '["p2"]'));
  ok('admin page: no sideways scroll at 390px', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));

  /* ---------- a real send, the click, the unsubscribe ---------- */
  Object.assign(box.__props, { MARKETING_ENABLED: 'true', MARKETING_DRY_RUN: 'false' });
  box.runMarketingSweep();
  const ev = rows('CampaignEvents').find((e) => e.EventType === 'DELIVERY' && e.Status === 'SENT');
  ok('the approved campaign was sent once to the opted-in customer', !!ev && box.__mail.filter((m) => m[0] === 'tera@x.com').length === 1);
  await page.goto(`${BASE}/product.html?store=ana&product=p2&mc=${ev.CampaignId}&me=${ev.EventId}`, { waitUntil: 'load' });
  await page.waitForTimeout(2500);
  ok('opening the email link records one click', rows('CampaignEvents').filter((e) => e.EventType === 'CLICK').length === 1, calls.filter((c) => /Marketing/.test(c)).join(','));
  await page.goto(`${BASE}/product.html?store=ana&product=p2&mc=${ev.CampaignId}&me=${ev.EventId}`, { waitUntil: 'load' });
  await page.waitForTimeout(1500);
  ok('opening it again does not count twice', rows('CampaignEvents').filter((e) => e.EventType === 'CLICK').length === 1);

  const token = rows('MarketingPreferences').find((p) => p.CustomerId === 'c1').UnsubscribeToken;
  await page.goto(BASE + '/unsubscribe.html?t=' + token, { waitUntil: 'load' });
  ok('unsubscribe page does nothing until the button is pressed (link scanners)', rows('MarketingPreferences').find((p) => p.CustomerId === 'c1').PromotionalEmailOptIn === 'true');
  await page.click('#unsub-btn');
  await page.waitForSelector('#unsub-done:not([hidden])');
  ok('one tap stops promotional emails', rows('MarketingPreferences').find((p) => p.CustomerId === 'c1').PromotionalEmailOptIn === 'false');

  /* ---------- privacy + performance guarantees ---------- */
  ok('no response to the browser carried a customer email', responses.every((r) => r.indexOf('tera@x.com') === -1));
  const fs = require('fs');
  const publicPages = ['index.html', 'product.html', 'store.html', 'stores.html', 'categories.html', 'checkout.html', 'cart.html', 'help.html', 'recent.html'];
  ok('no public page loads marketing code', publicPages.every((p) => !/admin-marketing|Marketing\.gs/.test(fs.readFileSync(__dirname + '/../' + p, 'utf8'))));
  ok('no JS errors', errs.length === 0, errs.join(' | '));

  await browser.close();
  let f = 0;
  console.log('\n--- Marketing (browser) ---');
  for (const [s, n, e] of R) { if (s === 'FAIL') f++; console.log(`${s}  ${n}${e !== '' ? '  [' + e + ']' : ''}`); }
  console.log(`\n${R.length - f}/${R.length} passed`);
  process.exit(f ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
