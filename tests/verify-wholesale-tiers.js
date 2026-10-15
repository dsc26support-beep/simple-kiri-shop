/**
 * Wholesale bulk prices + minimum order in the browser, against the REAL
 * backend (gas-harness behind every API call): a wholesaler sets bulk prices
 * in the product form, the product page shows them, the cart prices the line
 * by quantity, and what the server charges for that cart is what the shopper
 * was shown. A retailer sees none of it. Phone widths, no sideways scroll.
 */
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const { makeBox } = require('./lib/gas-harness.js');
const BASE = process.env.TX_BASE || 'http://127.0.0.1:8099';
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e === undefined ? '' : e]);
const FUT = new Date(Date.now() + 9e8).toISOString();
const OH = ['OwnerId', 'StoreSlug', 'StoreName', 'Email', 'Status', 'StoreType', 'Island', 'DeliveryPickPay'];
const PH = ['ProductId', 'OwnerId', 'StoreSlug', 'Name', 'Description', 'Category', 'SubcategoryId', 'ListingType', 'ProductType', 'ImageUrl', 'Status', 'SortOrder', 'OptionsJson'];
const SIZE = JSON.stringify([{ id: 'o_siz', name: 'Size', kind: 'size', values: [{ id: 'v_s1', label: '5kg' }, { id: 'v_s2', label: '25kg' }] }]);
const box = makeBox({
  Owners: [OH, ['own_w', 'whole', 'Whole Foods', 'w@x.test', 'active', 'wholesaler', 'South Tarawa', 'true'],
    ['own_r', 'retail', 'Corner Shop', 'r@x.test', 'active', 'retailer', 'South Tarawa', 'true']],
  Sessions: [['Token', 'OwnerId', 'CreatedAt', 'ExpiresAt'], ['tokw', 'own_w', '', FUT], ['tokr', 'own_r', '', FUT]],
  Products: [PH, ['p_rice', 'own_w', 'whole', 'Rice 10kg', 'Long grain', 'food', 'food-rice-grains', 'product', 'single', '', 'active', 0, ''],
    ['p_flour', 'own_w', 'whole', 'Flour', 'Baking flour', 'food', 'food-rice-grains', 'product', 'options', '', 'active', 1, SIZE],
    ['p_soap', 'own_r', 'retail', 'Soap', 'Bar soap', 'home', 'home-cleaning', 'product', 'single', '', 'active', 0, '']],
  Variants: [['VariantId', 'ProductId', 'OwnerId', 'Label', 'Price', 'SKU', 'StockQty', 'ReservedQty', 'Status', 'OptionValuesJson'],
    ['v_rice', 'p_rice', 'own_w', 'Standard', 18, '', 500, 0, 'active', ''], ['v_soap', 'p_soap', 'own_r', 'Standard', 2, '', '', 0, 'active', ''],
    ['v_f5', 'p_flour', 'own_w', '5kg', 10, '', '', 0, 'active', '{"o_siz":"v_s1"}'], ['v_f25', 'p_flour', 'own_w', '25kg', 40, '', '', 0, 'active', '{"o_siz":"v_s2"}']],
  Orders: [['OrderId', 'OwnerId', 'StoreSlug', 'CustomerName', 'CustomerPhone', 'CustomerEmail', 'Island', 'Village', 'DeliveryAddress',
    'DeliveryMethod', 'DeliveryCost', 'Notes', 'PaymentMethod', 'PaymentReference', 'ItemsJson', 'ItemsSummary', 'Subtotal', 'Total', 'Status', 'CreatedAt', 'UpdatedAt']],
  AbandonedCarts: [['CartId', 'StoreSlug', 'Email', 'ConvertedOrderId']]
});
box.ContentService = { createTextOutput: (s) => ({ s, setMimeType() { return this; } }), MimeType: { JSON: 'json' } };
box.__props.WHOLESALE_TIERS = 'on';
const fresh = () => { Object.keys(box.__cache).forEach((k) => delete box.__cache[k]); box.WHOLESALE_TIERS_MEMO = null; };
const SHOT = process.env.SHOT_DIR || '';
const shot = async (p, name, sel) => { if (!SHOT) return; const el = sel ? await p.$(sel) : null; await (el || p).screenshot({ path: `${SHOT}/${name}.png` }); };
const rice = () => box.__sheets.Variants.objects().find((v) => v.VariantId === 'v_rice');

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const errors = [];
  const open = async (w, path, token) => {
    const ctx = await browser.newContext({ viewport: { width: w, height: 844 }, serviceWorkers: 'block' });
    await ctx.addInitScript((t) => {
      localStorage.setItem('skiri_cookie_consent', 'true');
      if (t) { localStorage.setItem('skiri_owner_token', t); localStorage.setItem('skiri_owner_profile', JSON.stringify({ storeName: 'S', storeSlug: 's', status: 'active' })); }
    }, token || '');
    await ctx.route('**/macros/s/**', (route) => {
      fresh();
      const req = route.request();
      const b = req.postData();
      let out;
      if (b) out = box.doPost({ postData: { contents: b } }).s;
      else out = box.doGet({ parameter: Object.fromEntries(new URL(req.url()).searchParams) }).s;
      route.fulfill({ status: 200, contentType: 'application/json', body: out });
    });
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(path + ': ' + String(e)));
    p.on('dialog', (d) => d.accept());
    await p.goto(BASE + path, { waitUntil: 'load' });
    return { ctx, p };
  };
  const over = (p) => p.evaluate(() => document.documentElement.scrollWidth - innerWidth);

  /* ---------- seller: set bulk prices ---------- */
  let { ctx, p } = await open(390, '/owner/products.html', 'tokw');
  await p.waitForSelector('[data-action="edit"]', { timeout: 10000 });
  await p.click('[data-product-id="p_rice"] [data-action="edit"]');
  await p.waitForSelector('#single-wholesale .wp-panel', { timeout: 8000 });
  ok('wholesaler: the product form offers Wholesale prices', await p.isVisible('#single-wholesale .wp-panel'));
  await p.click('#single-wholesale .wp-add');
  await p.fill('#single-wholesale .wp-tier[data-i="0"] .wp-qty', '10');
  await p.fill('#single-wholesale .wp-tier[data-i="0"] .wp-price', '16.50');
  await p.click('#single-wholesale .wp-add');
  await p.fill('#single-wholesale .wp-tier[data-i="1"] .wp-qty', '50');
  await p.fill('#single-wholesale .wp-tier[data-i="1"] .wp-price', '19');
  await p.fill('#single-wholesale .wp-minqty', '10');
  await p.click('#save-product-btn');
  await p.waitForTimeout(800);
  ok('a bulk price above the normal price is stopped before saving, with the reason', /lower than the normal price/.test(await p.textContent('#product-form-error')) && !rice().PriceTiersJson,
    await p.textContent('#product-form-error'));
  await p.fill('#single-wholesale .wp-tier[data-i="1"] .wp-price', '15');
  ok('phone 390: the open form has no sideways scroll', (await over(p)) <= 1);
  await shot(p, 'seller-wholesale-prices', '#single-fields');
  await p.setViewportSize({ width: 320, height: 800 });
  ok('phone 320: the open form has no sideways scroll', (await over(p)) <= 1, String(await over(p)));
  await p.click('#save-product-btn');
  await p.waitForFunction(() => document.getElementById('product-form-section').classList.contains('hidden'), null, { timeout: 10000 }).catch(() => {});
  ok('saved: the sheet holds the bulk prices and the minimum', rice().PriceTiersJson === JSON.stringify([{ minQty: 10, price: 16.5 }, { minQty: 50, price: 15 }]) && Number(rice().MinOrderQty) === 10,
    JSON.stringify(rice()) + ' | ' + (await p.textContent('#product-form-error')));
  await ctx.close();

  /* ---------- seller: bulk prices per size (options product) ---------- */
  ({ ctx, p } = await open(390, '/owner/products.html', 'tokw'));
  await p.waitForSelector('[data-action="edit"]', { timeout: 10000 });
  await p.click('[data-product-id="p_flour"] [data-action="edit"]');
  await p.waitForSelector('#variant-grid .vg-wholesale', { timeout: 8000 });
  ok('options product: each size row has a Wholesale button', (await p.$$('#variant-grid .vg-wholesale')).length === 2);
  const row25 = p.locator('#variant-grid .vg-row', { hasText: '25kg' });
  await row25.locator('.vg-wholesale').click();
  await p.waitForSelector('#variant-grid .vg-wp-row .wp-panel');
  await p.click('#variant-grid .vg-wp-row .wp-add');
  await p.fill('#variant-grid .vg-wp-row .wp-qty', '5');
  await p.fill('#variant-grid .vg-wp-row .wp-price', '36');
  await p.fill('#variant-grid .vg-wp-row .wp-minqty', '2');
  ok('options product: the button counts what was set ("1 price, min 2")', (await row25.locator('.vg-wholesale').textContent()).trim() === '1 price, min 2', await row25.locator('.vg-wholesale').textContent());
  ok('options product 390: no sideways scroll with the panel open', (await over(p)) <= 1, String(await over(p)));
  await p.click('#save-product-btn');
  await p.waitForFunction(() => document.getElementById('product-form-section').classList.contains('hidden'), null, { timeout: 10000 }).catch(() => {});
  const f = (id) => box.__sheets.Variants.objects().find((v) => v.VariantId === id);
  ok('options product: saved on the 25kg row only', f('v_f25').PriceTiersJson === JSON.stringify([{ minQty: 5, price: 36 }]) && Number(f('v_f25').MinOrderQty) === 2 && !f('v_f5').PriceTiersJson,
    JSON.stringify([f('v_f5'), f('v_f25')]).slice(0, 300) + ' | ' + (await p.textContent('#product-form-error')));
  await ctx.close();

  /* ---------- shopper: product page ---------- */
  ({ ctx, p } = await open(390, '/product.html?store=whole&product=p_rice'));
  await p.waitForSelector('#pdp-bulk', { timeout: 10000 });
  const table = await p.$$eval('#pdp-bulk tbody tr', (trs) => trs.map((tr) => Array.from(tr.cells).map((c) => c.textContent.trim()).join(' ')));
  ok('product page: bulk price table from the minimum up (10–49 $16.50, 50+ $15.00)', table.join('|') === '10–49 $16.50|50+ $15.00', table.join('|'));
  ok('product page: minimum order shown', /Minimum order: 10/.test(await p.textContent('#pdp-bulk')));
  const qty = await p.evaluate(() => { const q = document.getElementById('qty-p_rice'); return q ? [q.value, q.min] : null; });
  ok('product page: quantity starts at the minimum', qty && qty[0] === '10' && qty[1] === '10', JSON.stringify(qty));
  ok('product page 390: no sideways scroll', (await over(p)) <= 1);
  await shot(p, 'product-bulk-prices', '#product-detail');
  await p.click('.add-to-cart-btn');
  await p.waitForTimeout(400);
  const line = await p.evaluate(() => JSON.parse(localStorage.getItem('skiri_cart_whole') || '[]')[0]);
  ok('add to cart: 10 in the cart, with the bulk prices', line && line.qty === 10 && line.tiers.length === 2 && line.minQty === 10, JSON.stringify(line));
  await p.setViewportSize({ width: 320, height: 800 });
  ok('product page 320: no sideways scroll', (await over(p)) <= 1, String(await over(p)));

  /* ---------- cart ---------- */
  await p.goto(BASE + '/cart.html?store=whole', { waitUntil: 'load' });
  await p.waitForSelector('.cart-line', { timeout: 10000 });
  ok('cart: "$16.50 each · Bulk price" with the normal price struck through', /\$16\.50 each Bulk price \$18\.00/.test((await p.textContent('.cart-line-price')).replace(/\s+/g, ' ')), await p.textContent('.cart-line-price'));
  ok('cart: offers the next step ("Buy 50+ for $15.00 each") and the minimum', /Buy 50\+ for \$15\.00 each · Minimum order 10/.test(await p.textContent('.cart-line-bulk')), await p.textContent('.cart-line-bulk'));
  ok('cart: total 10 × $16.50 = $165.00', (await p.textContent('#cart-total')).trim() === '$165.00', await p.textContent('#cart-total'));
  await p.fill('.cart-line-qty', '50');
  await p.waitForTimeout(200);
  await shot(p, 'cart-bulk-price', '#cart-content');
  ok('cart: typing 50 reprices live to $750.00', (await p.textContent('#cart-total')).trim() === '$750.00' && (await p.textContent('.cart-line-total')).trim() === '$750.00', await p.textContent('#cart-total'));
  await p.fill('.cart-line-qty', '3');
  await p.press('.cart-line-qty', 'Enter');
  await p.locator('.cart-line-qty').blur();
  await p.waitForTimeout(300);
  ok('cart: lowering below the minimum goes back to the minimum (10)', (await p.inputValue('.cart-line-qty')) === '10' && (await p.textContent('#cart-total')).trim() === '$165.00', await p.inputValue('.cart-line-qty'));
  await p.fill('.cart-line-qty', '12');
  await p.locator('.cart-line-qty').blur();
  await p.waitForTimeout(200);
  ok('cart 320: no sideways scroll', (await over(p)) <= 1, String(await over(p)));

  /* ---------- checkout: what the server charges = what was shown ---------- */
  await p.goto(BASE + '/checkout.html?store=whole', { waitUntil: 'load' });
  await p.waitForTimeout(800);
  const shown = await p.evaluate(() => ({ total: Cart.getTotal('whole'), lines: Cart.getCart('whole').map((l) => ({ variantId: l.variantId, qty: l.qty })) }));
  fresh();
  const charged = box.actionCreateOrder({ storeSlug: 'whole', items: shown.lines, customerName: 'Tia', customerPhone: '73000000', island: 'South Tarawa', village: 'Betio', deliveryMethod: 'pickPay', paymentMethod: 'cash' });
  ok('checkout: the server charges exactly what the cart showed (12 × $16.50 = $198.00)', charged.ok && charged.total === shown.total && shown.total === 198, JSON.stringify(shown) + ' ' + JSON.stringify(charged).slice(0, 200));
  await ctx.close();

  /* ---------- retailer: none of it ---------- */
  ({ ctx, p } = await open(390, '/owner/products.html', 'tokr'));
  await p.waitForSelector('[data-action="edit"]', { timeout: 10000 });
  await p.click('[data-action="edit"]');
  await p.waitForSelector('#single-price', { state: 'visible', timeout: 8000 });
  ok('retailer: no Wholesale prices in the product form', !(await p.isVisible('#single-wholesale')) && !(await p.$('#single-wholesale .wp-panel')));
  await ctx.close();
  ({ ctx, p } = await open(390, '/product.html?store=retail&product=p_soap'));
  await p.waitForSelector('.add-to-cart-btn', { timeout: 10000 });
  ok('retailer: product page has no bulk table', !(await p.$('#pdp-bulk')));
  await ctx.close();

  /* ---------- switch off: back to normal ---------- */
  box.__props.WHOLESALE_TIERS = 'off';
  ({ ctx, p } = await open(390, '/product.html?store=whole&product=p_rice'));
  await p.waitForSelector('.add-to-cart-btn', { timeout: 10000 });
  ok('WHOLESALE_TIERS off: the product page shows no bulk prices or minimum', !(await p.$('#pdp-bulk')) && (await p.inputValue('#qty-p_rice')) === '1');
  await ctx.close();

  ok('no page errors', errors.length === 0, errors.join(' | ').slice(0, 300));
  await browser.close();
  let fails = 0;
  console.log('\n--- wholesale bulk prices in the browser (real backend) ---');
  for (const [s, n, x] of R) { if (s === 'FAIL') fails++; console.log(`${s}  ${n}${x !== '' ? '  [' + x + ']' : ''}`); }
  console.log(`\n${R.length - fails}/${R.length} passed`);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
