/**
 * Product photo gallery (Images.gs, Oct 2026) on the REAL backend sources.
 * Covers: adding up to the limit, cover/reorder, replacing in place (the old
 * "second photo can't be replaced" limit), removing, retry safety, checking
 * the bytes rather than the browser's word, ownership, older products, the
 * older slot upload, the public payload, and the fix that stops a browser
 * naming a stored file id through createProduct/updateProduct.
 */
const { makeBox } = require('./lib/gas-harness.js');
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e === undefined ? '' : e]);
const J = (x) => JSON.stringify(x).slice(0, 400);

const OWNER = { OwnerId: 'own_1', StoreSlug: 'bong', StoreName: 'Bong', Email: '', Status: 'active', Island: 'South Tarawa', DeliveryPickPay: 'true', StoreType: 'retailer' };
const OTHER = { OwnerId: 'own_2', StoreSlug: 'other', StoreName: 'Other', Email: '', Status: 'active', Island: 'South Tarawa', DeliveryPickPay: 'true', StoreType: 'retailer' };
const box = makeBox({
  Owners: [Object.keys(OWNER), Object.values(OWNER), Object.keys(OWNER).map((k) => OTHER[k])],
  Products: [['ProductId', 'OwnerId', 'StoreSlug', 'Name', 'Description', 'Category', 'ListingType', 'ImageUrl', 'ImageFileId', 'ImageUrl2', 'ImageFileId2', 'Status', 'SortOrder', 'CreatedAt', 'UpdatedAt'],
    ['prod_old', 'own_1', 'bong', 'Pandanus mat', 'Woven', 'home', 'product', 'https://img/mat1.jpg', 'f_old1', 'https://img/mat2.jpg', 'f_old2', 'active', 0, '', ''],
    ['prod_theirs', 'own_2', 'other', 'Their mat', '', 'home', 'product', 'https://img/theirs.jpg', 'f_theirs', '', '', 'active', 0, '', '']],
  Variants: [['VariantId', 'ProductId', 'OwnerId', 'Label', 'Price', 'SKU', 'StockQty', 'Status'],
    ['var_old', 'prod_old', 'own_1', 'Standard', 20, '', 3, 'active'], ['var_theirs', 'prod_theirs', 'own_2', 'Standard', 10, '', '', 'active']],
  Orders: [['OrderId', 'OwnerId', 'StoreSlug', 'ItemsJson', 'Status', 'CreatedAt']]
});
const S = box.__sheets.Owners.objects()[0];
const O = box.__sheets.Owners.objects()[1];
const uploads = [], deleted = [];
box.uploadImage = (bytes, mime, hint) => { uploads.push({ hint, mime }); return { imageUrl: 'https://img/' + uploads.length + '.jpg', imageFileId: 'f_' + uploads.length }; };
box.deleteStoredImage = (id) => deleted.push(id);
box.getImageFolder = () => null;

