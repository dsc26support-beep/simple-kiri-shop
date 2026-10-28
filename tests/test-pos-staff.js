/**
 * Mwakete POS staff, tills and roles (PosStaff.gs; Oct 2026) through doPost,
 * like the real site: owner registers a till (secret shown once, stored
 * hashed), staff sign in with a PIN on that till, every POS action passes one
 * role check for owner and staff, revoking a till ends its sessions, store
 * isolation, PIN lockout, cash shifts with expected cash and variance, and
 * online orders kept apart from in-store sales.
 */
const { makeBox } = require('./lib/gas-harness.js');
let pass = 0, fails = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('PASS  ' + n); } else { fails++; console.log('FAIL  ' + n + (e === undefined ? '' : '  [' + String(e).slice(0, 400) + ']')); } };
const J = (x) => JSON.stringify(x);
const FUT = new Date(Date.now() + 86400000).toISOString();

const box = makeBox({
  Owners: [['OwnerId', 'StoreSlug', 'StoreName', 'Status', 'StoreType', 'Email'], ['own_a', 'a', 'A Shop', 'active', '', 'a@x.test'], ['own_b', 'b', 'B Shop', 'active', '', 'b@x.test']],
  Sessions: [['Token', 'OwnerId', 'CreatedAt', 'ExpiresAt'], ['tok-owner-a', 'own_a', '', FUT], ['tok-owner-b', 'own_b', '', FUT]],
  Products: [['ProductId', 'OwnerId', 'Name', 'Status', 'Category'], ['prod_a', 'own_a', 'Rice', 'active', 'food'], ['prod_b', 'own_b', 'Flour', 'active', 'food']],
  Variants: [['VariantId', 'ProductId', 'OwnerId', 'Label', 'Price', 'SKU', 'StockQty', 'Status', 'ReservedQty', 'Barcode', 'CostPrice'],
    ['v1', 'prod_a', 'own_a', '1kg', 2, 'R1', 100, 'active', 0, '0012', 1], ['vb', 'prod_b', 'own_b', '25kg', 30, 'F1', 50, 'active', 0, '', 20]],
  Orders: [['OrderId', 'OwnerId', 'Status', 'Total', 'CreatedAt', 'CustomerName', 'DeliveryMethod'], ['ord1', 'own_a', 'Pending Payment', 25, '2026-10-27T00:00:00Z', 'Teraoi', 'pickup'],
    ['ord2', 'own_a', 'Fulfilled', 10, '2026-10-26T00:00:00Z', 'Old', 'pickup']]
});
box.__props.POS_HUB = 'on';
box.__props.PASSWORD_ITERATIONS = '1000';
box.__props.PEPPER = 'test-pepper';
box.ContentService = { createTextOutput: (s) => ({ s, setMimeType() { return this; } }), MimeType: { JSON: 'json' } };
const post = (b) => { try { return JSON.parse(box.doPost({ postData: { contents: JSON.stringify(b) } }).s); } catch (e) { return { ok: false, error: String(e.message || e) }; } };
const owner = (action, body) => post(Object.assign({ action, token: 'tok-owner-a' }, body || {}));
let n = 0;
const txn = () => 'txn-staff-' + (++n) + '-abcd';

/* ---------- tills ---------- */
let r = owner('posRegisterDevice', { name: 'Front counter' });
const dev = r.device, secret = r.deviceSecret;
ok('owner registers a till: id, short code, secret answered once', r.ok && /^dev/.test(dev.deviceId) && /^[A-Z0-9]{4}$/.test(dev.code) && secret.length > 40, J(r));
ok('only a hash of the secret is stored', box.__sheets.PosDevices.objects().every((d) => d.SecretHash !== secret && /^h1:/.test(d.SecretHash)));
ok('the secret is never listed again', !J(owner('posListDevices')).includes(secret));
ok('another store cannot see or revoke this till', post({ action: 'posListDevices', token: 'tok-owner-b' }).devices.length === 0
  && !post({ action: 'posRevokeDevice', token: 'tok-owner-b', deviceId: dev.deviceId }).ok);
ok('no session, no till registration', !post({ action: 'posRegisterDevice', name: 'x' }).ok);

