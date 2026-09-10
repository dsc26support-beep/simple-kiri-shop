/**
 * Store directory, product/variant CRUD, and owner profile management.
 * Variants are diffed against a full `variants[]` array sent from the
 * dashboard's "Save Product" action - update rows by VariantId, insert
 * new ones, soft-delete rows that were dropped from the array.
 */

function getOwnerBySlug(slug) {
  return sheetToObjects(getSheet('Owners')).filter(function (o) { return o.StoreSlug === slug; })[0] || null;
}

/**
 * Booking-ness now lives entirely in Category, replacing the earlier
 * separate ListingType field - one fewer thing for a vendor to set
 * correctly, and "Rentals"/"Services" already describe the business, so a
 * second field asking the same question again was redundant. A listing in
 * either category gets the date-range request flow (Bookings.gs) instead
 * of cart/checkout; every other category is a normal goods listing.
 */
// LEGACY. These two strings were the old way of saying "this is booked by
// date" - they are still the values on rows saved before ListingType existed,
// which is why listingTypeOfRow() reads them. Do NOT use this to decide how a
// listing behaves: the mapped category of a legacy rental is now 'other', so
// this returns false for exactly the listings it used to catch. Use
// isBookingRow (sheet row) or listingTypeOf (client shape) instead.
var BOOKING_CATEGORIES = ['rentals', 'services'];
function isBookingCategory(category) { return BOOKING_CATEGORIES.indexOf(category) !== -1; }

/* ---------- Categories and listing types ----------
 *
 * MUST STAY IN SYNC with assets/js/helpers.js - the ids, the legacy map and the
 * derivation rule all appear on both sides, the same way BOOKING_CATEGORIES
 * already did. A test asserts the two lists match rather than trusting a
 * comment to be obeyed.
 *
 * A category says WHAT a thing is; a listing type says HOW you get it. Before
 * this, the category WAS the type - 'rentals'/'services' meant date-request,
 * anything else meant cart. Live rows still hold those values, so nothing here
 * rewrites them: they are mapped on READ. A row is only written with new values
 * when a seller saves it.
 */
var LISTING_TYPE_IDS = ['product', 'rental', 'service'];

var CATEGORY_IDS = ['food', 'fashion', 'electronics', 'home', 'building', 'vehicles',
  'fishing', 'agriculture', 'handicrafts', 'property', 'services', 'education', 'events', 'other'];

var LEGACY_CATEGORY_MAP = {
  pantry: 'food',
  clothing: 'fashion',
  household: 'home',
  electronics: 'electronics',
  services: 'services',
  // A rental's old category recorded only that it was rented, never what it
  // was - so it cannot be filed confidently, and goes to 'other' for review.
  rentals: 'other',
  general: 'other',
  '': 'other'
};

function categoryIdOf(rawCategory) {
  var raw = String(rawCategory == null ? '' : rawCategory).trim();
  if (CATEGORY_IDS.indexOf(raw) !== -1) return raw;
  return Object.prototype.hasOwnProperty.call(LEGACY_CATEGORY_MAP, raw) ? LEGACY_CATEGORY_MAP[raw] : 'other';
}

/**
 * The listing type of a Products row (sheet-shaped, capitalised fields).
 * An explicit ListingType wins; only a row predating the column falls back to
 * reading the type out of its legacy category.
 */
function listingTypeOfRow(p) {
  var explicit = String(p.ListingType || '').trim();
  if (LISTING_TYPE_IDS.indexOf(explicit) !== -1) return explicit;
  var legacy = String(p.Category == null ? '' : p.Category).trim();
  if (legacy === 'rentals') return 'rental';
  if (legacy === 'services') return 'service';
  return 'product';
}

function isBookingRow(p) {
  return listingTypeOfRow(p) !== 'product';
}

/**
 * Same rule as listingTypeOfRow, for an object that has already been mapped to
 * the client shape (lowercase `listingType` / `category`). Both exist because
 * this file passes rows around in both shapes and silently reading the wrong
 * one would mis-type every listing.
 */
function listingTypeOf(p) {
  if (!p) return 'product';
  var explicit = String(p.listingType || '').trim();
  if (LISTING_TYPE_IDS.indexOf(explicit) !== -1) return explicit;
  var legacy = String(p.category == null ? '' : p.category).trim();
  if (legacy === 'rentals') return 'rental';
  if (legacy === 'services') return 'service';
  return 'product';
}

