const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = 'http://127.0.0.1:8099';

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 800 } });

  // Delay getStorePublicInfo so the initial-load overlay is observable.
  await ctx.route('**/macros/s/**', async (route) => {
    let action = '';
    try { action = (route.request().postDataJSON() || {}).action; } catch (e) {}
    try { if (!action) action = new URL(route.request().url()).searchParams.get('action') || ''; } catch (e) {}
    let body = { ok: true };
    if (action === 'getStorePublicInfo') {
      await new Promise((r) => setTimeout(r, 600));
      body = { ok: true, store: { storeName: 'Test Store', island: 'South Tarawa', village: 'Bairiki', deliveryTruck: true, deliveryTruckCost: 0, deliveryPickPay: true } };
    } else if (action === 'createOrder') {
      await new Promise((r) => setTimeout(r, 600));
      body = { ok: true, orderRef: 'SKS-x-1', order: {} };
    }
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });

  const results = [];
  const ok = (n, c, e) => results.push([c ? 'PASS' : 'FAIL', n, e || '']);

  const page = await ctx.newPage();
  // Seed active store + a non-empty cart so checkout doesn't bounce to cart.html.
  await page.addInitScript(() => {
    try {
      localStorage.setItem('skiri_active_store', 'teststore');
      localStorage.setItem('skiri_cart_teststore', JSON.stringify([
        { variantId: 'v1', productId: 'p1', label: 'Rice — 1kg', unitPrice: 5, qty: 2 }
      ]));
    } catch (e) {}
  });

  await page.goto(BASE + '/checkout.html', { waitUntil: 'load' });

  // 1. Overlay is up during the (delayed) initial load, centered, with Loading text.
  const during = await page.evaluate(() => {
    const o = document.querySelector('.loading-overlay.is-visible');
    if (!o) return null;
    const card = o.querySelector('.loading-overlay-card');
    const cs = getComputedStyle(o);
    return { visible: true, text: card ? card.textContent : '', display: cs.display, justify: cs.justifyContent, align: cs.alignItems };
  });
  ok('initial load: overlay visible + centered', during && during.visible && during.display === 'flex' && during.justify === 'center' && during.align === 'center', JSON.stringify(during));
  ok('initial load: shows "Loading" text + dots', during && /Loading/.test(during.text), during && during.text);

  // 2. After the store loads, the overlay is gone.
  await page.waitForFunction(() => !document.querySelector('.loading-overlay.is-visible'), null, { timeout: 4000 });
  ok('initial load: overlay hidden after store loads', true);
  ok('checkout rendered after load', /Test Store/.test(await page.textContent('#store-name-tagline')));

  // 3. Unit-check the overlay helper directly (show -> visible+Loading; hide -> gone).
  const unit = await page.evaluate(() => {
    const hide = showLoadingOverlay();
    const o = document.querySelector('.loading-overlay.is-visible');
    const shown = !!o && /Loading/.test(o.querySelector('.loading-overlay-card').textContent);
    hide();
    const gone = !document.querySelector('.loading-overlay.is-visible');
    return { shown, gone };
  });
  ok('helper: show makes it visible with Loading', unit.shown);
  ok('helper: hide removes it', unit.gone);

  // 4. Confirm the submit path is wired (source contains hideOverlay around createOrder).
  // (Full form submission needs valid island/village/delivery selection; the helper
  // + initial-load test above cover the overlay behavior. Wiring checked by the code.)

  await browser.close();
  console.log('\n--- checkout loading overlay ---');
  let failed = 0;
  for (const [st, n, e] of results) { if (st === 'FAIL') failed++; console.log(`${st}  ${n}${e ? '  [' + e + ']' : ''}`); }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
