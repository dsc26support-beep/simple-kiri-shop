// Paid featuring, browser side: owner/feature.html (choose -> total ->
// continue -> pay details -> upload outcomes -> history) and the admin
// "Featuring payments" queue. Backend rules are covered by test-featuring.js.
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = 'http://127.0.0.1:8099';
const OWNER = { ownerId: 'o1', storeName: 'Bong Store', storeSlug: 'bong', status: 'active', isAdmin: true };
const PAYMENT = { accountName: 'Nei Recharge', accountNumber: '786149' };
const AWAITING = { purchaseId: 'fp1', productIds: ['p1', 'p2'], productNames: ['Rice', 'Flour'], days: 7, amount: 0.7,
  reference: 'MWFABC234', status: 'Awaiting payment', startsAt: '', endsAt: '' };
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e || '']);

  async function open(path, state) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await ctx.route('**/macros/s/**', (route) => {
      let body = {}; try { body = route.request().postDataJSON() || {}; } catch (e) {}
      const a = body.action || new URL(route.request().url()).searchParams.get('action');
      state.calls.push(body);
      let res = { ok: true };
      if (a === 'getOwnerProfile') res = { ok: true, owner: OWNER };
      else if (a === 'listMyFeaturePurchases') res = { ok: true, purchases: state.purchases, payment: PAYMENT };
      else if (a === 'listOwnerProducts') res = { ok: true, products: [
        { productId: 'p1', name: 'Rice', status: 'active' }, { productId: 'p2', name: 'Flour', status: 'active' },
        { productId: 'p3', name: 'Old', status: 'archived' }] };
      else if (a === 'startFeaturePurchase') res = { ok: true, purchase: AWAITING };
      else if (a === 'submitFeaturePayment') res = state.submit;
      else if (a === 'listFeaturePurchases') res = { ok: true, purchases: state.admin };
      else if (a === 'setFeaturePurchaseStatus') res = { ok: true };
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(res) });
    });
    const page = await ctx.newPage();
    await page.addInitScript(() => { try { localStorage.setItem('skiri_owner_token', 'tok'); } catch (e) {} });
    state.errors = []; page.on('pageerror', (e) => state.errors.push(String(e)));
    page.on('dialog', (d) => d.accept());
    await page.goto(BASE + path, { waitUntil: 'load' });
    return { ctx, page };
  }

  // ---------- step 1 ----------
  let st = { calls: [], purchases: [] };
  let { ctx, page } = await open('/owner/feature.html', st);
  await page.waitForSelector('#feature-product-list input', { timeout: 6000 });
  ok('only active products are offered', (await page.$$('#feature-product-list input')).length === 2);
  ok('history says nothing featured yet', /Nothing featured yet/.test(await page.textContent('#feature-history')));
  await page.check('#feature-product-list input[value="p1"]');
  await page.check('#feature-product-list input[value="p2"]');
  await page.fill('#feature-days', '7');
  const total = await page.textContent('#feature-total');
  ok('total previews 2 x 7 x 5c = $0.70', /2 products × 7 days × \$0\.05 = \$0\.70/.test(total), total);
  await page.fill('#feature-days', '0');
  await page.click('#feature-continue-btn');
  ok('0 days is refused before any server call', /between 1 and 60/.test(await page.textContent('#feature-select-error'))
    && !st.calls.some((c) => c.action === 'startFeaturePurchase'));
  await page.fill('#feature-days', '7');
  await Promise.all([page.waitForURL(/purchase=fp1/), page.click('#feature-continue-btn')]);
  const start = st.calls.find((c) => c.action === 'startFeaturePurchase');
  ok('continue sends the chosen products and days', start && JSON.stringify(start.productIds) === '["p1","p2"]' && start.days === 7, JSON.stringify(start));
  await ctx.close();

  // ---------- step 2: pay details + rejected upload, then approved ----------
  st = { calls: [], purchases: [AWAITING], submit: { ok: true, purchase: Object.assign({}, AWAITING, { status: 'Rejected' }),
    message: 'We could not find the reference MWFABC234 on that screenshot.' } };
  ({ ctx, page } = await open('/owner/feature.html?purchase=fp1', st));
  await page.waitForSelector('#feature-pay:not(.hidden)', { timeout: 6000 });
  const box = await page.evaluate(() => ['pay-account-name', 'pay-account-number', 'pay-reference', 'pay-amount'].map((id) => document.getElementById(id).textContent));
  ok('pay step shows account, number, reference and amount', JSON.stringify(box) === '["Nei Recharge","786149","MWFABC234","$0.70"]', JSON.stringify(box));
  ok('the choose step stays hidden on the pay step', await page.$eval('#feature-select', (e) => e.classList.contains('hidden')));
  await page.click('#feature-upload-btn');
  ok('upload without a file asks for one', /Choose the screenshot/.test(await page.textContent('#feature-pay-error')));
  await page.setInputFiles('#feature-screenshot', { name: 'r.png', mimeType: 'image/png', buffer: PNG });
  await page.click('#feature-upload-btn');
  await page.waitForFunction(() => /reference MWFABC234/.test(document.getElementById('feature-pay-error').textContent), null, { timeout: 4000 }).catch(() => {});
  ok('a rejected screenshot shows the reason and keeps the upload open',
    /reference MWFABC234/.test(await page.textContent('#feature-pay-error')) && await page.isVisible('#feature-upload-btn'));
  const sub = st.calls.find((c) => c.action === 'submitFeaturePayment');
  ok('upload sends purchaseId, mime type and the base64 image', sub && sub.purchaseId === 'fp1' && sub.mimeType === 'image/png' && sub.imageBase64 === PNG.toString('base64'));
  const ends = new Date(Date.now() + 7 * 86400000).toISOString();
  st.submit = { ok: true, purchase: Object.assign({}, AWAITING, { status: 'Approved', endsAt: ends }), message: 'Payment confirmed - your products are featured.' };
  await page.click('#feature-upload-btn');
  await page.waitForSelector('#feature-pay-result.is-approved', { timeout: 4000 }).catch(() => {});
  ok('an approved payment shows success and hides the upload', await page.isVisible('#feature-pay-result.is-approved') && !(await page.isVisible('#feature-upload-btn')));
  ok('history updates to "Featured until"', /Featured until/.test(await page.textContent('#feature-history')));
  ok('no page errors (owner page)', st.errors.length === 0, st.errors.join('; '));
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  ok('no horizontal scroll at 390px', !overflow);
  await ctx.close();

  // ---------- pending purchase revisited ----------
  st = { calls: [], purchases: [Object.assign({}, AWAITING, { status: 'Pending review' })] };
  ({ ctx, page } = await open('/owner/feature.html?purchase=fp1', st));
  await page.waitForSelector('#feature-pay-result.is-pending', { timeout: 6000 }).catch(() => {});
  ok('a pending purchase shows the waiting note, no upload', await page.isVisible('#feature-pay-result.is-pending') && !(await page.isVisible('#feature-upload-btn')));
  ok('no "Pay now" on a pending purchase', !(await page.$('#feature-history a.btn')));
  await ctx.close();

  // ---------- renew link from the "ends tomorrow" email ----------
  st = { calls: [], purchases: [Object.assign({}, AWAITING, { purchaseId: 'old1', status: 'Approved', days: 5, productIds: ['p1', 'p3'],
    endsAt: new Date(Date.now() + 20 * 3600 * 1000).toISOString() })] };
  ({ ctx, page } = await open('/owner/feature.html?renew=old1', st));
  await page.waitForSelector('#feature-product-list input', { timeout: 6000 });
  const renew = await page.evaluate(() => ({
    checked: [...document.querySelectorAll('#feature-product-list input:checked')].map((i) => i.value),
    days: document.getElementById('feature-days').value,
    total: document.getElementById('feature-total').textContent,
    note: document.getElementById('feature-status').textContent
  }));
  ok('?renew= ticks the same products (only the still-active ones)', JSON.stringify(renew.checked) === '["p1"]', JSON.stringify(renew));
  ok('?renew= sets the same number of days, and the total follows', renew.days === '5' && /1 product × 5 days/.test(renew.total), JSON.stringify(renew));
  ok('?renew= says it is a renewal and why a product is missing', /no longer active/.test(renew.note), renew.note);
  ok('no page errors (renew)', st.errors.length === 0, st.errors.join('; '));
  await ctx.close();

  // ---------- admin queue ----------
  st = { calls: [], admin: [
    Object.assign({}, AWAITING, { status: 'Pending review', storeName: 'Bong Store', screenshotUrl: 'https://drive.google.com/x', ocrNotes: 'ocr:unavailable' }),
    Object.assign({}, AWAITING, { purchaseId: 'fp2', status: 'Approved', storeName: 'Two', endsAt: ends })] };
  ({ ctx, page } = await open('/owner/admin.html', st));
  await page.waitForSelector('.feature-payment-row', { timeout: 6000 }).catch(() => {});
  const rows = await page.$$('.feature-payment-row');
  ok('admin lists featuring payments', rows.length === 2);
  ok('pending row has screenshot link and notes', await page.isVisible('.feature-payment-row a[href="https://drive.google.com/x"]') && /ocr:unavailable/.test(await rows[0].textContent()));
  ok('approved row offers Reject only', !(await rows[1].$('[data-approve="true"]')) && !!(await rows[1].$('[data-approve="false"]')));
  await page.click('.feature-payment-row [data-purchase-id="fp1"][data-approve="true"]');
  await page.waitForTimeout(500);
  const set = st.calls.find((c) => c.action === 'setFeaturePurchaseStatus');
  ok('Approve calls setFeaturePurchaseStatus', set && set.purchaseId === 'fp1' && set.approve === true, JSON.stringify(set));
  ok('no page errors (admin)', st.errors.length === 0, st.errors.join('; '));
  await ctx.close();

  await browser.close();
  let f = 0; console.log('\n--- paid featuring: seller page + admin queue ---');
  for (const [s, n, e] of R) { if (s === 'FAIL') f++; console.log(`${s}  ${n}${e ? '  [' + e + ']' : ''}`); }
  console.log(`\n${R.length - f}/${R.length} passed`);
  process.exit(f ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
