const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = 'http://127.0.0.1:8099';

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 800 } });
  const posted = [];
  await ctx.route('**/macros/s/**', (route) => {
    let action = '', body = {};
    try { body = route.request().postDataJSON() || {}; action = body.action; } catch (e) {}
    try { if (!action) action = new URL(route.request().url()).searchParams.get('action') || ''; } catch (e) {}
    if (action) posted.push(action);
    let out = { ok: true };
    if (action === 'getStorePublicInfo') out = { ok: true, store: { storeName: 'Bong', phone: '+68673001224', island: 'South Tarawa', deliveryTruck: true, deliveryTruckCost: 5, deliveryPickPay: true } };
    else if (action === 'createOrder') out = { ok: true, orderId: 'SKS-bong-1', total: 6, deliveryMethod: 'pickPay', deliveryCost: 0, items: [{ label: 'Rice', unitPrice: 6, qty: 1 }] };
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(out) });
  });
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    try {
      localStorage.setItem('skiri_active_store', 'bong');
      localStorage.setItem('skiri_cart_bong', JSON.stringify([{ variantId: 'v1', productId: 'p1', label: 'Rice', unitPrice: 6, qty: 1 }]));
    } catch (e) {}
  });
  await page.goto(BASE + '/checkout.html', { waitUntil: 'load' });
  await page.waitForFunction(() => typeof storeInfo !== 'undefined' && storeInfo && storeInfo.island, null, { timeout: 5000 });

  const results = [];
  const ok = (n, c, e) => results.push([c ? 'PASS' : 'FAIL', n, e || '']);

  // Select island + village so delivery options render
  await page.selectOption('#checkout-island', 'South Tarawa');
  await page.evaluate(() => {
    const vs = document.getElementById('checkout-village');
    for (const o of vs.options) { if (o.value && o.value !== 'Other (please specify)') { vs.value = o.value; vs.dispatchEvent(new Event('change', { bubbles: true })); break; } }
  });
  await page.waitForSelector('input[name="deliveryMethod"]');

  // §4: default-checked delivery method should be pickPay (present + free)
  const checkedVal = await page.evaluate(() => {
    const r = document.querySelector('input[name="deliveryMethod"]:checked');
    const all = [...document.querySelectorAll('input[name="deliveryMethod"]')].map(x => x.value);
    return { checked: r ? r.value : null, all };
  });
  ok('§4 Pick & Pay is default-selected', checkedVal.checked === 'pickPay', JSON.stringify(checkedVal));
  ok('§4 pickPay is among eligible options', checkedVal.all.includes('pickPay'), JSON.stringify(checkedVal.all));

  // §16: bad local phone blocks the order
  await page.fill('#customer-name', 'Debby');
  await page.fill('#customer-phone', '7201234'); // local but not 730/630
  await page.click('#place-order-btn');
  await page.waitForTimeout(150);
  let err = await page.textContent('#checkout-error');
  const createdAfterBad = posted.includes('createOrder');
  ok('§16 bad local phone shows 730/630 error', /730 or 630/.test(err), err);
  ok('§16 bad local phone blocks createOrder', !createdAfterBad);

  // Valid local phone lets it through
  await page.fill('#customer-phone', '7301234');
  await page.click('#place-order-btn');
  await page.waitForFunction(() => window.__done || document.getElementById('confirmation-section') && !document.getElementById('confirmation-section').classList.contains('hidden'), null, { timeout: 4000 }).catch(() => {});
  const createdAfterGood = posted.includes('createOrder');
  ok('§16 valid local phone allows createOrder', createdAfterGood);

  // Overseas number also allowed (function-level check; form now hidden)
  ok('§16 overseas number passes client validation', await page.evaluate(() => isCustomerPhoneValid('+64211234567')) === true);

  await browser.close();
  let failed = 0;
  console.log('\n--- Checkout: Pick&Pay default (§4) + phone rules (§16) ---');
  for (const [st, n, e] of results) { if (st === 'FAIL') failed++; console.log(`${st}  ${n}${e ? '  [' + e + ']' : ''}`); }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