function deliveryCostOf(rawCost) {
  return rawCost === '' || rawCost == null ? null : Number(rawCost);
}

function deliveryFlagsOf(owner) {
  return {
    deliveryTruck: String(owner.DeliveryTruck) === 'true',
    deliveryShip: String(owner.DeliveryShip) === 'true',
    deliveryAirCargo: String(owner.DeliveryAirCargo) === 'true',
    deliveryPickPay: String(owner.DeliveryPickPay) === 'true',
    deliveryTruckCost: deliveryCostOf(owner.DeliveryTruckCost),
    deliveryShipCost: deliveryCostOf(owner.DeliveryShipCost),
    deliveryAirCargoCost: deliveryCostOf(owner.DeliveryAirCargoCost)
  };
}

/**
 * Paginated the same way actionGetVendorConversations already is (Chat.gs):
 * the cache holds the full, unsliced list so one cached value serves every
 * page size a caller asks for, and slicing happens after the cache read.
 * At 10k+ vendors this is the directory the storefront's landing page
 * renders, so an unbounded response/DOM render there was the largest
 * unpaginated list in the app - see docs/production-readiness-report.md
 * Finding 10.
 */
function actionListStores(params) {
  params = params || {};
  var all = getCached('v1:listStores', 60, function () {
    return sheetToObjects(getSheet('Owners'))
      .filter(function (o) { return isStoreBrowsable(o); })
      .map(function (o) {
        var store = { storeSlug: o.StoreSlug, storeName: o.StoreName, phone: o.Phone, island: o.Island, village: o.Village, logoUrl: o.LogoUrl };
        Object.assign(store, deliveryFlagsOf(o));
        return store;
      });
  });

  // Filtering happens after the cache read, on the one full cached list -
  // every query shares the same 60s cache entry instead of minting a new
  // cache key per search string, and the query never affects the eligible
  // page-size cap below.
  var q = String(params.q || '').trim().toLowerCase();
  var filtered = q
    ? all.filter(function (s) {
        var haystack = (s.storeName + ' ' + (s.island || '') + ' ' + (s.village || '')).toLowerCase();
        return haystack.indexOf(q) !== -1;
      })
    : all;

  var limit = clampPageSize(params.limit, DEFAULT_LIST_PAGE_SIZE, MAX_LIST_PAGE_SIZE);
  var offset = Math.max(0, Number(params.offset) || 0);
  var page = filtered.slice(offset, offset + limit);
  return ok({ stores: page, total: filtered.length, hasMore: offset + limit < filtered.length });
}

/** Top 20 active products by view count, for the home page "trending" carousel. */
function getTopProductsCached() {
  return getCached('v1:topProducts', 300, function () {
    var ownersById = {};
    sheetToObjects(getSheet('Owners'))
      .filter(function (o) { return isStoreBrowsable(o); })
      .forEach(function (o) { ownersById[o.OwnerId] = o; });

    var variants = sheetToObjects(getSheet('Variants')).filter(function (v) { return v.Status === 'active'; });
    var ratings = productRatingIndex();

    return sheetToObjects(getSheet('Products'))
      .filter(function (p) { return p.Status === 'active' && ownersById[p.OwnerId]; })
      .map(function (p) {
        var owner = ownersById[p.OwnerId];
        var productVariants = variants
          .filter(function (v) { return v.ProductId === p.ProductId; })
          .map(function (v) { return { variantId: v.VariantId, label: v.Label, price: Number(v.Price) }; });
        var product = {
          productId: p.ProductId,
          name: p.Name,
          description: p.Description,
          category: categoryIdOf(p.Category),
      listingType: listingTypeOfRow(p),
          imageUrl: p.ImageUrl,
          imageUrl2: p.ImageUrl2,
          storeSlug: owner.StoreSlug,
          storeName: owner.StoreName,
          storePhone: owner.Phone,
          // The homepage and search cards show WHERE a thing is rather than
          // who sells it - in Kiribati that is what decides whether getting it
          // to you is practical at all. storeLocationLabel (helpers.js) turns
          // these two into the village on South Tarawa, the island elsewhere.
          storeIsland: owner.Island,
          storeVillage: owner.Village,
          storeLogoUrl: owner.LogoUrl,
          views: Number(p.Views) || 0,
          variants: productVariants,
          rating: (ratings[p.ProductId] || {}).average != null ? ratings[p.ProductId].average : null,
          reviewCount: (ratings[p.ProductId] || {}).count || 0
        };
        product.storeDeliveryTruck = String(owner.DeliveryTruck) === 'true';
        product.storeDeliveryShip = String(owner.DeliveryShip) === 'true';
        product.storeDeliveryAirCargo = String(owner.DeliveryAirCargo) === 'true';
        product.storeDeliveryPickPay = String(owner.DeliveryPickPay) === 'true';
        product.storeDeliveryTruckCost = deliveryCostOf(owner.DeliveryTruckCost);
        product.storeDeliveryShipCost = deliveryCostOf(owner.DeliveryShipCost);
        product.storeDeliveryAirCargoCost = deliveryCostOf(owner.DeliveryAirCargoCost);
        return product;
      })
      // Booking listings have no add-to-cart affordance, which this
      // "trending products" carousel assumes every card has - excluded here
      // rather than given a broken card.
      .filter(function (p) { return listingTypeOf(p) === 'product' && p.variants.length > 0; })
      .sort(function (a, b) { return b.views - a.views; })
      .slice(0, 20);
  });
}

