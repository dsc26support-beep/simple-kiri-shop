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
var TIPS_CACHE_KEY = 'v2:tips';   // v1 -> v2: the payload now carries sellerBadges

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
