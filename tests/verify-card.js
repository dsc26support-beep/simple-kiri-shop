const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = 'http://127.0.0.1:8099';

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 800 } });
  await ctx.route('**/macros/s/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, products: [] }) }));
  const page = await ctx.newPage();
  await page.goto(BASE + '/categories.html', { waitUntil: 'load' });
  await page.waitForFunction(() => typeof renderBrowseProductCard === 'function', null, { timeout: 5000 });

  const res = await page.evaluate(() => {
    const product = {
      productId: 'p1', name: 'Chop Syue', storeSlug: 'bong', storeName: 'Bong Restaurant',
      category: 'services', // would previously say "Service by"
      storePhone: '63011224',
      variants: [{ label: 'Small', price: 7.5 }, { label: 'Large', price: 40 }],
      storeDeliveryTruck: true, storeDeliveryShip: true, storeDeliveryAirCargo: true,
      storeDeliveryTruckCost: 0, storeDeliveryShipCost: 0,
    };
    const wrap = document.createElement('div');
    wrap.style.width = '360px';
    wrap.innerHTML = renderBrowseProductCard(product);
    document.body.appendChild(wrap);
    const card = wrap.querySelector('.product-card');
    const meta = card.querySelector('.helper-text');
    const row = card.querySelector('.store-phone-row');
    const phone = card.querySelector('.store-phone');
    const icons = card.querySelector('.delivery-icons');
    const pr = phone.getBoundingClientRect();
    const ir = icons.getBoundingClientRect();
    return {
      metaText: meta.textContent,
      cardText: card.textContent,
      hasRow: !!row,
      phoneInRow: row.contains(phone),
      iconsInRow: row.contains(icons),
      sameLine: Math.abs(pr.top - ir.top) <= 6,
      iconsAfterPhone: ir.left >= pr.right - 1,
      iconCount: icons.querySelectorAll('.delivery-icon').length,
    };
  });

  const results = [];
  const ok = (n, c, e) => results.push([c ? 'PASS' : 'FAIL', n, e || '']);
  ok('store name shown without verb', res.metaText.trim() === 'Bong Restaurant', JSON.stringify(res.metaText));
  ok('no Sold/Rent/Service by anywhere on card', !/(Sold|Rent|Service) by/.test(res.cardText), res.cardText);
  ok('phone + icons wrapped in one row', res.hasRow && res.phoneInRow && res.iconsInRow);
  ok('phone and icons on the same line', res.sameLine);
  ok('icons grouped right after phone', res.iconsAfterPhone);
  ok('all 3 delivery icons render', res.iconCount === 3, 'count=' + res.iconCount);

  await browser.close();
  let failed = 0;
  console.log('\n--- Product card layout ---');
  for (const [st, n, e] of results) { if (st === 'FAIL') failed++; console.log(`${st}  ${n}${e ? '  [' + e + ']' : ''}`); }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
