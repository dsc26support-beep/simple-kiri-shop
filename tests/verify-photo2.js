/**
 * Second product photos: no longer uploadable, still shown, now removable.
 *
 * THE ASSERTION THAT MATTERS MOST is that an ordinary edit does NOT send
 * imageUrl2. updateProduct keeps the stored value when the key is absent and
 * clears it when the key is present and empty - so a payload that always
 * included it would wipe the second photo off every product on its first edit,
 * silently, with the vendor seeing a normal successful save.
 *
 * Everything else here is the visible behaviour: the upload field is gone, the
 * existing photo still shows for products that have one, and Cancel really
 * cancels.
 */
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = process.env.AUDIT_BASE || 'http://127.0.0.1:8099';
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('PASS  ' + name + (detail ? '  [' + detail + ']' : '')); }
  else { fail++; console.log('FAIL  ' + name + (detail ? '  [' + detail + ']' : '')); }
};

const WITH_2 = {
  productId: 'p1', name: 'Radio', description: '', category: 'electronics',
  status: 'active', imageUrl: 'https://res.cloudinary.com/x/a.jpg',
  imageUrl2: 'https://res.cloudinary.com/x/b.jpg',
  variants: [{ variantId: 'v1', label: 'Small', price: 10, status: 'active' }]
};
const WITHOUT_2 = Object.assign({}, WITH_2, { productId: 'p2', name: 'Lamp', imageUrl2: '' });

