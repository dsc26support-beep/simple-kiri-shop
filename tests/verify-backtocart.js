// "Back to Cart" moves out of a floating pill and under Place Order, matching
// cart.html's own Proceed to Checkout / Continue Shopping pair.
//
// The floating version sat over the order summary and followed the shopper down
// the page. What must survive the move is that it still reaches the cart, and
// that it never gets mistaken for the primary action - a shopper one tap from
// paying should not find two blue buttons of equal weight.
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = 'http://127.0.0.1:8099';

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e || '']);

  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx.route('**/macros/s/**', (r) => {
    let a = '';
    try { a = (r.request().postDataJSON() || {}).action; } catch (e) {}
    try { if (!a) a = new URL(r.request().url()).searchParams.get('action') || ''; } catch (e) {}
    let res = { ok: true };
    if (a === 'getStorePublicInfo') {
      res = { ok: true, store: { storeName: 'Bong', storeSlug: 'bong', phone: '73007552',
        island: 'South Tarawa', village: 'Betio', isOpen: true, deliveryPickPay: true } };
    }
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(res) });
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.addInitScript(() => {
    if (window.__s) return; window.__s = 1;
    try {
      localStorage.setItem('skiri_active_store', 'bong');
      localStorage.setItem('skiri_cart_bong', JSON.stringify(
        [{ variantId: 'v1', productId: 'p1', label: 'Rice Chop Syue — small', unitPrice: 6, qty: 1 }]));
    } catch (e) {}
  });
  await page.goto(BASE + '/checkout.html', { waitUntil: 'load' });
  await page.waitForTimeout(700);

  const g = await page.evaluate(() => {
    const back = document.getElementById('back-to-cart-link');
    const place = document.getElementById('place-order-btn');
    const bb = back.getBoundingClientRect();
    const pb = place.getBoundingClientRect();
    const cs = getComputedStyle(back);
    const ps = getComputedStyle(place);
    return {
      classes: back.className,
      href: back.getAttribute('href'),
      position: cs.position,
      belowPlaceOrder: bb.top >= pb.bottom - 1,
      sameWidth: Math.round(bb.width) === Math.round(pb.width),
      backBg: cs.backgroundColor,
      placeBg: ps.backgroundColor,
      height: Math.round(bb.height),
      text: back.textContent.trim(),
      insideForm: !!back.closest('#checkout-form'),
      // Nothing should still be floating over the page on the left.
      leftFabs: document.querySelectorAll('.floating-action-btn--left').length
    };
  });

  ok('Back to Cart is no longer floating', g.position !== 'fixed', g.position);
  ok('and no left-hand floating button is left behind', g.leftFabs === 0, String(g.leftFabs));
  ok('THE ASK: it sits underneath Place Order', g.belowPlaceOrder === true, JSON.stringify(g));
  ok('full width, same as Place Order', g.sameWidth === true, JSON.stringify(g));
  ok('it uses the same secondary style as the cart page',
    /btn-continue-shopping/.test(g.classes), g.classes);
  ok('so it does NOT look like a second primary button',
    g.backBg !== g.placeBg, `${g.backBg} vs ${g.placeBg}`);
  ok('still a comfortable tap target', g.height >= 44, String(g.height));
  ok('it still says Back to Cart', /Back to Cart/.test(g.text), g.text);
  ok('and still points at the cart', g.href === 'cart.html', String(g.href));
  ok('it sits inside the checkout form, with the button it belongs to',
    g.insideForm === true, String(g.insideForm));

  // It has to actually go there, and not submit the form on the way.
  await page.click('#back-to-cart-link');
  await page.waitForURL(/cart\.html/, { timeout: 6000 }).catch(() => {});
  ok('tapping it reaches the cart', /cart\.html/.test(page.url()), page.url());
  ok('and it did not submit the order form on the way',
    !/checkout\.html\?/.test(page.url()), page.url());

  ok('no page errors - the removed JS href line broke nothing',
    errors.length === 0, errors.join('; '));
  await ctx.close();

  // The pattern it was copied from must be untouched.
  {
    const c = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await c.route('**/macros/s/**', (r) => r.fulfill({ status: 200,
      contentType: 'application/json', body: JSON.stringify({ ok: true }) }));
    const p2 = await c.newPage();
    await p2.addInitScript(() => {
      if (window.__s) return; window.__s = 1;
      try {
        localStorage.setItem('skiri_active_store', 'bong');
        localStorage.setItem('skiri_cart_bong', JSON.stringify(
          [{ variantId: 'v1', productId: 'p1', label: 'Rice', unitPrice: 6, qty: 1 }]));
      } catch (e) {}
    });
    await p2.goto(BASE + '/cart.html', { waitUntil: 'load' });
    await p2.waitForTimeout(600);
    const cart = await p2.evaluate(() => {
      const go = document.getElementById('checkout-btn');
      const cont = document.getElementById('back-to-store-link');
      return { contBelow: cont.getBoundingClientRect().top >= go.getBoundingClientRect().bottom - 1,
               contClass: cont.className, goClass: go.className };
    });
    ok('cart.html still has its own pair, unchanged',
      cart.contBelow === true && /btn-continue-shopping/.test(cart.contClass) &&
      /btn-primary/.test(cart.goClass), JSON.stringify(cart));
    await c.close();
  }

  await browser.close();
  console.log('\n--- Back to Cart placement ---');
  let f = 0;
  for (const [s, n, e] of R) { if (s === 'FAIL') f++; console.log(`${s}  ${n}${e ? '  [' + e + ']' : ''}`); }
  console.log(`\n${R.length - f}/${R.length} passed`);
  process.exit(f ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
