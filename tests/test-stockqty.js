/**
 * stockQtyOf and publicVariantFields (Products.gs) - the two pure functions
 * that decide what "stock" means everywhere it's written or read. Getting
 * either wrong either locks out every order against a variant (0 read as
 * "unlimited" or vice versa) or silently drops a seller's real "sold out".
 *
 * Exercises the real functions straight out of the source, not a
 * reimplementation - same pattern as test-costwrite.js.
 */
const fs = require('fs'), vm = require('vm');
const src = fs.readFileSync('/home/user/simple-kiri-shop/apps-script/Products.gs', 'utf8');
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e || '']);

const grab = (name) => {
  const m = src.match(new RegExp('function ' + name + '[\\s\\S]*?\\n}'));
  if (!m) throw new Error('could not find ' + name + ' in source');
  return m[0];
};

function load(names) {
  const box = {};
  vm.createContext(box);
  vm.runInContext(names.map(grab).join('\n'), box);
  return box;
}

const { stockQtyOf } = load(['stockQtyOf']);

ok("blank -> '' (untracked)", stockQtyOf('') === '');
ok('undefined -> "" (untracked)', stockQtyOf(undefined) === '');
ok('null -> "" (untracked)', stockQtyOf(null) === '');
ok('0 -> 0 (a real, deliberate sold-out)', stockQtyOf(0) === 0, stockQtyOf(0));
ok("'0' -> 0", stockQtyOf('0') === 0);
ok('5 -> 5', stockQtyOf(5) === 5);
ok("'12' -> 12", stockQtyOf('12') === 12);
ok('negative -> "" (untracked, not a negative shelf)', stockQtyOf(-3) === '');
ok('fractional -> floored', stockQtyOf(4.9) === 4);
ok("garbage -> '' (untracked, not a silent 0 that blocks every order)", stockQtyOf('abc') === '');

const { publicVariantFields } = load(['publicVariantFields']);
const v = (StockQty) => ({ VariantId: 'v1', Label: 'Small', Price: '10', StockQty });

ok("StockQty '' -> stockQty null (unlimited)", publicVariantFields(v('')).stockQty === null);
ok('StockQty undefined -> stockQty null', publicVariantFields(v(undefined)).stockQty === null);
ok('StockQty 0 -> stockQty 0, not null (sold out survives the trip to the frontend)',
  publicVariantFields(v(0)).stockQty === 0, publicVariantFields(v(0)).stockQty);
ok("StockQty '7' -> stockQty 7 (number, not string)", publicVariantFields(v('7')).stockQty === 7);
ok('price is still coerced to a number', publicVariantFields(v('')).price === 10);

// The variant-row acceptance guard inside actionCreateOrUpdateProduct: a
// price of exactly 0 must be rejected, same as a negative or missing one -
// it is never a deliberate listing, just an empty/mistyped field.
const guard = src.match(/if \(!label \|\| isNaN\(price\) \|\| price <= 0\) return;/);
ok('actionCreateOrUpdateProduct rejects price <= 0 (not just < 0)', !!guard);

let f = 0;
console.log('\n--- stock quantity: normalization + public exposure ---');
for (const [s, n, e] of R) { if (s === 'FAIL') f++; console.log(`${s}  ${n}${e !== '' && e !== undefined ? '  [' + e + ']' : ''}`); }
console.log(`\n${R.length - f}/${R.length} passed`);
process.exit(f ? 1 : 0);
