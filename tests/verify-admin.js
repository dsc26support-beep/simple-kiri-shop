const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = 'http://127.0.0.1:8099';
const results = [];
const ok = (n, c, e) => results.push([c ? 'PASS' : 'FAIL', n, e || '']);

function mount(ctx, opts, posted) {
  return ctx.route('**/macros/s/**', (route) => {
    let action = '', body = {};
    try { body = route.request().postDataJSON() || {}; action = body.action; } catch (e) {}
    try { if (!action) action = new URL(route.request().url()).searchParams.get('action') || ''; } catch (e) {}
    if (action) posted.push({ action, body });
    let out = { ok: true };
    if (action === 'getOwnerProfile') out = { ok: true, owner: { storeName: 'Bong', storeSlug: 'bong', status: 'active', isAdmin: !!opts.admin } };
    else if (action === 'listStores') out = { ok: true, stores: [{ storeSlug: 'bong', storeName: 'Bong' }, { storeSlug: 'kv', storeName: 'KV' }] };
    else if (action === 'listProducts') out = { ok: true, products: [{ productId: 'p1', name: 'Rice' }, { productId: 'p2', name: 'Kayak' }] };
    else if (action === 'listFeatured') out = opts.admin ? { ok: true, featured: opts.featured || [] } : { ok: false, error: 'Not authorized' };
    else if (action === 'addFeatured') out = { ok: true };
    else if (action === 'removeFeatured') out = { ok: true };
    else if (action === 'listOwnerProducts') out = { ok: true, products: [] };
    else if (action === 'listOwnerOrders') out = { ok: true, orders: [], total: 0 };
    else if (action === 'listOwnerBookings') out = { ok: true, bookings: [] };
    else if (action === 'getUnreadCount') out = { ok: true, count: 0 };
    else if (action === 'getTips') out = { ok: opts.tipsOk !== false, products: opts.tipsProducts || [], stores: opts.tipsStores || [], error: 'boom' };
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(out) });
  });
}

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

  // Non-admin owner: admin page shows denied; dashboard hides admin link
  {
    const ctx = await browser.newContext(); const posted = [];
    await mount(ctx, { admin: false }, posted);
    const page = await ctx.newPage();
    await page.addInitScript(() => { try { localStorage.setItem('skiri_owner_token', 't'); localStorage.setItem('skiri_cookie_consent', 'true'); } catch (e) {} });
    await page.goto(BASE + '/owner/admin.html', { waitUntil: 'load' });
    await page.waitForFunction(() => !document.getElementById('admin-denied').classList.contains('hidden') || !document.getElementById('admin-tools').classList.contains('hidden'));
    const denied = await page.evaluate(() => !document.getElementById('admin-denied').classList.contains('hidden') && document.getElementById('admin-tools').classList.contains('hidden'));
    ok('non-admin sees access-denied, tools hidden', denied);
    await page.goto(BASE + '/owner/dashboard.html', { waitUntil: 'load' });
    await page.waitForSelector('#store-status-toggle');
    ok('non-admin dashboard hides Admin link', await page.evaluate(() => document.getElementById('admin-link-wrap').classList.contains('hidden')));
    await ctx.close();
  }

  // Admin owner: tools + list + add store/product + remove; dashboard shows link
  {
    const ctx = await browser.newContext({ viewport: { width: 700, height: 900 } }); const posted = [];
    await mount(ctx, { admin: true, featured: [{ featuredId: 'f1', type: 'store', refId: 'bong', label: 'Bong', sortOrder: 1 }] }, posted);
    const page = await ctx.newPage();
    await page.addInitScript(() => { try { localStorage.setItem('skiri_owner_token', 't'); localStorage.setItem('skiri_cookie_consent', 'true'); } catch (e) {} });
    await page.goto(BASE + '/owner/admin.html', { waitUntil: 'load' });
    await page.waitForFunction(() => !document.getElementById('admin-tools').classList.contains('hidden'));
    await page.waitForSelector('#featured-list .dash-item');
    ok('admin sees tools + current featured', await page.evaluate(() => document.querySelectorAll('#featured-list .dash-item').length === 1));

    // feature a store
    await page.selectOption('#store-select', 'kv');
    await page.click('#feature-store-btn');
    await page.waitForTimeout(80);
    ok('feature store calls addFeatured{store}', posted.some(p => p.action === 'addFeatured' && p.body.type === 'store' && p.body.refId === 'kv'));

    // feature a product: pick store -> products load -> pick -> feature
    await page.selectOption('#prod-store-select', 'bong');
    await page.waitForFunction(() => document.querySelectorAll('#product-select option').length > 1);
    await page.selectOption('#product-select', 'p2');
    await page.click('#feature-product-btn');
    await page.waitForTimeout(80);
    ok('feature product calls addFeatured{product}', posted.some(p => p.action === 'addFeatured' && p.body.type === 'product' && p.body.refId === 'p2'));

    // remove
    await page.click('#featured-list [data-remove="f1"]');
    await page.waitForTimeout(80);
    ok('remove calls removeFeatured', posted.some(p => p.action === 'removeFeatured' && p.body.featuredId === 'f1'));

    await page.goto(BASE + '/owner/dashboard.html', { waitUntil: 'load' });
    await page.waitForSelector('#store-status-toggle');
    ok('admin dashboard shows Admin link', await page.evaluate(() => !document.getElementById('admin-link-wrap').classList.contains('hidden')));
    await ctx.close();
  }

  // Tips page: renders + empty + error
  {
    const ctx = await browser.newContext({ viewport: { width: 500, height: 900 } }); const posted = [];
    await mount(ctx, { tipsProducts: [{ productId: 'p1', name: 'Rice', storeSlug: 'bong', storeName: 'Bong', category: 'pantry', variants: [{ variantId: 'v1', label: '1kg', price: 6 }] }], tipsStores: [{ storeSlug: 'kv', storeName: 'KV', logoUrl: '' }] }, posted);
    const page = await ctx.newPage();
    await page.goto(BASE + '/customer-tips.html', { waitUntil: 'load' });
    await page.waitForSelector('#tips-products .product-card, #tips-stores .logo-carousel-item');
    const st = await page.evaluate(() => ({
      products: document.querySelectorAll('#tips-products .product-card').length,
      stores: document.querySelectorAll('#tips-stores .logo-carousel-item').length,
      storesShown: !document.getElementById('tips-stores-wrap').classList.contains('hidden'),
      productsShown: !document.getElementById('tips-products-wrap').classList.contains('hidden'),
    }));
    ok('tips renders featured product + store', st.products === 1 && st.stores === 1 && st.storesShown && st.productsShown, JSON.stringify(st));
    await ctx.close();
  }
  {
    const ctx = await browser.newContext(); const posted = [];
    await mount(ctx, { tipsProducts: [], tipsStores: [] }, posted);
    const page = await ctx.newPage();
    await page.goto(BASE + '/customer-tips.html', { waitUntil: 'load' });
    await page.waitForFunction(() => document.getElementById('tips-status').textContent.length > 0);
    ok('tips empty shows "No featured items yet."', /No featured items/.test(await page.textContent('#tips-status')));
    await ctx.close();
  }
  {
    const ctx = await browser.newContext(); const posted = [];
    await mount(ctx, { tipsOk: false }, posted);
    const page = await ctx.newPage();
    await page.goto(BASE + '/customer-tips.html', { waitUntil: 'load' });
    await page.waitForFunction(() => /refresh|Refresh/.test(document.getElementById('tips-status').textContent));
    ok('tips error shows refresh state', /refresh|Refresh/.test(await page.textContent('#tips-status')));
    await ctx.close();
  }

  await browser.close();
  let failed = 0;
  console.log('\n--- Phase 4: admin back-office + Tips ---');
  for (const [s, n, e] of results) { if (s === 'FAIL') failed++; console.log(`${s}  ${n}${e ? '  [' + e + ']' : ''}`); }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
