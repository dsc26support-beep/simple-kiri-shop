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
  return ok({});
}

function actionRemoveFeatured(owner, body) {
  if (!isOwnerAdmin(owner)) return fail('Not authorized');
  var sheet = getSheet('Featured');
  var row = findRowById(sheet, 'FeaturedId', String(body.featuredId || ''));
  if (row) sheet.deleteRow(row.__row);
  return ok({});
}

/* ---------- Public Tips read ---------- */

// Resolves featured products to the browse-card shape (same as
// actionSearchProducts) and featured stores to a lightweight store object,
// skipping missing or inactive refs, preserving the admin's order.
function actionGetTips(params) {
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
    if (o && o.Status === 'active') {
      stores.push({ storeSlug: o.StoreSlug, storeName: o.StoreName, logoUrl: o.LogoUrl, island: o.Island, village: o.Village });
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
      if (!owner || owner.Status !== 'active') return;
      var pv = variants
        .filter(function (v) { return v.ProductId === p.ProductId && v.Status === 'active'; })
        .map(function (v) { return { variantId: v.VariantId, label: v.Label, price: Number(v.Price) }; });
      if (pv.length === 0) return;
      byId[p.ProductId] = {
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
      };
    });
    productIds.forEach(function (id) { if (byId[id]) products.push(byId[id]); });
  }

  return ok({ products: products, stores: stores });
}
