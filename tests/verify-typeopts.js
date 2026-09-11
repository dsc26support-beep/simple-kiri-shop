// The "What are you offering?" dropdown on the seller's product form.
//
// The three options were sentence-long ("Something to sell - customers add it
// to their cart") and Android's native picker wrapped each onto two lines. They
// are one word now, with the explanation moved into the helper line below.
//
// The one thing that must NOT change is the option VALUES: product / rental /
// service are what the backend stores and what every isBookingListing check
// keys off. A copy change that quietly altered a value would turn a car hire
// into a cart item.
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const fs = require('fs');
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
        variants: [{ variantId: 'v1', label: 'Per day', price: 120, status: 'active' }]
      }] };
    } else if (action === 'createProduct' || action === 'updateProduct') {
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
  await page.evaluate(() => { if (typeof openForm === 'function') openForm(); });
  await page.waitForSelector('#product-listing-type', { timeout: 6000 });

  const opts = await page.$$eval('#product-listing-type option',
    (os) => os.map((o) => ({ value: o.value, text: o.textContent.trim(), disabled: o.disabled })));

  ok('the three options read Product / Rental / Service',
    JSON.stringify(opts.filter((o) => o.value).map((o) => o.text)) ===
    JSON.stringify(['Product', 'Rental', 'Service']), JSON.stringify(opts));
  ok('the stored values are untouched - product / rental / service',
    JSON.stringify(opts.filter((o) => o.value).map((o) => o.value)) ===
    JSON.stringify(['product', 'rental', 'service']), JSON.stringify(opts));
  ok('every option is one word - nothing left to wrap on a phone',
    opts.filter((o) => o.value).every((o) => o.text.split(/\s+/).length === 1), JSON.stringify(opts));
  ok('no sentence fragments survive in the options',
    !opts.some((o) => /customers|cart|request dates|Something to/.test(o.text)), JSON.stringify(opts));
  ok('the placeholder option is still there, still unselectable',
    opts[0].value === '' && opts[0].disabled === true, JSON.stringify(opts[0]));

  // ---------- the explanation moved, it was not lost ----------
  const helper = await page.evaluate(() => {
    const sel = document.getElementById('product-listing-type');
    const p = sel.closest('.field').querySelector('.helper-text');
    return p ? p.textContent.trim() : null;
  });
  ok('the helper line now explains cart vs by-date',
    helper && /cart/i.test(helper) && /date/i.test(helper), String(helper));
  ok('the helper line still says the choice can be changed later',
    helper && /change this later/i.test(helper), String(helper));

  // ---------- the labels ----------
  const labels = await page.evaluate(() => ({
    type: document.querySelector('label[for="product-listing-type"]').textContent.trim(),
    category: document.querySelector('label[for="product-category"]').textContent.trim()
  }));
  ok('"What are you offering?" is kept', labels.type === 'What are you offering?', labels.type);
  ok('"What type is it?" became "Category"', labels.category === 'Category', labels.category);
  ok('no field asks about a "type" any more - that was the confusing part',
    !/type/i.test(labels.category), labels.category);

  // ---------- the value still drives everything downstream ----------
  await page.selectOption('#product-listing-type', 'rental');
  const afterRental = await page.evaluate(() => ({
    varietyLabel: document.querySelector('#variant-rows .variant-label')
      .closest('.field').querySelector('label').textContent.trim(),
    categoryCount: document.querySelectorAll('#product-category option').length
  }));
  ok('choosing Rental still switches the variety row to Duration',
    afterRental.varietyLabel === 'Duration', afterRental.varietyLabel);
  ok('choosing Rental still narrows the category list',
    afterRental.categoryCount > 1, String(afterRental.categoryCount));

  await page.fill('#product-name', 'Toyota Hilux');
  await page.selectOption('#product-category', 'vehicles');
  await page.fill('#variant-rows .variant-label', 'Per day');
  await page.fill('#variant-rows .variant-price', '120');
  await page.evaluate(() => document.getElementById('product-form').requestSubmit());
  await page.waitForTimeout(1200);
  ok('saving still sends listingType "rental", not the label',
    saved && saved.listingType === 'rental', JSON.stringify(saved && saved.listingType));

  // ---------- editing an existing listing still preselects its type ----------
  await page.evaluate(() => openForm(ownerProducts.find((p) => p.productId === 'p1')));
  const reopened = await page.evaluate(() => {
    const sel = document.getElementById('product-listing-type');
    return { value: sel.value, text: sel.options[sel.selectedIndex].textContent.trim() };
  });
  ok('editing a saved rental reopens on Rental', reopened.value === 'rental' && reopened.text === 'Rental',
    JSON.stringify(reopened));

  ok('no page errors in this flow', pageErrors.length === 0, pageErrors.join('; '));

  // ---------- the shopper-facing wording is untouched ----------
  const helpers = fs.readFileSync('/home/user/simple-kiri-shop/assets/js/helpers.js', 'utf8');
  const types = (helpers.match(/const LISTING_TYPES = \[[\s\S]*?\n\];/) || [''])[0];
  ok('the homepage strip still says the plural Products / Rentals / Services',
    /label: 'Products'/.test(types) && /label: 'Rentals'/.test(types) && /label: 'Services'/.test(types), types);
  ok('the seller-side noun in the taxonomy is singular and matches the form',
    /seller: 'Product'/.test(types) && /seller: 'Rental'/.test(types) && /seller: 'Service'/.test(types), types);
  ok('no listing-type id changed', /'product'/.test(types) && /'rental'/.test(types) && /'service'/.test(types));

  await browser.close();
  console.log('\n--- Listing-type dropdown wording ---');
  let failed = 0;
  for (const [st, n, e] of results) { if (st === 'FAIL') failed++; console.log(`${st}  ${n}${e ? '  [' + e + ']' : ''}`); }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
