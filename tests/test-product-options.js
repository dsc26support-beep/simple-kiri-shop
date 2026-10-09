/**
 * Product options, variants, variant photos and ordering (Oct 2026), on the
 * REAL backend sources (gas-harness). Covers the owner brief's test list:
 * creation, combinations, validation, per-variant price/stock/photos, the
 * public payload, sold-out handling, server-side order checks, idempotency,
 * cancellation, permissions and migration safety.
 */
const fs = require('fs');
const { makeBox } = require('./lib/gas-harness.js');
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e === undefined ? '' : e]);
const J = (x) => JSON.stringify(x).slice(0, 400);

const OWNER = { OwnerId: 'own_1', StoreSlug: 'bong', StoreName: 'Bong', Email: '', Status: 'active', Island: 'South Tarawa', DeliveryPickPay: 'true', StoreType: 'wholesaler' };
const OTHER = { OwnerId: 'own_2', StoreSlug: 'other', StoreName: 'Other', Email: '', Status: 'active', Island: 'South Tarawa', DeliveryPickPay: 'true', StoreType: 'retailer' };
const box = makeBox({
  Owners: [Object.keys(OWNER), Object.values(OWNER), Object.keys(OWNER).map((k) => OTHER[k])],
  Products: [['ProductId', 'OwnerId', 'StoreSlug', 'Name', 'Description', 'Category', 'ListingType', 'ImageUrl', 'ImageFileId', 'ImageUrl2', 'ImageFileId2', 'Status', 'SortOrder', 'CreatedAt', 'UpdatedAt'],
    ['prod_legacy', 'own_1', 'bong', 'Coconut oil', 'Local oil', 'food', 'product', 'https://img/oil.jpg', '', '', '', 'active', 0, '', '']],
  Variants: [['VariantId', 'ProductId', 'OwnerId', 'Label', 'Price', 'SKU', 'StockQty', 'Status'],
    ['var_l1', 'prod_legacy', 'own_1', '250ml', 3, '', 5, 'active'], ['var_l2', 'prod_legacy', 'own_1', '1L', 9, '', '', 'active']],
  Orders: [['OrderId', 'OwnerId', 'StoreSlug', 'CustomerName', 'CustomerPhone', 'CustomerEmail', 'Island', 'Village', 'DeliveryAddress',
    'DeliveryMethod', 'DeliveryCost', 'Notes', 'PaymentMethod', 'PaymentReference', 'ItemsJson', 'ItemsSummary', 'Subtotal', 'Total', 'Status', 'CreatedAt', 'UpdatedAt']],
  AbandonedCarts: [['CartId', 'StoreSlug', 'Email', 'ConvertedOrderId']]
});
const S = box.__sheets.Owners.objects()[0];
const O = box.__sheets.Owners.objects()[1];
const uploads = [], deleted = [];
box.uploadImage = (bytes, mime, hint) => { uploads.push(hint); return { imageUrl: 'https://img/' + hint + '.jpg', imageFileId: 'f_' + uploads.length }; };
box.deleteStoredImage = (id) => deleted.push(id);
box.getImageFolder = () => null;

const variants = (pid) => box.__sheets.Variants.objects().filter((v) => v.ProductId === pid);
const product = (pid) => box.__sheets.Products.objects().find((p) => p.ProductId === pid);
const save = (who, o) => box.actionCreateOrUpdateProduct(who, Object.assign({ listingType: 'product', status: 'active', description: '' }, o));
const order = (items, extra) => box.actionCreateOrder(Object.assign({ storeSlug: 'bong', items, customerName: 'Tia', customerPhone: '73000000',
  island: 'South Tarawa', village: 'Betio', deliveryMethod: 'pickPay', paymentMethod: 'cash' }, extra || {}));
const pub = () => { box.__cache && Object.keys(box.__cache).forEach((k) => delete box.__cache[k]); return box.actionListProducts({ storeSlug: 'bong' }).products; };

const opt = (id, name, kind, labels) => ({ id: 'o_' + id, name, kind, values: labels.map((l, i) => ({ id: 'v_' + id + i, label: l })) });
const combos = (options, fill) => box.generateOptionCombinations(options).map((values) => Object.assign({ values, active: true, price: 12, stockQty: 5 }, fill ? fill(values) : {}));

