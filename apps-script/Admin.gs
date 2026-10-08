/**
 * Admin back-office + Tips (Phase 4).
 *
 * Admin = a store owner whose email is listed in the ADMIN_EMAILS Script
 * Property (comma-separated). Admins log in with their normal owner account;
 * the admin actions here additionally require isOwnerAdmin. Curated Tips items
 * live in a Featured sheet (getSheet throws if missing) - create it with these
 * exact headers:
 *   Featured: FeaturedId | Type | RefId | SortOrder | CreatedAt   (Type: product|store)
 */

function getAdminEmails() {
  var raw = PropertiesService.getScriptProperties().getProperty('ADMIN_EMAILS') || '';
  return raw.split(',')
    .map(function (s) { return normalizeEmail(s); })
    .filter(function (s) { return !!s; });
}

function isOwnerAdmin(owner) {
  if (!owner || !owner.Email) return false;
  return getAdminEmails().indexOf(normalizeEmail(owner.Email)) !== -1;
}

/**
 * 'retailer' | 'wholesaler' | 'distributor' (distributor = multi-location:
 * branches, warehouses). Blank - every store from before the choice existed -
 * and anything unknown reads as retailer.
 */
function storeTypeOf(owner) {
  var t = owner ? String(owner.StoreType) : '';
  return t === 'wholesaler' || t === 'distributor' ? t : 'retailer';
}

/**
 * Wholesalers and distributors are treated alike for the verification call
 * and Food & Groceries (owner decision: "like wholesaler").
 */
function isBulkSeller(owner) {
  return storeTypeOf(owner) !== 'retailer';
}

/** Food & Groceries listing permission - one place, so business types can grow. */
function canListFood(owner) {
  return isBulkSeller(owner);
}

/**
 * A new wholesaler means someone at Mwakete has to book a verification call,
 * so every admin gets the details needed to do it. Best effort - a failed
 * send never blocks the registration that triggered it.
 */
function notifyAdminsOfWholesaler(owner) {
  if (!owner) return;
  var admins = getAdminEmails();
  if (!admins.length) return;
  var adminUrl = siteBaseUrl() ? siteBaseUrl() + '/owner/admin.html' : '';
  var body = 'A new store registered as a ' + storeTypeOf(owner).toUpperCase() + ' and needs a verification call.\n\n' +
    'Store: ' + owner.StoreName + '\n' +
    'Phone: ' + owner.Phone + '\n' +
    'Email: ' + owner.Email + '\n' +
    'Username: ' + owner.Username + '\n' +
    (adminUrl ? '\nMark them verified after the call: ' + adminUrl + '\n' : '');
  admins.forEach(function (to) {
    try { sendAppEmail(to, 'Wholesaler verification call needed - ' + owner.StoreName, body); } catch (e) { Logger.log('wholesaler notify failed: ' + e); }
  });
}

function featuredLabel(type, refId) {
  if (type === 'store') {
    var o = getOwnerBySlug(refId);
    return o ? o.StoreName : refId;
  }
  var p = findRowById(getSheet('Products'), 'ProductId', refId);
  return p ? p.Name : refId;
}

/* ---------- Admin actions (owner token + admin email) ---------- */

function actionListFeatured(owner, body) {
  if (!isOwnerAdmin(owner)) return fail('Not authorized');
  var rows = sheetToObjects(getSheet('Featured'));
  rows.sort(function (a, b) { return Number(a.SortOrder) - Number(b.SortOrder); });
  return ok({
    featured: rows.map(function (r) {
      return { featuredId: r.FeaturedId, type: r.Type, refId: r.RefId, sortOrder: Number(r.SortOrder), label: featuredLabel(r.Type, r.RefId) };
    })
  });
}