function actionListTopProducts() {
  return ok({ products: getTopProductsCached() });
}

/** Top 20 active stores by visit count, for the home page "popular stores" logo carousel. */
function getTopStoresCached() {
  return getCached('v1:topStores', 300, function () {
    return sheetToObjects(getSheet('Owners'))
      .filter(function (o) { return isStoreBrowsable(o); })
      .map(function (o) {
        var store = {
          storeSlug: o.StoreSlug,
          storeName: o.StoreName,
          phone: o.Phone,
          island: o.Island,
          village: o.Village,
          logoUrl: o.LogoUrl,
          visits: Number(o.Visits) || 0
        };
        Object.assign(store, deliveryFlagsOf(o));
        return store;
      })
      .sort(function (a, b) { return b.visits - a.visits; })
      .slice(0, 20);
  });
}

function actionListTopStores() {
  return ok({ stores: getTopStoresCached() });
}

/**
 * The home page's "Trending Products" and "Popular Stores" sections used to
 * be two separate round trips to the Apps Script backend - each one pays
 * Apps Script's own per-request execution-startup overhead, which is the
 * dominant cost for a small/cached read like this (not the Sheets read
 * itself). Combining them into one response halves that fixed tax on the
 * highest-traffic page in the app. Both halves still read through the same
 * 300s caches as their standalone actions, so nothing about caching
 * behavior changes - this only cuts the network round trip.
 */
function actionGetHomePageData() {
  return ok({ products: getTopProductsCached(), stores: getTopStoresCached() });
}

/**
 * Records one view per productId, deduped client-side (once per visitor per
 * product via localStorage) before this is ever called - so this just
 * increments whatever it's given. Batched into one request per page load
 * rather than one call per product, to keep this cheap at scale.
 */
var VIEW_COOLDOWN_SECONDS = 5 * 60;

/**
 * Anti-gaming guard on top of the existing client-side once-per-visitor
 * dedup: this endpoint is fully anonymous with no caller identity at all
 * (no token, no customerToken), so a per-visitor limit isn't available -
 * instead each productId can increment at most once per 5 minutes,
 * globally, regardless of who's calling. This directly caps the abuse
 * metric (how fast a product's count can be inflated) without needing a
 * new anonymous identifier, which would offer no real Sybil-resistance
 * here anyway (nothing stops a script from minting a fresh one per
 * request). Items currently in cooldown are silently skipped, not
 * rejected - this action's contract is "never error the customer," so a
 * batch with some cooling-down items still returns ok:true.
 */
function actionRecordProductViews(body) {
  var productIds = Array.isArray(body.productIds) ? body.productIds : [];
  var wanted = {};
  productIds.forEach(function (id) { if (id) wanted[id] = true; });
  if (Object.keys(wanted).length === 0) return ok({});

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var cache = CacheService.getScriptCache();
    var toIncrement = {};
    Object.keys(wanted).forEach(function (id) {
      var cooldownKey = 'viewcooldown:v1:' + id;
      if (cache.get(cooldownKey)) return; // already counted in the last 5 min - skip silently
      try { cache.put(cooldownKey, '1', VIEW_COOLDOWN_SECONDS); } catch (e) { /* best effort */ }
      toIncrement[id] = true;
    });
    if (Object.keys(toIncrement).length === 0) return ok({});

    var sheet = getSheet('Products');
    sheetToObjects(sheet).forEach(function (p) {
      if (toIncrement[p.ProductId]) {
        updateRowFromObject(sheet, p.__row, { Views: (Number(p.Views) || 0) + 1 });
      }
    });
    return ok({});
  } finally {
    lock.releaseLock();
  }
}

