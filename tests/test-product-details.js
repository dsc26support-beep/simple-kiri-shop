/**
 * Category details and the likely-duplicate check (ProductDetails.gs, Oct
 * 2026) on the REAL backend sources: what is stored, what is refused, what
 * shoppers see, that an edit without details keeps them, and that the
 * duplicate check looks only at the seller's own listings and tells sizes apart.
 */
const { makeBox } = require('./lib/gas-harness.js');
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e === undefined ? '' : e]);
const J = (x) => JSON.stringify(x).slice(0, 400);

const OWNER = { OwnerId: 'own_1', StoreSlug: 'bong', StoreName: 'Bong', Email: '', Status: 'active', Island: 'Abaiang', DeliveryPickPay: 'true', StoreType: 'retailer' };
const OTHER = { OwnerId: 'own_2', StoreSlug: 'other', StoreName: 'Other', Email: '', Status: 'active', Island: 'Abaiang', DeliveryPickPay: 'true', StoreType: 'retailer' };
const box = makeBox({
  Owners: [Object.keys(OWNER), Object.values(OWNER), Object.keys(OWNER).map((k) => OTHER[k])],
  Products: [['ProductId', 'OwnerId', 'StoreSlug', 'Name', 'Description', 'Category', 'ListingType', 'ImageUrl', 'ImageFileId', 'ImageUrl2', 'ImageFileId2', 'Status', 'SortOrder', 'CreatedAt', 'UpdatedAt'],
    ['prod_rice1', 'own_1', 'bong', 'Jasmine Rice 1kg', '', 'food', 'product', '', '', '', '', 'active', 0, '', ''],
    ['prod_radio', 'own_1', 'bong', 'Solar radio', '', 'electronics', 'product', '', '', '', '', 'archived', 0, '', ''],
    ['prod_theirs', 'own_2', 'other', 'Coconut oil soap', '', 'home', 'product', '', '', '', '', 'active', 0, '', '']],
  Variants: [['VariantId', 'ProductId', 'OwnerId', 'Label', 'Price', 'SKU', 'StockQty', 'Status'],
    ['var_r1', 'prod_rice1', 'own_1', 'Standard', 3, '', 10, 'active']],
  Orders: [['OrderId', 'OwnerId', 'StoreSlug', 'ItemsJson', 'Status', 'CreatedAt']]
});
const S = box.__sheets.Owners.objects()[0];
const product = (pid) => box.__sheets.Products.objects().find((p) => p.ProductId === pid);
const save = (o) => box.actionCreateOrUpdateProduct(S, Object.assign({ listingType: 'product', status: 'active', description: '', productType: 'single' }, o));
const pub = () => { Object.keys(box.__cache).forEach((k) => delete box.__cache[k]); return box.actionListProducts({ storeSlug: 'bong' }).products; };

/* ---------- storing details ---------- */
let res = save({ name: 'Tuna in oil 185g', category: 'food', variants: [{ price: 2.5, stockQty: 12 }],
  details: { netQuantity: '185g', bestBefore: 'Dec 2027', storage: 'Room temperature', brand: 'Sunbell', junk: 'x', availability: 'Ready now' } });
ok('details are saved with the product', res.ok && J(JSON.parse(product(res.productId).AttributesJson)) === J({ netQuantity: '185g', bestBefore: 'Dec 2027', storage: 'Room temperature', brand: 'Sunbell', availability: 'Ready now' }), J(product(res.productId)));
ok('...an unknown key is dropped, never stored', !/junk/.test(product(res.productId).AttributesJson));
const tuna = res.productId;
let shown = pub().find((p) => p.productId === tuna);
ok('shoppers get them as label/value pairs in a fixed order', J(shown.details.map((d) => d.label)) === J(['Weight / size of pack', 'Best before', 'Storage', 'Brand', 'Availability']) && shown.details[0].value === '185g', J(shown.details));
ok('the owner list gets them as key/value for the form', J(box.actionListOwnerProducts(S, {}).products.find((p) => p.productId === tuna).details.storage) === '"Room temperature"');

const vid = () => box.actionListOwnerProducts(S, {}).products.find((p) => p.productId === tuna).variants[0].variantId;
res = save({ productId: tuna, name: 'Tuna in oil 185g', category: 'food', variants: [{ variantId: vid(), price: 2.5, stockQty: 12 }] });
ok('an edit that sends no details keeps the stored ones', res.ok && /Sunbell/.test(product(tuna).AttributesJson), product(tuna).AttributesJson);
res = save({ productId: tuna, name: 'Tuna in oil 185g', category: 'food', variants: [{ variantId: vid(), price: 2.5, stockQty: 12 }], details: { netQuantity: '185g' } });
ok('sending details replaces them (a cleared field is gone)', res.ok && J(JSON.parse(product(tuna).AttributesJson)) === J({ netQuantity: '185g' }));
ok('...stock was not touched by any of these edits', Number(box.__sheets.Variants.objects().find((v) => v.ProductId === tuna).StockQty) === 12);

