const fs = require('fs'), vm = require('vm');
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e || '']);
const AS = '/home/user/simple-kiri-shop/apps-script/';
const JS = '/home/user/simple-kiri-shop/assets/js/';
const read = (p) => fs.readFileSync(p, 'utf8');
const auth = read(AS + 'Auth.gs'), prod = read(AS + 'Products.gs'), orders = read(AS + 'Orders.gs');
const notify = read(AS + 'Notify.gs');
const grab = (src, name) => src.match(new RegExp('function ' + name + '\\([\\s\\S]*?\\n}'))[0];

// Real source, no reimplementation. isOwnerAdmin is stubbed (Admin.gs reaches
// for Script Properties); everything else is the shipped code.
const sandbox = {
  isOwnerAdmin: (o) => o.Email === 'boss@mwakete.com',
  String,
  // publicOwnerFields now calls effectiveAuthChannel (Notify.gs), which asks
  // Script Properties whether an SMS sender exists. No sender on a default
  // deployment, which is the state this suite should describe.
  PropertiesService: { getScriptProperties: () => ({ getProperty: () => null }) }
};
vm.createContext(sandbox);
vm.runInContext([
  grab(notify, 'smsSenderConfigured'),
  grab(notify, 'effectiveAuthChannel'),
  grab(auth, 'publicOwnerFields'),
  grab(auth, 'publicStoreFields'),
  grab(auth, 'isStoreOpenForBusiness'),
  grab(prod, 'deliveryFlagsOf'),
  grab(prod, 'deliveryCostOf')
].join('\n'), sandbox);
const { publicOwnerFields, publicStoreFields } = sandbox;

const OWNER = {
  OwnerId: 'own_1', StoreName: 'Tarawa Traders', StoreSlug: 'tarawa-traders',
  Email: 'boss@mwakete.com', Phone: '73012345', Messenger: 'm.me/tarawa',
  LogoUrl: 'https://img/logo.png', Island: 'South Tarawa', Village: 'Bairiki',
  Status: 'active', TwoFAEnabled: 'true',
  DeliveryTruck: 'true', DeliveryShip: 'true', DeliveryAirCargo: 'false', DeliveryPickPay: 'true',
  DeliveryTruckCost: 5, DeliveryShipCost: '', DeliveryAirCargoCost: null,
  IdLicenseUrl: 'https://img/license.png'
};

/* 1. The leak, closed. hasOwnProperty so an explicit undefined still fails. */
const store = publicStoreFields(OWNER);
for (const f of ['email', 'twoFAEnabled', 'isAdmin', 'ownerId', 'status', 'idLicenseUrl']) {
  ok(`publicStoreFields omits ${f}`, !Object.prototype.hasOwnProperty.call(store, f),
    Object.prototype.hasOwnProperty.call(store, f) ? 'value=' + JSON.stringify(store[f]) : '');
}
ok('no owner email anywhere in the serialised payload', JSON.stringify(store).indexOf('boss@mwakete.com') === -1);

/* 2. Everything the shape is supposed to carry. */
// whatsapp joined this list deliberately (PR #24, the Call/WhatsApp/Messenger
// buttons). It is the seller's own published business contact, sitting beside
// phone and messenger, which were already here - not new customer data.
const EXPECTED = ['storeName', 'storeSlug', 'phone', 'messenger', 'whatsapp', 'logoUrl', 'island', 'village',
  'isOpen', 'deliveryTruck', 'deliveryShip', 'deliveryAirCargo', 'deliveryPickPay',
  'deliveryTruckCost', 'deliveryShipCost', 'deliveryAirCargoCost'];
ok('publicStoreFields carries exactly the 16 expected fields',
  JSON.stringify(Object.keys(store).sort()) === JSON.stringify(EXPECTED.slice().sort()),
  Object.keys(store).sort().join(','));

/* 3. Delivery coercion must match publicOwnerFields row for row - the
      blank-means-negotiated contract from PR #10/#13. */
const DELIVERY = ['deliveryTruck', 'deliveryShip', 'deliveryAirCargo', 'deliveryPickPay',
  'deliveryTruckCost', 'deliveryShipCost', 'deliveryAirCargoCost'];
