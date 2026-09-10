// Renders checkout, cart and chat against the NARROWED getStorePublicInfo
// payload - produced by running the real publicStoreFields, so the fixture
// cannot drift from the shipped shape.
const fs = require('fs'), vm = require('vm');
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = 'http://127.0.0.1:8099';
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e || '']);
const AS = '/home/user/simple-kiri-shop/apps-script/';
const grab = (s, n) => s.match(new RegExp('function ' + n + '\\([\\s\\S]*?\\n}'))[0];
const auth = fs.readFileSync(AS + 'Auth.gs', 'utf8'), prod = fs.readFileSync(AS + 'Products.gs', 'utf8');
const box = { isOwnerAdmin: () => true }; vm.createContext(box);
vm.runInContext([grab(auth, 'publicStoreFields'), grab(auth, 'isStoreOpenForBusiness'),
  grab(prod, 'deliveryFlagsOf'), grab(prod, 'deliveryCostOf')].join('\n'), box);

const ROW = {
  OwnerId: 'own_1', StoreName: 'Bong Store', StoreSlug: 'bong', Email: 'boss@mwakete.com',
  Phone: '73001224', Messenger: 'm.me/bong', LogoUrl: 'https://img/logo.png',
  Island: 'South Tarawa', Village: 'Bairiki', Status: 'active', TwoFAEnabled: 'true',
  DeliveryTruck: 'true', DeliveryShip: 'true', DeliveryAirCargo: 'false', DeliveryPickPay: 'true',
  DeliveryTruckCost: 5, DeliveryShipCost: '', DeliveryAirCargoCost: null
};
const STORE = box.publicStoreFields(ROW);
const CART = [{ variantId: 'v1', productId: 'p1', label: 'Rice 1kg', unitPrice: 6, qty: 2 }];

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

  async function open(path, storeOverride) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 900 } });
    await ctx.route('**/macros/s/**', (r) => {
      let action = ''; let body = null;
      try { action = new URL(r.request().url()).searchParams.get('action') || ''; } catch (e) {}
      try { body = r.request().postDataJSON(); if (!action && body) action = body.action; } catch (e) {}
      const J = (o) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
      if (action === 'getStorePublicInfo') return J({ ok: true, store: storeOverride || STORE });
      if (action === 'getConversation') return J({ ok: true, conversation: null, messages: [], hasMoreBefore: false });
      J({ ok: true });
    });
    const pg = await ctx.newPage();
    await pg.addInitScript((cart) => {
      localStorage.setItem('skiri_cookie_consent', 'true');
      // Both pages read the slug from skiri_active_store, not the query string.
      localStorage.setItem('skiri_active_store', 'bong');
      localStorage.setItem('skiri_cart_bong', JSON.stringify(cart));
    }, CART);
    await pg.goto(BASE + path, { waitUntil: 'load' });
    await pg.waitForTimeout(450);
    return { ctx, page: pg };
  }

  const shot = (page) => page.evaluate(() => {
    const t = (id) => (document.getElementById(id) || {}).textContent || '';
    const logo = document.getElementById('store-logo-img');
    const phone = document.getElementById('store-phone-line');
    return {
      tagline: t('store-name-tagline').trim(),
      logoShown: !!logo && !logo.classList.contains('hidden'),
      logoAlt: logo ? logo.alt : '',
      phoneShown: !!phone && !phone.classList.contains('hidden'),
      phoneText: phone ? phone.textContent.trim() : '',
      iconsHtml: (document.getElementById('store-delivery-icons') || {}).innerHTML || '',
      storeOpen: window.__storeOpen
    };
  });

  /* ---- Checkout ---- */
  let { ctx, page } = await open('/checkout.html?store=bong');
  let s = await shot(page);
  ok('checkout: store name rendered', s.tagline === 'Checkout — Bong Store', s.tagline);
  ok('checkout: logo shown with alt', s.logoShown && s.logoAlt === 'Bong Store', s.logoAlt);
  ok('checkout: phone shown', s.phoneShown && s.phoneText === '73001224', s.phoneText);
  ok('checkout: delivery icons rendered', s.iconsHtml.length > 0);
  ok('checkout: truck cost $5 shown', /\$?5/.test(s.iconsHtml), s.iconsHtml.slice(0, 200));
  ok('checkout: window.__storeOpen true', s.storeOpen === true, String(s.storeOpen));
  ok('checkout: no owner email in the DOM', !(await page.content()).includes('boss@mwakete.com'));
  // island-dependent eligibility still resolves (storeInfo.island survived)
  // The id here was wrong (customer-island), so no island was ever set and this
  // passed on Pick & Pay alone - it asserted nothing about island eligibility.
  const elig = await page.evaluate(async () => {
    const before = [...document.querySelectorAll('#delivery-method-options input[type=radio]')].map((i) => i.value);
    const sel = document.getElementById('checkout-island');
    sel.value = 'South Tarawa';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 300));
    return { before, after: [...document.querySelectorAll('#delivery-method-options input[type=radio]')].map((i) => i.value) };
  });
  ok('checkout: choosing an island widens the delivery methods',
    elig.after.length > elig.before.length && elig.after.indexOf('truck') !== -1,
    `${elig.before.join(',')} -> ${elig.after.join(',')}`);
  ok('checkout: place order not blocked', await page.evaluate(() => !document.getElementById('place-order-btn').disabled));
  await ctx.close();

  /* ---- Cart page + chat header ---- */
  ({ ctx, page } = await open('/cart.html?store=bong'));
  s = await shot(page);
  ok('cart: store name rendered', s.tagline === 'Your cart — Bong Store', s.tagline);
  ok('cart: logo shown', s.logoShown);
  ok('cart: phone shown', s.phoneShown && s.phoneText === '73001224', s.phoneText);
  ok('cart: delivery icons rendered', s.iconsHtml.length > 0);
  ok('cart: no owner email in the DOM', !(await page.content()).includes('boss@mwakete.com'));
  const chat = await page.evaluate(async () => {
    const fab = document.getElementById('chat-fab');
    if (fab) fab.click();
    await new Promise((r) => setTimeout(r, 350));
    const st = document.querySelector('.chat-vendor-status');
    return {
      name: (document.getElementById('chat-window-vendor-name') || {}).textContent || '',
      avatar: !!document.querySelector('img.chat-vendor-avatar'),
      status: st ? st.textContent.trim() : '',
      isClosed: st ? st.classList.contains('is-closed') : null
    };
  });
  ok('chat: vendor name from narrowed payload', chat.name === 'Bong Store', chat.name);
  ok('chat: vendor logo rendered', chat.avatar === true);
  ok('chat: header reads Online for an active store', chat.status === 'Online', chat.status);
  ok('chat: not styled closed', chat.isClosed === false);
  await ctx.close();

  /* ---- standby store: isOpen false must still drive the Closed state ---- */
  const CLOSED = box.publicStoreFields(Object.assign({}, ROW, { Status: 'standby' }));
  ok('fixture: standby payload has isOpen false', CLOSED.isOpen === false);
  // Asserted on checkout.html, not cart.html: cart-page.js never sets
  // window.__storeOpen (only store.js, product-page.js and checkout.js do), so
  // chat on the cart page always reads Online. Pre-existing gap from PR #15,
  // out of scope for this security-only change - reported separately.
  ({ ctx, page } = await open('/checkout.html?store=bong', CLOSED));
  const closedChat = await page.evaluate(async () => {
    const fab = document.getElementById('chat-fab');
    if (fab) fab.click();
    await new Promise((r) => setTimeout(r, 350));
    const st = document.querySelector('.chat-vendor-status');
    return { status: st ? st.textContent.trim() : '', isClosed: st ? st.classList.contains('is-closed') : null,
      storeOpen: window.__storeOpen };
  });
  ok('closed: window.__storeOpen false', closedChat.storeOpen === false, String(closedChat.storeOpen));
  ok('closed: chat header reads Closed', /closed/i.test(closedChat.status), closedChat.status);
  ok('closed: styled closed', closedChat.isClosed === true);
  await ctx.close();

  /* ---- an older/narrower payload must not falsely read as Closed ---- */
  const NOFLAG = Object.assign({}, STORE); delete NOFLAG.isOpen;
  ({ ctx, page } = await open('/checkout.html?store=bong', NOFLAG));
  ok('missing isOpen still defaults to open', await page.evaluate(() => window.__storeOpen === true));
  await ctx.close();

  await browser.close();
  let f = 0;
  console.log('\n--- Narrowed public store payload: rendering ---');
  for (const [st, n, e] of R) { if (st === 'FAIL') f++; console.log(`${st}  ${n}${e ? '  [' + e + ']' : ''}`); }
  console.log(`\n${R.length - f}/${R.length} passed`);
  process.exit(f ? 1 : 0);
})();
