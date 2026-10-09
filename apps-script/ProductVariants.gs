/**
 * Saving products with options, per-variant photos, and what shoppers are
 * sent about them. The rules themselves are in ProductOptions.gs (shared with
 * the browser); this file applies them to the sheets. (Owner request, Oct 2026.)
 *
 * NEW COLUMNS, appended after the last header on first use (ensureColumn):
 *   Products.ProductType       'single' | 'options' | '' (older "list of varieties")
 *   Products.OptionsJson       the option types and values (ProductOptions.gs)
 *   Variants.OptionValuesJson  this variant's value per option
 *   Variants.ImagesJson        this variant's photos, primary first:
 *                              [{ id, url, fileId }]
 *   Variants.CreatedAt / UpdatedAt
 * Variants.Status gains 'disabled' - a combination that is not sold (or no
 * longer exists). Its row, stock history and photos stay; it cannot be ordered
 * because every order path accepts only Status 'active'.
 *
 * Price, stock and SKU stay in the existing Price / StockQty / SKU columns, so
 * inventory, reservations, the stock ledger and order processing need no
 * change: a variant is still one Variants row, picked by VariantId.
 */

var PRODUCT_TYPES = ['single', 'options', 'list'];
var VARIANT_PRICE_MAX = 1000000;

function productOptionLimits() {
  var props = PropertiesService.getScriptProperties();
  var num = function (key, dflt, lo, hi) {
    var n = Number(props.getProperty(key));
    return isNaN(n) || !props.getProperty(key) ? dflt : Math.max(lo, Math.min(hi, Math.floor(n)));
  };
  return {
    types: num('PRODUCT_OPTION_TYPES_MAX', PRODUCT_OPTION_LIMITS.types, 1, 5),
    values: num('PRODUCT_OPTION_VALUES_MAX', PRODUCT_OPTION_LIMITS.values, 1, 50),
    variants: num('PRODUCT_VARIANTS_MAX', PRODUCT_OPTION_LIMITS.variants, 1, 250),
    nameMax: PRODUCT_OPTION_LIMITS.nameMax,
    labelMax: PRODUCT_OPTION_LIMITS.labelMax
  };
}

/** Photos allowed per variant. Script Property VARIANT_IMAGES_MAX; 0 turns variant photos off. */
function variantImagesMax() {
  var raw = PropertiesService.getScriptProperties().getProperty('VARIANT_IMAGES_MAX');
  var n = Number(raw);
  return raw === null || raw === '' || isNaN(n) ? 4 : Math.max(0, Math.min(10, Math.floor(n)));
}

/** Money is stored to the cent - never a float like 12.300000001. */
function roundMoney(n) {
  return Math.round(Number(n) * 100) / 100;
}

/** A price a shopper can be charged: a number above 0 and below the cap. */
function variantPriceError(raw, label) {
  var n = Number(raw);
  if (raw === '' || raw === null || raw === undefined || isNaN(n) || n <= 0) return 'Enter a price above 0 for ' + label + '.';
  if (n > VARIANT_PRICE_MAX) return 'The price of ' + label + ' is too high.';
  return '';
}

/** Blank = not tracked (unlimited). Anything else must be a whole number, 0 or more. */
function variantStockError(raw, label) {
  if (raw === '' || raw === null || raw === undefined) return '';
  var n = Number(raw);
  if (isNaN(n) || n < 0 || Math.floor(n) !== n) return 'Stock for ' + label + ' must be a whole number, 0 or more (or blank for unlimited).';
  return '';
}

/**
 * Validates a single-product or options save BEFORE anything is written.
 * Caller holds the script lock. Returns { error } or a plan for applyVariantSave.
 * type '' / 'list' returns null: the older varieties path in Products.gs runs.
 */