function actionAddFeatured(owner, body) {
  if (!isOwnerAdmin(owner)) return fail('Not authorized');
  var type = String(body.type || '');
  var refId = String(body.refId || '').trim();
  if (type !== 'product' && type !== 'store') return fail('Invalid type');
  if (!refId) return fail('Nothing selected to feature');

  if (type === 'store') {
    if (!getOwnerBySlug(refId)) return fail('Store not found');
  } else if (!findRowById(getSheet('Products'), 'ProductId', refId)) {
    return fail('Product not found');
  }

  var sheet = getSheet('Featured');
  var rows = sheetToObjects(sheet);
  if (rows.filter(function (r) { return r.Type === type && String(r.RefId) === refId; })[0]) {
    return fail('That is already featured.');
  }
  var maxOrder = rows.reduce(function (m, r) { return Math.max(m, Number(r.SortOrder) || 0); }, 0);
  appendRowFromObject(sheet, {
    FeaturedId: newId('feat'),
    Type: type,
    RefId: refId,
    SortOrder: maxOrder + 1,
    CreatedAt: nowIso()
  });
  invalidateCache([TIPS_CACHE_KEY]);
  return ok({});
}

function actionRemoveFeatured(owner, body) {
  if (!isOwnerAdmin(owner)) return fail('Not authorized');
  var sheet = getSheet('Featured');
  var row = findRowById(sheet, 'FeaturedId', String(body.featuredId || ''));
  if (row) sheet.deleteRow(row.__row);
  invalidateCache([TIPS_CACHE_KEY]);
  return ok({});
}

/* ---------- Public Tips read ---------- */

// Resolves featured products to the browse-card shape (same as
// actionSearchProducts) and featured stores to a lightweight store object,
// skipping missing or inactive refs, preserving the admin's order.
// Admin-curated and changed by hand a few times a week, but it costs FOUR
// full-tab reads (Featured, Owners, Variants, Products) and was uncached, so
// every visit to the Tips page paid all four. 300s matches the homepage's
// top-products cache, which is the same kind of slow-moving editorial data.
// addFeatured/removeFeatured drop the key, so an admin's change is visible
// immediately rather than up to five minutes later.
var TIPS_CACHE_TTL_SECONDS = 300;
var TIPS_CACHE_KEY = 'v4:tips';   // v1 -> v2: the payload now carries sellerBadges; v3: admin stores hidden; v4: store island/village

function actionGetTips(params) {
  return getCached(TIPS_CACHE_KEY, TIPS_CACHE_TTL_SECONDS, function () {
    return buildTips();
  });
}

function buildTips() {
  // One read for the whole page, same as every other badge-bearing builder.
  var badges = sellerBadgeIndex();
  var featured = sheetToObjects(getSheet('Featured'));
  featured.sort(function (a, b) { return Number(a.SortOrder) - Number(b.SortOrder); });

  var productIds = [];
  var storeSlugs = [];
  featured.forEach(function (f) {
    if (f.Type === 'product') productIds.push(String(f.RefId));
    else if (f.Type === 'store') storeSlugs.push(String(f.RefId));
  });
  // Paid featuring (Featuring.gs) - after the admin's own picks, never
  // duplicating one. Expiry rides this function's 5-minute cache.
  activePaidFeaturedProductIds().forEach(function (id) {
    if (productIds.indexOf(id) === -1) productIds.push(id);
  });

  var owners = sheetToObjects(getSheet('Owners'));
  var ownersBySlug = {};
  var ownersById = {};
  owners.forEach(function (o) { ownersBySlug[o.StoreSlug] = o; ownersById[o.OwnerId] = o; });

  var stores = [];
  storeSlugs.forEach(function (slug) {
    var o = ownersBySlug[slug];
    if (isStoreBrowsable(o)) {
      stores.push(attachSellerBadges(
        { storeSlug: o.StoreSlug, storeName: o.StoreName, logoUrl: o.LogoUrl, island: o.Island, village: o.Village },
        badges, o.OwnerId));
    }
  });

  var products = [];
  if (productIds.length) {
    var want = {};
    productIds.forEach(function (id) { want[id] = true; });
    var variants = sheetToObjects(getSheet('Variants'));
    var byId = {};
    sheetToObjects(getSheet('Products')).forEach(function (p) {
      if (!want[p.ProductId] || p.Status !== 'active') return;
      var owner = ownersById[p.OwnerId];
      if (!isStoreBrowsable(owner)) return;
      var pv = variants
        .filter(function (v) { return v.ProductId === p.ProductId && v.Status === 'active'; })
        .map(function (v) { return { variantId: v.VariantId, label: v.Label, price: Number(v.Price) }; });
      if (pv.length === 0) return;
      byId[p.ProductId] = attachSellerBadges({
        productId: p.ProductId,
        name: p.Name,
        description: p.Description,
        category: p.Category,
        imageUrl: p.ImageUrl,
        imageUrl2: p.ImageUrl2,
        storeSlug: owner.StoreSlug,
        storeName: owner.StoreName,
        storePhone: owner.Phone,
        storeLogoUrl: owner.LogoUrl,
        // Product cards show where the store is (island, or village on South Tarawa).
        storeIsland: owner.Island,
        storeVillage: owner.Village,
        variants: pv,
        storeDeliveryTruck: String(owner.DeliveryTruck) === 'true',
        storeDeliveryShip: String(owner.DeliveryShip) === 'true',
        storeDeliveryAirCargo: String(owner.DeliveryAirCargo) === 'true',
        storeDeliveryPickPay: String(owner.DeliveryPickPay) === 'true',
        storeDeliveryTruckCost: deliveryCostOf(owner.DeliveryTruckCost),
        storeDeliveryShipCost: deliveryCostOf(owner.DeliveryShipCost),
        storeDeliveryAirCargoCost: deliveryCostOf(owner.DeliveryAirCargoCost)
      }, badges, owner.OwnerId);
    });
    productIds.forEach(function (id) { if (byId[id]) products.push(byId[id]); });
  }

  topUpTipsWithRecommended(stores, badges, owners);
  return ok({ products: products, stores: stores });
}

