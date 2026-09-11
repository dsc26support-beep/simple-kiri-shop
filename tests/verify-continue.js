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
    if (action === 'getStorePublicInfo') body = { ok: true, store: { storeName: 'Bong', phone: '+686111', deliveryPickPay: true } };
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    try {
      localStorage.setItem('skiri_active_store', 'bong');
      localStorage.setItem('skiri_cart_bong', JSON.stringify([{ variantId: 'v1', productId: 'p1', label: 'Rice', unitPrice: 5, qty: 2 }]));
    } catch (e) {}
  });
  await page.goto(BASE + '/cart.html', { waitUntil: 'load' });
  await page.waitForSelector('#cart-content:not(.hidden)');
  const s = await page.evaluate(() => {
    const link = document.getElementById('back-to-store-link');
    const checkout = document.getElementById('checkout-btn');
    const content = document.getElementById('cart-content');
    const isFloating = link ? link.classList.contains('floating-action-btn') : null;
    const insideContent = content && link ? content.contains(link) : false;
    // order: checkout comes before continue-shopping in DOM
    const belowCheckout = checkout && link ? !!(checkout.compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING) : false;
    const cRect = checkout ? checkout.getBoundingClientRect() : null;
    const lRect = link ? link.getBoundingClientRect() : null;
    return {
      exists: !!link,
      isFloating,
      insideContent,
      belowCheckout,
      hasContinueClass: link ? link.classList.contains('btn-continue-shopping') : false,
      isBtn: link ? link.classList.contains('btn') : false,
      href: link ? link.getAttribute('href') : '',
      visualBelow: cRect && lRect ? lRect.top >= cRect.bottom - 2 : false,
      sameWidth: cRect && lRect ? Math.abs(cRect.width - lRect.width) < 2 : false,
    };
  });
  console.log(JSON.stringify(s, null, 2));
  const pass = s.exists && s.isFloating === false && s.insideContent && s.belowCheckout && s.hasContinueClass && s.isBtn && s.visualBelow && s.sameWidth && /store\.html/.test(s.href);
  console.log(pass ? '\nALL PASS' : '\nFAIL');
  await browser.close();
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
