// Owner products: Duplicate starts a NEW listing from an existing one - everything but the photo.
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = process.env.AUDIT_BASE || 'http://127.0.0.1:8099';
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e === undefined ? '' : e]);
(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 } });
  const posted = [];
  await ctx.route('**/macros/s/**', (r) => {
    let body = {}; try { body = JSON.parse(r.request().postData() || '{}'); } catch (e) {}
    posted.push(body);
    const J = (o) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
    if (body.action === 'getOwnerProfile') return J({ ok: true, owner: { ownerId: 'o1', storeSlug: 'tst', storeName: 'Test Store' } });
    if (body.action === 'listOwnerProducts') return J({ ok: true, total: 2, hasMore: false, products: [
      { productId: 'p1', name: 'Pandanus mat', description: 'Hand woven', category: 'handicrafts', listingType: 'product', status: 'active',
        imageUrl: 'https://res.cloudinary.com/x/image/upload/mat.jpg', imageUrl2: 'https://res.cloudinary.com/x/image/upload/mat2.jpg',
        variants: [{ variantId: 'v1', label: 'Large', price: 40, stockQty: 3, status: 'active' }, { variantId: 'v2', label: 'Small', price: 25, stockQty: '', status: 'active' }, { variantId: 'v3', label: 'Old', price: 5, stockQty: '', status: 'deleted' }] },
      { productId: 'p9', name: 'Legacy thing', description: '', category: 'other', listingType: 'product', status: 'active', imageUrl: '',
        variants: [{ variantId: 'v9', label: 'One', price: 10, stockQty: '', status: 'active' }] }
    ] });
    if (body.action === 'createProduct') return J({ ok: true, productId: 'pNew' });
    return J({ ok: true });
  });
  const pg = await ctx.newPage();
  const errs = []; pg.on('pageerror', (e) => errs.push(e.message));
  await pg.addInitScript(() => { localStorage.setItem('skiri_owner_token', 'tok'); localStorage.setItem('skiri_cookie_consent', 'true'); });
  await pg.goto(BASE + '/owner/products.html', { waitUntil: 'load' });
  await pg.waitForTimeout(700);

  const row = (id) => `.owner-product-row[data-product-id="${id}"]`;
  ok('each row has a Duplicate button', (await pg.$$('[data-action="duplicate"]')).length === 2);
  const actionsFit = await pg.$eval(row('p1') + ' .row-actions', (el) => el.scrollWidth <= el.clientWidth + 1 && document.documentElement.scrollWidth <= window.innerWidth);
  ok('three buttons fit the row at 390px, no sideways scroll', actionsFit);

  await pg.click(row('p1') + ' [data-action="duplicate"]'); await pg.waitForTimeout(300);
  const f = await pg.evaluate(() => ({
    heading: document.getElementById('product-form-heading').textContent,
    id: document.getElementById('product-id').value,
    name: document.getElementById('product-name').value,
    desc: document.getElementById('product-description').value,
    type: document.getElementById('product-listing-type').value,
    cat: document.getElementById('product-category').value,
    rows: [...document.querySelectorAll('#variant-rows .variant-row')].map((r) => ({ id: r.dataset.variantId,
      label: r.querySelector('.variant-label').value, price: r.querySelector('.variant-price').value, stock: r.querySelector('.variant-stock').value })),
    previewHidden: document.getElementById('image-preview').classList.contains('hidden'),
    photo2Hidden: document.getElementById('existing-photo2-field').classList.contains('hidden'),
    noteShown: !document.getElementById('duplicate-photo-note').hidden
  }));
  ok('heading says Duplicate', f.heading === 'Duplicate: Pandanus mat', f.heading);
  ok('no product id, so Save creates', f.id === '');
  ok('name gets (copy)', f.name === 'Pandanus mat (copy)', f.name);
  ok('description, type, category copied', f.desc === 'Hand woven' && f.type === 'product' && f.cat === 'handicrafts', JSON.stringify([f.desc, f.type, f.cat]));
  ok('active varieties copied, deleted one left out', f.rows.length === 2 && f.rows.map((r) => r.label).join() === 'Large,Small', JSON.stringify(f.rows));
  ok('price and stock carried over', f.rows[0].price === '40' && f.rows[0].stock === '3' && f.rows[1].stock === '', JSON.stringify(f.rows));
  ok('no variant ids carried over', f.rows.every((r) => r.id === ''));
  ok('photo NOT copied (preview and second photo hidden)', f.previewHidden && f.photo2Hidden);
  ok('note tells the seller the photo is not copied', f.noteShown);

  await pg.click('#save-product-btn'); await pg.waitForTimeout(600);
  const create = posted.find((p) => p.action === 'createProduct');
  ok('Save calls createProduct, not updateProduct', !!create && !posted.some((p) => p.action === 'updateProduct'));
  ok('payload has no productId, imageUrl or variantIds', create && !create.productId && !('imageUrl' in create) && create.variants.every((v) => !v.variantId), JSON.stringify(create));
  ok('payload carries the copied varieties', create && JSON.stringify(create.variants.map((v) => [v.label, v.price, v.stockQty])) === JSON.stringify([['Large', 40, 3], ['Small', 25, '']]), JSON.stringify(create && create.variants));

  // legacy "Other" is not inherited by a new listing
  await pg.click(row('p9') + ' [data-action="duplicate"]'); await pg.waitForTimeout(300);
  ok('a duplicate of an "Other" listing must choose a real category', (await pg.$eval('#product-category', (s) => s.value)) === '');
  ok('and "Other" is not offered', !(await pg.$$eval('#product-category option', (os) => os.some((o) => o.value === 'other'))));

  // Edit afterwards is still a normal edit
  await pg.click(row('p1') + ' [data-action="edit"]'); await pg.waitForTimeout(300);
  const e = await pg.evaluate(() => ({ id: document.getElementById('product-id').value, name: document.getElementById('product-name').value,
    note: document.getElementById('duplicate-photo-note').hidden, vid: document.querySelector('#variant-rows .variant-row').dataset.variantId,
    preview: !document.getElementById('image-preview').classList.contains('hidden') }));
  ok('Edit after Duplicate is a normal edit again', e.id === 'p1' && e.name === 'Pandanus mat' && e.note && e.vid === 'v1' && e.preview, JSON.stringify(e));
  ok('no page errors', errs.length === 0, errs.join(' | '));

  let fl = 0; for (const [s, n, x] of R) { if (s === 'FAIL') fl++; console.log(`${s}  ${n}${x !== '' ? '  [' + x + ']' : ''}`); }
  console.log(`\n${R.length - fl}/${R.length} passed`);
  await b.close();
  process.exit(R.some(([st]) => st === 'FAIL') ? 1 : 0);
})();
