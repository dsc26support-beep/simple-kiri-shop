// Wholesalers: the store-type choice at sign-up and its verification-call
// notice, Food & Groceries limited to wholesalers in the product form, the
// pending-verification banner, and the admin verification queue.
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const fs = require('fs');
const vm = require('vm');
const BASE = process.env.AUDIT_BASE || 'http://127.0.0.1:8099';
const REPO = '/home/user/simple-kiri-shop/';
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e === undefined ? '' : e]);

function ownerFixture(storeType, verified) {
  return { ownerId: 'o1', storeSlug: 'tst', storeName: 'Test Store', storeType, wholesaleVerified: !!verified, isAdmin: true };
}

async function page(browser, path, opts) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const posted = [];
  await ctx.route('**/macros/s/**', (r) => {
    let body = {}; try { body = JSON.parse(r.request().postData() || '{}'); } catch (e) {}
    posted.push(body);
    const J = (o) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
    if (body.action === 'getOwnerProfile') return J({ ok: true, owner: ownerFixture(opts.storeType, opts.verified) });
    if (body.action === 'registerOwner') return J({ ok: true, token: 't', owner: ownerFixture(body.storeType, false) });
    if (body.action === 'listOwnerProducts') return J({ ok: true, total: 1, hasMore: false, products: [
      { productId: 'pf', name: 'Rice 20kg', description: '', category: 'food', listingType: 'product', status: 'active', imageUrl: '',
        variants: [{ variantId: 'v1', label: 'Bag', price: 30, stockQty: '', status: 'active' }] }] });
    if (body.action === 'listWholesalers') return J({ ok: true, wholesalers: opts.wholesalers || [] });
    if (body.action === 'setWholesaleVerified') {
      const w = (opts.wholesalers || []).find((x) => x.ownerId === body.ownerId); if (w) w.verified = body.verified;
      return J({ ok: true });
    }
    return J({ ok: true, stores: [], featured: [], sellers: [], config: {} });
  });
  const pg = await ctx.newPage();
  await pg.addInitScript((tok) => { localStorage.setItem('skiri_cookie_consent', 'true'); if (tok) localStorage.setItem('skiri_owner_token', 'tok'); }, opts.signedIn !== false);
  await pg.goto(BASE + path, { waitUntil: 'load' });
  await pg.waitForTimeout(700);
  return { ctx, pg, posted };
}

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

  /* ---- sign-up: choice, notice, payload ---- */
  {
    const { ctx, pg, posted } = await page(browser, '/owner/login.html?tab=register', { signedIn: false });
    await pg.evaluate(() => { const t = document.getElementById('tab-register'); if (t) t.click(); });
    await pg.waitForTimeout(200);
    ok('Retailer is the default', await pg.isChecked('input[name="storeType"][value="retailer"]'));
    ok('the verification notice is hidden for a retailer', await pg.locator('#wholesaler-note').isHidden());
    await pg.check('input[name="storeType"][value="wholesaler"]');
    ok('picking Wholesaler shows the verification-call notice at once',
      await pg.locator('#wholesaler-note').isVisible() && /verification call/i.test(await pg.textContent('#wholesaler-note')));
    await pg.check('input[name="storeType"][value="retailer"]');
    ok('switching back hides it again', await pg.locator('#wholesaler-note').isHidden());
    await pg.check('input[name="storeType"][value="wholesaler"]');
    await pg.fill('#register-store-name', 'Bulk Foods');
    await pg.fill('#register-username', 'bulkfoods');
    await pg.fill('#register-password', 'longpassword1');
    await pg.fill('#register-email', 'b@example.com');
    await pg.fill('#register-phone', '73012345');
    await pg.fill('#register-messenger', 'bulk.foods');
    await pg.click('#register-submit-btn');
    await pg.waitForTimeout(600);
    const reg = posted.find((p) => p.action === 'registerOwner');
    ok('the choice is sent with the registration', reg && reg.storeType === 'wholesaler', JSON.stringify(reg));
    await ctx.close();
  }

  /* ---- product form: Food only for wholesalers ---- */
  const foodOffered = (pg) => pg.$$eval('#product-category option', (os) => os.some((o) => o.value === 'food'));
  {
    const { ctx, pg } = await page(browser, '/owner/products.html', { storeType: 'retailer' });
    await pg.click('#add-product-btn'); await pg.selectOption('#product-listing-type', 'product'); await pg.waitForTimeout(150);
    ok('a retailer is not offered Food & Groceries for a new listing', !(await foodOffered(pg)));
    ok('...and is told why', await pg.locator('#food-wholesale-hint').isVisible());
    await pg.click('.owner-product-row[data-product-id="pf"] [data-action="edit"]'); await pg.waitForTimeout(200);
    ok('editing their existing Food listing keeps it in Food (grandfathered)', (await pg.$eval('#product-category', (s) => s.value)) === 'food');
    await pg.click('.owner-product-row[data-product-id="pf"] [data-action="duplicate"]'); await pg.waitForTimeout(200);
    ok('a duplicate of it is a NEW listing, so it must leave Food', (await pg.$eval('#product-category', (s) => s.value)) === '' && !(await foodOffered(pg)));
    await ctx.close();
  }
  {
    const { ctx, pg } = await page(browser, '/owner/products.html', { storeType: 'wholesaler', verified: false });
    await pg.click('#add-product-btn'); await pg.selectOption('#product-listing-type', 'product'); await pg.waitForTimeout(150);
    ok('a wholesaler is offered Food & Groceries (verification not required to list)', await foodOffered(pg));
    ok('...with no wholesale hint', await pg.locator('#food-wholesale-hint').isHidden());
    await ctx.close();
  }

  /* ---- pending banner ---- */
  for (const [label, storeType, verified, want] of [['unverified wholesaler', 'wholesaler', false, true], ['verified wholesaler', 'wholesaler', true, false], ['retailer', 'retailer', false, false]]) {
    const { ctx, pg } = await page(browser, '/owner/dashboard.html', { storeType, verified });
    ok(`dashboard banner for ${label}: ${want ? 'shown' : 'not shown'}`, (await pg.$('.wholesale-pending-banner') !== null) === want);
    await ctx.close();
  }

  /* ---- admin queue ---- */
  {
    const wholesalers = [
      { ownerId: 'w1', storeName: 'Bulk Foods', phone: '73012345', email: 'b@example.com', createdAt: '2026-10-05T00:00:00Z', verified: false },
      { ownerId: 'w2', storeName: 'Island Wholesale', phone: '63000000', email: 'i@example.com', createdAt: '2026-09-01T00:00:00Z', verified: true }
    ];
    const { ctx, pg, posted } = await page(browser, '/owner/admin.html', { storeType: 'retailer', wholesalers });
    const rows = await pg.$$eval('.wholesale-row', (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ')));
    ok('admin lists the wholesalers', rows.length === 2, JSON.stringify(rows));
    ok('...showing which still need the call', /Call pending/.test(rows[0]) && /Verified/.test(rows[1]), JSON.stringify(rows));
    ok('...with a tap-to-call phone link', await pg.$('.wholesale-row a[href="tel:73012345"]') !== null);
    await pg.click('.wholesale-row [data-owner-id="w1"]'); await pg.waitForTimeout(400);
    const call = posted.find((p) => p.action === 'setWholesaleVerified');
    ok('Mark Verified sends the right store', call && call.ownerId === 'w1' && call.verified === true, JSON.stringify(call));
    await ctx.close();
  }
  await browser.close();

  /* ---- backend: the Food rule in actionCreateOrUpdateProduct ---- */
  {
    const src = fs.readFileSync(REPO + 'apps-script/Products.gs', 'utf8');
    const guard = src.match(/  if \(category === 'food' && storeTypeOf\(owner\) !== 'wholesaler'\) \{[\s\S]*?\n  \}\n/)[0];
    const admin = fs.readFileSync(REPO + 'apps-script/Admin.gs', 'utf8');
    const storeTypeOf = admin.match(/function storeTypeOf[\s\S]*?\n}/)[0];
    const run = (owner, body, priorRow) => {
      const box = { owner, body, category: 'food', fail: (m) => ({ ok: false, error: m }),
        getSheet: () => ({}), findRowById: () => priorRow || null, categoryIdOf: (c) => c, result: null };
      vm.createContext(box);
      vm.runInContext(storeTypeOf + '\nresult = (function(){' + guard + ' return { ok: true }; })();', box);
      return box.result;
    };
    ok('server: a retailer cannot file a NEW listing in Food', run({ OwnerId: 'o', StoreType: '' }, {}).ok === false);
    ok('server: nor move an existing listing INTO Food', run({ OwnerId: 'o', StoreType: 'retailer' }, { productId: 'p' }, { OwnerId: 'o', Category: 'home' }).ok === false);
    ok('server: but can keep editing a listing already in Food', run({ OwnerId: 'o', StoreType: '' }, { productId: 'p' }, { OwnerId: 'o', Category: 'food' }).ok === true);
    ok('server: someone else\'s Food listing id does not grandfather anything', run({ OwnerId: 'o', StoreType: '' }, { productId: 'p' }, { OwnerId: 'other', Category: 'food' }).ok === false);
    ok('server: a wholesaler (verified or not) can list in Food', run({ OwnerId: 'o', StoreType: 'wholesaler' }, {}).ok === true);
  }

  let f = 0; for (const [s, n, x] of R) { if (s === 'FAIL') f++; console.log(`${s}  ${n}${x !== '' ? '  [' + x + ']' : ''}`); }
  console.log(`\n${R.length - f}/${R.length} passed`);
  process.exit(f ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