function prepareVariantSave(owner, body, prior, existingVariants) {
  var priorType = prior ? productTypeOfRow(prior) : '';
  var type = PRODUCT_TYPES.indexOf(String(body.productType || '')) !== -1 ? String(body.productType) : '';
  // An older cached page saving a product with options would send a plain
  // list of varieties and switch every combination off. Refused instead.
  if (!type && priorType === 'options') return { error: 'This page is out of date. Please reload it and save again.' };
  if (!type || type === 'list') return null;
  if (body.listingType && body.listingType !== 'product') return { error: 'Options and single prices are for products. Rentals and services use a list of rates.' };

  var mine = existingVariants.filter(function (v) { return v.OwnerId === owner.OwnerId && v.Status !== 'deleted'; });
  var incoming = Array.isArray(body.variants) ? body.variants : [];

  if (type === 'single') {
    var one = incoming[0] || {};
    var pErr = variantPriceError(one.price, 'this product');
    if (pErr) return { error: pErr };
    var sErr = variantStockError(one.stockQty, 'this product');
    if (sErr) return { error: sErr };
    var skuErr = capLength(one.sku, 60, 'SKU');
    if (skuErr) return { error: skuErr.error };
    var keep = one.variantId ? mine.filter(function (v) { return v.VariantId === one.variantId; })[0] : null;
    if (one.variantId && !keep) return { error: 'This product changed since you opened it. Please reload and try again.' };
    if (!keep) keep = mine.filter(function (v) { return v.Status === 'active'; })[0] || null;
    return {
      type: 'single', options: [],
      rows: [{ variant: keep, values: {}, label: keep ? (keep.Label || 'Standard') : 'Standard', active: true,
        price: roundMoney(one.price), stockQty: one.stockQty, sku: String(one.sku || '').trim() }],
      disable: mine.filter(function (v) { return v.Status === 'active' && (!keep || v.VariantId !== keep.VariantId); })
    };
  }

  // type === 'options'
  var checked = validateProductOptions(body.options, productOptionLimits());
  if (!checked.ok) return { error: checked.error, field: checked.field };
  var options = checked.options;
  if (incoming.length > productOptionLimits().variants) return { error: 'Too many combinations in one save.' };
  var plan = planVariantChanges(options,
    mine.map(function (v) { return { variantId: v.VariantId, values: variantValuesOf(v), status: v.Status, label: v.Label }; }),
    incoming.map(function (r) { return { variantId: r && r.variantId ? String(r.variantId) : '', values: r && r.values, active: !(r && r.active === false) }; }));
  if (!plan.ok) return { error: plan.error, index: plan.index };

  var byId = {};
  mine.forEach(function (v) { byId[v.VariantId] = v; });
  var skus = {};
  var rows = [];
  for (var i = 0; i < plan.rows.length; i++) {
    var pr = plan.rows[i];
    var raw = incoming[i] || {};
    // A combination switched off that never existed is simply not created.
    if (!pr.active && !pr.variantId) continue;
    if (pr.active) {
      var priceErr = variantPriceError(raw.price, pr.label);
      if (priceErr) return { error: priceErr, index: i };
    }
    var stockErr = variantStockError(raw.stockQty, pr.label);
    if (stockErr) return { error: stockErr, index: i };
    var sku = String(raw.sku || '').trim();
    if (sku.length > 60) return { error: 'Keep the SKU of ' + pr.label + ' to 60 characters.', index: i };
    if (sku) {
      if (skus[sku.toLowerCase()]) return { error: 'SKU "' + sku + '" is used twice.', index: i };
      skus[sku.toLowerCase()] = true;
    }
    var existing = pr.variantId ? byId[pr.variantId] : null;
    var priceOk = !variantPriceError(raw.price, pr.label);
    rows.push({ variant: existing, values: pr.values, label: pr.label, active: pr.active,
      price: priceOk ? roundMoney(raw.price) : (existing ? existing.Price : ''), stockQty: raw.stockQty, sku: sku, key: pr.key });
  }
  return { type: 'options', options: options, rows: rows,
    disable: plan.disabled.map(function (d) { return byId[d.variantId]; }).filter(function (v) { return !!v; }) };
}

/**
 * Writes the plan. Caller holds the lock and has written the product row.
 * Returns { stockMoves, variants: [{ variantId, key, label }] }.
 */
function applyVariantSave(owner, productId, plan, variantsSheet, productsSheet) {
  ['OptionValuesJson', 'ImagesJson', 'CreatedAt', 'UpdatedAt'].forEach(function (h) { ensureColumn(variantsSheet, h); });
  ['ProductType', 'OptionsJson'].forEach(function (h) { ensureColumn(productsSheet, h); });
  var productRow = findRowById(productsSheet, 'ProductId', productId);
  updateRowFromObject(productsSheet, productRow.__row, { ProductType: plan.type, OptionsJson: plan.type === 'options' ? JSON.stringify(plan.options) : '' });

  var now = nowIso();
  var stockMoves = [];
  var out = [];
  plan.rows.forEach(function (r) {
    var stock = r.stockQty === undefined ? (r.variant ? r.variant.StockQty : '') : stockQtyOf(r.stockQty);
    var fields = {
      Label: r.label, Price: r.price, SKU: r.sku, StockQty: stock,
      Status: r.active ? 'active' : 'disabled',
      OptionValuesJson: plan.type === 'options' ? JSON.stringify(r.values) : '',
      UpdatedAt: now
    };
    if (r.variant) {
      updateRowFromObject(variantsSheet, r.variant.__row, fields);
      var move = productFormStockMove(r.variant, stock, owner.OwnerId);
      if (move) stockMoves.push(move);
      out.push({ variantId: r.variant.VariantId, key: r.key || '', label: r.label });
    } else {
      var id = newId('var');
      fields.VariantId = id;
      fields.ProductId = productId;
      fields.OwnerId = owner.OwnerId;
      fields.CreatedAt = now;
      fields.ImagesJson = '';
      appendRowFromObject(variantsSheet, fields);
      if (stock !== '') {
        stockMoves.push({ OwnerId: owner.OwnerId, ProductId: productId, VariantId: id, Quantity: stock, MovementType: 'INITIAL_STOCK',
          PreviousStock: 0, NewStock: stock, PreviousReserved: 0, NewReserved: 0, Source: 'product form', UserId: owner.OwnerId, Notes: 'New option: ' + r.label });
      }
      out.push({ variantId: id, key: r.key || '', label: r.label });
    }
  });
  // Kept, never deleted: open orders, the stock ledger and photos still point here.
  plan.disable.forEach(function (v) {
    updateRowFromObject(variantsSheet, v.__row, { Status: 'disabled', UpdatedAt: now });
  });
  return { stockMoves: stockMoves, variants: out, disabled: plan.disable.length };
}