/*
 * Mwakete Recommended stores QUALIFY for Tips exposure. They are not guaranteed
 * it, and they never displace a curated one.
 *
 * Curated items keep every slot they had; recommended stores only fill what is
 * left up to TIPS_STORE_SLOTS, in the order the snapshot happens to hold, and
 * a store an admin already featured is not listed twice. So a page an admin has
 * filled looks exactly as it did before, and a thin one gets the stores that
 * earned their way there rather than staying empty.
 *
 * ORGANIC ONLY. There is no paid placement in this application and this is not
 * a route to one. If sponsored slots are ever added they must be a SEPARATE,
 * LABELLED list - never mixed into this array, where a shopper would read a
 * purchase as something a seller earned. The trust badges are the thing that
 * must not become buyable, and quietly widening this function is how that would
 * happen.
 */
var TIPS_STORE_SLOTS = 8;

function topUpTipsWithRecommended(stores, badges, owners) {
  if (stores.length >= TIPS_STORE_SLOTS) return;

  var already = {};
  stores.forEach(function (s) { already[s.storeSlug] = true; });

  for (var i = 0; i < owners.length && stores.length < TIPS_STORE_SLOTS; i++) {
    var o = owners[i];
    if (already[o.StoreSlug]) continue;
    if (!isStoreBrowsable(o)) continue;
    var ids = badges[String(o.OwnerId)] || [];
    if (ids.indexOf('recommended') === -1) continue;
    stores.push(attachSellerBadges(
      { storeSlug: o.StoreSlug, storeName: o.StoreName, logoUrl: o.LogoUrl,
        island: o.Island, village: o.Village },
      badges, o.OwnerId));
  }
}

/* ---------- Seller badges (admin) -------------------------------------------
 *
 * Everything here is gated on isOwnerAdmin, the same gate the Featured actions
 * use. This is the ONLY place scores, order counts, reply times and the wording
 * of why a badge was awarded are allowed out of the backend - the customer
 * responses in Products.gs carry the id list and nothing else.
 *
 * AN OVERRIDE NEVER REPLACES THE AUTOMATED ANSWER. Every row returns what the
 * data said (autoBadges) alongside what is actually shown (badges) and which
 * source decided each one, so the admin sees "not eligible, shown because you
 * granted it" rather than one merged answer that hides which is which.
 */

