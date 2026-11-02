/**
 * Cart, checkout, order received and the order sign-in open with the store's
 * cover on phones and tablets, like the store page but without its buttons
 * (owner request, 2 Nov 2026). In the browser on the REAL backend: the cover
 * photo or store colour, the round logo, the name with the verified tick, the
 * ⋮ menu on the cover, no red header, no bottom bar; the back arrow one step
 * back (cart -> store, checkout -> cart, order received -> store, sign-in ->
 * cart). Computers keep the red header.
 */
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const { makeBox } = require('./lib/gas-harness.js');
const BASE = process.env.TX_BASE || 'http://127.0.0.1:8099';
const SHOTS = process.env.CS_SHOTS || '';
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e === undefined ? '' : JSON.stringify(e).slice(0, 400)]);
const FUT = new Date(Date.now() + 30 * 86400000).toISOString();
const IMG = 'https://res.cloudinary.com/demo/image/upload/';

const box = makeBox({
  Owners: [['OwnerId', 'StoreSlug', 'StoreName', 'Email', 'Phone', 'Status', 'Island', 'Village', 'DeliveryPickPay', 'DeliveryTruck', 'DeliveryTruckCost', 'StoreType', 'BrandColor', 'LogoUrl', 'PaymentMethods', 'Username', 'CoverUrl'],
    ['own_s', 'bong', 'Burabonita', 's@x.test', '73001111', 'active', 'South Tarawa', 'Bairiki', 'true', 'true', 5, 'retailer', '#0b3d91', IMG + 'logo.png', 'ib', 'bong', IMG + 'cover.jpg']],
  Sessions: [['Token', 'OwnerId', 'CreatedAt', 'ExpiresAt']],
  SellerBadges: [['OwnerId', 'Badges'], ['own_s', 'verified']],
  Customers: [['CustomerId', 'Name', 'Email', 'Phone', 'EmailVerified', 'CreatedAt', 'UpdatedAt'], ['cus_b', 'Tebby Mote', 'tia@x.test', '73007552', 'yes', '', '']],
  CustomerSessions: [['Token', 'CustomerId', 'CreatedAt', 'ExpiresAt'], ['ctok-b', 'cus_b', '', FUT]],
  Products: [['ProductId', 'OwnerId', 'StoreSlug', 'Name', 'Description', 'Category', 'ListingType', 'ImageUrl', 'Status', 'SortOrder', 'CreatedAt', 'UpdatedAt'],
    ['p_rice', 'own_s', 'bong', 'Rice', '10kg bag', 'home', 'product', IMG + 'rice.jpg', 'active', 0, '', '']],
  Variants: [['VariantId', 'ProductId', 'OwnerId', 'Label', 'Price', 'SKU', 'StockQty', 'Status'], ['v_rice', 'p_rice', 'own_s', '10kg', 20, '', 1000, 'active']],
  Orders: [['OrderId', 'OwnerId', 'StoreSlug', 'CustomerName', 'CustomerPhone', 'CustomerEmail', 'Island', 'Village', 'DeliveryAddress',
    'DeliveryMethod', 'DeliveryCost', 'Notes', 'PaymentMethod', 'PaymentReference', 'ItemsJson', 'ItemsSummary', 'Subtotal', 'Total', 'Status', 'CreatedAt', 'UpdatedAt']],
  AbandonedCarts: [['CartId', 'StoreSlug', 'Email', 'ConvertedOrderId']]
}, { guest: true });
box.__props.SITE_BASE_URL = 'https://mwakete.com';
box.ContentService = { createTextOutput: (s) => ({ s, setMimeType() { return this; } }), MimeType: { JSON: 'json' } };
const clear = () => Object.keys(box.__cache || {}).forEach((k) => delete box.__cache[k]);
const call = (b) => { clear(); try { return box.doPost({ postData: { contents: b } }).s; } catch (e) { return JSON.stringify({ ok: false, error: String(e.message || e) }); } };
const callGet = (url) => { clear(); const u = new URL(url); const p = {}; u.searchParams.forEach((v, k) => { p[k] = v; });
  try { return box.doGet({ parameter: p }).s; } catch (e) { return JSON.stringify({ ok: false, error: String(e.message || e) }); } };

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const errors = [];
  const open = async (w, signedIn) => {
    const ctx = await browser.newContext({ viewport: { width: w, height: 844 }, serviceWorkers: 'block' });
    await ctx.addInitScript((s) => {
      localStorage.setItem('skiri_cookie_consent', 'true');
      localStorage.setItem('skiri_active_store', 'bong');
      if (!localStorage.getItem('skiri_cart_bong')) localStorage.setItem('skiri_cart_bong', JSON.stringify([{ variantId: 'v_rice', productId: 'p_rice', label: 'Rice', unitPrice: 20, qty: 2 }]));
      if (s) { localStorage.setItem('skiri_customer_token', 'ctok-b'); localStorage.setItem('skiri_customer_profile', JSON.stringify({ name: 'Tebby Mote', email: 'tia@x.test' })); }
    }, !!signedIn);
    await ctx.route('**/macros/s/**', (route) => { const req = route.request(); const b = req.postData(); route.fulfill({ status: 200, contentType: 'application/json', body: b ? call(b) : callGet(req.url()) }); });
    // Google's sign-in button runs its own script from accounts.google.com (it
    // currently throws "gis is not defined" inside its frame); not ours to test.
    await ctx.route('https://accounts.google.com/**', (route) => route.abort());
    await ctx.route('https://res.cloudinary.com/**', (route) => route.fulfill({ status: 200, contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="#6a61b8"/><circle cx="200" cy="150" r="80" fill="#fcd116"/></svg>' }));
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(w + ' ' + String(e)));
    return { ctx, p };
  };
  const look = (p) => p.evaluate(() => {
    const vis = (el) => !!el && getComputedStyle(el).display !== 'none' && el.getClientRects().length > 0;
    const r = (el) => { const b = el.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, left: b.left, w: b.width, h: b.height }; };
    const h1 = Array.from(document.querySelectorAll('main h1')).find(vis);
    return {
      cover: vis(document.getElementById('sp-cover')) ? r(document.getElementById('sp-cover')) : null,
      avatar: vis(document.getElementById('sp-avatar')) ? r(document.getElementById('sp-avatar')) : null,
      coverImg: (() => { const i = document.getElementById('sp-cover-img'); return i && !i.hidden && /cover\.jpg/.test(i.src); })(),
      logo: (() => { const i = document.getElementById('sp-avatar-img'); return i && !i.hidden && /logo\.png/.test(i.src); })(),
      name: (document.getElementById('sp-cover-name') || {}).textContent || '',
      tick: !!document.getElementById('sp-verified') && !document.getElementById('sp-verified').hidden,
      header: getComputedStyle(document.querySelector('header.site-header')).display,
      menuOnCover: !!document.querySelector('#sp-cover .header-menu-btn'),
      buttons: !!document.querySelector('.sp-actions, .sp-act, .sp-tabs'),
      bottomNav: !!document.querySelector('.bottom-nav'),
      back: (document.getElementById('sp-back') || {}).getAttribute ? document.getElementById('sp-back').getAttribute('href') : null,
      title: h1 ? h1.textContent.trim() : '', titleTop: h1 ? h1.getBoundingClientRect().top : 0,
      over: document.documentElement.scrollWidth - innerWidth
    };
  });
  const coverChecks = (tag, g, back, title) => {
    ok(`${tag}: no red header; the store's cover photo and round logo instead`, g.header === 'none' && g.cover && g.coverImg && g.logo && g.avatar.top < g.cover.bottom && g.avatar.top + g.avatar.h > g.cover.bottom, g);
    ok(`${tag}: store name with the verified tick on the cover`, g.name === 'Burabonita' && g.tick, g);
    ok(`${tag}: no Products / Photos / Info / Share buttons, no bottom bar`, !g.buttons && !g.bottomNav, g);
    ok(`${tag}: the back arrow goes one step back (${back})`, g.back === back, g.back);
    ok(`${tag}: the page title "${title}" comes under the logo`, g.title === title && g.titleTop > g.avatar.top + g.avatar.h - 4, g);
    ok(`${tag}: no sideways scrolling`, g.over <= 1, g.over);
  };

  /* ---------- cart ---------- */
  let { ctx, p } = await open(390, true);
  await p.goto(BASE + '/cart.html', { waitUntil: 'load' });
  await p.waitForFunction(() => document.getElementById('sp-cover-name').textContent === 'Burabonita', null, { timeout: 15000 });
  await p.waitForTimeout(300);
  let g = await look(p);
  coverChecks('cart', g, 'store.html?store=bong', 'Your Order');
  ok('cart: the ⋮ menu is on the cover', g.menuOnCover, g);
  if (SHOTS) await p.screenshot({ path: SHOTS + '/flow-cart.png' });
  await p.click('.header-menu-btn');
  await p.waitForTimeout(150);
  ok('cart: the ⋮ menu opens and its items can be tapped', await p.evaluate(() => {
    const first = Array.from(document.querySelectorAll('#header-menu-panel .header-menu-item')).find((e) => e.getClientRects().length > 0);
    if (!first) return false; const r = first.getBoundingClientRect(); const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !!(el && first.contains(el)); }));
  await ctx.close();

  /* ---------- checkout -> order received ---------- */
  ({ ctx, p } = await open(390, true));
  await p.goto(BASE + '/checkout.html', { waitUntil: 'load' });
  await p.waitForFunction(() => document.getElementById('sp-cover-name').textContent === 'Burabonita', null, { timeout: 15000 });
  await p.waitForTimeout(300);
  g = await look(p);
  coverChecks('checkout', g, 'cart.html', 'Checkout');
  if (SHOTS) await p.screenshot({ path: SHOTS + '/flow-checkout.png' });
  await p.selectOption('#checkout-island', 'South Tarawa');
  await p.evaluate(() => { const vs = document.getElementById('checkout-village'); for (const o of vs.options) { if (o.value && o.value !== 'Other (please specify)') { vs.value = o.value; vs.dispatchEvent(new Event('change', { bubbles: true })); break; } } });
  await p.waitForSelector('input[name="deliveryMethod"]');
  await p.fill('#customer-name', 'Tebby Mote');
  await p.fill('#customer-phone', '73007552');
  await p.click('#place-order-btn');
  await p.waitForFunction(() => !document.getElementById('confirmation-section').classList.contains('hidden'), null, { timeout: 15000 });
  await p.evaluate(() => window.scrollTo(0, 0));
  await p.waitForTimeout(300);
  g = await look(p);
  coverChecks('order received', g, 'store.html?store=bong', 'Order Received');
  if (SHOTS) await p.screenshot({ path: SHOTS + '/flow-received.png' });
  await ctx.close();

  /* ---------- sign-in to order ---------- */
  ({ ctx, p } = await open(390, false));
  await p.goto(BASE + '/checkout.html', { waitUntil: 'load' });
  await p.waitForURL(/customer-login\.html/, { timeout: 15000 });
  await p.waitForFunction(() => document.getElementById('sp-cover-name').textContent === 'Burabonita', null, { timeout: 15000 });
  await p.waitForTimeout(300);
  g = await look(p);
  ok('sign-in to order: the store\'s cover and logo on top, no red header', g.header === 'none' && g.cover && g.coverImg && g.logo && g.name === 'Burabonita', g);
  ok('...the back arrow goes back to the cart', g.back === 'cart.html', g.back);
  const form = await p.evaluate(() => ({ bg: getComputedStyle(document.querySelector('main.auth-page')).backgroundImage, google: !!document.querySelector('.auth-card') && getComputedStyle(document.querySelector('.auth-card')).display !== 'none' }));
  ok('...the sign-in form below it on white (not the purple screen)', form.bg === 'none' && form.google, form);
  ok('...no sideways scrolling', g.over <= 1, g.over);
  const em = await p.evaluate(() => { const b = document.getElementById('email-continue'); const c = getComputedStyle(b);
    return { color: c.color, panel: getComputedStyle(document.querySelector('.auth-split-panel')).display }; });
  ok('..."Continue with email" is dark text on the white form (readable), and the purple Mwakete panel is not shown', em.color === 'rgb(51, 45, 99)' && em.panel === 'none', em);
  if (SHOTS) await p.screenshot({ path: SHOTS + '/flow-signin.png' });
  await ctx.close();
  ({ ctx, p } = await open(390, false));
  await p.goto(BASE + '/customer-login.html', { waitUntil: 'load' });
  await p.waitForTimeout(600);
  ok('the ordinary sign-in screen is unchanged (purple, no store cover)', await p.evaluate(() => !document.documentElement.classList.contains('auth-for-store') && getComputedStyle(document.getElementById('store-profile')).display === 'none'
    && getComputedStyle(document.querySelector('main.auth-page')).backgroundImage !== 'none'));
  await ctx.close();

  /* ---------- tablet, computer ---------- */
  ({ ctx, p } = await open(820, true));
  await p.goto(BASE + '/cart.html', { waitUntil: 'load' });
  await p.waitForFunction(() => document.getElementById('sp-cover-name').textContent === 'Burabonita', null, { timeout: 15000 });
  await p.waitForTimeout(300);
  g = await look(p);
  ok('tablet cart: the same cover, with Home, cart and ⋮ on it', g.header === 'none' && g.cover && g.cover.h >= 200 && g.menuOnCover && await p.evaluate(() => getComputedStyle(document.querySelector('.sp-home')).display !== 'none'), g);
  if (SHOTS) await p.screenshot({ path: SHOTS + '/flow-cart-tablet.png' });
  await ctx.close();
  for (const pg of ['cart.html', 'checkout.html']) {
    ({ ctx, p } = await open(1280, true));
    await p.goto(BASE + '/' + pg, { waitUntil: 'load' });
    await p.waitForTimeout(1500);
    g = await look(p);
    ok(`computer ${pg}: unchanged - red header, no cover`, g.header !== 'none' && !g.cover, g);
    await ctx.close();
  }

  ok('no page errors', errors.length === 0, errors);
  await browser.close();
  R.forEach((x) => console.log(x[0] + '  ' + x[1] + (x[0] === 'FAIL' && x[2] ? '  [' + x[2] + ']' : '')));
  const f = R.filter((x) => x[0] === 'FAIL').length;
  console.log(`\n${R.length - f}/${R.length} passed`);
  process.exit(f ? 1 : 0);
})().catch((e) => { console.error(e); R.forEach((x) => console.log(x[0] + '  ' + x[1] + (x[0] === 'FAIL' && x[2] ? '  [' + x[2] + ']' : ''))); process.exit(1); });
