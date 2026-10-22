/**
 * Product photo / store logo upload. Requires a valid owner token - without
 * auth here, the fallback Drive folder would become open anonymous file
 * hosting for anyone who finds the exec URL. Actual image hosting goes
 * through Utils.gs's uploadImage()/deleteStoredImage(), which upload to
 * Cloudinary when configured (Script Properties) and fall back to this
 * file's Drive folder otherwise - see the comment above uploadImage.
 */

var MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5MB decoded

function getImageFolder() {
  var props = PropertiesService.getScriptProperties();
  var folderId = props.getProperty('IMAGE_FOLDER_ID');
  if (folderId) {
    try {
      return DriveApp.getFolderById(folderId);
    } catch (e) {
      // stored id no longer valid, fall through and recreate
    }
  }
  var folder = DriveApp.createFolder('Mwakete Product Images');
  props.setProperty('IMAGE_FOLDER_ID', folder.getId());
  return folder;
}

/**
 * The older one-photo-at-a-time upload (slot 1 = main photo, slot 2 = second
 * photo). Kept for any client still using it; it now writes into the product
 * photo gallery below, replacing that position or adding to the end.
 */
function actionUploadProductImage(owner, body) {
  var slot = Number(body.slot) === 2 ? 2 : 1;
  if (!body.productId) return fail('productId is required');
  var product = findRowById(getSheet('Products'), 'ProductId', String(body.productId));
  if (!product || product.OwnerId !== owner.OwnerId) return fail('Product not found');
  var current = productGalleryOf(product)[slot - 1];
  var res = actionUploadProductPhoto(owner, {
    productId: body.productId, imageBase64: body.imageBase64, mimeType: body.mimeType, replaceId: current ? current.id : ''
  });
  if (!res.ok) return res;
  var placed = res.images.filter(function (i) { return i.id === res.imageId; })[0];
  return ok({ imageUrl: placed ? placed.url : '', slot: slot, images: res.images });
}

/* ==================== Product photo gallery ==================== */
/*
 * A product keeps up to PRODUCT_IMAGES_MAX photos (Script Property, default 6)
 * in Products.ImagesJson: [{ id, url, fileId, req }] - the first is the cover.
 * ImageUrl/ImageFileId and ImageUrl2/ImageFileId2 are ALWAYS rewritten to the
 * first two, so every page, cache and older client that reads those two keeps
 * working unchanged. A product saved before the gallery existed has no
 * ImagesJson; its gallery is read from those two fields.
 *
 * Only these actions change a product's photos. createProduct/updateProduct
 * ignore any photo fields a browser sends (a stored file id from a browser
 * could name somebody else's file, which replacing would then delete).
 */

var PRODUCT_IMAGE_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

function productImagesMax() {
  var raw = PropertiesService.getScriptProperties().getProperty('PRODUCT_IMAGES_MAX');
  var n = Number(raw);
  if (raw === null || raw === '' || isNaN(n)) return 6;
  return Math.max(2, Math.min(12, Math.floor(n)));
}

/**
 * What the bytes actually are, from their first bytes - never from the
 * browser's word or the file name. Apps Script bytes are signed (-128..127).
 * Returns 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif' | ''.
 */
function sniffImageType(bytes) {
  if (!bytes || bytes.length < 12) return '';
  var b = function (i) { return bytes[i] & 0xff; };
  if (b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff) return 'image/jpeg';
  if (b(0) === 0x89 && b(1) === 0x50 && b(2) === 0x4e && b(3) === 0x47 && b(4) === 0x0d && b(5) === 0x0a && b(6) === 0x1a && b(7) === 0x0a) return 'image/png';
  if (b(0) === 0x52 && b(1) === 0x49 && b(2) === 0x46 && b(3) === 0x46 && b(8) === 0x57 && b(9) === 0x45 && b(10) === 0x42 && b(11) === 0x50) return 'image/webp';
  if (b(0) === 0x47 && b(1) === 0x49 && b(2) === 0x46 && b(3) === 0x38) return 'image/gif';
  return '';
}

