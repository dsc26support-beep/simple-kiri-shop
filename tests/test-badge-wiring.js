/**
 * Badges riding along with the responses that already exist.
 *
 * THE ASSERTIONS THAT MATTER MOST
 *
 * 1. ONE BADGE LOOKUP PER RESPONSE, NOT ONE PER PRODUCT. actionSearchProducts
 *    already reads Owners, Variants, Products and Reviews in full on a cold
 *    cache. If badges were fetched per card, a 20-product page would turn one
 *    expensive request into twenty. The sandbox counts the calls.
 *
 * 2. EVERY CACHE KEY THAT CHANGED SHAPE WAS BUMPED. A warm entry holding the
 *    old payload would serve badge-less products until it expired - which on
 *    the 300s homepage cache is five minutes of "the feature did not ship".
 *    Read straight out of the source rather than trusted.
 *
 * 3. A STORE PAGE SENDS ITS SELLER'S BADGES ONCE. Every product there belongs
 *    to the same seller; repeating them per product is the same bytes sent
 *    twenty times to say one thing.
 *
 * 4. NO SCORE, METRIC OR REASON REACHES A CUSTOMER. The snapshot holds order
 *    counts, reply times and the wording of why a badge was awarded. Only the
 *    id list may leave the backend.
 */
const fs = require('fs'), vm = require('vm');
const REPO = '/home/user/simple-kiri-shop/';
const products = fs.readFileSync(REPO + 'apps-script/Products.gs', 'utf8');
const admin = fs.readFileSync(REPO + 'apps-script/Admin.gs', 'utf8');
const codeGs = fs.readFileSync(REPO + 'apps-script/Code.gs', 'utf8');
let pass = 0, fail = 0;
const ok = (n, c, e) => {
  if (c) { pass++; console.log('PASS  ' + n + (e ? '  [' + e + ']' : '')); }
  else { fail++; console.log('FAIL  ' + n + (e ? '  [' + e + ']' : '')); }
};

const OWNERS = [
  { OwnerId: 'o1', StoreSlug: 'bong', StoreName: 'Bong', Status: 'active',
    Phone: '73011111', Island: 'Tarawa', Village: 'Bairiki' },
  { OwnerId: 'o2', StoreSlug: 'tabon', StoreName: 'Tabon', Status: 'active',
    Phone: '73022222', Island: 'Abaiang', Village: '' }
];
const PRODUCTS = [
  { ProductId: 'p1', OwnerId: 'o1', Name: 'Rice', Category: 'food', Status: 'active', Views: 10 },
  { ProductId: 'p2', OwnerId: 'o1', Name: 'Salt', Category: 'food', Status: 'active', Views: 5 },
  { ProductId: 'p3', OwnerId: 'o2', Name: 'Lamp', Category: 'electronics', Status: 'active', Views: 8 }
];
const VARIANTS = [
  { VariantId: 'v1', ProductId: 'p1', OwnerId: 'o1', Label: 'Bag', Price: 10, Status: 'active' },
  { VariantId: 'v2', ProductId: 'p2', OwnerId: 'o1', Label: 'Pack', Price: 3, Status: 'active' },
  { VariantId: 'v3', ProductId: 'p3', OwnerId: 'o2', Label: 'One', Price: 25, Status: 'active' }
];
const BADGES = { o1: ['recommended', 'verified'], o2: ['new'] };

function ctx(extra) {
  const tabs = Object.assign({
    Owners: OWNERS, Products: PRODUCTS, Variants: VARIANTS,
    Reviews: [], Bookings: [], Featured: []
  }, (extra && extra.tabs) || {});
  const counts = { badgeIndex: 0 };

  const sandbox = {
    counts, tabs,
    Logger: { log() {} },
    ok: (d) => Object.assign({ ok: true }, d),
    fail: (e) => ({ ok: false, error: String(e) }),
    nowIso: () => '2026-09-11T00:00:00.000Z',
    normalizeEmail: (e) => String(e || '').trim().toLowerCase(),
    getSheet: (n) => n,
    sheetToObjects: (n) => (tabs[n] || []).map((r, i) => Object.assign({ __row: i + 2 }, r)),
    // No caching here on purpose: this exercises the builders' bodies, which is
    // where the per-response lookup has to happen.
    getCached: (key, ttl, producer) => producer(),
    clampPageSize: (r, d, m) => Math.min(Number(r) || d, m),
    DEFAULT_LIST_PAGE_SIZE: 20, MAX_LIST_PAGE_SIZE: 100,
    isStoreBrowsable: (o) => !!o && o.Status !== 'closed',
    isStoreOpenForBusiness: (o) => !!o && o.Status === 'active',
    publicStoreFields: (o) => ({ storeName: o.StoreName, storeSlug: o.StoreSlug }),
    productRatingIndex: () => ({}),
    unavailableProductIdsToday: () => ({}),
    getOwnerBySlug: (slug) => OWNERS.filter((o) => o.StoreSlug === slug)[0] || null,
    // The thing under test: it must be called ONCE per response.
    sellerBadgeIndex: () => { counts.badgeIndex++; return (extra && extra.badges) || BADGES; }
  };
  vm.createContext(sandbox);
  vm.runInContext(products, sandbox);
  vm.runInContext(admin, sandbox);
  return sandbox;
}

