/**
 * TestData.gs (owner request, 28 Oct 2026): addTestProducts puts 150 "TEST - "
 * listings across the categories into Nei Recharge through the real seller
 * save; removeTestProducts takes exactly those out again. Real backend
 * sources (gas-harness).
 */
const { makeBox } = require('./lib/gas-harness.js');
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e === undefined ? '' : String(e).slice(0, 400)]);

const box = makeBox({
  Owners: [['OwnerId', 'StoreName', 'StoreSlug', 'Status', 'StoreType', 'Island', 'Village'],
    ['o_nei', 'Nei Recharge', 'nei-recharge', 'active', 'retailer', 'South Tarawa', 'Bairiki'],
    ['o_x', 'Other Shop', 'other-shop', 'active', 'retailer', 'Abaiang', '']],
  Products: [['ProductId', 'OwnerId', 'StoreSlug', 'Name', 'Description', 'Status', 'Category', 'ListingType'],
    ['p_real', 'o_nei', 'nei-recharge', 'TEST - Real phone credit', 'Real item, no tag', 'active', 'electronics', 'product'],
    ['p_other', 'o_x', 'other-shop', 'TEST - Rice 10kg bag (1)', 'x [mwk-test-2026-10]', 'active', 'food', 'product']],
  Variants: [['VariantId', 'ProductId', 'OwnerId', 'Label', 'Price', 'StockQty', 'Status'],
    ['v_real', 'p_real', 'o_nei', 'Default', '5', '3', 'active'], ['v_other', 'p_other', 'o_x', 'Default', '5', '3', 'active']]
});
box.Logger = { log() {} };
const products = () => box.__sheets.Products.objects();
const mine = () => products().filter((p) => p.OwnerId === 'o_nei' && /\[mwk-test-2026-10\]/.test(p.Description));

let msg = box.addTestProducts();
const added = mine();
ok('adds 150 test products to Nei Recharge', added.length === 150, msg);
ok('every name starts "TEST - " and is unique', added.every((p) => p.Name.indexOf('TEST - ') === 0) && new Set(added.map((p) => p.Name)).size === 150);
const cats = {}; added.forEach((p) => { cats[p.Category] = (cats[p.Category] || 0) + 1; });
const counts = Object.values(cats);
ok('spread evenly over the categories (no Other)', !cats.other && Math.max(...counts) - Math.min(...counts) <= 1, JSON.stringify(cats));
ok('a South Tarawa retailer gets no Food (the store rule)', !cats.food, JSON.stringify(cats));
ok('rentals/services where a category takes no products', added.filter((p) => p.Category === 'property').every((p) => p.ListingType === 'rental')
  && added.filter((p) => p.Category === 'services').every((p) => p.ListingType === 'service'), JSON.stringify(added.filter((p) => ['property', 'services', 'education'].includes(p.Category)).map((p) => p.ListingType)));
ok('all live for shoppers (none held for review or hidden)', added.every((p) => p.Status === 'active'), JSON.stringify(added.filter((p) => p.Status !== 'active').map((p) => p.Name + ':' + p.Status)));
const vars = box.__sheets.Variants.objects().filter((v) => added.some((p) => p.ProductId === v.ProductId));
ok('each has a price', vars.length >= 150 && vars.every((v) => Number(v.Price) > 0), vars.length);

msg = box.addTestProducts();
ok('running it again adds nothing (it only tops up to 150)', mine().length === 150, msg);

msg = box.removeTestProducts();
ok('remove takes all 150 off the site (archived, the normal delete)', mine().length === 150 && mine().every((p) => p.Status === 'archived'), msg);
msg = box.removeTestProducts();
ok('removing again finds nothing left to remove', /^Removed 0 /.test(msg), msg);
msg = box.addTestProducts();
ok('and they can be added again afterwards', mine().filter((p) => p.Status === 'active').length === 150, msg);
ok('...but not the store\'s real product, even one named "TEST - "', products().some((p) => p.ProductId === 'p_real' && p.Status === 'active'));
ok('...nor another store\'s product carrying the tag', products().some((p) => p.ProductId === 'p_other' && p.Status === 'active'));

const box2 = makeBox({ Owners: [['OwnerId', 'StoreName', 'StoreSlug', 'Status'], ['o1', 'Somebody', 's', 'active']], Products: [['ProductId', 'OwnerId', 'Name']], Variants: [['VariantId']] });
let threw = ''; try { box2.addTestProducts(); } catch (e) { threw = e.message; }
ok('no store called Nei Recharge: stops with a clear message, adds nothing', /No store is called "Nei Recharge"/.test(threw) && box2.__sheets.Products.objects().length === 0, threw);

let f = 0; console.log('\n--- test products (TestData.gs) ---');
for (const [s, n, e] of R) { if (s === 'FAIL') f++; console.log(`${s}  ${n}${e && s === 'FAIL' ? '  [' + e + ']' : ''}`); }
console.log(`\n${R.length - f}/${R.length} passed`);
process.exit(f ? 1 : 0);
