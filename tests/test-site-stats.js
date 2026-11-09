/**
 * The welcome screen's live counts (owner request, Nov 2026): siteStats
 * counts the stores and listings a shopper can actually see - browsable
 * stores, their active listings, minus Food a store may not list - and
 * nothing else. On the REAL backend sources (gas-harness).
 */
const { makeBox } = require('./lib/gas-harness.js');
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e === undefined ? '' : e]);
const J = (x) => JSON.stringify(x).slice(0, 300);

const oHead = ['OwnerId', 'StoreName', 'StoreSlug', 'Status', 'StoreType', 'Island', 'Village', 'DeliveryPickPay'];
const box = makeBox({
  Owners: [oHead,
    ['o_st', 'Tarawa Shop', 'tarawa-shop', 'active', 'retailer', 'South Tarawa', 'Bairiki', 'true'],
    ['o_ab', 'Abaiang Shop', 'abaiang-shop', 'active', 'retailer', 'Abaiang', 'Tebunginako', 'true'],
    ['o_wh', 'Bulk Foods', 'bulk-foods', 'active', 'wholesaler', 'South Tarawa', 'Betio', 'true'],
    ['o_off', 'Closed Down', 'closed-down', 'suspended', 'retailer', 'Abaiang', '', 'true']],
  Products: [['ProductId', 'OwnerId', 'StoreSlug', 'Name', 'Description', 'Status', 'Category', 'ListingType'],
    ['p_st', 'o_st', 'tarawa-shop', 'Rice bag', 'Rice', 'active', 'food', 'product'],
    ['p_st2', 'o_st', 'tarawa-shop', 'Bucket', 'Bucket', 'active', 'home', 'product'],
    ['p_st3', 'o_st', 'tarawa-shop', 'Old mop', 'Mop', 'inactive', 'home', 'product'],
    ['p_ab', 'o_ab', 'abaiang-shop', 'Rice bag', 'Rice', 'active', 'food', 'product'],
    ['p_wh', 'o_wh', 'bulk-foods', 'Rice bag', 'Rice', 'active', 'food', 'product'],
    ['p_off', 'o_off', 'closed-down', 'Chair', 'Chair', 'active', 'home', 'product']],
  Variants: [['VariantId', 'ProductId', 'OwnerId', 'Label', 'Price', 'StockQty', 'Status']]
});

const browsable = box.__sheets.Owners.objects().filter((o) => box.isStoreBrowsable(o)).map((o) => o.OwnerId);
ok('fixture: the suspended store is not browsable', browsable.indexOf('o_off') === -1 && browsable.length === 3, J(browsable));

let res = box.actionSiteStats();
ok('counts the browsable stores only', res.ok && res.stores === 3, J(res));
ok('counts active listings a shopper can see (no inactive, no hidden Food, no suspended store)', res.products === 3, J(res));
ok('answers counts and nothing else', Object.keys(res).sort().join(',') === 'ok,products,stores', J(res));

// Public GET route, like listStores.
const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8');
ok('routed as a public GET', /case 'siteStats': return jsonOut\(actionSiteStats\(\)\);/.test(src));
const doGet = src.slice(src.indexOf('function doGet('), src.indexOf('function doPost('));
ok('...inside doGet (no sign-in needed)', /siteStats/.test(doGet));

R.forEach(([s, n, e]) => console.log(s + '  ' + n + (e && s === 'FAIL' ? '  [' + e + ']' : '')));
const failed = R.filter((r) => r[0] === 'FAIL').length;
console.log('\n' + (R.length - failed) + '/' + R.length + ' passed');
process.exit(failed ? 1 : 0);
