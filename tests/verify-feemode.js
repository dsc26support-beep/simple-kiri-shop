const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = 'http://127.0.0.1:8099';
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e || '']);

const OWNER = (over) => Object.assign({
  ownerId: 'o1', storeName: 'Bong', storeSlug: 'bong', email: 'o@b.com', phone: '73001224',
  island: 'South Tarawa', village: 'Betio', status: 'active', logoUrl: 'https://res.cloudinary.com/x/logo.png',
  deliveryTruck: true, deliveryShip: false, deliveryAirCargo: false, deliveryPickPay: true,
  deliveryTruckCost: null, deliveryShipCost: null, deliveryAirCargoCost: null, twoFAEnabled: false,
}, over);

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

  async function settings(owner) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 900 } });
    const posted = [];
    await ctx.route('**/macros/s/**', (r) => {
      let body = null; try { body = r.request().postDataJSON(); } catch (e) {}
      if (body) posted.push(body);
      const action = body ? body.action : '';
      if (action === 'getOwnerProfile') {
        return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, owner }) });
      }
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, owner }) });
    });
    const page = await ctx.newPage();
    await page.addInitScript(() => {
      localStorage.setItem('skiri_cookie_consent', 'true');
      localStorage.setItem('skiri_owner_token', 'tok');
    });
    await page.goto(BASE + '/owner/settings.html', { waitUntil: 'load' });
    await page.waitForTimeout(400);
    return { ctx, page, posted };
  }

  // onSaveSettings validates island/village before building the payload, so
  // the harness has to satisfy them to reach the delivery-cost logic.
  const ensureLocation = (page) => page.evaluate(() => {
    const v = document.getElementById('settings-village');
    if (v && !v.value) {
      const first = [...v.options].map((o) => o.value).filter(Boolean)[0];
      if (first) { v.value = first; v.dispatchEvent(new Event('change', { bubbles: true })); }
    }
  });
  const errText = (page) => page.evaluate(() => (document.getElementById('settings-error') || {}).textContent || '');

  const state = (page) => page.evaluate(() => ({
    truckMode: (document.querySelector('input[name="truckFeeMode"]:checked') || {}).value,
    modeVisible: !document.getElementById('delivery-truck-mode').classList.contains('hidden'),
    costVisible: !document.getElementById('delivery-truck-cost').classList.contains('hidden'),
    costValue: document.getElementById('delivery-truck-cost').value,
    shipModeVisible: !document.getElementById('delivery-ship-mode').classList.contains('hidden'),
  }));

  // Unset fee -> preselects Negotiated (this is the state that used to be unreachable)
  let { ctx, page } = await settings(OWNER({ deliveryTruckCost: null }));
  let st = await state(page);
  ok('unset fee preselects "To Be Negotiated"', st.truckMode === 'negotiated', st.truckMode);
  ok('negotiated hides the cost box', st.costVisible === false);
  ok('enabled method shows the fee-type choice', st.modeVisible === true);
  ok('disabled method hides the fee-type choice', st.shipModeVisible === false);
  await ctx.close();

  // Fixed fee round-trips
  ({ ctx, page } = await settings(OWNER({ deliveryTruckCost: 15 })));
  st = await state(page);
  ok('fixed fee preselects "Fixed"', st.truckMode === 'fixed', st.truckMode);
  ok('fixed fee shows the cost box', st.costVisible === true);
  ok('fixed fee value loaded', st.costValue === '15', st.costValue);
  await ctx.close();

  // Genuinely free (0) is NOT negotiated
  ({ ctx, page } = await settings(OWNER({ deliveryTruckCost: 0 })));
  st = await state(page);
  ok('zero fee is Fixed, not negotiated', st.truckMode === 'fixed', st.truckMode);
  ok('zero fee shows 0 in the box', st.costValue === '0', st.costValue);
  await ctx.close();

  // Save: negotiated -> null on the wire
  let res = await settings(OWNER({ deliveryTruckCost: 15 }));
  await res.page.click('input[name="truckFeeMode"][value="negotiated"]');
  await res.page.waitForTimeout(80);
  ok('choosing negotiated hides the cost box', (await state(res.page)).costVisible === false);
  await ensureLocation(res.page);
  await res.page.evaluate(() => document.getElementById('settings-form')
    .dispatchEvent(new Event('submit', { cancelable: true, bubbles: true })));
  await res.page.waitForTimeout(300);
  let sent = res.posted.filter((b) => b && b.action === 'updateOwnerProfile').pop();
  ok('negotiated saves as null, not 0', sent && sent.deliveryTruckCost === null, JSON.stringify(sent && sent.deliveryTruckCost) + ' err=' + (await errText(res.page)));
  await res.ctx.close();

  // Save: fixed -> the number
  res = await settings(OWNER({ deliveryTruckCost: null }));
  await res.page.click('input[name="truckFeeMode"][value="fixed"]');
  await res.page.fill('#delivery-truck-cost', '12.5');
  await ensureLocation(res.page);
  await res.page.evaluate(() => document.getElementById('settings-form')
    .dispatchEvent(new Event('submit', { cancelable: true, bubbles: true })));
  await res.page.waitForTimeout(300);
  sent = res.posted.filter((b) => b && b.action === 'updateOwnerProfile').pop();
  ok('fixed saves the entered number', sent && sent.deliveryTruckCost === 12.5, JSON.stringify(sent && sent.deliveryTruckCost));
  await res.ctx.close();

  // Save: fixed + blank box -> 0 (explicit choice, so free is unambiguous)
  res = await settings(OWNER({ deliveryTruckCost: 5 }));
  await res.page.fill('#delivery-truck-cost', '');
  await ensureLocation(res.page);
  await res.page.evaluate(() => document.getElementById('settings-form')
    .dispatchEvent(new Event('submit', { cancelable: true, bubbles: true })));
  await res.page.waitForTimeout(300);
  sent = res.posted.filter((b) => b && b.action === 'updateOwnerProfile').pop();
  ok('fixed + blank saves 0 (free), unambiguous now', sent && sent.deliveryTruckCost === 0, JSON.stringify(sent && sent.deliveryTruckCost));
  await res.ctx.close();

  await browser.close();
  let f = 0;
  console.log('\n--- Vendor fee mode (Fixed / To Be Negotiated) ---');
  for (const [s, n, e] of R) { if (s === 'FAIL') f++; console.log(`${s}  ${n}${e ? '  [' + e + ']' : ''}`); }
  console.log(`\n${R.length - f}/${R.length} passed`);
  process.exit(f ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