const COSTS = [['blank', '', null], ['null', null, null], ['zero', 0, 0], ['number', 250, 250], ['numeric string', '250', 250]];
for (const [label, raw, want] of COSTS) {
  const row = Object.assign({}, OWNER, { DeliveryTruckCost: raw });
  const s = publicStoreFields(row), o = publicOwnerFields(row);
  ok(`cost ${label} -> ${JSON.stringify(want)}`, s.deliveryTruckCost === want, 'got ' + JSON.stringify(s.deliveryTruckCost));
  ok(`cost ${label} matches publicOwnerFields`, s.deliveryTruckCost === o.deliveryTruckCost);
}
for (const flag of ['true', 'false', '', null, true, false]) {
  const row = Object.assign({}, OWNER, { DeliveryShip: flag });
  ok(`flag ${JSON.stringify(flag)} coerces identically`,
    publicStoreFields(row).deliveryShip === publicOwnerFields(row).deliveryShip);
}
for (const f of DELIVERY) ok(`${f} identical for the sample row`, store[f] === publicOwnerFields(OWNER)[f]);

/* 4. isOpen still derives from status, and only 'active' is open. */
for (const [status, want] of [['active', true], ['standby', false], ['closed', false]]) {
  ok(`isOpen for ${status} = ${want}`, publicStoreFields(Object.assign({}, OWNER, { Status: status })).isOpen === want);
}

/* 5. publicOwnerFields must not have moved - the authenticated profile. */
const owner = publicOwnerFields(OWNER);
ok('publicOwnerFields still exposes ownerId/email/status/twoFAEnabled/isAdmin',
  owner.ownerId === 'own_1' && owner.email === 'boss@mwakete.com' && owner.status === 'active' &&
  owner.twoFAEnabled === true && owner.isAdmin === true);
// authChannel / authChannelEffective joined this list deliberately (PR #27, the
// auth-code channel router). Both are about how the VENDOR receives a login
// code; neither is customer data, and neither is on publicStoreFields.
const OWNER_KEYS = ['ownerId', 'storeName', 'storeSlug', 'email', 'phone', 'messenger', 'whatsapp', 'logoUrl',
  'authChannel', 'authChannelEffective',
  'island', 'village', 'status', 'isOpen', 'deliveryTruck', 'deliveryShip', 'deliveryAirCargo',
  'deliveryPickPay', 'deliveryTruckCost', 'deliveryShipCost', 'deliveryAirCargoCost',
  'twoFAEnabled', 'isAdmin'];
ok('publicOwnerFields key set unchanged',
  JSON.stringify(Object.keys(owner).sort()) === JSON.stringify(OWNER_KEYS.slice().sort()),
  Object.keys(owner).sort().join(','));
// Independent of my fixture: diff the shipped function against main's copy.
const mainAuth = require('child_process')
  .execSync('git -C /home/user/simple-kiri-shop show origin/main:apps-script/Auth.gs', { encoding: 'utf8' });
// Back to strict, now that PR #27 has merged and main carries the two
// auth-channel fields too.
//
// While that PR was open this was relaxed to "the only differences may be the
// two auth-channel lines". Left relaxed after the merge it would quietly retire
// the guard: it would keep passing while some LATER change added a field, since
// tree and main would differ by that instead. Strict is the resting state;
// relax it only for the life of a branch that is deliberately adding a field,
// and put it back on merge.
const mainOwnerSrc = grab(mainAuth, 'publicOwnerFields');
const hereOwnerSrc = grab(auth, 'publicOwnerFields');
ok('publicOwnerFields source is byte-identical to main', mainOwnerSrc === hereOwnerSrc);
ok('nothing was removed from publicOwnerFields',
  mainOwnerSrc.split('\n').filter((l) => /^\s+\w+: /.test(l))
    .every((l) => hereOwnerSrc.indexOf(l) !== -1));
