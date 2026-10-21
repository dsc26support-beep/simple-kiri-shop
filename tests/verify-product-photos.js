/**
 * Seller product photo gallery (owner-product-photos.js), in a real browser
 * against a stand-in backend that keeps each product's photos the way
 * Images.gs does. Replaces verify-photo2.js: the second photo can now be
 * replaced, which that test asserted was impossible.
 *
 * The assertions that matter most:
 *   - an ordinary edit sends NO photo calls and no photo fields, so it can
 *     never disturb the photos already there;
 *   - nothing is sent until Save, and Cancel really cancels;
 *   - a failed upload keeps the old photo and retries with the same requestId.
 */
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');
const BASE = process.env.AUDIT_BASE || 'http://127.0.0.1:8099';
const IMG = path.resolve(__dirname, '../assets/img');
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e === undefined ? '' : e]);
const J = (x) => JSON.stringify(x).slice(0, 300);

const PRODUCTS = [
  { productId: 'p1', name: 'Radio', description: '', category: 'electronics', listingType: 'product', status: 'active',
    imageUrl: 'https://res.cloudinary.com/x/image/upload/a.jpg', imageUrl2: 'https://res.cloudinary.com/x/image/upload/b.jpg',
    images: [{ id: 'main', url: 'https://res.cloudinary.com/x/image/upload/a.jpg' }, { id: 'second', url: 'https://res.cloudinary.com/x/image/upload/b.jpg' }],
    variants: [{ variantId: 'v1', label: 'Small', price: 10, status: 'active', stockQty: '' }] },
  { productId: 'p2', name: 'Lamp', description: '', category: 'home', listingType: 'product', status: 'active',
    imageUrl: 'https://res.cloudinary.com/x/image/upload/l1.jpg', imageUrl2: 'https://res.cloudinary.com/x/image/upload/l2.jpg',
    images: ['l1', 'l2', 'l3'].map((k) => ({ id: 'img_' + k, url: 'https://res.cloudinary.com/x/image/upload/' + k + '.jpg' })),
    variants: [{ variantId: 'v2', label: 'Standard', price: 15, status: 'active', stockQty: '' }] }
];