var VISIT_COOLDOWN_SECONDS = 5 * 60;

/** Records one visit for a store, deduped client-side (once per visitor per store) before this is called, plus the same global 5-minute per-store cooldown actionRecordProductViews uses - see that function's comment. */
function actionRecordStoreVisit(body) {
  var slug = body.storeSlug;
  if (!slug) return ok({});

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var cache = CacheService.getScriptCache();
    var cooldownKey = 'visitcooldown:v1:' + slug;
    if (cache.get(cooldownKey)) return ok({}); // already counted in the last 5 min - skip silently

    var sheet = getSheet('Owners');
    var owner = findRowById(sheet, 'StoreSlug', slug);
    if (owner) {
      try { cache.put(cooldownKey, '1', VISIT_COOLDOWN_SECONDS); } catch (e) { /* best effort */ }
      updateRowFromObject(sheet, owner.__row, { Visits: (Number(owner.Visits) || 0) + 1 });
    }
    return ok({});
  } finally {
    lock.releaseLock();
  }
}

/**
 * Cross-store product search, used by the homepage search box and category
 * buttons. Matches on product name/description (case-insensitive substring)
 * and/or exact category, across every active store's active products.
 */
/**
 * Cached like its listStores/listProducts/topProducts/topStores siblings
 * (all read-heavy, all full-table scans otherwise) - this one was originally
 * left out despite being the highest-traffic customer-facing action (every
 * homepage search/category click), which is an oversight rather than a
 * deliberate choice. Keyed per query+category since the query space is
 * unbounded (unlike the fixed keys those siblings use) - CacheService
 * entries just expire on their own TTL, so this doesn't need explicit
 * invalidation any more than v1:topProducts/v1:topStores already don't (same
 * TTL-only staleness tradeoff, 60s to match listProducts). The query portion
 * of the key is capped so a very long q can never produce an invalid
 * CacheService key (250-char limit).
 */
function actionSearchProducts(params) {
  var q = String(params.q || '').trim().toLowerCase();
  var category = String(params.category || '').trim();
  // Listing-type filter: the [All][Products][Rentals][Services] strip.
  var type = String(params.type || '').trim();
  if (LISTING_TYPE_IDS.indexOf(type) === -1) type = '';
  var cacheKey = 'v2:search:' + category + ':' + type + ':' + q.slice(0, 100);

  var results = getCached(cacheKey, 60, function () {
    var ownersById = {};
    sheetToObjects(getSheet('Owners'))
      .filter(function (o) { return isStoreBrowsable(o); })
      .forEach(function (o) { ownersById[o.OwnerId] = o; });

    var variants = sheetToObjects(getSheet('Variants')).filter(function (v) { return v.Status === 'active'; });
    var ratings = productRatingIndex();

    var matched = sheetToObjects(getSheet('Products'))
      .filter(function (p) { return p.Status === 'active' && ownersById[p.OwnerId]; })
      .filter(function (p) {
        // Compared against the MAPPED id, so "Food & Groceries" finds the
        // products still stored as the legacy 'pantry'. Matching the raw
        // stored value would have shown only listings saved since the change.
        if (category && categoryIdOf(p.Category) !== category) return false;
        if (type && listingTypeOfRow(p) !== type) return false;
        if (q) {
          var haystack = (String(p.Name) + ' ' + String(p.Description)).toLowerCase();
          if (haystack.indexOf(q) === -1) return false;
        }
        return true;
      });

    var unavailableIds = unavailableProductIdsToday(matched.filter(isBookingRow).map(function (p) { return p.ProductId; }));

    return matched
      .map(function (p) {
        var owner = ownersById[p.OwnerId];
        var productVariants = variants
          .filter(function (v) { return v.ProductId === p.ProductId; })
          .map(function (v) { return { variantId: v.VariantId, label: v.Label, price: Number(v.Price) }; });
        var product = {
          productId: p.ProductId,
          name: p.Name,
          description: p.Description,
          category: categoryIdOf(p.Category),
      listingType: listingTypeOfRow(p),
          imageUrl: p.ImageUrl,
          imageUrl2: p.ImageUrl2,
          storeSlug: owner.StoreSlug,
          storeName: owner.StoreName,
          storePhone: owner.Phone,
          // The homepage and search cards show WHERE a thing is rather than
          // who sells it - in Kiribati that is what decides whether getting it
          // to you is practical at all. storeLocationLabel (helpers.js) turns
          // these two into the village on South Tarawa, the island elsewhere.
          storeIsland: owner.Island,
          storeVillage: owner.Village,
          storeLogoUrl: owner.LogoUrl,
          variants: productVariants,
          // Both columns already exist on Products and are already maintained
          // (Views by recordProductViews). Surfacing them costs nothing extra
          // to read and is what lets the results page offer honest "Most
          // popular" and "Newest" sorting instead of inventing a ranking.
          views: Number(p.Views) || 0,
          createdAt: p.CreatedAt || '',
          // Rating is computed server-side from the Reviews sheet - a seller
          // cannot submit or influence it. null means "no reviews yet", which
          // the UI must show as such rather than as a zero-star product.
          rating: (ratings[p.ProductId] || {}).average != null ? ratings[p.ProductId].average : null,
          reviewCount: (ratings[p.ProductId] || {}).count || 0
        };
        if (isBookingRow(p)) product.available = !unavailableIds[p.ProductId];
        product.storeDeliveryTruck = String(owner.DeliveryTruck) === 'true';
        product.storeDeliveryShip = String(owner.DeliveryShip) === 'true';
        product.storeDeliveryAirCargo = String(owner.DeliveryAirCargo) === 'true';
        product.storeDeliveryPickPay = String(owner.DeliveryPickPay) === 'true';
        product.storeDeliveryTruckCost = deliveryCostOf(owner.DeliveryTruckCost);
        product.storeDeliveryShipCost = deliveryCostOf(owner.DeliveryShipCost);
        product.storeDeliveryAirCargoCost = deliveryCostOf(owner.DeliveryAirCargoCost);
        return product;
      })
      .filter(function (p) { return p.variants.length > 0; });
  });

  return ok({ products: results });
}

