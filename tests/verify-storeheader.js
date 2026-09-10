// The store header carries no shipping note.
//
// The sentence "Shipping fee and delivery date to be negotiated" was taking
// four lines of the red header on a phone, before a shopper saw a single
// product. It is gone from there.
//
// The half that matters is what SURVIVES: the same sentence still has to reach
// a shopper on the product page and at checkout, which is where they are
// actually deciding to pay. Removing it from a header is tidying; removing it
// from a checkout would be hiding a cost.
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = 'http://127.0.0.1:8099';
const PHRASE = /Shipping fee and delivery date to be negotiated/i;

// Truck offered with NO cost set = negotiated.
const NEG = { storeDeliveryTruck: true, storeDeliveryTruckCost: null };
const P = [{ productId: 'p1', name: 'Rice', description: 'x', category: 'food',
  listingType: 'product', imageUrls: [], storeSlug: 'a', storeName: 'Tekataake',
  variants: [{ variantId: 'v1', label: '1kg', price: 8 }], ...NEG }];

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e || '']);

  async function open(path, seed) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await ctx.route('**/macros/s/**', (r) => {
      let body = {};
      try { body = r.request().postDataJSON() || {}; } catch (e) {}
      let a = body.action;
      try { if (!a) a = new URL(r.request().url()).searchParams.get('action') || ''; } catch (e) {}
      let res = { ok: true, products: [], stores: [] };
      if (a === 'listProducts') {
        res = { ok: true, storeName: 'Tekataake', storeSlug: 'a', storeOpen: true,
          storePhone: '73011111', storeIsland: 'Abaiang', products: P, ...NEG };
      } else if (a === 'getStorePublicInfo') {
        res = { ok: true, store: { storeName: 'Tekataake', storeSlug: 'a', phone: '73011111',
          island: 'Abaiang', village: 'x', isOpen: true, deliveryTruck: true,
          deliveryTruckCost: null, deliveryPickPay: true } };
      } else if (a === 'listProductReviews') res = { ok: true, reviews: [], average: 0, count: 0 };
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(res) });
    });
    const pg = await ctx.newPage();
    if (seed) await pg.addInitScript(seed);
    await pg.goto(BASE + path, { waitUntil: 'load' });
    await pg.waitForTimeout(800);
    return { ctx, pg };
  }

  // ---------------- the store page ----------------
  {
    const { ctx, pg } = await open('/store.html?store=a');
    const g = await pg.evaluate(() => {
      const header = document.querySelector('header.site-header');
      return {
        noteEl: !!document.getElementById('store-shipping-note'),
        headerText: header.textContent.replace(/\s+/g, ' ').trim(),
        headerH: Math.round(header.getBoundingClientRect().height),
        pageText: document.body.textContent.replace(/\s+/g, ' '),
        phone: (document.getElementById('store-phone-line') || {}).textContent,
        icons: document.querySelectorAll('#store-delivery-icons svg').length,
        name: (document.getElementById('store-name-tagline') || {}).textContent
      };
    });

    ok('the note element is gone from the store header', g.noteEl === false, String(g.noteEl));
    ok('the sentence appears nowhere on the store page', !PHRASE.test(g.pageText),
      (g.pageText.match(PHRASE) || [''])[0]);

    // Everything else in that header must survive.
    ok('the store name is still in the header', /Tekataake/.test(g.headerText), g.headerText);
    ok('the phone is still there', /73011111/.test(g.headerText), String(g.phone));
    ok('the delivery icons are still there', g.icons > 0, String(g.icons));
    ok('the header is shorter than a phone screen now', g.headerH < 300, String(g.headerH));
    await ctx.close();
  }

  // ---------------- the product page KEEPS it ----------------
  {
    const { ctx, pg } = await open('/product.html?store=a&product=p1');
    const g = await pg.evaluate(() => {
      const el = document.getElementById('product-shipping-note');
      return { exists: !!el, hidden: el ? el.hidden : null,
               text: el ? el.textContent.trim() : null };
    });
    ok('THE ONE THAT MATTERS: the product page still shows the note',
      g.exists === true && g.hidden === false && PHRASE.test(g.text || ''), JSON.stringify(g));
    ok('and it still points the shopper at chat',
      /chat with this store/i.test(g.text || ''), String(g.text));
    await ctx.close();
  }

  // ---------------- checkout KEEPS its own ----------------
  {
    const { ctx, pg } = await open('/checkout.html', () => {
      if (window.__s) return; window.__s = 1;
      try {
        localStorage.setItem('skiri_active_store', 'a');
        localStorage.setItem('skiri_cart_a', JSON.stringify(
          [{ variantId: 'v1', productId: 'p1', label: 'Rice', unitPrice: 8, qty: 1 }]));
      } catch (e) {}
    });
    await pg.selectOption('#checkout-island', 'Abaiang').catch(() => {});
    await pg.waitForTimeout(500);
    const g = await pg.evaluate(() => {
      const n = document.getElementById('delivery-negotiated-note');
      return { exists: !!n, text: n ? n.textContent.trim() : null,
               hidden: n ? n.classList.contains('hidden') : null };
    });
    ok('checkout still has its own negotiated-fee note element', g.exists === true, JSON.stringify(g));
    await ctx.close();
  }

  // ---------------- the shared helper is untouched ----------------
  {
    const fs = require('fs');
    const helpers = fs.readFileSync('/home/user/simple-kiri-shop/assets/js/helpers.js', 'utf8');
    const store = fs.readFileSync('/home/user/simple-kiri-shop/assets/js/store.js', 'utf8');
    const product = fs.readFileSync('/home/user/simple-kiri-shop/assets/js/product-page.js', 'utf8');
    ok('renderShippingNote still exists - the product page needs it',
      /function renderShippingNote/.test(helpers));
    ok('store.js no longer calls it', !/renderShippingNote/.test(store));
    ok('product-page.js still does', /renderShippingNote\('product-shipping-note'/.test(product));
  }

  await browser.close();
  console.log('\n--- Store header shipping note ---');
  let f = 0;
  for (const [s, n, e] of R) { if (s === 'FAIL') f++; console.log(`${s}  ${n}${e ? '  [' + e + ']' : ''}`); }
  console.log(`\n${R.length - f}/${R.length} passed`);
  process.exit(f ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