/** Admin view of every seller's badges, score and the metrics behind them. */
function actionListSellerBadges(owner, body) {
  if (!isOwnerAdmin(owner)) return fail('Not authorized');

  var snapshots = {};
  try {
    sheetToObjects(getSheet('SellerBadges')).forEach(function (r) {
      snapshots[String(r.OwnerId)] = r;
    });
  } catch (err) {
    // Tab missing - report every seller as un-computed rather than failing, so
    // the page can still offer the Recompute button that creates it.
    snapshots = {};
  }

  var rows = sheetToObjects(getSheet('Owners')).map(function (o) {
    var snap = snapshots[String(o.OwnerId)] || {};
    var reason = {};
    var metrics = {};
    try { reason = JSON.parse(snap.ReasonJson || '{}'); } catch (e) { reason = {}; }
    try { metrics = JSON.parse(snap.MetricsJson || '{}'); } catch (e) { metrics = {}; }

    return {
      ownerId: o.OwnerId,
      storeName: o.StoreName,
      storeSlug: o.StoreSlug,
      status: o.Status,
      createdAt: o.CreatedAt ? String(o.CreatedAt) : '',
      badges: String(snap.Badges || '').split(',').filter(function (s) { return !!s; }),
      autoBadges: reason.auto || [],
      source: reason.source || {},
      why: reason.why || {},
      suppressed: String(o.BadgeSuppressed) === 'true',
      // The raw override cells, so the admin UI shows the state that is stored
      // rather than inferring it from the result.
      overrides: {
        verified: String(o.BadgeVerified || ''),
        recommended: String(o.BadgeRecommended || '')
      },
      score: snap.Score === '' || snap.Score === undefined ? null : Number(snap.Score),
      metrics: metrics,
      updatedAt: snap.UpdatedAt ? String(snap.UpdatedAt) : ''
    };
  });

  // Most decorated first, so whoever is reviewing sees the sellers whose badges
  // carry the most weight before scrolling.
  rows.sort(function (a, b) {
    if (b.badges.length !== a.badges.length) return b.badges.length - a.badges.length;
    return String(a.storeName).localeCompare(String(b.storeName));
  });

  return ok({ sellers: rows, config: badgeConfig(), badgeIds: BADGE_IDS });
}

/**
 * Grant, revoke or clear an admin override on one seller.
 *
 * field: 'verified' | 'recommended' | 'suppressed'
 * value: 'true' | 'false' | ''   ('' means "leave it to the data")
 *
 * Only these three cells are writable, and only these three values - the
 * request body never reaches a column name or a badge id.
 */
var BADGE_OVERRIDE_COLUMNS = {
  verified: 'BadgeVerified',
  recommended: 'BadgeRecommended',
  suppressed: 'BadgeSuppressed'
};

function actionSetSellerBadgeOverride(owner, body) {
  if (!isOwnerAdmin(owner)) return fail('Not authorized');

  var column = BADGE_OVERRIDE_COLUMNS[String(body.field || '')];
  if (!column) return fail('Unknown badge control');

  var value = String(body.value === undefined ? '' : body.value);
  if (['true', 'false', ''].indexOf(value) === -1) return fail('Invalid value');

  var sheet = getSheet('Owners');
  var row = findRowById(sheet, 'OwnerId', String(body.ownerId || ''));
  if (!row) return fail('Store not found');

  ensureBadgeColumns();
  updateRowFromObject(sheet, row.__row, (function () {
    var patch = {};
    patch[column] = value;
    return patch;
  })());

  // Recomputed immediately rather than waiting up to six hours for the trigger.
  // An admin who verifies a seller and then cannot see it on the storefront has
  // no way to tell a slow system from a broken one.
  recomputeSellerBadges();
  return ok({ ownerId: body.ownerId, field: body.field, value: value });
}

/**
 * Change one configuration value.
 *
 * The key must be one this build knows - BADGE_CONFIG_DEFAULTS is the
 * whitelist, so a request body can never introduce a setting, and a typo is
 * refused rather than silently stored and ignored.
 */
