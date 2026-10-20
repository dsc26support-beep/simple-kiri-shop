/**
 * Payment options a store accepts (owner decision, Oct 2026), on the REAL
 * Apps Script sources: ticked from IB / MPaisa / Teremo / Cash plus one short
 * option the seller names; only the NAMES reach the public store payloads -
 * never an account number; anything else is refused.
 */
const { makeBox } = require('./lib/gas-harness.js');
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e === undefined ? '' : e]);
const J = (x) => JSON.stringify(x).slice(0, 300);
const FUT = new Date(Date.now() + 9e8).toISOString();

const box = makeBox({
  Owners: [['OwnerId', 'StoreSlug', 'StoreName', 'Status', 'Email', 'Phone', 'Island', 'Village', 'ANZ_AccountNumber', 'Teremo_Number'],
    ['own_a', 'ana', 'Ana Shop', 'active', 'ana@x.com', '73001111', 'South Tarawa', 'Bairiki', '12345678', '73009999'],
    ['own_b', 'bob', 'Bob Store', 'active', 'bob@x.com', '73002222', 'Abaiang', '', '', '']],
  Sessions: [['Token', 'OwnerId', 'CreatedAt', 'ExpiresAt'], ['tok-a', 'own_a', '', FUT]],
  Products: [['ProductId', 'OwnerId', 'StoreSlug', 'Name', 'Status', 'Category', 'ListingType', 'ImageUrl', 'CreatedAt'],
    ['p1', 'own_a', 'ana', 'Rice', 'active', 'home', 'product', '', '']],
  Variants: [['VariantId', 'ProductId', 'OwnerId', 'Label', 'Price', 'Status'], ['v1', 'p1', 'own_a', 'One', 30, 'active']]
}, { guest: true });
box.ContentService = { createTextOutput: (s) => ({ s, setMimeType() { return this; } }), MimeType: { JSON: 'json' } };
const post = (b) => JSON.parse(box.doPost({ postData: { contents: JSON.stringify(b) } }).s);
const owner = (id) => box.sheetToObjects(box.getSheet('Owners')).find((o) => o.OwnerId === id);
const clear = () => Object.keys(box.__cache).forEach((k) => delete box.__cache[k]);
const store = (slug) => { clear(); return box.actionListProducts({ storeSlug: slug }); };

ok('a store that has not chosen shows nothing (no made-up options)', J(store('ana').storePaymentOptions) === '[]');

let r = post({ action: 'updateOwnerProfile', token: 'tok-a', paymentMethods: ['ib', 'mpaisa', 'teremo'], paymentOther: '' });
ok('a seller ticks IB, MPaisa and Teremo', r.ok && owner('own_a').PaymentMethods === 'ib,mpaisa,teremo', J(r));
ok('the storefront gets just the names, in order: IB, MPaisa, Teremo', J(store('ana').storePaymentOptions) === '["IB","MPaisa","Teremo"]');
r = post({ action: 'updateOwnerProfile', token: 'tok-a', paymentMethods: ['cash', 'ib'], paymentOther: 'BKL transfer' });
ok('Cash and their own option "BKL transfer" are added', r.ok && J(store('ana').storePaymentOptions) === '["IB","Cash","BKL transfer"]', J(store('ana').storePaymentOptions));
ok('Settings reads back what was ticked and typed', (() => { const p = box.actionGetOwnerProfile(owner('own_a')).owner; return J(p.paymentMethods) === '["ib","cash"]' && p.paymentOther === 'BKL transfer'; })());
ok('the public store info carries the names too', J(box.publicStoreFields(owner('own_a')).paymentOptions) === '["IB","Cash","BKL transfer"]');

/* ---------- names only, never details ---------- */
const s = JSON.stringify(store('ana')) + JSON.stringify(box.publicStoreFields(owner('own_a')));
ok('NO ACCOUNT NUMBER is ever public: not the ANZ or Teremo number on file', !s.includes('12345678') && !s.includes('73009999'));
const bad = (v) => post({ action: 'updateOwnerProfile', token: 'tok-a', paymentOther: v });
ok('their own option refuses an account number', /account numbers/i.test(bad('ANZ 1234 5678').error || '') && /account numbers/i.test(bad('Teremo 7300-9999').error || ''));
ok('...HTML', !bad('<b>Cash</b>').ok);
ok('...and more than 30 characters', !bad('A very long payment description here').ok);
ok('...and nothing bad was saved', owner('own_a').PaymentOther === 'BKL transfer');
r = post({ action: 'updateOwnerProfile', token: 'tok-a', paymentMethods: ['ib', 'paypal', 'ib', '<x>'] });
ok('unknown or repeated ticks are dropped', r.ok && owner('own_a').PaymentMethods === 'ib');
ok('a non-list is refused', !post({ action: 'updateOwnerProfile', token: 'tok-a', paymentMethods: 'ib' }).ok);
r = post({ action: 'updateOwnerProfile', token: 'tok-a', paymentMethods: [], paymentOther: '' });
ok('clearing everything shows nothing again', r.ok && J(store('ana').storePaymentOptions) === '[]');
ok('only the signed-in seller can change it', !post({ action: 'updateOwnerProfile', token: 'nope', paymentMethods: ['cash'] }).ok);
ok('other stores are not touched', !owner('own_b').PaymentMethods);

let fails = 0;
console.log('\n--- payment options (real backend) ---');
for (const [st, n, x] of R) { if (st === 'FAIL') fails++; console.log(`${st}  ${n}${x !== '' ? '  [' + x + ']' : ''}`); }
console.log(`\n${R.length - fails}/${R.length} passed`);
process.exit(fails ? 1 : 0);
