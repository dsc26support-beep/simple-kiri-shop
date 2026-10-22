/**
 * Bulk product import (InventorySync.gs, Oct 2026 additions) on the REAL
 * backend: a Category column per row (names or ids, subcategories too), a
 * Description column, the Food rule per row, names already listed skipped as
 * duplicates (so importing the same file twice never doubles up), preview =
 * apply, the listing checks still holding a mismatched row, the stock ledger,
 * and seller isolation.
 */
const { makeBox } = require('./lib/gas-harness.js');
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e === undefined ? '' : e]);
const J = (x) => JSON.stringify(x).slice(0, 500);

const box = makeBox({
  Owners: [['OwnerId', 'StoreSlug', 'StoreName', 'Status', 'StoreType', 'Island'],
    ['own_a', 'a', 'A', 'active', '', 'South Tarawa'], ['own_w', 'w', 'W', 'active', 'wholesaler', 'South Tarawa']],
  Products: [['ProductId', 'OwnerId', 'StoreSlug', 'Name', 'Description', 'Status', 'Category', 'ListingType'],
    ['prod_mat', 'own_a', 'a', 'Pandanus mat', '', 'active', 'home', 'product'],
    ['prod_old', 'own_a', 'a', 'Old broom', '', 'archived', 'home', 'product'],
    ['prod_w', 'own_w', 'w', 'Kerosene lamp', '', 'active', 'home', 'product']],
  Variants: [['VariantId', 'ProductId', 'OwnerId', 'Label', 'Price', 'SKU', 'StockQty', 'Status', 'ReservedQty', 'Barcode', 'ExternalId'],
    ['v_mat', 'prod_mat', 'own_a', 'Large', 40, 'MAT-L', 3, 'active', '', '', '']]
});
const A = { OwnerId: 'own_a', StoreSlug: 'a', StoreType: '', Island: 'South Tarawa' };
const W = { OwnerId: 'own_w', StoreSlug: 'w', StoreType: 'wholesaler', Island: 'South Tarawa' };
// The product template's columns (owner-inventory-sync.js PRODUCT_TEMPLATE).
const headers = ['Product name', 'Variety / size', 'Selling price', 'Stock on hand', 'SKU', 'Category', 'Description'];
const mapping = { 'Product name': 'productName', 'Variety / size': 'variantLabel', 'Selling price': 'price', 'Stock on hand': 'physicalStock', 'SKU': 'sku', 'Category': 'category', 'Description': 'description' };
const req = (rows, extra) => Object.assign({ type: 'csv', headers, rows, mapping, createNew: true }, extra || {});
const products = () => box.__sheets.Products.objects();
const variantsOf = (pid) => box.__sheets.Variants.objects().filter((v) => v.ProductId === pid);
const ledger = () => (box.__sheets.StockMovements ? box.__sheets.StockMovements.objects() : []);

const rows = [
  ['Woven fan', '', 8, 20, 'FAN-1', 'Handicrafts', 'Hand woven from pandanus'],
  ['Coconut soap', 'Small', 2, 50, 'SOAP-S', 'home', ''],
  ['Coconut soap', 'Large', 3.5, 30, 'SOAP-L', 'home', 'Made in Abaiang'],
  ['Shell earrings', 'Pair', 12, 6, 'EAR-1', 'Jewellery & Accessories', ''],
  ['Canned tuna 185g', '', 2.5, 100, 'TUNA', 'Canned Fish & Tuna', ''],
  ['Mystery item', '', 5, 1, 'MYS', 'Spaceships', ''],
  ['Pandanus Mat', 'Small', 25, 2, 'MAT-S', 'home', ''],
  ['Old broom', '', 4, 1, 'BRM', 'home', ''],
  ['No category', '', 3, 1, 'NOC', '', '']
];