function actionSetBadgeConfig(owner, body) {
  if (!isOwnerAdmin(owner)) return fail('Not authorized');

  var key = String(body.key || '').trim();
  if (!Object.prototype.hasOwnProperty.call(BADGE_CONFIG_DEFAULTS, key)) {
    return fail('Unknown setting: ' + key);
  }

  var value = String(body.value === undefined ? '' : body.value).trim();
  // Two shapes only: an on/off switch, or a number. Anything else would be
  // stored, read back by badgeNum as NaN, and quietly fall through to the
  // default - a setting that looks changed and is not.
  if (key.indexOf('enabled.') === 0 || key.indexOf('.use') !== -1) {
    if (value !== 'true' && value !== 'false') return fail('That setting is true or false');
  } else {
    if (value === '' || isNaN(Number(value))) return fail('That setting must be a number');
    if (Number(value) < 0) return fail('That setting cannot be negative');
  }

  var sheet = getSheet('BadgeConfig');
  var existing = sheetToObjects(sheet).filter(function (r) {
    return String(r.Key).trim() === key;
  })[0];

  if (existing) updateRowFromObject(sheet, existing.__row, { Key: key, Value: value, UpdatedAt: nowIso() });
  else appendRowFromObject(sheet, { Key: key, Value: value, UpdatedAt: nowIso() });

  invalidateCache([BADGE_CONFIG_CACHE_KEY]);
  recomputeSellerBadges();
  return ok({ key: key, value: value });
}

/** Rebuild the snapshot now, rather than waiting for the six-hourly trigger. */
function actionRecomputeBadges(owner) {
  if (!isOwnerAdmin(owner)) return fail('Not authorized');
  var count = recomputeSellerBadges();
  return ok({ sellers: count });
}

/* ---------- Wholesaler verification (admin) ---------- */

/** Every wholesaler store, unverified first, then newest first - the queue an admin works through. */
function actionListWholesalers(owner) {
  if (!isOwnerAdmin(owner)) return fail('Not authorized');
  var list = sheetToObjects(getSheet('Owners'))
    .filter(function (o) { return isBulkSeller(o); })
    .map(function (o) {
      return {
        ownerId: o.OwnerId, storeName: o.StoreName, storeSlug: o.StoreSlug, storeType: storeTypeOf(o),
        phone: o.Phone, email: o.Email, createdAt: o.CreatedAt,
        verified: String(o.WholesaleVerified) === 'true'
      };
    })
    .sort(function (a, b) {
      if (a.verified !== b.verified) return a.verified ? 1 : -1;
      return String(b.createdAt).localeCompare(String(a.createdAt));
    });
  return ok({ wholesalers: list });
}

/** body.ownerId, body.verified (boolean). Only a wholesaler store can be marked. */
function actionSetWholesaleVerified(owner, body) {
  if (!isOwnerAdmin(owner)) return fail('Not authorized');
  var sheet = getSheet('Owners');
  var row = findRowById(sheet, 'OwnerId', String(body.ownerId || ''));
  if (!row) return fail('Store not found');
  if (!isBulkSeller(row)) return fail('That store is not registered as a wholesaler or distributor');
  ensureColumn(sheet, 'WholesaleVerified');
  updateRowFromObject(sheet, row.__row, { WholesaleVerified: body.verified ? 'true' : '' });
  return ok({ ownerId: row.OwnerId, verified: !!body.verified });
}

/* ---------- Admin search + store analytics ---------- */

/**
 * body.q: at least 2 characters. Matches stores by name, slug, email or phone
 * and products by name - every status, closed included, since this is the
 * admin's lookup. At most 20 of each.
 */
function actionAdminSearch(owner, body) {
  if (!isOwnerAdmin(owner)) return fail('Not authorized');
  var q = String(body.q || '').trim().toLowerCase();
  if (q.length < 2) return ok({ stores: [], products: [] });
  var has = function (v) { return String(v || '').toLowerCase().indexOf(q) !== -1; };
  var owners = sheetToObjects(getSheet('Owners'));
  var storeNames = {};
  owners.forEach(function (o) { storeNames[o.OwnerId] = o.StoreName; });
  var stores = owners
    .filter(function (o) { return has(o.StoreName) || has(o.StoreSlug) || has(o.Email) || has(o.Phone); })
    .slice(0, 20)
    .map(function (o) { return { ownerId: o.OwnerId, storeName: o.StoreName, storeSlug: o.StoreSlug, status: o.Status }; });
  var products = sheetToObjects(getSheet('Products'))
    .filter(function (p) { return has(p.Name); })
    .slice(0, 20)
    .map(function (p) {
      return { productId: p.ProductId, name: p.Name, status: p.Status, ownerId: p.OwnerId, storeName: storeNames[p.OwnerId] || '' };
    });
  return ok({ stores: stores, products: products });
}

