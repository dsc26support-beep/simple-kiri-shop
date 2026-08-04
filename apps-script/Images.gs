/**
 * Product photo upload. Requires a valid owner token - without auth here,
 * the Drive folder would become open anonymous file hosting for anyone who
 * finds the exec URL.
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

  var folder = getImageFolder();
  var blob = Utilities.newBlob(bytes, mimeType, productId + '_' + slot + '_' + Date.now());
  var file = folder.createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

  // drive.google.com/uc?export=view links are unreliable as <img> sources
  // (Google frequently blocks the hotlink and shows a broken image icon) -
  // the googleusercontent.com CDN form embeds reliably instead.
  var url = 'https://lh3.googleusercontent.com/d/' + file.getId();
  var urlField = slot === 2 ? 'ImageUrl2' : 'ImageUrl';
  var fileIdField = slot === 2 ? 'ImageFileId2' : 'ImageFileId';
  var oldFileId = product[fileIdField];

  var update = { UpdatedAt: nowIso() };
  update[urlField] = url;
  update[fileIdField] = file.getId();
  updateRowFromObject(getSheet('Products'), product.__row, update);

  if (oldFileId) {
    try { DriveApp.getFileById(oldFileId).setTrashed(true); } catch (e) { /* already gone, ignore */ }
  }

  invalidateCache(['v1:listProducts:' + owner.StoreSlug]);
  return ok({ imageUrl: url, slot: slot });
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

  var folder = getImageFolder();
  var blob = Utilities.newBlob(bytes, mimeType, 'logo_' + owner.OwnerId + '_' + Date.now());
  var file = folder.createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

  var url = 'https://lh3.googleusercontent.com/d/' + file.getId();
  var oldFileId = ownerRow.LogoFileId;

  updateRowFromObject(ownersSheet, ownerRow.__row, {
    LogoUrl: url,
    LogoFileId: file.getId()
  });

  if (oldFileId) {
    try { DriveApp.getFileById(oldFileId).setTrashed(true); } catch (e) { /* already gone, ignore */ }
  }

  invalidateCache(['v1:listStores', 'v1:listProducts:' + owner.StoreSlug, 'v1:storeInfo:' + owner.StoreSlug, 'v1:topStores']);
  return ok({ logoUrl: url });
}
