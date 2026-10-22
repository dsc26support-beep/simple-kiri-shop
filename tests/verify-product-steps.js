/**
 * Guided product form (owner-product-steps.js), in a real browser against a
 * stand-in backend: step by step and one-page modes, Continue checking only
 * its step, details that follow the category, the review and quality meter,
 * Save hidden, the "you already have this" note, the copy of unsaved work
 * kept on this device (per seller, cleared on log out), and layout at five
 * screen sizes.
 */
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const fs = require('fs');
const BASE = process.env.AUDIT_BASE || 'http://127.0.0.1:8099';
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e === undefined ? '' : e]);
const J = (x) => JSON.stringify(x).slice(0, 400);

const PRODUCTS = [
  { productId: 'p_rice', name: 'Jasmine rice 1kg', description: 'Long grain', category: 'food', listingType: 'product', status: 'active', productType: 'single',
    images: [], details: { netQuantity: '1kg' }, variants: [{ variantId: 'v_rice', label: 'Standard', price: 3, stockQty: 10, status: 'active' }] }
];
const OWNER = { ownerId: 'o1', storeName: 'Bong Store', storeType: 'retailer', island: 'Abaiang', deliveryPickPay: true, deliveryTruck: true, deliveryTruckCost: 5 };

async function open(browser, opts) {
  opts = opts || {};
  const ctx = await browser.newContext({ viewport: opts.viewport || { width: 390, height: 844 }, reducedMotion: 'reduce' });
  const posted = [];
  await ctx.route('**/macros/s/**', (route) => {
    let b = {}; try { b = route.request().postDataJSON() || {}; } catch (e) {}
    if (b.action) posted.push(b);
    const reply = (body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (b.action === 'getOwnerProfile') return reply({ ok: true, owner: Object.assign({}, OWNER, opts.owner || {}) });
    if (b.action === 'listOwnerProducts') return reply({ ok: true, products: PRODUCTS, total: PRODUCTS.length, hasMore: false, photoMax: 6 });
    if (b.action === 'findSimilarProducts') return reply({ ok: true, similar: /rice/i.test(b.name) && !/25kg/i.test(b.name) ? [{ productId: 'p_rice', name: 'Jasmine rice 1kg', status: 'active' }] : [] });
    if (b.action === 'createProduct') return reply({ ok: true, productId: 'p_new', notes: [] });
    if (b.action === 'updateProduct') return reply({ ok: true, productId: b.productId, notes: [] });
    return reply({ ok: true });
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('dialog', (d) => d.accept());
  await page.addInitScript((pref) => { try {
    localStorage.setItem('skiri_owner_token', 'test-token'); localStorage.setItem('skiri_cookie_consent', 'true');
    if (pref) localStorage.setItem('mwk_pform_mode', pref);
  } catch (e) {} }, opts.pref || '');
  await page.goto(BASE + '/owner/products.html', { waitUntil: 'load' });
  await page.waitForSelector('.owner-product-row', { timeout: 6000 });
  return { ctx, page, posted, errors };
}
const cont = async (page) => { await page.click('#pf-next'); await page.waitForFunction(() => !document.getElementById('pf-next').disabled); await page.waitForTimeout(60); };
const visibleSteps = (page) => page.$$eval('.pf-step', (els) => els.filter((e) => !e.hidden).map((e) => Number(e.dataset.step)));
const shown = (page, sel) => page.locator(sel).isVisible();
const fillBasics = async (page, name, cat) => {
  await page.fill('#product-name', name);
  await page.selectOption('#product-listing-type', 'product');
  await page.selectOption('#product-category', cat || 'food');
};

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

  // ---------- step by step ----------
  {
    const { ctx, page, posted, errors } = await open(browser);
    await page.click('#add-product-btn');
    ok('a new listing opens step by step: only "Basics" shows', J(await visibleSteps(page)) === '[1]', J(await visibleSteps(page)));
    ok('...the progress marks step 1 as current', await page.getAttribute('.pf-progress-btn[data-go="1"]', 'aria-current') === 'step');
    ok('...Continue shows, Back does not, Save is there but quieter', await shown(page, '#pf-next') && !(await shown(page, '#pf-back'))
      && await shown(page, '#save-product-btn') && await page.$eval('#save-product-btn', (b) => b.classList.contains('pf-save-early')));
    await cont(page);
    ok('Continue with no name: stays on Basics, the error is under the name', J(await visibleSteps(page)) === '[1]'
      && /enter a name/i.test(await page.textContent('#pf-step-1 .field-error')) && await page.evaluate(() => document.activeElement.id) === 'product-name');
    await fillBasics(page, 'Tuna in oil 185g', 'food');
    await cont(page);
    ok('Continue: on to Photos', J(await visibleSteps(page)) === '[2]');
    ok('...keyboard focus moves to the new section\'s heading', await page.evaluate(() => document.activeElement.classList.contains('pf-step-title')));
    ok('...step 1 is marked done', await page.$eval('.pf-progress-btn[data-go="1"]', (b) => b.classList.contains('is-done')));
    await cont(page);
    ok('on to Price & stock', J(await visibleSteps(page)) === '[3]');
    await page.check('input[name="productType"][value="single"]');
    await cont(page);
    ok('Continue with no price: stays, error on the price', J(await visibleSteps(page)) === '[3]' && /price greater than zero/i.test(await page.textContent('#pf-step-3 .field-error')));
    await page.fill('#single-price', '2.5');
    await page.fill('#single-stock', '24');
    await cont(page);
    ok('on to Details', J(await visibleSteps(page)) === '[4]');
    let keys = await page.$$eval('#pf-details [data-detail]', (els) => els.map((e) => e.dataset.detail));
    ok('Food shows food details: weight, sold by, best before, storage, brand, availability', J(keys) === J(['netQuantity', 'unitOfSale', 'bestBefore', 'storage', 'brand', 'availability']), J(keys));
    ok('...and the store\'s own delivery, read from Settings', /Pick up and pay/.test(await page.textContent('#pf-delivery')) && /Truck \(\$5\.00\)/.test(await page.textContent('#pf-delivery')), await page.textContent('#pf-delivery'));
    await page.fill('#pd-netQuantity', '185g');
    await page.selectOption('#pd-storage', 'Room temperature');
    await page.fill('#pd-brand', 'Sunbell');
    await page.selectOption('#pd-availability', 'Ready now');
    // Change the category: brand carries over, storage is not offered for electronics.
    await page.click('.pf-progress-btn[data-go="1"]');
    ok('the progress buttons go back to an earlier step', J(await visibleSteps(page)) === '[1]');
    await page.selectOption('#product-category', 'electronics');
    await page.click('.pf-progress-btn[data-go="4"]');
    keys = await page.$$eval('#pf-details [data-detail]', (els) => els.map((e) => e.dataset.detail));
    ok('Electronics shows brand, model, condition, warranty, availability', J(keys) === J(['brand', 'model', 'condition', 'warranty', 'availability']), J(keys));
    ok('...what was typed in a field both share (Brand) is kept', await page.inputValue('#pd-brand') === 'Sunbell');
    await page.selectOption('#pd-condition', 'New');
    await cont(page);
    ok('on to Review: Save Product is now the main button, plus Save hidden', J(await visibleSteps(page)) === '[5]'
      && !(await page.$eval('#save-product-btn', (b) => b.classList.contains('pf-save-early'))) && await shown(page, '#pf-save-hidden'));
    const review = await page.textContent('#pf-review');
    ok('the review says it is not saved yet', /Preview - not saved yet/.test(review));
    ok('...and lists name, category, price, details and who can see it', /Tuna in oil 185g/.test(review) && /Electronics/.test(review) && /\$2\.50/.test(review)
      && /Brand\s*Sunbell/.test(review) && /Condition\s*New/.test(review) && /Visible to shoppers once saved/.test(review), review);
    const meter = await page.textContent('#pf-quality');
    ok('listing quality is shown with what would help (never blocking)', /Listing quality: \d+%/.test(meter) && /A cover photo/.test(meter) && /description/.test(meter), meter);
    ok('the shopper card preview is open on Review', await page.$eval('#card-preview', (d) => d.open) && (await page.$$('#card-preview-slot .product-card, #card-preview-slot article')).length > 0);
    await page.click('#save-product-btn');
    await page.waitForFunction(() => document.getElementById('product-form-section').classList.contains('hidden'), null, { timeout: 8000 });
    const created = posted.find((b) => b.action === 'createProduct');
    ok('Save sends the details for this category only (no Storage from food)', created && J(created.details) === J({ brand: 'Sunbell', condition: 'New', availability: 'Ready now' }), J(created && created.details));
    ok('...status Active as chosen', created && created.status === 'active');
    ok('no page errors', errors.length === 0, errors.join('; '));
    await ctx.close();
  }

  // ---------- one page; Save hidden; rentals and services ----------
  {
    const { ctx, page, posted } = await open(browser);
    await page.click('#add-product-btn');
    await page.click('.pf-mode-btn[data-mode="page"]');
    ok('Quick add (one page) shows all five sections and no Back/Continue', J(await visibleSteps(page)) === '[1,2,3,4,5]' && !(await shown(page, '#pf-next')) && !(await shown(page, '#pf-back')));
    ok('...and is remembered on this device', await page.evaluate(() => localStorage.getItem('mwk_pform_mode')) === 'page');
    await page.fill('#product-name', 'Car wash');
    await page.selectOption('#product-listing-type', 'service');
    await page.selectOption('#product-category', { index: 1 });
    let keys = await page.$$eval('#pf-details [data-detail]', (els) => els.map((e) => e.dataset.detail));
    ok('a Service gets service details: area, duration, how it is priced, booking notes', J(keys) === J(['serviceArea', 'duration', 'pricingModel', 'bookingNotes']), J(keys));
    await page.selectOption('#product-listing-type', 'rental');
    keys = await page.$$eval('#pf-details [data-detail]', (els) => els.map((e) => e.dataset.detail));
    ok('a Rental gets rental details: condition, deposit, duration, booking notes', J(keys) === J(['condition', 'deposit', 'duration', 'bookingNotes']), J(keys));
    await page.selectOption('#product-listing-type', 'product');
    await page.selectOption('#product-category', 'home');
    await page.fill('#product-name', 'Woven mat');
    await page.check('input[name="productType"][value="single"]');
    await page.fill('#single-price', '40');
    await page.click('#pf-save-hidden');
    await page.waitForFunction(() => document.getElementById('product-form-section').classList.contains('hidden'), null, { timeout: 8000 });
    const created = posted.filter((b) => b.action === 'createProduct').pop();
    ok('"Save hidden (draft)" saves it as Hidden - not shown to shoppers', created && created.status === 'hidden', J(created && created.status));
    await page.click('#add-product-btn');
    ok('the next new listing opens on one page (remembered)', J(await visibleSteps(page)) === '[1,2,3,4,5]');
    await page.click('#cancel-product-btn');
    await page.click('.owner-product-row[data-product-id="p_rice"] [data-action="edit"]');
    ok('editing an existing listing always opens on one page', J(await visibleSteps(page)) === '[1,2,3,4,5]');
    ok('...with its saved details filled in', await page.inputValue('#pd-netQuantity') === '1kg');
    await ctx.close();
  }

  // ---------- an error on another step is opened for the seller ----------
  {
    const { ctx, page } = await open(browser);
    await page.click('#add-product-btn');
    await fillBasics(page, 'Coconut oil 500ml');
    await page.click('#save-product-btn');
    await page.waitForTimeout(300);
    ok('Save from step 1 with no price opens Price & stock and points at the price', J(await visibleSteps(page)) === '[3]'
      && await page.evaluate(() => document.activeElement.id) === 'single-price', J(await visibleSteps(page)));
    await ctx.close();
  }

  // ---------- likely duplicates ----------
  {
    const { ctx, page, posted } = await open(browser);
    await page.click('#add-product-btn');
    await fillBasics(page, 'Jasmine Rice 1 kg');
    await cont(page);
    await page.waitForSelector('#pf-similar:not([hidden])', { timeout: 4000 }).catch(() => {});
    ok('a listing like one the seller already has: Continue stops once on a note', J(await visibleSteps(page)) === '[1]'
      && await page.isVisible('#pf-similar') && /You may already have this listing/.test(await page.textContent('#pf-similar')), await page.textContent('#pf-similar'));
    ok('...the check asked only about this seller\'s products (token, name, category)', posted.some((b) => b.action === 'findSimilarProducts' && b.token === 'test-token' && b.category === 'food'));
    await cont(page);
    ok('...Continue again carries on (never blocked)', J(await visibleSteps(page)) === '[2]');
    await page.click('.pf-progress-btn[data-go="5"]').catch(() => {});
    await page.click('.pf-progress-btn[data-go="1"]');
    await page.click('#pf-similar [data-open-product="p_rice"]');
    await page.waitForTimeout(300);
    ok('"Open it" opens that listing to edit', await page.inputValue('#product-id') === 'p_rice' && await page.inputValue('#product-name') === 'Jasmine rice 1kg');
    await page.click('#cancel-product-btn');
    await page.click('#add-product-btn');
    await fillBasics(page, 'Jasmine Rice 25kg');
    await cont(page);
    await page.waitForTimeout(400);
    ok('a different size gets no note', await page.locator('#pf-similar').isHidden());
    await ctx.close();
  }

  // ---------- unsaved work kept on this device ----------
  {
    const { ctx, page } = await open(browser);
    await page.click('#add-product-btn');
    await fillBasics(page, 'Pandanus hat');
    await page.fill('#product-description', 'Hand woven in Abaiang');
    await page.waitForTimeout(1100);
    const keys = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.indexOf('mwk_pdraft_v1:') === 0));
    ok('typing keeps a copy on this device, under this seller\'s id', J(keys) === J(['mwk_pdraft_v1:o1:new']), J(keys));
    ok('...and says so plainly - not saved to Mwakete', /kept on this device/.test(await page.textContent('#pf-autosave')) && /Not on Mwakete until you save/.test(await page.textContent('#pf-autosave')));
    const stored = await page.evaluate(() => localStorage.getItem('mwk_pdraft_v1:o1:new'));
    ok('...with no token or password in it', !/test-token/.test(stored) && !/token/i.test(stored), stored.slice(0, 120));
    await page.click('#cancel-product-btn');
    await page.click('#add-product-btn');
    ok('reopening offers to restore it', await shown(page, '#pf-draft-banner') && /Pandanus hat/.test(await page.textContent('#pf-draft-banner')));
    await page.click('#pf-draft-restore');
    ok('Restore brings back what was typed', await page.inputValue('#product-name') === 'Pandanus hat' && await page.inputValue('#product-description') === 'Hand woven in Abaiang'
      && await page.inputValue('#product-category') === 'food');
    await page.reload({ waitUntil: 'load' });
    await page.waitForSelector('.owner-product-row');
    await page.click('#add-product-btn');
    ok('...it survives a reload or a dropped connection', await shown(page, '#pf-draft-banner'));
    await page.click('#pf-draft-discard');
    ok('Discard removes it', await page.evaluate(() => !localStorage.getItem('mwk_pdraft_v1:o1:new')));
    await fillBasics(page, 'Shell necklace');
    await page.waitForTimeout(1100);
    await page.evaluate(() => Auth.clearSession());
    ok('logging out removes every kept listing from the device', await page.evaluate(() => !Object.keys(localStorage).some((k) => k.indexOf('mwk_pdraft_v1:') === 0)));
    await ctx.close();
  }
  {
    // Another seller on the same phone never sees the first seller's copy.
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const { ctx: c2, page } = await open(browser, { owner: { ownerId: 'o2', storeName: 'Other Store' } });
    await page.evaluate(() => localStorage.setItem('mwk_pdraft_v1:o1:new', JSON.stringify({ v: 1, at: Date.now(), f: { name: 'Secret listing' } })));
    await page.click('#add-product-btn');
    ok('a different seller signed in on the same device is not offered it', await page.locator('#pf-draft-banner').isHidden());
    await c2.close(); await ctx.close();
  }

  // ---------- a draft made against an older version says so ----------
  {
    const { ctx, page } = await open(browser);
    await page.evaluate(() => localStorage.setItem('mwk_pdraft_v1:o1:p_rice', JSON.stringify({ v: 1, at: Date.now() - 60000, base: '["old"]',
      f: { name: 'Jasmine rice 1kg - promo', listingType: 'product', category: 'food', status: 'active' }, editor: { productType: 'single', variants: [{ variantId: 'v_rice', status: 'active', price: '2.8', stockQty: '10' }] }, rows: [], details: {} })));
    await page.click('.owner-product-row[data-product-id="p_rice"] [data-action="edit"]');
    ok('editing: a kept copy made against an older version warns before restoring', /was changed on Mwakete since then/.test(await page.textContent('#pf-draft-banner')));
    await page.click('#pf-draft-restore');
    ok('...restoring brings the name and the price back', await page.inputValue('#product-name') === 'Jasmine rice 1kg - promo' && await page.inputValue('#single-price') === '2.8');
    await ctx.close();
  }

  // ---------- details lists match the server ----------
  {
    const gs = fs.readFileSync(__dirname + '/../apps-script/ProductDetails.gs', 'utf8');
    const js = fs.readFileSync(__dirname + '/../assets/js/owner-product-steps.js', 'utf8');
    const lists = (src) => {
      const out = {}; const re = /(\w+): \{ label: '([^']+)'[^}]*?(?:options: \[([^\]]+)\])?[^}]*\}/g; let m;
      while ((m = re.exec(src))) out[m[1]] = [m[2], m[3] ? m[3].replace(/\s/g, '') : ''];
      return out;
    };
    const a = lists(gs.slice(gs.indexOf('PRODUCT_DETAIL_FIELDS'), gs.indexOf('PRODUCT_DETAIL_ORDER')));
    const b = lists(js.slice(js.indexOf('const FIELDS'), js.indexOf('const SETS')));
    ok('every detail key, label and list matches ProductDetails.gs', Object.keys(a).length === 22 && J(a) === J(b), J(Object.keys(a).filter((k) => J(a[k]) !== J(b[k]))));
  }

  // ---------- layout ----------
  for (const vp of [{ width: 360, height: 800 }, { width: 390, height: 844 }, { width: 768, height: 1024 }, { width: 1366, height: 768 }, { width: 1920, height: 1080 }]) {
    for (const pref of ['steps', 'page']) {
      const { ctx, page, errors } = await open(browser, { viewport: vp, pref });
      await page.click('#add-product-btn');
      await fillBasics(page, 'Layout check');
      if (pref === 'steps') { await page.click('.pf-progress-btn[data-go="4"]').catch(() => {}); }
      const g = await page.evaluate(() => {
        const over = document.documentElement.scrollWidth > window.innerWidth + 1;
        const offRight = Array.from(document.querySelectorAll('#product-form input, #product-form select, #product-form button, #product-form textarea'))
          .filter((e) => e.offsetParent && e.getBoundingClientRect().right > window.innerWidth + 1).map((e) => e.id || e.className);
        return { over, offRight };
      });
      ok(`${vp.width}px ${pref}: no sideways scroll, no control off the edge`, !g.over && !g.offRight.length, J(g));
      ok(`${vp.width}px ${pref}: no page errors`, errors.length === 0, errors.join('; '));
      await ctx.close();
    }
  }

  await browser.close();
  let f = 0; console.log('\n--- guided product form (browser) ---');
  for (const [s, n, e] of R) { if (s === 'FAIL') f++; console.log(`${s}  ${n}${e && s === 'FAIL' ? '  [' + e + ']' : ''}`); }
  console.log(`\n${R.length - f}/${R.length} passed`);
  process.exit(f ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