function actionGetStorePublicInfo(params) {
  var slug = params.storeSlug;
  if (!slug) return fail('storeSlug is required');

  // Cache key bumped v1 -> v2 with the payload narrowing below, so a warm
  // entry holding the old wide object can't be served after the deploy.
  var store = getCached('v2:storeInfo:' + slug, 60, function () {
    var owner = getOwnerBySlug(slug);
    if (!isStoreBrowsable(owner)) return null;
    return publicStoreFields(owner);
  });
  if (!store) return fail('Store not found');
  return ok({ store: store });
}

function actionListProducts(params) {
  var slug = params.storeSlug;
  if (!slug) return fail('storeSlug is required');

  var response = getCached('v1:listProducts:' + slug, 60, function () {
    var owner = getOwnerBySlug(slug);
    if (!isStoreBrowsable(owner)) return null;

    var products = sheetToObjects(getSheet('Products')).filter(function (p) {
      return p.OwnerId === owner.OwnerId && p.Status === 'active';
    });
    var variants = sheetToObjects(getSheet('Variants')).filter(function (v) {
      return v.OwnerId === owner.OwnerId && v.Status === 'active';
    });
    var unavailableIds = unavailableProductIdsToday(products.filter(isBookingRow).map(function (p) { return p.ProductId; }));
    // One Reviews read for the whole store, not one per product.
    var ratings = productRatingIndex();

    var result = products
      .sort(function (a, b) { return (Number(a.SortOrder) || 0) - (Number(b.SortOrder) || 0); })
      .map(function (p) {
        var productVariants = variants
          .filter(function (v) { return v.ProductId === p.ProductId; })
          .map(function (v) { return { variantId: v.VariantId, label: v.Label, price: Number(v.Price) }; });
        var product = {
          productId: p.ProductId,
          name: p.Name,
          description: p.Description,
          category: categoryIdOf(p.Category),
      listingType: listingTypeOfRow(p),
          imageUrl: p.ImageUrl,
          imageUrl2: p.ImageUrl2,
          variants: productVariants,
          rating: (ratings[p.ProductId] || {}).average != null ? ratings[p.ProductId].average : null,
          reviewCount: (ratings[p.ProductId] || {}).count || 0
        };
        if (isBookingRow(p)) product.available = !unavailableIds[p.ProductId];
        return product;
      })
      .filter(function (p) { return p.variants.length > 0; });

    var out = {
      storeName: owner.StoreName,
      storePhone: owner.Phone,
      storeMessenger: owner.Messenger,
      storeWhatsapp: owner.WhatsApp,
      storeLogoUrl: owner.LogoUrl,
      storeIsland: owner.Island,
      storeVillage: owner.Village,
      // A closed store is still browsable; the UI needs to say so and block
      // ordering rather than pretend it is open.
      storeOpen: isStoreOpenForBusiness(owner),
      products: result
    };
    out.storeDeliveryTruck = String(owner.DeliveryTruck) === 'true';
    out.storeDeliveryShip = String(owner.DeliveryShip) === 'true';
    out.storeDeliveryAirCargo = String(owner.DeliveryAirCargo) === 'true';
    out.storeDeliveryPickPay = String(owner.DeliveryPickPay) === 'true';
    out.storeDeliveryTruckCost = deliveryCostOf(owner.DeliveryTruckCost);
    out.storeDeliveryShipCost = deliveryCostOf(owner.DeliveryShipCost);
    out.storeDeliveryAirCargoCost = deliveryCostOf(owner.DeliveryAirCargoCost);
    return out;
  });

  if (!response) return fail('Store not found');
  return ok(response);
}

