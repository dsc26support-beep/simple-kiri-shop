const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = 'http://127.0.0.1:8099';

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 800 } });
  await ctx.route('**/macros/s/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, products: [] }) }));
  const page = await ctx.newPage();
  await page.goto(BASE + '/categories.html', { waitUntil: 'load' });
  await page.waitForFunction(() => typeof renderBrowseProductCard === 'function', null, { timeout: 5000 });

  // Goods listing: the phone + delivery icons row. Service listing: no verb
  // ("Service by") and no delivery icons - delivery is store-wide and means
  // nothing on a service, so renderBrowseProductCard hides it there on purpose.
  const res = await page.evaluate(() => {
    const base = {
      storeSlug: 'bong', storeName: 'Bong Restaurant', storePhone: '63011224',
      variants: [{ label: 'Small', price: 7.5 }, { label: 'Large', price: 40 }],
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
    const meta = goods.querySelector('.helper-text');
    const row = goods.querySelector('.store-phone-row');
    const phone = goods.querySelector('.store-phone');
    const icons = goods.querySelector('.delivery-icons');
    const pr = phone.getBoundingClientRect();
    const ir = icons.getBoundingClientRect();
    return {
      metaText: meta.textContent,
      cardText: goods.textContent + ' ' + service.textContent,
      hasRow: !!row,
      phoneInRow: row.contains(phone),
      iconsInRow: row.contains(icons),
      sameLine: Math.abs(pr.top - ir.top) <= 6,
      iconsAfterPhone: ir.left >= pr.right - 1,
      iconCount: icons.querySelectorAll('.delivery-icon').length,
      serviceIcons: service.querySelectorAll('.delivery-icon').length,
      serviceMeta: service.querySelector('.helper-text').textContent,
    };
  });

  const results = [];
  const ok = (n, c, e) => results.push([c ? 'PASS' : 'FAIL', n, e || '']);
  ok('store name shown without verb', res.metaText.trim() === 'Bong Restaurant', JSON.stringify(res.metaText));
  ok('no Sold/Rent/Service by anywhere on either card', !/(Sold|Rent|Service) by/.test(res.cardText), res.cardText);
  ok('service card also shows the plain store name', res.serviceMeta.trim() === 'Bong Restaurant', JSON.stringify(res.serviceMeta));
  ok('phone + icons wrapped in one row', res.hasRow && res.phoneInRow && res.iconsInRow);
  ok('phone and icons on the same line', res.sameLine);
  ok('icons grouped right after phone', res.iconsAfterPhone);
  ok('all 3 delivery icons render on a goods listing', res.iconCount === 3, 'count=' + res.iconCount);
  ok('a service listing shows no delivery icons (by design)', res.serviceIcons === 0, 'count=' + res.serviceIcons);

  await browser.close();
  let failed = 0;
  console.log('\n--- Product card layout ---');
  for (const [st, n, e] of results) { if (st === 'FAIL') failed++; console.log(`${st}  ${n}${e ? '  [' + e + ']' : ''}`); }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
