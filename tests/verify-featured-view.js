/**
 * Featured at the top of the browse rail, the three new categories, and Other
 * off the seller's form.
 *
 * THE ASSERTION THAT MATTERS MOST is that Featured never becomes a place a
 * seller can file a listing. The Featured sheet is admin-curated precisely so
 * a seller cannot put themselves at the top of the rail; the moment 'featured'
 * is a storable category id, they can. So: it is absent from the seller's
 * dropdown, absent from the backend's id list, and a row that claims it lands
 * in Other on both sides.
 *
 * Second: the Featured view costs no extra request. loadFeatured() is already
 * in flight from init(), so tapping Featured must wait on that one rather than
 * asking for the same rows again on a connection that takes a second to answer.
 *
 * Third: Other is gone from the seller's picker WITHOUT stranding a listing
 * already filed in it. Dropping the option out from under such a product would
 * leave the picker empty on open and the save blocked by the "choose a
 * category" guard - so editing that listing's price would force a re-file.
 */
const fs = require('fs');
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = 'http://127.0.0.1:8099';
const REPO = '/home/user/simple-kiri-shop/';
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('PASS  ' + name + (detail ? '  [' + detail + ']' : '')); }
  else { fail++; console.log('FAIL  ' + name + (detail ? '  [' + detail + ']' : '')); }
};

const mk = (id, cat, name) => ({
  productId: id, name: name, category: cat, description: 'x', imageUrl: '',
  storeSlug: 'bong', storeName: 'Bong Store', island: 'South Tarawa', village: 'Bairiki',
  variants: [{ variantId: 'v' + id, label: 'one', price: 5 }],
  rating: null, reviewCount: 0, views: 0, createdAt: '2026-01-01'
});

// Deliberately spread across categories, and one carrying a LEGACY value:
// getTips emits the sheet's Category untouched, so the view has to map it the
// way renderFeatured already does or that item silently never appears.
const FEATURED = [
  mk('f1', 'solar', 'Solar Panel 200W'),
  mk('f2', 'hire', 'Hire a Truck'),
  mk('f3', 'pantry', 'Legacy Rice')
];

async function open(browser, path, opts) {
  opts = opts || {};
  const ctx = await browser.newContext({ viewport: { width: opts.width || 390, height: 844 } });
  const calls = [];
  await ctx.route('**/macros/s/**', async (r) => {
    let a = '', cat = null;
    try { const u = new URL(r.request().url()); a = u.searchParams.get('action') || ''; cat = u.searchParams.get('category'); } catch (e) {}
    try { const j = r.request().postDataJSON(); if (!a && j) a = j.action; } catch (e) {}
    calls.push({ action: a, category: cat });
    if (opts.tipsDelay && a === 'getTips') await new Promise((x) => setTimeout(x, opts.tipsDelay));
    const J = (o) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
    if (a === 'getTips') return J({ ok: true, products: opts.noFeatured ? [] : FEATURED, stores: [], tips: [] });
    if (a === 'searchProducts') return J({ ok: true, products: [mk('p-' + cat, cat, cat + ' item')] });
    if (a === 'listStores') return J({ ok: true, stores: [], hasMore: false, total: 0 });
    J({ ok: true });
  });
  const page = await ctx.newPage();
  await page.addInitScript(() => { try { localStorage.setItem('skiri_cookie_consent', 'true'); } catch (e) {} });
  await page.goto(BASE + path, { waitUntil: 'load' });
  await page.waitForTimeout(opts.settle || 900);
  return { ctx, page, calls };
}

