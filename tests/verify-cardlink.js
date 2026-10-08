// Store cards: the whole card opens the product's own page (shared product card, Oct 2026).
//
// The controls on the card are the point of the design - a store card is a
// buying card - so most of this suite is about what must NOT have changed.
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = 'http://127.0.0.1:8099';
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e || '']);

const PRODUCTS = [
  { productId: 'p1', name: 'Rice 10kg', category: 'pantry', description: 'A sack.',
    imageUrl: 'https://res.cloudinary.com/x/a.jpg', imageUrl2: 'https://res.cloudinary.com/x/b.jpg',
    variants: [{ variantId: 'v1', label: 'Sack', price: 25 }, { variantId: 'v2', label: 'Half', price: 13 }] },
  { productId: 'p2', name: 'Blue Shirt', category: 'clothing',
    imageUrl: 'https://res.cloudinary.com/x/c.jpg',
    variants: [{ variantId: 'v3', label: 'M', price: 10 }] },
  { productId: 'p3', name: 'No Photo Item', category: 'household',
    variants: [{ variantId: 'v4', label: 'One', price: 4 }] },
  { productId: 'p4', name: 'Kayak Hire', category: 'rentals', available: true,
    imageUrl: 'https://res.cloudinary.com/x/d.jpg',
    variants: [{ variantId: 'v5', label: 'Per day', price: 30 }] }
];

const STORE = {
  ok: true, storeName: 'Bong', storeSlug: 'bong', storeOpen: true, products: PRODUCTS,
  storeDeliveryTruck: true, storeDeliveryPickPay: true, storeDeliveryTruckCost: 5,
  store: { storeName: 'Bong', storeSlug: 'bong', isOpen: true,
    deliveryTruck: true, deliveryPickPay: true, deliveryTruckCost: 5 }
};

async function openStore(browser, path) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 800 } });
  await ctx.route('**/macros/s/**', (r) => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify(Object.assign({ tips: [], stores: [], conversations: [], reviews: [] }, STORE)) }));
  const page = await ctx.newPage();
  await page.addInitScript(() => localStorage.setItem('skiri_cookie_consent', 'true'));
  await page.goto(BASE + '/' + path, { waitUntil: 'load' });
  await page.waitForSelector('#product-list .product-card, #product-detail .product-card');
  await page.waitForTimeout(300);
  return { ctx, page };
}

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

  // ---------- store.html: the shared product card (Oct 2026) ----------
  // A store page shows the same card as everywhere else: the whole card opens
  // the product (a stretched title link), with one real button - the round
  // cart button - sitting above it, never inside it.
  {
    const { ctx, page } = await openStore(browser, 'store.html?store=bong');

    const cards = await page.evaluate(() => [...document.querySelectorAll('#product-list .product-card')].map((c) => {
      const link = c.querySelector('.product-card-link');
      return {
        pid: c.dataset.productId, tag: c.tagName,
        href: link ? link.getAttribute('href') : null,
        linkName: link ? link.getAttribute('aria-label') : null,
        links: c.querySelectorAll('a').length,
        cart: !!c.querySelector('.card-cart-btn')
      };
    }));
    ok('every card is an article with one link', cards.length === 4 && cards.every((c) => c.tag === 'ARTICLE' && c.links === 1), JSON.stringify(cards));
    ok('the link is named by the product (and store)', cards[0].linkName === 'Rice 10kg, Bong', cards[0].linkName);
    for (const c of cards) {
      ok(`${c.pid}: card opens its own product page`, c.href === `product.html?store=bong&product=${c.pid}`, c.href);
    }
    const kayak = cards.find((c) => c.pid === 'p4');
    ok('rental card is linked too, with no cart button (booked on its page)', !!kayak.href && !kayak.cart, JSON.stringify(kayak));
    ok('goods cards have the cart button', cards.filter((c) => c.pid !== 'p4').every((c) => c.cart));
    ok('no control nested inside a link', await page.evaluate(() =>
      document.querySelectorAll('#product-list a button, #product-list a select, #product-list a input, #product-list a textarea').length) === 0);
    ok('the old store-only controls are gone (dropdown, quantity, inline booking)', await page.evaluate(() =>
      document.querySelectorAll('#product-list .variety-select, #product-list .qty-input, #product-list .request-booking-btn, #product-list .product-gallery-thumb').length) === 0);

    // The cart button adds and does NOT navigate - the stretched link must not swallow it.
    await page.click('.product-card[data-product-id="p2"] .card-cart-btn');
    await page.waitForTimeout(400);
    const cart = await page.evaluate(() => ({
      url: location.pathname,
      stored: JSON.parse(localStorage.getItem('skiri_cart_bong') || '[]').length
    }));
    ok('cart button adds and does NOT navigate', cart.stored === 1 && /store\.html$/.test(cart.url), JSON.stringify(cart));
    await ctx.close();
  }

  // ---------- tapping the photo goes to that product ----------
  {
    const { ctx, page } = await openStore(browser, 'store.html?store=bong');
    // force: the stretched link sits over the photo on purpose, which Playwright reports as "intercepting".
    await page.click('.product-card[data-product-id="p2"] .product-image', { force: true });
    await page.waitForTimeout(700);
    const url = page.url();
    ok('tapping a photo lands on that product page', /product\.html\?store=bong&product=p2$/.test(url), url);
    ok('same tab - one page in this context', ctx.pages().length === 1, String(ctx.pages().length));
    await ctx.close();
  }

  // ---------- tapping the text line goes there too ----------
  {
    const { ctx, page } = await openStore(browser, 'store.html?store=bong');
    await page.click('.product-card[data-product-id="p4"] .product-card-link');
    await page.waitForTimeout(700);
    ok('tapping a rental card lands on that product page', /product\.html\?store=bong&product=p4$/.test(page.url()), page.url());
    await ctx.close();
  }

  // ---------- product.html must NOT link its own card to itself ----------
  {
    const { ctx, page } = await openStore(browser, 'product.html?store=bong&product=p1');
    const detail = await page.evaluate(() => {
      const c = document.querySelector('#product-detail .product-card');
      return {
        links: c.querySelectorAll('.product-card-link').length,
        hasSelect: !!c.querySelector('.variety-select'),
        hasAdd: !!c.querySelector('.add-to-cart-btn'),
        name: c.querySelector('.product-name').textContent.trim()
      };
    });
    ok('product page card has NO self-link', detail.links === 0, JSON.stringify(detail));
    ok('product page card still shows the name', detail.name === 'Rice 10kg', detail.name);
    ok('product page card still buyable', detail.hasSelect && detail.hasAdd, JSON.stringify(detail));
    await ctx.close();
  }

  await browser.close();

  let f = 0;
  console.log('\n--- Store cards link to their product page ---');
  for (const [st, n, e] of R) { if (st === 'FAIL') f++; console.log(`${st}  ${n}${e ? '  [' + e + ']' : ''}`); }
  console.log(`\n${R.length - f}/${R.length} passed`);
  process.exit(f ? 1 : 0);
})();
