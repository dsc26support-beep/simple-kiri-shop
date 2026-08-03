/**
 * Store directory, product/variant CRUD, and owner profile management.
 * Variants are diffed against a full `variants[]` array sent from the
 * dashboard's "Save Product" action - update rows by VariantId, insert
 * new ones, soft-delete rows that were dropped from the array.
 */

function getOwnerBySlug(slug) {
  return sheetToObjects(getSheet('Owners')).filter(function (o) { return o.StoreSlug === slug; })[0] || null;
}

function deliveryFlagsOf(owner) {
  return {
    deliveryTruck: String(owner.DeliveryTruck) === 'true',
    deliveryShip: String(owner.DeliveryShip) === 'true',
    deliveryAirCargo: String(owner.DeliveryAirCargo) === 'true'
  };
}

function actionListStores() {
  var stores = sheetToObjects(getSheet('Owners'))
    .filter(function (o) { return o.Status === 'active'; })
    .map(function (o) {
      var store = { storeSlug: o.StoreSlug, storeName: o.StoreName, phone: o.Phone, island: o.Island, logoUrl: o.LogoUrl };
      Object.assign(store, deliveryFlagsOf(o));
      return store;
    });
  return ok({ stores: stores });
}

/**
 * Cross-store product search, used by the homepage search box and category
 * buttons. Matches on product name/description (case-insensitive substring)
 * and/or exact category, across every active store's active products.
 */
function actionSearchProducts(params) {
  var q = String(params.q || '').trim().toLowerCase();
  var category = String(params.category || '').trim();

  var ownersById = {};
  sheetToObjects(getSheet('Owners'))
    .filter(function (o) { return o.Status === 'active'; })
    .forEach(function (o) { ownersById[o.OwnerId] = o; });

  var variants = sheetToObjects(getSheet('Variants')).filter(function (v) { return v.Status === 'active'; });

  var results = sheetToObjects(getSheet('Products'))
    .filter(function (p) { return p.Status === 'active' && ownersById[p.OwnerId]; })
    .filter(function (p) {
      if (category && p.Category !== category) return false;
      if (q) {
        var haystack = (String(p.Name) + ' ' + String(p.Description)).toLowerCase();
        if (haystack.indexOf(q) === -1) return false;
      }
      return true;
    })
    .map(function (p) {
      var owner = ownersById[p.OwnerId];
      var productVariants = variants
        .filter(function (v) { return v.ProductId === p.ProductId; })
        .map(function (v) { return { variantId: v.VariantId, label: v.Label, price: Number(v.Price) }; });
      var product = {
        productId: p.ProductId,
        name: p.Name,
        description: p.Description,
        category: p.Category,
        imageUrl: p.ImageUrl,
        storeSlug: owner.StoreSlug,
        storeName: owner.StoreName,
        storePhone: owner.Phone,
        storeLogoUrl: owner.LogoUrl,
        variants: productVariants
      };
      product.storeDeliveryTruck = String(owner.DeliveryTruck) === 'true';
      product.storeDeliveryShip = String(owner.DeliveryShip) === 'true';
      product.storeDeliveryAirCargo = String(owner.DeliveryAirCargo) === 'true';
      return product;
    })
    .filter(function (p) { return p.variants.length > 0; });

  return ok({ products: results });
}

function actionGetStorePublicInfo(params) {
  var slug = params.storeSlug;
  if (!slug) return fail('storeSlug is required');
  var owner = getOwnerBySlug(slug);
  if (!owner || owner.Status !== 'active') return fail('Store not found');
  return ok({ store: publicOwnerFields(owner) });
}

