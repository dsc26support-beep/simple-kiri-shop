// The variety rows on the seller's Add/Edit Product form.
//
// Two changes: the row label is the noun alone ("Variety", not
// "Label (e.g. 500g, Large)") with the example moved into the input's
// placeholder, and the "Varieties & Prices" heading is visually gone because
// the row labels already say what the block is.
//
// The thing worth guarding is that neither change touched what gets SAVED -
// a relabelled field that silently stops sending its value would be far worse
// than the wording it fixed.
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = 'http://127.0.0.1:8099';

const OWNER = {
  ownerId: 'own_1', storeName: 'Bong Rentals', storeSlug: 'bong', email: 'a@b.com',
  phone: '73007552', island: 'South Tarawa', village: 'Betio', status: 'active',
  isOpen: true, deliveryPickPay: true
};

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const results = [];
  const ok = (n, c, e) => results.push([c ? 'PASS' : 'FAIL', n, e || '']);

  let saved = null;
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx.route('**/macros/s/**', (route) => {
    let body = {};
    try { body = route.request().postDataJSON() || {}; } catch (e) {}
    let action = body.action;
    try { if (!action) action = new URL(route.request().url()).searchParams.get('action') || ''; } catch (e) {}
    let res = { ok: true };
    if (action === 'getOwnerProfile') res = { ok: true, owner: OWNER };
    else if (action === 'listOwnerProducts') {
      res = { ok: true, total: 1, hasMore: false, products: [{
        productId: 'p1', name: 'Toyota Hilux', description: 'Daily hire',
        category: 'vehicles', listingType: 'rental', status: 'active', imageUrls: [],
        variants: [{ variantId: 'v1', label: 'Per day', price: 120, status: 'active' },
                   { variantId: 'v2', label: 'Per week', price: 600, status: 'active' }]
      }] };
    } else if (action === 'saveProduct' || action === 'updateProduct' || action === 'createProduct') {
      saved = body;
      res = { ok: true, productId: 'p1' };
    }
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(res) });
  });

  const page = await ctx.newPage();
  await page.addInitScript(() => {
    if (window.__seeded) return;
    window.__seeded = true;
    try { localStorage.setItem('skiri_owner_token', 'tok-123'); } catch (e) {}
  });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  await page.goto(BASE + '/owner/products.html', { waitUntil: 'load' });
  await page.waitForSelector('#add-product-btn, [id*="add-product"]', { timeout: 6000 }).catch(() => {});

  // Open the "add a product" form.
  await page.evaluate(() => { if (typeof openForm === 'function') openForm(); });
  await page.waitForSelector('#variant-rows .variant-row', { timeout: 6000 });

  // ---------- the heading ----------
  const heading = await page.evaluate(() => {
    const el = document.getElementById('varieties-label');
    if (!el) return { exists: false };
    const r = el.getBoundingClientRect();
    return {
      exists: true,
      text: el.textContent.trim(),
      srOnly: el.classList.contains('sr-only'),
      // sr-only is clipped to a 1px box, so this is what "visually gone" means.
      visualWidth: Math.round(r.width),
      visualHeight: Math.round(r.height)
    };
  });
  ok('the "Varieties & Prices" heading is no longer visible',
    heading.exists && heading.srOnly && heading.visualWidth <= 1 && heading.visualHeight <= 1,
    JSON.stringify(heading));
  ok('but it is still in the page for screen readers, not deleted',
    heading.exists && heading.text.length > 0, JSON.stringify(heading));

  // ---------- the row label, for a product ----------
  await page.selectOption('#product-listing-type', 'product');
  const asProduct = await page.evaluate(() => {
    const input = document.querySelector('#variant-rows .variant-label');
    return {
      label: input.closest('.field').querySelector('label').textContent.trim(),
      placeholder: input.placeholder,
      priceLabel: document.querySelector('#variant-rows .variant-price')
        .closest('.field').querySelector('label').textContent.trim()
    };
  });
  ok('the row label is just "Variety"', asProduct.label === 'Variety', asProduct.label);
  ok('no "(e.g. ...)" left in the label', !/\(e\.g\./.test(asProduct.label), asProduct.label);
  ok('the example moved into the placeholder',
    asProduct.placeholder === 'e.g. 500g, Large', asProduct.placeholder);
  ok('the Price label is untouched', asProduct.priceLabel === 'Price', asProduct.priceLabel);

  // ---------- rental and service keep their own wording ----------
  await page.selectOption('#product-listing-type', 'rental');
  const asRental = await page.evaluate(() => {
    const input = document.querySelector('#variant-rows .variant-label');
    return { label: input.closest('.field').querySelector('label').textContent.trim(),
             placeholder: input.placeholder };
  });
  ok('a rental still says "Duration", not "Variety"', asRental.label === 'Duration', asRental.label);
  ok('the rental example moved to the placeholder too',
    asRental.placeholder === 'e.g. ½ day, per day, per week', asRental.placeholder);

  await page.selectOption('#product-listing-type', 'service');
  const asService = await page.evaluate(() => {
    const input = document.querySelector('#variant-rows .variant-label');
    return { label: input.closest('.field').querySelector('label').textContent.trim(),
             placeholder: input.placeholder };
  });
  ok('a service still says "Service Name"', asService.label === 'Service Name', asService.label);
  ok('the service example moved to the placeholder too',
    asService.placeholder === 'e.g. Car Wash start price', asService.placeholder);

  // Switching type must relabel rows that already exist, not just new ones.
  await page.selectOption('#product-listing-type', 'product');
  await page.click('#add-variant-btn');
  await page.selectOption('#product-listing-type', 'rental');
  const allRows = await page.evaluate(() => [...document.querySelectorAll('#variant-rows .variant-label')]
    .map((i) => ({ label: i.closest('.field').querySelector('label').textContent.trim(), ph: i.placeholder })));
  ok('switching type relabels EVERY existing row, not only new ones',
    allRows.length >= 2 && allRows.every((r) => r.label === 'Duration' && r.ph === 'e.g. ½ day, per day, per week'),
    JSON.stringify(allRows));

  // ---------- a placeholder is not a value ----------
  const emptiness = await page.evaluate(() => {
    const i = document.querySelector('#variant-rows .variant-label');
    return { value: i.value, required: i.required };
  });
  ok('the placeholder is grey hint text, not a prefilled value',
    emptiness.value === '' && emptiness.required === true, JSON.stringify(emptiness));

  // ---------- editing an existing product still shows its saved labels ----------
  await page.evaluate(() => {
    const p = ownerProducts.find((x) => x.productId === 'p1');
    openForm(p);
  });
  await page.waitForFunction(() => document.querySelectorAll('#variant-rows .variant-row').length === 2,
    null, { timeout: 4000 });
  const editing = await page.evaluate(() => ({
    values: [...document.querySelectorAll('#variant-rows .variant-label')].map((i) => i.value),
    prices: [...document.querySelectorAll('#variant-rows .variant-price')].map((i) => i.value),
    labels: [...document.querySelectorAll('#variant-rows .variant-label')]
      .map((i) => i.closest('.field').querySelector('label').textContent.trim())
  }));
  ok('editing a saved rental still loads its variety values',
    JSON.stringify(editing.values) === JSON.stringify(['Per day', 'Per week']), JSON.stringify(editing.values));
  ok('editing a saved rental still loads its prices',
    JSON.stringify(editing.prices) === JSON.stringify(['120', '600']), JSON.stringify(editing.prices));
  ok('a saved rental shows the Duration label',
    editing.labels.every((l) => l === 'Duration'), JSON.stringify(editing.labels));

  // ---------- the save payload is unchanged ----------
  await page.fill('#product-name', 'Toyota Hilux');
  const inputs = await page.$$('#variant-rows .variant-label');
  await inputs[0].fill('Per day');
  const prices = await page.$$('#variant-rows .variant-price');
  await prices[0].fill('120');
  await page.evaluate(() => {
    document.querySelectorAll('#variant-rows .variant-row')[1].remove();
  });
  await page.click('#product-form button[type="submit"]').catch(async () => {
    await page.evaluate(() => document.getElementById('product-form').requestSubmit());
  });
  await page.waitForTimeout(1200);
  ok('saving still sends the variety label the seller typed',
    saved && JSON.stringify(saved.variants) === JSON.stringify([{ variantId: 'v1', label: 'Per day', price: 120 }]),
    JSON.stringify(saved && saved.variants));

  ok('no page errors anywhere in this flow', pageErrors.length === 0, pageErrors.join('; '));

  await browser.close();
  console.log('\n--- Variety label + heading on the seller form ---');
  let failed = 0;
  for (const [st, n, e] of results) { if (st === 'FAIL') failed++; console.log(`${st}  ${n}${e ? '  [' + e + ']' : ''}`); }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