/** Decodes and checks an uploaded photo. { bytes, mimeType } or { error }. */
function checkedProductPhoto(body) {
  if (!body.imageBase64) return { error: 'No image data received' };
  if (String(body.imageBase64).length > Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 8) return { error: 'Image is too large (max 5MB) - please choose a smaller photo' };
  var bytes;
  try { bytes = Utilities.base64Decode(String(body.imageBase64)); } catch (e) { return { error: 'Invalid image data' }; }
  if (!bytes || !bytes.length) return { error: 'Invalid image data' };
  if (bytes.length > MAX_IMAGE_BYTES) return { error: 'Image is too large (max 5MB) - please choose a smaller photo' };
  var kind = sniffImageType(bytes);
  if (!kind) return { error: 'That file is not a JPEG, PNG, WebP or GIF photo.' };
  return { bytes: bytes, mimeType: kind };
}

/** The product's photos, cover first: [{ id, url, fileId, req }]. */
function productGalleryOf(p) {
  var list = parseJsonSafe(p && p.ImagesJson, null);
  if (Array.isArray(list)) {
    return list.filter(function (i) { return i && i.url && PRODUCT_IMAGE_ID_RE.test(String(i.id || '')); })
      .map(function (i) { return { id: String(i.id), url: String(i.url), fileId: String(i.fileId || ''), req: String(i.req || '') }; });
  }
  var out = [];
  if (p && p.ImageUrl) out.push({ id: 'main', url: String(p.ImageUrl), fileId: String(p.ImageFileId || ''), req: '' });
  if (p && p.ImageUrl2) out.push({ id: 'second', url: String(p.ImageUrl2), fileId: String(p.ImageFileId2 || ''), req: '' });
  return out;
}

/** The public shape: urls only, cover first. */
function productPhotoUrls(p) {
  return productGalleryOf(p).map(function (i) { return i.url; });
}

/** Row fields that store a gallery (ImagesJson + the two legacy columns). */
function productGalleryFields(images) {
  return {
    ImagesJson: JSON.stringify(images),
    ImageUrl: images[0] ? images[0].url : '', ImageFileId: images[0] ? images[0].fileId : '',
    ImageUrl2: images[1] ? images[1].url : '', ImageFileId2: images[1] ? images[1].fileId : '',
    UpdatedAt: nowIso()
  };
}

/**
 * True when some OTHER product or variety still shows this stored file, so
 * removing it here must not delete it. Duplicating a listing never copies
 * photos, so this is a guard, not the normal case.
 */
function storedImageInUse(fileId, exceptProductId) {
  if (!fileId) return false;
  var products = sheetToObjects(getSheet('Products'));
  for (var i = 0; i < products.length; i++) {
    var p = products[i];
    if (p.ProductId === exceptProductId) continue;
    if (p.ImageFileId === fileId || p.ImageFileId2 === fileId) return true;
    if (productGalleryOf(p).some(function (g) { return g.fileId === fileId; })) return true;
  }
  var variants = sheetToObjects(getSheet('Variants'));
  for (var k = 0; k < variants.length; k++) {
    if (variantImagesOf(variants[k]).some(function (g) { return g.fileId === fileId; })) return true;
  }
  return false;
}

function deleteProductPhotoFiles(removed, productId) {
  removed.forEach(function (i) {
    if (i.fileId && !storedImageInUse(i.fileId, productId)) deleteStoredImage(i.fileId);
  });
}

function photoGalleryAnswer(images, extra) {
  var out = { images: images.map(function (i) { return { id: i.id, url: i.url }; }), max: productImagesMax() };
  for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) out[k] = extra[k];
  return ok(out);
}

/**
 * Adds one photo to a product, or replaces one in place (body.replaceId).
 * body.requestId makes a retried upload (no answer came back) a no-op that
 * returns the gallery, instead of a second copy of the photo.
 *
 * Replacing writes the new photo first and deletes the old file only after
 * the row is saved, so a failed upload never loses the photo already there.
 */