function actionListProducts(params) {
  var slug = params.storeSlug;
  if (!slug) return fail('storeSlug is required');
  var owner = getOwnerBySlug(slug);
  if (!owner || owner.Status !== 'active') return fail('Store not found');

  var products = sheetToObjects(getSheet('Products')).filter(function (p) {
    return p.OwnerId === owner.OwnerId && p.Status === 'active';
  });
  var variants = sheetToObjects(getSheet('Variants')).filter(function (v) {
    return v.OwnerId === owner.OwnerId && v.Status === 'active';
  });

  var result = products
    .sort(function (a, b) { return (Number(a.SortOrder) || 0) - (Number(b.SortOrder) || 0); })
    .map(function (p) {
      var productVariants = variants
        .filter(function (v) { return v.ProductId === p.ProductId; })
        .map(function (v) { return { variantId: v.VariantId, label: v.Label, price: Number(v.Price) }; });
      return {
        productId: p.ProductId,
        name: p.Name,
        description: p.Description,
        category: p.Category,
        imageUrl: p.ImageUrl,
        variants: productVariants
      };
    })
    .filter(function (p) { return p.variants.length > 0; });

  var response = { storeName: owner.StoreName, storePhone: owner.Phone, storeLogoUrl: owner.LogoUrl, products: result };
  response.storeDeliveryTruck = String(owner.DeliveryTruck) === 'true';
  response.storeDeliveryShip = String(owner.DeliveryShip) === 'true';
  response.storeDeliveryAirCargo = String(owner.DeliveryAirCargo) === 'true';
  return ok(response);
}

function actionListOwnerProducts(owner) {
  var products = sheetToObjects(getSheet('Products')).filter(function (p) { return p.OwnerId === owner.OwnerId; });
  var variants = sheetToObjects(getSheet('Variants')).filter(function (v) { return v.OwnerId === owner.OwnerId; });

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
      category: p.Category,
      imageUrl: p.ImageUrl,
      status: p.Status,
      sortOrder: p.SortOrder,
      variants: productVariants
    };
  });

  return ok({ products: result });
}

function actionCreateOrUpdateProduct(owner, body) {
  var name = String(body.name || '').trim();
  if (!name) return fail('Product name is required');

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
      updateRowFromObject(productsSheet, existing.__row, {
        Name: name,
        Description: body.description || '',
        Category: body.category || '',
        ImageUrl: body.imageUrl !== undefined ? body.imageUrl : existing.ImageUrl,
        ImageFileId: body.imageFileId !== undefined ? body.imageFileId : existing.ImageFileId,
        Status: body.status || existing.Status || 'active',
        SortOrder: body.sortOrder !== undefined ? body.sortOrder : existing.SortOrder,
        UpdatedAt: now
      });
    } else {
      productId = newId('prod');
      appendRowFromObject(productsSheet, {
        ProductId: productId,
        OwnerId: owner.OwnerId,
        StoreSlug: owner.StoreSlug,
        Name: name,
        Description: body.description || '',
        Category: body.category || '',
        ImageUrl: body.imageUrl || '',
        ImageFileId: body.imageFileId || '',
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
  return ok({});
}

function actionGetOwnerProfile(owner) {
  return ok({ owner: publicOwnerFields(owner) });
}

function actionUpdateOwnerProfile(owner, body) {
  var sheet = getSheet('Owners');
  var row = findRowById(sheet, 'OwnerId', owner.OwnerId);

  var fieldMap = {
    storeName: 'StoreName',
    email: 'Email',
    phone: 'Phone',
    island: 'Island',
    village: 'Village'
  };
  var update = {};
  Object.keys(fieldMap).forEach(function (k) {
    if (body[k] !== undefined) update[fieldMap[k]] = body[k];
  });

  if (body.deliveryTruck !== undefined) update.DeliveryTruck = body.deliveryTruck ? 'true' : 'false';
  if (body.deliveryShip !== undefined) update.DeliveryShip = body.deliveryShip ? 'true' : 'false';
  if (body.deliveryAirCargo !== undefined) update.DeliveryAirCargo = body.deliveryAirCargo ? 'true' : 'false';

  if (body.newPassword) {
    if (String(body.newPassword).length < 8) return fail('Password must be at least 8 characters');
    var salt = Utilities.getUuid();
    update.PasswordSalt = salt;
    update.PasswordHash = hashPassword(body.newPassword, salt);
  }

  updateRowFromObject(sheet, row.__row, update);
  return ok({ owner: publicOwnerFields(findRowById(sheet, 'OwnerId', owner.OwnerId)) });
}
