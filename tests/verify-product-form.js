// Owner product form: 44px buttons, required markers, inline field errors, description counter.
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = process.env.AUDIT_BASE || 'http://127.0.0.1:8099';
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e === undefined ? '' : e]);
(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 } });
  const posted = [];
  await ctx.route('**/macros/s/**', (r) => {
    let body = {}; try { body = JSON.parse(r.request().postData() || '{}'); } catch (e) {}
    posted.push(body.action);
    const J = (o) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
    if (body.action === 'getOwnerProfile') return J({ ok: true, owner: { ownerId: 'o1', storeSlug: 'tst', storeName: 'Test Store' } });
    if (body.action === 'listOwnerProducts') return J({ ok: true, products: [{ productId: 'p1', name: 'Pandanus mat', description: 'Hand woven', category: 'handicrafts', listingType: 'product', status: 'active', imageUrl: '', variants: [{ variantId: 'v1', label: 'Large', price: 40, stockQty: 3, status: 'active' }] }], total: 1, hasMore: false });
    if (body.action === 'createProduct') return J({ ok: true, productId: 'p2' });
    return J({ ok: true });
  });
  const pg = await ctx.newPage();
  const errs = []; pg.on('pageerror', (e) => errs.push(e.message));
  await pg.addInitScript(() => { localStorage.setItem('skiri_owner_token', 'tok'); localStorage.setItem('skiri_cookie_consent', 'true'); });
  await pg.goto(BASE + '/owner/products.html', { waitUntil: 'load' });
  await pg.waitForTimeout(700);

  // 1. buttons
  const heights = await pg.$$eval('.btn-small', (els) => els.filter((e) => e.offsetParent).map((e) => Math.round(e.getBoundingClientRect().height)));
  ok('visible small buttons are >= 44px tall', heights.length > 0 && heights.every((h) => h >= 44), JSON.stringify(heights));

  await pg.click('#add-product-btn'); await pg.waitForTimeout(300);
  const h2 = await pg.$$eval('#product-form .btn-small', (els) => els.filter((e) => e.offsetParent).map((e) => Math.round(e.getBoundingClientRect().height)));
  ok('form buttons (+ Add Variety, Remove) >= 44px', h2.every((h) => h >= 44), JSON.stringify(h2));

  // 2. required markers
  const star = await pg.evaluate(() => getComputedStyle(document.querySelector('label[for="product-name"]'), '::after').content);
  ok('Product Name shows a required star', /\*/.test(star), star);
  ok('label text itself is untouched', (await pg.textContent('label[for="product-name"]')) === 'Product Name');
  ok('required note is shown', /Required/.test(await pg.textContent('.form-required-note')));

  // 2. field errors, top to bottom
  const errFor = (sel) => pg.evaluate((s) => {
    const el = document.querySelector(s);
    const id = el.getAttribute('aria-describedby');
    return { invalid: el.getAttribute('aria-invalid'), msg: id ? document.getElementById(id).textContent : null,
      focused: document.activeElement === el, count: document.querySelectorAll('.field-error').length };
  }, sel);
  await pg.click('#save-product-btn'); await pg.waitForTimeout(200);
  let e = await errFor('#product-name');
  ok('empty submit: error sits on Product Name', e.invalid === 'true' && /name/i.test(e.msg || ''), JSON.stringify(e));
  ok('and focus is on it', e.focused);
  ok('only one error at a time', e.count === 1, e.count);
  ok('the bottom alert stays empty', (await pg.textContent('#product-form-error')) === '');
  await pg.fill('#product-name', 'Coconut oil');
  e = await errFor('#product-name');
  ok('typing clears it', e.invalid === null && e.count === 0, JSON.stringify(e));

  await pg.click('#save-product-btn'); await pg.waitForTimeout(200);
  ok('next: listing type', (await errFor('#product-listing-type')).invalid === 'true');
  // A service: since product options (Oct 2026) a new PRODUCT starts as a
  // Single product with its own price field (verify-product-options.js); the
  // row-by-row varieties checked below are the rentals' and services' list.
  await pg.selectOption('#product-listing-type', 'service');
  await pg.click('#save-product-btn'); await pg.waitForTimeout(200);
  ok('next: category', (await errFor('#product-category')).invalid === 'true');
  const firstCat = await pg.$eval('#product-category', (s) => [...s.options].find((o) => o.value).value);
  await pg.selectOption('#product-category', firstCat);

  await pg.fill('.variant-label', '500ml');
  await pg.fill('.variant-price', '0');
  await pg.click('#save-product-btn'); await pg.waitForTimeout(200);
  e = await errFor('.variant-price');
  ok('price 0: error on the price input', e.invalid === 'true' && /greater than zero/.test(e.msg || ''), JSON.stringify(e));
  const msgParent = await pg.evaluate(() => document.querySelector('.field-error').parentElement.className);
  ok('row message spans the row, not the narrow column', msgParent === 'variant-row', msgParent);
  await pg.fill('.variant-price', '6.5');
  await pg.fill('.variant-stock', '2.5');
  await pg.click('#save-product-btn'); await pg.waitForTimeout(200);
  ok('fractional stock: error on stock input', (await errFor('.variant-stock')).invalid === 'true');
  await pg.fill('.variant-stock', '10');

  // 3. description counter
  await pg.fill('#product-description', 'a'.repeat(1700));
  ok('counter hidden well under the limit', await pg.locator('#description-count').isHidden());
  await pg.fill('#product-description', 'a'.repeat(1900));
  ok('counter appears near the limit', /100 characters left/.test(await pg.textContent('#description-count')), await pg.textContent('#description-count'));
  await pg.fill('#product-description', 'a'.repeat(2050));
  ok('over the limit: red, says by how much', (await pg.getAttribute('#description-count', 'class')).includes('is-over') && /50 characters over/.test(await pg.textContent('#description-count')), await pg.textContent('#description-count'));
  await pg.click('#save-product-btn'); await pg.waitForTimeout(200);
  ok('over-length description blocks save with its own error', (await errFor('#product-description')).invalid === 'true' && !posted.includes('createProduct'));
  await pg.fill('#product-description', 'Cold-pressed, local.');

  await pg.click('#save-product-btn'); await pg.waitForTimeout(500);
  ok('a valid form saves', posted.includes('createProduct'), JSON.stringify(posted));
  ok('no page errors', errs.length === 0, errs.join(' | '));

  let f = 0; for (const [s, n, x] of R) { if (s === 'FAIL') f++; console.log(`${s}  ${n}${x !== '' ? '  [' + x + ']' : ''}`); }
  console.log(`\n${R.length - f}/${R.length} passed`);
  await b.close();
  process.exit(R.some(([st]) => st === 'FAIL') ? 1 : 0);
})();