/* ---------- creating products ---------- */
let res = save(S, { name: 'Bottled water 600ml', category: 'food', subcategoryId: 'food-bottled-water', productType: 'single', variants: [{ price: 1.5, stockQty: 40 }] });
ok('simple product: one price, one stock, no options', res.ok && variants(res.productId).length === 1 && Number(variants(res.productId)[0].Price) === 1.5
  && Number(variants(res.productId)[0].StockQty) === 40 && product(res.productId).ProductType === 'single' && product(res.productId).OptionsJson === '', J(res));
const waterId = res.productId;

const colour = opt('col', 'Colour', 'colour', ['Red', 'Blue', 'Green']);
colour.values[0].hex = '#C62828';
const size = opt('siz', 'Size', 'size', ['S', 'M', 'L']);
let shirtOpts = [colour, size];
let rows = combos(shirtOpts, (v) => {
  const c = v.o_col, s = v.o_siz;
  return { price: c === 'v_col1' ? 13 : 12, stockQty: c === 'v_col0' && s === 'v_siz1' ? 0 : 5, active: !(c === 'v_col2' && s === 'v_siz2'), sku: 'TS-' + c.slice(-1) + s.slice(-1) };
});
res = save(S, { name: 'Cotton T-shirt', category: 'fashion', subcategoryId: 'fashion-men', productType: 'options', options: shirtOpts, variants: rows });
const shirtId = res.productId;
ok('shirt with Colour + Size: saved', res.ok, J(res));
ok('...9 combinations generated, Green/L switched off is simply not created (8 rows)', variants(shirtId).length === 8, variants(shirtId).length);
ok('...labels are "Red / S" etc.', variants(shirtId).some((v) => v.Label === 'Red / S') && variants(shirtId).some((v) => v.Label === 'Blue / M'));
ok('...each variant keeps its own price, stock and SKU', variants(shirtId).find((v) => v.Label === 'Blue / S').Price == 13
  && variants(shirtId).find((v) => v.Label === 'Red / M').StockQty === 0 && variants(shirtId).find((v) => v.Label === 'Red / M').SKU === 'TS-01');
ok('...hex for a colour value is kept, lower-case', JSON.parse(product(shirtId).OptionsJson)[0].values[0].hex === '#c62828');
ok('...save answers which variant id each combination got', res.variants.length === 8 && res.variants.every((v) => /^var_/.test(v.variantId) && v.key), J(res.variants));

res = save(S, { name: 'Leather sandals', category: 'fashion', subcategoryId: 'fashion-shoes', productType: 'options',
  options: [opt('shz', 'Size', 'size', ['38', '39', '40'])], variants: combos([opt('shz', 'Size', 'size', ['38', '39', '40'])]) });
ok('shoes with Size only (Colour not required)', res.ok && variants(res.productId).length === 3, J(res));
res = save(S, { name: 'Shell necklace', category: 'fashion', subcategoryId: 'fashion-jewellery', productType: 'options',
  options: [opt('dsg', 'Design', 'custom', ['Cowrie', 'Turtle'])], variants: combos([opt('dsg', 'Design', 'custom', ['Cowrie', 'Turtle'])]) });
ok('necklace with a custom Design option', res.ok && variants(res.productId).map((v) => v.Label).join() === 'Cowrie,Turtle', J(res));
const rice = [opt('pkg', 'Package Size', 'custom', ['1 kg', '5 kg', '10 kg'])];
res = save(S, { name: 'Jasmine rice', category: 'food', subcategoryId: 'food-rice-grains', productType: 'options', options: rice,
  variants: combos(rice, (v) => ({ price: { v_pkg0: 3, v_pkg1: 13.5, v_pkg2: 25 }[v.o_pkg] })) });
ok('rice with a custom "Package Size" option - no code change needed', res.ok && variants(res.productId).find((v) => v.Label === '5 kg').Price == 13.5, J(res));
const riceId = res.productId;