/* ---------- one lookup per response ---------- */
{
  let s = ctx();
  let r = s.actionSearchProducts({ q: '' });
  ok('search returns every product', r.products.length === 3, String(r.products.length));
  ok('SEARCH LOOKS BADGES UP ONCE for the whole page, not once per product',
    s.counts.badgeIndex === 1, String(s.counts.badgeIndex));
  const byId = {};
  r.products.forEach((p) => { byId[p.productId] = p; });
  ok('a product carries its seller\'s badges', byId.p1.sellerBadges.join(',') === 'recommended,verified');
  ok('two products from the same seller both carry them',
    byId.p2.sellerBadges.join(',') === 'recommended,verified');
  ok('and a different seller carries theirs', byId.p3.sellerBadges.join(',') === 'new');

  s = ctx({ badges: {} });
  r = s.actionSearchProducts({ q: '' });
  ok('A SELLER WITH NO BADGES SENDS NO KEY AT ALL, not an empty array',
    r.products.every((p) => !('sellerBadges' in p)),
    JSON.stringify(r.products.map((p) => p.sellerBadges)));

  s = ctx({ badges: { o1: ['verified'] } });
  r = s.actionSearchProducts({ q: '' });
  ok('and one unbadged seller among badged ones is simply left out',
    byIdOf(r).p3.sellerBadges === undefined && byIdOf(r).p1.sellerBadges.join(',') === 'verified');
}

function byIdOf(r) {
  const m = {};
  (r.products || []).forEach((p) => { m[p.productId] = p; });
  return m;
}

/* ---------- the store page sends them once ---------- */
{
  const s = ctx();
  const r = s.actionListProducts({ storeSlug: 'bong' });
  ok('a store page carries the seller\'s badges at the top level',
    r.sellerBadges.join(',') === 'recommended,verified', JSON.stringify(r.sellerBadges));
  ok('and NOT repeated on every product - same seller, one statement',
    r.products.every((p) => !('sellerBadges' in p)),
    JSON.stringify(r.products.map((p) => p.sellerBadges)));
  ok('one lookup for that response too', s.counts.badgeIndex === 1, String(s.counts.badgeIndex));

  const none = ctx({ badges: {} });
  const r2 = none.actionListProducts({ storeSlug: 'bong' });
  ok('a store with no badges sends no key', !('sellerBadges' in r2));
  ok('and the rest of the store payload is untouched',
    r2.storeName === 'Bong' && r2.products.length === 2 && r2.storeOpen === true);
}

/* ---------- the other surfaces ---------- */
{
  let s = ctx();
  let r = s.actionListStores({});
  ok('the store directory carries badges', r.stores[0].sellerBadges.join(',') === 'recommended,verified');
  ok('one lookup', s.counts.badgeIndex === 1, String(s.counts.badgeIndex));
  ok('and the existing directory fields still come through',
    r.stores[0].storeName === 'Bong' && r.stores[0].phone === '73011111'
    && r.stores[0].island === 'Tarawa' && r.total === 2);

  s = ctx();
  r = s.actionGetHomePageData();
  ok('the homepage carousel carries badges',
    r.products.every((p) => !!p.sellerBadges) && r.stores.every((st) => !!st.sellerBadges));
  ok('the homepage asks twice - once for products, once for stores - and not per card',
    s.counts.badgeIndex === 2, String(s.counts.badgeIndex));

  s = ctx();
  r = s.actionGetStorePublicInfo({ storeSlug: 'bong' });
  ok('the public store lookup carries them', r.store.sellerBadges.join(',') === 'recommended,verified');
  ok('without losing what it already returned', r.store.storeName === 'Bong');

  s = ctx({ tabs: { Featured: [
    { FeaturedId: 'f1', Type: 'store', RefId: 'bong', SortOrder: 1 },
    { FeaturedId: 'f2', Type: 'product', RefId: 'p3', SortOrder: 2 }
  ] } });
  r = s.buildTips();
  ok('Tips carries badges on featured stores', r.stores[0].sellerBadges.join(',') === 'recommended,verified');
  ok('and on featured products', r.products[0].sellerBadges.join(',') === 'new');
  ok('with one lookup for the whole page', s.counts.badgeIndex === 1, String(s.counts.badgeIndex));
}