ok('the auth-channel fields are on main, not just in the working tree',
  /authChannel: owner\.AuthChannel/.test(mainOwnerSrc) &&
  /authChannelEffective: effectiveAuthChannel\(owner\)/.test(mainOwnerSrc), 'still branch-only');

// PR #16 is merged, so publicStoreFields is on main now too - what still has
// to hold is that it is there and that no public action reaches past it.
ok('publicStoreFields is present on main', mainAuth.indexOf('function publicStoreFields') !== -1);

/* 6. Every field the customer scripts actually read must exist in the shape.
      This is the regression that would break shoppers if a field were cut. */
const reads = new Set();
for (const [file, re] of [
  ['checkout.js', /storeInfo\.([A-Za-z]\w*)/g],
  ['cart-page.js', /res\.store\.([A-Za-z]\w*)/g],
  ['chat-window.js', /res\.store\.([A-Za-z]\w*)/g]
]) {
  const src = read(JS + file);
  let m; while ((m = re.exec(src))) reads.add(file + ':' + m[1]);
}
const missing = [...reads].filter((r) => !Object.prototype.hasOwnProperty.call(store, r.split(':')[1]));
ok(`all ${reads.size} consumer field reads resolve against publicStoreFields`, missing.length === 0, missing.join(' '));

/* 7. No PUBLIC action may still hand out publicOwnerFields. */
ok('actionGetStorePublicInfo uses publicStoreFields',
  /function actionGetStorePublicInfo[\s\S]*?return publicStoreFields\(owner\);/.test(prod));
ok('createOrder response uses publicStoreFields', /store: publicStoreFields\(owner\),/.test(orders));
ok('createOrder no longer references publicOwnerFields', orders.indexOf('publicOwnerFields') === -1);
const publicInfoBody = prod.match(/function actionGetStorePublicInfo[\s\S]*?\n}/)[0];
ok('actionGetStorePublicInfo no longer references publicOwnerFields', publicInfoBody.indexOf('publicOwnerFields') === -1);

/* 8. The cache-key bump must be applied everywhere, or invalidation silently
      stops clearing what the reader reads. */
const all = ['Auth.gs', 'Products.gs', 'Images.gs', 'Orders.gs', 'Chat.gs', 'Code.gs', 'Admin.gs', 'Bookings.gs']
  .map((f) => read(AS + f)).join('\n');
const keys = [...new Set(all.match(/'v\d+:storeInfo:'/g) || [])];
ok('every storeInfo cache key is on the same version', keys.length === 1 && keys[0] === "'v2:storeInfo:'", keys.join(' '));
ok('read and invalidate sites all bumped', (all.match(/'v2:storeInfo:'/g) || []).length === 4,
  String((all.match(/'v2:storeInfo:'/g) || []).length));
// Not a literal - pinning one means every later release breaks this test, which
// has now happened four times. The rule that actually matters: if any .gs file
// differs from main, APP_VERSION must differ too, or the deploy probe will
// report a version that is already live and the redeploy looks done when it
// isn't.
const sh = (c) => require('child_process').execSync(c, { encoding: 'utf8' }).trim();
const gsChanged = sh('git -C /home/user/simple-kiri-shop diff --name-only origin/main -- apps-script/')
  .split('\n').filter(Boolean);
const verOf = (t) => (t.match(/var APP_VERSION = '([^']+)';/) || [])[1];
const mineVer = verOf(read(AS + 'Code.gs'));
const mainVer = verOf(sh('git -C /home/user/simple-kiri-shop show origin/main:apps-script/Code.gs'));
ok('APP_VERSION is set', !!mineVer, String(mineVer));
ok('APP_VERSION bumped because .gs files changed',
  gsChanged.length === 0 || mineVer !== mainVer,
  `${gsChanged.length} changed: ${gsChanged.join(',')} | ${mainVer} -> ${mineVer}`);

let f = 0;
console.log('\n--- Public store payload narrowing ---');
for (const [s, n, e] of R) { if (s === 'FAIL') f++; console.log(`${s}  ${n}${e ? '  [' + e + ']' : ''}`); }
console.log(`\n${R.length - f}/${R.length} passed`);
process.exit(f ? 1 : 0);