async function open(browser, opts) {
  opts = opts || {};
  const ctx = await browser.newContext({ viewport: opts.viewport || { width: 390, height: 844 }, hasTouch: !!opts.touch, isMobile: !!opts.touch });
  const posted = [];
  const galleries = {};
  PRODUCTS.forEach((p) => { galleries[p.productId] = p.images.slice(); });
  let failNext = opts.failUploads || 0;
  const seenReq = {};
  let n = 0;
  await ctx.route('**/macros/s/**', (route) => {
    let b = {};
    try { b = route.request().postDataJSON() || {}; } catch (e) {}
    if (b.action) posted.push(b);
    const reply = (body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (b.action === 'getOwnerProfile') return reply({ ok: true, owner: { storeName: 'Test Store', storeType: 'retailer', island: 'Abaiang' } });
    if (b.action === 'listOwnerProducts') return reply({ ok: true, products: PRODUCTS, total: PRODUCTS.length, hasMore: false, photoMax: 6 });
    if (b.action === 'createProduct') { galleries.p_new = []; return reply({ ok: true, productId: 'p_new', notes: [] }); }
    if (b.action === 'updateProduct') return reply({ ok: true, productId: b.productId, notes: [] });
    if (b.action === 'uploadProductPhoto') {
      const g = galleries[b.productId];
      if (failNext > 0) { failNext--; return reply({ ok: false, error: 'Network error - check your connection' }); }
      if (seenReq[b.requestId]) return reply({ ok: true, images: g, imageId: seenReq[b.requestId], replayed: true });
      const id = 'img_n' + (++n);
      const entry = { id, url: 'https://res.cloudinary.com/x/image/upload/new' + n + '.webp' };
      if (b.replaceId) { const at = g.findIndex((x) => x.id === b.replaceId); g[at] = entry; } else g.push(entry);
      seenReq[b.requestId] = id;
      return reply({ ok: true, images: g, imageId: id, max: 6 });
    }
    if (b.action === 'setProductPhotos') {
      const g = galleries[b.productId];
      const next = b.order.map((id) => g.find((x) => x.id === id));
      if (next.some((x) => !x)) return reply({ ok: false, error: 'Those photos changed. Please reload and try again.' });
      galleries[b.productId] = next;
      return reply({ ok: true, images: next, max: 6 });
    }
    return reply({ ok: true });
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('dialog', (d) => d.accept());
  await page.addInitScript(() => { try { localStorage.setItem('skiri_owner_token', 'test-token'); localStorage.setItem('skiri_cookie_consent', 'true'); } catch (e) {} });
  await page.goto(BASE + '/owner/products.html', { waitUntil: 'load' });
  await page.waitForSelector('.owner-product-row', { timeout: 6000 });
  return { ctx, page, posted, galleries, errors };
}

const edit = async (page, id) => {
  await page.click(`.owner-product-row[data-product-id="${id}"] [data-action="edit"]`);
  await page.waitForSelector('#product-form-section:not(.hidden)');
  await page.waitForTimeout(200);
};
const tiles = (page) => page.$$eval('#photo-list .pg-item', (els) => els.map((li) => ({
  src: li.querySelector('img').getAttribute('src'), cover: !!li.querySelector('.pg-cover'), status: (li.querySelector('.pg-status') || {}).textContent || '' })));
const save = async (page) => {
  await page.click('#save-product-btn');
  await page.waitForFunction(() => !document.getElementById('save-product-btn').disabled, null, { timeout: 15000 });
  await page.waitForTimeout(200);
};
const photoCalls = (posted) => posted.filter((b) => /ProductPhoto/.test(b.action));

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

  // ---- an older product's two photos, and an ordinary edit ----
  {
    const { ctx, page, posted, errors } = await open(browser);
    await edit(page, 'p1');
    const t = await tiles(page);
    ok('the gallery shows the product\'s photos, cover first and marked', t.length === 2 && t[0].cover && !t[1].cover && /a\.jpg/.test(t[0].src), J(t));
    ok('...with the count against the limit', /2 of 6/.test(await page.textContent('#photo-count')));
    ok('the old one-photo input and the remove-only second-photo block are gone',
      (await page.locator('#product-image-input, #existing-photo2-field').count()) === 0);
    await page.fill('#single-price, .variant-price >> nth=0', '12').catch(() => {});
    await save(page);
    const upd = posted.find((b) => b.action === 'updateProduct');
    ok('an ordinary edit makes no photo calls at all', photoCalls(posted).length === 0, J(photoCalls(posted)));
    ok('...and sends no photo fields (the server ignores them anyway)', upd && !('imageUrl' in upd) && !('imageUrl2' in upd) && !('imageFileId' in upd), J(upd));
    ok('no page errors', errors.length === 0, errors.join('; '));
    await ctx.close();
  }

  // ---- replacing the SECOND photo (the old limitation) ----
  {
    const { ctx, page, posted, galleries } = await open(browser);
    await edit(page, 'p1');
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('#photo-list .pg-item:nth-child(2) [data-act="replace"]')]);
    await chooser.setFiles(path.join(IMG, 'app-icon-192.png'));
    const t = await tiles(page);
    ok('Replace on photo 2 shows the new photo in its place, marked as waiting for Save', t.length === 2 && /^blob:/.test(t[1].src) && /Replaces the old photo/.test(t[1].status), J(t));
    ok('...nothing is sent before Save', photoCalls(posted).length === 0);
    await save(page);
    const ups = posted.filter((b) => b.action === 'uploadProductPhoto');
    ok('Save sends ONE upload that replaces "second" in place', ups.length === 1 && ups[0].replaceId === 'second' && ups[0].productId === 'p1', J(ups.map((u) => ({ r: u.replaceId, p: u.productId }))));
    ok('...made smaller in the browser: sent as WebP', ups[0] && ups[0].mimeType === 'image/webp', ups[0] && ups[0].mimeType);
    ok('...with a requestId so a retry is safe', ups[0] && /^[A-Za-z0-9_-]{8,}$/.test(ups[0].requestId));
    ok('...the cover is untouched and no reorder call is needed', galleries.p1[0].id === 'main' && !posted.some((b) => b.action === 'setProductPhotos'), J(galleries.p1));
    ok('...and the form closes as a normal save', await page.locator('#product-form-section').isHidden());
    await ctx.close();
  }

  // ---- cover, reorder, remove; Cancel cancels ----
  {
    const { ctx, page, posted, galleries } = await open(browser);
    await edit(page, 'p2');
    await page.click('#photo-list .pg-item:nth-child(2) [data-act="remove"]');
    ok('Remove takes the photo off the screen straight away', (await tiles(page)).length === 2);
    await page.click('#cancel-product-btn');
    ok('...but Cancel sends nothing', photoCalls(posted).length === 0);
    await edit(page, 'p2');
    ok('...and on reopening the photo is still there', (await tiles(page)).length === 3);

    await page.click('#photo-list .pg-item:nth-child(3) [data-act="cover"]');
    let t = await tiles(page);
    ok('Make cover moves photo 3 to the front and marks it Cover', /l3\.jpg/.test(t[0].src) && t[0].cover, J(t));
    await page.focus('#photo-list .pg-item:nth-child(2) [data-act="right"]');
    await page.keyboard.press('Enter');
    t = await tiles(page);
    ok('Move later works from the keyboard', /l2\.jpg/.test(t[1].src) && /l1\.jpg/.test(t[2].src), J(t));
    ok('...and keyboard focus stays on the moved photo', await page.evaluate(() => /l1\.jpg/.test(document.activeElement.closest('.pg-item').querySelector('img').getAttribute('src'))));
    await page.click('#photo-list .pg-item:nth-child(2) [data-act="remove"]');
    await save(page);
    const sets = posted.filter((b) => b.action === 'setProductPhotos');
    ok('Save sends the new order once, without the removed photo', sets.length === 1 && J(sets[0].order) === J(['img_l3', 'img_l1']), J(sets.map((s) => s.order)));
    ok('...no uploads for a reorder', !posted.some((b) => b.action === 'uploadProductPhoto'));
    ok('...the stand-in server now has exactly that', J(galleries.p2.map((g) => g.id)) === J(['img_l3', 'img_l1']));
    await ctx.close();
  }

  // ---- a new product with photos; the limit; HEIC ----
  {
    const { ctx, page, posted, galleries, errors } = await open(browser);
    await page.click('#add-product-btn');
    await page.selectOption('#product-listing-type', 'product');
    await page.waitForTimeout(100);
    await page.fill('#product-name', 'Woven basket');
    await page.selectOption('#product-category', 'home');
    await page.check('input[name="productType"][value="single"]').catch(() => {});
    await page.fill('#single-price', '25').catch(() => {});
    const files = Array.from({ length: 7 }, (_, i) => path.join(IMG, i % 2 ? 'apple-touch-icon-180.png' : 'app-icon-192.png'));
    await page.setInputFiles('#photo-input', files);
    ok('7 photos chosen: only 6 are added, and the seller is told', (await tiles(page)).length === 6 && /Only 6 more photos fit/.test(await page.textContent('#photo-msg')), await page.textContent('#photo-msg'));
    ok('...the Add buttons hide at the limit', await page.locator('#photo-add-row').isHidden());
    // Keep two for the save.
    for (let i = 0; i < 4; i++) await page.click('#photo-list .pg-item:last-child [data-act="remove"]');
    await save(page);
    const created = posted.find((b) => b.action === 'createProduct');
    const ups = posted.filter((b) => b.action === 'uploadProductPhoto');
    ok('a new product is created first, then its 2 photos go up', created && ups.length === 2 && ups.every((u) => u.productId === 'p_new' && !u.replaceId), J(ups.map((u) => u.productId)));
    ok('...each with its own requestId', ups.length === 2 && ups[0].requestId !== ups[1].requestId);
    ok('...in the order shown, first = cover', galleries.p_new.length === 2 && galleries.p_new[0].id === 'img_n1');
    ok('...no photo fields on createProduct', created && !('imageUrl' in created) && !('imageFileId' in created));
    ok('no page errors', errors.length === 0, errors.join('; '));
    await ctx.close();
  }

  // ---- a failed upload keeps everything and retries safely ----
  {
    const { ctx, page, posted, galleries } = await open(browser, { failUploads: 1 });
    await edit(page, 'p1');
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('#photo-list .pg-item:nth-child(1) [data-act="replace"]')]);
    await chooser.setFiles(path.join(IMG, 'app-icon-192.png'));
    await save(page);
    let t = await tiles(page);
    ok('a failed replacement: the form stays open and says the product saved but the photo did not', await page.locator('#product-form-section').isVisible()
      && /Product saved, but a photo did not upload/.test(await page.textContent('#product-form-error')), await page.textContent('#product-form-error'));
    ok('...the tile is marked "Didn\'t upload"', /Didn't upload/.test(t[0].status), J(t));
    ok('...and the OLD cover is still on the server', galleries.p1[0].id === 'main');
    const first = posted.filter((b) => b.action === 'uploadProductPhoto')[0].requestId;
    await save(page);
    const ups = posted.filter((b) => b.action === 'uploadProductPhoto');
    ok('Save again retries it with the SAME requestId', ups.length === 2 && ups[1].requestId === first && ups[1].replaceId === 'main', J(ups.map((u) => u.requestId)));
    ok('...and this time it is replaced and the form closes', galleries.p1[0].id !== 'main' && await page.locator('#product-form-section').isHidden());
    await ctx.close();
  }

  // ---- HEIC the browser can't read ----
  {
    const { ctx, page } = await open(browser);
    await edit(page, 'p1');
    await page.setInputFiles('#photo-input', { name: 'IMG_0001.HEIC', mimeType: 'image/heic', buffer: Buffer.from('not really an image, just bytes') });
    await save(page);
    const msg = await page.textContent('#product-form-error');
    ok('a HEIC photo the browser can\'t open gets a plain explanation', /HEIC/.test(msg) && /Most compatible/.test(msg), msg);
    await ctx.close();
  }

  // ---- Duplicate does not copy photos ----
  {
    const { ctx, page } = await open(browser);
    await page.click('.owner-product-row[data-product-id="p2"] [data-action="duplicate"]');
    await page.waitForSelector('#product-form-section:not(.hidden)');
    ok('Duplicate starts with no photos, and says so', (await tiles(page)).length === 0 && await page.locator('#duplicate-photo-note').isVisible());
    await ctx.close();
  }

  // ---- phone layout, camera button ----
  for (const vp of [{ width: 360, height: 800 }, { width: 768, height: 1024 }, { width: 1366, height: 768 }]) {
    const { ctx, page } = await open(browser, { viewport: vp, touch: vp.width < 700 });
    await edit(page, 'p2');
    const g = await page.evaluate(() => {
      const sec = document.getElementById('photo-section').getBoundingClientRect();
      const btns = Array.from(document.querySelectorAll('#photo-list .pg-actions .btn')).map((b) => b.getBoundingClientRect());
      return { overflow: document.documentElement.scrollWidth > window.innerWidth, inside: sec.right <= window.innerWidth + 0.5,
        minH: Math.min.apply(null, btns.map((b) => b.height)), camera: !document.getElementById('photo-camera-btn').hidden };
    });
    ok(`${vp.width}px: no sideways scroll, gallery fits`, !g.overflow && g.inside, J(g));
    ok(`${vp.width}px: photo buttons are at least 36px tall`, g.minH >= 36, g.minH);
    ok(`${vp.width}px: "Take a photo" only on touch screens`, g.camera === (vp.width < 700), J(g));
    await ctx.close();
  }

  // ---- shoppers see every photo ----
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const four = ['s1', 's2', 's3', 's4'].map((k) => 'https://res.cloudinary.com/x/image/upload/' + k + '.jpg');
    const prod = { productId: 'pg1', name: 'Shell lamp', description: 'x', category: 'home', listingType: 'product', status: 'active',
      imageUrl: four[0], imageUrl2: four[1], images: four, storeSlug: 'bong', storeName: 'Bong',
      variants: [{ variantId: 'v', label: 'Standard', price: 30, stockQty: null }] };
    await ctx.route('**/macros/s/**', (route) => {
      let a = ''; try { a = new URL(route.request().url()).searchParams.get('action') || ''; } catch (e) {}
      let b = {}; try { b = route.request().postDataJSON() || {}; } catch (e) {}
      a = a || b.action;
      const body = a === 'listProducts' ? { ok: true, storeName: 'Bong', products: [prod], storeOpen: true } : { ok: true, products: [] };
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });
    const page = await ctx.newPage();
    await page.addInitScript(() => { try { localStorage.setItem('skiri_cookie_consent', 'true'); } catch (e) {} });
    await page.goto(BASE + '/store.html?store=bong', { waitUntil: 'load' });
    await page.waitForSelector('.product-card', { timeout: 6000 });
    const srcs = await page.$$eval('.product-card img.product-image, .product-card img.carousel-slide', (els) => els.map((e) => e.getAttribute('src')));
    ok('store page: a product with 4 photos shows all 4 in its card gallery', four.every((u) => srcs.some((x) => x.indexOf(u.split('/').pop()) !== -1)), J(srcs));
    await ctx.close();
  }

  await browser.close();
  let f = 0; console.log('\n--- product photo gallery (browser) ---');
  for (const [s, n, e] of R) { if (s === 'FAIL') f++; console.log(`${s}  ${n}${e && s === 'FAIL' ? '  [' + e + ']' : ''}`); }
  console.log(`\n${R.length - f}/${R.length} passed`);
  process.exit(f ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