/* ==================== What shoppers are sent ==================== */

/** Extra product fields for the public payload (only when the product has them). */
function publicOptionFields(product, p) {
  var type = productTypeOfRow(p);
  if (type) product.productType = type;
  if (type === 'options') product.options = productOptionsOf(p);
  return product;
}

/* ==================== Variant photos ==================== */

function ownedVariant(owner, productId, variantId) {
  var product = findRowById(getSheet('Products'), 'ProductId', String(productId || ''));
  if (!product || product.OwnerId !== owner.OwnerId) return { error: 'Product not found' };
  var sheet = getSheet('Variants');
  var v = findRowById(sheet, 'VariantId', String(variantId || ''));
  if (!v || v.ProductId !== product.ProductId || v.OwnerId !== owner.OwnerId || v.Status === 'deleted') return { error: 'Option not found' };
  return { product: product, variant: v, sheet: sheet };
}

/** Adds one photo to a variant's gallery (same checks and storage as product photos). */
function actionUploadVariantImage(owner, body) {
  var max = variantImagesMax();
  if (max === 0) return fail('Photos per option are switched off.');
  var mimeType = String(body.mimeType || '');
  if (!/^image\/(jpeg|png|webp|gif)$/.test(mimeType)) return fail('Use a JPEG, PNG, WebP or GIF photo.');
  if (!body.imageBase64) return fail('No image data received');
  var bytes;
  try { bytes = Utilities.base64Decode(String(body.imageBase64)); } catch (e) { return fail('Invalid image data'); }
  if (!bytes.length) return fail('Invalid image data');
  if (bytes.length > MAX_IMAGE_BYTES) return fail('Image is too large (max 5MB) - please choose a smaller photo');

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  var found, images;
  try {
    found = ownedVariant(owner, body.productId, body.variantId);
    if (found.error) return fail(found.error);
    ensureColumn(found.sheet, 'ImagesJson');
    images = variantImagesOf(found.variant);
    if (images.length >= max) return fail('This option already has ' + max + ' photos. Remove one first.');
  } finally {
    lock.releaseLock();
  }
  // The upload is slow, so it runs outside the lock; the gallery is re-read
  // and re-checked before writing.
  var uploaded = uploadImage(bytes, mimeType, found.variant.VariantId + '_' + Date.now(), getImageFolder);
  lock.waitLock(30000);
  try {
    var fresh = findRowById(found.sheet, 'VariantId', found.variant.VariantId);
    images = variantImagesOf(fresh);
    if (images.length >= max) {
      if (uploaded.imageFileId) deleteStoredImage(uploaded.imageFileId);
      return fail('This option already has ' + max + ' photos. Remove one first.');
    }
    images.push({ id: 'img_' + Utilities.getUuid().replace(/-/g, '').slice(0, 12), url: uploaded.imageUrl, fileId: uploaded.imageFileId || '' });
    updateRowFromObject(found.sheet, fresh.__row, { ImagesJson: JSON.stringify(images), UpdatedAt: nowIso() });
    invalidateCache([storeProductsCacheKey(owner.StoreSlug)]);
    return ok({ images: images.map(function (i) { return { id: i.id, url: i.url }; }) });
  } finally {
    lock.releaseLock();
  }
}

/**
 * Reorders or removes a variant's photos. body.order: the image ids in the
 * new order (the first is the primary photo); ids left out are removed and
 * their stored file deleted. Ids that aren't this variant's are refused.
 */
function actionSetVariantImages(owner, body) {
  var order = Array.isArray(body.order) ? body.order.map(String) : null;
  if (!order) return fail('order is required');
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var found = ownedVariant(owner, body.productId, body.variantId);
    if (found.error) return fail(found.error);
    var images = variantImagesOf(found.variant);
    var byId = {};
    images.forEach(function (i) { byId[i.id] = i; });
    var seen = {};
    for (var k = 0; k < order.length; k++) {
      if (!byId[order[k]] || seen[order[k]]) return fail('Those photos changed. Please reload and try again.');
      seen[order[k]] = true;
    }
    var next = order.map(function (id) { return byId[id]; });
    var removed = images.filter(function (i) { return !seen[i.id]; });
    updateRowFromObject(found.sheet, found.variant.__row, { ImagesJson: next.length ? JSON.stringify(next) : '', UpdatedAt: nowIso() });
    removed.forEach(function (i) { if (i.fileId) deleteStoredImage(i.fileId); });
    invalidateCache([storeProductsCacheKey(owner.StoreSlug)]);
    return ok({ images: next.map(function (i) { return { id: i.id, url: i.url }; }) });
  } finally {
    lock.releaseLock();
  }
}
