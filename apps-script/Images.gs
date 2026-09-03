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

function actionUploadProductImage(owner, body) {
  var productId = body.productId;
  var mimeType = body.mimeType;
  var imageBase64 = body.imageBase64;
  var slot = Number(body.slot) === 2 ? 2 : 1; // up to 2 photos per product

  if (!productId) return fail('productId is required');
  if (!mimeType || mimeType.indexOf('image/') !== 0) return fail('Only image uploads are allowed');
  if (!imageBase64) return fail('No image data received');

  var product = findRowById(getSheet('Products'), 'ProductId', productId);
  if (!product || product.OwnerId !== owner.OwnerId) return fail('Product not found');

  var bytes;
  try {
    bytes = Utilities.base64Decode(imageBase64);
  } catch (e) {
    return fail('Invalid image data');
  }
  if (bytes.length > MAX_IMAGE_BYTES) return fail('Image is too large (max 5MB) - please choose a smaller photo');

  var uploaded = uploadImage(bytes, mimeType, productId + '_' + slot + '_' + Date.now(), getImageFolder);
  var urlField = slot === 2 ? 'ImageUrl2' : 'ImageUrl';
  var fileIdField = slot === 2 ? 'ImageFileId2' : 'ImageFileId';
  var oldFileId = product[fileIdField];

  var update = { UpdatedAt: nowIso() };
  update[urlField] = uploaded.imageUrl;
  update[fileIdField] = uploaded.imageFileId;
  updateRowFromObject(getSheet('Products'), product.__row, update);

  if (oldFileId) deleteStoredImage(oldFileId);

  invalidateCache(['v1:listProducts:' + owner.StoreSlug]);
  return ok({ imageUrl: uploaded.imageUrl, slot: slot });
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

  invalidateCache(['v1:listStores', 'v1:listProducts:' + owner.StoreSlug, 'v2:storeInfo:' + owner.StoreSlug, 'v1:topStores']);
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
  // (v1:listStores/listProducts/storeInfo/topStores), so there's nothing
  // stale to clear.
  return ok({ idLicenseUrl: uploaded.imageUrl });
}