/**
 * Paginated via body.limit/offset (same shape as actionGetVendorConversations
 * and actionListStores) - see docs/production-readiness-report.md Finding
 * 10. Sheet row order is stable (appendRowFromObject only ever appends, rows
 * are never reordered), so slicing before mapping is a safe, deterministic
 * page boundary across repeated calls.
 */
function actionListOwnerProducts(owner, body) {
  body = body || {};
  var allProducts = sheetToObjects(getSheet('Products')).filter(function (p) { return p.OwnerId === owner.OwnerId; });
  var variants = sheetToObjects(getSheet('Variants')).filter(function (v) { return v.OwnerId === owner.OwnerId; });

  var limit = clampPageSize(body.limit, DEFAULT_LIST_PAGE_SIZE, MAX_LIST_PAGE_SIZE);
  var offset = Math.max(0, Number(body.offset) || 0);
  var products = allProducts.slice(offset, offset + limit);

  var result = products.map(function (p) {
    var productVariants = variants
      .filter(function (v) { return v.ProductId === p.ProductId && v.Status !== 'deleted'; })
      .map(function (v) {
        return { variantId: v.VariantId, label: v.Label, price: Number(v.Price), sku: v.SKU, stockQty: v.StockQty, status: v.Status };
      });
    return {
      productId: p.ProductId,
      name: p.Name,
      description: p.Description,
      category: categoryIdOf(p.Category),
      listingType: listingTypeOfRow(p),
      imageUrl: p.ImageUrl,
      imageUrl2: p.ImageUrl2,
      status: p.Status,
      sortOrder: p.SortOrder,
      variants: productVariants
    };
  });

  return ok({ products: result, total: allProducts.length, hasMore: offset + limit < allProducts.length });
}

