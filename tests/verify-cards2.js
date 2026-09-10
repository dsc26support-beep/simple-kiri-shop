const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = 'http://127.0.0.1:8099';
const SHIP = 'Shipping fee and delivery date to be negotiated. Chat with store for more details.';

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 800 } });
  await ctx.route('**/macros/s/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, storeName: 'Bong', products: [] }) }));
  const page = await ctx.newPage();
  await page.goto(BASE + '/store.html?store=bong', { waitUntil: 'load' });
  await page.waitForFunction(() => typeof renderProductCard === 'function' && typeof renderBrowseProductCard === 'function', null, { timeout: 5000 });

  const out = await page.evaluate((SHIP) => {
    const goods = { productId: 'g1', name: 'Rice', category: 'pantry', storeSlug: 'bong', storeName: 'Bong', storePhone: '73001224',
      variants: [{ variantId: 'v1', label: '1kg', price: 6 }], storeDeliveryTruck: true, storeDeliveryPickPay: true, storeDeliveryTruckCost: 5 };
    const rental = { productId: 'r1', name: 'Kayak', category: 'rentals', storeSlug: 'bong', storeName: 'Bong', storePhone: '73001224',
      variants: [{ variantId: 'v2', label: 'per day', price: 20 }], storeDeliveryTruck: true, storeDeliveryPickPay: true, storeDeliveryTruckCost: 5, available: true };

    const goodsCard = renderProductCard(goods);
    const rentalCard = renderProductCard(rental);
    const goodsBrowse = renderBrowseProductCard(goods);
    const rentalBrowse = renderBrowseProductCard(rental);

    const div = document.createElement('div');
    div.innerHTML = goodsBrowse + rentalBrowse;
    const cards = div.querySelectorAll('.product-card');
    const goodsBrowseIcons = cards[0].querySelector('.delivery-icons');
    const rentalBrowseIcons = cards[1].querySelector('.delivery-icons');

    return {
      goodsHasShip: goodsCard.includes(SHIP),
      rentalHasShip: rentalCard.includes(SHIP),
      rentalHasPickup: rentalCard.includes('Pick-up date') && rentalCard.includes('Return date'),
      rentalHasOldLabels: /Start date|End date/.test(rentalCard),
      goodsBrowseHasIcons: !!goodsBrowseIcons,
      rentalBrowseHasIcons: !!rentalBrowseIcons,
    };
  }, SHIP);

  const results = [];
  const ok = (n, c, e) => results.push([c ? 'PASS' : 'FAIL', n, e || '']);
  // Moved off the cards: it now appears once per page, and only when the store
  // actually has an unset fee. Neither card carries it any more.
  ok('§3 shipping message is off the goods card', !out.goodsHasShip);
  ok('§3 rental product card does NOT show shipping message', !out.rentalHasShip);
  ok('§19 rental form shows Pick-up date / Return date', out.rentalHasPickup);
  ok('§19 old Start/End labels are gone', !out.rentalHasOldLabels);
  ok('§18 goods browse card keeps delivery icons', out.goodsBrowseHasIcons);
  ok('§18 rental browse card has NO delivery icons', !out.rentalBrowseHasIcons);

  await browser.close();
  let failed = 0;
  console.log('\n--- Product cards: date wording (§19) + shipping msg (§3) + icon suppression (§18) ---');
  for (const [st, n, e] of results) { if (st === 'FAIL') failed++; console.log(`${st}  ${n}${e ? '  [' + e + ']' : ''}`); }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