/* ---------- validation ---------- */
const bad = (o, re, name) => { const r = save(S, Object.assign({ name: 'Test shirt', category: 'fashion', subcategoryId: 'fashion-men', productType: 'options' }, o)); ok(name, !r.ok && re.test(r.error), J(r)); };
bad({ options: [], variants: [] }, /at least one option/, 'options mode with no options is refused (use Single instead)');
bad({ options: [opt('aa', '', 'custom', ['x'])], variants: [] }, /name/, 'empty option name refused');
bad({ options: [opt('aa', 'Size', 'size', ['S', 's'])], variants: [] }, /twice/, 'duplicate value (case-insensitive) refused');
bad({ options: [opt('aa', 'Size', 'size', ['S']), opt('bb', 'size', 'size', ['M'])], variants: [] }, /two options/, 'duplicate option name refused');
bad({ options: [opt('aa', 'Size', 'size', ['<b>S</b>'])], variants: [] }, /cannot contain/, 'markup in a value refused');
const big = [opt('aa', 'A', 'custom', Array.from({ length: 11 }, (_, i) => 'a' + i)), opt('bb', 'B', 'custom', Array.from({ length: 10 }, (_, i) => 'b' + i))];
bad({ options: big, variants: [] }, /110 combinations - the most is 100/, 'too many combinations refused (limit 100)');
box.__props.PRODUCT_VARIANTS_MAX = '120';
ok('...and the limit is a Script Property', box.validateProductOptions(big, box.productOptionLimits()).ok);
delete box.__props.PRODUCT_VARIANTS_MAX;
const twoRows = combos([size]).slice(0, 1).concat(combos([size]).slice(0, 1));
bad({ options: [size], variants: twoRows }, /listed twice/, 'the same combination twice is refused');
bad({ options: [size], variants: [{ values: { o_siz: 'v_nope' }, price: 5, active: true }] }, /value for every option/, 'a value that does not exist is refused');
bad({ options: shirtOpts, variants: [{ values: { o_col: 'v_col0' }, price: 5, active: true }] }, /value for every option/, 'an incomplete combination is refused');
bad({ options: [size], variants: combos([size], () => ({ price: 0 })) }, /price above 0/, 'price 0 refused');
bad({ options: [size], variants: combos([size], () => ({ price: 'abc' })) }, /price above 0/, 'non-numeric price refused');
bad({ options: [size], variants: combos([size], () => ({ stockQty: -2 })) }, /whole number/, 'negative stock refused');
bad({ options: [size], variants: combos([size], () => ({ stockQty: 2.5 })) }, /whole number/, 'fractional stock refused');
bad({ options: [size], variants: combos([size], () => ({ active: false })) }, /at least one combination/, 'all combinations switched off refused');
bad({ options: [size], variants: combos([size], () => ({ sku: 'SAME' })) }, /used twice/, 'duplicate SKU in one product refused');
res = save(S, { name: 'Car hire', category: 'hire', listingType: 'rental', productType: 'options', options: [size], variants: combos([size]) });
ok('options are for products, not rentals/services', !res.ok && /for products/.test(res.error));
ok('a refused save writes nothing', !box.__sheets.Products.objects().some((p) => p.Name === 'Test shirt'));

/* ---------- editing safely ---------- */
const shirtVariants = () => variants(shirtId);
const idOf = (label) => shirtVariants().find((v) => v.Label === label).VariantId;
const redS = idOf('Red / S');
// The seller renames Red -> Crimson and adds XL; client sends no variant ids at all (regenerated grid).
const colour2 = JSON.parse(JSON.stringify(colour)); colour2.values[0].label = 'Crimson';
const size2 = JSON.parse(JSON.stringify(size)); size2.values.push({ id: 'v_siz3', label: 'XL' });
shirtOpts = [colour2, size2];
const plan = box.planVariantChanges(shirtOpts, shirtVariants().map((v) => ({ variantId: v.VariantId, values: JSON.parse(v.OptionValuesJson), status: v.Status })),
  box.generateOptionCombinations(shirtOpts).map((values) => ({ values, active: true })));
ok('plan shown before a change: 3 new (XL), 8 kept, 1 previously-off combination now created', plan.ok
  && plan.rows.filter((r) => r.action === 'create').length === 4 && plan.rows.filter((r) => r.action === 'update').length === 8, J(plan.rows.map((r) => r.action)));
res = save(S, { productId: shirtId, name: 'Cotton T-shirt', category: 'fashion', subcategoryId: 'fashion-men', productType: 'options', options: shirtOpts,
  variants: combos(shirtOpts, (v) => ({ price: 12, stockQty: 3 })) });
ok('regenerating without ids reuses existing variants (no duplicates)', res.ok && shirtVariants().length === 12 && idOf('Crimson / S') === redS, J(res));
ok('...a renamed value renames its variants, same id', shirtVariants().some((v) => v.Label === 'Crimson / M') && !shirtVariants().some((v) => v.Label === 'Red / M'));
ok('...stock change on an existing variant is recorded in the ledger', box.__sheets.StockMovements.objects().some((m) => m.VariantId === redS && m.MovementType === 'MANUAL_ADJUSTMENT'));

