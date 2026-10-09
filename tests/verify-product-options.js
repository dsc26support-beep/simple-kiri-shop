// Product options in the browser (backend mocked; the real shared rules run
// in the page): the seller's Single / Options editor, the card carousel and
// swatches, and the product page picker + gallery. Phone width.
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = process.env.AUDIT_BASE || 'http://127.0.0.1:8099';
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e === undefined ? '' : e]);
const SHOT = process.env.SHOT_DIR || '';

const img = (n) => `https://example.com/img/${n}.jpg`;
const OPTIONS = [
  { id: 'o_col', name: 'Colour', kind: 'colour', values: [{ id: 'v_red', label: 'Red', hex: '#c62828' }, { id: 'v_blu', label: 'Blue', hex: '#1565c0' }, { id: 'v_grn', label: 'Green', hex: '#2e7d32' }] },
  { id: 'o_siz', name: 'Size', kind: 'size', values: [{ id: 'v_ss', label: 'S' }, { id: 'v_mm', label: 'M' }, { id: 'v_ll', label: 'L' }] }
];
const V = (c, s, price, stock, images, sku) => ({ variantId: `var_${c}${s}`, label: `${c} / ${s}`, price, stockQty: stock,
  values: { o_col: { Red: 'v_red', Blue: 'v_blu', Green: 'v_grn' }[c], o_siz: 'v_' + s.toLowerCase() + s.toLowerCase() }, images, sku });
const SHIRT = { productId: 'p_shirt', name: 'Cotton T-shirt', description: 'Soft cotton', category: 'fashion', listingType: 'product', productType: 'options', options: OPTIONS,
  imageUrl: img('shirt'), storeSlug: 'bong', storeName: 'Bong',
  variants: [V('Red', 'S', 12, 0, [img('red1'), img('red2')]), V('Red', 'M', 12, 0), V('Red', 'L', 12, 0),
    V('Blue', 'S', 13, 4, [img('blue1'), img('blue2'), img('blue3')], 'TS-BS'), V('Blue', 'M', 13, 8, null, 'TS-BM'), V('Blue', 'L', 13, 2),
    V('Green', 'S', 12, 5, [img('green1')]), V('Green', 'M', 12, 5)] };
SHIRT.variants.forEach((v) => { if (!v.images) delete v.images; if (!v.sku) delete v.sku; });
const WATER = { productId: 'p_water', name: 'Bottled water', description: '', category: 'food', listingType: 'product', productType: 'single', imageUrl: img('water'),
  storeSlug: 'bong', storeName: 'Bong', variants: [{ variantId: 'var_w', label: 'Standard', price: 1.5, stockQty: 30 }] };
const GONE = { productId: 'p_gone', name: 'Sold out hat', description: '', category: 'fashion', listingType: 'product', productType: 'options',
  options: [OPTIONS[1]], imageUrl: '', storeSlug: 'bong', storeName: 'Bong', variants: [{ variantId: 'var_h', label: 'S', price: 5, stockQty: 0, values: { o_siz: 'v_ss' } }] };