/** body.ownerId. Everything the admin dashboard shows about one store. */
function actionAdminStoreAnalytics(owner, body) {
  if (!isOwnerAdmin(owner)) return fail('Not authorized');
  var ownerId = String(body.ownerId || '');
  var store = findRowById(getSheet('Owners'), 'OwnerId', ownerId);
  if (!store) return fail('Store not found.');
  var mine = function (r) { return r.OwnerId === ownerId; };
  var optional = function (name) {
    var sheet = SpreadsheetApp.getActive().getSheetByName(name);
    return sheet ? sheetToObjects(sheet).filter(mine) : [];
  };
  return ok({ analytics: buildStoreAnalytics(store, {
    products: sheetToObjects(getSheet('Products')).filter(mine),
    variants: sheetToObjects(getSheet('Variants')).filter(mine),
    orders: sheetToObjects(getSheet('Orders')).filter(mine),
    bookings: optional('Bookings'),
    reviews: optional('Reviews'),
    featurePurchases: optional('FeaturePurchases'),
    adminFeatured: sheetToObjects(getSheet('Featured')).some(function (f) {
      return f.Type === 'store' && f.RefId === store.StoreSlug;
    })
  }) });
}

/** Pure: the analytics panel's numbers from one store's rows (tested in tests/test-admin-analytics.js). */
function buildStoreAnalytics(store, d) {
  var count = function (rows) {
    var by = {};
    rows.forEach(function (r) { by[r.Status || 'Unknown'] = (by[r.Status || 'Unknown'] || 0) + 1; });
    return by;
  };
  var cents = function (n) { return Math.round(n * 100) / 100; };

  var products = d.products.map(function (p) {
    var vs = d.variants.filter(function (v) { return v.ProductId === p.ProductId && v.Status !== 'archived'; });
    var prices = vs.map(function (v) { return Number(v.Price); }).filter(function (n) { return !isNaN(n); });
    var tracked = vs.filter(function (v) { return v.StockQty !== '' && v.StockQty != null; });
    return {
      productId: p.ProductId, name: p.Name, status: p.Status, category: p.Category || '',
      views: Number(p.Views) || 0,
      minPrice: prices.length ? Math.min.apply(null, prices) : null,
      stock: tracked.length ? tracked.reduce(function (s, v) { return s + (Number(v.StockQty) || 0); }, 0) : null
    };
  }).sort(function (a, b) { return b.views - a.views; });

  var sold = d.orders.filter(function (o) { return o.Status === 'Paid' || o.Status === 'Fulfilled'; });
  var published = d.reviews.filter(function (r) { return r.Status === 'published'; });
  var ratingSum = published.reduce(function (s, r) { return s + (Number(r.Rating) || 0); }, 0);
  var now = Date.now();
  var paidFeaturing = d.featurePurchases.filter(function (f) { return f.Status === 'Approved'; });

  return {
    store: {
      ownerId: store.OwnerId, storeName: store.StoreName, storeSlug: store.StoreSlug,
      email: store.Email || '', phone: store.Phone || '', island: store.Island || '', village: store.Village || '',
      status: store.Status, storeType: storeTypeOf(store),
      wholesaleVerified: String(store.WholesaleVerified).toUpperCase() === 'TRUE',
      createdAt: store.CreatedAt || '', visits: Number(store.Visits) || 0, adminFeatured: !!d.adminFeatured
    },
    products: products,
    totals: {
      products: products.length,
      activeProducts: products.filter(function (p) { return p.status === 'active'; }).length,
      views: products.reduce(function (s, p) { return s + p.views; }, 0)
    },
    orders: { count: d.orders.length, byStatus: count(d.orders), sales: cents(sold.reduce(function (s, o) { return s + (Number(o.Total) || 0); }, 0)) },
    bookings: { count: d.bookings.length, byStatus: count(d.bookings) },
    reviews: { count: published.length, average: published.length ? Math.round(ratingSum / published.length * 10) / 10 : null },
    featuring: {
      purchases: d.featurePurchases.length,
      spent: cents(paidFeaturing.reduce(function (s, f) { return s + (Number(f.Amount) || 0); }, 0)),
      activeNow: paidFeaturing.some(function (f) {
        return f.StartsAt && f.EndsAt && new Date(f.StartsAt).getTime() <= now && new Date(f.EndsAt).getTime() > now;
      }),
      recent: d.featurePurchases.slice().sort(function (a, b) { return String(b.CreatedAt).localeCompare(String(a.CreatedAt)); })
        .slice(0, 5).map(function (f) {
          return { reference: f.Reference, status: f.Status, amount: Number(f.Amount) || 0, days: Number(f.Days) || 0, endsAt: f.EndsAt || '' };
        })
    }
  };
}