// Remove the value Green: its variants are switched off, never deleted.
const colour3 = JSON.parse(JSON.stringify(colour2)); colour3.values = colour3.values.filter((v) => v.label !== 'Green');
shirtOpts = [colour3, size2];
res = save(S, { productId: shirtId, name: 'Cotton T-shirt', category: 'fashion', subcategoryId: 'fashion-men', productType: 'options', options: shirtOpts,
  variants: combos(shirtOpts, () => ({ price: 12, stockQty: 3 })) });
const greens = shirtVariants().filter((v) => /^Green/.test(v.Label));
ok('removing a value switches its variants off - rows, stock history kept', res.ok && greens.length === 4 && greens.every((v) => v.Status === 'disabled'), J(greens.map((v) => v.Status)));
// Turn Crimson/L off explicitly.
res = save(S, { productId: shirtId, name: 'Cotton T-shirt', category: 'fashion', subcategoryId: 'fashion-men', productType: 'options', options: shirtOpts,
  variants: combos(shirtOpts, (v) => ({ price: 12, stockQty: v.o_col === 'v_col0' ? 0 : 3, active: !(v.o_col === 'v_col0' && v.o_siz === 'v_siz2') })) });
ok('switching one combination off keeps its row as disabled', res.ok && shirtVariants().find((v) => v.Label === 'Crimson / L').Status === 'disabled');
res = save(S, { productId: shirtId, name: 'Cotton T-shirt', category: 'fashion', productType: '', variants: [{ label: 'x', price: 1 }] });
ok('an out-of-date page (no productType) cannot wipe a product with options', !res.ok && /reload/.test(res.error));
res = save(O, { productId: shirtId, name: 'Mine now', category: 'fashion', subcategoryId: 'fashion-men', productType: 'options', options: shirtOpts, variants: combos(shirtOpts) });
ok('another seller cannot edit this product', !res.ok && /not found/i.test(res.error) && product(shirtId).Name === 'Cotton T-shirt');
res = save(S, { productId: shirtId, name: 'Cotton T-shirt', category: 'fashion', subcategoryId: 'fashion-men', productType: 'options', options: shirtOpts,
  variants: [{ variantId: variants('prod_legacy')[0].VariantId, values: combos(shirtOpts)[0].values, price: 5, active: true }] });
ok('a variant id from another product is refused', !res.ok && /not part of this product/.test(res.error));

/* ---------- photos per variant ---------- */
const png = Buffer.alloc(3000, 1).toString('base64');
const up = (who, pid, vid, mime) => box.actionUploadVariantImage(who, { productId: pid, variantId: vid, mimeType: mime || 'image/jpeg', imageBase64: png });
const blueS = idOf('Blue / S');
ok('upload a photo to a variant', up(S, shirtId, redS).ok && up(S, shirtId, redS).ok && up(S, shirtId, blueS).ok);
let reds = JSON.parse(shirtVariants().find((v) => v.VariantId === redS).ImagesJson);
ok('...each variant keeps its own gallery (Crimson has 2, Blue 1)', reds.length === 2 && JSON.parse(shirtVariants().find((v) => v.VariantId === blueS).ImagesJson).length === 1);
ok('invalid file type refused', !up(S, shirtId, redS, 'application/pdf').ok && !up(S, shirtId, redS, 'image/svg+xml').ok);
ok('another seller cannot add photos to it', !up(O, shirtId, redS).ok);
ok('a variant of another product is refused', !up(S, waterId, redS).ok);
ok('malformed image data refused', !box.actionUploadVariantImage(S, { productId: shirtId, variantId: redS, mimeType: 'image/jpeg', imageBase64: '' }).ok);
up(S, shirtId, redS); up(S, shirtId, redS);
ok('gallery limit (4, Script Property VARIANT_IMAGES_MAX)', !up(S, shirtId, redS).ok);
reds = JSON.parse(shirtVariants().find((v) => v.VariantId === redS).ImagesJson);
res = box.actionSetVariantImages(S, { productId: shirtId, variantId: redS, order: [reds[3].id, reds[0].id, reds[1].id] });
const after = JSON.parse(shirtVariants().find((v) => v.VariantId === redS).ImagesJson);
ok('reorder: the first is the primary; the one left out is removed and its file deleted', res.ok && after[0].id === reds[3].id && after.length === 3 && deleted.includes(reds[2].fileId), J(after));
ok('ids from another variant are refused', !box.actionSetVariantImages(S, { productId: shirtId, variantId: blueS, order: [reds[0].id] }).ok);