function actionCreateOrUpdateProduct(owner, body) {
  var name = String(body.name || '').trim();
  if (!name) return fail('Product name is required');
  var nameErr = capLength(name, 150, 'Product name');
  if (nameErr) return nameErr;
  var descErr = capLength(body.description, 2000, 'Product description');
  if (descErr) return descErr;
  var categoryErr = capLength(body.category, 50, 'Category');
  if (categoryErr) return categoryErr;

  // Validated against the real list rather than trusted: this decides whether a
  // listing goes to the cart or the date-request flow, so a wrong value would
  // put a car hire in someone's shopping basket.
  var category = categoryIdOf(body.category);
  var listingType = String(body.listingType || '').trim();
  if (LISTING_TYPE_IDS.indexOf(listingType) === -1) {
    // No type sent - an older client, or an edit of a row that predates the
    // field. Recover it from what the row already said rather than defaulting
    // to 'product', which would silently turn a rental into a cart item.
    listingType = listingTypeOfRow({ ListingType: '', Category: body.category });
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var productsSheet = getSheet('Products');
    var variantsSheet = getSheet('Variants');
    var isUpdate = !!body.productId;
    var now = nowIso();
    var productId;

    if (isUpdate) {
      var existing = findRowById(productsSheet, 'ProductId', body.productId);
      if (!existing || existing.OwnerId !== owner.OwnerId) return fail('Product not found');
      productId = existing.ProductId;
      ensureColumn(productsSheet, 'ListingType');
      updateRowFromObject(productsSheet, existing.__row, {
        Name: name,
        Description: body.description || '',
        Category: category,
        ListingType: listingType,
        ImageUrl: body.imageUrl !== undefined ? body.imageUrl : existing.ImageUrl,
        ImageFileId: body.imageFileId !== undefined ? body.imageFileId : existing.ImageFileId,
        ImageUrl2: body.imageUrl2 !== undefined ? body.imageUrl2 : existing.ImageUrl2,
        ImageFileId2: body.imageFileId2 !== undefined ? body.imageFileId2 : existing.ImageFileId2,
        Status: body.status || existing.Status || 'active',
        SortOrder: body.sortOrder !== undefined ? body.sortOrder : existing.SortOrder,
        UpdatedAt: now
      });
    } else {
      productId = newId('prod');
      ensureColumn(productsSheet, 'ListingType');
      appendRowFromObject(productsSheet, {
        ProductId: productId,
        OwnerId: owner.OwnerId,
        StoreSlug: owner.StoreSlug,
        Name: name,
        Description: body.description || '',
        Category: category,
        ListingType: listingType,
        ImageUrl: body.imageUrl || '',
        ImageFileId: body.imageFileId || '',
        ImageUrl2: body.imageUrl2 || '',
        ImageFileId2: body.imageFileId2 || '',
        Status: 'active',
        SortOrder: body.sortOrder || 0,
        CreatedAt: now,
        UpdatedAt: now
      });
    }

    var incoming = Array.isArray(body.variants) ? body.variants : [];
    var existingVariants = sheetToObjects(variantsSheet).filter(function (v) { return v.ProductId === productId; });
    var keptVariantIds = {};

    incoming.forEach(function (v) {
      var label = String(v.label || '').trim();
      var price = Number(v.price);
      if (!label || isNaN(price) || price < 0) return;

      if (v.variantId) {
        var match = existingVariants.filter(function (e) { return e.VariantId === v.variantId; })[0];
        if (match && match.OwnerId === owner.OwnerId) {
          keptVariantIds[v.variantId] = true;
          updateRowFromObject(variantsSheet, match.__row, {
            Label: label,
            Price: price,
            SKU: v.sku || '',
            StockQty: v.stockQty !== undefined ? v.stockQty : match.StockQty,
            Status: 'active'
          });
        }
      } else {
        var newVariantId = newId('var');
        keptVariantIds[newVariantId] = true;
        appendRowFromObject(variantsSheet, {
          VariantId: newVariantId,
          ProductId: productId,
          OwnerId: owner.OwnerId,
          Label: label,
          Price: price,
          SKU: v.sku || '',
          StockQty: v.stockQty || '',
          Status: 'active'
        });
      }
    });

    existingVariants.forEach(function (ev) {
      if (!keptVariantIds[ev.VariantId]) {
        updateRowFromObject(variantsSheet, ev.__row, { Status: 'deleted' });
      }
    });

    invalidateCache(['v1:listProducts:' + owner.StoreSlug]);
    return ok({ productId: productId });
  } finally {
    lock.releaseLock();
  }
}

function actionDeleteProduct(owner, body) {
  var sheet = getSheet('Products');
  var existing = findRowById(sheet, 'ProductId', body.productId);
  if (!existing || existing.OwnerId !== owner.OwnerId) return fail('Product not found');
  updateRowFromObject(sheet, existing.__row, { Status: 'archived', UpdatedAt: nowIso() });
  invalidateCache(['v1:listProducts:' + owner.StoreSlug]);
  return ok({});
}

/**
 * publicOwnerFields (Auth.gs) describes the owner's own ACCOUNT - ownerId,
 * email, status, twoFAEnabled, isAdmin - so it belongs only behind a bearer
 * token. The public actions (actionGetStorePublicInfo, the store object in
 * actionCreateOrder's response) use publicStoreFields instead. idLicenseUrl is
 * narrower still: it is added here, directly on this PROTECTED action's
 * response, so only the owner viewing their own profile ever sees it.
 */
function actionGetOwnerProfile(owner) {
  var fields = publicOwnerFields(owner);
  fields.idLicenseUrl = owner.IdLicenseUrl || '';
  return ok({ owner: fields });
}