/* ---------- nothing private escapes ---------- */
{
  const s = ctx({ badges: { o1: ['recommended'] } });
  const payloads = [
    JSON.stringify(s.actionSearchProducts({ q: '' })),
    JSON.stringify(s.actionListProducts({ storeSlug: 'bong' })),
    JSON.stringify(s.actionListStores({})),
    JSON.stringify(s.actionGetHomePageData()),
    JSON.stringify(s.actionGetStorePublicInfo({ storeSlug: 'bong' }))
  ].join('');
  ok('NO SCORE reaches a customer', payloads.indexOf('"score"') === -1 && !/\bScore\b/.test(payloads));
  ok('no order counts, reply times or repeat-customer figures either',
    !/medianReplyMinutes|repeatCustomers|fulfilled|cancelled/.test(payloads));
  ok('and no reason text explaining why a badge was awarded',
    !/ReasonJson|"why"|"auto"|"suppressed"/.test(payloads));
  ok('only the id list travels', /"sellerBadges":\["recommended"\]/.test(payloads));
}

/* ---------- read from the source ---------- */
{
  // A warm cache holding the old shape is the quiet way a shipped feature does
  // not appear. Every builder that gained a field must have a new key.
  ok('listStores cache bumped', /storeListCacheKey\(\) \{ return 'v2:listStores'/.test(products));
  ok('topProducts cache bumped', /topProductsCacheKey\(\) \{ return 'v2:topProducts'/.test(products));
  ok('topStores cache bumped', /topStoresCacheKey\(\) \{ return 'v2:topStores'/.test(products));
  ok('storeInfo cache bumped', /storeInfoCacheKey\(slug\) \{ return 'v3:storeInfo:'/.test(products));
  ok('listProducts cache bumped', /storeProductsCacheKey\(slug\) \{ return 'v2:listProducts:'/.test(products));
  ok('search cache bumped', /v3:search/.test(products) && !/'v2:search/.test(products));
  ok('tips cache bumped', /v2:tips/.test(admin) && !/'v1:tips'/.test(admin));

  /*
   * THE REGRESSION THIS EXISTS TO STOP.
   *
   * Bumping these keys for the badge payload left six invalidateCache() calls
   * across Products.gs, Images.gs and Auth.gs still naming the OLD keys.
   * Nothing failed loudly - a vendor's edit just would not appear for a minute,
   * and a store switched to closed would have stayed browsable for five. The
   * cause was the key being spelled out at eight separate call sites.
   *
   * So: no .gs file may write one of these keys inline. There is one definition
   * each, and every caller goes through it.
   */
  ['Products.gs', 'Images.gs', 'Auth.gs', 'Admin.gs', 'Badges.gs'].forEach((f) => {
    const src = fs.readFileSync(REPO + 'apps-script/' + f, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const inline = (src.match(/'v\d+:(listStores|topStores|topProducts|listProducts|storeInfo)[^']*'/g) || [])
      // The one definition of each is allowed; it is the return in the helper.
      .filter((m) => !new RegExp("return " + m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(src));
    ok(f + ' spells no store cache key inline', inline.length === 0, inline.join(' '));
  });

  ok('and every store-record change clears the same five keys through one helper',
    /function storeCacheKeys\(slug\)/.test(products)
    && /invalidateCache\(storeCacheKeys\(owner\.StoreSlug\)\)/.test(
         fs.readFileSync(REPO + 'apps-script/Auth.gs', 'utf8')));

  // The per-card regression this whole design exists to prevent.
  ok('no builder calls sellerBadgeIndex from inside a map over products',
    !/\.map\(function[\s\S]{0,600}sellerBadgeIndex\(\)[\s\S]{0,600}\}\)/.test(products));

  ok('the new tabs are in REQUIRED_TABS, so setupSheets creates them',
    /SellerBadges: \['OwnerId', 'Badges', 'Score', 'MetricsJson', 'ReasonJson', 'UpdatedAt'\]/.test(codeGs)
    && /BadgeConfig: \['Key', 'Value', 'UpdatedAt'\]/.test(codeGs));
  ok('checkSetup reports an empty Badges.gs, which would otherwise look like "no badges yet"',
    /sellerBadgeIndex !== 'function'\) missingFiles\.push\('Badges\.gs'\)/.test(codeGs));
  ok('APP_VERSION was bumped, so the deploy can be confirmed rather than assumed',
    /APP_VERSION = 'badges1-2026-09-11'/.test(codeGs));

  // Auth.gs is shared with the chat window's store lookup and is deliberately
  // left alone; the display concern lives in the display builder.
  const auth = fs.readFileSync(REPO + 'apps-script/Auth.gs', 'utf8');
  ok('Auth.gs was not touched - publicStoreFields stays a pure auth-side shape',
    !/sellerBadge/i.test(auth));
  ['Orders.gs', 'Customers.gs', 'Bookings.gs'].forEach((f) => {
    ok(f + ' untouched by the badge feature',
      !/sellerBadge/i.test(fs.readFileSync(REPO + 'apps-script/' + f, 'utf8')));
  });
}

console.log('\n' + pass + '/' + (pass + fail) + ' passed');
process.exit(fail ? 1 : 0);