/* ---------- staff ---------- */
r = owner('posSaveStaff', { name: 'Tiaon', role: 'cashier', pin: '4821' });
const cashierId = r.staff && r.staff.staffId;
ok('owner adds a cashier with a PIN (stored hashed)', r.ok && box.__sheets.PosStaff.objects().every((s) => s.PinHash !== '4821' && /^pbkdf2\$/.test(s.PinHash)), J(r));
ok('weak or malformed PINs refused', !owner('posSaveStaff', { name: 'X', role: 'cashier', pin: '1111' }).ok && !owner('posSaveStaff', { name: 'X', role: 'cashier', pin: '12a4' }).ok);
ok('"owner" is not a role staff can be given', !owner('posSaveStaff', { name: 'X', role: 'owner', pin: '5824' }).ok);
r = owner('posSaveStaff', { name: 'Bwena', role: 'manager', pin: '7391' });
const managerId = r.staff.staffId;
r = owner('posSaveStaff', { name: 'Kiri', role: 'reports', pin: '6620' });
const reportsId = r.staff.staffId;

r = post({ action: 'posDeviceInfo', deviceId: dev.deviceId, deviceSecret: secret });
ok('the till lists who can sign in on it (names and roles, no PINs)', r.ok && r.staff.length === 3 && !J(r).includes('PinHash') && !J(r).includes('pbkdf2'), J(r));
ok('a wrong till secret gets nothing', !post({ action: 'posDeviceInfo', deviceId: dev.deviceId, deviceSecret: 'nope' }).ok);

const login = (staffId, pin) => post({ action: 'posStaffLogin', deviceId: dev.deviceId, deviceSecret: secret, staffId, pin });
r = login(cashierId, '0000');
ok('wrong PIN: refused, without saying which part was wrong', !r.ok && r.error === 'Wrong name or PIN.', J(r));
r = login(cashierId, '4821');
const cashierTok = r.posToken;
ok('right PIN: a 12-hour session for this till', r.ok && cashierTok && r.staff.role === 'cashier' && Date.parse(r.expiresAt) > Date.now() + 11 * 3600000, J(r));
ok('the session is stored hashed', box.__sheets.PosSessions.objects().every((s) => s.TokenHash !== cashierTok));
const asCashier = (action, body) => post(Object.assign({ action, posToken: cashierTok, deviceSecret: secret }, body || {}));

/* ---------- the role gate (server side) ---------- */
r = asCashier('posCatalog');
ok('cashier loads the catalogue, without cost prices', r.ok && r.items.length === 1 && r.items[0].costPrice === undefined && r.actor.role === 'cashier', J(r));
r = asCashier('posCheckout', { clientTxnId: txn(), lines: [{ variantId: 'v1', qty: 2 }], payment: { method: 'cash' } });
ok('cashier sells; the sale records the cashier and the till', r.ok && r.sale.staffName === 'Tiaon (cashier)' && box.__sheets.PosSales.objects().slice(-1)[0].DeviceId === dev.deviceId, J(r));
const saleId = r.sale && r.sale.saleId;
ok('cashier cannot refund, void, see reports, change prices, manage staff or tills', ['posRefundSale', 'posVoidSale', 'posReport', 'posUpdateItem', 'posListStaff', 'posRegisterDevice', 'posSaveSettings', 'posConfirmPayment']
  .every((a) => asCashier(a, { saleId, requestId: 'req-' + a + '-0001', reason: 'test', variantId: 'v1', price: 1 }).errorKind === 'forbidden'));
ok('cashier cannot receive stock', asCashier('posStockOp', { opId: 'op-cash-000001', type: 'receive', variantId: 'v1', quantity: 5 }).errorKind === 'forbidden');
ok('a staff session works only with this till\'s secret', post({ action: 'posCatalog', posToken: cashierTok, deviceSecret: 'other' }).errorKind === 'auth');
ok('a staff session is not an owner session (owner-only actions refuse it)', !post({ action: 'getOwnerProfile', token: cashierTok }).ok && !post({ action: 'getInventory', posToken: cashierTok, deviceSecret: secret }).ok);
r = login(reportsId, '6620');
const repTok = r.posToken;
ok('reports role: reports yes, selling no', post({ action: 'posReport', posToken: repTok, deviceSecret: secret }).ok
  && post({ action: 'posCheckout', posToken: repTok, deviceSecret: secret, clientTxnId: txn(), lines: [{ variantId: 'v1', qty: 1 }], payment: { method: 'cash' } }).errorKind === 'forbidden');
r = login(managerId, '7391');
const mgrTok = r.posToken;
const asManager = (action, body) => post(Object.assign({ action, posToken: mgrTok, deviceSecret: secret }, body || {}));
r = asManager('posVoidSale', { saleId, requestId: 'void-mgr-00001', reason: 'customer left' });
ok('manager voids the cashier\'s sale', r.ok && r.sale.status === 'voided', J(r));
ok('manager cannot manage staff or tills (owner only)', asManager('posListStaff').errorKind === 'forbidden' && asManager('posRevokeDevice', { deviceId: dev.deviceId }).errorKind === 'forbidden');
ok('owner (owner session) can do everything through the same gate', owner('posReport').ok && owner('posListStaff').ok);

