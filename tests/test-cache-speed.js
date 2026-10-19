/**
 * Speed work (Oct 2026: "home page, categories, dashboard feel very slow"),
 * on the REAL backend sources (gas-harness):
 *  - getCached now keeps values over ScriptCache's ~100KB per-key cap, split
 *    into parts, instead of silently not caching them (big categories);
 *  - warmPublicCaches() pre-builds the homepage and every top-level category
 *    for the 5-minute trigger, and writes nothing to the sheets.
 */
const { makeBox } = require('./lib/gas-harness.js');
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e === undefined ? '' : e]);

const big = Array.from({ length: 1200 }, (_, i) => ({ id: 'p' + i, name: 'Product number ' + i + ' with a fairly long descriptive name', price: i + 0.5 }));
const box = makeBox({
  Owners: [['OwnerId', 'StoreSlug', 'StoreName', 'Email', 'Status', 'StoreType', 'Island'], ['own_a', 'alpha', 'Alpha', 'a@x.test', 'active', 'wholesaler', 'South Tarawa']],
  Products: [['ProductId', 'OwnerId', 'StoreSlug', 'Name', 'Description', 'Category', 'ListingType', 'Status', 'ViewCount'],
    ['p1', 'own_a', 'alpha', 'Rice 10kg', 'Long grain', 'food', 'product', 'active', 5], ['p2', 'own_a', 'alpha', 'Phone charger', 'USB', 'electronics', 'product', 'active', 9]],
  Variants: [['VariantId', 'ProductId', 'OwnerId', 'Label', 'Price', 'StockQty', 'Status'], ['v1', 'p1', 'own_a', 'Bag', 18, '', 'active'], ['v2', 'p2', 'own_a', 'Std', 9, '', 'active']]
});
const cache = box.__cache;

/* ---------- large values are cached in parts ---------- */
let built = 0;
const make = () => { built++; return big; };
const text = JSON.stringify(big);
ok('the test value really is over the per-key cap', text.length > 100000, text.length);
let v = box.getCached('t:big', 60, make);
ok('first call builds it', built === 1 && v.length === 1200);
ok('stored as a marker plus parts', /^~parts:\d+$/.test(cache['t:big']) && typeof cache['t:big#0'] === 'string', String(cache['t:big']));
ok('every part is under the cap', Object.keys(cache).filter((k) => k.indexOf('t:big#') === 0).every((k) => cache[k].length <= 90000));
v = box.getCached('t:big', 60, make);
ok('second call is served from the cache, identical', built === 1 && JSON.stringify(v) === text);
delete cache['t:big#1'];
v = box.getCached('t:big', 60, make);
ok('a missing part is a miss (rebuilt), never half an answer', built === 2 && JSON.stringify(v) === text);
ok('small values are stored as before (plain JSON)', box.getCached('t:small', 60, () => ({ a: 1 })).a === 1 && cache['t:small'] === '{"a":1}');
ok('a value that cannot be parsed back reads as a miss', (cache['t:bad'] = '~parts:2', cache['t:bad#0'] = '{"x"', cache['t:bad#1'] = ':', box.getCached('t:bad', 60, () => 'rebuilt') === 'rebuilt'));

/* ---------- warm-up job ---------- */
Object.keys(cache).forEach((k) => delete cache[k]);
const before = JSON.stringify(box.__sheets.Products.grid) + JSON.stringify(box.__sheets.Variants.grid);
const warmed = box.warmPublicCaches();
ok('warms the homepage and every top-level category', warmed[0] === 'homepage' && warmed.indexOf('food') !== -1 && warmed.indexOf('electronics') !== -1, warmed.join(','));
ok('homepage pieces are in the cache', !!cache['v3:topProducts'] && !!cache['v3:topStores']);
ok('category first screens are in the cache', !!cache['v4:search:food::'] && JSON.parse(cache['v4:search:food::']).some((p) => p.productId === 'p1'));
ok('writes nothing to the sheets', JSON.stringify(box.__sheets.Products.grid) + JSON.stringify(box.__sheets.Variants.grid) === before);
const res = box.actionSearchProducts({ category: 'food', type: '', q: '' });
ok('a shopper opening Food now gets the warmed answer', res.ok && res.products.length === 1 && res.products[0].productId === 'p1', JSON.stringify(res).slice(0, 200));
ok('homepage answer matches what is warmed', JSON.stringify(box.actionGetHomePageData().products) === cache['v3:topProducts']);

let fails = 0;
console.log('\n--- speed: big values cached in parts + warm-up job ---');
for (const [s, n, x] of R) { if (s === 'FAIL') fails++; console.log(`${s}  ${n}${x !== '' ? '  [' + x + ']' : ''}`); }
console.log(`\n${R.length - fails}/${R.length} passed`);
process.exit(fails ? 1 : 0);
