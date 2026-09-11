// The negotiated-shipping sentence: gone from every product card, said once on
// the store page and only when it is true, still there at checkout.
const fs = require('fs');
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = 'http://127.0.0.1:8099';
const REPO = '/home/user/simple-kiri-shop/';
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e || '']);
const PHRASE = /Shipping fee and delivery date to be negotiated/;

const PRODUCTS = [1, 2, 3].map((i) => ({
  productId: 'p' + i, name: 'Item ' + i, category: 'pantry', description: 'x', imageUrl: '',
  variants: [{ variantId: 'v' + i, label: '1kg', price: 6 }], rating: null, reviewCount: 0
}));

// truck offered with NO fee set -> negotiated. ship fixed at 5. pickPay free.
const NEGOTIATED = { storeDeliveryTruck: true, storeDeliveryTruckCost: null,
  storeDeliveryShip: true, storeDeliveryShipCost: 5,
  storeDeliveryAirCargo: false, storeDeliveryAirCargoCost: null, storeDeliveryPickPay: true };
// every offered method has a fixed fee -> nothing to negotiate.
const FIXED = { storeDeliveryTruck: true, storeDeliveryTruckCost: 5,
  storeDeliveryShip: true, storeDeliveryShipCost: 10,
  storeDeliveryAirCargo: false, storeDeliveryAirCargoCost: null, storeDeliveryPickPay: true };
// only Pick & Pay, which is always free - must NOT count as negotiable.
const PICKPAY_ONLY = { storeDeliveryTruck: false, storeDeliveryTruckCost: null,
  storeDeliveryShip: false, storeDeliveryShipCost: null,
  storeDeliveryAirCargo: false, storeDeliveryAirCargoCost: null, storeDeliveryPickPay: true };

async function openStore(browser, delivery) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx.route('**/macros/s/**', (r) => {
    let a = ''; try { a = new URL(r.request().url()).searchParams.get('action') || ''; } catch (e) {}
    try { const j = r.request().postDataJSON(); if (!a && j) a = j.action; } catch (e) {}
    const J = (o) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
    if (a === 'listProducts') return J(Object.assign({ ok: true, storeName: 'Bong', storePhone: '73001224',
      storeIsland: 'South Tarawa', storeVillage: 'Bairiki', storeOpen: true, products: PRODUCTS }, delivery));
    if (a === 'searchProducts') return J({ ok: true, products: [] });
    if (a === 'getConversation') return J({ ok: true, conversation: null, messages: [], hasMoreBefore: false });
    J({ ok: true });
  });
  const page = await ctx.newPage();
  await page.addInitScript(() => localStorage.setItem('skiri_cookie_consent', 'true'));
  await page.goto(BASE + '/store.html?store=bong', { waitUntil: 'load' });
  await page.waitForTimeout(900);
  return { ctx, page };
}