/* ---------- needs a category from somewhere ---------- */
let res = box.actionPreviewInventoryImport(A, req(rows, { mapping: Object.assign({}, mapping, { Category: undefined }) }));
ok('no Category column and none chosen for the file: refused with a clear message', !res.ok && /Choose a category for the new products, or match a Category column/.test(res.error), J(res));

/* ---------- preview ---------- */
res = box.actionPreviewInventoryImport(A, req(rows));
ok('preview works with a Category column and no file-wide category', res.ok, J(res));
const p = res.preview;
const names = p.newProducts.map((n) => n.name + '>' + n.category + (n.subcategoryId ? '/' + n.subcategoryId : '') + ':' + n.varieties);
ok('rows go in their own categories; same name = one product with varieties', J(names) === J(['Woven fan>handicrafts:1', 'Coconut soap>home:2', 'Shell earrings>fashion/fashion-jewellery:1', 'Old broom>home:1']), J(names));
ok('a subcategory name files it in the parent with that subcategory (Jewellery -> Fashion)', p.newProducts[2].subcategoryId === 'fashion-jewellery');
ok('an unknown category is an error for that line only', p.errors.some((e) => e.line === 7 && /Category "Spaceships" is not one Mwakete has/.test(e.message)), J(p.errors));
ok('Food for a South Tarawa retailer is refused on that line (the Food rule, per row)', p.errors.some((e) => e.line === 6 && /South Tarawa/.test(e.message)), J(p.errors));
ok('a name already listed is skipped as a duplicate, not added twice (any case)', p.duplicates.some((d) => d.line === 8 && /already on Mwakete as "Pandanus mat"/.test(d.reason)) && p.counts.duplicates === 1, J(p.duplicates));
ok('...an ARCHIVED listing with the same name does not block a new one', p.newProducts.some((n) => n.name === 'Old broom') && !p.duplicates.some((d) => d.name === 'Old broom'));
ok('a row with no category and none for the file is set aside with the reason', p.unmatched.some((u) => u.line === 10 && /needs a category/.test(u.reason)), J(p.unmatched));
ok('preview writes nothing', products().length === 3 && !ledger().length);
ok('the counts add up: 4 new products, 1 duplicate, 2 errors, 1 set aside', p.counts.newProducts === 4 && p.counts.duplicates === 1 && p.counts.errors === 2 && p.counts.unmatched === 1, J(p.counts));

/* ---------- apply ---------- */
res = box.actionApplyInventoryImport(A, req(rows, { planToken: p.planToken }));
ok('apply does exactly what was previewed', res.ok && res.created === p.newProducts.length, J(res));
const soap = products().find((x) => x.Name === 'Coconut soap');
ok('the product gets the description from its rows', soap && soap.Description === 'Made in Abaiang', J(soap));
const ear = products().find((x) => x.Name === 'Shell earrings');
ok('...and the category and subcategory', ear && ear.Category === 'fashion' && ear.SubcategoryId === 'fashion-jewellery', J(ear));
ok('varieties, prices and SKUs as in the file', J(variantsOf(soap.ProductId).map((v) => [v.Label, v.Price, v.SKU, v.StockQty])) === J([['Small', 2, 'SOAP-S', 50], ['Large', 3.5, 'SOAP-L', 30]]));
ok('stock is recorded in the ledger as INITIAL_STOCK, one row per variety', ledger().filter((m) => m.MovementType === 'INITIAL_STOCK').length === 5, J(ledger().map((m) => m.Notes)));
ok('the existing product with the duplicate name was not touched', J(variantsOf('prod_mat').map((v) => v.SKU)) === J(['MAT-L']));
const job = box.__sheets.SyncJobs.objects().pop();
ok('the history says some rows were skipped, and counts the duplicate', job.Status === 'PARTIAL_SUCCESS' && /duplicates/.test(job.SummaryJson) && Number(job.RecordsSkipped) >= 2, J(job));

