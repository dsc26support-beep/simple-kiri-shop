const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = 'http://127.0.0.1:8099';

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 800 } });
  await ctx.route('**/macros/s/**', (route) => {
    let action = '';
    try { action = (route.request().postDataJSON() || {}).action; } catch (e) {}
    try { if (!action) action = new URL(route.request().url()).searchParams.get('action') || ''; } catch (e) {}
    let body = { ok: true };
    if (action === 'getStorePublicInfo') body = { ok: true, store: { storeName: 'Bong Restaurant', phone: '+68673007552', email: 'seller@x.com', deliveryPickPay: true } };
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });

  const results = [];
  const ok = (n, c, e) => results.push([c ? 'PASS' : 'FAIL', n, e || '']);

  const page = await ctx.newPage();
  await page.addInitScript(() => {
    try {
      localStorage.setItem('skiri_active_store', 'bong');
      localStorage.setItem('skiri_cart_bong', JSON.stringify([{ variantId: 'v1', productId: 'p1', label: 'Rice — 1kg', unitPrice: 5, qty: 2 }]));
    } catch (e) {}
  });
  await page.goto(BASE + '/checkout.html', { waitUntil: 'load' });
  await page.waitForFunction(() => window.storeInfo && window.storeInfo.phone, null, { timeout: 4000 }).catch(() => {});

  // Drive the confirmation screen directly.
  await page.evaluate(() => {
    showConfirmation(
      { orderId: 'SKS-bong-1', total: 18, deliveryCost: 0, items: [{ label: 'Rice — 1kg', unitPrice: 5, qty: 2 }] },
      { customerName: 'Debby', customerPhone: '+686111', island: 'South Tarawa', village: 'Betio', deliveryMethod: 'truck', notes: '' }
    );
  });
  await page.waitForSelector('#confirmation-section:not(.hidden)');

  // The single "Call Seller Now!" button became the first of three (Call /
  // WhatsApp / Messenger). What this suite still guards is everything that was
  // true before and must stay true: the copy/email buttons are gone, the call
  // action is present, green, and dials the store - just from #order-contact
  // now instead of #call-seller-link.
  const state = await page.evaluate(() => {
    const call = document.querySelector('#order-contact .btn-call');
    const probe = document.createElement('div');
    probe.style.background = 'var(--color-success)';
    document.body.appendChild(probe);
    const greenRef = getComputedStyle(probe).backgroundColor;
    probe.remove();
    const cta = document.querySelector('.confirmation-cta');
    return {
      copyGone: !document.getElementById('copy-summary-btn'),
      emailGone: !document.getElementById('email-order-link'),
      oldIdGone: !document.getElementById('call-seller-link'),
      callExists: !!call,
      callVisible: call ? getComputedStyle(call).display !== 'none' : false,
      hasBtnCall: call ? call.classList.contains('btn-call') : false,
      href: call ? call.getAttribute('href') : '',
      bg: call ? getComputedStyle(call).backgroundColor : '',
      greenRef,
      label: call ? call.textContent.trim() : '',
      cta: cta ? cta.textContent : '',
    };
  });

  ok('Copy Summary button removed', state.copyGone);
  ok('Email Seller button removed', state.emailGone);
  ok('the old single-button #call-seller-link is gone', state.oldIdGone);
  ok('green call link present + visible', state.callExists && state.callVisible && state.hasBtnCall, JSON.stringify(state));
  ok('href is tel: store phone', state.href === 'tel:+68673007552', state.href);
  ok('button is green (--color-success)', state.bg === state.greenRef && /rgb/.test(state.bg), `${state.bg} vs ${state.greenRef}`);
  ok('label says Call', state.label === 'Call', state.label);
  ok('CTA reads CALL SELLER NOW!', /CALL SELLER NOW!/.test(state.cta), state.cta);

  await browser.close();
  console.log('\n--- Call action on the order confirmation ---');
  let failed = 0;
  for (const [st, n, e] of results) { if (st === 'FAIL') failed++; console.log(`${st}  ${n}${e ? '  [' + e + ']' : ''}`); }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
