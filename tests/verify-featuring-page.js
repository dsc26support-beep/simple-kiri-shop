// Paid featuring, browser side: owner/feature.html (choose -> total ->
// continue -> pay details -> upload outcomes -> history) and the admin
// "Featuring payments" queue. Backend rules are covered by test-featuring.js.
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = 'http://127.0.0.1:8099';
const OWNER = { ownerId: 'o1', storeName: 'Bong Store', storeSlug: 'bong', status: 'active', isAdmin: true };
const PAYMENT = { accountName: 'Mwakete', accountNumber: '906149' };
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
      else if (a === 'listMyFeaturePurchases') res = { ok: true, purchases: state.purchases, payment: PAYMENT, freeAvailable: !!state.free, freeMaxProducts: 3 };
      else if (a === 'listOwnerProducts') res = { ok: true, products: [
        { productId: 'p1', name: 'Rice', status: 'active' }, { productId: 'p2', name: 'Flour', status: 'active' },
        { productId: 'p3', name: 'Old', status: 'archived' }] };
      else if (a === 'startFeaturePurchase') res = state.start || { ok: true, purchase: AWAITING };
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
  ok('loading text is cleared once loaded', (await page.textContent('#feature-status')).trim() === '');
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
  ok('pay step shows account, number, reference and amount', JSON.stringify(box) === '["Mwakete","906149","MWFABC234","$0.70"]', JSON.stringify(box));
  const words = await page.evaluate(() => ({
    heading: document.getElementById('feature-pay-heading').textContent.replace(/\s+/g, ' ').trim(),
    intro: document.querySelector('#feature-pay-steps > p').textContent.trim(),
    labels: [...document.querySelectorAll('.feature-pay-box dt')].map((d) => d.textContent),
    shot: document.querySelector('.feature-pay-shot').textContent.trim(),
    shotAlign: getComputedStyle(document.querySelector('.feature-pay-shot')).textAlign,
    oldText: /goMoney|Not the screen with the Confirm button/.test(document.getElementById('feature-pay-steps').textContent)
  }));
  ok('heading: a ? button, no "2."', /^\? ?Show an example payment screenshot Pay and upload your receipt$/.test(words.heading) && !/2\./.test(words.heading), words.heading);
  ok('intro says Copy/Paste onto the Kiribati Banking App', words.intro === 'Copy/Paste the following onto your Kiribati Banking App', words.intro);
  ok('label reads "Reference to Recipient"', words.labels.join('|') === 'Account name|Account number|Reference to Recipient|Amount', words.labels.join('|'));
  ok('"SCREENSHOT PAYMENT RECEIPT", centred, replaces the old paragraph', words.shot === 'SCREENSHOT PAYMENT RECEIPT' && words.shotAlign === 'center' && !words.oldText, JSON.stringify(words));
  ok('example receipt starts hidden', !(await page.isVisible('#feature-example')) && await page.getAttribute('#feature-example-btn', 'aria-expanded') === 'false');
  const qb = await page.$eval('#feature-example-btn', (b) => { const r = b.getBoundingClientRect(); return { w: r.width, h: r.height, round: getComputedStyle(b).borderRadius }; });
  ok('the ? is a small circle', qb.w <= 32 && Math.abs(qb.w - qb.h) < 1 && qb.round === '50%', JSON.stringify(qb));
  await page.click('#feature-example-btn');
  const ex = await page.evaluate(() => ({
    shown: !document.getElementById('feature-example').hidden,
    expanded: document.getElementById('feature-example-btn').getAttribute('aria-expanded'),
    svg: [...document.querySelectorAll('#feature-example svg [data-example]')].map((t) => t.textContent),
    w: document.querySelector('.feature-example-img').getBoundingClientRect().width,
    steps: document.querySelectorAll('.feature-example-list li').length
  }));
  ok('tapping ? shows the example, filled with this purchase\'s details', ex.shown && ex.expanded === 'true'
    && ex.svg.join('|') === 'Mwakete|906149|$0.70|MWFABC234' && ex.steps === 4, JSON.stringify(ex));
  await page.screenshot({ path: process.env.SHOT_DIR ? process.env.SHOT_DIR + '/feature-example.png' : '/dev/null', fullPage: true }).catch(() => {});
  ok('example fits the phone screen', ex.w > 200 && ex.w <= 300 && await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), String(ex.w));
  await page.click('#feature-example-btn');
  ok('tapping ? again hides it', !(await page.isVisible('#feature-example')));
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

  // ---------- results: views while featured ----------
  st = { calls: [], purchases: [
    Object.assign({}, AWAITING, { purchaseId: 'r1', status: 'Approved', endsAt: new Date(Date.now() + 86400000).toISOString(), viewsGained: { p1: 12, p2: 3 } }),
    Object.assign({}, AWAITING, { purchaseId: 'r2', status: 'Approved', endsAt: new Date(Date.now() - 86400000).toISOString(), viewsGained: { p1: 1, p2: 0 } }),
    Object.assign({}, AWAITING, { purchaseId: 'r3', status: 'Approved', endsAt: new Date(Date.now() - 86400000).toISOString(), viewsGained: null })] };
  ({ ctx, page } = await open('/owner/feature.html', st));
  await page.waitForSelector('.feature-history-row', { timeout: 6000 });
  const res = await page.$$eval('.feature-history-row', (rows) => rows.map((r) => (r.querySelector('.feature-results') || {}).textContent || ''));
  ok('live purchase shows "+15 views so far" with a per-product split', /\+15 views so far while featured/.test(res[0]) && /Rice \+12 · Flour \+3/.test(res[0]), res[0]);
  ok('ended purchase shows "+1 view while featured" (singular)', /\+1 view while featured/.test(res[1]), res[1]);
  ok('purchase from before results existed shows no results line', res[2] === '', res[2]);
  ok('no page errors (results)', st.errors.length === 0, st.errors.join('; '));
  await ctx.close();

  // ---------- free first featuring ----------
  const FREE = Object.assign({}, AWAITING, { purchaseId: 'free1', amount: 0, status: 'Approved',
    startsAt: new Date().toISOString(), endsAt: new Date(Date.now() + 7 * 86400000).toISOString() });
  st = { calls: [], purchases: [], free: true, start: { ok: true, free: true, purchase: FREE } };
  ({ ctx, page } = await open('/owner/feature.html', st));
  await page.waitForSelector('#feature-product-list input', { timeout: 6000 });
  ok('free: the offer is announced', await page.isVisible('#feature-free-note') && /first featuring is free/.test(await page.textContent('#feature-free-note')));
  await page.check('#feature-product-list input[value="p1"]');
  await page.check('#feature-product-list input[value="p2"]');
  let ft = await page.textContent('#feature-total');
  ok('free: 2 products shows Free, button says Feature for free', /= Free/.test(ft) && (await page.textContent('#feature-continue-btn')) === 'Feature for free', ft);
  await Promise.all([page.waitForURL(/purchase=free1/), page.click('#feature-continue-btn')]);
  await ctx.close();
  st = { calls: [], purchases: [FREE], free: false };
  ({ ctx, page } = await open('/owner/feature.html?purchase=free1', st));
  await page.waitForSelector('#feature-pay-result.is-approved', { timeout: 6000 }).catch(() => {});
  ok('free: lands on "Free - featured until", no bank details, no ?, no upload',
    /^Free - featured until/.test(await page.textContent('#feature-pay-result')) && !(await page.isVisible('#feature-pay-steps'))
    && !(await page.isVisible('#feature-example-btn')) && /Featured for free/.test(await page.textContent('#feature-pay-heading')));
  ok('free: history shows Free, not $0.00', /Free · ref/.test(await page.textContent('#feature-history')) && !/\$0\.00/.test(await page.textContent('#feature-history')));
  ok('no page errors (free)', st.errors.length === 0, st.errors.join('; '));
  await ctx.close();
  // 4 products with the offer still open: normal price, plus a hint.
  st = { calls: [], purchases: [], free: true };
  ({ ctx, page } = await open('/owner/feature.html', st));
  await page.waitForSelector('#feature-product-list input', { timeout: 6000 });
  await page.evaluate(() => {
    const list = document.getElementById('feature-product-list');
    ['p4', 'p5'].forEach((id) => list.insertAdjacentHTML('beforeend', `<label class="feature-product-option"><input type="checkbox" value="${id}"><span>${id}</span></label>`));
    list.querySelectorAll('input').forEach((i) => { i.checked = true; });
    list.dispatchEvent(new Event('change', { bubbles: true }));
  });
  ft = await page.textContent('#feature-total');
  ok('free: 4 products is priced normally, with a "3 or fewer" hint', /4 products × 7 days × \$0\.05 = \$1\.40/.test(ft) && /choose 3 or fewer/.test(ft)
    && (await page.textContent('#feature-continue-btn')) === 'Continue to payment', ft);
  await ctx.close();
  st = { calls: [], purchases: [] };
  ({ ctx, page } = await open('/owner/feature.html', st));
  await page.waitForSelector('#feature-product-list input', { timeout: 6000 });
  ok('offer used: no free note', !(await page.isVisible('#feature-free-note')));
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