const tiles = (page) => page.$$eval('#category-list a', (els) => els.map((e) => e.textContent.trim()));

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

  /* ---- Featured is not a filing place ---------------------------------- */
  {
    const helpers = fs.readFileSync(REPO + 'assets/js/helpers.js', 'utf8');
    const prod = fs.readFileSync(REPO + 'apps-script/Products.gs', 'utf8');
    const cats = helpers.match(/const CATEGORIES = \[([\s\S]*?)\n\];/)[1];
    ok('featured is not a member of CATEGORIES', !/id: 'featured'/.test(cats));
    ok('featured is not a storable id in Products.gs',
      !/CATEGORY_IDS = \[[\s\S]*?'featured'[\s\S]*?\];/.test(prod));
    ok('the three new categories are on BOTH sides', ['solar', 'hire', 'rental'].every((id) =>
      new RegExp("id: '" + id + "'").test(cats) &&
      new RegExp("CATEGORY_IDS = \\[[\\s\\S]*?'" + id + "'[\\s\\S]*?\\];").test(prod)));
  }

  /* ---- the rail ---------------------------------------------------------- */
  {
    const { ctx, page } = await open(browser, '/categories.html');
    const rail = await page.$$eval('.category-rail-item', (els) => els.map((e) => ({
      id: e.dataset.category, label: e.querySelector('.category-rail-label').textContent.trim()
    })));
    ok('Featured is the first rail entry', rail[0] && rail[0].id === 'featured' && rail[0].label === 'Featured',
      JSON.stringify(rail[0]));
    const ids = rail.map((r) => r.id);
    ok('the three new categories are on the rail, in order',
      ids.indexOf('solar') > 0 && ids.indexOf('hire') === ids.indexOf('solar') + 1 &&
      ids.indexOf('rental') === ids.indexOf('hire') + 1, ids.join(','));
    ok('Other is still on the rail, still last', ids[ids.length - 1] === 'other');
    ok('Featured is NOT the default landing - it can be empty on any given day',
      await page.evaluate(() => (document.querySelector('.category-rail-item.is-selected') || {}).dataset.category) === 'food');
    await ctx.close();
  }

  /* ---- tapping Featured -------------------------------------------------- */
  {
    const { ctx, page, calls } = await open(browser, '/categories.html');
    const before = calls.filter((c) => c.action === 'getTips').length;
    await page.click('.category-rail-item[data-category="featured"]');
    await page.waitForTimeout(500);

    const names = await tiles(page);
    ok('Featured shows every curated item, whatever category it is in',
      names.length === 3 && /Solar Panel/.test(names.join('|')) && /Hire a Truck/.test(names.join('|')),
      names.join(' | '));
    ok('...including one carrying a LEGACY category value',
      /Legacy Rice/.test(names.join('|')), names.join(' | '));
    ok('no second getTips request - it waits on the one already in flight',
      calls.filter((c) => c.action === 'getTips').length === before,
      before + ' -> ' + calls.filter((c) => c.action === 'getTips').length);
    ok('no searchProducts for a category that does not exist',
      !calls.some((c) => c.action === 'searchProducts' && c.category === 'featured'),
      JSON.stringify(calls.filter((c) => c.action === 'searchProducts').map((c) => c.category)));

    ok('the strip is hidden - the list IS the featured items',
      await page.$eval('#featured-strip', (el) => el.hidden === true));
    ok('the heading and title say Featured', await page.evaluate(() => ({
      h: document.getElementById('category-pane-heading').textContent.trim(),
      t: document.title
    })).then((r) => r.h === 'Featured' && /^Featured —/.test(r.t)));
    ok('the URL is shareable', /category=featured/.test(page.url()), page.url());
    ok('the rail marks it selected',
      await page.evaluate(() => (document.querySelector('.category-rail-item.is-selected') || {}).dataset.category) === 'featured');
    await ctx.close();
  }

  /* ---- and back off it again -------------------------------------------- */
  {
    const { ctx, page } = await open(browser, '/categories.html');
    await page.click('.category-rail-item[data-category="featured"]');
    await page.waitForTimeout(400);
    await page.click('.category-rail-item[data-category="solar"]');
    await page.waitForTimeout(600);
    const names = await tiles(page);
    ok('leaving Featured loads the real category', names.some((n) => /solar item/.test(n)), names.join(' | '));
    ok('and the strip comes back for that category',
      await page.$eval('#featured-strip', (el) => el.hidden === false));
    ok('the strip shows only THAT category\'s featured item',
      await page.$$eval('#featured-list a', (els) => els.length === 1 && /Solar Panel/.test(els[0].textContent)));
    await ctx.close();
  }

  /* ---- a shared link straight into Featured ------------------------------ */
  {
    const { ctx, page } = await open(browser, '/categories.html?category=featured', { tipsDelay: 400, settle: 1400 });
    ok('a shared ?category=featured link lands there',
      await page.evaluate(() => (document.querySelector('.category-rail-item.is-selected') || {}).dataset.category) === 'featured');
    ok('and waits for the curated rows rather than showing empty',
      (await tiles(page)).length === 3, (await tiles(page)).join(' | '));
    await ctx.close();
  }

  /* ---- nothing curated yet ---------------------------------------------- */
  {
    const { ctx, page } = await open(browser, '/categories.html', { noFeatured: true });
    await page.click('.category-rail-item[data-category="featured"]');
    await page.waitForTimeout(500);
    ok('an empty Featured says so and points somewhere useful',
      /Nothing featured right now/.test(await page.$eval('#category-status', (e) => e.textContent)),
      await page.$eval('#category-status', (e) => e.textContent));
    ok('...and does not leave a loading message running',
      !/Loading|loading/.test(await page.$eval('#category-status', (e) => e.textContent)));
    await ctx.close();
  }

  /* ---- the new categories browse like any other -------------------------- */
  for (const id of ['solar', 'hire', 'rental']) {
    const { ctx, page, calls } = await open(browser, '/categories.html?category=' + id);
    ok(id + ': lands on it and asks the backend for it',
      calls.some((c) => c.action === 'searchProducts' && c.category === id), id);
    ok(id + ': renders its products', (await tiles(page)).length === 1, (await tiles(page)).join());
    await ctx.close();
  }

  /* ---- the homepage strip ------------------------------------------------ */
  {
    const { ctx, page } = await open(browser, '/index.html');
    const chips = await page.$$eval('#category-strip .chip-strip-item', (els) => els.map((e) => e.textContent.trim()));
    ok('the new categories reach the homepage strip',
      ['Everything Solar', 'Hire', 'Rental'].every((l) => chips.includes(l)), chips.join(' | '));
    // The reason the count is allowed to grow at all.
    const strip = await page.evaluate(() => {
      const el = document.getElementById('category-strip');
      const r = el.getBoundingClientRect();
      const items = [...el.children].map((c) => c.getBoundingClientRect().top);
      return { h: Math.round(r.height), rows: new Set(items.map((t) => Math.round(t))).size };
    });
    ok('and the strip is still exactly one row tall', strip.rows === 1, strip.rows + ' rows, ' + strip.h + 'px');
    ok('Featured is NOT on the homepage strip - it is a browse view, not a category',
      !chips.includes('Featured'), chips.join(' | '));
    await ctx.close();
  }

  /* ---- the seller's category picker, driven in a real browser ------------ */
  //
  // Source-shape assertions would pass on a rule that never fires. These open
  // the actual form and read the actual <option> list.
  {
    const OWNER = {
      ownerId: 'own_1', storeName: 'Bong Rentals', storeSlug: 'bong', email: 'a@b.com',
      phone: '73007552', island: 'South Tarawa', village: 'Betio', status: 'active',
      isOpen: true, deliveryPickPay: true
    };
    // p1 is filed in Other and p2 is not. p1 is the one that would be stranded.
    const OWNED = [
      { productId: 'p1', name: 'Odds and ends', description: 'x', category: 'other',
        listingType: 'product', status: 'active', imageUrls: [],
        variants: [{ variantId: 'v1', label: 'One', price: 5, status: 'active' }] },
      { productId: 'p2', name: 'Solar panel', description: 'x', category: 'solar',
        listingType: 'product', status: 'active', imageUrls: [],
        variants: [{ variantId: 'v2', label: 'One', price: 500, status: 'active' }] }
    ];
    let saved = null;
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await ctx.route('**/macros/s/**', (route) => {
      let body = {};
      try { body = route.request().postDataJSON() || {}; } catch (e) {}
      let action = body.action;
      try { if (!action) action = new URL(route.request().url()).searchParams.get('action') || ''; } catch (e) {}
      let res = { ok: true };
      if (action === 'getOwnerProfile') res = { ok: true, owner: OWNER };
      else if (action === 'listOwnerProducts') res = { ok: true, total: 2, hasMore: false, products: OWNED };
      else if (action === 'createProduct' || action === 'updateProduct') { saved = body; res = { ok: true, productId: 'p1' }; }
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(res) });
    });
    const page = await ctx.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(String(e)));
    await page.addInitScript(() => { try { localStorage.setItem('skiri_owner_token', 'tok-123'); } catch (e) {} });
    await page.goto(BASE + '/owner/products.html', { waitUntil: 'load' });
    await page.waitForTimeout(700);

    const catOptions = () => page.$$eval('#product-category option',
      (os) => os.map((o) => ({ value: o.value, text: o.textContent.trim() })));

    // --- a NEW listing ---
    await page.evaluate(() => openForm());
    await page.waitForSelector('#product-category');
    let opts = await catOptions();
    ok('new listing: Other is not offered',
      !opts.some((o) => o.value === 'other'), opts.map((o) => o.value).join(','));
    ok('new listing: the three new categories are offered',
      ['solar', 'hire', 'rental'].every((id) => opts.some((o) => o.value === id)),
      opts.map((o) => o.value).join(','));
    ok('new listing: Featured is never offered to a seller',
      !opts.some((o) => o.value === 'featured'), opts.map((o) => o.value).join(','));

    // --- narrowing by listing type ---
    await page.selectOption('#product-listing-type', 'product');
    await page.waitForTimeout(100);
    opts = await catOptions();
    ok('a Product is not offered Rental, which only takes rentals',
      !opts.some((o) => o.value === 'rental'), opts.map((o) => o.value).join(','));
    ok('...and still not offered Other', !opts.some((o) => o.value === 'other'));
    await page.selectOption('#product-listing-type', 'rental');
    await page.waitForTimeout(100);
    opts = await catOptions();
    ok('a Rental IS offered both Hire and Rental',
      opts.some((o) => o.value === 'rental') && opts.some((o) => o.value === 'hire'),
      opts.map((o) => o.value).join(','));
    await page.selectOption('#product-listing-type', 'service');
    await page.waitForTimeout(100);
    opts = await catOptions();
    ok('a Service is offered Hire but not Rental',
      opts.some((o) => o.value === 'hire') && !opts.some((o) => o.value === 'rental'),
      opts.map((o) => o.value).join(','));

    // --- editing a listing ALREADY in Other: the stranding case ---
    await page.evaluate(() => openForm(ownerProducts.find((p) => p.productId === 'p1')));
    await page.waitForTimeout(150);
    opts = await catOptions();
    const sel = await page.$eval('#product-category', (s2) => s2.value);
    ok('editing a listing already in Other: the option is there, and selected',
      opts.some((o) => o.value === 'other') && sel === 'other', sel + ' / ' + opts.map((o) => o.value).join(','));
    ok('...and it says why it is there',
      /re-file/.test((opts.filter((o) => o.value === 'other')[0] || {}).text || ''),
      (opts.filter((o) => o.value === 'other')[0] || {}).text);
    // The whole point: the save guard must not block them.
    await page.evaluate(() => document.getElementById('product-form').requestSubmit());
    await page.waitForTimeout(400);
    ok('...so editing it does not force a re-file before it can be saved',
      saved && saved.category === 'other', JSON.stringify(saved && saved.category));

    // --- editing a listing NOT in Other ---
    saved = null;
    await page.evaluate(() => openForm(ownerProducts.find((p) => p.productId === 'p2')));
    await page.waitForTimeout(150);
    opts = await catOptions();
    ok('editing a listing filed elsewhere is offered no Other',
      !opts.some((o) => o.value === 'other'), opts.map((o) => o.value).join(','));
    ok('...and reopens on its own category',
      await page.$eval('#product-category', (s2) => s2.value) === 'solar');

    // --- and once they move OFF Other, it goes ---
    await page.evaluate(() => openForm(ownerProducts.find((p) => p.productId === 'p1')));
    await page.waitForTimeout(150);
    await page.selectOption('#product-category', 'solar');
    await page.selectOption('#product-listing-type', 'product');   // re-fills the list
    await page.waitForTimeout(150);
    opts = await catOptions();
    ok('once re-filed, Other disappears from the picker',
      !opts.some((o) => o.value === 'other'), opts.map((o) => o.value).join(','));
    ok('...and the new choice survives the re-fill',
      await page.$eval('#product-category', (s2) => s2.value) === 'solar');

    ok('no page errors in the seller flow', pageErrors.length === 0, pageErrors.join('; '));
    await ctx.close();
  }

  await browser.close();
  console.log('\n' + pass + '/' + (pass + fail) + ' passed');
  process.exit(fail ? 1 : 0);
})();
