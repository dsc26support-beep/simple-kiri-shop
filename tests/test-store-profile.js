/**
 * Store page profile header (owner request, Nov 2026): the seller's cover
 * photo (Images.gs actionUploadStoreCover), "About your store" (Products.gs
 * actionUpdateOwnerProfile storeBio) and what the store page reads back
 * (actionListProducts). Real .gs sources (gas-harness), through doPost.
 */
const { makeBox } = require('./lib/gas-harness.js');
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e === undefined ? '' : JSON.stringify(e).slice(0, 400)]);
const FUT = new Date(Date.now() + 86400000).toISOString();

const box = makeBox({
  Owners: [['OwnerId', 'StoreSlug', 'StoreName', 'Email', 'Status', 'Island', 'DeliveryPickPay', 'StoreType', 'LogoUrl', 'BrandColor'],
    ['own_1', 'bong', 'Bong', 'b@x.test', 'active', 'South Tarawa', 'true', 'retailer', 'https://img/logo.png', '#0b3d91'],
    ['own_2', 'other', 'Other', 'o@x.test', 'active', 'South Tarawa', 'true', 'retailer', '', 'red; x']],
  Sessions: [['Token', 'OwnerId', 'CreatedAt', 'ExpiresAt'], ['tok-1', 'own_1', '', FUT], ['tok-2', 'own_2', '', FUT]],
  Products: [['ProductId', 'OwnerId', 'StoreSlug', 'Name', 'Description', 'Category', 'ListingType', 'Status', 'SortOrder', 'CreatedAt', 'UpdatedAt'],
    ['p1', 'own_1', 'bong', 'Rice', '', 'food', 'product', 'active', 0, '', ''], ['p2', 'own_2', 'other', 'Fish', '', 'food', 'product', 'active', 0, '', '']],
  Variants: [['VariantId', 'ProductId', 'OwnerId', 'Label', 'Price', 'SKU', 'StockQty', 'Status'],
    ['v1', 'p1', 'own_1', '10kg', 20, '', 5, 'active'], ['v2', 'p2', 'own_2', '1kg', 5, '', 5, 'active']],
  Orders: [['OrderId', 'OwnerId', 'StoreSlug', 'ItemsJson', 'Status', 'CreatedAt']]
});
box.ContentService = { createTextOutput: (s) => ({ s, setMimeType() { return this; } }), MimeType: { JSON: 'json' } };
const uploads = [], deleted = [];
box.uploadImage = (bytes, mime, hint) => { uploads.push({ hint, mime }); return { imageUrl: 'https://img/cover' + uploads.length + '.jpg', imageFileId: 'fc_' + uploads.length }; };
box.deleteStoredImage = (id) => deleted.push(id);
box.getImageFolder = () => null;
const clear = () => Object.keys(box.__cache || {}).forEach((k) => delete box.__cache[k]);
const post = (b) => { try { return JSON.parse(box.doPost({ postData: { contents: JSON.stringify(b) } }).s); } catch (e) { return { ok: false, error: String(e.stack || e) }; } };
const store = (slug) => JSON.parse(box.doGet({ parameter: { action: 'listProducts', storeSlug: slug } }).s);
const owner = (id) => box.__sheets.Owners.objects().find((o) => o.OwnerId === id);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1].concat(new Array(40).fill(1))).toString('base64');
const HTML = Buffer.from('<html><script>alert(1)</script></html>').toString('base64');

let s = store('bong');
ok('before any change: the store page gets an empty cover and bio, and the store colour', s.ok && s.storeCoverUrl === '' && s.storeBio === '' && s.storeColor === '#0b3d91', s);
ok('a colour that is not #rrggbb is never sent (it goes into a style)', store('other').storeColor === '');

/* ---------- cover photo ---------- */
let r = post({ action: 'uploadStoreCover', token: 'tok-1', imageBase64: HTML, mimeType: 'image/jpeg' });
ok('a file that is not really a photo is refused, whatever type the browser claims', !r.ok && /not a JPEG/.test(r.error) && uploads.length === 0, r);
r = post({ action: 'uploadStoreCover', imageBase64: JPEG, mimeType: 'image/jpeg' });
ok('no sign-in, no upload', !r.ok && uploads.length === 0, r);
r = post({ action: 'uploadStoreCover', token: 'tok-1', imageBase64: JPEG, mimeType: 'image/jpeg' });
ok('a seller uploads a cover photo; the columns are added at the end of Owners', r.ok && r.coverUrl === 'https://img/cover1.jpg' && owner('own_1').CoverUrl === r.coverUrl && box.__sheets.Owners.grid[0].slice(-2).join() === 'CoverUrl,CoverFileId', r);
ok('...the store page shows it at once (the upload clears the cached page)', store('bong').storeCoverUrl === 'https://img/cover1.jpg');
r = post({ action: 'uploadStoreCover', token: 'tok-1', imageBase64: JPEG, mimeType: 'image/jpeg' });
ok('a new cover replaces the old one and the old file is deleted', r.ok && owner('own_1').CoverUrl === 'https://img/cover2.jpg' && deleted.includes('fc_1'), deleted);
ok('...only for that store', owner('own_2').CoverUrl === '' || owner('own_2').CoverUrl === undefined);
r = post({ action: 'uploadStoreCover', token: 'tok-1', remove: true });
ok('the seller can remove it; the page falls back to the store colour', r.ok && owner('own_1').CoverUrl === '' && deleted.includes('fc_2') && store('bong').storeCoverUrl === '', r);

/* ---------- about your store ---------- */
r = post({ action: 'updateOwnerProfile', token: 'tok-1', storeBio: 'Fresh rice and tinned fish.\r\nOpen every day in Bairiki.' });
s = store('bong');
ok('the seller writes a bio; line breaks are kept, the store page gets it', r.ok && s.storeBio === 'Fresh rice and tinned fish.\nOpen every day in Bairiki.', s.storeBio);
ok('...and Settings reads it back', r.owner && r.owner.storeBio === s.storeBio);
r = post({ action: 'updateOwnerProfile', token: 'tok-1', storeBio: 'x'.repeat(301) });
ok('more than 300 characters is refused', !r.ok && /About your store/.test(r.error), r);
r = post({ action: 'updateOwnerProfile', token: 'tok-1', storeBio: '=HYPERLINK("http://evil")' });
clear();
ok('a bio that looks like a formula is stored as text, and read back exactly as typed', r.ok && String(box.__sheets.Owners.grid[1][box.__sheets.Owners.grid[0].indexOf('StoreBio')]).startsWith("'=") && store('bong').storeBio === '=HYPERLINK("http://evil")');
r = post({ action: 'updateOwnerProfile', token: 'tok-1', storeName: 'Bong' });
clear();
ok('saving other settings leaves the bio alone', r.ok && store('bong').storeBio === '=HYPERLINK("http://evil")');
r = post({ action: 'updateOwnerProfile', token: 'tok-1', storeBio: '' });
clear();
ok('the bio can be cleared', r.ok && store('bong').storeBio === '');

R.forEach((x) => console.log(x[0] + '  ' + x[1] + (x[0] === 'FAIL' && x[2] ? '  [' + x[2] + ']' : '')));
const f = R.filter((x) => x[0] === 'FAIL').length;
console.log(`\n${R.length - f}/${R.length} passed`);
process.exit(f ? 1 : 0);