const product = (pid) => box.__sheets.Products.objects().find((p) => p.ProductId === pid);
// Real first bytes of each format, padded.
const pad = (arr) => Buffer.from(arr.concat(new Array(40).fill(1))).toString('base64');
const JPEG = pad([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
const PNG = pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);
const WEBP = pad([0x52, 0x49, 0x46, 0x46, 0x10, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
const HTML = Buffer.from('<html><script>alert(1)</script></html>').toString('base64');
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>').toString('base64');
const up = (who, o) => box.actionUploadProductPhoto(who, Object.assign({ imageBase64: JPEG, mimeType: 'image/jpeg' }, o));
const pub = (slug) => { Object.keys(box.__cache).forEach((k) => delete box.__cache[k]); return box.actionListProducts({ storeSlug: slug || 'bong' }).products; };

/* ---------- an older product keeps its photos ---------- */
let mine = box.actionListOwnerProducts(S, {});
let old = mine.products.find((p) => p.productId === 'prod_old');
ok('older product (no ImagesJson): its two photos are the gallery, cover first', J(old.images) === J([{ id: 'main', url: 'https://img/mat1.jpg' }, { id: 'second', url: 'https://img/mat2.jpg' }]), J(old.images));
ok('...the owner list says how many photos fit (default 6)', mine.photoMax === 6, mine.photoMax);
ok('...shoppers get every photo too, and imageUrl/imageUrl2 are unchanged', (() => { const p = pub().find((x) => x.productId === 'prod_old');
  return J(p.images) === J(['https://img/mat1.jpg', 'https://img/mat2.jpg']) && p.imageUrl === 'https://img/mat1.jpg' && p.imageUrl2 === 'https://img/mat2.jpg'; })());

/* ---------- replacing the SECOND photo (the reported limitation) ---------- */
let res = up(S, { productId: 'prod_old', replaceId: 'second', requestId: 'req-replace-0001' });
ok('the second photo can now be replaced', res.ok && res.images.length === 2 && res.images[1].url === 'https://img/1.jpg', J(res));
ok('...in place: the cover is untouched', res.images[0].url === 'https://img/mat1.jpg');
ok('...ImageUrl2 (what older pages read) now shows the new photo', product('prod_old').ImageUrl2 === 'https://img/1.jpg' && product('prod_old').ImageFileId2 === 'f_1');
ok('...and the replaced file is deleted only after the new one is saved', deleted.join() === 'f_old2', deleted.join());
const retry = up(S, { productId: 'prod_old', replaceId: 'second', requestId: 'req-replace-0001' });
ok('a retried upload (same requestId) does nothing twice', retry.ok && retry.replayed && uploads.length === 1 && deleted.length === 1, J(retry));

/* ---------- adding, up to the limit ---------- */
for (let i = 0; i < 4; i++) res = up(S, { productId: 'prod_old', requestId: 'req-add-000' + i });
ok('photos are added to the end, up to 6', res.ok && res.images.length === 6, J(res));
res = up(S, { productId: 'prod_old' });
ok('...a 7th is refused, nothing uploaded', !res.ok && /already has 6 photos/.test(res.error) && uploads.length === 5, J(res));
box.__props.PRODUCT_IMAGES_MAX = '8';
res = up(S, { productId: 'prod_old' });
ok('PRODUCT_IMAGES_MAX raises the limit', res.ok && res.images.length === 7 && res.max === 8, J(res));
delete box.__props.PRODUCT_IMAGES_MAX;

/* ---------- cover, reorder, remove ---------- */
let ids = res.images.map((i) => i.id);
res = box.actionSetProductPhotos(S, { productId: 'prod_old', order: [ids[3], ids[0], ids[1], ids[2], ids[4], ids[5], ids[6]] });
ok('reorder: the chosen photo becomes the cover', res.ok && res.images[0].id === ids[3] && product('prod_old').ImageUrl === res.images[0].url, J(res));
ok('...ImageUrl2 follows the new second photo', product('prod_old').ImageUrl2 === res.images[1].url);
const before = deleted.length;
res = box.actionSetProductPhotos(S, { productId: 'prod_old', order: [ids[3], ids[0]] });
ok('removing: photos left out are gone, their files deleted', res.ok && res.images.length === 2 && deleted.length === before + 5, J([res, deleted]));
ok('...a repeated id is refused', !box.actionSetProductPhotos(S, { productId: 'prod_old', order: [ids[3], ids[3]] }).ok);
ok('...an id that is not this product\'s is refused, nothing changes', !box.actionSetProductPhotos(S, { productId: 'prod_old', order: [ids[3], 'img_nothere'] }).ok
  && JSON.parse(product('prod_old').ImagesJson).length === 2);
res = up(S, { productId: 'prod_old', replaceId: 'img_gone' });
ok('replacing a photo that was already removed is refused (no upload)', !res.ok && /already removed/.test(res.error), J(res));

/* ---------- a shared file is not deleted ---------- */
const keepFile = JSON.parse(product('prod_old').ImagesJson)[1].fileId;
box.__sheets.Variants.grid[0].push('ImagesJson');
box.__sheets.Variants.grid[2][box.__sheets.Variants.grid[0].length - 1] = JSON.stringify([{ id: 'img_x', url: 'https://img/x.jpg', fileId: keepFile }]);
const d0 = deleted.length;
res = box.actionSetProductPhotos(S, { productId: 'prod_old', order: [ids[3]] });
ok('a file another listing still shows is NOT deleted when removed here', res.ok && deleted.length === d0, J(deleted.slice(d0)));

/* ---------- what is accepted ---------- */
ok('PNG is accepted, stored as PNG', (() => { const r = up(S, { productId: 'prod_old', imageBase64: PNG, mimeType: 'image/png' }); return r.ok && uploads[uploads.length - 1].mime === 'image/png'; })());
ok('WebP is accepted', up(S, { productId: 'prod_old', imageBase64: WEBP, mimeType: 'image/webp' }).ok);
ok('the type comes from the bytes: a JPEG labelled image/gif is stored as JPEG', (() => { const r = up(S, { productId: 'prod_old', mimeType: 'image/gif' }); return r.ok && uploads[uploads.length - 1].mime === 'image/jpeg'; })());
res = up(S, { productId: 'prod_old', imageBase64: HTML, mimeType: 'image/jpeg' });
ok('an HTML page labelled image/jpeg is refused', !res.ok && /not a JPEG, PNG, WebP or GIF/.test(res.error), J(res));
ok('an SVG (can carry script) is refused', !up(S, { productId: 'prod_old', imageBase64: SVG, mimeType: 'image/svg+xml' }).ok);
ok('a file over 5MB is refused before decoding', /too large/.test(up(S, { productId: 'prod_old', imageBase64: 'A'.repeat(7 * 1024 * 1024) }).error || ''));
ok('empty data is refused', !up(S, { productId: 'prod_old', imageBase64: '' }).ok);

/* ---------- ownership ---------- */
const n0 = uploads.length;
res = up(S, { productId: 'prod_theirs' });
ok('a seller cannot add a photo to another seller\'s product', !res.ok && res.error === 'Product not found' && uploads.length === n0, J(res));
res = up(S, { productId: 'prod_theirs', replaceId: 'main' });
ok('...or replace theirs (which would delete their file)', !res.ok && deleted.indexOf('f_theirs') === -1, J(res));
ok('...or reorder/remove theirs', !box.actionSetProductPhotos(S, { productId: 'prod_theirs', order: [] }).ok && product('prod_theirs').ImageUrl === 'https://img/theirs.jpg');
ok('an unknown product is refused', !up(S, { productId: 'prod_nope' }).ok);

/* ---------- D1: no stored file ids from the browser ---------- */
let saved = box.actionCreateOrUpdateProduct(S, { name: 'Coconut broom', listingType: 'product', category: 'home', status: 'active', description: '',
  productType: 'single', variants: [{ price: 5, stockQty: 2 }], imageUrl: 'https://evil/x.jpg', imageFileId: 'f_theirs', imageFileId2: 'f_theirs' });
ok('createProduct ignores photo fields sent by the browser', saved.ok && product(saved.productId).ImageUrl === '' && product(saved.productId).ImageFileId === '' && product(saved.productId).ImageFileId2 === '', J(product(saved.productId)));
const broom = saved.productId;
saved = box.actionCreateOrUpdateProduct(S, { productId: 'prod_old', name: 'Pandanus mat', listingType: 'product', category: 'home', status: 'active', description: 'Woven',
  variants: [{ variantId: 'var_old', label: 'Standard', price: 20, stockQty: 3 }], imageUrl: 'https://evil/x.jpg', imageFileId: 'f_theirs' });
ok('updateProduct ignores them too: the photos stay as they were', saved.ok && product('prod_old').ImageFileId !== 'f_theirs' && product('prod_old').ImageUrl !== 'https://evil/x.jpg', J(product('prod_old')));
res = up(S, { productId: 'prod_old', replaceId: JSON.parse(product('prod_old').ImagesJson)[0].id });
ok('...so a later replacement can never delete somebody else\'s file', res.ok && deleted.indexOf('f_theirs') === -1, J(deleted));

/* ---------- a new product gets photos after it is created ---------- */
res = up(S, { productId: broom, requestId: 'req-broom-0001' });
ok('a new product: first photo becomes the cover and ImageUrl', res.ok && product(broom).ImageUrl === res.images[0].url && product(broom).ImageUrl2 === '', J(res));

/* ---------- the older slot upload still works ---------- */
res = box.actionUploadProductImage(S, { productId: broom, imageBase64: JPEG, mimeType: 'image/jpeg', slot: 2 });
ok('uploadProductImage slot 2 adds a second photo (was impossible before)', res.ok && res.slot === 2 && product(broom).ImageUrl2 === res.imageUrl, J(res));
const firstFile = product(broom).ImageFileId;
res = box.actionUploadProductImage(S, { productId: broom, imageBase64: JPEG, mimeType: 'image/jpeg', slot: 1 });
ok('uploadProductImage slot 1 replaces the cover and deletes the old file', res.ok && product(broom).ImageUrl === res.imageUrl && deleted.indexOf(firstFile) !== -1, J(res));
ok('...it checks the bytes too', !box.actionUploadProductImage(S, { productId: broom, imageBase64: HTML, mimeType: 'image/jpeg', slot: 1 }).ok);

/* ---------- the older "remove second photo" still works ---------- */
const second = product(broom).ImageFileId2;
saved = box.actionCreateOrUpdateProduct(S, { productId: broom, name: 'Coconut broom', listingType: 'product', category: 'home', status: 'active', description: '',
  productType: 'single', variants: box.actionListOwnerProducts(S, { limit: 50 }).products.find((p) => p.productId === broom).variants.map((v) => ({ variantId: v.variantId, price: 5, stockQty: 2 })), imageUrl2: '' });
ok('imageUrl2: "" from an older form removes the second photo through the gallery', saved.ok && product(broom).ImageUrl2 === '' && JSON.parse(product(broom).ImagesJson).length === 1 && deleted.indexOf(second) !== -1, J([saved, product(broom)]));

/* ---------- shoppers ---------- */
const shown = pub().find((p) => p.productId === broom);
ok('shoppers see the gallery in images[], no file ids anywhere', J(shown.images) === J([product(broom).ImageUrl]) && !/f_\d/.test(JSON.stringify(shown)), J(shown));
const routed = require('fs').readFileSync(__dirname + '/../apps-script/Code.gs', 'utf8');
ok('both new actions are seller-only (in PROTECTED_POST_ACTIONS and routed)', /PROTECTED_POST_ACTIONS = \[[\s\S]*'uploadProductPhoto', 'setProductPhotos'/.test(routed)
  && /case 'uploadProductPhoto': return jsonOut\(actionUploadProductPhoto\(owner, body\)\)/.test(routed) && /case 'setProductPhotos'/.test(routed));

let f = 0; console.log('\n--- product photo gallery (real backend) ---');
for (const [s, n, e] of R) { if (s === 'FAIL') f++; console.log(`${s}  ${n}${e && s === 'FAIL' ? '  [' + e + ']' : ''}`); }
console.log(`\n${R.length - f}/${R.length} passed`);
process.exit(f ? 1 : 0);