/* ---------- importing the same file again ---------- */
res = box.actionPreviewInventoryImport(A, req(rows));
ok('the same file again: its rows now match the products by SKU - nothing new, nothing changed', res.ok && res.preview.counts.newProducts === 0 && res.preview.counts.existing === 5 && res.preview.counts.unchanged === 5, J(res.preview.counts));
const count = products().length;
res = box.actionApplyInventoryImport(A, req(rows, { planToken: res.preview.planToken }));
ok('...and applying it creates nothing', res.ok && products().length === count && res.created === 0, J(res));
const fresh = rows.slice(0, 4).map((r) => r.slice(0, 4).concat(['NEW-' + r[4]], r.slice(5)));
res = box.actionPreviewInventoryImport(A, req(fresh));
ok('...and with new SKUs, the names already listed are skipped as duplicates', res.ok && res.preview.counts.newProducts === 0 && res.preview.counts.duplicates === 4, J(res.preview.counts));
ok('an old preview\'s token is refused once things changed (no double apply)', !box.actionApplyInventoryImport(A, req(rows, { planToken: p.planToken })).ok);

/* ---------- listing checks still apply ---------- */
res = box.actionPreviewInventoryImport(A, req([['Bottled water 600ml', '', 1, 10, 'H2O', 'Building & Hardware', '']]));
const held = box.actionApplyInventoryImport(A, req([['Bottled water 600ml', '', 1, 10, 'H2O', 'Building & Hardware', '']], { planToken: res.preview.planToken }));
const water = products().find((x) => x.Name === 'Bottled water 600ml');
ok('a row whose name plainly does not fit its category is created held for review, not live', held.ok && water && water.Status === 'review', J([held, water]));

/* ---------- wholesalers may import Food ---------- */
res = box.actionPreviewInventoryImport(W, req([['Rice 25kg', '', 30, 10, 'RICE25', 'Food & Groceries', '']]));
ok('a wholesaler\'s Food row is accepted', res.ok && res.preview.counts.newProducts === 1 && !res.preview.errors.length, J(res.preview));
ok('another seller\'s names never count as duplicates', (() => {
  const r = box.actionPreviewInventoryImport(W, req([['Coconut soap', 'Small', 2, 5, 'WS-1', 'home', '']]));
  return r.ok && r.preview.counts.newProducts === 1 && r.preview.counts.duplicates === 0;
})());

/* ---------- a description is plain text, kept to 2000 ---------- */
res = box.actionPreviewInventoryImport(A, req([['Long text item', '', 1, 1, 'LT', 'home', 'x'.repeat(2500)]]));
box.actionApplyInventoryImport(A, req([['Long text item', '', 1, 1, 'LT', 'home', 'x'.repeat(2500)]], { planToken: res.preview.planToken }));
ok('a description is kept to 2000 characters', products().find((x) => x.Name === 'Long text item').Description.length === 2000);
res = box.actionPreviewInventoryImport(A, req([['=HYPERLINK("http://x","Click")', '', 1, 1, 'FX', 'home', '=1+1']]));
box.actionApplyInventoryImport(A, req([['=HYPERLINK("http://x","Click")', '', 1, 1, 'FX', 'home', '=1+1']], { planToken: res.preview.planToken }));
const fx = box.__sheets.Products.grid.find((r) => r.some((c) => typeof c === 'string' && /HYPERLINK/.test(c)));
ok('a cell that looks like a formula is stored as text (never run in the sheet)', fx && fx.some((c) => c === '\'=HYPERLINK("http://x","Click")') && fx.some((c) => c === '\'=1+1'), J(fx));

let f = 0; console.log('\n--- bulk product import (real backend) ---');
for (const [s, n, e] of R) { if (s === 'FAIL') f++; console.log(`${s}  ${n}${e && s === 'FAIL' ? '  [' + e + ']' : ''}`); }
console.log(`\n${R.length - f}/${R.length} passed`);
process.exit(f ? 1 : 0);