/* ---------- what shoppers get ---------- */
let list = pub();
const shirt = list.filter((p) => p.productId === shirtId);
ok('one parent listing per product (not one per colour/size)', shirt.length === 1);
ok('...with its options, and only the combinations on sale', shirt[0].productType === 'options' && shirt[0].options.length === 2
  && shirt[0].variants.length === 7 && !shirt[0].variants.some((v) => /Green|Crimson \/ L/.test(v.label)), J(shirt[0].variants.map((v) => v.label)));
ok('...each variant carries its values, photos and SKU - never storage file ids', shirt[0].variants.find((v) => v.variantId === redS).images.length === 3
  && !/"f_\d/.test(JSON.stringify(shirt[0])) && shirt[0].variants.find((v) => v.variantId === redS).values.o_col === 'v_col0', J(shirt[0].variants.find((v) => v.variantId === redS)));
ok('simple product: no options sent', list.find((p) => p.productId === waterId).productType === 'single' && !list.find((p) => p.productId === waterId).options);
ok('older product unchanged in the payload', !list.find((p) => p.productId === 'prod_legacy').productType && list.find((p) => p.productId === 'prod_legacy').variants.length === 2);
const st = box.optionValueStates(shirt[0].options, shirt[0].variants, 'o_col', {});
ok('availability: Crimson is all sold out, Blue available, Green (removed) not offered at all', st.v_col0 === 'soldout' && st.v_col1 === 'available' && !('v_col2' in st), J(st));
const sizesForBlue = box.optionValueStates(shirt[0].options, shirt[0].variants, 'o_siz', { o_col: 'v_col1' });
ok('...one colour sold out does not hide the others; Crimson/L off -> "none" for Crimson', sizesForBlue.v_siz2 === 'available'
  && box.optionValueStates(shirt[0].options, shirt[0].variants, 'o_siz', { o_col: 'v_col0' }).v_siz2 === 'none');

/* ---------- ordering ---------- */
const blueM = idOf('Blue / M');
res = order([{ variantId: blueM, qty: 2, unitPrice: 0.01, price: 0.01 }]);
ok('the price comes from the sheet, never the browser', res.ok && res.items[0].unitPrice === 12 && res.total === 24, J(res));
ok('the order keeps a snapshot: name + options + SKU + price', res.items[0].label === 'Cotton T-shirt - Blue / M' && res.items[0].options.Colour === 'Blue'
  && res.items[0].options.Size === 'M' && res.items[0].unitPrice === 12, J(res.items[0]));
const firstOrder = res.orderId;
res = order([{ variantId: redS, qty: 1 }]);
ok('a sold-out variant cannot be ordered', !res.ok && /out of stock/.test(res.error), J(res));
res = order([{ variantId: idOf('Crimson / L'), qty: 1 }]);
ok('a switched-off combination cannot be ordered, even with stock', !res.ok && /no longer available/.test(res.error));
res = order([{ variantId: greens[0].VariantId, qty: 1 }]);
ok('a removed (disabled) variant cannot be ordered by id', !res.ok);
res = order([{ variantId: blueM, qty: 2.5 }]);
ok('fractional quantity refused', !res.ok && /whole-number/.test(res.error));
res = order([{ variantId: blueM, qty: 99 }]);
ok('more than the stock is refused', !res.ok && /Only 1 left/.test(res.error), J(res));
res = order([{ variantId: 'var_madeup', qty: 1 }]);
ok('a made-up variant id is refused', !res.ok);
// Idempotency.
const before = box.__sheets.Orders.objects().length;
const r1 = order([{ variantId: blueS, qty: 1 }], { requestId: 'chk-retry-0001' });
const r2 = order([{ variantId: blueS, qty: 1 }], { requestId: 'chk-retry-0001' });
ok('the same Place Order twice -> one order, stock reserved once', r1.ok && r2.ok && r2.replayed && r1.orderId === r2.orderId
  && box.__sheets.Orders.objects().length === before + 1 && Number(shirtVariants().find((v) => v.VariantId === blueS).ReservedQty) === 1, J(r2));
// Money to the cent.
res = save(S, { productId: riceId, name: 'Jasmine rice', category: 'food', subcategoryId: 'food-rice-grains', productType: 'options', options: rice,
  variants: combos(rice, (v) => ({ variantId: variants(riceId).find((x) => JSON.parse(x.OptionValuesJson).o_pkg === v.o_pkg).VariantId, price: 0.1, stockQty: '' })) });
res = order([{ variantId: variants(riceId)[0].VariantId, qty: 3 }]);
ok('money is rounded to the cent (0.1 x 3 = 0.30, not 0.30000000000000004)', res.ok && res.total === 0.3 && res.items[0].lineTotal === 0.3, J(res.total));
// Cancel restores stock.
ok('cancelling restores the reserved stock', box.actionUpdateOrderStatus(S, { orderId: firstOrder, status: 'Cancelled' }).ok
  && !Number(shirtVariants().find((v) => v.VariantId === blueM).ReservedQty));
// History survives later edits.
const colour4 = JSON.parse(JSON.stringify(colour3)); colour4.values[1].label = 'Navy';
save(S, { productId: shirtId, name: 'Shirt (renamed)', category: 'fashion', subcategoryId: 'fashion-men', productType: 'options', options: [colour4, size2],
  variants: combos([colour4, size2], () => ({ price: 20, stockQty: 3 })) });
const stored = JSON.parse(box.__sheets.Orders.objects().find((o) => o.OrderId === firstOrder).ItemsJson)[0];
ok('an order keeps its original name, options and price after renames and price changes', stored.label === 'Cotton T-shirt - Blue / M'
  && stored.options.Colour === 'Blue' && stored.unitPrice === 12);
ok('...and its variant id still points at a kept row', shirtVariants().some((v) => v.VariantId === stored.variantId));
res = order([{ variantId: waterIdVariant(), qty: 2 }]);
function waterIdVariant() { return variants(waterId)[0].VariantId; }
ok('a simple product orders under its name alone', res.ok && res.items[0].label === 'Bottled water 600ml', J(res.items[0]));
box.updateRowFromObject(box.__sheets.Products, box.findRowById(box.__sheets.Products, 'ProductId', waterId).__row, { Status: 'hidden' });
res = order([{ variantId: waterIdVariant(), qty: 1 }]);
ok('a hidden product cannot be ordered through an old cart', !res.ok);

/* ---------- migration ---------- */
res = save(S, { productId: 'prod_legacy', name: 'Coconut oil', description: 'Local oil', category: 'food', variants: [{ variantId: 'var_l1', label: '250ml', price: 3, stockQty: 5 }, { variantId: 'var_l2', label: '1L', price: 9 }] });
ok('an older product saves exactly as before (no productType)', res.ok && !product('prod_legacy').ProductType && variants('prod_legacy').every((v) => v.Status === 'active'));
const vol = [opt('vol', 'Size', 'size', ['250ml', '1L'])];
res = save(S, { productId: 'prod_legacy', name: 'Coconut oil', description: 'Local oil', category: 'food', productType: 'options', options: vol, variants: combos(vol, () => ({ price: 4 })) });
ok('converting it to options is explicit; old varieties are switched off, not deleted', res.ok && variants('prod_legacy').filter((v) => v.Status === 'disabled').map((v) => v.VariantId).sort().join() === 'var_l1,var_l2'
  && variants('prod_legacy').filter((v) => v.Status === 'active').length === 2, J(variants('prod_legacy').map((v) => v.Status)));
ok('category checks still run with options (water + tuna is still refused)', /mismatch/.test((save(S, { name: 'Water', description: 'The cheapest tuna in a can.', category: 'food',
  subcategoryId: 'food-bottled-water', productType: 'single', variants: [{ price: 1 }] }).error || '')));
ok('option values are not treated as categories (a "Red" colour is not a mismatch)', save(S, { name: 'Summer dress', category: 'fashion', subcategoryId: 'fashion-women',
  productType: 'options', options: [opt('dc', 'Colour', 'colour', ['Red', 'Water blue'])], variants: combos([opt('dc', 'Colour', 'colour', ['Red', 'Water blue'])]) }).ok);

/* ---------- one rules file, both sides ---------- */
const gs = fs.readFileSync('/home/user/simple-kiri-shop/apps-script/ProductOptions.gs', 'utf8');
const fe = fs.readFileSync('/home/user/simple-kiri-shop/assets/js/product-options.js', 'utf8');
ok('the browser runs the same options rules as the backend (built copy is current)', fe.endsWith(gs));

let fails = 0;
console.log('\n--- product options + variants ---');
for (const [s, n, x] of R) { if (s === 'FAIL') fails++; console.log(`${s}  ${n}${x !== '' ? '  [' + x + ']' : ''}`); }
console.log(`\n${R.length - fails}/${R.length} passed`);
process.exit(fails ? 1 : 0);