/* ---------- isolation ---------- */
ok('staff of store A cannot touch store B\'s items', !asCashier('posCheckout', { clientTxnId: txn(), lines: [{ variantId: 'vb', qty: 1 }], payment: { method: 'cash' } }).ok
  && !asManager('posUpdateItem', { variantId: 'vb', price: 1 }).ok);

/* ---------- lockout ---------- */
for (let i = 0; i < 5; i++) login(reportsId, '1234');
r = login(reportsId, '6620');
ok('5 wrong PINs lock that person for 15 minutes, even with the right PIN', !r.ok && /Too many wrong PINs/.test(r.error), J(r));
ok('owner sees them as locked', owner('posListStaff').staff.find((s) => s.staffId === reportsId).locked === true);

/* ---------- disabling and revoking ---------- */
r = owner('posSaveStaff', { staffId: managerId, name: 'Bwena', role: 'manager', active: false });
ok('disabling a staff member ends their session at once', r.ok && asManager('posCatalog').errorKind === 'auth');
r = owner('posRevokeDevice', { deviceId: dev.deviceId });
ok('revoking the till ends every session on it at once', r.ok && r.device.status === 'revoked' && asCashier('posCatalog').errorKind === 'auth');
ok('...and the till cannot sign anyone in again', !login(cashierId, '4821').ok && !post({ action: 'posDeviceInfo', deviceId: dev.deviceId, deviceSecret: secret }).ok);
// Controlled recovery: the owner, signed in on that device, sends the sales that were waiting there.
r = owner('posUploadSales', { sales: [{ clientTxnId: txn(), offline: true, completedAt: new Date(Date.now() - 3600000).toISOString(), lines: [{ variantId: 'v1', qty: 1, unitPrice: 2 }], payment: { method: 'cash' } }] });
ok('a revoked till\'s waiting sales: the owner\'s session can still send them (recorded as the owner)', r.ok && r.results[0].ok && r.results[0].sale.staffName === 'A Shop (owner)', J(r));
ok('every till and staff change is audited', ['POS_DEVICE_REGISTERED', 'POS_DEVICE_REVOKED', 'POS_STAFF_SAVED', 'POS_STAFF_SIGNED_IN', 'POS_PIN_LOCKED']
  .every((a) => box.__sheets.Audit_Log.objects().some((x) => x.Action === a)));

/* ---------- cash shifts ---------- */
r = owner('posRegisterDevice', { name: 'Back counter' });
const dev2 = r.device, secret2 = r.deviceSecret;
owner('posSaveStaff', { staffId: cashierId, name: 'Tiaon', role: 'cashier', pin: '4821' });
const tok2 = post({ action: 'posStaffLogin', deviceId: dev2.deviceId, deviceSecret: secret2, staffId: cashierId, pin: '4821' }).posToken;
const c2 = (action, body) => post(Object.assign({ action, posToken: tok2, deviceSecret: secret2 }, body || {}));
r = c2('posOpenShift', { openingFloat: 50 });
const shiftId = r.shift && r.shift.shiftId;
ok('cashier opens a shift with $50 in the drawer', r.ok && r.shift.openingFloat === 50, J(r));
c2('posCheckout', { clientTxnId: txn(), shiftId, lines: [{ variantId: 'v1', qty: 5 }], payment: { method: 'cash', amountTendered: 20 } });
c2('posCheckout', { clientTxnId: txn(), shiftId, lines: [{ variantId: 'v1', qty: 3 }], payment: { method: 'eftpos' } });
c2('posCashMove', { shiftId, type: 'out', amount: 4, reason: 'paid for ice' });
r = c2('posShiftCurrent');
ok('expected cash = float 50 + cash sales 10 - cash out 4 (EFTPOS not counted as cash)', r.ok && r.shift.expectedCash === 56, J(r));
r = c2('posCloseShift', { shiftId, countedCash: 55 });
ok('closing with $55 counted: short by $1, recorded', r.ok && r.shift.status === 'closed' && r.shift.variance === -1 && r.shift.expectedCash === 56, J(r));
ok('closing again changes nothing', c2('posCloseShift', { shiftId, countedCash: 99 }).shift.variance === -1);

/* ---------- online orders stay separate ---------- */
r = owner('posOnlineOrders');
ok('online orders are listed for the till to see, only open ones, marked online', r.ok && r.orders.length === 1 && r.orders[0].orderId === 'ord1' && r.orders[0].channel === 'online', J(r));
ok('...and never become in-store sales', box.__sheets.PosSales.objects().every((s) => s.Channel === 'in_store'));

console.log(`\n${pass}/${pass + fails} passed`);
process.exit(fails ? 1 : 0);