function actionUpdateOwnerProfile(owner, body) {
  var sheet = getSheet('Owners');
  // WhatsApp is new. Created past the last header so no existing column moves
  // and no data row is touched - Owners is not in REQUIRED_TABS, so setupSheets
  // must never rewrite its header row. Without this the write would be silently
  // DROPPED: updateRowFromObject matches by header name.
  ensureColumn(sheet, 'WhatsApp');
  // Same additive treatment for the auth-code channel. Appended past the last
  // header, so nothing moves and no vendor row is touched.
  ensureColumn(sheet, 'AuthChannel');
  var update = {};

  if (body.storeName !== undefined) {
    var storeNameErr = capLength(body.storeName, 100, 'Store name');
    if (storeNameErr) return storeNameErr;
    update.StoreName = body.storeName;
  }
  if (body.phone !== undefined) {
    var phoneErr = capLength(body.phone, 30, 'Phone number');
    if (phoneErr) return phoneErr;
    update.Phone = body.phone;
  }
  if (body.messenger !== undefined) {
    var messengerErr = capLength(body.messenger, 100, 'Facebook Messenger');
    if (messengerErr) return messengerErr;
    update.Messenger = body.messenger;
  }
  if (body.authChannel !== undefined) {
    // Allowlisted, not length-capped: this value is read back as a switch, so
    // anything outside the two known channels must not reach the sheet.
    var channel = String(body.authChannel || '').toLowerCase();
    if (channel !== 'email' && channel !== 'sms') return fail('Choose email or SMS for your login codes');
    update.AuthChannel = channel;
  }
  if (body.whatsapp !== undefined) {
    var whatsappErr = capLength(body.whatsapp, 30, 'WhatsApp number');
    if (whatsappErr) return whatsappErr;
    update.WhatsApp = body.whatsapp;
  }
  if (body.island !== undefined) {
    var islandErr = capLength(body.island, 100, 'Island');
    if (islandErr) return islandErr;
    update.Island = body.island;
  }
  if (body.village !== undefined) {
    var villageErr = capLength(body.village, 100, 'Village');
    if (villageErr) return villageErr;
    update.Village = body.village;
  }

  if (body.deliveryTruck !== undefined) update.DeliveryTruck = body.deliveryTruck ? 'true' : 'false';
  if (body.deliveryShip !== undefined) update.DeliveryShip = body.deliveryShip ? 'true' : 'false';
  if (body.deliveryAirCargo !== undefined) update.DeliveryAirCargo = body.deliveryAirCargo ? 'true' : 'false';
  if (body.deliveryPickPay !== undefined) update.DeliveryPickPay = body.deliveryPickPay ? 'true' : 'false';

  var costFieldMap = { deliveryTruckCost: 'DeliveryTruckCost', deliveryShipCost: 'DeliveryShipCost', deliveryAirCargoCost: 'DeliveryAirCargoCost' };
  Object.keys(costFieldMap).forEach(function (k) {
    if (body[k] === undefined) return;
    // null / '' mean "fee to be negotiated" and are stored BLANK, which every
    // read path already treats as negotiated (publicOwnerFields maps a blank
    // cell to null). Number('') is 0, so this has to be checked before the
    // numeric conversion or a negotiated fee would silently become free.
    if (body[k] === null || body[k] === '') {
      update[costFieldMap[k]] = '';
      return;
    }
    var cost = Number(body[k]);
    update[costFieldMap[k]] = isNaN(cost) || cost < 0 ? '' : cost;
  });

  if (body.newPassword) {
    if (String(body.newPassword).length < 8) return fail('Password must be at least 8 characters');
    var salt = Utilities.getUuid();
    update.PasswordSalt = salt;
    update.PasswordHash = hashPassword(body.newPassword, salt);
  }

  // Email gets its own validated path (format, non-blank, not already
  // claimed by another owner) - actionRegisterOwner already enforces all
  // three at signup, this closes the gap where an update could silently
  // skip them, including blanking out the very email password reset
  // depends on. The dedupe check is a check-then-write, so it needs the
  // same lock-guarded read every other duplicate check in this codebase uses.
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var row = findRowById(sheet, 'OwnerId', owner.OwnerId);
    if (!row) return fail('Store account not found');

    if (body.email !== undefined) {
      var emailErr = validateOwnerEmail(body.email, owner.OwnerId);
      if (emailErr) return emailErr;
      update.Email = String(body.email).trim();
    }

    updateRowFromObject(sheet, row.__row, update);
    invalidateCache(['v1:listStores', 'v1:listProducts:' + owner.StoreSlug, 'v2:storeInfo:' + owner.StoreSlug, 'v1:topStores']);
    return ok({ owner: publicOwnerFields(findRowById(sheet, 'OwnerId', owner.OwnerId)) });
  } finally {
    lock.releaseLock();
  }
}
