// Call / WhatsApp / Messenger after a booking request and after an order,
// driven through the real pages.
//
// The screenshot that started this showed a rental sitting on "Requested" with
// no way to reach the seller at all, so the assertions that matter most are on
// product.html - the page that had no contact block whatsoever.
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = 'http://127.0.0.1:8099';

const PRODUCTS = [
  {
    productId: 'p-rental', name: 'Toyota Hilux', description: 'Daily hire',
    category: 'vehicles', listingType: 'rental', imageUrls: [],
    variants: [{ variantId: 'v1', label: 'Per day', price: 120 }]
  }
];

function storeResponse(over) {
  return Object.assign({
    ok: true, storeName: 'Bong Rentals', storeSlug: 'bong', storeOpen: true,
    storePhone: '73007552', storeMessenger: 'bongrentals', storeWhatsapp: '',
    storeIsland: 'South Tarawa', storeVillage: 'Betio', products: PRODUCTS
  }, over || {});
}

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const results = [];
  const ok = (n, c, e) => results.push([c ? 'PASS' : 'FAIL', n, e || '']);

  async function makeCtx(overrides) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await ctx.route('**/macros/s/**', (route) => {
      let action = '';
      try { action = (route.request().postDataJSON() || {}).action; } catch (e) {}
      try { if (!action) action = new URL(route.request().url()).searchParams.get('action') || ''; } catch (e) {}
      let body = { ok: true };
      if (action === 'listProducts') body = storeResponse(overrides);
      else if (action === 'getStorePublicInfo') {
        body = { ok: true, store: Object.assign({
          storeName: 'Bong Rentals', storeSlug: 'bong', phone: '73007552',
          messenger: 'bongrentals', whatsapp: '', island: 'South Tarawa',
          village: 'Betio', deliveryPickPay: true, isOpen: true
        }, overrides && overrides.store) };
      } else if (action === 'createBookingRequest') body = { ok: true, bookingId: 'BK-1' };
      else if (action === 'createOrder') {
        body = { ok: true, orderId: 'SKS-bong-1', total: 10, deliveryCost: 0,
          items: [{ label: 'Rice — 1kg', unitPrice: 5, qty: 2 }] };
      } else if (action === 'getProductRating') body = { ok: true, average: 0, count: 0 };
      else if (action === 'listReviews') body = { ok: true, reviews: [] };
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });
    return ctx;
  }

  // ---------- product.html: the page from the screenshot ----------
  {
    const ctx = await makeCtx();
    const page = await ctx.newPage();
    await page.goto(`${BASE}/product.html?store=bong&product=p-rental`, { waitUntil: 'load' });
    await page.waitForSelector('.request-booking-btn', { timeout: 6000 });

    const before = await page.evaluate(() => {
      const el = document.getElementById('booking-contact-p-rental');
      return { exists: !!el, hidden: el ? el.classList.contains('hidden') : null };
    });
    ok('product page: contact block is hidden before a request is sent',
      before.exists && before.hidden === true, JSON.stringify(before));

    const today = new Date();
    const iso = (d) => d.toISOString().slice(0, 10);
    await page.fill('#name-p-rental', 'Debby');
    await page.fill('#phone-p-rental', '73011111');
    await page.fill('#start-p-rental', iso(new Date(today.getTime() + 86400000)));
    await page.fill('#end-p-rental', iso(new Date(today.getTime() + 3 * 86400000)));
    await page.click('.request-booking-btn');
    await page.waitForFunction(
      () => document.querySelector('.request-booking-btn').textContent.trim() === 'Requested',
      null, { timeout: 6000 });

    const after = await page.evaluate(() => {
      const el = document.getElementById('booking-contact-p-rental');
      const btns = [...el.querySelectorAll('.btn')];
      return {
        hidden: el.classList.contains('hidden'),
        count: btns.length,
        labels: btns.map((b) => b.textContent.trim()),
        hrefs: btns.map((b) => b.getAttribute('href')),
        widths: btns.map((b) => Math.round(b.getBoundingClientRect().width)),
        right: Math.max(...btns.map((b) => b.getBoundingClientRect().right)),
        docWidth: document.documentElement.clientWidth
      };
    });
    ok('product page: three contact buttons appear after the request is sent',
      after.hidden === false && after.count === 3, JSON.stringify(after));
    ok('product page: they are Call, WhatsApp and Messenger',
      JSON.stringify(after.labels) === JSON.stringify(['Call', 'WhatsApp', 'Messenger']),
      JSON.stringify(after.labels));
    ok('product page: Call dials the store phone', after.hrefs[0] === 'tel:73007552', after.hrefs[0]);
    ok('product page: WhatsApp falls back to the phone, with the 686 country code',
      after.hrefs[1] === 'https://wa.me/68673007552', after.hrefs[1]);
    ok('product page: Messenger goes to m.me', after.hrefs[2] === 'https://m.me/bongrentals', after.hrefs[2]);
    ok('product page: all three fit on a 390px screen without overflowing',
      after.right <= after.docWidth + 1 && after.widths.every((w) => w > 60),
      JSON.stringify({ right: after.right, doc: after.docWidth, widths: after.widths }));

    // Also prove the booking still actually happened - the contact block must be
    // an addition to the request, never a replacement for it.
    ok('product page: the request itself still succeeded',
      (await page.textContent('#booking-status-p-rental')).includes('Booking request sent'));
    await ctx.close();
  }

  // ---------- a seller with no Messenger ----------
  {
    const ctx = await makeCtx({ storeMessenger: '' });
    const page = await ctx.newPage();
    const popups = [];
    await page.goto(`${BASE}/product.html?store=bong&product=p-rental`, { waitUntil: 'load' });
    await page.waitForSelector('.request-booking-btn', { timeout: 6000 });
    const iso = (d) => d.toISOString().slice(0, 10);
    const t = Date.now();
    await page.fill('#name-p-rental', 'Debby');
    await page.fill('#phone-p-rental', '73011111');
    await page.fill('#start-p-rental', iso(new Date(t + 86400000)));
    await page.fill('#end-p-rental', iso(new Date(t + 3 * 86400000)));
    await page.click('.request-booking-btn');
    await page.waitForSelector('#booking-contact-p-rental:not(.hidden)', { timeout: 6000 });

    const shape = await page.evaluate(() => {
      const el = document.getElementById('booking-contact-p-rental');
      const msgr = el.querySelector('[data-no-contact="messenger"]');
      return {
        count: el.querySelectorAll('.btn').length,
        msgrExists: !!msgr,
        msgrTag: msgr ? msgr.tagName : '',
        msgrHref: msgr ? msgr.getAttribute('href') : null,
        visible: msgr ? getComputedStyle(msgr).display !== 'none' : false,
        dashed: msgr ? getComputedStyle(msgr).borderTopStyle : ''
      };
    });
    ok('missing Messenger still renders a button rather than vanishing',
      shape.count === 3 && shape.msgrExists && shape.msgrTag === 'BUTTON' && shape.visible,
      JSON.stringify(shape));
    ok('the unavailable button has no href to follow', shape.msgrHref === null, String(shape.msgrHref));
    ok('the unavailable button is visually muted (dashed border)', shape.dashed === 'dashed', shape.dashed);

    await page.click('[data-no-contact="messenger"]');
    await page.waitForSelector('#order-sent-popup.is-visible', { timeout: 3000 });
    const popup = await page.evaluate(() => {
      const o = document.getElementById('order-sent-popup');
      const check = o.querySelector('.order-sent-check');
      return {
        text: o.querySelector('.order-sent-text').textContent,
        checkShown: getComputedStyle(check).display !== 'none',
        plain: o.classList.contains('order-sent-popup--plain')
      };
    });
    ok('tapping it says the seller has no Messenger, in Kiribati and English',
      popup.text === 'Akea ana Messenger te seller aio — this seller has no Messenger.', popup.text);
    ok('the popup shows no green tick - this is not a success message',
      popup.plain && !popup.checkShown, JSON.stringify(popup));

    // The click must not navigate away from the confirmed booking.
    ok('tapping an unavailable contact does not leave the page',
      page.url().includes('product.html?store=bong'), page.url());

    // waitForSelector would wait for VISIBILITY, and this element is hidden by
    // the class going away - it never becomes visible, so the class is checked.
    const dismissed = await page.waitForFunction(
      () => !document.getElementById('order-sent-popup').classList.contains('is-visible'),
      null, { timeout: 6000 }).then(() => true).catch(() => false);
    ok('the popup dismisses itself', dismissed);
    await ctx.close();
  }

  // ---------- store.html ----------
  {
    const ctx = await makeCtx();
    const page = await ctx.newPage();
    await page.goto(`${BASE}/store.html?store=bong`, { waitUntil: 'load' });
    await page.waitForSelector('.request-booking-btn', { timeout: 6000 });
    const iso = (d) => d.toISOString().slice(0, 10);
    const t = Date.now();
    await page.fill('#name-p-rental', 'Debby');
    await page.fill('#phone-p-rental', '73011111');
    await page.fill('#start-p-rental', iso(new Date(t + 86400000)));
    await page.fill('#end-p-rental', iso(new Date(t + 3 * 86400000)));
    await page.click('.request-booking-btn');
    await page.waitForSelector('#booking-contact-p-rental:not(.hidden)', { timeout: 6000 });
    const labels = await page.$$eval('#booking-contact-p-rental .btn', (b) => b.map((x) => x.textContent.trim()));
    ok('store page: the same three buttons, not the old two',
      JSON.stringify(labels) === JSON.stringify(['Call', 'WhatsApp', 'Messenger']), JSON.stringify(labels));
    await ctx.close();
  }

  // ---------- checkout confirmation ----------
  {
    const ctx = await makeCtx({ store: { whatsapp: '63099999' } });
    const page = await ctx.newPage();
    await page.addInitScript(() => {
      if (window.__seeded) return;
      window.__seeded = true;
      try {
        localStorage.setItem('skiri_active_store', 'bong');
        localStorage.setItem('skiri_cart_bong', JSON.stringify(
          [{ variantId: 'v1', productId: 'p1', label: 'Rice — 1kg', unitPrice: 5, qty: 2 }]));
      } catch (e) {}
    });
    await page.goto(BASE + '/checkout.html', { waitUntil: 'load' });
    await page.waitForFunction(() => document.getElementById('store-name-tagline').textContent.includes('Bong'),
      null, { timeout: 6000 });

    await page.evaluate(() => showConfirmation(
      { orderId: 'SKS-bong-1', total: 10, deliveryCost: 0, items: [{ label: 'Rice — 1kg', unitPrice: 5, qty: 2 }] },
      { customerName: 'Debby', customerPhone: '73011111', island: 'South Tarawa',
        village: 'Betio', deliveryMethod: 'pickPay', notes: '' }));
    await page.waitForSelector('#confirmation-section:not(.hidden)');

    const conf = await page.evaluate(() => {
      const btns = [...document.querySelectorAll('#order-contact .btn')];
      return {
        count: btns.length,
        labels: btns.map((b) => b.textContent.trim()),
        hrefs: btns.map((b) => b.getAttribute('href')),
        summary: (document.getElementById('order-summary-text') || {}).value || ''
      };
    });
    ok('checkout: three contact buttons under the order confirmation', conf.count === 3, JSON.stringify(conf));
    ok('checkout: Call dials the store phone', conf.hrefs[0] === 'tel:73007552', conf.hrefs[0]);
    ok('checkout: a seller-set WhatsApp number is used ahead of the contact phone',
      conf.hrefs[1] === 'https://wa.me/68663099999', conf.hrefs[1]);
    ok('checkout: the order summary still renders', conf.summary.includes('SKS-bong-1'), conf.summary.slice(0, 60));

    // The fallback path is the one that matters most: the order never reached
    // the backend, so reaching the seller by hand is all the customer has.
    const fb = await page.evaluate(() => {
      document.getElementById('order-contact').innerHTML = '';
      showFallbackConfirmation(
        { customerName: 'Debby', customerPhone: '73011111', island: 'South Tarawa',
          village: 'Betio', deliveryMethod: 'pickPay', notes: '' },
        [{ label: 'Rice — 1kg', unitPrice: 5, qty: 2 }]);
      return document.querySelectorAll('#order-contact .btn').length;
    });
    ok('checkout: the failed-order fallback shows the contact buttons too', fb === 3, String(fb));

    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.waitForTimeout(200);
    ok('checkout: no page error from the removed Call-only button', errors.length === 0, errors.join('; '));
    await ctx.close();
  }

  // ---------- owner settings ----------
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    let savedBody = null;
    await ctx.route('**/macros/s/**', (route) => {
      let body = {};
      try { body = route.request().postDataJSON() || {}; } catch (e) {}
      let action = body.action;
      try { if (!action) action = new URL(route.request().url()).searchParams.get('action') || ''; } catch (e) {}
      let res = { ok: true };
      if (action === 'getOwnerProfile') {
        res = { ok: true, owner: { storeName: 'Bong Rentals', email: 'a@b.com', phone: '73007552',
          messenger: 'bongrentals', whatsapp: '63099999', island: 'South Tarawa', village: 'Betio',
          logoUrl: 'https://res.cloudinary.com/demo/image/upload/logo.png', deliveryPickPay: true } };
      } else if (action === 'updateOwnerProfile') {
        savedBody = body;
        res = { ok: true, owner: { storeName: 'Bong Rentals', whatsapp: body.whatsapp } };
      }
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(res) });
    });
    const page = await ctx.newPage();
    await page.addInitScript(() => {
      if (window.__seeded) return;
      window.__seeded = true;
      try { localStorage.setItem('skiri_owner_token', 'tok-123'); } catch (e) {}
    });
    await page.goto(BASE + '/owner/settings.html', { waitUntil: 'load' });
    await page.waitForFunction(() => {
      const el = document.getElementById('contact-whatsapp');
      return el && el.value !== '';
    }, null, { timeout: 6000 }).catch(() => {});

    const loaded = await page.inputValue('#contact-whatsapp').catch(() => null);
    ok('settings: the saved WhatsApp number loads into the form', loaded === '63099999', String(loaded));

    await page.fill('#contact-whatsapp', '63012345');
    await page.click('#save-settings-btn');
    await page.waitForTimeout(1500);
    const settingsErr = await page.textContent('#settings-error').catch(() => '');
    ok('settings: the save was not blocked by validation', !settingsErr.trim(), settingsErr);
    ok('settings: saving sends the WhatsApp number to the backend',
      savedBody && savedBody.whatsapp === '63012345', JSON.stringify(savedBody && savedBody.whatsapp));
    // Phone goes as typed; Messenger is now normalized to the one stored shape
    // on every save path, so a legacy bare handle loaded into the box comes
    // back out as its m.me link. That is the change, not a regression.
    ok('settings: phone is sent unchanged, Messenger as its m.me link',
      savedBody && savedBody.phone === '73007552'
        && savedBody.messenger === 'https://m.me/bongrentals',
      JSON.stringify(savedBody));
    await ctx.close();
  }

  await browser.close();
  console.log('\n--- Seller contact buttons (pages) ---');
  let failed = 0;
  for (const [st, n, e] of results) { if (st === 'FAIL') failed++; console.log(`${st}  ${n}${e ? '  [' + e + ']' : ''}`); }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