/* ---------- Inventory & Sync monitoring (admin) ---------- */

/**
 * Platform-wide view of inventory sync for the admin dashboard. Counts and
 * recent problems only - never a seller's sheet ID, link or anything that
 * could open their data (none is stored that could, but it isn't shown either).
 */
function actionAdminInventoryOverview(owner) {
  if (!isOwnerAdmin(owner)) return fail('Not authorized');
  var rows = function (name) {
    var sheet = SpreadsheetApp.getActive().getSheetByName(name);
    return sheet ? sheetToObjects(sheet) : [];
  };
  return ok({ overview: buildInventoryOverview({
    owners: rows('Owners'), variants: rows('Variants'), connections: rows('InventoryConnections'),
    jobs: rows('SyncJobs'), conflicts: rows('SyncConflicts')
  }) });
}

/** Pure: the overview numbers (tested in tests/test-admin-inventory.js). */
function buildInventoryOverview(d) {
  var names = {};
  var types = { retailer: 0, wholesaler: 0, distributor: 0 };
  d.owners.forEach(function (o) {
    names[o.OwnerId] = o.StoreName;
    if (o.Status !== 'closed') types[storeTypeOf(o)]++;
  });
  var tracking = {};
  var synced = 0;
  d.variants.forEach(function (v) {
    if (v.Status !== 'active') return;
    if (v.StockQty !== '' && v.StockQty != null) tracking[v.OwnerId] = true;
    if (v.LastSyncedAt) synced++;
  });
  var live = d.connections.filter(function (c) { return c.Status !== 'disconnected'; });
  var byType = {};
  live.forEach(function (c) { byType[c.Type] = (byType[c.Type] || 0) + 1; });
  var failing = live.filter(function (c) { return c.LastSyncStatus === 'FAILED'; });
  var jobs = d.jobs.slice().sort(function (a, b) { return String(b.CompletedAt).localeCompare(String(a.CompletedAt)); });
  var lastOk = jobs.filter(function (j) { return j.Status === 'SUCCESS' || j.Status === 'PARTIAL_SUCCESS'; })[0];
  var summaryError = function (j) {
    try { var s = JSON.parse(j.SummaryJson || '{}'); return s.writeError || ((s.errors || [])[0] || {}).message || ''; } catch (e) { return ''; }
  };
  return {
    businessTypes: types,
    trackingStock: Object.keys(tracking).length,
    connectedBusinesses: Object.keys(live.reduce(function (m, c) { m[c.OwnerId] = true; return m; }, {})).length,
    connections: { total: live.length, byType: byType, failing: failing.length },
    productsSynced: synced,
    openConflicts: d.conflicts.filter(function (x) { return x.Status === 'open'; }).length,
    lastSuccessfulSync: lastOk ? lastOk.CompletedAt : '',
    syncsLast7Days: jobs.filter(function (j) { return new Date(j.CompletedAt).getTime() > Date.now() - 7 * 86400000; }).length,
    failingConnections: failing.slice(0, 20).map(function (c) {
      return { store: names[c.OwnerId] || c.OwnerId, name: c.Name, type: c.Type, since: c.LastSyncAt || '', error: String(c.LastError || '').slice(0, 200) };
    }),
    recentFailures: jobs.filter(function (j) { return j.Status === 'FAILED'; }).slice(0, 20).map(function (j) {
      return { store: names[j.OwnerId] || j.OwnerId, type: j.ConnectorType, at: j.CompletedAt, error: summaryError(j).slice(0, 200) };
    })
  };
}
