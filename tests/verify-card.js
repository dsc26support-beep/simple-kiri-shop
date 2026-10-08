const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = 'http://127.0.0.1:8099';

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 800 } });
  await ctx.route('**/macros/s/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, products: [] }) }));
  const page = await ctx.newPage();
  await page.goto(BASE + '/categories.html', { waitUntil: 'load' });
  await page.waitForFunction(() => typeof renderBrowseProductCard === 'function', null, { timeout: 5000 });

  // The place row (Oct 2026): where the store is, then the delivery icons,
  // then the badges. Goods show all their delivery icons; a service shows
  // none - delivery is store-wide and means nothing on a service, so
  // renderBrowseProductCard hides it there on purpose. No phone number, no
  // "Sold by / Service by" verbs.
  const res = await page.evaluate(() => {
    const base = {
      storeSlug: 'bong', storeName: 'Bong Restaurant', storePhone: '63011224', storeIsland: 'Abaiang',
      variants: [{ variantId: 'a', label: 'Small', price: 7.5 }, { variantId: 'b', label: 'Large', price: 40 }],
      storeDeliveryTruck: true, storeDeliveryShip: true, storeDeliveryAirCargo: true,
      storeDeliveryTruckCost: 0, storeDeliveryShipCost: 0,
    };
    const render = (product) => {
      const wrap = document.createElement('div');
      wrap.style.width = '360px';
      wrap.innerHTML = renderBrowseProductCard(product);
      document.body.appendChild(wrap);
      return wrap.querySelector('.product-card');
    };
    const goods = render(Object.assign({ productId: 'p1', name: 'Chop Syue', category: 'food', listingType: 'product' }, base));
    const service = render(Object.assign({ productId: 'p2', name: 'Catering', category: 'services', listingType: 'service' }, base));
    const meta = goods.querySelector('.product-card-meta');
    const place = meta.querySelector('.product-card-place');
    const icons = meta.querySelector('.delivery-icons');
    const pr = place.getBoundingClientRect();
    const ir = icons.getBoundingClientRect();
    return {
      place: place.textContent,
      cardText: goods.textContent + ' ' + service.textContent,
      phone: !!goods.querySelector('.store-phone'),
      sameLine: Math.abs(pr.top - ir.top) <= 6,
      iconsAfterPlace: ir.left >= pr.right - 1,
      iconCount: icons.querySelectorAll('.delivery-icon').length,
      serviceIcons: service.querySelectorAll('.delivery-icon').length,
      servicePlace: service.querySelector('.product-card-place').textContent,
      serviceCart: !!service.querySelector('.card-cart-btn'),
    };
  });

  const results = [];
  const ok = (n, c, e) => results.push([c ? 'PASS' : 'FAIL', n, e || '']);
  ok('place shown (island), not the store name', res.place === 'Abaiang', JSON.stringify(res.place));
  ok('no Sold/Rent/Service by anywhere on either card', !/(Sold|Rent|Service) by/.test(res.cardText), res.cardText);
  ok('no phone number on the card', !res.phone);
  ok('service card shows its place too', res.servicePlace === 'Abaiang', JSON.stringify(res.servicePlace));
  ok('place and icons on the same line', res.sameLine);
  ok('icons right after the place', res.iconsAfterPlace);
  ok('all 3 delivery icons render on a goods listing', res.iconCount === 3, 'count=' + res.iconCount);
  ok('a service listing shows no delivery icons (by design)', res.serviceIcons === 0, 'count=' + res.serviceIcons);
  ok('a service listing has no cart button (booked, not bought)', !res.serviceCart);

  await browser.close();
  let failed = 0;
  console.log('\n--- Product card layout ---');
  for (const [st, n, e] of results) { if (st === 'FAIL') failed++; console.log(`${st}  ${n}${e ? '  [' + e + ']' : ''}`); }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
