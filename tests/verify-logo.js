// Site logo: far left, in the flow, ahead of the nav, and a link home.
const fs = require('fs');
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = 'http://127.0.0.1:8099';
const REPO = '/home/user/simple-kiri-shop/';
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e || '']);

const WITH_LOGO = ['index.html', 'customer-dashboard.html', 'customer-login.html',
  'customer-messages.html', 'customer-tips.html'];
const WITHOUT = ['store.html?store=bong', 'search.html?q=x', 'stores.html',
  'cart.html', 'checkout.html', 'categories.html', 'my-carts.html', 'product.html?store=bong&product=p1'];

async function open(browser, path, width) {
  const ctx = await browser.newContext({ viewport: { width: width || 390, height: 800 } });
  await ctx.route('**/macros/s/**', (r) => r.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ ok: true, products: [], stores: [], tips: [], conversations: [],
      storeName: 'Bong', storeOpen: true, store: { storeName: 'Bong', storeSlug: 'bong', isOpen: true,
        deliveryTruck: true, deliveryShip: false, deliveryAirCargo: false, deliveryPickPay: true,
        deliveryTruckCost: 5, deliveryShipCost: null, deliveryAirCargoCost: null } }) }));
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    localStorage.setItem('skiri_cookie_consent', 'true');
    localStorage.setItem('skiri_active_store', 'bong');
    localStorage.setItem('skiri_cart_bong', JSON.stringify([{ variantId: 'v', productId: 'p', label: 'a', unitPrice: 1, qty: 3 }]));
  });
  await page.goto(BASE + '/' + path, { waitUntil: 'load' });
  await page.waitForTimeout(600);
  return { ctx, page };
}

const probe = (page) => page.evaluate(() => {
  const row = document.querySelector('.header-top-row') || document.querySelector('header.site-header .container');
  const logo = document.querySelector('.header-logo-link');
  const img = document.querySelector('.header-logo-mark');
  const nav = document.querySelector('.site-nav');
  const cart = document.getElementById('header-cart-link');
  const cartHidden = !cart || getComputedStyle(cart).display === 'none';
  const rect = (e) => (e ? e.getBoundingClientRect() : null);
  const L = rect(logo), N = rect(nav), C = rect(cart), W = rect(row);
  const cs = logo ? getComputedStyle(logo) : null;
  const imgCs = img ? getComputedStyle(img) : null;
  return {
    hasLogo: !!logo,
    href: logo ? logo.getAttribute('href') : null,
    label: logo ? logo.getAttribute('aria-label') : null,
    isFirstChild: !!(row && logo && row.firstElementChild === logo),
    inFlow: cs ? cs.position !== 'absolute' && cs.position !== 'fixed' : null,
    imgInFlow: imgCs ? imgCs.position !== 'absolute' && imgCs.position !== 'fixed' : null,
    // Far left WITHIN ITS ROW. Comparing against every element in the header
    // was wrong: the container and branding divs span the full width and start
    // at x=0 by definition, so that could never pass.
    leftMost: !!(L && row && [...row.children]
      .filter((e) => e !== logo && e.getBoundingClientRect().width > 0)
      .every((e) => e.getBoundingClientRect().left >= L.left - 0.5)),
    beforeNav: !!(L && N && L.right <= N.left + 1),
    navClearsCart: !!(N && C ? N.right <= C.left + 1 : true),
    cartHidden: cartHidden,
    logoLeftInset: L && W ? Math.round(L.left - W.left) : null,
    imgAlt: img ? img.getAttribute('alt') : null
  };
});

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

  for (const p of WITH_LOGO) {
    const { ctx, page } = await open(browser, p);
    const v = await probe(page);
    ok(`${p}: logo present`, v.hasLogo === true);
    ok(`${p}: logo is the first thing in the header row`, v.isFirstChild === true);
    ok(`${p}: nothing in the header sits further left`, v.leftMost === true);
    ok(`${p}: logo comes before the nav links`, v.beforeNav === true);
    ok(`${p}: logo is in the flow, not absolutely pinned`,
      v.inFlow === true && v.imgInFlow === true, `link=${v.inFlow} img=${v.imgInFlow}`);
    ok(`${p}: logo links home`, v.href === 'index.html', String(v.href));
    ok(`${p}: logo has an accessible name`, /Mwakete/.test(v.label || ''), String(v.label));
    ok(`${p}: the image itself is not announced twice`, v.imgAlt === '', JSON.stringify(v.imgAlt));
    // The header cart is display:none below 700px (the bottom bar carries Cart
    // there), so there is nothing for the nav to run under. Assert THAT rather
    // than an overlap against a zero-sized box, which would pass vacuously.
    ok(`${p}: header cart is hidden on mobile - the nav has the row to itself`,
      v.cartHidden === true, `hidden=${v.cartHidden} clears=${v.navClearsCart}`);
    await ctx.close();
  }

  // Narrow phone: still left, still clear of the cart.
  {
    const { ctx, page } = await open(browser, 'index.html', 320);
    const v = await probe(page);
    ok('320px: logo still leftmost', v.leftMost === true && v.beforeNav === true);
    ok('320px: header cart still hidden, nav unobstructed', v.cartHidden === true, String(v.cartHidden));
    await ctx.close();
  }

  // Pages that never had a logo must be untouched.
  for (const p of WITHOUT) {
    const { ctx, page } = await open(browser, p);
    const v = await probe(page);
    ok(`${p.split('?')[0]}: still has no site logo`, v.hasLogo === false);
    ok(`${p.split('?')[0]}: header cart hidden on mobile`, v.cartHidden === true, String(v.cartHidden));
    await ctx.close();
  }

  await browser.close();

  const css = fs.readFileSync(REPO + 'assets/css/styles.css', 'utf8');
  ok('the old right-corner pin is gone',
    !/\.header-logo-mark\s*\{[^}]*position:\s*absolute/.test(css));
  ok('the cart no longer dodges a logo in its corner',
    css.indexOf('header-logo-mark ~ .header-cart') === -1);
  for (const p of WITH_LOGO) {
    const html = fs.readFileSync(REPO + p, 'utf8');
    ok(`${p}: markup has the logo before the nav`,
      html.indexOf('header-logo-link') < html.indexOf('<nav class="site-nav"'));
  }

  let f = 0;
  console.log('\n--- Site logo, far left ---');
  for (const [st, n, e] of R) { if (st === 'FAIL') f++; console.log(`${st}  ${n}${e ? '  [' + e + ']' : ''}`); }
  console.log(`\n${R.length - f}/${R.length} passed`);
  process.exit(f ? 1 : 0);
})();