async function open(browser) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const posted = [];
  await ctx.route('**/macros/s/**', (route) => {
    let b = {};
    try { b = route.request().postDataJSON() || {}; } catch (e) {}
    if (b.action) posted.push(b);
    let body = { ok: true };
    if (b.action === 'getOwnerProfile') body = { ok: true, owner: { storeName: 'Test Store' } };
    else if (b.action === 'listOwnerProducts') {
      body = { ok: true, products: [WITH_2, WITHOUT_2], total: 2, hasMore: false };
    } else if (b.action === 'updateProduct') body = { ok: true, productId: b.productId };
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  const page = await ctx.newPage();
  await page.addInitScript(() => { try {
    localStorage.setItem('skiri_owner_token', 'test-token');
    localStorage.setItem('skiri_cookie_consent', 'true');
  } catch (e) {} });
  await page.goto(BASE + '/owner/products.html', { waitUntil: 'load' });
  await page.waitForTimeout(1400);
  return { ctx, page, posted };
}

// Opens the edit form for the product whose name matches. Rows carry
// data-product-id and the button is [data-action="edit"] - matching on those
// rather than on text, which an earlier version of this did and failed on.
async function edit(page, productId) {
  const sel = `.owner-product-row[data-product-id="${productId}"] [data-action="edit"]`;
  const btn = await page.$(sel);
  if (!btn) return false;
  await btn.click();
  await page.waitForSelector('#product-form-section:not(.hidden)', { timeout: 4000 }).catch(() => {});
  await page.waitForTimeout(500);
  return true;
}

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

  // ---- the upload field is gone ------------------------------------------
  {
    const { ctx, page } = await open(browser);
    await page.click('#add-product-btn');
    await page.waitForSelector('#product-form-section:not(.hidden)');
    ok('there is no second-photo upload input any more',
      (await page.locator('#product-image-input-2').count()) === 0);
    ok('the first photo input is still there',
      (await page.locator('#product-image-input').count()) === 1);
    ok('a NEW product shows no second-photo block at all',
      await page.locator('#existing-photo2-field').isHidden());
    ok('and the helper text no longer promises two photos',
      !/up to 2 photos/i.test(await page.textContent('#product-form') || ''));
    await ctx.close();
  }

  // ---- a product that HAS one still shows it ------------------------------
  {
    const { ctx, page } = await open(browser);
    const found = await edit(page, 'p1');
    ok('opened the product that has a second photo', found);
    if (found) {
      ok('its second photo is shown', await page.locator('#existing-photo2-field').isVisible());
      const src = await page.getAttribute('#image-preview-2', 'src');
      ok('and it is the stored one', /\/x\/b\.jpg/.test(src || ''), String(src));
      ok('with a way to remove it', await page.locator('#remove-photo2-btn').isVisible());
    }
    await ctx.close();
  }

  // ---- a product WITHOUT one shows nothing --------------------------------
  {
    const { ctx, page } = await open(browser);
    const found = await edit(page, 'p2');
    ok('opened the product with no second photo', found);
    if (found) {
      ok('no second-photo block for it', await page.locator('#existing-photo2-field').isHidden());
    }
    await ctx.close();
  }

  // ---- THE ONE THAT MATTERS: an ordinary edit must not touch it -----------
  {
    const { ctx, page, posted } = await open(browser);
    const found = await edit(page, 'p1');
    ok('opened it again for an ordinary edit', found);
    if (found) {
      await page.fill('#product-name', 'Radio Mk2');
      await page.click('#save-product-btn');
      await page.waitForTimeout(1200);
      const save = posted.filter((b) => b.action === 'updateProduct').pop();
      ok('an ordinary save reaches the backend', !!save, JSON.stringify(save || {}).slice(0, 80));
      // Absent means "keep what is stored". Present-and-empty means "delete it".
      ok('and it does NOT mention imageUrl2, so the stored photo survives',
        save && !('imageUrl2' in save), JSON.stringify(save && save.imageUrl2));
    }
    await ctx.close();
  }

  // ---- removing it does send the clear ------------------------------------
  {
    const { ctx, page, posted } = await open(browser);
    const found = await edit(page, 'p1');
    if (found) {
      await page.click('#remove-photo2-btn');
      await page.waitForTimeout(300);
      ok('tapping Remove hides the photo straight away',
        await page.locator('#existing-photo2-field').isHidden());
      ok('and that counts as an unsaved change',
        await page.evaluate(() => typeof UnsavedGuard === 'undefined' || UnsavedGuard.isDirty()));

      await page.click('#save-product-btn');
      await page.waitForTimeout(1200);
      const save = posted.filter((b) => b.action === 'updateProduct').pop();
      ok('saving after Remove sends an empty imageUrl2',
        save && save.imageUrl2 === '', JSON.stringify(save && save.imageUrl2));
    }
    await ctx.close();
  }

  // ---- Cancel really cancels ---------------------------------------------
  {
    const { ctx, page, posted } = await open(browser);
    const found = await edit(page, 'p1');
    if (found) {
      await page.click('#remove-photo2-btn');
      await page.waitForTimeout(250);
      await page.click('#cancel-product-btn');
      await page.waitForTimeout(400);
      ok('Cancel after Remove sends nothing at all',
        posted.filter((b) => b.action === 'updateProduct').length === 0);
      // Re-open: the photo must be back, not half-removed in memory.
      await edit(page, 'p1');
      ok('and the photo is still there on re-open',
        await page.locator('#existing-photo2-field').isVisible());
    }
    await ctx.close();
  }

  await browser.close();

  // ---- shoppers keep the gallery: that code is deliberately untouched -----
  const fs = require('fs');
  const card = fs.readFileSync('/home/user/simple-kiri-shop/assets/js/product-card.js', 'utf8');
  ok('the shopper-side two-photo gallery still exists', /imageUrl2/.test(card));
  ok('and still renders thumbnails for it', /product-gallery-thumb/.test(card));
  const images = fs.readFileSync('/home/user/simple-kiri-shop/apps-script/Images.gs', 'utf8');
  ok('the backend slot-2 path is untouched, so nothing stored becomes unreadable',
    /slot === 2 \? 'ImageUrl2'/.test(images));

  console.log('\n' + pass + '/' + (pass + fail) + ' passed');
  process.exit(fail ? 1 : 0);
})();