function actionUploadProductPhoto(owner, body) {
  var checked = checkedProductPhoto(body);
  if (checked.error) return fail(checked.error);
  var productId = String(body.productId || '');
  var replaceId = String(body.replaceId || '');
  if (replaceId && !PRODUCT_IMAGE_ID_RE.test(replaceId)) return fail('Those photos changed. Please reload and try again.');
  var req = typeof cleanRequestId === 'function' ? cleanRequestId(body.requestId) : '';
  var max = productImagesMax();
  var sheet = getSheet('Products');

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var product = findRowById(sheet, 'ProductId', productId);
    if (!productId || !product || product.OwnerId !== owner.OwnerId) return fail('Product not found');
    var images = productGalleryOf(product);
    var done = req && images.filter(function (i) { return i.req === req; })[0];
    if (done) return photoGalleryAnswer(images, { imageId: done.id, replayed: true });
    if (replaceId && !images.some(function (i) { return i.id === replaceId; })) return fail('That photo was already removed. Please reload and try again.');
    if (!replaceId && images.length >= max) return fail('This product already has ' + max + ' photos. Remove one first.');
  } finally {
    lock.releaseLock();
  }

  // The upload is slow, so it runs outside the lock; the gallery is read and
  // checked again before writing.
  var uploaded = uploadImage(checked.bytes, checked.mimeType, productId + '_' + Date.now(), getImageFolder);
  lock.waitLock(30000);
  var removed = [];
  try {
    var fresh = findRowById(sheet, 'ProductId', productId);
    if (!fresh || fresh.OwnerId !== owner.OwnerId) {
      if (uploaded.imageFileId) deleteStoredImage(uploaded.imageFileId);
      return fail('Product not found');
    }
    images = productGalleryOf(fresh);
    var entry = { id: 'img_' + Utilities.getUuid().replace(/-/g, '').slice(0, 12), url: uploaded.imageUrl, fileId: uploaded.imageFileId || '', req: req };
    var at = replaceId ? images.map(function (i) { return i.id; }).indexOf(replaceId) : -1;
    if (replaceId && at === -1) {
      if (uploaded.imageFileId) deleteStoredImage(uploaded.imageFileId);
      return fail('That photo was already removed. Please reload and try again.');
    }
    if (!replaceId && images.length >= max) {
      if (uploaded.imageFileId) deleteStoredImage(uploaded.imageFileId);
      return fail('This product already has ' + max + ' photos. Remove one first.');
    }
    if (at !== -1) {
      removed = [images[at]];
      images[at] = entry;
    } else {
      images.push(entry);
    }
    ensureColumn(sheet, 'ImagesJson');
    updateRowFromObject(sheet, fresh.__row, productGalleryFields(images));
    invalidateCache([storeProductsCacheKey(owner.StoreSlug)]);
  } finally {
    lock.releaseLock();
  }
  deleteProductPhotoFiles(removed, productId);
  return photoGalleryAnswer(images, { imageId: entry.id });
}

/**
 * Reorders or removes a product's photos. body.order: the photo ids in the
 * new order (the first becomes the cover); ids left out are removed and their
 * stored file deleted, unless something else still shows it. An id that isn't
 * this product's, or a repeated id, refuses the whole change.
 */
function actionSetProductPhotos(owner, body) {
  var order = Array.isArray(body.order) ? body.order.map(String) : null;
  if (!order) return fail('order is required');
  var sheet = getSheet('Products');
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  var removed, next, productId = String(body.productId || '');
  try {
    var product = findRowById(sheet, 'ProductId', productId);
    if (!productId || !product || product.OwnerId !== owner.OwnerId) return fail('Product not found');
    var images = productGalleryOf(product);
    var byId = {};
    images.forEach(function (i) { byId[i.id] = i; });
    var seen = {};
    for (var k = 0; k < order.length; k++) {
      if (!byId[order[k]] || seen[order[k]]) return fail('Those photos changed. Please reload and try again.');
      seen[order[k]] = true;
    }
    next = order.map(function (id) { return byId[id]; });
    removed = images.filter(function (i) { return !seen[i.id]; });
    ensureColumn(sheet, 'ImagesJson');
    updateRowFromObject(sheet, product.__row, productGalleryFields(next));
    invalidateCache([storeProductsCacheKey(owner.StoreSlug)]);
  } finally {
    lock.releaseLock();
  }
  deleteProductPhotoFiles(removed, productId);
  return photoGalleryAnswer(next, {});
}