/* ---------- refused ---------- */
const refused = (details, re, name) => { const r = save({ name: 'Bad details', category: 'food', variants: [{ price: 1, stockQty: 1 }], details }); ok(name, !r.ok && re.test(r.error), J(r)); };
refused({ storage: 'In the sun' }, /Storage: choose one of the options/, 'a list value that was never offered is refused');
refused({ brand: 'x'.repeat(41) }, /Brand: keep it to 40/, 'an over-long value is refused');
refused(['185g'], /expected form/, 'details that are not an object are refused');
ok('...nothing was saved by a refused save', !box.__sheets.Products.objects().some((p) => p.Name === 'Bad details'));
res = save({ name: 'Control chars', category: 'food', variants: [{ price: 1, stockQty: 1 }], details: { brand: 'Sun\u0000bell\n  Co' } });
ok('control characters and runs of spaces are cleaned', res.ok && JSON.parse(product(res.productId).AttributesJson).brand === 'Sun bell Co', product(res.productId).AttributesJson);
res = save({ name: 'Formula brand', category: 'food', variants: [{ price: 1, stockQty: 1 }], details: { brand: '=IMPORTXML("http://x","//a")' } });
ok('a value that looks like a spreadsheet formula is stored inside JSON text, so the cell never starts with "="',
  res.ok && /^\{/.test(box.__sheets.Products.grid.find((r) => r.indexOf('Formula brand') !== -1).find((c) => typeof c === 'string' && /IMPORTXML/.test(c))));

/* ---------- listing checks see the details ---------- */
res = save({ name: 'Bottled water', category: 'food', subcategoryId: 'food-bottled-water', variants: [{ price: 1, stockQty: 5 }], details: { volume: '600ml' } });
ok('a filled-in Volume answers the listing check\'s volume tip', res.ok && !(res.notes || []).some((n) => /volume/i.test(n.message)), J(res.notes));
res = save({ name: 'Bottled water three', category: 'food', subcategoryId: 'food-bottled-water', variants: [{ price: 1, stockQty: 5 }], details: { netQuantity: '1.5L' } });
ok('...so does "Weight / size of pack" holding a volume (what the form offers for food)', res.ok && !(res.notes || []).some((n) => /volume/i.test(n.message)), J(res.notes));
res = save({ name: 'Bottled water two', category: 'food', subcategoryId: 'food-bottled-water', variants: [{ price: 1, stockQty: 5 }] });
ok('...without it, the tip is still given', res.ok && (res.notes || []).some((n) => /volume/i.test(n.message)), J(res.notes));

/* ---------- likely duplicates ---------- */
const sim = (o) => box.actionFindSimilarProducts(S, o).similar;
ok('the same product again is flagged', sim({ name: 'Jasmine rice 1 kg', category: 'food' }).map((x) => x.productId).join() === 'prod_rice1', J(sim({ name: 'Jasmine rice 1 kg', category: 'food' })));
ok('a different size is NOT a duplicate', sim({ name: 'Jasmine Rice 25kg', category: 'food' }).length === 0);
ok('another category is NOT a duplicate', sim({ name: 'Jasmine rice 1kg', category: 'home' }).length === 0);
ok('a listing is not its own duplicate (edit)', sim({ name: 'Jasmine Rice 1kg', category: 'food', productId: 'prod_rice1' }).length === 0);
ok('archived listings are not offered', sim({ name: 'Solar radio', category: 'electronics' }).length === 0);
ok('another seller\'s listings are never looked at', sim({ name: 'Coconut oil soap', category: 'home' }).length === 0);
ok('different model numbers are not duplicates', (() => {
  save({ name: 'Solar lantern', category: 'electronics', variants: [{ price: 20, stockQty: 1 }], details: { brand: 'Sunlite', model: 'SL-100' } });
  return sim({ name: 'Solar lantern', category: 'electronics', details: { brand: 'Sunlite', model: 'SL-200' } }).length === 0
    && sim({ name: 'Solar lantern', category: 'electronics', details: { brand: 'Sunlite', model: 'SL-100' } }).length === 1;
})());
ok('only a few words in common is not enough', sim({ name: 'Jasmine tea bags', category: 'food' }).length === 0);
ok('an empty or symbol-only name returns nothing', sim({ name: '!!!', category: 'food' }).length === 0);
const routed = require('fs').readFileSync(__dirname + '/../apps-script/Code.gs', 'utf8');
ok('findSimilarProducts is seller-only (protected and routed)', /PROTECTED_POST_ACTIONS = \[[\s\S]*'findSimilarProducts'/.test(routed) && /case 'findSimilarProducts': return jsonOut\(actionFindSimilarProducts\(owner, body\)\)/.test(routed));

let f = 0; console.log('\n--- product details + duplicates (real backend) ---');
for (const [s, n, e] of R) { if (s === 'FAIL') f++; console.log(`${s}  ${n}${e && s === 'FAIL' ? '  [' + e + ']' : ''}`); }
console.log(`\n${R.length - f}/${R.length} passed`);
process.exit(f ? 1 : 0);
