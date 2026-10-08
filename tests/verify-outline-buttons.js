/**
 * Dark purple buttons are outlined (owner's call, Oct 2026): white inside,
 * dark purple border and text, lavender on hover. The purchase/payment steps
 * keep .btn-solid. Green Save buttons stay green. Checked on real pages.
 */
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = 'http://127.0.0.1:8099';
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e === undefined ? '' : e]);
const PURPLE = 'rgb(51, 45, 99)', WHITE = 'rgb(255, 255, 255)', SOFT = 'rgb(232, 229, 242)';
const SHOT = process.env.SHOT_DIR || '';

const P = { productId: 'p1', name: 'Samsung 7', description: 'Free cover', category: 'electronics', listingType: 'product',
  imageUrl: '', storeSlug: 'bong', storeName: 'Teaube', variants: [{ variantId: 'v1', label: 'Samsung 7', price: 260, stockQty: null }] };

async function open(browser, path, seed) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx.route('**/macros/s/**', (r) => {
    let a = ''; try { a = new URL(r.request().url()).searchParams.get('action') || ''; } catch (e) {}
    try { const j = r.request().postDataJSON(); if (!a && j) a = j.action; } catch (e) {}
    const J = (o) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
    if (a === 'listProducts') return J({ ok: true, storeName: 'Teaube', storeSlug: 'bong', storeOpen: true, products: [P] });
    if (a === 'listProductReviews') return J({ ok: true, reviews: [], average: null, count: 0, distribution: [0, 0, 0, 0, 0] });
    if (a === 'getStorePublicInfo') return J({ ok: true, store: { storeName: 'Teaube', storeSlug: 'bong' } });
    J({ ok: true, products: [], stores: [], reviews: [] });
  });
  const page = await ctx.newPage();
  await page.addInitScript((s) => {
    try {
      localStorage.setItem('skiri_cookie_consent', 'true');
      if (s) Object.keys(s).forEach((k) => localStorage.setItem(k, s[k]));
    } catch (e) {}
  }, seed || null);
  await page.goto(BASE + path, { waitUntil: 'load' });
  await page.waitForTimeout(900);
  return { ctx, page };
}

const look = (page, sel) => page.$eval(sel, (b) => {
  const c = getComputedStyle(b);
  return { bg: c.backgroundColor, color: c.color, border: c.borderTopColor };
});

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const cart = JSON.stringify([{ variantId: 'v1', productId: 'p1', label: 'Samsung 7 — Samsung 7', unitPrice: 260, qty: 1 }]);

  /* product page: Add to Cart + Submit review outlined */
  let { ctx, page } = await open(browser, '/product.html?store=bong&product=p1');
  // Submit review only renders for a signed-in shopper, so a plain .btn-primary stands in for it.
  await page.evaluate(() => { const b = document.createElement('button'); b.id = 'probe-primary'; b.className = 'btn btn-primary'; b.textContent = 'Submit review'; document.querySelector('main').appendChild(b); });
  for (const sel of ['.add-to-cart-btn', '#probe-primary']) {
    const s = await look(page, sel);
    ok(`product page: ${sel} is outlined (white, purple border + text)`, s.bg === WHITE && s.border === PURPLE && s.color === PURPLE, JSON.stringify(s));
  }
  await page.hover('.add-to-cart-btn');
  await page.waitForTimeout(150);
  ok('hover fills light purple', (await look(page, '.add-to-cart-btn')).bg === SOFT);
  if (SHOT) await page.screenshot({ path: SHOT + '/btn-product.png', fullPage: true });
  await ctx.close();

  /* my carts: View Cart outlined */
  ({ ctx, page } = await open(browser, '/my-carts.html', { skiri_cart_bong: cart, skiri_cart_gold: cart }));
  const v = await look(page, 'a.btn-primary');
  ok('my carts: View Cart is outlined', v.bg === WHITE && v.border === PURPLE && v.color === PURPLE, JSON.stringify(v));
  if (SHOT) await page.screenshot({ path: SHOT + '/btn-mycarts.png', fullPage: true });
  await ctx.close();

  /* cart: Proceed to Checkout stays solid */
  ({ ctx, page } = await open(browser, '/cart.html?store=bong', { skiri_cart_bong: cart, skiri_active_store: 'bong' }));
  const c = await look(page, '#checkout-btn');
  ok('cart: Proceed to Checkout stays SOLID dark purple, white text', c.bg === PURPLE && c.color === WHITE, JSON.stringify(c));
  if (SHOT) await page.screenshot({ path: SHOT + '/btn-cart.png', fullPage: true });
  await ctx.close();

  /* source: the solid set, and nothing else */
  const fs = require('fs'), REPO = '/home/user/simple-kiri-shop/';
  const files = ['cart.html', 'checkout.html', 'owner/feature.html', 'assets/js/owner-feature.js'];
  const solid = files.map((f) => (fs.readFileSync(REPO + f, 'utf8').match(/btn-solid/g) || []).length);
  ok('solid only on: Proceed to Checkout, Place Order, Continue to payment, Upload payment, Pay now',
    solid.join(',') === '1,1,2,1', solid.join(','));

  /* green Save buttons keep their own colour, no purple outline */
  ({ ctx, page } = await open(browser, '/customer-dashboard.html'));
  const save = await page.evaluate(() => {
    const b = document.createElement('button'); b.className = 'btn btn-primary btn-save'; b.textContent = 'Save';
    document.body.appendChild(b); const c = getComputedStyle(b);
    return { bg: c.backgroundColor, border: c.borderTopColor, color: c.color };
  });
  ok('green Save stays green with white text, no purple border', save.bg !== WHITE && save.color === WHITE && save.border !== PURPLE, JSON.stringify(save));
  await ctx.close();

  /* phone search disc: outlined, icon still visible */
  ({ ctx, page } = await open(browser, '/categories.html'));
  await page.fill('.search-box input[type="search"], .search-box input', 'rice').catch(() => {});
  await page.waitForTimeout(300);
  const disc = await page.$eval('.search-box .search-submit', (b) => { const c = getComputedStyle(b); return { bg: c.backgroundColor, color: c.color, border: c.borderTopColor }; }).catch(() => null);
  ok('phone search button: outlined, magnifier visible (purple on white)', !!disc && disc.bg === WHITE && disc.color === PURPLE, JSON.stringify(disc));
  await ctx.close();

  await browser.close();
  let f = 0;
  console.log('\n--- outlined buttons ---');
  for (const [s, n, e] of R) { if (s === 'FAIL') f++; console.log(`${s}  ${n}${e !== '' ? '  [' + e + ']' : ''}`); }
  console.log(`\n${R.length - f}/${R.length} passed`);
  process.exit(f ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