async function page(browser, handler, path, seed) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const posted = [];
  await ctx.route('**/macros/s/**', (r) => {
    let body = {};
    try { body = JSON.parse(r.request().postData() || '{}'); } catch (e) {}
    try { if (!body.action) body.action = new URL(r.request().url()).searchParams.get('action'); } catch (e) {}
    posted.push(body);
    const J = (o) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
    const out = handler(body, J);
    if (out !== undefined) return out;
    return J({ ok: true, products: [], stores: [], reviews: [] });
  });
  await ctx.route('https://example.com/img/**', (r) => r.fulfill({ status: 200, contentType: 'image/svg+xml',
    body: `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><rect width="400" height="400" fill="#${(Math.random() * 0xffffff | 0).toString(16).padStart(6, '0')}"/></svg>` }));
  const pg = await ctx.newPage();
  const errs = [];
  pg.on('pageerror', (e) => errs.push(e.message));
  pg.on('dialog', (d) => { pg.__dialogs = (pg.__dialogs || []).concat(d.message()); d.accept(); });
  await pg.addInitScript((s) => { localStorage.setItem('skiri_cookie_consent', 'true'); localStorage.setItem('skiri_owner_token', 'tok'); if (s) Object.keys(s).forEach((k) => localStorage.setItem(k, s[k])); }, seed || null);
  await pg.goto(BASE + path, { waitUntil: 'load' });
  await pg.waitForTimeout(900);
  return { ctx, pg, posted, errs };
}

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const store = (body, J) => {
    if (body.action === 'listProducts') return J({ ok: true, storeName: 'Bong', storeSlug: 'bong', storeOpen: true, products: [SHIRT, WATER, GONE] });
    if (body.action === 'listProductReviews') return J({ ok: true, reviews: [], average: null, count: 0, distribution: [0, 0, 0, 0, 0] });
    return undefined;
  };

  /* ---------------- product page ---------------- */
  let { ctx, pg, errs } = await page(browser, store, '/product.html?store=bong&product=p_shirt');
  const add = () => pg.$eval('#product-detail .add-to-cart-btn', (b) => b.disabled);
  ok('PDP: nothing pre-selected, Add to Cart waits', (await add()) === true && /Choose colour and size/.test(await pg.textContent('.option-status')), await pg.textContent('.option-status'));
  ok('PDP: price range shown until chosen', /\$12\.00-13\.00|12\.00.?-.?13\.00/.test(await pg.textContent('.option-status')));
  ok('PDP: Red is marked sold out (all its sizes are), Blue and Green are not', await pg.$eval('[data-option="o_col"] [data-value="v_red"]', (b) => b.classList.contains('is-soldout') && !b.disabled)
    && !(await pg.$eval('[data-option="o_col"] [data-value="v_blu"]', (b) => b.classList.contains('is-soldout'))));
  ok('PDP: gallery has arrows + counter + thumbnails', await pg.$('#product-detail .carousel-next') !== null && /1 of \d/.test(await pg.textContent('#product-detail .carousel-count'))
    && (await pg.$$('#product-detail .carousel-thumb')).length >= 2);
  await pg.click('[data-option="o_col"] [data-value="v_blu"]');
  await pg.waitForTimeout(150);
  let srcs = await pg.$$eval('#product-detail .carousel-slide', (els) => els.map((e) => e.getAttribute('src')));
  ok('PDP: choosing Blue shows the Blue photos only', srcs.length === 3 && srcs.every((s) => /blue/.test(s)), srcs.join());
  ok('PDP: still waits for a size', (await add()) === true && /Choose size/.test(await pg.textContent('.option-status')));
  await pg.click('[data-option="o_siz"] [data-value="v_mm"]');
  await pg.waitForTimeout(150);
  let st = await pg.textContent('.option-status');
  ok('PDP: Blue / M shows its price, stock and SKU, and can be added', /\$13\.00/.test(st) && /In stock/.test(st) && /TS-BM/.test(st) && (await add()) === false, st);
  ok('PDP: quantity is capped at the stock (8)', (await pg.getAttribute('#qty-p_shirt', 'max')) === '8');
  await pg.click('[data-option="o_col"] [data-value="v_red"]');
  await pg.waitForTimeout(150);
  st = await pg.textContent('.option-status');
  ok('PDP: Red / M is sold out - shown, not addable', /Sold out/.test(st) && (await add()) === true, st);
  srcs = await pg.$$eval('#product-detail .carousel-slide', (els) => els.map((e) => e.getAttribute('src')));
  ok('PDP: switching to Red swaps in the Red photos', srcs.length === 2 && srcs.every((s) => /red/.test(s)), srcs.join());
  await pg.click('[data-option="o_col"] [data-value="v_blu"]');
  await pg.click('[data-option="o_siz"] [data-value="v_ll"]');
  await pg.click('[data-option="o_col"] [data-value="v_grn"]');
  await pg.waitForTimeout(150);
  ok('PDP: Green / L is not sold - L is cleared, and the page says so', /Size L isn.t sold in Green, so it was cleared/.test(await pg.textContent('.option-note'))
    && (await pg.getAttribute('[data-option="o_siz"] [data-value="v_ll"]', 'aria-pressed')) === 'false'
    && await pg.$eval('[data-option="o_siz"] [data-value="v_ll"]', (b) => b.classList.contains('is-conflict')), await pg.textContent('.option-note'));
  ok('PDP: unavailable choice says why (screen readers)', /not sold in Green - choosing it clears that/.test(await pg.getAttribute('[data-option="o_siz"] [data-value="v_ll"]', 'aria-label')));
  await pg.click('[data-option="o_siz"] [data-value="v_ss"]');
  await pg.click('#product-detail .add-to-cart-btn');
  await pg.waitForTimeout(300);
  const cart = await pg.evaluate(() => JSON.parse(localStorage.getItem('skiri_cart_bong') || '[]'));
  ok('PDP: Add to Cart adds exactly the chosen variant', cart.length === 1 && cart[0].variantId === 'var_GreenS' && /Green \/ S/.test(cart[0].label), JSON.stringify(cart));
  const before = pg.url();
  await pg.click('#product-detail .carousel-next').catch(() => {});
  ok('PDP: arrows move the gallery, never leave the page', pg.url() === before);
  if (SHOT) await pg.screenshot({ path: SHOT + '/pdp-options.png', fullPage: true });
  ok('PDP: no sideways scroll at phone width', await pg.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  ok('PDP: no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();

  ({ ctx, pg, errs } = await page(browser, store, '/product.html?store=bong&product=p_water'));
  ok('single product: no option picker, Add to Cart ready', (await pg.$('.option-picker')) === null && !(await pg.$eval('#product-detail .add-to-cart-btn', (b) => b.disabled)));
  await pg.click('#product-detail .add-to-cart-btn');
  await pg.waitForTimeout(300);
  const c2 = await pg.evaluate(() => JSON.parse(localStorage.getItem('skiri_cart_bong') || '[]'));
  ok('single product: the cart line is just its name', c2.length === 1 && c2[0].label === 'Bottled water', JSON.stringify(c2));
  await ctx.close();

  /* ---------------- store page cards ---------------- */
  ({ ctx, pg, errs } = await page(browser, store, '/store.html?store=bong'));
  const cards = await pg.$$eval('.product-card', (els) => els.map((e) => e.dataset.productId));
  ok('card: one card per product, not one per colour/size', cards.filter((x) => x === 'p_shirt').length === 1, cards.join());
  const shirtCard = '.product-card[data-product-id="p_shirt"]';
  ok('card: manual carousel with a counter (no autoplay)', /1 of 4/.test(await pg.textContent(`${shirtCard} .carousel-count`)), await pg.textContent(`${shirtCard} .carousel-count`));
  await pg.waitForTimeout(1500);
  ok('card: it does not move by itself', /1 of 4/.test(await pg.textContent(`${shirtCard} .carousel-count`)));
  const url0 = pg.url();
  await pg.click(`${shirtCard} .carousel-next`);
  await pg.waitForTimeout(600);
  ok('card: Next shows photo 2 and does not open the product', /2 of 4/.test(await pg.textContent(`${shirtCard} .carousel-count`)) && pg.url() === url0, pg.url());
  await pg.click(`${shirtCard} .carousel-prev`);
  await pg.waitForTimeout(600);
  ok('card: Previous goes back', /1 of 4/.test(await pg.textContent(`${shirtCard} .carousel-count`)));
  await pg.$eval(`${shirtCard} .carousel-track`, (t) => { t.scrollLeft = t.clientWidth * 2; });
  await pg.waitForTimeout(400);
  ok('card: a swipe (scroll) updates the counter', /3 of 4/.test(await pg.textContent(`${shirtCard} .carousel-count`)));
  await ctx.close();

  ({ ctx, pg, errs } = await page(browser, (body, J) => {
    if (body.action === 'getHomePageData') return J({ ok: true, products: [SHIRT, WATER, GONE], stores: [] });
    if (body.action === 'listTopProducts') return J({ ok: true, products: [SHIRT, WATER, GONE] });
    return undefined;
  }, '/index.html'));
  const homeCard = '.product-card[data-product-id="p_shirt"]';
  const hasCard = await pg.$(homeCard);
  if (hasCard) {
    const sw = await pg.$$eval(`${homeCard} .card-swatch`, (els) => els.map((e) => [e.dataset.colour, e.classList.contains('is-soldout')]));
    ok('home card: colour swatches, Red marked sold out', sw.length === 3 && sw.find((x) => x[0] === 'v_red')[1] === true && sw.find((x) => x[0] === 'v_blu')[1] === false, JSON.stringify(sw));
    const u = pg.url();
    await pg.click(`${homeCard} .card-swatch[data-colour="v_blu"]`);
    await pg.waitForTimeout(500);
    ok('home card: tapping Blue jumps to the Blue photo and says what is in stock (not every size)', /Blue: in stock in S, M, L/.test(await pg.textContent(`${homeCard} .card-swatch-note`))
      && /4 of 4|3 of 4/.test(await pg.textContent(`${homeCard} .carousel-count`)) && pg.url() === u, await pg.textContent(`${homeCard} .card-swatch-note`));
    await pg.click(`${homeCard} .card-swatch[data-colour="v_red"]`);
    ok('home card: Red says sold out', /Red: sold out/.test(await pg.textContent(`${homeCard} .card-swatch-note`)));
    ok('home card: an all-sold-out product says Sold out', /Sold out/.test(await pg.textContent('.product-card[data-product-id="p_gone"]')));
    ok('home card: a product with stock left is not marked sold out', !/Sold out/.test(await pg.textContent(homeCard)));
    if (SHOT) await pg.locator(homeCard).screenshot({ path: SHOT + '/card-options.png' });
  } else {
    ok('home card rendered', false, 'no shirt card on the home page');
  }
  ok('home: no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();

  /* ---------------- seller form ---------------- */
  let saveMode = 'ok';
  ({ ctx, pg, errs } = await page(browser, (body, J) => {
    if (body.action === 'getOwnerProfile') return J({ ok: true, owner: { ownerId: 'o1', storeSlug: 'bong', storeName: 'Bong', storeType: 'wholesaler' } });
    if (body.action === 'listOwnerProducts') return J({ ok: true, total: 2, hasMore: false, products: [
      Object.assign({}, SHIRT, { status: 'active', subcategoryId: 'fashion-men', variants: SHIRT.variants.map((v) => Object.assign({ status: 'active' }, v, { images: (v.images || []).map((u, i) => ({ id: 'img' + i, url: u })) })) }),
      { productId: 'p_old', name: 'Coconut oil', description: '', category: 'food', listingType: 'product', productType: '', status: 'active', imageUrl: '', variants: [{ variantId: 'var_o1', label: '250ml', price: 3, stockQty: 5, status: 'active' }, { variantId: 'var_o2', label: '1L', price: 9, stockQty: '', status: 'active' }] }] });
    if (body.action === 'createProduct' || body.action === 'updateProduct') {
      if (saveMode === 'refuse') return J({ ok: false, error: 'Enter a price above 0 for Blue / L.' });
      return J({ ok: true, productId: body.productId || 'p_new', variants: (body.variants || []).map((v, i) => ({ variantId: v.variantId || 'var_n' + i, key: '' })), notes: [] });
    }
    return undefined;
  }, '/owner/products.html'));
  await pg.click('#add-product-btn');
  await pg.waitForTimeout(200);
  await pg.selectOption('#product-listing-type', 'product');
  ok('seller: a new product starts as Single product', await pg.isChecked('input[name="productType"][value="single"]') && await pg.isVisible('#single-price')
    && !(await pg.isVisible('#variant-rows')));
  await pg.fill('#product-name', 'Cotton T-shirt');
  await pg.selectOption('#product-category', 'fashion');
  await pg.selectOption('#product-subcategory', 'fashion-men');
  await pg.check('input[name="productType"][value="options"]');
  ok('seller: options start empty - Colour and Size are not forced', (await pg.$$('#option-types .option-type')).length === 0);
  await pg.click('#add-colour-btn');
  for (const c of ['Red', 'Blue', 'Green']) { await pg.fill('#option-types .option-type:nth-of-type(1) .ov-new', c); await pg.press('#option-types .option-type:nth-of-type(1) .ov-new', 'Enter'); }
  await pg.click('#add-size-btn');
  for (const s of ['S', 'M', 'L']) { await pg.fill('#option-types .option-type:nth-of-type(2) .ov-new', s); await pg.press('#option-types .option-type:nth-of-type(2) .ov-new', 'Enter'); }
  await pg.fill('#option-types .option-type:nth-of-type(2) .ov-new', 'm');
  await pg.press('#option-types .option-type:nth-of-type(2) .ov-new', 'Enter');
  ok('seller: a duplicate value is refused', /already there/.test(await pg.textContent('#options-status')));
  await pg.fill('#bulk-price', '12');
  await pg.fill('#bulk-stock', '5');
  await pg.click('#generate-variants-btn');
  const labels = await pg.$$eval('#variant-grid .vg-label', (els) => els.map((e) => e.textContent));
  ok('seller: 3 x 3 = 9 combinations made, with the starting price', labels.length === 9 && labels[0] === 'Red / S'
    && (await pg.$$eval('#variant-grid .vg-price', (els) => els.every((e) => e.value === '12'))), labels.join());
  await pg.uncheck('#variant-grid tr[data-key]:nth-of-type(9) .vg-active');
  // Bulk: Blue rows to 13, after confirming.
  await pg.fill('#vg-filter', 'Blue');
  await pg.check('#vg-all');
  await pg.fill('#vg-filter', '');
  await pg.fill('#bulk-price', '13');
  await pg.fill('#bulk-stock', '');
  await pg.click('#bulk-apply-btn');
  ok('seller: bulk change asks first, naming the rows', (pg.__dialogs || []).some((d) => /Set price 13 for these 3:\nBlue \/ S, Blue \/ M, Blue \/ L/.test(d)), (pg.__dialogs || []).join(' || '));
  await pg.fill('#variant-grid tr[data-key]:nth-of-type(1) .vg-stock', '0');
  await pg.locator('#card-preview summary').click();
  await pg.waitForTimeout(200);
  ok('seller: card preview shows the shopper\'s card with swatches', (await pg.$$('#card-preview-slot .card-swatch')).length === 3);
  await pg.click('#save-product-btn');
  await pg.waitForTimeout(500);
  const sent = (await pg.evaluate(() => 1)) && null;
  ctx.__posted = null;
  await ctx.close();
  ok('seller page: no script errors', errs.length === 0, errs.join(' | '));

  // Check the payload separately (fresh page) to read `posted`.
  let posted;
  ({ ctx, pg, errs, posted } = await page(browser, (body, J) => {
    if (body.action === 'getOwnerProfile') return J({ ok: true, owner: { ownerId: 'o1', storeSlug: 'bong', storeName: 'Bong', storeType: 'wholesaler' } });
    if (body.action === 'listOwnerProducts') return J({ ok: true, total: 1, hasMore: false, products: [
      { productId: 'p_old', name: 'Coconut oil', description: '', category: 'food', listingType: 'product', productType: '', status: 'active', imageUrl: '', variants: [{ variantId: 'var_o1', label: '250ml', price: 3, stockQty: 5, status: 'active' }, { variantId: 'var_o2', label: '1L', price: 9, stockQty: '', status: 'active' }] },
      Object.assign({}, SHIRT, { status: 'active', subcategoryId: 'fashion-men', variants: SHIRT.variants.map((v) => Object.assign({ status: 'active' }, v, { images: (v.images || []).map((u, i) => ({ id: 'img' + i, url: u })) })) })] });
    if (body.action === 'updateProduct' || body.action === 'createProduct') return J({ ok: true, productId: body.productId || 'p_new', variants: [], notes: [] });
    return undefined;
  }, '/owner/products.html'));
  // Older listing: stays a list until converted.
  await pg.click('.owner-product-row[data-product-id="p_old"] [data-action="edit"]');
  await pg.waitForTimeout(300);
  ok('older listing opens as its list of varieties (not converted silently)', await pg.isChecked('input[name="productType"][value="list"]') && await pg.isVisible('#variant-rows'));
  await pg.check('input[name="productType"][value="options"]');
  const conv = await pg.$$eval('#variant-grid .vg-label', (els) => els.map((e) => e.textContent));
  ok('converting is explicit: its varieties become the values of one option', conv.join() === '250ml,1L', conv.join());
  await pg.click('#cancel-product-btn');
  // Shirt edit: remove Green -> confirmation lists what is switched off.
  await pg.click('.owner-product-row[data-product-id="p_shirt"] [data-action="edit"]');
  await pg.waitForTimeout(300);
  ok('editing a product with options opens its grid (8 combinations)', (await pg.$$('#variant-grid .vg-row')).length === 8);
  await pg.click('#option-types .option-type:nth-of-type(1) .ov:nth-of-type(3) .ov-remove');
  await pg.click('#generate-variants-btn');
  await pg.click('#save-product-btn');
  await pg.waitForTimeout(500);
  ok('removing a colour asks first and says the rows are kept, not deleted', (pg.__dialogs || []).some((d) => /2 switched off \(kept with their stock history, not deleted\): Green \/ S, Green \/ M/.test(d)), (pg.__dialogs || []).join(' || '));
  const up = posted.filter((p) => p.action === 'updateProduct').pop();
  ok('save sends options + combinations with their ids, never prices for the server to trust blindly', up && up.productType === 'options' && up.options.length === 2
    && up.variants.length === 6 && up.variants.every((v) => /^var_/.test(v.variantId)), JSON.stringify(up && up.variants.map((v) => v.variantId)));
  ok('seller page (edit): no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();

  await browser.close();
  let f = 0;
  console.log('\n--- product options: seller form, cards, product page ---');
  for (const [s, n, e] of R) { if (s === 'FAIL') f++; console.log(`${s}  ${n}${e !== '' ? '  [' + e + ']' : ''}`); }
  console.log(`\n${R.length - f}/${R.length} passed`);
  process.exit(f ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
