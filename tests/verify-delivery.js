const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = 'http://127.0.0.1:8099';
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e || '']);

const STORE = (over) => Object.assign({
  ownerId: 'o1', storeName: 'Bong', storeSlug: 'bong', phone: '73001224',
  island: 'South Tarawa', village: 'Betio', status: 'active',
  deliveryTruck: false, deliveryShip: false, deliveryAirCargo: false, deliveryPickPay: false,
  deliveryTruckCost: null, deliveryShipCost: null, deliveryAirCargoCost: null,
}, over);

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

  async function checkout(store, { fail = false, island = 'South Tarawa', village = 'Betio', qty = 2, price = 50 } = {}) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 900 } });
    await ctx.route('**/macros/s/**', (r) => {
      let action = ''; try { action = new URL(r.request().url()).searchParams.get('action') || ''; } catch (e) {}
      try { if (!action) action = (r.request().postDataJSON() || {}).action; } catch (e) {}
      if (action === 'getStorePublicInfo') {
        return r.fulfill({ status: 200, contentType: 'application/json',
          body: JSON.stringify(fail ? { ok: false, error: 'Backend unavailable' } : { ok: true, store }) });
      }
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });
    const page = await ctx.newPage();
    await page.addInitScript(({ q, p }) => {
      localStorage.setItem('skiri_cookie_consent', 'true');
      localStorage.setItem('skiri_active_store', 'bong');
      localStorage.setItem('skiri_cart_bong', JSON.stringify([
        { variantId: 'v1', productId: 'p1', label: 'Rice 1kg', unitPrice: p, qty: q }]));
    }, { q: qty, p: price });
    await page.goto(BASE + '/checkout.html', { waitUntil: 'load' });
    await page.waitForTimeout(250);
    if (!fail) {
      await page.selectOption('#checkout-island', island);
      await page.waitForTimeout(80);
      const opts = await page.$$eval('#checkout-village option', (o) => o.map((x) => x.value).filter(Boolean));
      await page.selectOption('#checkout-village', opts.includes(village) ? village : opts[0]);
      await page.waitForTimeout(150);
    }
    return { ctx, page };
  }

  const state = (page) => page.evaluate(() => {
    const opts = [...document.querySelectorAll('#delivery-method-options .delivery-method-option')];
    const alertEl = document.getElementById('delivery-alert');
    const note = document.getElementById('delivery-negotiated-note');
    return {
      labels: opts.map((o) => o.textContent.replace(/\s+/g, ' ').trim()),
      checked: (document.querySelector('input[name="deliveryMethod"]:checked') || {}).value || null,
      placeDisabled: document.getElementById('place-order-btn').disabled,
      alertClass: alertEl.className,
      alertText: alertEl.textContent.replace(/\s+/g, ' ').trim(),
      hasContact: !!document.getElementById('delivery-contact-store'),
      hasRetry: !!document.getElementById('delivery-retry'),
      deliveryCell: (document.getElementById('review-delivery-cost') || {}).textContent || '',
      total: (document.getElementById('review-total') || {}).textContent || '',
      noteVisible: !note.classList.contains('hidden'),
      noteText: note.textContent.trim(),
    };
  });

  // CASE 1 - Pick & Pay available
  let { ctx, page } = await checkout(STORE({ deliveryPickPay: true }));
  let s = await state(page);
  ok('CASE 1: Pick & Pay auto-selected', s.checked === 'pickPay', s.checked);
  ok('CASE 1: shown as Free', /Free/.test(s.labels.join('|')), s.labels.join('|'));
  ok('CASE 1: total = subtotal', s.total === '$100.00', s.total);
  await ctx.close();

  // CASE 2 - fixed truck fee
  ({ ctx, page } = await checkout(STORE({ deliveryTruck: true, deliveryTruckCost: 15 })));
  s = await state(page);
  ok('CASE 2: fixed fee shown', /\$15\.00/.test(s.labels.join('|')), s.labels.join('|'));
  ok('CASE 2: fee added to total', s.total === '$115.00', s.total);
  await ctx.close();

  // CASE 3/4 - truck enabled, cost never set -> negotiated (the money bug)
  ({ ctx, page } = await checkout(STORE({ deliveryTruck: true, deliveryTruckCost: null })));
  s = await state(page);
  ok('CASE 3: labelled To Be Negotiated', /To Be Negotiated/.test(s.labels.join('|')), s.labels.join('|'));
  ok('CASE 3: never shows Free', !/Free/.test(s.labels.join('|')), s.labels.join('|'));
  ok('CASE 3: review cell = To Be Negotiated', s.deliveryCell === 'To Be Negotiated', s.deliveryCell);
  ok('CASE 3: unknown fee excluded from total', s.total === '$100.00', s.total);
  ok('CASE 3: negotiation note shown', s.noteVisible && /Chat with store/.test(s.noteText), s.noteText);
  await ctx.close();

  // CASE 6 - mixed: Pick & Pay free + truck fixed
  ({ ctx, page } = await checkout(STORE({ deliveryPickPay: true, deliveryTruck: true, deliveryTruckCost: 15 })));
  s = await state(page);
  ok('CASE 6: both methods offered', s.labels.length === 2, String(s.labels.length));
  ok('CASE 6: Pick & Pay still the default', s.checked === 'pickPay', s.checked);
  ok('CASE 6: no alert while options exist', /hidden/.test(s.alertClass), s.alertClass);
  await ctx.close();

  // CASE 7 - nothing eligible
  ({ ctx, page } = await checkout(STORE({})));
  s = await state(page);
  ok('CASE 7: light-red unavailable panel', /delivery-alert--unavailable/.test(s.alertClass), s.alertClass);
  ok('CASE 7: exact brief wording', s.alertText.includes("This store can't deliver to your island/village with an available method. Double-check your selection above, or contact the store directly."), s.alertText);
  ok('CASE 7: Place Order blocked', s.placeDisabled === true);
  ok('CASE 7: Contact Store offered', s.hasContact === true);
  await ctx.close();

  // CASE 9 - backend failed: must NOT claim the store can't deliver
  ({ ctx, page } = await checkout(STORE({}), { fail: true }));
  s = await state(page);
  ok('CASE 9: failed-load state, not unavailable', /delivery-alert--failed/.test(s.alertClass), s.alertClass);
  ok('CASE 9: does NOT say the store cannot deliver', !/can't deliver/.test(s.alertText), s.alertText);
  ok('CASE 9: offers retry', s.hasRetry === true);
  ok('CASE 9: Place Order blocked', s.placeDisabled === true);
  await ctx.close();

  // CASE 8 - a selection that stops being eligible must not survive
  ({ ctx, page } = await checkout(STORE({ deliveryPickPay: true, deliveryTruck: true, deliveryTruckCost: 15 })));
  await page.evaluate(() => {
    const t = document.querySelector('input[name="deliveryMethod"][value="truck"]');
    t.checked = true; t.dispatchEvent(new Event('change', { bubbles: true }));
  });
  // Outer island: a South Tarawa vendor's truck can't reach it, so truck drops out.
  await page.selectOption('#checkout-island', 'Abemama');
  await page.waitForTimeout(80);
  const vopts = await page.$$eval('#checkout-village option', (o) => o.map((x) => x.value).filter(Boolean));
  await page.selectOption('#checkout-village', vopts[0]);
  await page.waitForTimeout(150);
  s = await state(page);
  ok('CASE 8: stale truck selection dropped', s.checked === 'pickPay', s.checked);
  ok('CASE 8: a method is always selected when options exist', s.checked !== null);
  await ctx.close();

  await browser.close();
  let f = 0;
  console.log('\n--- Delivery Phase 1 ---');
  for (const [st, n, e] of R) { if (st === 'FAIL') f++; console.log(`${st}  ${n}${e ? '  [' + e + ']' : ''}`); }
  console.log(`\n${R.length - f}/${R.length} passed`);
  process.exit(f ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
