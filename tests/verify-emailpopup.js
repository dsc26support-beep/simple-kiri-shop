const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = 'http://127.0.0.1:8099';

async function run(emailedSeller) {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 800 } });
  await ctx.route('**/macros/s/**', (route) => {
    let action = '', post = {};
    try { post = route.request().postDataJSON() || {}; action = post.action; } catch (e) {}
    try { if (!action) action = new URL(route.request().url()).searchParams.get('action') || ''; } catch (e) {}
    let body = { ok: true };
    if (action === 'getStorePublicInfo') body = { ok: true, store: { storeName: 'Bong', phone: '+68673007552', email: 's@x.com', island: 'South Tarawa', deliveryPickPay: true } };
    if (action === 'createOrder') body = { ok: true, orderId: 'SKS-bong-1', total: 6, deliveryMethod: 'pickPay', deliveryCost: 0, items: [{ label: 'Rice — 1kg', unitPrice: 6, qty: 1 }], emailedSeller };
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    try {
      localStorage.setItem('skiri_active_store', 'bong');
      localStorage.setItem('skiri_cart_bong', JSON.stringify([{ variantId: 'v1', productId: 'p1', label: 'Rice — 1kg', unitPrice: 6, qty: 1 }]));
    } catch (e) {}
  });
  await page.goto(BASE + '/checkout.html', { waitUntil: 'load' });
  await page.waitForFunction(() => typeof storeInfo !== 'undefined' && storeInfo && storeInfo.phone, null, { timeout: 5000 });

  // Fill the form
  await page.fill('#customer-name', 'Debby Hakau');
  await page.fill('#customer-phone', '+686111');
  await page.selectOption('#checkout-island', 'South Tarawa');
  // pick first village option that isn't the placeholder
  await page.evaluate(() => {
    const vs = document.getElementById('checkout-village');
    for (const o of vs.options) { if (o.value && o.value !== 'Other') { vs.value = o.value; vs.dispatchEvent(new Event('change', { bubbles: true })); break; } }
  });
  // choose delivery method (pickPay should be present)
  await page.waitForSelector('input[name="deliveryMethod"]');
  await page.evaluate(() => { const r = document.querySelector('input[name="deliveryMethod"]'); r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); });

  const t0 = Date.now();
  await page.click('#place-order-btn');

  // Observe popup presence (only when emailedSeller)
  let popupSeen = false, popupText = '';
  if (emailedSeller) {
    await page.waitForSelector('#order-sent-popup.is-visible', { timeout: 4000 });
    popupSeen = true;
    popupText = await page.textContent('.order-sent-text');
    // confirmation should NOT be visible yet while popup shows
    const confHiddenDuringPopup = await page.evaluate(() => document.getElementById('confirmation-section').classList.contains('hidden'));
    // now wait for confirmation to appear
    await page.waitForSelector('#confirmation-section:not(.hidden)', { timeout: 5000 });
    const elapsed = Date.now() - t0;
    await browser.close();
    return { emailedSeller, popupSeen, popupText, confHiddenDuringPopup, elapsed };
  } else {
    // No popup; confirmation should appear quickly
    await page.waitForSelector('#confirmation-section:not(.hidden)', { timeout: 5000 });
    const popupExists = await page.evaluate(() => !!document.querySelector('#order-sent-popup.is-visible'));
    const elapsed = Date.now() - t0;
    await browser.close();
    return { emailedSeller, popupVisible: popupExists, elapsed };
  }
}

(async () => {
  const a = await run(true);
  const b = await run(false);
  console.log('emailedSeller=true :', JSON.stringify(a));
  console.log('emailedSeller=false:', JSON.stringify(b));
  const results = [];
  const ok = (n, c, e) => results.push([c ? 'PASS' : 'FAIL', n, e || '']);
  ok('popup shown when emailed', a.popupSeen === true);
  ok('popup text mentions seller emailed', /seller has been emailed/i.test(a.popupText), a.popupText);
  ok('confirmation hidden while popup shows', a.confHiddenDuringPopup === true);
  ok('popup delays confirmation ~2.6s', a.elapsed >= 2400, `elapsed=${a.elapsed}`);
  ok('no popup when not emailed', b.popupVisible === false);
  ok('no-email path reaches confirmation fast', b.elapsed < 2000, `elapsed=${b.elapsed}`);
  let failed = 0;
  console.log('\n--- Email-sent popup ---');
  for (const [st, n, e] of results) { if (st === 'FAIL') failed++; console.log(`${st}  ${n}${e ? '  [' + e + ']' : ''}`); }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