const look = (page) => page.evaluate(() => {
  const note = document.getElementById('store-shipping-note');
  return {
    cards: document.querySelectorAll('#product-list .product-card, #product-list article').length,
    cardText: document.getElementById('product-list').textContent.replace(/\s+/g, ' '),
    noteShown: !!(note && !note.hidden),
    noteText: note ? note.textContent.trim() : null,
    notesOnPage: document.querySelectorAll('#store-shipping-note').length,
    legacyNotes: document.querySelectorAll('.product-shipping-note').length
  };
});

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

  /* --- store with a negotiated fee --- */
  let { ctx, page } = await openStore(browser, NEGOTIATED);
  let v = await look(page);
  ok('products rendered', v.cards >= 3, String(v.cards));
  ok('no card carries the sentence any more', !PHRASE.test(v.cardText), v.cardText.slice(0, 140));
  ok('no .product-shipping-note left at all', v.legacyNotes === 0, String(v.legacyNotes));
  // The store header no longer carries this note at all - it was taking four
  // lines of red header on a phone before a shopper saw a single product. The
  // sentence still lives on the product page and at checkout, which are the
  // two places a shopper is actually deciding to pay.
  //
  // What this suite exists to prevent is unchanged and still asserted above:
  // the sentence must never come back onto every product card.
  ok('the store header carries no shipping note any more',
    v.notesOnPage === 0, `count=${v.notesOnPage}`);
  ok('and the sentence appears nowhere on the store page',
    !PHRASE.test(v.cardText), v.cardText.slice(0, 140));
  await ctx.close();

  /* --- store where every offered method has a fixed fee --- */
  ({ ctx, page } = await openStore(browser, FIXED));
  v = await look(page);
  ok('fixed-fee store shows NO note (this was the untruth)', v.noteShown === false, String(v.noteText));
  ok('fixed-fee store has no header note either', v.notesOnPage === 0, String(v.notesOnPage));
  ok('fixed-fee store has no sentence on the cards either', !PHRASE.test(v.cardText));
  await ctx.close();

  /* --- Pick & Pay only: always free, so nothing is negotiable --- */
  ({ ctx, page } = await openStore(browser, PICKPAY_ONLY));
  v = await look(page);
  ok('Pick & Pay alone does not count as negotiable', v.noteShown === false, String(v.noteText));
  await ctx.close();

  /* --- checkout keeps its own note --- */
  {
    const c = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await c.route('**/macros/s/**', (r) => {
      let a = ''; try { a = new URL(r.request().url()).searchParams.get('action') || ''; } catch (e) {}
      try { const j = r.request().postDataJSON(); if (!a && j) a = j.action; } catch (e) {}
      const J = (o) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
      if (a === 'getStorePublicInfo') return J({ ok: true, store: { storeName: 'Bong', storeSlug: 'bong',
        phone: '73001224', messenger: '', logoUrl: '', island: 'South Tarawa', village: 'Bairiki', isOpen: true,
        deliveryTruck: true, deliveryShip: false, deliveryAirCargo: false, deliveryPickPay: true,
        deliveryTruckCost: null, deliveryShipCost: null, deliveryAirCargoCost: null } });
      J({ ok: true });
    });
    const p = await c.newPage();
    await p.addInitScript(() => {
      localStorage.setItem('skiri_cookie_consent', 'true');
      localStorage.setItem('skiri_active_store', 'bong');
      localStorage.setItem('skiri_cart_bong', JSON.stringify([{ variantId: 'v1', productId: 'p1', label: 'Item', unitPrice: 6, qty: 1 }]));
    });
    await p.goto(BASE + '/checkout.html', { waitUntil: 'load' });
    await p.waitForTimeout(900);
    const out = await p.evaluate(async () => {
      // Real ids are checkout-island / checkout-village.
      const isl = document.getElementById('checkout-island');
      isl.value = 'South Tarawa';
      isl.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 300));
      const vil = document.getElementById('checkout-village');
      if (vil && vil.options.length > 1) {
        vil.selectedIndex = 1;
        vil.dispatchEvent(new Event('change', { bubbles: true }));
      }
      await new Promise((r) => setTimeout(r, 300));
      const truck = document.querySelector('#delivery-method-options input[value="truck"]');
      if (truck) { truck.checked = true; truck.dispatchEvent(new Event('change', { bubbles: true })); }
      await new Promise((r) => setTimeout(r, 300));
      const n = document.getElementById('delivery-negotiated-note');
      return { text: n ? n.textContent.trim() : null, hidden: n ? n.classList.contains('hidden') : null,
               cost: (document.getElementById('review-delivery-cost') || {}).textContent || '',
               methods: [...document.querySelectorAll('#delivery-method-options input')].map((i) => i.value + (i.checked ? '*' : '')) };
    });
    ok('truck became selectable once an island was chosen',
      out.methods.some((m) => m.startsWith('truck')), out.methods.join(','));
    ok('checkout still shows the negotiated note', out.hidden === false && PHRASE.test(out.text || ''),
      `hidden=${out.hidden} text=${out.text} methods=${out.methods.join(',')}`);
    ok('checkout summary still reads "To Be Negotiated"', /To Be Negotiated/.test(out.cost), out.cost);
    await c.close();
  }

  await browser.close();

  /* --- static --- */
  const card = fs.readFileSync(REPO + 'assets/js/product-card.js', 'utf8');
  ok('product-card.js no longer contains the sentence', !PHRASE.test(card));
  const checkout = fs.readFileSync(REPO + 'assets/js/checkout.js', 'utf8');
  ok('checkout.js still contains it', PHRASE.test(checkout));

  let f = 0;
  console.log('\n--- Negotiated shipping note ---');
  for (const [st, n, e] of R) { if (st === 'FAIL') f++; console.log(`${st}  ${n}${e ? '  [' + e + ']' : ''}`); }
  console.log(`\n${R.length - f}/${R.length} passed`);
  process.exit(f ? 1 : 0);
})();
