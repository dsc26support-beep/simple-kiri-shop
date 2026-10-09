/**
 * Store names: 22 characters at most (owner's call, Oct 2026), on the REAL
 * backend (gas-harness) and the shared front-end helpers.
 */
const { makeBox } = require('./lib/gas-harness.js');
const fs = require('fs'), vm = require('vm');
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e === undefined ? '' : e]);

const box = makeBox({ Owners: [['OwnerId', 'StoreSlug', 'StoreName', 'Status', 'Phone', 'Email'],
  ['o1', 'long', 'A Very Long Old Store Name Here', 'active', '73000001', 'a@x.com']] });
ok('backend: 22 characters is fine', box.storeNameTooLong('Abcdefghijklmnopqrstuv') === null);
ok('backend: 23 is refused, with the limit in the message', /22 characters or fewer/.test((box.storeNameTooLong('Abcdefghijklmnopqrstuvw') || {}).error || ''));
ok('backend: counted in characters - 22 emoji/accents are fine', box.storeNameTooLong('é'.repeat(22)) === null && box.storeNameTooLong('😀'.repeat(22)) === null);
ok('backend: surrounding spaces are not counted', box.storeNameTooLong('  ' + 'a'.repeat(22) + '  ') === null);
const src = fs.readFileSync(__dirname + '/../apps-script/Auth.gs', 'utf8') + fs.readFileSync(__dirname + '/../apps-script/Products.gs', 'utf8');
ok('backend: Create Store and the Settings save both use the 22 limit', (src.match(/storeNameTooLong\(/g) || []).length === 2 && !/capLength\([^)]*'Store name'\)/.test(src));
// The settings save on a store whose old name is too long must be refused until shortened.
const owner = box.findRowById(box.getSheet('Owners'), 'OwnerId', 'o1');
let res = box.actionUpdateOwnerProfile(owner, { storeName: owner.StoreName });
ok('backend: an older long name must be shortened at the next Settings save', !res.ok && /22 characters or fewer/.test(res.error), JSON.stringify(res).slice(0, 200));
ok('backend: ...and nothing in the sheet is changed meanwhile', box.getSheet('Owners').getRange(2, 3).getValue() === 'A Very Long Old Store Name Here');

// Front-end helper.
const helpersSrc = fs.readFileSync(__dirname + '/../assets/js/helpers.js', 'utf8');
const h = { Array, String };
vm.createContext(h);
vm.runInContext(helpersSrc.match(/const STORE_NAME_MAX = \d+;/)[0] + '\n' + helpersSrc.match(/function shortStoreName[\s\S]*?\n}\n/)[0] + 'this.shortStoreName = shortStoreName;', h);
ok('display: a short name is unchanged', h.shortStoreName('Bong Store') === 'Bong Store');
ok('display: an older long name is cut at 22 with …', h.shortStoreName('A Very Long Old Store Name Here') === 'A Very Long Old Store…', h.shortStoreName('A Very Long Old Store Name Here'));
ok('display: empty stays empty', h.shortStoreName('') === '' && h.shortStoreName(null) === '');

let f = 0;
console.log('\n--- store name limit ---');
for (const [s, n, e] of R) { if (s === 'FAIL') f++; console.log(`${s}  ${n}${e !== '' ? '  [' + e + ']' : ''}`); }
console.log(`\n${R.length - f}/${R.length} passed`);
process.exit(f ? 1 : 0);
