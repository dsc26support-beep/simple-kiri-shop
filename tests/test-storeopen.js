const fs = require('fs'), vm = require('vm');
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e || '']);
const auth = fs.readFileSync('/home/user/simple-kiri-shop/apps-script/Auth.gs', 'utf8');

// Pull the two helpers out of Auth.gs and exercise the real source.
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(auth.match(/function isStoreBrowsable[\s\S]*?\n}/)[0] + '\n' +
                auth.match(/function isStoreOpenForBusiness[\s\S]*?\n}/)[0], sandbox);
const { isStoreBrowsable, isStoreOpenForBusiness } = sandbox;

for (const [status, browsable, open] of [
  ['active', true, true],
  ['standby', true, false],   // the new meaning: visible, marked Closed, no orders
  ['closed', false, false],   // soft delete: hidden and locked out
]) {
  ok(`${status}: browsable=${browsable}`, isStoreBrowsable({ Status: status }) === browsable);
  ok(`${status}: openForBusiness=${open}`, isStoreOpenForBusiness({ Status: status }) === open);
}
ok('null owner is neither', !isStoreBrowsable(null) && !isStoreOpenForBusiness(null));
ok('unknown status is neither', !isStoreBrowsable({ Status: 'wat' }) && !isStoreOpenForBusiness({ Status: 'wat' }));

// The money gates must reject standby, and say why.
for (const [file, word] of [['Orders.gs', 'order'], ['Bookings.gs', 'booking']]) {
  const src = fs.readFileSync('/home/user/simple-kiri-shop/apps-script/' + file, 'utf8');
  ok(`${file} allows browsable stores through`, /if \(!isStoreBrowsable\(owner\)\) return fail\('Store not found'\);/.test(src));
  ok(`${file} blocks a closed store from taking ${word}s`,
    new RegExp(`if \\(!isStoreOpenForBusiness\\(owner\\)\\)[\\s\\S]{0,200}closed right now and cannot take ${word}s`).test(src));
}

// No customer-facing read path may still gate on 'active' alone.
for (const f of ['Products.gs', 'Chat.gs']) {
  const src = fs.readFileSync('/home/user/simple-kiri-shop/apps-script/' + f, 'utf8');
  const owners = src.match(/owner\w*\.Status [!=]== 'active'/g) || [];
  ok(`${f} has no leftover owner-status === active gate`, owners.length === 0, owners.join(' '));
}

// Product/variant status gates must NOT have been touched - different concept.
const prod = fs.readFileSync('/home/user/simple-kiri-shop/apps-script/Products.gs', 'utf8');
ok('product-level active filter preserved', /p\.Status === 'active'/.test(prod));
ok('variant-level active filter preserved', /v\.Status === 'active'/.test(prod));
ok('storeOpen exposed on the store payload', /storeOpen: isStoreOpenForBusiness\(owner\)/.test(prod));
ok('isOpen exposed on publicOwnerFields', /isOpen: isStoreOpenForBusiness\(owner\)/.test(auth));

let f = 0;
console.log('\n--- Store open/closed semantics ---');
for (const [s, n, e] of R) { if (s === 'FAIL') f++; console.log(`${s}  ${n}${e ? '  [' + e + ']' : ''}`); }
console.log(`\n${R.length - f}/${R.length} passed`);
process.exit(f ? 1 : 0);