function actionUploadStoreLogo(owner, body) {
  var mimeType = body.mimeType;
  var imageBase64 = body.imageBase64;

  if (!mimeType || mimeType.indexOf('image/') !== 0) return fail('Only image uploads are allowed');
  if (!imageBase64) return fail('No image data received');

  var bytes;
  try {
    bytes = Utilities.base64Decode(imageBase64);
  } catch (e) {
    return fail('Invalid image data');
  }
  if (bytes.length > MAX_IMAGE_BYTES) return fail('Image is too large (max 5MB) - please choose a smaller photo');

  var ownersSheet = getSheet('Owners');
  var ownerRow = findRowById(ownersSheet, 'OwnerId', owner.OwnerId);
  if (!ownerRow) return fail('Store account not found');

  var uploaded = uploadImage(bytes, mimeType, 'logo_' + owner.OwnerId + '_' + Date.now(), getImageFolder);
  var oldFileId = ownerRow.LogoFileId;

  updateRowFromObject(ownersSheet, ownerRow.__row, {
    LogoUrl: uploaded.imageUrl,
    LogoFileId: uploaded.imageFileId
  });

  if (oldFileId) deleteStoredImage(oldFileId);

  invalidateCache(storeCacheKeys(owner.StoreSlug));
  return ok({ logoUrl: uploaded.imageUrl });
}

/**
 * ID/License documents get their own Drive folder (like chat images do),
 * separate from product/logo photos, so they're easy to find/manage
 * independently.
 *
 * IMPORTANT CAVEAT, documented here and in README.md: this reuses the same
 * uploadImage() pipeline as every other photo in this app, which for the
 * Drive fallback path sets ANYONE_WITH_LINK view access (see Utils.gs's
 * uploadImage) - there is no authenticated-file-serving mechanism anywhere
 * in this app. The resulting URL is never shown in any customer- or
 * vendor-facing UI except the owner's own Settings page (see
 * actionGetOwnerProfile's comment on why it's kept out of
 * publicOwnerFields), but anyone who somehow obtained the exact URL could
 * still view the document. Same trust model this app already accepts for
 * product photos and store logos, just with materially higher stakes for a
 * personal ID document - worth the vendor knowing before they upload one.
 */
function getIdLicenseFolder() {
  var props = PropertiesService.getScriptProperties();
  var folderId = props.getProperty('ID_LICENSE_FOLDER_ID');
  if (folderId) {
    try {
      return DriveApp.getFolderById(folderId);
    } catch (e) {
      // stored id no longer valid, fall through and recreate
    }
  }
  var folder = DriveApp.createFolder('Mwakete ID License Documents');
  props.setProperty('ID_LICENSE_FOLDER_ID', folder.getId());
  return folder;
}

/** Protected, optional. Vendor-only upload of an ID/License photo - never exposed in any public response, see actionGetOwnerProfile. */
function actionUploadOwnerIdLicense(owner, body) {
  var mimeType = body.mimeType;
  var imageBase64 = body.imageBase64;

  if (!mimeType || mimeType.indexOf('image/') !== 0) return fail('Only image uploads are allowed');
  if (!imageBase64) return fail('No image data received');

  var bytes;
  try {
    bytes = Utilities.base64Decode(imageBase64);
  } catch (e) {
    return fail('Invalid image data');
  }
  if (bytes.length > MAX_IMAGE_BYTES) return fail('Image is too large (max 5MB) - please choose a smaller photo');

  var ownersSheet = getSheet('Owners');
  var ownerRow = findRowById(ownersSheet, 'OwnerId', owner.OwnerId);
  if (!ownerRow) return fail('Store account not found');

  var uploaded = uploadImage(bytes, mimeType, 'idlicense_' + owner.OwnerId + '_' + Date.now(), getIdLicenseFolder, 'id-license');
  var oldFileId = ownerRow.IdLicenseFileId;

  updateRowFromObject(ownersSheet, ownerRow.__row, {
    IdLicenseUrl: uploaded.imageUrl,
    IdLicenseFileId: uploaded.imageFileId
  });

  if (oldFileId) deleteStoredImage(oldFileId);

  // No cache invalidation here, unlike the logo upload above - IdLicenseUrl
  // is never part of any cached public response
  // (see storeCacheKeys in Products.gs), so there's nothing
  // stale to clear.
  return ok({ idLicenseUrl: uploaded.imageUrl });
}
